/** Actual browser regression for upstream navigation + separated account extensions.
 * No external requests, installed profiles, real credentials or upgrade files.
 * node scripts/upstream-ui-parity-test.mjs [--out-dir <audit directory>]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out-dir')
const outDir = path.resolve(outIndex >= 0 ? argv[outIndex + 1] : process.env.OFM_UI_PARITY_OUT_DIR || path.join(os.tmpdir(), 'ofm-upstream-ui-parity'))
fs.mkdirSync(outDir, { recursive: true })
const require = createRequire(import.meta.url)
const frontendRequire = createRequire(new URL('../packages/standalone/package.json', import.meta.url))
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE || process.env.OFM_TEST_PLAYWRIGHT_MODULE || 'playwright')
const { build } = frontendRequire('esbuild')
const reactBundle = await build({ stdin: { contents: 'import * as React from "react"; import * as ReactDOM from "react-dom"; import * as Client from "react-dom/client"; window.__uiRuntime={React,ReactDOM,Client}', resolveDir: path.join(root, 'packages/standalone') }, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
const reactRuntime = reactBundle.outputFiles[0].text
const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const preview = fs.readFileSync(path.join(root, 'scripts/ui-preview.mjs'), 'utf8')
const fixturePalette = preview.match(/const FALLBACK_THEME = \x60([\s\S]*?)\x60/)[1]
const webRoot = path.join(root, 'packages/standalone/web')
const assets = JSON.parse(fs.readFileSync(path.join(webRoot, 'assets.json'), 'utf8'))
assert.ok(assets.every(name => /^[\w-]+\.(js|css)$/.test(name)), 'asset paths are manifest-controlled')
assert.ok(!assets.some(name => /channels|channel-pack/.test(name)), 'rebuilt web must not restore the old account bundle')
const coreVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const extension = { id: 'ofm.account-connectors', state: 'not-installed', installed: false, enabled: false, version: null, protocolVersion: 1, providerCount: 0, modelCount: 0, managementTarget: '' }
const settings = { enabled: true, exposeRegionModels: true, streamRecovery: true, standaloneProbe: false, defaultMaxTokens: 32768, probeIntervalMinutes: 15, updateCheckHours: 6, autoReloadWatch: false, reloadCount: 0, forward: { enabled: false, running: false, host: '127.0.0.1', port: 18899, lan: { enabled: false, port: 0 } }, egress: { enabled: false, proxyUrl: '' } }
const catalog = [{ id: 'fixture-free', name: '本机免费模型', channel: undefined, route: 'our-free-model', routable: true, availability: 'available', contextWindow: 128000, maxOutput: 8192, reasoning: true }]
const stats = { requests: 0, requestFailures: 0, turns: 0, failedTurns: 0, days: [], models: [], samples: [], grand: { input: 0, output: 0, reasoning: 0, calls: 0, failed: 0 } }
const baselineUpdate = { current: coreVersion, installedVersion: coreVersion, latest: '2.3.1', available: true, applying: false, recoveryRequired: false, versionMismatch: false, checkedAt: Date.now(), notes: '<p>本机上游同步回归样例</p>', lastApplied: { ok: true, from: '2.2.0', to: coreVersion, at: Date.now() - 60000 } }
let update = { ...baselineUpdate }, failCheck = false
const requests = [], problems = [], checks = [], shots = []
const pass = name => { checks.push(name); console.log('ok  ' + name) }
let origin
const summary = standalone => ({ version: coreVersion, baseUrl: origin, dataDir: 'D:/isolated-upstream-ui', networkMode: 'fixture', automaticRefresh: false, catalogSyncedAt: 0, catalog: standalone ? catalog.map(row => ({ ...row, channel: 'anonymous' })) : catalog, settings, extensions: { accountConnectors: extension }, laneAvailable: false, eacAuth: { available: false, authorized: false, local: false, login: '' }, announcements: { unread: 0 }, announcementVersion: coreVersion, distribution: 'self', update })
const shell = locale => '<!doctype html><html lang="' + locale + '"><meta charset="utf-8"><style>' + fixturePalette + '\nbody{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}#root{max-width:1200px;margin:auto;padding:16px 18px 40px}</style><body><div id="preview-app"><div id="root"></div><div id="onboarding-slot"></div></div><script src="/react-runtime.js"></script><script>window.__ModuleLoader__={load:record=>{const r=window.__uiRuntime;window.__uiPlugin=record.factory(name=>name==="react"?r.React:name==="react-dom"?r.ReactDOM:undefined)}}</script><script src="/client.js"></script><script>(' + mountPlugin.toString() + ')(' + JSON.stringify(locale) + ')</script></body></html>'
function mountPlugin(localeTag) {
  const { React, Client } = window.__uiRuntime
  const dictionaries = {}, registrations = { section: [], onboarding: [] }, disposers = []
  const locale = { register: (ns, table) => { dictionaries[ns] = table }, bind: ns => Object.assign(key => dictionaries[ns]?.[localeTag]?.[key] ?? key, { locale: localeTag }), getLocale: () => ({ active: localeTag }), getSnapshot: () => ({ active: localeTag }) }
  const slots = { inject: (_name, callback) => { callback(); return { [Symbol.dispose]() {} } }, register: (options, component) => { (options.name === 'settings.onboarding' ? registrations.onboarding : registrations.section).push({ options, component }); return () => {} } }
  const ctx = { slots, locale, get: name => name === 'slots' ? slots : name === 'locale' ? locale : undefined, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return { [Symbol.dispose]() {} } } }
  window.__uiPlugin.apply(ctx)
  const entry = registrations.section.find(row => row.options.id === 'our-free-model')
  Client.createRoot(document.getElementById('root')).render(React.createElement(entry.component, { ctx, t: locale.bind(entry.options.locale) }))
  let onboardingRoot
  window.__parity = { openOnboarding: () => {
    const app = document.getElementById('preview-app')
    app.inert = true
    app.style.transform = 'translate3d(0,20px,0)'
    app.style.contain = 'paint'
    if (!onboardingRoot) onboardingRoot = Client.createRoot(document.getElementById('onboarding-slot'))
    const onboarding = registrations.onboarding[0]
    onboardingRoot.render(React.createElement(onboarding.component, { explicit: true, complete: () => { onboardingRoot.render(null); app.inert = false; app.style.transform = ''; app.style.contain = '' } }))
  } }
}
const server = http.createServer((req, res) => { void handle(req, res).catch(error => { problems.push('fixture server: ' + error.message); if (!res.headersSent) res.writeHead(500); res.end() }) })
async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (value, status = 200, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(type.startsWith('application/json') ? JSON.stringify(value) : value) }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
  if (url.pathname === '/plugin') return send(shell(url.searchParams.get('locale') === 'en' ? 'en' : 'zh'), 200, 'text/html; charset=utf-8')
  if (url.pathname === '/react-runtime.js') return send(reactRuntime, 200, 'text/javascript; charset=utf-8')
  if (url.pathname === '/client.js') return send(client, 200, 'text/javascript; charset=utf-8')
  if (url.pathname === '/') return send(fs.readFileSync(path.join(webRoot, 'index.html')), 200, 'text/html; charset=utf-8')
  if (url.pathname.startsWith('/assets/')) {
    const name = url.pathname.slice('/assets/'.length)
    if (!assets.includes(name)) return send({ error: 'asset not in manifest' }, 404)
    return send(fs.readFileSync(path.join(webRoot, name)), 200, name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8')
  }
  const standalone = url.pathname.startsWith('/api/management/')
  const prefix = standalone ? '/api/management' : '/api/our-free-model'
  if (!url.pathname.startsWith(prefix + '/')) return send({ error: 'unknown fixture path' }, 404)
  const endpoint = url.pathname.slice(prefix.length)
  if (endpoint === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write('event: hello\ndata: {"version":"' + coreVersion + '","reloadedAt":0}\n\n'); req.on('close', () => res.end()); return }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
  requests.push({ surface: standalone ? 'standalone' : 'plugin', endpoint, method: req.method, ...(body ? { body } : {}) })
  if (endpoint === '/summary') return send(summary(standalone))
  if (endpoint === '/stats') return send(stats)
  if (endpoint === '/meta') return send({ version: coreVersion, reloadedAt: 0, reloadCount: 0, distribution: 'self', update, feed: { fetchedAt: 0 } })
  if (endpoint === '/session') return send({ ok: true })
  if (endpoint === '/eac/status') return send(summary(standalone).eacAuth)
  if (endpoint === '/pool' || endpoint === '/eac/pool') return send({ inflight: 0, pool: 100, active24h: 0 })
  if (endpoint === '/announcements') return send({ items: [], unread: 0, fetchedAt: 0, notifyOs: false })
  if (endpoint === '/announcement') return send({ version: coreVersion, acknowledged: false })
  if (endpoint === '/announcement/ack') return send({ ok: true })
  if (endpoint === '/extensions/account-connectors' || endpoint === '/extensions/account-connectors/refresh') return send({ accountConnectors: extension })
  if (endpoint === '/clients') return send({ running: false })
  if (endpoint === '/forward/lan/addresses') return send({ addresses: [] })
  if (endpoint === '/outlet') return send({ running: false })
  if (!standalone && endpoint === '/update/status') return send(update)
  if (!standalone && endpoint === '/update/check') { if (failCheck) { failCheck = false; return send({ error: '本机测试：暂时无法检查更新' }, 503) }; update.checkedAt = Date.now(); return send(update) }
  if (!standalone && endpoint === '/update/apply') { update = { ...update, current: update.latest, installedVersion: update.latest, available: false }; return send({ ok: true, version: update.latest }) }
  if (!standalone && endpoint === '/reload') return send({ ok: true })
  if (!standalone && endpoint === '/settings') { Object.assign(settings, body); return send({ settings }) }
  problems.push('unexpected API request: ' + prefix + endpoint)
  return send({ error: 'unimplemented parity fixture' }, 404)
}
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
origin = 'http://127.0.0.1:' + server.address().port
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(file => fs.existsSync(file))
const executablePath = process.env.OFM_TEST_BROWSER_EXECUTABLE || process.env.OFM_BROWSER_EXECUTABLE || edge
let browser
async function contextFor({ surface, theme, width, locale = 'zh', savedTab }) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin) return route.continue(); problems.push('external browser request blocked: ' + url.hostname); return route.abort() })
  await context.addInitScript(({ surface, theme, savedTab }) => { if (surface === 'plugin') { if (savedTab && !sessionStorage.getItem('parity-seeded')) localStorage.setItem('ofm.tab', savedTab); if (theme === 'dark') document.addEventListener('DOMContentLoaded', () => document.body.setAttribute('data-ds-dark-theme', '')) } else { if (!sessionStorage.getItem('parity-seeded')) { localStorage.setItem('ofm-theme', theme); localStorage.setItem('ofm-page', savedTab || 'overview') } } sessionStorage.setItem('parity-seeded', 'true') }, { surface, theme, savedTab })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => problems.push(surface + ' browser error: ' + error.message))
  await page.goto(origin + (surface === 'plugin' ? '/plugin?locale=' + locale : '/'), { waitUntil: 'load' })
  await page.locator(surface === 'plugin' ? '.ofm_tabs .ofm_tab' : '.console-nav-item').first().waitFor()
  return { context, page }
}
async function snapshot(page, file) {
  const size = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, theme: document.documentElement.dataset.theme ?? (document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'), background: getComputedStyle(document.body).backgroundColor, label: getComputedStyle(document.body).getPropertyValue('--dsw-alias-label-primary').trim() }))
  assert.ok(size.scrollWidth <= size.width + 1, file + ' has document horizontal overflow: ' + JSON.stringify(size))
  await page.screenshot({ path: path.join(outDir, file), fullPage: true })
  shots.push({ file, ...size })
}
try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  for (const theme of ['light', 'dark']) for (const width of [1280, 390, 320]) {
    const { page, context } = await contextFor({ surface: 'plugin', theme, width })
    const name = 'plugin-' + theme + '-' + width
    const tabs = await page.getByRole('tab').allTextContents()
    const gateway = tabs.findIndex(text => text === '网关设置')
    assert.equal(tabs[gateway + 1], '插件升级')
    assert.ok(tabs.some(text => text === '账号连接扩展'))
    assert.ok(!tabs.some(text => /白嫖模型接入/.test(text)))
    assert.equal(await page.getByRole('button', { name: '检查更新', exact: true }).count(), 0, 'free page must not duplicate the updater')
    await page.getByRole('button', { name: '打开插件升级', exact: true }).click()
    await page.getByRole('button', { name: '检查更新', exact: true }).waitFor()
    assert.equal(await page.getByRole('tab', { name: '插件升级', exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.getByRole('button', { name: '检查更新', exact: true }).count(), 1)
    await snapshot(page, name + '-upgrade.png')
    await page.getByRole('tab', { name: '账号连接扩展', exact: true }).click()
    await page.getByRole('button', { name: '查看安装方法', exact: true }).click()
    await page.locator('#ofm-account-install-guide').waitFor()
    assert.equal(await page.getByRole('button', { name: '打开独立插件管理', exact: true }).isEnabled(), false)
    await snapshot(page, name + '-extension-guide.png')
    await page.getByRole('button', { name: '刷新检测', exact: true }).click()
    await page.getByText('已刷新扩展状态与公开模型目录。', { exact: true }).waitFor()
    pass(name + ': nav order, legacy update shortcut, single updater and optional extension guide')
    await context.close()
  }
  for (const theme of ['light', 'dark']) {
    const { page, context } = await contextFor({ surface: 'plugin', theme, width: 390, locale: 'en', savedTab: 'upgrade' })
    const tabs = await page.getByRole('tab').allTextContents()
    assert.equal(tabs[tabs.indexOf('Gateway') + 1], 'Plugin upgrade')
    await page.getByRole('button', { name: 'Check for updates', exact: true }).waitFor()
    await page.reload()
    assert.equal(await page.getByRole('tab', { name: 'Plugin upgrade', exact: true }).getAttribute('aria-selected'), 'true')
    await snapshot(page, 'plugin-' + theme + '-en-upgrade.png')
    pass('plugin ' + theme + ': English upgrade navigation persists through reload')
    await context.close()
  }
  {
    const { page, context } = await contextFor({ surface: 'plugin', theme: 'dark', width: 900, savedTab: 'upgrade' })
    const count = endpoint => requests.filter(row => row.surface === 'plugin' && row.endpoint === endpoint && row.method === 'POST').length
    let before = count('/update/check')
    await page.getByRole('button', { name: '检查更新', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.ofm_upgradecards')?.parentElement.querySelector('button')?.disabled)
    assert.equal(count('/update/check'), before + 1)
    failCheck = true
    await page.getByRole('button', { name: '检查更新', exact: true }).click()
    await page.getByText(/本机测试：暂时无法检查更新/).waitFor()
    await page.getByRole('button', { name: '检查更新', exact: true }).click()
    await page.getByText(/本机测试：暂时无法检查更新/).waitFor({ state: 'hidden' })
    before = count('/reload')
    await page.getByRole('button', { name: '热重载插件', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => node.textContent === '热重载插件' && !node.disabled))
    assert.equal(count('/reload'), before + 1)
    const watch = page.getByRole('switch', { name: '文件变化自动热重载', exact: true })
    const watchBefore = await watch.getAttribute('aria-checked')
    await watch.click()
    await page.waitForFunction(value => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') !== value, watchBefore)
    assert.equal(settings.autoReloadWatch, true)
    before = count('/update/apply')
    await page.getByRole('button', { name: '立即升级', exact: true }).click()
    await page.getByText(/已升级到/).waitFor()
    assert.equal(count('/update/apply'), before + 1)
    assert.equal(await page.getByRole('button', { name: '立即升级', exact: true }).count(), 0)
    pass('plugin updater: check/retry, hot reload, auto reload and apply use existing APIs')
    update = { ...baselineUpdate, recoveryRequired: true, versionMismatch: true, recoveryBackup: 'D:/isolated-upgrade-backup' }
    await page.reload()
    await page.getByText(/D:\/isolated-upgrade-backup/).waitFor()
    assert.equal(await page.getByRole('button', { name: '立即升级', exact: true }).isEnabled(), false)
    assert.equal(await page.getByRole('button', { name: '热重载插件', exact: true }).isEnabled(), false)
    pass('plugin recovery and version mismatch keep upgrade/reload disabled and backup visible')
    update = { ...baselineUpdate }
    await context.close()
  }
  for (const theme of ['light', 'dark']) for (const width of [1280, 320]) {
    const { page, context } = await contextFor({ surface: 'plugin', theme, width, savedTab: 'channels' })
    assert.equal(await page.getByRole('tab', { name: '账号连接扩展', exact: true }).getAttribute('aria-selected'), 'true')
    for (let repeat = 0; repeat < 2; repeat++) {
      await page.evaluate(() => window.__parity.openOnboarding())
      await page.getByRole('dialog').waitFor()
      await page.waitForTimeout(400)
      const portal = await page.evaluate(() => { const host = document.querySelector('[data-ofm-announcement-root]'); const dialog = host.querySelector('[role="dialog"]'); const rect = dialog.getBoundingClientRect(); const button = dialog.querySelector('.ofm_annfoot button:last-child'); const b = button.getBoundingClientRect(); return { bodyHost: host.parentElement === document.body, inertApp: document.getElementById('preview-app').inert, trapped: !!host.closest('[inert]'), clickable: button.contains(document.elementFromPoint(b.x + b.width/2, b.y + b.height/2)), withinViewport: rect.x >= 0 && rect.right <= innerWidth && rect.y >= 0 && rect.bottom <= innerHeight } })
      assert.deepEqual(portal, { bodyHost: true, inertApp: true, trapped: false, clickable: true, withinViewport: true })
      await snapshot(page, 'portal-' + theme + '-' + width + '-' + repeat + '.png')
      if (repeat === 0) { await page.getByRole('button', { name: '›', exact: true }).click(); await page.getByText('2 / 5', { exact: false }).waitFor(); await page.getByRole('button', { name: '‹', exact: true }).click() }
      await page.getByRole('button', { name: '稍后再说', exact: true }).click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      await page.locator('[data-ofm-announcement-root]').waitFor({ state: 'detached' })
    }
    pass('portal ' + theme + '-' + width + ': outside inert/transformed app; clickable and cleaned after repeated open')
    await context.close()
  }
  for (const theme of ['light', 'dark']) for (const width of [1280, 390, 320]) {
    const { page, context } = await contextFor({ surface: 'standalone', theme, width, savedTab: 'upgrade' })
    const nav = page.locator('.console-nav-item')
    const labels = await nav.allTextContents()
    assert.ok(labels.indexOf('插件升级') > labels.indexOf('服务设置'))
    await page.getByTestId('standalone-upgrade-page').waitFor()
    await page.getByRole('link', { name: '查看发行版本', exact: true }).waitFor()
    assert.ok((await page.getByTestId('standalone-upgrade-page').textContent()).includes('v' + coreVersion))
    await page.getByRole('button', { name: '刷新版本信息', exact: true }).click()
    await page.getByText('已刷新当前运行版本。发行版本请在发布页核对。', { exact: true }).waitFor()
    await snapshot(page, 'standalone-' + theme + '-' + width + '-upgrade.png')
    await page.getByRole('button', { name: '查看独立账号连接扩展', exact: true }).click()
    await page.getByRole('heading', { name: '安装方法', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '导入本机扩展', exact: true }).isEnabled(), false)
    await snapshot(page, 'standalone-' + theme + '-' + width + '-extension-guide.png')
    const toggle = page.getByRole('button', { name: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题', exact: true })
    await toggle.click()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme === 'dark' ? 'light' : 'dark')
    await page.reload()
    await page.getByRole('heading', { name: '安装方法', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme === 'dark' ? 'light' : 'dark', 'manual theme persists after reload')
    await page.getByRole('button', { name: '插件升级', exact: true }).click()
    await page.getByTestId('standalone-upgrade-page').waitFor()
    assert.equal(await page.getByRole('button', { name: '插件升级', exact: true }).getAttribute('aria-current'), 'page')
    assert.equal(await page.getByRole('link', { name: '查看发行版本', exact: true }).getAttribute('href'), 'https://github.com/Ebony-Vinyl/dsh-our-free-model/releases')
    await page.reload()
    await page.getByTestId('standalone-upgrade-page').waitFor()
    pass('standalone ' + theme + '-' + width + ': upgrade nav, real version, release link, extension guide and theme switch')
    await context.close()
  }
  assert.ok(!requests.some(row => /channels\/rpc|chan-gateway|account\.list/.test(row.endpoint)), 'no old built-in account API')
  assert.ok(!requests.some(row => row.surface === 'standalone' && /^\/(?:update|reload)/.test(row.endpoint)), 'standalone guide must not claim unsupported hot-upgrade APIs')
  assert.equal(problems.length, 0, problems.join('\n'))
} catch (error) { problems.push(error.stack || error.message); console.error(error.stack || error.message); process.exitCode = 1 }
finally {
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), result: problems.length ? 'failed' : 'passed', coreVersion, environment: 'real React + real client.js + built standalone web; loopback API fixtures only; no installed profiles', standaloneUpgradeScope: 'version and release instructions; standalone host has no hot-upgrade APIs', checks, screenshots: shots, requests, problems }, null, 2) + '\n')
  await browser?.close()
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}
console.log(checks.length + ' upstream UI parity checks; ' + shots.length + ' screenshots; report: ' + path.join(outDir, 'report.json'))
