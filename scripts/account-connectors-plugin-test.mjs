/**
 * DSH core separation contract. No profile, credential file, supplier or live
 * model is touched: host wiring runs against in-memory dependencies and the
 * real optional collaboration helper; client renders through a React stub.
 * Run: node scripts/account-connectors-plugin-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createOptionalAccountBridge, combineCoreWithAccountConnectors, ACCOUNT_PROVIDERS } from '../src/extensions/account-connectors.js'
import { buildStats } from '../src/core/stats.js'
import { SETTINGS_INITIAL, STATS_INITIAL } from '../src/store.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [hostSource, clientSource] = await Promise.all(['index.js', 'client.js'].map(file => fs.readFile(path.join(root, file), 'utf8')))
let checks = 0
const check = async (name, action) => { await action(); console.log('ok ' + (++checks) + ' ' + name) }
const copy = value => JSON.parse(JSON.stringify(value))
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const store = initial => {
  let value = copy(initial)
  return { get: () => value, update: patch => { value = { ...value, ...patch } }, edit: edit => { value = edit(value) }, flush() {}, dispose() {} }
}
const coreCatalog = [
  { id: 'free/mock', name: 'Free fixture' },
  { id: 'eac/mock', name: 'EAC fixture', channel: 'eac' },
  { id: 'kilo/mock', name: 'Kilo fixture', channel: 'kilo' },
  { id: 'minimax/core-official-api', name: 'Official fixture', channel: 'aggregate' },
  { id: 'combo/mock', name: 'Route fixture', channel: 'combo', combo: ['free/mock'] },
]
function fakeExtension(overrides = {}) {
  const listeners = new Set()
  const descriptor = { id: 'ofm.account-connectors', version: '0.1.0', protocolVersion: 1, instanceId: 'fixture-dsh-1', state: 'ready', capabilities: ['hostModels', 'ofmApi', 'managementUi'], managementTarget: '/ofm-account-connectors', ...overrides }
  const service = {
    descriptor, listeners, modelCalls: 0, streamCalls: 0, closeCalls: 0,
    describe: async () => descriptor,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    async listModels() { this.modelCalls++; return [{ id: 'buddy/mock', name: 'Account fixture', apiKey: 'credential-sentinel', access_token: 'credential-sentinel' }] },
    async *stream() {
      this.streamCalls++
      yield { type: 'text-delta', text: 'extension answer' }
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    close() { this.closeCalls++ }, dispose() { this.closeCalls++ },
  }
  return service
}
function mountHost(extension) {
  let lookupFailure = false
  const observations = { adapters: [], routes: [], injections: [], forward: null, coreRequests: [], pushes: [], logs: [], disposed: false }
  const settings = store({ ...copy(SETTINGS_INITIAL), forward: { enabled: true, host: '127.0.0.1', port: 18777, lan: { enabled: false } } })
  const stats = store(STATS_INITIAL)
  const availability = store({ at: 1, results: {} })
  const runtime = {
    catalog: copy(coreCatalog), egress: null, gatewayLatency: { ms: 0, at: 0 },
    state: () => ({ catalog: runtime.catalog, membership: { 'our-free-model': runtime.catalog.map(row => row.id), 'our-free-model-region': [] }, settings: settings.get() }),
    adapter: { async *stream() { throw new Error('No adapter network is permitted in this test') } },
    async complete(request) { observations.coreRequests.push(request.model); return { text: 'core:' + request.model } },
    publicModelRows: () => runtime.catalog.map(row => ({ ...row, object: 'model' })),
    async refreshCatalog() { return runtime.catalog }, async refreshAvailability() {}, async watchEgress() { return false },
    async fetchListing() { return [] }, syncAggregateCatalog: () => runtime.catalog,
    setAttributionUserAgent() {}, dispose() { observations.disposed = true },
  }
  const disposers = []
  const context = {
    logger: { ...quiet, warn: message => observations.logs.push(String(message)) },
    get: name => { if (name === 'ofmAccountConnectors' && lookupFailure) throw new Error('service lookup refused'); return name === 'ofmAccountConnectors' ? extension : undefined },
    fiber: { entry: { options: { id: 'our-free-model' } } },
    llm: {
      registerAdapter(routes, adapter) { observations.adapters.push({ routes, adapter }); return Object.assign(() => {}, { replace() {} }) },
      registerConfigurableProviders() {}, registerModelDiscovery() {},
    },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') disposers.push(cleanup) },
    on() {}, emit() {},
    inject(deps, callback) {
      observations.injections.push(deps)
      if (deps.length === 1 && deps[0] === 'webServer') callback({ effect: context.effect, webServer: { register(route) { observations.routes.push(route); return () => {} } } })
      if (deps.length === 1 && deps[0] === 'ofmAccountConnectors' && extension) callback(context)
    },
  }
  const timer = () => ({ unref() {} })
  const dependencies = {
    console: quiet, URL, AbortController, AbortSignal, Buffer, Symbol, Date, Promise, Map, Set, Object, Number, String, RegExp,
    process: { platform: 'fixture', env: {} },
    os: { networkInterfaces: () => ({}) }, path, crypto,
    fs: { mkdirSync() {}, readFileSync(file) { if (!file.endsWith('package.json')) throw new Error('Unexpected filesystem read: ' + file); return '{"version":"fixture"}' } },
    spawn() { throw new Error('No external process may be launched') }, fileURLToPath,
    setTimeout: timer, clearTimeout() {},
    ROUTE_LABELS: { 'our-free-model': 'Free' }, ROUTE_MAIN: 'our-free-model', ROUTE_REGION: 'our-free-model-region',
    DATA_DIR_NAME: 'fixture', resolveDshHome: () => '/in-memory-only', decodeWindow: () => ({ measurable: false }),
    isEacEntry: row => row.channel === 'eac', isKiloEntry: row => row.channel === 'kilo', STATE: { available: 'available', unknown: 'unknown' },
    generateKey: () => 'mock-forward-key', rankLanAddresses: () => [],
    startForwardServer: async options => { observations.forward = options; return { host: '127.0.0.1', port: 18777, close: async () => {} } },
    startLanRelay: async () => { throw new Error('LAN listener not requested') },
    CODE: { server: 'server' }, UpstreamError: Error, outletLabel: () => '', readOutletSelection: async () => ({}),
    startEgressRelay: async () => { throw new Error('No egress network requested') },
    directFetch: async () => { throw new Error('No supplier network is permitted') },
    clearEacUser() { throw new Error('No credentials may be changed') }, readEacUser() { throw new Error('No credentials may be read') }, writeEacUser() { throw new Error('No credentials may be written') },
    createEacLoginPoller: () => ({ reset() {} }), unlockSealedLane: () => null,
    DEFAULT_LEVEL: 'balanced', budgetLadder: () => [], windowTokens: () => 0,
    AnnouncementFeed: class { load() {} view() { return { unread: 0, fetchedAt: 0 } } },
    PluginUpdater: class { status() { return { available: false, latest: '', current: 'fixture', checkedAt: 0 } } },
    selfReload() { throw new Error('No reload requested') }, watchPackage() { throw new Error('No watcher requested') }, isReloading: () => false,
    createPushHub: () => ({ emit(type, value) { observations.pushes.push({ type, value }) }, dispose() {} }),
    rejectionFor: () => undefined, isLoopbackHost: host => host === '127.0.0.1', connectionAdmissionView: () => undefined,
    resolveAttributionUserAgent: async () => 'fixture',
    buildAggregateCatalog: () => [], fetchProviderModels: async () => [], isAggregateEntry: row => row.channel === 'aggregate', testProvider: async () => ({}),
    buildComboCatalog: () => [], isComboEntry: row => row.channel === 'combo', normalizeCombos: value => value ?? [], pruneRotation() {}, getProvider: () => null, listProviders: () => [],
    addSavings() {}, describeSavingsTotal: () => ({}), emptySavings: () => ({}), saverConfig: () => ({}), savingsPercent: () => 0,
    CAVEMAN_LEVELS: ['off', 'lite'], PONYTAIL_LEVELS: ['off'], OPTIMIZATIONS: [],
    createModelRuntime: () => runtime, createRuntimeStores: () => ({ settings, stats, availability, dispose() {} }),
    createOptionalAccountBridge, combineCoreWithAccountConnectors, buildStats,
  }
  // Only import declarations are replaced. All apply()/API/summary code runs as
  // written, with memory-only services; any account dynamic import would fail.
  const script = hostSource.replace(/^import .*$/gm, '').replace(/^export \{.*\}.*$/gm, '').replace(/^export /gm, '').replace(/import\.meta\.url/g, JSON.stringify('file:///D:/in-memory-only/index.js')) + '\n;globalThis.hostFixture = { apply, inject, publicAccountExtension };'
  const sandbox = { ...dependencies }
  vm.runInNewContext(script, sandbox, { filename: 'index.js', timeout: 5000 })
  sandbox.hostFixture.apply(context, { distribution: 'managed' })
  const api = observations.routes.find(route => route.kind === 'prefix')?.handler
  assert.equal(typeof api, 'function', 'settings API must mount without an account service')
  return { observations, runtime, settings, stats, api, sandbox, setExtension(value) { extension = value }, setLookupFailure(value) { lookupFailure = value }, dispose() { for (const disposer of disposers.reverse()) disposer() } }
}
async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve() }
async function call(host, method, route, body) {
  let status, text = '', bodyReads = 0
  const req = { url: '/api/our-free-model' + route, method, headers: {}, async *[Symbol.asyncIterator]() { bodyReads++; yield Buffer.from(JSON.stringify(body ?? {})) } }
  const res = { writeHead(value) { status = value }, end(value) { text = String(value) } }
  await host.api(req, res)
  return { status, json: JSON.parse(text), bodyReads }
}

const mounted = []
try {
  await check('core entry removes bundled account import, dedicated relay and credential/command injection', () => {
    assert.doesNotMatch(hostSource, /vendor\/channel-pack|channelPack|startChanRelay|chanGateway|pack\.apply/)
    assert.doesNotMatch(hostSource, /inject\(\[['"]credentials['"]|inject\(\[['"]commands['"]/)
    assert.match(hostSource, /optional\('ofmAccountConnectors'\)/)
    assert.match(hostSource, /combineCoreWithAccountConnectors\(modelRuntime, accountBridge\)/)
  })
  const missing = mountHost(undefined); mounted.push(missing); await settle()
  await check('absent native extension never blocks core adapter, EAC, Kilo, official API, route and gateway', async () => {
    assert.deepEqual(copy(missing.sandbox.hostFixture.inject), ['llm'])
    assert.equal(missing.observations.adapters.length, 1)
    assert.equal(missing.observations.forward !== null, true)
    const summary = await call(missing, 'GET', '/summary')
    assert.equal(summary.status, 200)
    assert.deepEqual(summary.json.catalog.map(row => row.id), coreCatalog.map(row => row.id))
    assert.equal(summary.json.extensions.accountConnectors.state, 'notinstalled')
    assert.equal(Object.hasOwn(summary.json, 'channels'), false)
    assert.equal(summary.json.settings.forward.running, true)
    assert.equal((await call(missing, 'GET', '/eac/status')).status, 200)
    assert.equal((await call(missing, 'GET', '/token-saver')).status, 200)
    assert.equal((await call(missing, 'GET', '/combos')).status, 200)
    for (const row of coreCatalog) assert.equal((await missing.observations.forward.complete({ model: row.id })).text, 'core:' + row.id)
  })
  await check('every retired account model fails explicitly without anonymous fallback', async () => {
    const previous = missing.observations.coreRequests.length
    for (const provider of ACCOUNT_PROVIDERS) await assert.rejects(missing.observations.forward.complete({ model: provider + '/old-account-model' }), error => error.statusCode === 503 && error.code === 'EXTENSION_UNAVAILABLE')
    assert.equal(missing.observations.coreRequests.length, previous)
  })
  await check('retired login, backup and account gateway entry points reject without reading credentials', async () => {
    for (const route of ['/channels/login', '/channel-pack/backup.export', '/chan-gateway', '/chan-gateway/apply', '/chan-gateway/key', '/chan-gateway/rotate', '/account-connectors/rpc']) {
      const result = await call(missing, 'POST', route, { access_token: 'credential-sentinel', method: 'backup.export' })
      assert.equal(result.status, 410, route); assert.equal(result.json.code, 'ACCOUNT_CONNECTORS_MOVED'); assert.equal(result.bodyReads, 0)
    }
  })
  const extension = fakeExtension(); const connected = mountHost(extension); mounted.push(connected); await settle()
  await check('compatible optional extension joins only OFM catalog and API, never duplicate DSH suppliers', async () => {
    const result = await call(connected, 'GET', '/summary')
    assert.equal(result.json.extensions.accountConnectors.state, 'ready')
    assert.equal(result.json.extensions.accountConnectors.version, '0.1.0')
    assert.equal(result.json.extensions.accountConnectors.managementTarget, '/ofm-account-connectors')
    assert.equal(result.json.catalog.find(row => row.id === 'buddy/mock').source, 'extension:ofm.account-connectors')
    assert.equal(result.json.catalog.find(row => row.id === 'buddy/mock').route, 'our-free-model')
    const choices = (await call(connected, 'GET', '/combos')).json.models
    assert.equal(choices.find(row => row.id === 'buddy/mock').source, 'extension:ofm.account-connectors')
    assert.equal(connected.observations.adapters.length, 1)
    assert.deepEqual(copy(connected.observations.adapters[0].routes), ['our-free-model', 'our-free-model-region'])
    assert.doesNotMatch(JSON.stringify(result.json), /credential-sentinel|access_token|apiKey/)
    assert.equal((await connected.observations.forward.complete({ model: 'buddy/mock' })).text, 'extension answer')
    assert.equal(connected.stats.get().requests, 1, 'one extension completion is counted once in core statistics')
    assert.equal((await call(connected, 'GET', '/stats')).json.samples[0].model, 'buddy/mock')
  })
  await check('same actual model owned by both runtimes returns 409 instead of choosing silently', async () => {
    connected.runtime.catalog.push({ id: 'buddy/mock', channel: 'aggregate' })
    await assert.rejects(connected.observations.forward.complete({ model: 'buddy/mock' }), error => error.statusCode === 409 && error.code === 'EXTENSION_MODEL_CONFLICT')
    connected.runtime.catalog.pop()
  })
  await check('protocol mismatch and missing ofmApi capability remain visible without touching account models', async () => {
    for (const overrides of [{ protocolVersion: 2 }, { capabilities: ['hostModels', 'managementUi'] }]) {
      const incompatible = fakeExtension(overrides); missing.setExtension(incompatible)
      const result = await call(missing, 'POST', '/extensions/account-connectors/refresh')
      assert.equal(result.status, 200); assert.equal(result.json.accountConnectors.state, 'incompatible'); assert.equal(incompatible.modelCalls, 0)
      assert.equal((await missing.observations.forward.complete({ model: 'free/mock' })).text, 'core:free/mock')
    }
  })
  await check('disabled, failed and conflict descriptors withdraw account rows while keeping core usable', async () => {
    for (const state of ['disabled', 'failed', 'conflict']) {
      const addon = fakeExtension({ state }); missing.setExtension(addon)
      const result = await call(missing, 'POST', '/extensions/account-connectors/refresh')
      assert.equal(result.json.accountConnectors.state, state); assert.equal(addon.modelCalls, 0)
      assert.equal((await call(missing, 'GET', '/summary')).json.catalog.some(row => row.id === 'buddy/mock'), false)
      assert.equal((await missing.observations.forward.complete({ model: 'eac/mock' })).text, 'core:eac/mock')
    }
  })
  await check('untrusted descriptor URLs and extra credential fields cannot reach core management link or status', async () => {
    for (const target of ['https://example.invalid/install.js', '//example.invalid/manage', 'javascript:alert(1)', 'data:text/html,test', '/ofm-account-connectors?script=1', '/ofm-account-connectors/../other', '/ofm-account-connectors#x']) {
      missing.setExtension(fakeExtension({ managementTarget: target, access_token: 'credential-sentinel' }))
      const result = await call(missing, 'POST', '/extensions/account-connectors/refresh')
      assert.equal(result.json.accountConnectors.managementTarget, '')
      assert.doesNotMatch(JSON.stringify(result.json), /example.invalid|javascript:|credential-sentinel|access_token/)
    }
  })
  await check('missing or broken service lookup never rewrites host core settings or enables providers', async () => {
    const before = copy(missing.settings.get()); missing.setExtension(undefined)
    assert.equal((await call(missing, 'POST', '/extensions/account-connectors/refresh')).json.accountConnectors.state, 'notinstalled')
    const broken = fakeExtension(); broken.describe = async () => { throw new Error('credential-sentinel') }; missing.setExtension(broken)
    const result = await call(missing, 'POST', '/extensions/account-connectors/refresh')
    assert.equal(result.json.accountConnectors.state, 'failed'); assert.doesNotMatch(JSON.stringify(result.json), /credential-sentinel/)
    assert.deepEqual(copy(missing.settings.get()), before)
  })
  await check('a temporarily throwing optional service lookup degrades to absent and never blocks core', async () => {
    missing.setLookupFailure(true)
    assert.equal((await call(missing, 'POST', '/extensions/account-connectors/refresh')).json.accountConnectors.state, 'notinstalled')
    assert.equal((await missing.observations.forward.complete({ model: 'free/mock' })).text, 'core:free/mock')
    missing.setLookupFailure(false)
  })
  await check('OFM teardown detaches subscriptions but never disposes the other native plugin', () => {
    assert.ok(extension.listeners.size > 0); connected.dispose(); mounted.splice(mounted.indexOf(connected), 1)
    assert.equal(extension.listeners.size, 0); assert.equal(extension.closeCalls, 0)
  })

  // React headless render exercises real elements, dictionaries, hooks and links.
  let bundle, hookSeed = []
  const browser = { __ModuleLoader__: { load(record) { bundle = record } }, localStorage: { getItem: () => 'channels', setItem() {} }, addEventListener() {}, removeEventListener() {} }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }), Fragment: 'fragment',
    useState(initial) { return [hookSeed.length ? hookSeed.shift() : typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect() {}, useMemo: fn => fn(), useCallback: fn => fn, useRef: initial => ({ current: initial }),
  }
  vm.runInNewContext(clientSource, { window: browser, document: { baseURI: 'http://localhost/' }, navigator: { language: 'zh-CN' }, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console: quiet }, { filename: 'client.js', timeout: 5000 })
  const exported = bundle.factory(name => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: element => element }
    assert.fail('unexpected client dependency: ' + name)
  })
  const ui = exported.__test
  const walk = node => {
    if (node == null || typeof node === 'boolean') return []
    if (Array.isArray(node)) return node.flatMap(walk)
    if (typeof node !== 'object') return [node]
    if (typeof node.type === 'function') return walk(node.type(node.props))
    return [node, ...walk(node.props.children)]
  }
  const render = (component, props, seeds = []) => { hookSeed = [...seeds]; return walk(component(props)) }
  const text = nodes => nodes.filter(node => typeof node === 'string' || typeof node === 'number').join(' ')
  const t = key => { assert.ok(Object.hasOwn(ui.DICT.zh, key), 'missing copy ' + key); return ui.DICT.zh[key] }

  await check('account page, logos, login helpers and credential RPC are removed from core client', () => {
    assert.doesNotMatch(clientSource, /CHANNEL_PROVIDERS|ChannelCard|ChannelsPage|useChannelRpc|channel-pack|tokenLedger|chan-gateway/)
    assert.doesNotMatch(clientSource, /\.ofm_chanlogo|\.ofm_acctlist|\.ofm_loginbody/)
    for (const name of ['EacAuth', 'useEacLogin', 'DICT', 'CSS', 'Tank', 'usePool', 'poolReading', 'capacityText', 'LedgerPage', 'LogsPage']) assert.ok(exported.standalone[name], 'shared ' + name)
  })
  await check('old remembered channels tab reloads to the extension guide; all core tabs remain', () => {
    assert.equal(ui.normalizeCoreTab('channels'), 'extensions'); assert.equal(ui.normalizeCoreTab('gateway'), 'gateway'); assert.equal(ui.normalizeCoreTab('invalid'), 'free')
    const nodes = render(ui.Shell, { t, data: { catalog: [] }, counts: {}, summary: {}, stats: {}, setBusy() {} })
    const active = nodes.find(node => node.props?.role === 'tab' && node.props['aria-selected'] === 'true')
    assert.equal(text(walk(active)), t('nav.tab.extensions'))
    for (const key of ['nav.tab.free', 'nav.tab.eac', 'nav.tab.aggregate', 'nav.tab.saver', 'nav.tab.routing', 'nav.tab.ledger', 'nav.tab.logs', 'nav.tab.gateway', 'nav.tab.upgrade']) assert.ok(text(nodes).includes(t(key)), key)
  })
  await check('each extension card state has text, real version and safe management availability', () => {
    for (const state of ['notinstalled', 'installed', 'disabled', 'ready', 'failed', 'incompatible', 'conflict']) {
      const descriptor = { state, installed: state !== 'notinstalled', version: '0.1.0', protocolVersion: 1, modelCount: 0, managementTarget: '/ofm-account-connectors' }
      const nodes = render(ui.ExtensionsPage, { t, summary: { data: { extensions: { accountConnectors: descriptor } } } })
      assert.ok(text(nodes).includes(t('ext.state.' + state)), state); assert.ok(text(nodes).includes('0.1.0'))
      assert.ok(text(nodes).includes(t('ext.installMethod'))); assert.ok(text(nodes).includes(t('ext.refresh')))
      const links = nodes.filter(node => node.type === 'a')
      assert.equal(links.length, state === 'notinstalled' ? 0 : 1)
      if (links.length) assert.equal(links[0].props.href, '/ofm-account-connectors')
    }
    assert.equal(ui.accountExtensionView({ state: 'not-installed' }).state, 'notinstalled')
  })
  await check('verified management callback opens only the independent settings section', () => {
    const opened = []
    const view = { state: 'ready', installed: true, managementTarget: '/ofm-account-connectors' }
    const nodes = render(ui.ExtensionsPage, { t, openSection: target => opened.push(target), summary: { data: { extensions: { accountConnectors: view } } } })
    const button = nodes.find(node => node.type === 'button' && text(walk(node)) === t('ext.manage'))
    assert.equal(typeof button?.props.onClick, 'function'); button.props.onClick()
    assert.deepEqual(opened, ['ofm-account-connectors'])
    assert.equal(nodes.filter(node => node.type === 'a').length, 0)
  })
  await check('client itself rejects arbitrary URLs and renders truthful local installation instructions', () => {
    for (const managementTarget of ['https://example.invalid/', '//example.invalid/', 'javascript:alert(1)', '/ofm-account-connectors?q=1']) {
      assert.equal(ui.accountExtensionView({ installed: true, state: 'ready', managementTarget }).managementTarget, '')
    }
    const nodes = render(ui.ExtensionsPage, { t, summary: {} }, [{ status: 'ready', data: {} }, false, true, '', undefined])
    assert.ok(text(nodes).includes(t('ext.unpublished'))); assert.ok(text(nodes).includes(t('ext.privacy')))
    assert.equal(nodes.filter(node => node.type === 'a').length, 0)
  })
  const day = '2026-10-14'
  const statsFixture = { requests: 7, requestFailures: 1, grand: { input: 101, output: 55 }, models: [{ model: 'free/mock', name: 'Fixture free', input: 101, output: 55, reasoning: 9, cacheRead: 25, calls: 7, failed: 1 }], days: [{ day, models: [{ model: 'free/mock', input: 11, output: 7, reasoning: 1, cacheRead: 2, calls: 2, failed: 1 }] }], samples: [{ at: new Date(day + 'T01:00:00').getTime(), model: 'free/mock', input: 11, output: 7, origin: 'forward', ok: false }, { at: new Date(day + 'T02:00:00').getTime(), model: 'eac/mock', input: 1, output: 2, origin: 'chat', ok: true }] }
  await check('core ledger keeps today versus lifetime counts and core logs display newest call first', () => {
    const today = ui.coreLedgerView(statsFixture, 'today', day); const all = ui.coreLedgerView(statsFixture, 'all', day)
    assert.equal(today.totals.input, 11); assert.equal(today.totals.output, 7); assert.equal(today.totals.calls, 2)
    assert.equal(all.totals.input, 101); assert.equal(all.totals.calls, 7); assert.equal(all.totals.failed, 1)
    assert.equal(all.entries[0].model, 'eac/mock')
    const logNodes = render(ui.LogsPage, { t, stats: { data: statsFixture } }, [{ status: 'ready', data: statsFixture }, 20, false, 1])
    assert.ok(text(logNodes).indexOf('eac/mock') < text(logNodes).indexOf('free/mock'))
    const ledger = render(ui.LedgerPage, { t, stats: { data: statsFixture } }, [{ status: 'ready', data: statsFixture }, 'all'])
    assert.ok(text(ledger).includes('156')); assert.ok(text(ledger).includes('Fixture free'))
  })
  await check('core gateway still renders local forward, LAN and egress controls without account gateway', () => {
    const settings = { forward: { enabled: false, port: 18777, host: '127.0.0.1', lan: { enabled: false } }, egress: { enabled: false } }
    const nodes = render(ui.GatewayPage, { t, data: { settings }, busy: false, apply() {} })
    for (const key of ['section.forward', 'section.egress', 'forward.enabled', 'forward.lanEnabled', 'gw.clientsTitle']) assert.ok(text(nodes).includes(t(key)), key)
    assert.equal(nodes.filter(node => node.type === 'input' && node.props?.type === 'password').length, 0)
  })
  await check('retained roster, authorization, tank and button interaction primitives remain available', () => {
    for (const functionName of ['EacAuth', 'useEacLogin', 'Tank', 'usePool', 'poolReading', 'capacityText', 'FreePage', 'EacPage', 'Forward', 'Egress']) assert.match(clientSource, new RegExp('function ' + functionName + '\\('))
    assert.match(ui.CSS, /\.ofm_btn:active/); assert.match(ui.CSS, /prefers-reduced-motion/); assert.match(ui.CSS, /\.ofm_tank/)
    assert.match(clientSource, /m\.channel === 'kilo'/)
  })
  await check('free and EAC pages actually render original core sections without account code', () => {
    const data = { catalog: [], settings: copy(SETTINGS_INITIAL), egress: null }
    const props = { t, data, counts: {}, summary: { data, status: 'ready', reload() {} }, stats: { status: 'ready', data: { grand: {}, days: [], models: [], samples: [] } }, busy: false, benches: {}, eacAuth: { available: false, authorized: false }, eacLogin: { busy: false, notice: '', pending: null, refresh() {}, login() {}, logout() {}, cancel() {} }, refresh() {}, reprobe() {}, apply() {}, bench() {} }
    const free = render(ui.FreePage, props)
    for (const key of ['free.title', 'section.models', 'section.dash', 'section.forward', 'section.egress', 'section.prefs']) assert.ok(text(free).includes(t(key)), key)
    const eac = render(ui.EacPage, props, [{ pool: 100, inflight: 3, active24h: 40, poolSource: 'configured' }, ''])
    for (const key of ['eac.title', 'section.eac', 'section.models']) assert.ok(text(eac).includes(t(key)), key)
    assert.ok(eac.some(node => node.props?.['aria-label']?.includes(t('eac.tankLabel'))), 'EAC tank accessible pressure label')
    assert.equal(ui.normalizeCoreTab('eac'), 'eac')
  })
  await check('zh and en locale files expose the same complete optional-extension states', async () => {
    const [zh, en] = await Promise.all(['zh', 'en'].map(language => fs.readFile(path.join(root, 'locale', language + '.json'), 'utf8').then(JSON.parse)))
    assert.deepEqual(Object.keys(zh.extensions.accountConnectors.states), Object.keys(en.extensions.accountConnectors.states))
    assert.equal(Object.keys(zh.extensions.accountConnectors.states).length, 7)
    assert.match(zh.extensions.accountConnectors.installation, /尚未正式发行/)
  })
  console.log('account-connectors-plugin-test: OK (' + checks + ' checks; mock services only)')
} finally { for (const host of mounted.reverse()) host.dispose() }
