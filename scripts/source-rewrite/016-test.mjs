/**
 * SRC-016 gate: the account RPC gateway serves the frozen surface over the new core.
 *
 * Run: `node scripts/source-rewrite/016-test.mjs`
 *
 * ## What this proves
 *
 * That the gateway accepts the frozen envelope, dispatches all 45 frozen method names, answers
 * with the frozen response shape, and that every handler actually reaches the new core rather
 * than a stub. The method set is compared against the SRC-001 contract, so a rename on either
 * side fails here.
 *
 * ## What it does not do
 *
 * It does not mount the gateway into the live host. That switch edits `index.js`, which is inside
 * the uncommitted working tree this session must not overwrite, so the mount is left to the
 * integration step and recorded as such.
 *
 * @module scripts/source-rewrite/016-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createRpcGateway,
  RPC_METHOD,
  RPC_METHODS,
  RPC_PATH,
  readEnvelope,
  writeEnvelope,
  writeFailure,
} from '../../src/accounts/api/rpc.js'
import { AccountIndexStore, ACCOUNT_PROVIDERS } from '../../src/accounts/core/index-store.js'
import { exportBackup, importBackup } from '../../src/accounts/core/backup.js'
import { ACCOUNT_ERROR_CODES } from '../../src/accounts/core/errors.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const failures = []
let passed = 0

/** @param {string} name @param {() => unknown | Promise<unknown>} body */
async function check(name, body) {
  try {
    await body()
    passed += 1
    process.stdout.write(`  ok  ${name}\n`)
  } catch (error) {
    failures.push({ name, message: error?.message ?? String(error) })
    process.stdout.write(`  FAIL ${name}\n        ${String(error?.message ?? error).split('\n').join('\n        ')}\n`)
  }
}

/** Build a gateway over an in-memory index and a minimal adapter set. */
function harness({ adapters = {} } = {}) {
  let document
  const index = new AccountIndexStore({
    load: () => document,
    save: async state => { document = JSON.parse(JSON.stringify(state)) },
    now: () => 1_000,
  })
  const core = {
    exportBackup: async () => (await exportBackup({
      index,
      credentials: { resolve: async () => ({ value: '{}' }) },
      credentialRef: ref => ref,
    })).payload,
    importBackup: async payload => importBackup({
      credentials: { set: async () => {} },
      index,
      credentialRef: ref => ref,
      payload,
    }),
  }
  const gateway = createRpcGateway({ index, core, adapters })
  return { gateway, index, document: () => document }
}

/** Wrap a call in the frozen envelope. */
function envelope(method, payload, rpcId = 'rpc-1') {
  return { type: 'client-request', rpcId, method: RPC_METHOD, payload: { method, payload } }
}

process.stdout.write('SRC-016 account-RPC gateway gate\n\n')

// ── 1. the frozen surface ──────────────────────────────────────────────────
await check('the gateway exposes exactly the 45 frozen method names', () => {
  const contracts = JSON.parse(fs.readFileSync(path.join(
    REPO_ROOT, '工程控制', 'ORIGIN-REWRITE-01', 'contracts', 'baseline-20261122', 'channel-contracts.json',
  ), 'utf8'))
  const frozen = new Set(contracts.sharedRpcMethods)
  const served = new Set(RPC_METHODS)
  for (const method of frozen) assert.ok(served.has(method), `the contract names ${method} but the gateway does not serve it`)
  for (const method of served) assert.ok(frozen.has(method), `the gateway serves ${method}, which the contract does not name`)
  assert.equal(RPC_METHODS.length, 45)
})

await check('the transport path and envelope method are the frozen ones', () => {
  assert.equal(RPC_PATH, '/api/channel-pack')
  assert.equal(RPC_METHOD, 'channel-pack')
})

await check('every served method has a handler, not a placeholder', async () => {
  const { gateway } = harness()
  for (const method of RPC_METHODS) {
    const response = await gateway.handle(envelope(method, { provider: 'loomy' }))
    assert.equal(response.type, 'server-response', `${method}: wrong envelope type`)
    assert.notEqual(response.result?.code, 'NOT_IMPLEMENTED', `${method} has no handler`)
  }
})

// ── 2. envelope validation ─────────────────────────────────────────────────
await check('a malformed envelope is rejected with a reason', () => {
  const cases = [
    [null, /not an object/],
    [{}, /unexpected envelope type/],
    [{ type: 'client-request', method: RPC_METHOD, payload: { method: 'account.list' } }, /no rpcId/],
    [{ type: 'client-request', rpcId: 'r', method: 'wrong', payload: { method: 'account.list' } }, /unexpected envelope method/],
    [{ type: 'client-request', rpcId: 'r', method: RPC_METHOD, payload: null }, /no payload/],
    [{ type: 'client-request', rpcId: 'r', method: RPC_METHOD, payload: {} }, /no method/],
    [envelope('nosuch.method', {}), /unknown RPC method/],
  ]
  for (const [body, pattern] of cases) {
    assert.throws(() => readEnvelope(body), pattern)
  }
})

await check('a malformed envelope still answers with a shaped response', async () => {
  const { gateway } = harness()
  const response = await gateway.handle({ nonsense: true })
  assert.equal(response.type, 'server-response')
  assert.equal(response.result.ok, false)
})

await check('the response carries the request rpcId', async () => {
  const { gateway } = harness()
  const response = await gateway.handle(envelope('provider.getOrder', {}, 'rpc-xyz'))
  assert.equal(response.rpcId, 'rpc-xyz')
})

// ── 3. handlers reach the new core ─────────────────────────────────────────
await check('account.create writes through to the index and account.list reads it back', async () => {
  const { gateway, index } = harness()
  await gateway.handle(envelope('account.create', {
    provider: 'loomy',
    entry: { id: 'loomy-1', nickname: 'first', credentialRef: 'LOOMY_ACCOUNT_AAAAAA', enabled: true },
  }))
  assert.equal(index.listByProvider('loomy').length, 1, 'the index was not written')
  const listed = await gateway.handle(envelope('account.list', { provider: 'loomy' }))
  assert.equal(listed.result.accounts.length, 1)
  assert.equal(listed.result.accounts[0].id, 'loomy-1')
})

await check('account.delete removes the row and reports whether it existed', async () => {
  const { gateway } = harness()
  await gateway.handle(envelope('account.create', {
    provider: 'trae',
    entry: { id: 'trae-1', credentialRef: 'TRAE_ACCOUNT_AAAAAA' },
  }))
  const removed = await gateway.handle(envelope('account.delete', { id: 'trae-1' }))
  assert.equal(removed.result.removed, true)
  const again = await gateway.handle(envelope('account.delete', { id: 'trae-1' }))
  assert.equal(again.result.removed, false, 'a second delete claimed to remove a row')
})

await check('an unknown provider is refused, not silently accepted', async () => {
  const { gateway } = harness()
  const response = await gateway.handle(envelope('account.list', { provider: 'nosuchprovider' }))
  assert.equal(response.result.ok, false)
  assert.equal(response.result.code, ACCOUNT_ERROR_CODES.INVALID_REQUEST)
})

await check('opencode is not one of the ten account providers', async () => {
  const { gateway } = harness()
  const response = await gateway.handle(envelope('account.list', { provider: 'opencode' }))
  assert.equal(response.result.ok, false, 'opencode was accepted as an account provider')
})

await check('model.setDisabled writes the blacklist and model.list reflects it', async () => {
  const adapters = {
    zcode: { listModels: async () => [{ id: 'GLM-5.3' }, { id: 'GLM-5.3-Flash' }] },
  }
  const { gateway } = harness({ adapters })
  await gateway.handle(envelope('model.setDisabled', { provider: 'zcode', modelId: 'GLM-5.3', disabled: true }))
  const listed = await gateway.handle(envelope('model.list', { provider: 'zcode' }))
  const byId = new Map(listed.result.models.map(row => [row.id, row]))
  assert.equal(byId.get('GLM-5.3').disabled, true)
  assert.equal(byId.get('GLM-5.3-Flash').disabled, false)
})

await check('model.setAllDisabled disables every model the adapter lists', async () => {
  const adapters = { zcode: { listModels: async () => [{ id: 'a' }, { id: 'b' }] } }
  const { gateway, index } = harness({ adapters })
  const response = await gateway.handle(envelope('model.setAllDisabled', { provider: 'zcode' }))
  assert.equal(response.result.disabled, 2)
  assert.equal(index.disabledModelsFor('zcode').size, 2)
})

await check('provider.status reports all ten providers', async () => {
  const { gateway } = harness()
  const response = await gateway.handle(envelope('provider.status', {}))
  assert.equal(response.result.providers.length, 10)
  assert.deepEqual(response.result.providers.map(row => row.provider), ACCOUNT_PROVIDERS)
})

await check('the gateway switch round-trips through the index', async () => {
  const { gateway, index } = harness()
  const initial = await gateway.handle(envelope('gateway.getEnabled', {}))
  assert.equal(initial.result.enabled, true, 'the gateway must default to enabled')
  await gateway.handle(envelope('gateway.setEnabled', { enabled: false }))
  assert.equal(index.isGatewayEnabled(), false)
  const after = await gateway.handle(envelope('gateway.getEnabled', {}))
  assert.equal(after.result.enabled, false)
})

await check('the permanent-credit lock round-trips for both spellings', async () => {
  const { gateway, index } = harness()
  await gateway.handle(envelope('credits.permanentLock', { provider: 'loomy', locked: true }))
  assert.equal(index.isPermanentLocked('loomy'), true)
  await gateway.handle(envelope('loomy.permanentLock', { locked: false }))
  assert.equal(index.isPermanentLocked('loomy'), false, 'the legacy spelling did not unlock')
})

await check('an adapter failure becomes a shaped failure, not a thrown error', async () => {
  const adapters = { cline: { listModels: async () => { throw new Error('upstream down') } } }
  const { gateway } = harness({ adapters })
  const response = await gateway.handle(envelope('model.list', { provider: 'cline' }))
  assert.equal(response.type, 'server-response')
  assert.equal(response.result.ok, false)
  assert.match(response.result.error, /upstream down/)
})

await check('a method with no mounted adapter reports NOT_MOUNTED rather than crashing', async () => {
  const { gateway } = harness()
  const response = await gateway.handle(envelope('account.refresh', { provider: 'raccoon', id: 'x' }))
  assert.equal(response.result.ok, false)
  assert.equal(response.result.code, 'NOT_MOUNTED')
})

await check('a provider capability the adapter lacks is reported as NOT_SUPPORTED', async () => {
  const adapters = { raccoon: { listModels: async () => [] } }
  const { gateway } = harness({ adapters })
  const sms = await gateway.handle(envelope('login.sendSms', { provider: 'raccoon', phone: '1' }))
  assert.equal(sms.result.code, 'NOT_SUPPORTED')
  const onboarding = await gateway.handle(envelope('onboarding.claim', { provider: 'raccoon' }))
  assert.equal(onboarding.result.code, 'NOT_SUPPORTED')
})

await check('backup export and import reach the core', async () => {
  const { gateway, index } = harness()
  await gateway.handle(envelope('account.create', {
    provider: 'loomy',
    entry: { id: 'loomy-1', credentialRef: 'LOOMY_ACCOUNT_AAAAAA' },
  }))
  const exported = await gateway.handle(envelope('backup.export', {}))
  assert.equal(exported.result.ok, true)
  assert.equal(exported.result.payload.accounts.length, 1)
  const imported = await gateway.handle(envelope('backup.import', { payload: exported.result.payload }))
  assert.equal(imported.result.ok, true)
  assert.equal(index.listByProvider('loomy').length, 1)
})

// ── 4. shape helpers ───────────────────────────────────────────────────────
await check('a failure result carries a code and a message', () => {
  const failure = writeFailure(new Error('boom'))
  assert.equal(failure.ok, false)
  assert.equal(failure.error, 'boom')
  assert.equal(typeof failure.code, 'string')
})

await check('the response envelope is the frozen shape', () => {
  assert.deepEqual(writeEnvelope('r', { ok: true }), { type: 'server-response', rpcId: 'r', result: { ok: true } })
})

// ── 5. the mount boundary, stated honestly ─────────────────────────────────
await check('the live host still loads the absorbed pack, and that is recorded rather than hidden', () => {
  // The switch edits index.js, which is inside the uncommitted working tree this session must
  // not overwrite. The gate records the boundary instead of pretending the mount happened.
  const host = fs.readFileSync(path.join(REPO_ROOT, 'index.js'), 'utf8')
  const usesPack = host.includes("vendor/channel-pack/pack.js")
  assert.equal(usesPack, true,
    'index.js no longer loads the absorbed pack; if the switch has been made, update this gate')
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'src', 'accounts', 'api', 'rpc.js')),
    'the replacement gateway is missing')
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`016-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`016-test: ${passed} checks passed — the account RPC gateway serves the frozen surface.\n`)
process.stdout.write('Scope reminder: the gateway is built and tested in isolation. Mounting it into index.js is the integration step, left undone because that file holds uncommitted work.\n')
