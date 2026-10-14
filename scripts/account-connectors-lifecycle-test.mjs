import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createOptionalAccountBridge, combineCoreWithAccountConnectors, createAccountConnectorsHost } from '../src/extensions/account-connectors.js'
import { safeExtensionMessage, startExtensionWorker } from '../src/extensions/worker-bridge.js'
import { inspectExtensionDirectory } from '../src/extensions/installation.js'
const root = new URL('../.extension-test-tmp/', import.meta.url)
await fs.mkdir(root, { recursive: true })
const describe = (changes = {}) => ({ id: 'ofm.account-connectors', version: '0.1.0', protocolVersion: 1, instanceId: 'fixture', state: 'ready', capabilities: ['ofmApi'], ...changes })
const pause = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const next = () => new Promise(resolve => setImmediate(resolve))
test('switching native service does not wait for an unresolved old descriptor', async () => {
  const old = pause(); let selected = { describe: () => old.promise }, newReads = 0
  const bridge = createOptionalAccountBridge({ getService: () => selected })
  const held = bridge.refresh()
  selected = { describe: () => { newReads++; return describe({ instanceId: 'replacement' }) }, listModels: () => [{ id: 'buddy/new' }] }
  await bridge.refresh(); assert.equal(newReads, 1); assert.equal(bridge.publicModelRows()[0].id, 'buddy/new')
  old.resolve(describe()); await held; assert.equal(bridge.publicModelRows()[0].id, 'buddy/new'); bridge.dispose()
})
test('same service disabling aborts an active request and rejects stream completion after disposal', async () => {
  const held = pause(); let state = 'ready'; let receivedSignal
  const service = { describe: () => describe({ state }), listModels: () => [{ id: 'buddy/a' }], async *stream(_, { signal }) { receivedSignal = signal; await held.promise; yield { type: 'text-delta', text: 'after-disable' } } }
  const bridge = createOptionalAccountBridge({ getService: () => service }); await bridge.refresh()
  const request = bridge.complete({ model: 'buddy/a' }); const rejected = assert.rejects(request, error => error.code === 'EXTENSION_DISABLED')
  await next(); state = 'disabled'; await bridge.refresh(); assert.equal(receivedSignal.aborted, true); held.resolve(); await rejected; bridge.dispose()
})
test('nested model fields cannot smuggle credentials into the core catalog', async () => {
  const secret = 'synthetic-review-secret'
  const bridge = createOptionalAccountBridge({ getService: () => ({ describe, listModels: () => [{ id: 'buddy/a', name: { refresh_token: secret }, pricing: { input: 1, access_token: secret }, apiKey: secret }] }) })
  await bridge.refresh(); assert.equal(JSON.stringify(bridge.publicModelRows()).includes(secret), false); assert.equal(bridge.publicModelRows()[0].pricing.input, 1); bridge.dispose()
})
test('JSON-shaped secrets and Bearer credentials are redacted from public diagnostics', () => {
  for (const key of ['access_token', 'refresh_token', 'api_key', 'password', 'client_secret']) assert.ok(!safeExtensionMessage(JSON.stringify({ [key]: 'synthetic-private-value' })).includes('synthetic-private-value'))
  assert.ok(!safeExtensionMessage('Authorization: Bearer synthetic-private-value').includes('synthetic-private-value'))
})
test('incomplete native descriptors never advertise ready models', async () => {
  const bridge = createOptionalAccountBridge({ getService: () => ({ describe: () => ({ id: 'ofm.account-connectors', protocolVersion: 1, version: '0.1.0', instanceId: 'fixture', capabilities: ['ofmApi'] }), listModels: () => [{ id: 'buddy/a' }] }) })
  await bridge.refresh(); assert.equal(bridge.state().state, 'incompatible'); assert.deepEqual(bridge.publicModelRows(), []); bridge.dispose()
})
class FakeWorker extends EventEmitter {
  constructor() { super(); this.terminated = false; setImmediate(() => this.emit('message', { type: 'ready', descriptor: describe() })) }
  postMessage(message) { if (message.type === 'close') setImmediate(() => this.emit('message', { type: 'closed' })) }
  async terminate() { this.terminated = true; this.emit('exit', 0) }
}
test('exited workers reject new work immediately instead of waiting for request timeout', async () => {
  let worker
  const transport = await startExtensionWorker({ entry: 'fixture', dataDir: '.', workerFactory: () => (worker = new FakeWorker()) })
  worker.emit('exit', 1)
  assert.equal(transport.closed, true); await assert.rejects(transport.call('models'), error => error.code === 'EXTENSION_EXITED'); await transport.close()
})
test('global OFM pause blocks both extension and mixed-route execution', async () => {
  let calls = 0
  const bridge = { publicModelRows: () => [{ id: 'buddy/a' }], handles: () => true, complete: async () => { calls++; return { text: 'bad' } }, refresh: async () => [] }
  const core = { catalog: [], state: () => ({ catalog: [], membership: {}, settings: { enabled: false } }), publicModelRows: () => [], complete: async () => ({}) }
  await assert.rejects(combineCoreWithAccountConnectors(core, bridge).complete({ model: 'buddy/a' }), error => error.code === 'CONFIG_DISABLED'); assert.equal(calls, 0)
})
test('manifest without UI metadata is rejected before replacing an installed package', async () => {
  const dir = await fs.mkdtemp(new URL('missing-ui-', root)); const content = 'export{}'; await fs.writeFile(path.join(dir, 'worker.mjs'), content)
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify({ id: 'ofm.account-connectors', version: '0.1.0', protocolVersion: 1, runtime: { entry: 'worker.mjs' }, files: { 'worker.mjs': crypto.createHash('sha256').update(content).digest('hex') } }))
  try { await assert.rejects(inspectExtensionDirectory(dir), error => error.code === 'EXTENSION_INVALID_PACKAGE') } finally { await fs.rm(dir, { recursive: true }) }
})
test('extension installation roots through junctions are rejected without deleting their targets', async () => {
  const dir = await fs.mkdtemp(new URL('junction-', root)); const real = path.join(dir, 'real'), link = path.join(dir, 'link'); await fs.mkdir(real); await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir')
  try { await assert.rejects(createAccountConnectorsHost({ dataDir: path.join(dir, 'data'), extensionDir: link }), error => error.code === 'EXTENSION_INVALID_PATH'); assert.equal((await fs.stat(real)).isDirectory(), true) }
  finally { await fs.unlink(link); await fs.rm(dir, { recursive: true }) }
})

test('mixed core/extension route buffers failed reasoning, preserves requested fallback and never advances after visible content', async () => {
  const rows = [{ id: 'buddy/first', name: 'Account fixture' }]
  let calls = [], mode = 'fail-before-output'
  const bridge = { publicModelRows: () => rows, handles: id => id.startsWith('buddy/'), refresh: async () => [], async complete(request, onChunk) { calls.push(request.model); if (mode === 'fail-before-output') { onChunk?.({ type: 'reasoning-delta', text: 'discarded thought' }); throw Object.assign(new Error('provider unavailable'), { statusCode: 503 }) } onChunk?.({ type: 'text-delta', text: 'already visible' }); throw Object.assign(new Error('late provider failure'), { statusCode: 503 }) } }
  const settings = { enabled: true, combos: [{ id: 'combo:mixed', name: 'Mixed', enabled: true, models: ['buddy/first','free-fixture'], strategy:'fallback', stickyLimit:1 }] }
  const core = { catalog: [{ id:'free-fixture',name:'Free fixture' }], state() { return { catalog:this.catalog,membership:{main:['free-fixture']},settings } }, publicModelRows() { return this.catalog }, async complete(request,onChunk) { calls.push(request.model); onChunk?.({ type:'text-delta',text:'core fallback' }); return { text:'core fallback' } }, refreshCatalog:async()=>[] }
  const combined=combineCoreWithAccountConnectors(core,bridge),chunks=[]
  assert.ok(combined.publicModelRows().some(row=>row.id==='combo:mixed'))
  const result=await combined.complete({model:'combo:mixed'},chunk=>chunks.push(chunk));assert.equal(result.text,'core fallback');assert.deepEqual(calls,['buddy/first','free-fixture']);assert.equal(chunks.some(chunk=>chunk.text==='discarded thought'),false)
  calls=[];mode='fail-after-output';await assert.rejects(combined.complete({model:'combo:mixed'},()=>{}));assert.deepEqual(calls,['buddy/first'])
})
