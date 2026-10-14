import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { stageDesktopService, repositoryRoot } from './prepare-desktop.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm desktop 测试 '))
const serviceRoot = path.join(scratch, 'service')
const dataDir = path.join(scratch, 'data')
const preload = path.join(scratch, 'offline.mjs')
const children = new Set()
let checks = 0
const check = async (name, run) => { await run(); console.log(`ok ${++checks} ${name}`) }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
fs.writeFileSync(preload, `const original = globalThis.fetch; globalThis.fetch = (input, init) => { const u = new URL(input instanceof Request ? input.url : String(input)); return u.hostname === '127.0.0.1' || u.hostname === 'localhost' ? original(input, init) : Promise.resolve(Response.json({ data: [] })); };`)

function launch({ port = 0, directory = dataDir, endInput = false } = {}) {
  const node = path.join(scratch, process.platform === 'win32' ? 'node.exe' : 'node')
  const child = spawn(node, ['--import', pathToFileURL(preload).href,
    path.join(serviceRoot, 'packages/desktop/service-host.mjs'), '--port', String(port), '--no-refresh', '--data-dir', directory],
  { cwd: scratch, env: { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '' }, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  const exit = once(child, 'exit')
  let ready, error = ''
  let output = ''
  child.stderr.on('data', chunk => { error += chunk })
  child.stdout.on('data', chunk => {
    output += chunk
    const lines = output.split('\n'); output = lines.pop()
    for (const line of lines) {
      try { const message = JSON.parse(line); if (message.protocol?.startsWith('ofm-desktop-')) ready = message } catch {}
    }
  })
  if (endInput) child.stdin.end()
  return {
    child, exit,
    async ready() {
      for (let i = 0; i < 150; i++) {
        if (ready) return ready
        if (child.exitCode !== null) throw new Error(`启动握手前退出：${error.slice(0, 200)}`)
        await delay(100)
      }
      throw new Error('桌面服务握手超时')
    },
    async stop(eof = false) {
      if (child.exitCode === null) {
        if (eof) child.stdin.end(); else child.stdin.end('shutdown\n')
      }
      const timeout = setTimeout(() => { child.kill() }, 10000)
      try { const [code] = await exit; assert.equal(code, 0); children.delete(child) }
      finally { clearTimeout(timeout) }
    },
  }
}

const occupied = net.createServer(socket => socket.end())
try {
  await check('仅选择完整运行资源，临时包在源码仓库之外，不带工具索引及用户数据', () => {
    stageDesktopService(serviceRoot)
    fs.copyFileSync(process.execPath, path.join(scratch, process.platform === 'win32' ? 'node.exe' : 'node'))
    for (const file of ['src/providers/registry.json', 'src/core/runtime.js', 'packages/standalone/web/assets.json',
      'packages/standalone/management.mjs', 'packages/standalone/extensions.mjs', 'src/extensions/account-connectors.js']) {
      assert.ok(fs.existsSync(path.join(serviceRoot, file)), file)
    }
    assert.ok(!fs.existsSync(path.join(serviceRoot, 'packages/standalone/channels')))
    assert.ok(!fs.existsSync(path.join(serviceRoot, 'vendor/channel-pack')))
    assert.ok(!fs.existsSync(path.join(serviceRoot, '.aoci')))
    assert.ok(!fs.existsSync(path.join(serviceRoot, '.pr-screenshots')))
    assert.ok(!fs.existsSync(path.join(serviceRoot, 'node_modules')))
    assert.ok(!fs.existsSync(path.join(serviceRoot, 'settings.json')))
  })
  occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening')
  let first, ready
  await check('复制的内置 Node 在空 PATH 和含中文空格的安装路径启动，返回自身 PID 与真实端口', async () => {
    first = launch({ port: occupied.address().port }); ready = await first.ready()
    assert.equal(ready.protocol, 'ofm-desktop-ready/v1')
    assert.equal(ready.pid, first.child.pid)
    assert.notEqual(ready.port, occupied.address().port)
    const url = new URL(ready.managementUrl)
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(Number(url.port), ready.port)
    assert.ok(url.hash.startsWith('#login='))
  })
  await check('一次性登录入口创建会话后可请求管理 API，令牌不写进测试输出', async () => {
    const url = new URL(ready.managementUrl)
    const response = await fetch(`${url.origin}/api/management/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: new URLSearchParams(url.hash.slice(1)).get('login') }) })
    assert.equal(response.status, 200)
    const summary = await fetch(`${url.origin}/api/management/summary`, { headers: { cookie: response.headers.get('set-cookie').split(';')[0] } })
    assert.equal(summary.status, 200)
    const duplicate = await fetch(`${url.origin}/api/management/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: new URLSearchParams(url.hash.slice(1)).get('login') }) })
    assert.equal(duplicate.status, 401)
  })
  await check('已有服务的数据锁不被删除，重复启动明确报错并保留原服务', async () => {
    const before = fs.readFileSync(path.join(dataDir, 'service.lock'))
    const second = launch(); const failure = await second.ready()
    assert.equal(failure.code, 'DATA_DIRECTORY_IN_USE')
    const [code] = await second.exit; assert.equal(code, 1); children.delete(second.child)
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'service.lock')), before)
    assert.equal((await fetch(`http://127.0.0.1:${ready.port}/health`)).status, 200)
  })
  await check('私有管道关闭服务，清理锁后相同目录可以立即重启', async () => {
    await first.stop(); assert.ok(!fs.existsSync(path.join(dataDir, 'service.lock')))
    const restarted = launch(); assert.equal((await restarted.ready()).protocol, 'ofm-desktop-ready/v1')
    await restarted.stop(); assert.ok(!fs.existsSync(path.join(dataDir, 'service.lock')))
  })
  await check('父进程管道 EOF 和启动前 EOF 均正常退出，不留下锁', async () => {
    const parentClosed = launch(); await parentClosed.ready(); await parentClosed.stop(true)
    const earlyClosed = launch({ endInput: true }); await earlyClosed.stop(true)
    assert.ok(!fs.existsSync(path.join(dataDir, 'service.lock')))
  })
  await check('桌面配置使用明确资源映射，启动不依赖系统 Node；标题栏 API 使用 v2', () => {
    const config = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'packages/desktop/src-tauri/tauri.conf.json')))
    assert.equal(config.bundle.resources['resources/service/'], 'service/')
    assert.equal(config.bundle.resources['resources/runtime/'], 'runtime/')
    const js = fs.readFileSync(path.join(repositoryRoot, 'packages/desktop/ui/titlebar.js'), 'utf8')
    assert.ok(js.includes('getCurrentWindow'))
    assert.ok(!js.includes('getCurrent()'))
    const css = fs.readFileSync(path.join(repositoryRoot, 'packages/desktop/ui/titlebar.css'), 'utf8')
    assert.ok(!css.startsWith('\uFEFF'), '注入的 CSS 不得带 BOM，否则第一个选择器失效')
    const hooks = fs.readFileSync(path.join(repositoryRoot, 'packages/desktop/src-tauri/install-hooks.nsh'), 'utf8')
    assert.ok(!/taskkill|Delete |FileWrite/.test(hooks))
  })
  console.log(`${checks}/${checks} 桌面回归检查通过`)
} finally {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit').catch(() => {})
    child.kill(); await exited
  }
  if (occupied.listening) await new Promise(resolve => occupied.close(resolve))
  assert.ok(scratch.startsWith(path.resolve(os.tmpdir()) + path.sep))
  fs.rmSync(scratch, { recursive: true, force: true })
}
