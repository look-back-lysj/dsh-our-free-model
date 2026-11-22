import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  GATEWAY_KEY_SCOPES,
  MAX_GATEWAY_KEYS,
  authenticateGatewayKey,
  createGatewayKey,
  gatewayKeyAllows,
  listGatewayKeys,
  revokeGatewayKey,
} from '../src/gateway-keys.js'

function makeKey(records, label = 'editor', scopes = ['models:read', 'chat:write'], models) {
  return createGatewayKey(records, {
    label,
    scopes,
    ...(models === undefined ? {} : { models }),
  }, { now: 1_801_234_567_890 })
}

const first = makeKey([], ' CI client ', ['chat:write', 'models:read'], ['vendor/model-a'])
assert.match(first.key, /^ofm_sk_[A-Za-z0-9_-]{43}$/)
assert.deepEqual(first.metadata, {
  id: first.records[0].id,
  prefix: first.key.slice(0, 15),
  label: 'CI client',
  createdAt: 1_801_234_567_890,
  scopes: ['models:read', 'chat:write'],
  models: ['vendor/model-a'],
})
assert.equal(first.records[0].digest, crypto.createHash('sha256').update(first.key).digest('hex'))
assert.deepEqual(Object.keys(first.records[0]).sort(), ['createdAt', 'digest', 'id', 'label', 'models', 'prefix', 'scopes'])
assert.equal(JSON.stringify(first.records).includes(first.key), false)
assert.equal(JSON.stringify(first.metadata).includes(first.key), false)
assert.equal(JSON.stringify(first.metadata).includes(first.records[0].digest), false)

assert.deepEqual(listGatewayKeys(first.records), [first.metadata])
const principal = authenticateGatewayKey(first.records, first.key)
assert.deepEqual(principal, first.metadata)
assert.equal(authenticateGatewayKey(first.records, `${first.key}x`), null)
assert.equal(authenticateGatewayKey(first.records, 'not-a-token'), null)
assert.equal(gatewayKeyAllows(principal, { scope: 'chat:write', model: 'vendor/model-a' }), true)
assert.equal(gatewayKeyAllows(principal, { scope: 'chat:write', model: 'vendor/model-b' }), false)
assert.equal(gatewayKeyAllows(principal, { scope: 'responses:write', model: 'vendor/model-a' }), false)
assert.equal(gatewayKeyAllows(principal, { scope: 'not-a-scope' }), false)
assert.equal(gatewayKeyAllows({ scopes: ['chat:write', 'unknown'] }, { scope: 'chat:write' }), false)
assert.equal(gatewayKeyAllows({ scopes: ['chat:write'], models: 'all' }, { scope: 'chat:write' }), false)

const second = makeKey(first.records, 'unrestricted', GATEWAY_KEY_SCOPES)
assert.equal(second.metadata.models, undefined)
assert.equal(gatewayKeyAllows(second.metadata, { scope: 'messages:write', model: 'any/model' }), true)
assert.equal(authenticateGatewayKey(second.records, second.key)?.id, second.metadata.id)

const revoked = revokeGatewayKey(second.records, first.metadata.id)
assert.equal(revoked.length, 1)
assert.equal(authenticateGatewayKey(revoked, first.key), null)
assert.equal(authenticateGatewayKey(revoked, second.key)?.id, second.metadata.id)
assert.throws(() => revokeGatewayKey(revoked, first.metadata.id), { code: 'NOT_FOUND' })

for (const input of [
  { label: '', scopes: ['chat:write'] },
  { label: 'bad\nlabel', scopes: ['chat:write'] },
  { label: 'x'.repeat(81), scopes: ['chat:write'] },
  { label: 'client', scopes: [] },
  { label: 'client', scopes: ['unknown:scope'] },
  { label: 'client', scopes: ['chat:write', 'chat:write'] },
  { label: 'client', scopes: ['chat:write'], extra: true },
  { label: 'client', scopes: ['chat:write'], models: ['bad model'] },
  { label: 'client', scopes: ['chat:write'], models: ['one', 'one'] },
  { label: 'client', scopes: ['chat:write'], models: Array.from({ length: 201 }, (_, index) => `model-${index}`) },
]) assert.throws(() => createGatewayKey([], input), TypeError)

assert.throws(() => createGatewayKey([], { label: 'client', scopes: ['chat:write'] }, { now: -1 }), TypeError)
assert.throws(() => listGatewayKeys([{ ...first.records[0], digest: 'bad' }]), { code: 'INVALID_GATEWAY_KEY_STORE' })
assert.throws(() => listGatewayKeys([{ ...first.records[0], key: first.key }]), { code: 'INVALID_GATEWAY_KEY_STORE' })
assert.throws(() => authenticateGatewayKey([null], first.key), { code: 'INVALID_GATEWAY_KEY_STORE' })

let full = []
for (let index = 0; index < MAX_GATEWAY_KEYS; index++) {
  full = makeKey(full, `client-${index}`, ['models:read']).records
}
assert.equal(full.length, MAX_GATEWAY_KEYS)
assert.throws(() => makeKey(full, 'too many'), { code: 'GATEWAY_KEY_LIMIT' })

process.stdout.write('gateway-keys: scoped create/list/auth/revoke and fail-closed validation passed\n')
