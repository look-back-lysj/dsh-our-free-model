import assert from 'node:assert/strict'
import { startForwardServer } from '../src/forward.js'
import { createGatewayKey, GATEWAY_KEY_SCOPES } from '../src/gateway-keys.js'

const catalog = [
  { id: 'vendor/model-a', created: 1, owned_by: 'ofm' },
  { id: 'vendor/model-b', created: 2, owned_by: 'ofm' },
]
const scoped = createGatewayKey([], {
  label: 'read and chat', scopes: ['models:read', 'chat:write'], models: ['vendor/model-a'],
})
const responseOnly = createGatewayKey(scoped.records, {
  label: 'responses only', scopes: ['responses:write'],
})
const secrets = new Map([[scoped.key, scoped.metadata], [responseOnly.key, responseOnly.metadata]])
const rootKey = 'root-test-key'
let completions = 0
const server = await startForwardServer({
  config: () => ({ host: '127.0.0.1', port: 0, enabled: true, key: rootKey }),
  authenticate: key => secrets.get(key) ?? null,
  modelRows: () => catalog,
  complete: async request => {
    completions += 1
    return { text: request.model, toolCalls: [], usage: { inputTokens: 2, outputTokens: 2 } }
  },
})
const root = `http://127.0.0.1:${server.port}`
const call = (path, key, body, method = 'POST') => fetch(root + path, {
  method,
  headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

try {
  const listed = await call('/v1/models', scoped.key, undefined, 'GET')
  assert.equal(listed.status, 200)
  assert.deepEqual((await listed.json()).data.map(row => row.id), ['vendor/model-a'])

  const allowed = await call('/v1/chat/completions', scoped.key, {
    model: 'vendor/model-a', messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(allowed.status, 200)
  assert.equal(completions, 1)

  const blockedModel = await call('/v1/chat/completions', scoped.key, {
    model: 'vendor/model-b', messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(blockedModel.status, 403)
  assert.equal(completions, 1, 'a model outside the allowlist must never dispatch')

  const blockedScope = await call('/v1/responses', scoped.key, { model: 'vendor/model-a', input: 'hello' })
  assert.equal(blockedScope.status, 403)
  assert.equal(completions, 1, 'a missing operation scope must never dispatch')

  const allowedResponses = await call('/v1/responses', responseOnly.key, { model: 'vendor/model-b', input: 'hello' })
  assert.equal(allowedResponses.status, 200)
  assert.equal(completions, 2)

  const rootListing = await call('/v1/models', rootKey, undefined, 'GET')
  assert.equal(rootListing.status, 200)
  assert.equal((await rootListing.json()).data.length, catalog.length)
  assert.deepEqual(GATEWAY_KEY_SCOPES, ['models:read', 'chat:write', 'responses:write', 'messages:write'])
} finally {
  await server.close()
}

process.stdout.write('gateway-key-forward: scopes, model filtering, and master-key compatibility passed\n')
