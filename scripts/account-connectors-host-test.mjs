import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createAccountConnectorsHost, createOptionalAccountBridge, combineCoreWithAccountConnectors } from '../src/extensions/account-connectors.js'
import { inspectExtensionDirectory } from '../src/extensions/installation.js'
import { extensionEnvironment } from '../src/extensions/worker-bridge.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const scratchRoot = path.join(root, '.extension-test-tmp')
await fs.mkdir(scratchRoot, { recursive: true })
const scratch = await fs.mkdtemp(path.join(scratchRoot, 'host-'))
let checks = 0
const check = async (name, action) => { await action(); console.log('ok ' + (++checks) + ' ' + name) }
const fixtureWorker = String.raw`import { parentPort, workerData } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
const timers = new Map()
let closed = false
const send = value => { if (!closed || value.type === 'closed') parentPort.postMessage(value) }
parentPort.on('message', message => {
  if (message.type === 'models') send({ type: 'result', id: message.id, value: [{ id: 'buddy/test-model', name: 'Fixture account model', owned_by: 'buddy', apiKey: 'never-return-this', access_token: 'never-return-this' }] })
  if (message.type === 'rpc') send({ type: 'result', id: message.id, value: { ok: true, value: { requestMethod: message.call.method } } })
  if (message.type === 'complete') {
    if (message.request.openAi?.hold) {
      const timer = setTimeout(() => { send({ type: 'chunk', id: message.id, chunk: { type: 'text-delta', text: 'late' } }); send({ type: 'result', id: message.id }) }, 300)
      timers.set(message.id, timer)
    } else {
      send({ type: 'chunk', id: message.id, chunk: { type: 'text-delta', text: 'extension-ok' } })
      send({ type: 'chunk', id: message.id, chunk: { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } } })
      send({ type: 'chunk', id: message.id, chunk: { type: 'finish', reason: { kind: 'stop' } } })
      send({ type: 'result', id: message.id })
    }
  }
  if (message.type === 'cancel') { clearTimeout(timers.get(message.id)); timers.delete(message.id) }
  if (message.type === 'close') { closed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); send({ type: 'closed' }) }
})
parentPort.postMessage({ type: 'ready', providers: ['buddy'], descriptor: { id: 'ofm.account-connectors', version: '0.1.0', protocolVersion: 1, instanceId: workerData.instanceId ?? randomUUID(), state: 'ready', capabilities: ['ofmApi', 'managementUi'], managementTarget: '/extensions/account-connectors' } })
`
async function makePackage(directory, extra = {}) {
  await fs.mkdir(path.join(directory, 'runtime'), { recursive: true }); await fs.mkdir(path.join(directory, 'web'), { recursive: true })
  const files = { 'runtime/worker.mjs': fixtureWorker, 'web/index.html': '<!doctype html><title>Account fixture</title>', 'web/app.js': 'console.log("fixture")' }
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(directory, name), content)
  const manifest = { id: 'ofm.account-connectors', version: '0.1.0', protocolVersion: 1, runtime: { entry: 'runtime/worker.mjs' }, ui: { entry: 'web/index.html', assets: ['web/app.js'] }, providers: ['buddy'], development: true, files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, crypto.createHash('sha256').update(content).digest('hex')])), ...extra }
  await fs.writeFile(path.join(directory, 'extension.json'), JSON.stringify(manifest))
  return manifest
}
let host
try {
  const source = path.join(scratch, 'package'), dataDir = path.join(scratch, 'data')
  await makePackage(source)
  host = await createAccountConnectorsHost({ dataDir })
  const fakeCore = { catalog: [{ id: 'free-test' }, { id: 'eac-test', channel: 'eac' }, { id: 'minimax/core-api', channel: 'aggregate' }], state() { return { catalog: this.catalog, membership: {}, settings: {} } }, publicModelRows() { return this.catalog }, async complete(request) { return { text: 'core:' + request.model } }, async refreshCatalog() { return this.catalog } }
  const combined = combineCoreWithAccountConnectors(fakeCore, host)
  await check('worker receives only named local gateway settings and not unrelated server secrets', async () => {
    const values={DSH_OPENAI_GATEWAY_ENABLED:'false',DSH_OPENAI_GATEWAY_PORT:'19625',DSH_OPENAI_GATEWAY_API_KEY:'synthetic-local-gateway-key',GITHUB_CLIENT_SECRET:'synthetic-server-only-secret'}
    const saved=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]))
    try{Object.assign(process.env,values);const env=extensionEnvironment(dataDir);for(const key of Object.keys(values).filter(key=>key.startsWith('DSH_OPENAI_GATEWAY')))assert.equal(env[key],values[key]);assert.equal(env.GITHUB_CLIENT_SECRET,undefined)}finally{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value}
  })
  await check('missing extension does not start account code and preserves EAC, free, official API', async () => {
    assert.equal(host.state().state, 'not-installed'); assert.deepEqual(combined.publicModelRows(), fakeCore.publicModelRows())
    assert.equal((await combined.complete({ model: 'eac-test' })).text, 'core:eac-test')
    assert.equal((await combined.complete({ model: 'minimax/core-api' })).text, 'core:minimax/core-api')
    await assert.rejects(combined.complete({ model: 'buddy/test-model' }), error => error.code === 'EXTENSION_UNAVAILABLE')
  })
  await check('explicit trust is required before installing a development package', async () => {
    await assert.rejects(host.installFromDirectory(source), error => error.code === 'EXTENSION_TRUST_REQUIRED')
    assert.equal(host.state().installed, false)
  })
  await check('installation copies only declared files and remains disabled', async () => {
    await fs.writeFile(path.join(source, 'should-not-copy.txt'), 'sentinel')
    await host.installFromDirectory(source, { trustDevelopment: true })
    assert.equal(host.state().state, 'disabled'); assert.equal(host.state().enabled, false)
    await assert.rejects(fs.access(path.join(dataDir, 'extensions/ofm.account-connectors/should-not-copy.txt')))
    assert.deepEqual(host.publicModelRows(), [])
  })
  await check('checksum corruption cannot replace an existing valid extension', async () => {
    const broken = path.join(scratch, 'broken'); await makePackage(broken)
    await fs.writeFile(path.join(broken, 'runtime/worker.mjs'), 'corrupted')
    await assert.rejects(host.installFromDirectory(broken, { trustDevelopment: true }), error => error.code === 'EXTENSION_CHECKSUM_FAILED')
    assert.equal(host.state().version, '0.1.0'); assert.equal(host.state().state, 'disabled')
  })
  await check('path traversal in a manifest is rejected before any file is copied', async () => {
    const traversal = path.join(scratch, 'traversal'); const manifest = await makePackage(traversal)
    manifest.files['../outside.txt'] = '0'.repeat(64); await fs.writeFile(path.join(traversal, 'extension.json'), JSON.stringify(manifest))
    await assert.rejects(inspectExtensionDirectory(traversal), error => error.code === 'EXTENSION_INVALID_PACKAGE')
  })
  await check('incompatible collaboration version is rejected without loading', async () => {
    const incompatible = path.join(scratch, 'incompatible'); await makePackage(incompatible, { protocolVersion: 2 })
    await assert.rejects(host.installFromDirectory(incompatible, { trustDevelopment: true }), error => error.code === 'EXTENSION_INCOMPATIBLE')
    assert.equal(host.state().enabled, false)
  })
  await check('explicit enable performs a real worker handshake and safe model projection', async () => {
    await host.enable(); assert.equal(host.state().state, 'ready'); assert.equal(host.publicModelRows().length, 1)
    assert.equal(host.publicModelRows()[0].source, 'extension:ofm.account-connectors')
    assert.equal(JSON.stringify(host.publicModelRows()).includes('never-return-this'), false)
    const result = await combined.complete({ model: 'buddy/test-model', openAi: { messages: [] } })
    assert.equal(result.text, 'extension-ok'); assert.equal((await combined.complete({ model: 'free-test' })).text, 'core:free-test')
    await assert.rejects(host.rpc({ method: 'backup.export', payload: {} }), error => error.code === 'EXTENSION_PRIVATE_OPERATION')
  })
  await check('disabled extension cancels its inflight request and keeps the retired model out of core fallback', async () => {
    const pending = combined.complete({ model: 'buddy/test-model', openAi: { hold: true } })
    const rejection = assert.rejects(pending, error => ['EXTENSION_DISABLED', 'EXTENSION_UNAVAILABLE'].includes(error.code))
    await host.disable(); await rejection
    assert.equal(host.state().state, 'disabled'); assert.equal(combined.publicModelRows().some(row => row.id === 'buddy/test-model'), false)
    await assert.rejects(combined.complete({ model: 'buddy/test-model' }), error => error.code === 'EXTENSION_UNAVAILABLE')
  })
  await check('uninstall removes code, keeps data, and is not undone by reopening the host', async () => {
    await fs.mkdir(path.join(dataDir, 'extensions-data/ofm.account-connectors'), { recursive: true }); await fs.writeFile(path.join(dataDir, 'extensions-data/ofm.account-connectors/keep.txt'), 'retained')
    const result = await host.uninstall(); assert.equal(result.dataRetained, true)
    assert.equal(await fs.readFile(path.join(dataDir, 'extensions-data/ofm.account-connectors/keep.txt'), 'utf8'), 'retained')
    await host.dispose(); host = await createAccountConnectorsHost({ dataDir })
    assert.equal(host.state().state, 'not-installed'); assert.equal(host.state().enabled, false)
  })
  await check('public cooperation refuses malformed versions and does not dispose the independent DSH plugin', async () => {
    let serviceDisposed = false
    let service = { describe: () => ({ id: 'ofm.account-connectors', version: '0.1.0', protocolVersion: 2, instanceId: 'fixture', capabilities: ['ofmApi'] }), dispose() { serviceDisposed = true } }
    const bridge = createOptionalAccountBridge({ getService: () => service })
    await bridge.refresh(); assert.equal(bridge.state().state, 'incompatible'); assert.deepEqual(bridge.publicModelRows(), [])
    service = { ...service, describe: () => ({ id: 'ofm.account-connectors', version: '0.1.0', protocolVersion: 1, instanceId: 'fixture', state: 'ready', capabilities: ['ofmApi'] }), listModels: () => [{ id: 'buddy/test-model', owned_by: 'buddy' }], async *stream() { yield { type: 'text-delta', text: 'native-ok' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
    await bridge.refresh(); assert.equal((await bridge.complete({ model: 'buddy/test-model' })).text, 'native-ok')
    bridge.dispose(); assert.equal(serviceDisposed, false)
  })
  console.log('\n' + checks + ' extension host checks passed (isolated local workers; no supplier calls).')
} finally {
  await host?.dispose()
  const relative = path.relative(scratchRoot, scratch)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'test cleanup must remain inside scratch root')
  await fs.rm(scratch, { recursive: true, force: true })
}
