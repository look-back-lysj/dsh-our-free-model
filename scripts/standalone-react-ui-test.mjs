/** 使用真实构建资源、本机浏览器和隔离接口，验证核心页面状态及会话边界。 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createManagement } from '../packages/standalone/management.mjs'
import { buildStats } from '../src/core/stats.js'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? process.env.OFM_TEST_PLAYWRIGHT_MODULE ?? 'playwright')
const edge = process.platform === 'win32' ? [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(file => fs.existsSync(file)) : undefined
const executablePath = process.env.OFM_TEST_BROWSER_EXECUTABLE ?? process.env.OFM_BROWSER_EXECUTABLE ?? edge
const imageDir = process.env.OFM_UI_SCREENSHOT_DIR ?? 'D:\\ofm-audits\\20261014-account-relay-separation\\implementation-qa\\screenshots'
// --source 只在内存构建最新源码，供主控整合产物前检查；默认仍验证真实 web 文件。
const sourceMode = process.argv.includes('--source')
let sourceFiles
if (sourceMode) {
  const project = fileURLToPath(new URL('../packages/standalone/', import.meta.url))
  const { build } = await import(pathToFileURL(require.resolve('vite', { paths: [project] })).href)
  const built = await build({ configFile: path.join(project, 'vite.config.mjs'), logLevel: 'warn', build: { write: false } })
  const output = Array.isArray(built) ? built.flatMap(item => item.output) : built.output
  sourceFiles = new Map(output.map(item => [item.fileName, item.type === 'chunk' ? item.code : item.source]))
}
const management = createManagement({ stores: { settings: { get: () => ({ forwardKey: 'isolated' }) } }, info: () => ({}) })
const server = http.createServer((req, res) => {
  if (sourceFiles && (req.method === 'GET' || req.method === 'HEAD')) {
    const pathname = new URL(req.url, 'http://localhost').pathname
    const name = pathname === '/' ? 'index.html' : pathname.startsWith('/assets/') ? pathname.slice(8) : ''
    if (sourceFiles.has(name)) {
      res.writeHead(200, { 'cache-control': 'no-store', 'content-type': name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' })
      res.end(req.method === 'HEAD' ? undefined : sourceFiles.get(name)); return
    }
  }
  void management.handleRequest(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end() } }).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const baseUrl = 'http://127.0.0.1:' + server.address().port
management.setPort(server.address().port)
const settings = { enabled: true, exposeRegionModels: true, streamRecovery: true, standaloneProbe: false, defaultMaxTokens: 32768, probeIntervalMinutes: 15 }
const connectorTarget = '/api/management/extensions/account-connectors/ui/'
let connector = { id: 'ofm.account-connectors', state: 'not-installed', installed: false, enabled: false, version: null, protocolVersion: 1, providerCount: 0, modelCount: 0, managementTarget: connectorTarget }
let loggedIn = false, key = 'ofm-ui-isolated-key', summaryReads = 0, failNextSave = false, saveGate, failNextEnable = false
const summary = () => ({ version: 'test', baseUrl, dataDir: 'D:/isolated-ui-test', networkMode: 'fixture', automaticRefresh: false,
  catalogSyncedAt: 0, settings: { ...settings }, channels: { ...connector }, extensions: { accountConnectors: { ...connector } }, eacAuth: { local: false },
  catalog: [{ id: 'fixture/model', name: '测试模型', channel: 'anonymous', routable: true, availability: 'available' }] })
const errors = [], requests = [], screenshots = [], checks = [], overflowFailures = [], visited = new Set()
const passed = name => { checks.push(name); console.log('ok   ' + name) }
const count = endpoint => requests.filter(request => request.endpoint === endpoint).length
let browser, context
try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== baseUrl) { errors.push('测试禁止访问外部网络：' + url.origin); return route.abort() }
    if (!url.pathname.startsWith('/api/management/')) return route.continue()
    const endpoint = url.pathname.slice('/api/management'.length)
    const body = request.postData() ? request.postDataJSON() : undefined
    requests.push({ endpoint, method: request.method(), body })
    const answer = (value, status = 200) => route.fulfill({ status, json: value })
    if (endpoint === '/session') {
      assert.equal(request.method(), 'POST')
      loggedIn = body.key === key || body.bootstrapToken === 'test'
      return answer(loggedIn ? { ok: true } : { error: '登录令牌无效' }, loggedIn ? 200 : 401)
    }
    if (!loggedIn) return answer({ error: '管理会话已失效，请重新登录' }, 401)
    if (endpoint === '/summary') { summaryReads++; return answer(summary()) }
    if (endpoint === '/stats') return answer(buildStats({}, []))
    if (endpoint === '/settings') {
      assert.equal(request.method(), 'POST')
      assert.deepEqual(Object.keys(body).sort(), Object.keys(settings).sort(), '保存只能提交六个公开设置')
      for (const name of ['enabled', 'exposeRegionModels', 'streamRecovery', 'standaloneProbe']) assert.equal(typeof body[name], 'boolean', name + ' 必须保持布尔参数')
      assert.ok(Number.isInteger(body.defaultMaxTokens) && body.defaultMaxTokens >= 512 && body.defaultMaxTokens <= 131072)
      assert.ok(Number.isInteger(body.probeIntervalMinutes) && body.probeIntervalMinutes >= 1 && body.probeIntervalMinutes <= 1440)
      if (saveGate) { const gate = saveGate; gate.started(); await gate.release }
      if (failNextSave) { failNextSave = false; return answer({ error: '测试保存失败，修改已保留，请重试。' }, 500) }
      Object.assign(settings, body); return answer({ settings: { ...settings } })
    }
    if (endpoint === '/key') return answer({ key })
    if (endpoint === '/key/rotate') { assert.deepEqual(body, { confirm: true }); key = 'ofm-ui-rotated-key'; return answer({ key }) }
    if (endpoint === '/logout') { assert.deepEqual(body, {}); loggedIn = false; return answer({ ok: true }) }
    if (endpoint === '/eac/status') return answer({ available: true, authorized: false, local: false, login: '' })
    if (endpoint === '/eac/pool') return answer({ inflight: 0, pool: 100, active24h: 0 })
    if (endpoint === '/channels/rpc') { errors.push('核心不得调用旧账号 RPC'); return answer({ error: '旧账号管理入口已移除', code: 'LEGACY_CHANNELS_REMOVED' }, 410) }
    if (endpoint.startsWith('/extensions/account-connectors/')) {
      const action = endpoint.slice('/extensions/account-connectors/'.length)
      assert.equal(request.method(), 'POST')
      if (action === 'install') {
        assert.deepEqual(body, { path: 'D:\\ofm-fixtures\\account-connectors', trustDevelopment: true })
        connector = { ...connector, state: 'disabled', installed: true, enabled: false, version: '0.1.0', providerCount: 13, modelCount: 0, error: '' }
      } else if (action === 'enable') {
        assert.deepEqual(body, {})
        if (failNextEnable) { failNextEnable = false; connector = { ...connector, state: 'failed', enabled: false, modelCount: 0, error: '测试扩展无法启动，请检查安装文件。' }; return answer({ error: connector.error }, 503) }
        connector = { ...connector, state: 'ready', enabled: true, modelCount: 2, error: '' }
      } else if (action === 'disable') { assert.deepEqual(body, {}); connector = { ...connector, state: 'disabled', enabled: false, modelCount: 0, error: '' } }
      else if (action === 'uninstall') { assert.deepEqual(body, { deleteData: false }); connector = { ...connector, state: 'not-installed', installed: false, enabled: false, modelCount: 0, version: null, error: '' } }
      else return answer({ error: '测试未声明该扩展接口' }, 404)
      return answer({ accountConnectors: { ...connector } })
    }
    return answer({ error: '测试未声明该管理接口：' + endpoint }, 404)
  })
  const nav = async name => { await page.locator('.console-nav-item').filter({ hasText: name }).click(); visited.add(name) }
  const waitForPoll = async description => {
    const before = summaryReads
    // 等待真实 15 秒自动轮询；不改时钟、不手动调用刷新。
    await page.waitForResponse(response => new URL(response.url()).pathname === '/api/management/summary', { timeout: 20000 })
    assert.ok(summaryReads > before, description)
  }
  const refreshConnector = async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/management/summary')
    await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await response
  }
  const expectText = value => page.getByText(value, { exact: true }).first().waitFor()
  const screenshot = async name => { const file = path.join(imageDir, (sourceMode ? 'source-' : '') + name + '.png'); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file) }
  const noOverflow = async name => {
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
    if (dimensions.scroll > dimensions.width || dimensions.body > dimensions.width) {
      const elements = await page.evaluate(() => [...document.querySelectorAll('main, .page, .connection-browser, .connection-card, .copy-field, .cx-field, .connection-example, .extensions-page')].map(element => ({ tag: element.tagName, class: element.className, width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right, scroll: element.scrollWidth, minWidth: getComputedStyle(element).minWidth })).filter(element => element.right > innerWidth || element.width > innerWidth).slice(0, 12))
      overflowFailures.push({ name, ...dimensions, elements }); console.error('overflow: ' + JSON.stringify(overflowFailures.at(-1)))
    }
  }
  fs.mkdirSync(imageDir, { recursive: true })
  await page.goto(baseUrl)
  await page.locator('#login-key').fill('bad-key')
  await page.getByRole('button', { name: '进入控制台' }).click()
  await expectText('登录令牌无效'); assert.equal(loggedIn, false)
  await page.locator('#login-key').fill(key)
  await page.getByRole('button', { name: '进入控制台' }).click()
  await page.getByTestId('overview-ready').waitFor(); visited.add('概览')
  assert.equal(await page.locator('#login-key').count(), 0)
  passed('真实登录失败/成功与 React 概览')
  await nav('模型清单'); await page.getByTestId('models-ready').waitFor()
  await nav('用量统计'); await page.getByTestId('usage-ready').waitFor()
  await nav('服务设置'); await page.getByTestId('settings-ready').waitFor()

  const tokenInput = page.locator('#setting-defaultMaxTokens'), intervalInput = page.locator('#setting-probeIntervalMinutes')
  await tokenInput.fill('8192')
  await page.evaluate(() => { window.__ofmSettingsInput = document.getElementById('setting-defaultMaxTokens') })
  settings.probeIntervalMinutes = 12
  await waitForPoll('15 秒自动轮询应执行，且不得覆盖设置草稿')
  assert.equal(await tokenInput.inputValue(), '8192')
  assert.equal(await intervalInput.inputValue(), '15', '更新后台基线不能覆盖当前草稿')
  assert.equal(await page.evaluate(() => window.__ofmSettingsInput === document.getElementById('setting-defaultMaxTokens')), true)
  assert.equal(count('/settings'), 0, '轮询不能自动提交草稿')
  await page.getByRole('button', { name: '撤销修改', exact: true }).click()
  assert.equal(await tokenInput.inputValue(), '32768'); assert.equal(await intervalInput.inputValue(), '12', '撤销应恢复最新后台基线')
  assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true)
  passed('真实轮询保留设置草稿、页面节点和最新撤销基线')

  for (const [input, invalid] of [[tokenInput, ['', '511', '131073', '512.5']], [intervalInput, ['', '0', '1441', '1.5']]]) {
    for (const value of invalid) {
      await tokenInput.fill('8192'); await intervalInput.fill('12'); await input.fill(value)
      await page.getByRole('button', { name: '保存设置', exact: true }).click()
      assert.equal(await input.getAttribute('aria-invalid'), 'true', '空值、小数和越界必须显示字段错误')
      assert.equal(count('/settings'), 0, '无效参数不得发保存请求')
    }
  }
  await tokenInput.fill(''); await intervalInput.fill('0')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  assert.equal(await page.locator('.settings-field-error').count(), 2)
  assert.equal(settings.defaultMaxTokens, 32768)
  passed('设置空值、小数、上下界及双字段错误阻止真实提交')
  await tokenInput.fill('8192'); await intervalInput.fill('12')
  for (const [name, checked] of [['enabled', false], ['exposeRegionModels', false], ['streamRecovery', false], ['standaloneProbe', true]]) await page.locator('input[name="' + name + '"]').setChecked(checked)
  const expectedSettings = { enabled: false, exposeRegionModels: false, streamRecovery: false, standaloneProbe: true, defaultMaxTokens: 8192, probeIntervalMinutes: 12 }
  failNextSave = true
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await expectText('测试保存失败，修改已保留，请重试。')
  assert.equal(await tokenInput.inputValue(), '8192'); assert.equal(await intervalInput.inputValue(), '12')
  assert.equal(settings.defaultMaxTokens, 32768)
  assert.deepEqual(requests.find(request => request.endpoint === '/settings').body, expectedSettings)
  passed('保存失败保留草稿，六个参数的类型和值不变')
  let started, release
  const starting = new Promise(resolve => { started = resolve })
  saveGate = { started, release: new Promise(resolve => { release = resolve }) }
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await starting
  try {
    assert.equal(await tokenInput.isDisabled(), true); assert.equal(await intervalInput.isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '正在保存', exact: true }).isDisabled(), true)
  } finally { release(); saveGate = undefined }
  await expectText('设置已保存并生效')
  assert.deepEqual(settings, expectedSettings)
  assert.equal(count('/settings'), 2, '重试只执行一次保存')
  await nav('概览'); await nav('服务设置'); await page.getByTestId('settings-ready').waitFor()
  assert.equal(await tokenInput.inputValue(), '8192'); assert.equal(await intervalInput.inputValue(), '12')
  for (const [name, checked] of Object.entries(expectedSettings).filter(([, value]) => typeof value === 'boolean')) assert.equal(await page.locator('input[name="' + name + '"]').isChecked(), checked)
  passed('保存忙碌态禁止重复提交，成功后六项设置在切页后保持')

  await nav('API 接入'); await page.getByTestId('connection-ready').waitFor()
  assert.equal(await page.locator('#connection-key').inputValue(), '')
  assert.equal(await page.getByRole('button', { name: '复制', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '查看密钥', exact: true }).click()
  await page.waitForFunction(() => document.getElementById('connection-key').value.length > 0)
  assert.equal(await page.locator('#connection-key').inputValue(), key)
  await page.getByRole('button', { name: '复制', exact: true }).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), key)
  await page.getByRole('button', { name: '隐藏密钥', exact: true }).click()
  assert.equal(await page.locator('#connection-key').inputValue(), '')
  await page.getByRole('button', { name: '复制地址', exact: true }).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), baseUrl + '/v1')
  await page.getByRole('button', { name: '复制示例', exact: true }).click()
  const example = await page.evaluate(() => navigator.clipboard.readText())
  assert.ok(example.includes('Bearer YOUR_API_KEY') && example.includes('fixture/model')); assert.ok(!example.includes(key))
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: '轮换密钥', exact: true }).click()
  assert.equal(count('/key/rotate'), 0, '取消确认不得轮换密钥')
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '轮换密钥', exact: true }).click()
  await page.waitForFunction(() => document.getElementById('connection-key').value === 'ofm-ui-rotated-key')
  assert.equal(count('/key/rotate'), 1)
  await page.getByRole('button', { name: '隐藏密钥', exact: true }).click()
  passed('API 密钥显隐、真实剪贴板复制、取消/确认轮换与请求参数')

  await nav('账号连接扩展'); await page.getByTestId('extensions-ready').waitFor()
  assert.equal(await page.getByLabel('搜索渠道').count(), 0, '核心扩展页不再包含账号渠道浏览器')
  const directory = page.locator('#extension-directory'), trust = page.locator('.extensions-trust input')
  const importButton = page.getByRole('button', { name: '导入本机扩展', exact: true })
  assert.equal(await importButton.isDisabled(), true)
  await directory.fill('D:\\ofm-fixtures\\account-connectors')
  assert.equal(await importButton.isDisabled(), true, '未确认信任不能导入')
  await trust.check()
  await page.evaluate(() => { window.__ofmExtensionInput = document.getElementById('extension-directory') })
  await waitForPoll('真实自动轮询必须执行，且保留正在填写的扩展页面')
  assert.equal(await directory.inputValue(), 'D:\\ofm-fixtures\\account-connectors')
  assert.equal(await trust.isChecked(), true)
  assert.equal(await page.evaluate(() => window.__ofmExtensionInput === document.getElementById('extension-directory')), true)
  assert.equal(await page.locator('.console-nav-item.selected').innerText(), '账号连接扩展')
  passed('扩展页替代旧账号子页，轮询保留导航、填写内容、信任选择和节点')
  await importButton.click(); await expectText('已安装 · 待启用')
  assert.equal(count('/extensions/account-connectors/install'), 1); assert.equal(count('/extensions/account-connectors/enable'), 0)
  assert.equal(await directory.isDisabled(), true)
  failNextEnable = true
  await page.getByRole('button', { name: '启用扩展', exact: true }).click()
  await expectText('测试扩展无法启动，请检查安装文件。')
  await refreshConnector(); await expectText('扩展故障')
  await page.getByRole('button', { name: '重试启用', exact: true }).click(); await expectText('已连接')
  assert.equal(await page.getByRole('link', { name: '打开扩展管理' }).getAttribute('href'), connectorTarget)
  await page.getByRole('button', { name: '停用扩展', exact: true }).click(); await expectText('已安装 · 待启用')
  assert.equal(await page.getByRole('link', { name: '打开扩展管理' }).count(), 0)
  await page.getByRole('button', { name: '卸载扩展', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(count('/extensions/account-connectors/uninstall'), 0)
  await page.getByRole('button', { name: '卸载扩展', exact: true }).click()
  await page.getByRole('button', { name: '确认卸载并保留数据', exact: true }).click(); await expectText('未安装')
  assert.equal(count('/extensions/account-connectors/uninstall'), 1)
  passed('显式信任导入不自动启用，失败重试、停用及确认卸载保留数据')
  await page.goto(baseUrl + '/?pageKey=channels'); await page.getByTestId('extensions-ready').waitFor()
  assert.equal(await page.locator('.console-nav-item.selected').innerText(), '账号连接扩展')
  await nav('EAC 协付渠道'); await page.getByRole('heading', { name: 'EAC 协付渠道', exact: true }).waitFor()
  await page.getByRole('heading', { name: 'EAC 实时资源池', exact: true }).waitFor()
  await page.getByText('当前并发：0', { exact: false }).waitFor()
  assert.ok(count('/eac/status') > 0 && count('/eac/pool') > 0)
  assert.equal(count('/channels/rpc'), 0)
  passed('旧 pageKey 转指引，EAC 实际授权/资源池加载且无供应商账号 RPC')

  const layouts = [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 740 }]]
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize(layouts[0][1])
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; localStorage.setItem('ofm-theme', theme) }, theme)
    await nav('EAC 协付渠道'); await page.getByRole('heading', { name: 'EAC 实时资源池', exact: true }).waitFor()
    await screenshot('react-eac-' + theme + '-desktop')
    await nav('API 接入'); await page.getByTestId('connection-ready').waitFor()
    assert.equal(await page.locator('#eac-root').count(), 0, '离开 EAC 后必须卸载独立挂载点')
    for (const [name, viewport] of layouts) { await page.setViewportSize(viewport); await noOverflow(theme + '/API/' + name); await screenshot('react-connection-' + theme + '-' + name) }
    // 在标准视口实际应用根节点 200% 缩放，并检查缩放后的几何尺寸。
    await page.setViewportSize(layouts[0][1])
    await page.evaluate(() => { document.documentElement.style.zoom = '2' })
    try {
      const zoom = await page.evaluate(() => ({ viewport: innerWidth, layoutWidth: Number.parseFloat(getComputedStyle(document.documentElement).width), rootClientWidth: document.documentElement.clientWidth, zoom: getComputedStyle(document.documentElement).zoom }))
      assert.equal(zoom.viewport, 1280); assert.equal(zoom.layoutWidth, 640); assert.equal(Number(zoom.zoom), 2)
      await noOverflow(theme + '/API/root-zoom200')
      const escapedControls = await page.locator('.connection-browser input, .connection-browser button').evaluateAll(elements => elements.map(element => ({ name: element.id || element.textContent.trim(), rect: element.getBoundingClientRect(), card: element.closest('.connection-card').getBoundingClientRect() })).filter(({ rect, card }) => rect.left < card.left || rect.right > card.right || rect.top < card.top || rect.bottom > card.bottom).map(({ name }) => name))
      assert.deepEqual(escapedControls, [], '200% 缩放后字段和按钮必须完整位于卡片内')
      console.log('root zoom: ' + JSON.stringify({ theme, ...zoom }))
      await screenshot('react-connection-' + theme + '-root-zoom200')
    } finally { await page.evaluate(() => { document.documentElement.style.zoom = '' }) }
    await page.setViewportSize(layouts[0][1]); await nav('账号连接扩展'); await page.getByTestId('extensions-ready').waitFor()
    for (const state of ['not-installed', 'disabled', 'starting', 'ready', 'failed', 'incompatible', 'stopping']) {
      connector = { ...connector, state, installed: state !== 'not-installed', enabled: state === 'ready', version: state === 'not-installed' ? null : '0.1.0', modelCount: state === 'ready' ? 2 : 0,
        error: ['failed', 'incompatible'].includes(state) ? '测试扩展加载失败，请核对协议和文件摘要：' + 'long-directory/'.repeat(32) : '' }
      await refreshConnector()
      const stateLabel = { 'not-installed': '未安装', disabled: '已安装 · 待启用', starting: '正在启用', ready: '已连接', failed: '扩展故障', incompatible: '不兼容', stopping: '正在停用' }[state]
      await expectText(stateLabel); await noOverflow(theme + '/扩展/' + state)
      if (state === 'incompatible') assert.equal(await page.getByRole('button', { name: '启用扩展', exact: true }).count(), 0)
      assert.equal(await page.getByRole('link', { name: '打开扩展管理' }).count(), state === 'ready' ? 1 : 0)
      await screenshot('react-extensions-' + theme + '-' + state)
    }
    connector = { ...connector, state: 'failed', enabled: false, error: '测试长错误说明：' + 'long-directory/'.repeat(32) }
    await refreshConnector(); await expectText('扩展故障')
    for (const [name, viewport] of [['zoom200-equivalent', { width: 640, height: 450 }], ...layouts.slice(1)]) {
      await page.setViewportSize(viewport); await noOverflow(theme + '/扩展长错误/' + name); await screenshot('react-extensions-' + theme + '-' + name)
    }
  }
  if (!overflowFailures.length) passed('昼夜七状态、API 三视口和根节点 200% 缩放、扩展窄屏均无横向溢出；真实截图已保存')
  else console.error('FAIL 昼夜/窄屏布局：' + overflowFailures.length + ' 项溢出，已保存对应真实截图')
  await page.setViewportSize(layouts[0][1]); await nav('API 接入'); await page.getByTestId('connection-ready').waitFor()
  await page.getByRole('button', { name: '查看密钥', exact: true }).click()
  await page.waitForFunction(() => document.getElementById('connection-key').value === 'ofm-ui-rotated-key')
  await page.getByRole('button', { name: '退出管理', exact: true }).click()
  await page.getByTestId('login-screen').waitFor()
  assert.equal(loggedIn, false); assert.equal(await page.locator('#connection-key').count(), 0)
  const afterLogout = await page.evaluate(async () => ({ status: (await fetch('/api/management/key', { credentials: 'same-origin' })).status }))
  assert.equal(afterLogout.status, 401, '登出后管理读写必须重新鉴权')
  assert.deepEqual([...visited].sort(), ['概览', '模型清单', '用量统计', '服务设置', 'API 接入', '账号连接扩展', 'EAC 协付渠道'].sort())
  assert.deepEqual(errors, [])
  passed('七页面导航、退出清除密钥和会话、无浏览器错误或外部请求')
  assert.equal(overflowFailures.length, 0, '所有原有及新增视口都必须不溢出：' + overflowFailures.map(item => item.name + ' ' + item.width + '→' + item.scroll).join('；'))
  console.log('react UI (' + (sourceMode ? 'in-memory source' : 'built web assets') + '): ' + checks.length + '/' + checks.length + ' 组真实检查通过，' + screenshots.length + ' 张截图；browser=' + browser.version())
  console.log('screenshots: ' + path.resolve(imageDir))
} catch (error) {
  console.error('react UI failure: ' + JSON.stringify({ passed: checks.length, browserErrors: errors, latestRequests: requests.slice(-6), overflowFailures: overflowFailures.map(({ name, width, scroll }) => ({ name, width, scroll })), screenshots: screenshots.length }))
  throw error
} finally {
  await context?.close(); await browser?.close(); management.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
