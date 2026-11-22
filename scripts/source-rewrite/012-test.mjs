/**
 * SRC-012 gate: the Qoder and Qoder CN outer adapters match their frozen contracts.
 *
 * Run: `node scripts/source-rewrite/012-test.mjs`
 *
 * The cases that carry weight:
 *
 * - **The two products are verified separately.** They share the WASM but not their hosts,
 *   client ids or model tables, so a pass on one is not evidence for the other.
 * - **The encrypted envelope comes from the bridge, and the adapter never rebuilds the
 *   `Authorization` header.** Replacing it yields a request the server rejects without a reason.
 * - **A model key, not a display name, reaches the payload**, and an id outside the product's
 *   table is refused rather than forwarded.
 * - **A queue notice is waited out, not surfaced**, and rotation happens only after repeated
 *   hits so one busy account cannot consume the whole budget.
 * - **A spent allowance parks the model and rotates.**
 *
 * @module scripts/source-rewrite/012-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  buildInferPayload,
  classifyHttp,
  classifyInBand,
  effortMenu,
  hasPricingHint,
  isBillingPayload,
  isQueuePayload,
  mapErrorCode,
  MAX_ATTEMPTS,
  modelsFor,
  PRODUCTS,
  PROVIDER_QODER,
  PROVIDER_QODER_CN,
  QODER_CN_MODELS,
  QODER_MODELS,
  queueDelayMs,
  QUEUE_MAX_DELAY_MS,
  resolveEffort,
} from '../../src/accounts/providers/qoder/product.js'
import { createQoderAdapter } from '../../src/accounts/providers/qoder/adapter.js'
import { ACCOUNT_ERROR_CODES } from '../../src/accounts/core/errors.js'

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

/** Build an SSE response from payloads. */
function sseResponse(payloads) {
  const body = payloads.map(payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/**
 * An adapter over a scripted fetch and a stub encryption bridge.
 *
 * The bridge records what it was asked to encrypt and returns a fixed envelope, which is enough
 * to prove the adapter delegates rather than reimplements.
 */
function harness({ provider = PROVIDER_QODER, responses, secrets, pool, encrypt, sleep }) {
  let index = 0
  const requests = []
  const encrypted = []
  const ref = PRODUCTS[provider].defaultCredentialRef
  const store = new Map(Object.entries(secrets ?? { [ref]: '{"access_token":"tok","refresh_token":"r"}' }))
  const adapter = createQoderAdapter({
    provider,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      const make = responses[index]
      index += 1
      if (make === undefined) throw new Error(`ran out of scripted responses (attempt ${index})`)
      return make()
    },
    credentials: {
      resolve: async name => (store.has(name) ? { value: store.get(name) } : undefined),
      set: async (name, value) => { store.set(name, value) },
    },
    credentialRef: name => name,
    accountPool: pool,
    encrypt: encrypt ?? (async plaintext => {
      encrypted.push(plaintext)
      return {
        url: `${PRODUCTS[provider].encryptedInferBase}/algo/api/v2/service/pro/sse/agent_chat_generation`,
        headers: { authorization: 'Bearer COSY.envelope', 'x-wasm': 'yes' },
        body: 'ENCRYPTED',
      }
    }),
    ...(sleep === undefined ? {} : { sleep }),
    now: () => 1_000_000,
    warn: () => {},
  })
  return { adapter, requests, encrypted, store }
}

process.stdout.write('SRC-012 Qoder / Qoder CN adapter gate\n\n')

// ── 1. the two products, separately ────────────────────────────────────────
await check('both products exist with distinct hosts', () => {
  assert.equal(PRODUCTS[PROVIDER_QODER].authBase, 'https://qoder.com')
  assert.equal(PRODUCTS[PROVIDER_QODER_CN].authBase, 'https://qoder.cn')
  assert.notEqual(PRODUCTS[PROVIDER_QODER].encryptedInferBase, PRODUCTS[PROVIDER_QODER_CN].encryptedInferBase,
    'the two products must not share an inference host')
})

await check('the international table is the frozen 17 rows, in order', () => {
  const contracts = JSON.parse(fs.readFileSync(
    new URL('../../工程控制/ORIGIN-REWRITE-01/contracts/baseline-20261122/channel-contracts.json', import.meta.url),
    'utf8',
  ))
  const frozen = contracts.products.find(row => row.id === PROVIDER_QODER)
  assert.deepEqual(QODER_MODELS.map(row => row.id), frozen.modelIds)
  assert.equal(QODER_MODELS.length, 17)
})

await check('the CN table is the frozen 14 rows, in order, and is not the international one', () => {
  const contracts = JSON.parse(fs.readFileSync(
    new URL('../../工程控制/ORIGIN-REWRITE-01/contracts/baseline-20261122/channel-contracts.json', import.meta.url),
    'utf8',
  ))
  const frozen = contracts.products.find(row => row.id === PROVIDER_QODER_CN)
  assert.deepEqual(QODER_CN_MODELS.map(row => row.id), frozen.modelIds)
  assert.equal(QODER_CN_MODELS.length, 14)
  assert.notDeepEqual(QODER_CN_MODELS.map(row => row.id), QODER_MODELS.map(row => row.id))
})

await check('the CN-only rows exist and the international-only rows do not', () => {
  const cn = new Set(QODER_CN_MODELS.map(row => row.id))
  const intl = new Set(QODER_MODELS.map(row => row.id))
  for (const id of ['q37fmodel', 'gm51model']) {
    assert.equal(cn.has(id), true, `CN is missing ${id}`)
    assert.equal(intl.has(id), false, `international must not carry ${id}`)
  }
  for (const id of ['ultimate', 'performance', 'efficient', 'smodel', 'cmodel']) {
    assert.equal(intl.has(id), true, `international is missing ${id}`)
    assert.equal(cn.has(id), false, `CN must not carry ${id}`)
  }
})

await check('modelsFor selects the right table per product', () => {
  assert.equal(modelsFor(PROVIDER_QODER), QODER_MODELS)
  assert.equal(modelsFor(PROVIDER_QODER_CN), QODER_CN_MODELS)
})

// ── 2. effort and the payload ──────────────────────────────────────────────
await check('the effort menu is strength-ordered with none first when disabling is allowed', () => {
  const model = QODER_MODELS.find(row => row.id === 'ultimate')
  assert.deepEqual(effortMenu(model), ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  const noDisable = QODER_MODELS.find(row => row.id === 'kmodel_latest')
  assert.deepEqual(effortMenu(noDisable), ['low', 'high', 'max'])
  assert.equal(effortMenu(QODER_MODELS.find(row => row.id === 'auto')).length, 0)
})

await check('effort resolution only sends a declared level', () => {
  const model = QODER_MODELS.find(row => row.id === 'gmodel')
  assert.equal(resolveEffort(model, 'high'), 'high')
  assert.equal(resolveEffort(model, 'max'), 'max')
  assert.equal(resolveEffort(model, 'medium'), 'max', 'an undeclared level was sent')
  assert.equal(resolveEffort({ efforts: ['high'], defaultEffort: 'high' }, undefined), 'high')
  assert.equal(resolveEffort({ efforts: [] }, undefined), undefined)
})

await check('the payload carries the model key, not the display name', () => {
  const model = QODER_MODELS.find(row => row.id === 'qfmodel')
  const payload = buildInferPayload({
    model,
    requestId: 'req-1',
    sessionId: 'sess-1',
    text: 'hello',
    system: 'be brief',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    reasoningEffort: 'medium',
  })
  assert.equal(payload.model_config.key, 'qfmodel')
  assert.equal(payload.model_config.model, 'qfmodel')
  assert.equal(payload.model_config.display_name, 'Qwen3.8-Flash')
  assert.equal(payload.chat_context.extra.modelConfig.key, 'qfmodel')
  assert.equal(payload.request_id, 'req-1')
  assert.equal(payload.session_id, 'sess-1')
  assert.equal(payload.stream, true)
})

await check('the payload derives its capability flags from the model row', () => {
  const withImage = buildInferPayload({ model: QODER_MODELS.find(row => row.id === 'gmodel'), requestId: 'r', sessionId: 's' })
  assert.equal(withImage.model_config.is_vl, true)
  assert.equal(withImage.model_config.is_reasoning, true)
  const cn = buildInferPayload({ model: QODER_CN_MODELS.find(row => row.id === 'mmodel'), requestId: 'r', sessionId: 's' })
  assert.equal(cn.model_config.is_vl, undefined, 'an undeclared image capability became false rather than absent')
})

// ── 3. queue and billing detection ─────────────────────────────────────────
await check('a queue payload is recognised by code or by its own fields', () => {
  assert.equal(isQueuePayload({ code: '10605' }), true)
  assert.equal(isQueuePayload({ code: 10605 }), true)
  assert.equal(isQueuePayload({ isQueued: true }), true)
  assert.equal(isQueuePayload({ model_queued: true }), true)
  assert.equal(isQueuePayload({ choices: [] }), false)
  assert.equal(isQueuePayload(null), false)
})

await check('the queue delay prefers milliseconds, then seconds, and caps', () => {
  assert.equal(queueDelayMs({ retry_after_ms: 5_000 }), 5_000)
  assert.equal(queueDelayMs({ retryAfterMs: 4_000 }), 4_000)
  assert.equal(queueDelayMs({ retryAfterSeconds: 2 }), 2_000)
  assert.equal(queueDelayMs({ retryAfterSeconds: 60 }), QUEUE_MAX_DELAY_MS, 'a long wait was not capped')
  assert.equal(queueDelayMs({ retryAfterSeconds: -1 }), undefined, 'a negative wait was accepted')
  assert.equal(queueDelayMs({}), undefined)
})

await check('a billing payload is recognised by code or wording, and not by prose', () => {
  assert.equal(isBillingPayload({ code: '110' }), true)
  assert.equal(isBillingPayload({ code: 112 }), true)
  assert.equal(isBillingPayload({ message: 'Billing daily count exceeded' }), true)
  assert.equal(isBillingPayload({ message: 'explain a billing system' }), false)
})

await check('a pricing hint is recognised by key only', () => {
  assert.equal(hasPricingHint({ error: { pricingUrl: 'https://x' } }), true)
  assert.equal(hasPricingHint({ text: 'pricing matters' }), false)
})

await check('the HTTP order puts queue first, then billing, then auth', () => {
  assert.equal(classifyHttp({ status: 403, body: { code: '10605' } }), 'queue')
  assert.equal(classifyHttp({ status: 403, body: { code: '110' } }), 'quota-exceeded')
  assert.equal(classifyHttp({ status: 403, body: { pricingUrl: 'https://x' } }), 'quota-exceeded')
  assert.equal(classifyHttp({ status: 403, body: {} }), 'auth')
  assert.equal(classifyHttp({ status: 409, body: {} }), 'duplicate')
  assert.equal(classifyHttp({ status: 429, body: {} }), 'soft-rate')
  assert.equal(classifyHttp({ status: 503, body: {} }), 'server')
})

await check('the in-band default is a server error', () => {
  assert.equal(classifyInBand({ code: '10605' }), 'queue')
  assert.equal(classifyInBand({ code: '110' }), 'quota-exceeded')
  assert.equal(classifyInBand({ something: 'odd' }), 'server')
  assert.equal(mapErrorCode('queue', 200), ACCOUNT_ERROR_CODES.QUEUE)
  assert.equal(mapErrorCode('quota-exceeded', 403), ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED)
})

// ── 4. the encrypted envelope boundary ─────────────────────────────────────
await check('the adapter posts to the URL the bridge produced and keeps its headers', async () => {
  const { adapter, requests } = harness({
    responses: [() => sseResponse([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }, '[DONE]'])],
  })
  await collect(adapter.stream({ model: 'qfmodel', messages: [{ role: 'user', content: 'hello' }] }))
  const { url, init } = requests[0]
  assert.ok(url.includes('agent_chat_generation'), `posted to ${url}`)
  assert.equal(init.headers.authorization, 'Bearer COSY.envelope', 'the WASM authorization header was replaced')
  assert.equal(init.headers['x-wasm'], 'yes', 'a bridge header was dropped')
  assert.equal(init.body, 'ENCRYPTED', 'the encrypted body was not sent verbatim')
})

await check('the bridge receives the plaintext payload', async () => {
  const { adapter, encrypted } = harness({
    responses: [() => sseResponse([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }, '[DONE]'])],
  })
  await collect(adapter.stream({ model: 'gmodel', messages: [{ role: 'user', content: 'hello' }] }))
  assert.equal(encrypted.length, 1, 'the bridge was not called')
  const payload = JSON.parse(encrypted[0])
  assert.equal(payload.model_config.key, 'gmodel')
  assert.equal(payload.chat_context.extra.modelConfig.is_reasoning, true)
})

await check('a bridge failure is reported as a server error, not as a network fault', async () => {
  const { adapter } = harness({
    responses: [],
    encrypt: async () => { throw new Error('wasm trap') },
  })
  await assert.rejects(
    () => collect(adapter.stream({ model: 'gmodel', messages: [{ role: 'user', content: 'hi' }] })),
    error => error.code === ACCOUNT_ERROR_CODES.SERVER && /encryption bridge/.test(error.message),
  )
})

await check('a model outside the product table is refused before encryption', async () => {
  const { adapter, encrypted } = harness({ responses: [] })
  await assert.rejects(
    () => collect(adapter.stream({ model: 'gm51model', messages: [{ role: 'user', content: 'hi' }] })),
    error => error.code === ACCOUNT_ERROR_CODES.INVALID_REQUEST,
  )
  assert.equal(encrypted.length, 0, 'the bridge was invoked for an unknown model')
})

await check('the CN product accepts its own rows and refuses the international ones', async () => {
  const { adapter } = harness({
    provider: PROVIDER_QODER_CN,
    responses: [() => sseResponse([{ choices: [{ delta: { content: 'cn' }, finish_reason: 'stop' }] }, '[DONE]'])],
  })
  const chunks = await collect(adapter.stream({ model: 'q37fmodel', messages: [{ role: 'user', content: 'hi' }] }))
  assert.ok(chunks.some(chunk => chunk.text === 'cn'))
  await assert.rejects(
    () => collect(adapter.stream({ model: 'ultimate', messages: [{ role: 'user', content: 'hi' }] })),
    error => error.code === ACCOUNT_ERROR_CODES.INVALID_REQUEST,
  )
})

// ── 5. queue and quota behaviour ───────────────────────────────────────────
await check('a queue notice is waited out rather than surfaced', async () => {
  const slept = []
  const { adapter } = harness({
    sleep: async ms => { slept.push(ms) },
    responses: [
      () => new Response(JSON.stringify({ code: '10605', retryAfterSeconds: 3 }), { status: 403 }),
      () => sseResponse([{ choices: [{ delta: { content: 'after queue' }, finish_reason: 'stop' }] }, '[DONE]']),
    ],
  })
  const chunks = await collect(adapter.stream({ model: 'gmodel', messages: [{ role: 'user', content: 'hi' }] }))
  assert.ok(slept.length >= 1, 'the queue notice was surfaced instead of waited out')
  assert.ok(chunks.some(chunk => chunk.text === 'after queue'))
})

await check('a spent allowance parks the model and rotates', async () => {
  const accounts = [
    { id: 'a', provider: PROVIDER_QODER, enabled: true },
    { id: 'b', provider: PROVIDER_QODER, enabled: true },
  ]
  const cooldowns = []
  let next = 0
  const pool = {
    getAvailableAccount: async () => {
      const row = accounts[next]
      next += 1
      return row === undefined ? null : { entry: row, credential: { access_token: `t-${row.id}` } }
    },
    updateModelRateLimit: async (id, model, at) => { cooldowns.push({ id, model, at }) },
  }
  const { adapter, requests } = harness({
    pool,
    responses: [
      () => new Response(JSON.stringify({ code: '110' }), { status: 403 }),
      () => sseResponse([{ choices: [{ delta: { content: 'from b' }, finish_reason: 'stop' }] }, '[DONE]']),
    ],
  })
  const chunks = await collect(adapter.stream({ model: 'gmodel', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(requests.length, 2, 'a spent allowance did not rotate')
  assert.ok(chunks.some(chunk => chunk.text === 'from b'))
  assert.equal(cooldowns.length, 1)
  assert.ok(cooldowns[0].at > 1_000_000 + 3_600_000, 'a daily allowance cooled for less than a day')
})

await check('a pricing-hint rejection counts as a spent allowance', async () => {
  const accounts = [
    { id: 'a', provider: PROVIDER_QODER_CN, enabled: true },
    { id: 'b', provider: PROVIDER_QODER_CN, enabled: true },
  ]
  const cooldowns = []
  let next = 0
  const pool = {
    getAvailableAccount: async () => {
      const row = accounts[next]
      next += 1
      return row === undefined ? null : { entry: row, credential: { access_token: `t-${row.id}` } }
    },
    updateModelRateLimit: async (id, model, at) => { cooldowns.push({ id, at }) },
  }
  const { adapter } = harness({
    provider: PROVIDER_QODER_CN,
    pool,
    responses: [
      () => new Response(JSON.stringify({ code: '112', pricingUrl: 'https://buy' }), { status: 403 }),
      () => sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']),
    ],
  })
  await collect(adapter.stream({ model: 'gmodel', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(cooldowns.length, 1, 'a pricing-hint rejection recorded no cooldown')
})

await check('a 409 duplicate is resent without consuming a rotation', async () => {
  const { adapter, requests } = harness({
    responses: [
      () => new Response('conflict', { status: 409 }),
      () => sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']),
    ],
  })
  const chunks = await collect(adapter.stream({ model: 'gmodel', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(requests.length, 2)
  assert.ok(chunks.some(chunk => chunk.text === 'ok'))
})

await check('a 401 refreshes once and retries', async () => {
  let refreshed = 0
  const store = new Map([['QODER_ACCESS_TOKEN', JSON.stringify({ access_token: 'old', refresh_token: 'r1' })]])
  const adapter = createQoderAdapter({
    fetch: async (url) => {
      if (String(url).includes('/deviceToken/refresh')) {
        refreshed += 1
        return new Response(JSON.stringify({ data: { access_token: 'new' } }), { status: 200 })
      }
      if (refreshed === 0) return new Response('unauthorized', { status: 401 })
      return sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'])
    },
    credentials: {
      resolve: async name => (store.has(name) ? { value: store.get(name) } : undefined),
      set: async (name, value) => { store.set(name, value) },
    },
    credentialRef: name => name,
    encrypt: async () => ({ url: 'https://x/agent_chat_generation', headers: { authorization: 'Bearer e' }, body: 'b' }),
    now: () => 1_000_000,
  })
  const chunks = await collect(adapter.stream({ model: 'gmodel', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(refreshed, 1)
  assert.ok(chunks.some(chunk => chunk.text === 'ok'))
})

await check('rotation is bounded', async () => {
  const accounts = Array.from({ length: MAX_ATTEMPTS + 2 }, (_, index) => ({ id: `a${index}`, provider: PROVIDER_QODER, enabled: true }))
  let next = 0
  const pool = {
    getAvailableAccount: async () => {
      const row = accounts[next]
      next += 1
      return row === undefined ? null : { entry: row, credential: { access_token: `t-${row.id}` } }
    },
    updateModelRateLimit: async () => {},
  }
  const { adapter, requests } = harness({
    pool,
    responses: Array.from({ length: MAX_ATTEMPTS }, () => () => new Response(JSON.stringify({ code: '110' }), { status: 403 })),
  })
  await assert.rejects(
    () => collect(adapter.stream({ model: 'gmodel', messages: [{ role: 'user', content: 'hi' }] })),
    error => error.code === ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED,
  )
  assert.equal(requests.length, MAX_ATTEMPTS)
})

await check('an in-band quota frame after output is surfaced, not retried', async () => {
  const accounts = [
    { id: 'a', provider: PROVIDER_QODER, enabled: true },
    { id: 'b', provider: PROVIDER_QODER, enabled: true },
  ]
  let next = 0
  const pool = {
    getAvailableAccount: async () => {
      const row = accounts[next]
      next += 1
      return row === undefined ? null : { entry: row, credential: { access_token: `t-${row.id}` } }
    },
    updateModelRateLimit: async () => {},
  }
  const { adapter, requests } = harness({
    pool,
    sleep: async () => {},
    responses: [() => sseResponse([
      { choices: [{ delta: { content: 'partial' } }] },
      { code: '110', message: 'Billing daily count exceeded' },
    ])],
  })
  const out = []
  await assert.rejects(async () => {
    for await (const chunk of adapter.stream({ model: 'gmodel', messages: [{ role: 'user', content: 'hi' }] })) out.push(chunk)
  })
  assert.ok(out.some(chunk => chunk.text === 'partial'))
  assert.equal(requests.length, 1, 'a retry was opened after output had been delivered')
})

await check('the model list reflects the product table and its effort menus', async () => {
  const { adapter } = harness({ provider: PROVIDER_QODER_CN, responses: [] })
  const models = await adapter.listModels()
  assert.equal(models.length, 14)
  assert.ok(models.every(row => typeof row.supportsImage === 'boolean'))
  const gmodel = models.find(row => row.id === 'gmodel')
  assert.deepEqual(gmodel.efforts, ['low', 'high', 'max'])
})

await check('a missing encryption bridge is refused at construction', () => {
  assert.throws(() => createQoderAdapter({
    fetch: async () => new Response(''),
    credentials: { resolve: async () => undefined, set: async () => {} },
    credentialRef: name => name,
  }), /requires the retained-WASM encrypt bridge/)
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`012-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`012-test: ${passed} checks passed — both Qoder products meet their contracts.\n`)
process.stdout.write('Scope reminder: the WASM bridge is stubbed here. Host wiring is SRC-016; a real encrypted request is SRC-019.\n')
