import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { startStandalone } from '../packages/standalone/service.mjs'
import { createAccountConnectorsHost } from '../src/extensions/account-connectors.js'
const addon = process.env.OFM_ACCOUNT_CONNECTORS_PACKAGE
if (!addon || !path.isAbsolute(addon)) throw new Error('Set OFM_ACCOUNT_CONNECTORS_PACKAGE to the real local extension distribution directory')
const root = fileURLToPath(new URL('../.extension-test-tmp/', import.meta.url)); await fs.mkdir(root, { recursive: true }); const dataDir = await fs.mkdtemp(path.join(root, 'real-package-'))
const originalFetch = globalThis.fetch
let supplierCalls = 0
// Core upstream calls are local substitutes; account worker is explicitly offline.
globalThis.fetch = (url, options) => {
  const target = new URL(url instanceof Request ? url.url : String(url))
  if (target.hostname === '127.0.0.1' || target.hostname === 'localhost') return originalFetch(url, options)
  supplierCalls++
  return Promise.resolve(Response.json({ data: [] }))
}
let service, cookie = ''
let checks = 0
const check = async (name, action) => { await action(); console.log('ok ' + (++checks) + ' ' + name) }
try {
  service = await startStandalone({ dataDir, port: 0, refresh: false, logger: { info() {}, warn() {}, error() {} }, accountConnectorsFactory: config => createAccountConnectorsHost({ ...config, workerFactory: (entry, options) => new Worker(entry, { ...options, workerData: { ...options.workerData, offline: true } }) }) })
  const request = async (relative, payload) => {
    const response = await fetch(service.url + relative, { method: payload === undefined ? 'GET' : 'POST', headers: { ...cookie ? { cookie } : {}, 'content-type': 'application/json', origin: service.url }, body: payload === undefined ? undefined : JSON.stringify(payload) })
    return { response, value: await response.json() }
  }
  const session = await request('/api/management/session', { bootstrapToken: new URLSearchParams(service.managementUrl.split('#')[1]).get('login') }); assert.equal(session.response.status, 200); cookie = session.response.headers.get('set-cookie').split(';')[0]
  await check('actual distribution directory imports but does not run any account provider', async () => {
    const imported = await request('/api/management/extensions/account-connectors/install', { path: addon, trustDevelopment: true }); assert.equal(imported.response.status, 200); assert.equal(imported.value.accountConnectors.state, 'disabled')
    assert.equal(service.accountConnectors.publicModelRows().length, 0)
  })
  await check('real bundled engine handshakes through the core and begins with all thirteen providers disabled', async () => {
    const enabled = await request('/api/management/extensions/account-connectors/enable', {}); assert.equal(enabled.response.status, 200); assert.equal(enabled.value.accountConnectors.state, 'ready')
    const status = await request('/api/management/extensions/account-connectors/rpc', { method: 'provider.status', payload: { providers: ['codearts','buddy','workbuddy','lobsterai','qoder','qodercn','trae','cline','loomy','raccoon','minimax','zcode','gemini'] } }); assert.equal(status.value.ok, true)
    assert.equal(Object.keys(status.value.value.statuses).length, 13); assert.ok(Object.values(status.value.value.statuses).every(row => row.extensionEnabled === false)); assert.deepEqual(service.accountConnectors.publicModelRows(), [])
  })
  await check('manifest-bound UI and its actual React bundle are served through the protected core management path', async () => {
    for (const [relative, type] of [['', 'text/html'], ['app.js','javascript'], ['theme.css','text/css'], ['icon.svg','image/svg+xml']]) {
      const response = await fetch(service.url + '/api/management/extensions/account-connectors/ui/' + relative, { headers: { cookie } }); assert.equal(response.status, 200); assert.ok(response.headers.get('content-type').includes(type)); assert.ok((await response.arrayBuffer()).byteLength > 0)
    }
    const unauthenticated = await fetch(service.url + '/api/management/extensions/account-connectors/ui/'); assert.equal(unauthenticated.status, 401)
  })
  await check('account-model requests fail with explicit extension ownership while the core health remains normal', async () => {
    const denied = await request('/v1/chat/completions', { model: 'buddy/nonexistent', messages: [{ role: 'user', content: 'fixture' }] }); assert.equal(denied.response.status, 401, 'management cookie is never inference API authentication')
    const key = JSON.parse(await fs.readFile(service.keyFile, 'utf8')).forwardKey
    const response = await fetch(service.url + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'buddy/nonexistent', messages: [{ role:'user', content:'fixture' }], stream:false }) }); const body = await response.json(); assert.equal(response.status, 404); assert.equal(body.error.code, 'EXTENSION_MODEL_NOT_FOUND')
    assert.equal((await fetch(service.url + '/health')).status, 200)
  })
  await check('disabling real account engine withdraws management execution; uninstall retains account data', async () => {
    const disabled = await request('/api/management/extensions/account-connectors/disable', {}); assert.equal(disabled.value.accountConnectors.state, 'disabled')
    const denied = await request('/api/management/extensions/account-connectors/rpc', { method: 'account.list', payload: {} }); assert.equal(denied.response.status, 503)
    const uninstalled = await request('/api/management/extensions/account-connectors/uninstall', { deleteData: false }); assert.equal(uninstalled.response.status, 200); assert.equal(uninstalled.value.accountConnectors.state, 'not-installed')
    assert.ok((await fs.stat(path.join(dataDir,'extensions-data/ofm.account-connectors'))).isDirectory())
  })
  console.log(checks + ' actual external package / OFM joint checks passed; no real account data or supplier login used.')
} finally { await service?.close(); globalThis.fetch = originalFetch; assert.ok(path.relative(root,dataDir) && !path.relative(root,dataDir).startsWith('..')); await fs.rm(dataDir,{recursive:true,force:true}) }
