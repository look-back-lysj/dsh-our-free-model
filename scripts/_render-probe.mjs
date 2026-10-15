/**
 * Mini-render probe: mounts the settings section with a stub React that has
 * just enough state to re-render after async data lands, and throws the moment
 * any plain object appears where React expects an element (production error
 * #31). This is the offline reproduction of the "blank settings page" class of
 * bugs — run it against any page by seeding localStorage's active tab.
 *
 * Run: node scripts/_render-probe.mjs [tabName]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const activeTab = process.argv[2] ?? 'gateway'

// ── fake backend: same-origin payloads the pages read ────────────────────────
const summary = {
  catalog: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', availability: 'available', vision: false, route: 'our-free-model', channel: undefined, contextWindow: 1000000, maxOutput: 32768, reasoning: true }],
  settings: { enabled: true, forward: { enabled: false, host: '127.0.0.1', port: 18899, lan: { enabled: false, port: 0 } }, egress: { enabled: false }, probeIntervalMinutes: 15, defaultMaxTokens: 32768, notifyOs: false, autoReloadWatch: false, updateCheckHours: 6, reloadCount: 0, reloadedAt: 0 },
  egress: { country: 'CN' }, outlet: { running: false }, probedAt: Date.now(),
  announcementVersion: 'x', version: '2.3.0', distribution: 'self',
  announcements: { unread: 0, fetchedAt: 0 },
  laneAvailable: true,
  eacAuth: { available: true, authorized: true, login: 'probe', required: true, lastCheck: Date.now() },
  extensions: { accountConnectors: { state: 'not-installed', installed: false, enabled: false, providerCount: 0, modelCount: 0, managementTarget: '' } },
  update: { available: false, latest: '', current: '2.3.0', checkedAt: 0, applying: false, managed: false },
}
const routes = {
  '/summary': summary,
  '/stats': { requests: 0, requestFailures: 0, turns: 0, failedTurns: 0, days: [], models: [], samples: [], grand: { input: 0, output: 0, reasoning: 0, calls: 0, failed: 0 } },
  '/meta': { version: '2.3.0', reloadedAt: 0, reloadCount: 0, distribution: 'self', feed: { fetchedAt: 0, source: '', error: '' }, update: { available: false } },
  '/eac/status': summary.eacAuth,
  '/clients': { running: false },
  '/update/status': { current: '2.3.0', installedVersion: '2.3.0', latest: '2.3.1', available: true, checkedAt: Date.now(), applying: false, recoveryRequired: false },
  '/extensions/account-connectors': { accountConnectors: summary.extensions.accountConnectors },
  '/announcement': { version: 'x', acknowledged: true },
  '/announcements': { items: [], unread: 0, fetchedAt: 0, notifyOs: false },
}
globalThis.fetch = url => {
  const path = String(url).replace(/^.*?\/api\/our-free-model/, '').split('?')[0]
  const payload = routes[path] ?? {}
  return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload })
}

// ── window/document stubs ────────────────────────────────────────────────────
globalThis.window = {
  __ModuleLoader__: { load: r => { globalThis.__registered = r } },
  localStorage: { getItem: () => activeTab, setItem: () => {} },
  dispatchEvent: () => {}, addEventListener: () => {}, open: () => {},
  confirm: () => true,
}
globalThis.document = {
  createElement: () => ({ setAttribute() {}, style: {}, remove() {}, appendChild() {}, addEventListener() {} }),
  head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} },
  querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
  execCommand: () => true, documentElement: { lang: 'zh' },
}
globalThis.Notification = undefined
globalThis.EventSource = class { addEventListener() {} close() {} }
globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts?.detail } }
// `navigator` is a getter-only global in Node 21+; the factory only reads it.
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })

// ── the stub React with stateful hooks ───────────────────────────────────────
let seq = 0
let dirty = false
let callKey = ''
let hookIdx = 0
const hookState = new Map()
const isEl = v => v !== null && typeof v === 'object' && v.__el === true

const stubReact = {
  createElement(type, props, ...children) {
    const kids = children.flat(Infinity).filter(c => c !== undefined && c !== false && c !== true)
    for (const child of kids) {
      if (child !== null && typeof child === 'object' && !Array.isArray(child) && !isEl(child)) {
        throw new Error(`OBJECT CHILD in <${String(type)}>: ${JSON.stringify(child).slice(0, 180)}`)
      }
    }
    return { __el: true, id: seq += 1, type, props: props ?? {}, children: kids }
  },
  Fragment: 'fragment',
  useState(initial) {
    const key = `${callKey}#${hookIdx += 1}`
    if (!hookState.has(key)) hookState.set(key, typeof initial === 'function' ? initial() : initial)
    const set = value => {
      const prev = hookState.get(key)
      const next = typeof value === 'function' ? value(prev) : value
      if (JSON.stringify(next) !== JSON.stringify(prev)) { hookState.set(key, next); dirty = true }
    }
    return [hookState.get(key), set]
  },
  useRef: () => ({ current: null }),
  useMemo: factory => factory(),
  useCallback: fn => fn,
  Fragment: 'fragment',
  useEffect(fn) { void (async () => { try { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) } catch { /* effects must not break the probe */ } })() },
}

const cleanups = []
let renderPass = 0
const hooksPerPass = new Map()

/** Render one element, invoking function components with stable hook keys. */
function visit(el, path, out) {
  if (el === null || el === undefined || typeof el !== 'object' || !isEl(el)) return
  if (typeof el.type === 'function') {
    const key = `${el.type.name ?? 'anon'}@${path}`
    const savedKey = callKey
    const savedIdx = hookIdx
    callKey = key
    hookIdx = 0
    try {
      const inner = el.type({ ...el.props, children: el.children })
      visit(inner, `${path}/${el.type.name ?? 'anon'}`, out)
    } catch (error) {
      out.push(`THREW in ${key}: ${String(error).slice(0, 200)}`)
    }
    callKey = savedKey
    hookIdx = savedIdx
    return
  }
  for (const [index, child] of (el.children ?? []).entries()) visit(child, `${path}/${String(el.type)}[${index}]`, out)
}

// ── boot the bundle and mount the section ────────────────────────────────────
new Function('window', 'document', 'navigator', source)(globalThis.window, globalThis.document, globalThis.navigator)
const registered = globalThis.__registered
const exports = registered.factory(name => {
  if (name === 'react') return stubReact
  if (name === 'react-dom') return { createPortal: (children, container) => ({ __el: true, type: 'portal', props: { container }, children: [children] }) }
  throw new Error(`asked for ${name}`)
})

const sections = []
// The separated core uses its own HTTP API; account RPC is deliberately absent.
const ctx = {
  locale: { register: () => {}, bind: () => key => (typeof key === 'string' ? key : String(key)) },
  effect: fn => { try { fn() } catch { /* degrade */ } return { [Symbol.dispose]() {} } },
  get: () => undefined,
  slots: {
    inject: (name, register) => { if (name === 'settings.section') register() },
    register: (options, render) => sections.push({ options, render }),
  },
}
exports.apply(ctx)

const section = sections[0]
if (section === undefined) {
  console.log('PROBE: settings.section was never registered')
  process.exit(1)
}

const problems = []
;(async () => {
  for (renderPass = 0; renderPass < 6; renderPass += 1) {
    const out = []
    visit(section.render({ locale: 'zh', ctx, t: key => (typeof key === 'string' ? key : String(key)) }), 'root', out)
    problems.push(...out)
    await new Promise(resolve => setTimeout(resolve, 30))
    if (!dirty && renderPass >= 2) { renderPass += 1; break }
    dirty = false
  }
  if (problems.length === 0) console.log(`PROBE: ${renderPass} pass(es), no object children, no throws (tab=${activeTab})`)
  else for (const line of [...new Set(problems)].slice(0, 10)) console.log(`PROBE ${line}`)
  process.exit(problems.length === 0 ? 0 : 1)
})()
