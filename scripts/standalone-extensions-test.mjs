/** 隔离的 standalone 扩展边界回归；所有数据均在当前包下的临时目录。 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageRoot = path.join(root, 'packages', 'standalone')
const scratch = await fs.mkdtemp(path.join(packageRoot, '.extensions-test-'))
const originalFetch = globalThis.fetch
const previousEnv = Object.fromEntries(['OUR_FREE_MODEL_BASE', 'OUR_FREE_MODEL_KILO_BASE'].map(key => [key, process.env[key]]))
const servers = [], services = []
let anonymousCalls = 0, kiloCalls = 0
const anon = 'mimo-v2.6-flash-free', kilo = 'nvidia/nemotron-3.5-lightning:free'
const frames = text => [
  'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }),
  'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
  'data: [DONE]', '',
].join('\n\n')
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    if (req.url === '/zen/v1/models' || req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: req.url === '/models' ? kilo : anon, name: 'Local fixture', isFree: true }] }))
    } else if (req.url === '/auth/status') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ authorized: false, configured: true, required: true }))
    } else if (req.url === '/pool') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, inflight: 1, pool: 4 }))
    } else {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      if (body.model === kilo) kiloCalls++; else anonymousCalls++
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frames(body.model === kilo ? 'kilo-ok' : 'core-ok'))
    }
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); servers.push(upstream)
const fixtureUrl = 'http://127.0.0.1:' + upstream.address().port
process.env.OUR_FREE_MODEL_BASE = fixtureUrl
process.env.OUR_FREE_MODEL_KILO_BASE = fixtureUrl
// 即使误加外部请求，测试也立即失败，不接触任何真实上游。
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('测试禁止访问外部网络')
  return originalFetch(input, options)
}
const { startStandalone } = await import('../packages/standalone/service.mjs')
const { createStandaloneEac } = await import('../packages/standalone/eac.mjs')
const { createAccountConnectorsHost, ACCOUNT_PROVIDERS } = await import('../src/extensions/account-connectors.js')
const { normalizePage, extensionPresentation } = await import('../packages/standalone/frontend/extension-data.mjs')
const { unavailableAccountConnectors } = await import('../packages/standalone/extensions.mjs')
const quiet = { warn() {}, info() {}, error() {} }
const isolatedEac = options => createStandaloneEac({ ...options, credentialOf: () => ({ mode: 'worker', base: fixtureUrl + '/v1' }), fetch: globalThis.fetch })
async function start(options = {}) {
  const service = await startStandalone({ dataDir: path.join(scratch, crypto.randomUUID()), port: 0, refresh: false, logger: quiet, eacFactory: isolatedEac, ...options })
  services.push(service); await service.ready
  return service
}
async function keyOf(service) { return JSON.parse(await fs.readFile(service.keyFile, 'utf8')).forwardKey }
async function request(service, route, body, options = {}) {
  const { authenticated = true, headers = {}, ...rest } = options
  const response = await fetch(service.url + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(authenticated ? { authorization: 'Bearer ' + await keyOf(service) } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000), ...rest,
  })
  const text = await response.text()
  let value; try { value = JSON.parse(text) } catch { value = text }
  return { response, value }
}
const management = '/api/management', ext = management + '/extensions/account-connectors', ui = ext + '/ui/'
function mockHost() {
  let state = { state: 'not-installed', installed: false, enabled: false, version: null, protocolVersion: 1, providerCount: 0, modelCount: 0 }
  let disposed = false, stops = 0
  const calls = [], listeners = new Set()
  const publish = () => listeners.forEach(listener => listener({ ...state }))
  const unavailable = () => Object.assign(new Error('账号连接扩展当前不可用'), { statusCode: 503, code: 'EXTENSION_UNAVAILABLE' })
  const host = {
    calls, get stops() { return stops }, get disposed() { return disposed },
    state: () => ({ ...state, managementTarget: ui.slice(0, -1), secretSentinel: 'must-not-expose' }),
    publicModelRows: () => state.state === 'ready' ? [{ id: 'buddy/mock', object: 'model', source: 'extension:ofm.account-connectors', channel: 'buddy' }] : [],
    handles: model => ACCOUNT_PROVIDERS.some(provider => model.startsWith(provider + '/')),
    refresh: async () => host.publicModelRows(), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    complete: async () => { if (state.state !== 'ready') throw unavailable(); return { text: 'mock-ok', toolCalls: [], truncated: false } },
    async rpc(body, signal) { calls.push(['rpc', body]); assert.equal(signal.aborted, false); return { ok: true, value: { status: 'owned-by-extension' } } },
    async installFromDirectory(directory, options) { calls.push(['install', directory, options]); state = { ...state, state: 'disabled', installed: true, enabled: false, version: '0.1.0', providerCount: 1 }; publish() },
    async enable() { calls.push(['enable']); if (!state.installed) throw unavailable(); state = { ...state, state: 'ready', enabled: true, modelCount: 1 }; publish() },
    async disable() { calls.push(['disable']); stops++; state = { ...state, state: state.installed ? 'disabled' : 'not-installed', enabled: false, modelCount: 0 }; publish() },
    async uninstall(options) { await host.disable(); calls.push(['uninstall', options]); state = { ...state, state: 'not-installed', installed: false }; publish() },
    async readUiAsset(relative) { calls.push(['asset', relative]); if (relative === 'index.html') return { bytes: Buffer.from('<!doctype html><script src="./app.js"></script>'), path: 'web/index.html' }; if (relative === 'web/app.js') return { bytes: Buffer.from('window.fixture = true'), path: relative }; return null },
    async dispose() { if (disposed) return; disposed = true; await host.disable(); listeners.clear() },
  }
  return host
}

try {
  const missing = await start()
  await test('未安装扩展：核心健康、摘要和真实兼容状态正常', async () => {
    const health = await request(missing, '/health', undefined, { authenticated: false })
    assert.equal(health.response.status, 200); assert.equal(health.value.capabilities.eac, true); assert.equal(health.value.capabilities.accountChannels, false)
    const { value } = await request(missing, management + '/summary')
    assert.equal(value.extensions.accountConnectors.state, 'not-installed'); assert.equal(value.channels.state, 'not-installed')
    assert.ok(value.catalog.some(row => row.channel === 'anonymous'))
    assert.equal((await request(missing, ext)).value.installed, false)
  })
  await test('未安装扩展：匿名、Kilo、用量、设置、密钥与 EAC 均可用', async () => {
    assert.equal((await request(missing, management + '/models/refresh', { probe: false })).response.status, 200)
    for (const [model, text] of [[anon, 'core-ok'], [kilo, 'kilo-ok']]) {
      const { response, value } = await request(missing, '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }] })
      assert.equal(response.status, 200); assert.equal(value.choices[0].message.content, text)
    }
    const stats = await request(missing, management + '/stats'); assert.equal(stats.response.status, 200); assert.ok(stats.value.requests >= 2)
    const settings = await request(missing, management + '/settings', { defaultMaxTokens: 2048 }); assert.equal(settings.value.settings.defaultMaxTokens, 2048)
    assert.ok((await request(missing, management + '/key')).value.key.startsWith('ofm-'))
    assert.equal((await request(missing, management + '/eac/status')).response.status, 200)
    assert.equal((await request(missing, management + '/eac/pool')).value.pool, 4)
  })
  await test('13 个旧模型前缀明确拒绝，绝不转发到匿名或 Kilo', async () => {
    const before = [anonymousCalls, kiloCalls]
    for (const provider of ACCOUNT_PROVIDERS) {
      await assert.rejects(missing.runtime.complete({ model: provider + '/retired', openAi: { messages: [] } }), { statusCode: 503, code: 'EXTENSION_UNAVAILABLE' })
      const result = await request(missing, '/v1/chat/completions', { model: provider + '/retired', messages: [{ role: 'user', content: 'hi' }] })
      assert.equal(result.response.status, 503); assert.match(result.value.error.message, /扩展/)
    }
    assert.deepEqual([anonymousCalls, kiloCalls], before)
  })
  await test('管理鉴权及同源边界覆盖所有扩展动作和界面资源', async () => {
    for (const route of [ext, ui, ui + 'app.js']) assert.equal((await request(missing, route, undefined, { authenticated: false })).response.status, 401)
    for (const action of ['enable', 'disable', 'install', 'uninstall', 'rpc']) assert.equal((await request(missing, ext + '/' + action, {}, { authenticated: false })).response.status, 401)
    assert.equal((await request(missing, ext, undefined, { headers: { authorization: 'Bearer ' + await keyOf(missing), origin: 'https://evil.example' } })).response.status, 403)
    assert.equal((await request(missing, ui, undefined, { headers: { authorization: 'Bearer ' + await keyOf(missing), 'sec-fetch-site': 'cross-site' } })).response.status, 403)
  })
  await test('未安装界面提供指引；旧 RPC 永久拒绝', async () => {
    const alias = await request(missing, '/extensions/account-connectors', undefined, { authenticated: false, redirect: 'manual' })
    assert.equal(alias.response.status, 302); assert.equal(alias.response.headers.get('location'), ui)
    assert.equal(alias.value, '')
    const guide = await request(missing, ui); assert.equal(guide.response.status, 200); assert.match(guide.value, /page=extensions/)
    const legacy = await request(missing, management + '/channels/rpc', { method: 'gateway.getEnabled', payload: {} })
    assert.equal(legacy.response.status, 410); assert.equal(legacy.value.code, 'LEGACY_CHANNELS_REMOVED')
    assert.equal((await request(missing, ext + '/rpc', { method: 'account.list', payload: {} })).value.code, 'EXTENSION_UNAVAILABLE')
  })
  const mock = mockHost(), mocked = await start({ accountConnectorsFactory: async () => mock })
  await test('摘要只包含扩展公共字段，不泄漏宿主内部值', async () => {
    const summary = await request(mocked, management + '/summary')
    assert.equal(JSON.stringify(summary.value).includes('must-not-expose'), false)
    assert.equal((await request(mocked, ext)).value.secretSentinel, undefined)
  })
  await test('本机导入需要绝对目录和显式信任；安装不会启用', async () => {
    for (const body of [{ path: scratch }, { path: './relative', trustDevelopment: true }, { path: 'https://example.org/remote.js', trustDevelopment: true }, { path: String.fromCharCode(92, 92) + 'server' + String.fromCharCode(92) + 'share', trustDevelopment: true }, { path: scratch, trustDevelopment: true, url: 'remote' }]) {
      assert.equal((await request(mocked, ext + '/install', body)).response.status, 400)
    }
    assert.equal(mock.calls.length, 0)
    const result = await request(mocked, ext + '/install', { path: scratch, trustDevelopment: true })
    assert.equal(result.value.accountConnectors.state, 'disabled'); assert.equal(mock.calls.some(call => call[0] === 'enable'), false)
    assert.equal((await request(mocked, ext + '/rpc', { method: 'account.list', payload: {} })).response.status, 503)
  })
  await test('启用后只走扩展自有 RPC，backup.export 与旧 RPC 拒绝', async () => {
    await request(mocked, ext + '/enable', {})
    const result = await request(mocked, ext + '/rpc', { method: 'provider.status', payload: {} })
    assert.equal(result.value.value.status, 'owned-by-extension')
    assert.equal((await request(mocked, ext + '/rpc', { method: 'backup.export', payload: {} })).response.status, 403)
    assert.equal((await request(mocked, management + '/channels/rpc', { method: 'provider.status', payload: {} })).response.status, 410)
    assert.equal((await request(mocked, ext + '/rpc', { method: 123 })).response.status, 400)
    assert.equal(mock.calls.filter(call => call[0] === 'rpc').length, 1)
  })
  await test('固定界面路由映射 web/；仅清单资源可读，Cookie 会话也可访问', async () => {
    const page = await request(mocked, ui); assert.equal(page.response.status, 200); assert.match(page.value, /app.js/)
    const asset = await request(mocked, ui + 'app.js'); assert.equal(asset.response.status, 200); assert.match(asset.response.headers.get('content-type'), /javascript/)
    assert.ok(mock.calls.some(call => call[0] === 'asset' && call[1] === 'web/app.js'))
    assert.equal((await request(mocked, ui + 'runtime/worker.mjs')).response.status, 404)
    assert.equal((await request(mocked, ui + '%2e%2e%2fruntime%2fworker.mjs')).response.status, 400)
    const login = await request(mocked, management + '/session', { key: await keyOf(mocked) }, { authenticated: false })
    const cookie = login.response.headers.get('set-cookie'); assert.ok(cookie.includes('Path=/api/management;'))
    assert.equal((await request(mocked, ui, undefined, { authenticated: false, headers: { cookie: cookie.split(';')[0] } })).response.status, 200)
    await request(mocked, management + '/logout', {}, { authenticated: false, headers: { cookie: cookie.split(';')[0] } })
    assert.equal((await request(mocked, ui, undefined, { authenticated: false, headers: { cookie: cookie.split(';')[0] } })).response.status, 401)
  })
  await test('停用和卸载撤销模型、RPC、资源，并保留数据约定', async () => {
    await request(mocked, ext + '/disable', {})
    assert.equal(mock.publicModelRows().length, 0)
    assert.equal((await request(mocked, ext + '/rpc', { method: 'account.list', payload: {} })).response.status, 503)
    assert.equal((await request(mocked, ui + 'app.js')).response.status, 503)
    assert.equal((await request(mocked, ext + '/uninstall', { deleteData: true })).response.status, 400)
    await request(mocked, ext + '/enable', {})
    const result = await request(mocked, ext + '/uninstall', { deleteData: false })
    assert.equal(result.value.accountConnectors.installed, false); assert.ok(mock.stops >= 2)
    assert.deepEqual(mock.calls.find(call => call[0] === 'uninstall')[1], { deleteData: false })
    assert.equal((await request(mocked, ui + 'app.js')).response.status, 404)
  })
  await test('关闭服务只清理自己的扩展实例，重复关闭复用结果', async () => {
    const first = mocked.close(); assert.equal(mocked.close(), first); await first
    assert.equal(mock.disposed, true)
    await assert.rejects(fs.stat(path.join(mocked.dataDir, 'service.lock')), { code: 'ENOENT' })
  })
  await test('宿主工厂异常仍保留核心，退役模型保持明确拒绝', async () => {
    const failed = await start({ accountConnectorsFactory: async () => { throw new Error('fixture host failure') } })
    assert.equal((await request(failed, '/health', undefined, { authenticated: false })).response.status, 200)
    assert.equal((await request(failed, ext)).value.state, 'failed')
    await assert.rejects(failed.runtime.complete({ model: 'buddy/retired' }), { statusCode: 503, code: 'EXTENSION_UNAVAILABLE' })
    const fallback = unavailableAccountConnectors(new Error('fixture'))
    assert.equal(fallback.handles('minimax/retired'), true); assert.equal(fallback.handles('minimax-official'), false); assert.equal(fallback.handles('gemini-2.5-flash'), false)
  })

  const candidate = path.join(scratch, 'candidate')
  const worker = `import { parentPort, workerData } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
fs.writeFileSync(path.join(workerData.dataDir, 'started.txt'), 'enabled')
const pending = new Map()
parentPort.on('message', message => {
  if (message.type === 'models') parentPort.postMessage({ type: 'result', id: message.id, value: [{ id: 'buddy/fixture', object: 'model', name: 'Fixture account model', channel: 'buddy' }] })
  if (message.type === 'rpc') parentPort.postMessage({ type: 'result', id: message.id, value: { ok: true, value: { extension: true } } })
  if (message.type === 'complete') {
    const send = () => { parentPort.postMessage({ type: 'chunk', id: message.id, chunk: { type: 'text-delta', text: 'addon-ok' } }); parentPort.postMessage({ type: 'result', id: message.id, value: null }); pending.delete(message.id) }
    if (message.request.openAi?.user === 'hold') pending.set(message.id, setTimeout(send, 30000)); else send()
  }
  if (message.type === 'cancel') { clearTimeout(pending.get(message.id)); pending.delete(message.id) }
  if (message.type === 'close') { for (const timer of pending.values()) clearTimeout(timer); fs.writeFileSync(path.join(workerData.dataDir, 'closed.txt'), 'closed'); parentPort.postMessage({ type: 'closed' }); parentPort.close() }
})
parentPort.postMessage({ type: 'ready', descriptor: { id: 'ofm.account-connectors', version: '0.1.0', protocolVersion: 1, instanceId: workerData.instanceId, state: 'ready', capabilities: ['hostModels', 'ofmApi', 'managementUi'], managementTarget: '/ofm-account-connectors' }, providers: ['buddy'] })
`
  const candidateFiles = { 'runtime/worker.mjs': worker, 'web/index.html': '<!doctype html><script src="./app.js"></script>', 'web/app.js': 'window.extensionFixture = true' }
  for (const [relative, text] of Object.entries(candidateFiles)) { await fs.mkdir(path.dirname(path.join(candidate, relative)), { recursive: true }); await fs.writeFile(path.join(candidate, relative), text) }
  const manifest = { id: 'ofm.account-connectors', version: '0.1.0', protocolVersion: 1, runtime: { entry: 'runtime/worker.mjs' }, ui: { entry: 'web/index.html', assets: ['web/app.js'] }, providers: ['buddy'], files: Object.fromEntries(Object.entries(candidateFiles).map(([relative, text]) => [relative, crypto.createHash('sha256').update(text).digest('hex')])), node: '^22.19.0 || >=24.0.0', development: true }
  await fs.writeFile(path.join(candidate, 'extension.json'), JSON.stringify(manifest))
  const real = await start(), ownData = path.join(real.dataDir, 'extensions-data', 'ofm.account-connectors')
  await test('真实宿主只安装元信息，明确启用后才执行独立 Worker', async () => {
    const installed = await request(real, ext + '/install', { path: candidate, trustDevelopment: true })
    assert.equal(installed.response.status, 200); assert.equal(installed.value.accountConnectors.enabled, false)
    await assert.rejects(fs.stat(path.join(ownData, 'started.txt')), { code: 'ENOENT' })
    const enabled = await request(real, ext + '/enable', {})
    assert.equal(enabled.response.status, 200); assert.equal(enabled.value.accountConnectors.state, 'ready')
    assert.equal(await fs.readFile(path.join(ownData, 'started.txt'), 'utf8'), 'enabled')
    const completion = await request(real, '/v1/chat/completions', { model: 'buddy/fixture', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(completion.value.choices[0].message.content, 'addon-ok')
    const assets = await request(real, ui + 'app.js'); assert.equal(assets.response.status, 200); assert.match(assets.value, /extensionFixture/)
    assert.equal((await request(real, ui + 'runtime/worker.mjs')).response.status, 404)
  })
  await test('真实停用取消在途请求；卸载先关闭 Worker 并保留扩展数据', async () => {
    await fs.writeFile(path.join(ownData, 'retained-sentinel.txt'), 'isolated-test-data')
    const pending = real.runtime.complete({ model: 'buddy/fixture', openAi: { user: 'hold', messages: [] } })
    const rejected = assert.rejects(pending, { code: 'EXTENSION_DISABLED' })
    await request(real, ext + '/disable', {}); await rejected
    assert.equal(real.accountConnectors.publicModelRows().length, 0)
    assert.equal(await fs.readFile(path.join(ownData, 'closed.txt'), 'utf8'), 'closed')
    await request(real, ext + '/enable', {})
    const removed = await request(real, ext + '/uninstall', { deleteData: false })
    assert.equal(removed.value.accountConnectors.state, 'not-installed')
    assert.equal(await fs.readFile(path.join(ownData, 'retained-sentinel.txt'), 'utf8'), 'isolated-test-data')
    await assert.rejects(fs.stat(path.join(real.dataDir, 'extensions', 'ofm.account-connectors')), { code: 'ENOENT' })
    assert.equal((await request(real, ui + 'app.js')).response.status, 404)
    assert.equal((await request(real, '/v1/chat/completions', { model: anon, messages: [{ role: 'user', content: 'hi' }] })).response.status, 200)
  })
  await test('真实安装拒绝协议不兼容与摘要错误，核心继续可用', async () => {
    await fs.writeFile(path.join(candidate, 'extension.json'), JSON.stringify({ ...manifest, protocolVersion: 99 }))
    assert.equal((await request(real, ext + '/install', { path: candidate, trustDevelopment: true })).response.status, 409)
    await fs.writeFile(path.join(candidate, 'extension.json'), JSON.stringify(manifest))
    await fs.writeFile(path.join(candidate, 'web/app.js'), 'tampered')
    assert.equal((await request(real, ext + '/install', { path: candidate, trustDevelopment: true })).response.status, 400)
    assert.equal((await request(real, '/health', undefined, { authenticated: false })).response.status, 200)
  })
  await test('旧 pageKey 转到指引，状态文字涵盖未安装、待启用、连接、停用、不兼容和故障', () => {
    assert.equal(normalizePage('channels'), 'extensions'); assert.equal(normalizePage('unknown'), 'overview')
    for (const state of ['not-installed', 'disabled', 'starting', 'ready', 'failed', 'incompatible', 'stopping']) {
      const value = extensionPresentation({ state, installed: state !== 'not-installed', enabled: state === 'ready', modelCount: 0 })
      assert.ok(value.label); assert.ok(value.description); assert.equal(value.canOpen, state === 'ready')
    }
  })
  await test('EAC 源码和核心入口不包含账号实现或旧 RPC', async () => {
    const eac = await fs.readFile(path.join(packageRoot, 'frontend', 'eac.mjs'), 'utf8')
    for (const name of ['EacAuth', 'useEacLogin', 'Tank', 'usePool', 'poolReading', 'capacityText']) assert.ok(eac.includes(name))
    assert.doesNotMatch(eac, /ChannelCard|ChannelBrowser|CHANNEL_PROVIDERS|account\.list|provider\.status|channels\/rpc/)
    const app = await fs.readFile(path.join(packageRoot, 'frontend', 'app.tsx'), 'utf8')
    assert.match(app, /import\('.\/eac\.mjs'\)/); assert.doesNotMatch(app, /import\('.\/channels/)
    const service = await fs.readFile(path.join(packageRoot, 'service.mjs'), 'utf8')
    assert.doesNotMatch(service, /createChannelRuntime|channels\/runtime|channels\/business/)
  })
  let uiOutput
  if (process.argv.includes('--ui') || process.argv.includes('--visual')) await test('内存构建 EAC 页面不夹带账号组件；不写 web 生成产物', async () => {
    const require = createRequire(import.meta.url)
    const { build } = await import(pathToFileURL(require.resolve('vite', { paths: [packageRoot] })).href)
    const result = await build({ configFile: path.join(packageRoot, 'vite.config.mjs'), logLevel: 'warn', build: { write: false, minify: false } })
    const output = (Array.isArray(result) ? result.flatMap(item => item.output) : result.output)
    uiOutput = output
    const js = output.filter(item => item.type === 'chunk').map(item => item.code).join('\n')
    assert.doesNotMatch(js, /ChannelCard|ChannelBrowser|CHANNEL_PROVIDERS|account\.update|provider\.status|channels\/rpc|backup\.export/)
    assert.ok(output.some(item => /^eac-.*\.js$/.test(item.fileName)))
  })
  if (process.argv.includes('--visual')) await test('昼夜主题、七种扩展状态、EAC 与 200% 等效宽度的浏览器检查', async () => {
    assert.ok(uiOutput, '先成功完成内存构建')
    const require = createRequire(import.meta.url)
    const browserModule = process.env.OFM_TEST_PLAYWRIGHT_MODULE || require.resolve('playwright', { paths: [packageRoot] })
    const { chromium } = await import(pathToFileURL(browserModule).href)
    const files = new Map(uiOutput.map(item => [item.fileName, item.type === 'chunk' ? item.code : item.source]))
    const preview = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname
      const name = pathname === '/' ? 'index.html' : pathname.startsWith('/assets/') ? pathname.slice(8) : ''
      if (!files.has(name)) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(files.get(name))
    })
    await new Promise(resolve => preview.listen(0, '127.0.0.1', resolve)); servers.push(preview)
    const previewUrl = 'http://127.0.0.1:' + preview.address().port
    const browser = await chromium.launch({ headless: true, ...(process.env.OFM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.OFM_TEST_BROWSER_EXECUTABLE } : {}) })
    let visualStatus = { id: 'ofm.account-connectors', state: 'not-installed', installed: false, enabled: false, version: null, protocolVersion: 1, providerCount: 0, modelCount: 0, managementTarget: ui.slice(0, -1) }
    const apiCalls = [], pageErrors = [], layouts = []
    const context = await browser.newContext({ viewport: { width: 1360, height: 940 }, reducedMotion: 'reduce' })
    await context.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== previewUrl) { pageErrors.push('外部请求：' + url.origin); await route.abort(); return }
      if (!url.pathname.startsWith(management)) { await route.continue(); return }
      apiCalls.push(url.pathname)
      const summary = { version: '0.1.0', baseUrl: previewUrl, dataDir: 'D:/isolated-test/' + 'long-directory/'.repeat(12), networkMode: 'fixture', automaticRefresh: false, catalogSyncedAt: 0,
        extensions: { accountConnectors: visualStatus }, channels: visualStatus, eacAuth: { available: true, authorized: false, local: false },
        settings: { enabled: true, exposeRegionModels: false, streamRecovery: true, standaloneProbe: false, probeIntervalMinutes: 15, defaultMaxTokens: 4096 },
        catalog: [{ id: anon, name: 'Anonymous fixture', channel: 'anonymous', routable: true }, { id: kilo, name: 'Kilo fixture', channel: 'kilo', routable: true }],
      }
      const stats = { requests: 0, requestFailures: 0, turns: 0, failedTurns: 0, recoveredTurns: 0, days: [], grand: { input: 0, output: 0, reasoning: 0 }, models: [], samples: [] }
      const value = url.pathname.endsWith('/summary') ? summary : url.pathname.endsWith('/stats') ? stats : url.pathname.endsWith('/eac/pool') ? { ok: true, pool: 4, inflight: 1 } : url.pathname.endsWith('/eac/status') ? { available: true, authorized: false, local: false } : {}
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) })
    })
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message))
    const measure = async label => {
      const value = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, pageWidth: document.querySelector('.extensions-page')?.clientWidth, pageScroll: document.querySelector('.extensions-page')?.scrollWidth }))
      layouts.push({ label, ...value }); assert.ok(value.scroll <= value.width + 1, label + ' 页面横向溢出：' + JSON.stringify(value))
      if (value.pageWidth) assert.ok(value.pageScroll <= value.pageWidth + 1, label + ' 扩展正文横向溢出')
    }
    try {
      await page.goto(previewUrl + '/?pageKey=channels'); await page.getByTestId('extensions-ready').waitFor()
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
        for (const state of ['not-installed', 'disabled', 'starting', 'ready', 'failed', 'incompatible', 'stopping']) {
          visualStatus = { ...visualStatus, state, installed: state !== 'not-installed', enabled: state === 'ready', version: state === 'not-installed' ? null : '0.1.0', modelCount: state === 'ready' ? 2 : 0,
            error: ['failed', 'incompatible'].includes(state) ? '扩展加载失败，请核对协议和文件摘要：' + 'very-long-path/'.repeat(32) : '' }
          const response = page.waitForResponse(response => response.url() === previewUrl + management + '/summary', { timeout: 10000 })
          await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await response
          await page.getByText(extensionPresentation(visualStatus).label, { exact: true }).first().waitFor({ timeout: 10000 })
          await measure(theme + '/' + state)
        }
        if (process.env.OFM_TEST_VISUAL_SNAPSHOTS === '1') console.log('OFM_VISUAL_SNAPSHOT ' + theme + '-desktop ' + (await page.screenshot()).toString('base64'))
        visualStatus = { ...visualStatus, state: 'failed', enabled: false, error: '扩展加载失败，请核对协议和文件摘要：' + 'very-long-path/'.repeat(32) }
        const summaryResponse = page.waitForResponse(response => response.url() === previewUrl + management + '/summary')
        await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await summaryResponse
        await page.getByText('扩展故障', { exact: true }).waitFor()
        await page.setViewportSize({ width: 680, height: 470 }); await measure(theme + '/200%-equivalent-long-error')
        if (process.env.OFM_TEST_VISUAL_SNAPSHOTS === '1') console.log('OFM_VISUAL_SNAPSHOT ' + theme + '-zoom ' + (await page.screenshot({ fullPage: true })).toString('base64'))
        await page.setViewportSize({ width: 360, height: 780 }); await measure(theme + '/mobile')
        await page.setViewportSize({ width: 1360, height: 940 })
      }
      await page.getByRole('button', { name: 'EAC 协付渠道', exact: true }).click()
      await page.getByRole('heading', { name: 'EAC 协付渠道', exact: true }).waitFor()
      await page.getByRole('heading', { name: 'EAC 实时资源池', exact: true }).waitFor()
      await page.getByText('当前并发：1', { exact: false }).waitFor()
      assert.ok(apiCalls.some(route => route.endsWith('/eac/status'))); assert.ok(apiCalls.some(route => route.endsWith('/eac/pool')))
      assert.equal(apiCalls.some(route => route.includes('/channels/rpc')), false)
      assert.deepEqual(pageErrors, [])
      console.log('browser layouts: ' + JSON.stringify(layouts))
    } catch (error) { console.log('browser failure state: ' + JSON.stringify({ status: visualStatus, body: (await page.locator('body').innerText()).slice(0, 2400), errors: pageErrors })); throw error }
    finally { await context.close(); await browser.close() }
  })
} finally {
  await Promise.allSettled(services.map(service => service.close()))
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  const target = path.resolve(scratch)
  if (path.dirname(target) !== path.resolve(packageRoot) || !path.basename(target).startsWith('.extensions-test-')) throw new Error('临时目录清理范围无效')
  await fs.rm(target, { recursive: true, force: true })
}
