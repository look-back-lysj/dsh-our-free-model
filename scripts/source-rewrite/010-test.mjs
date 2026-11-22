/**
 * SRC-010 gate: the Gemini adapter matches its frozen contract.
 *
 * Run: `node scripts/source-rewrite/010-test.mjs`
 *
 * The cases that carry weight:
 *
 * - **The body is alphabetically ordered at every level.** The upstream is field-order
 *   sensitive, and relying on insertion order produces failures that only some requests hit.
 * - **A model id other than the exposed one is refused**, not forwarded: a permissive id is
 *   accepted locally and then fails upstream with a message that names the wrong cause.
 * - **The session id is stable per conversation** and changes when the generation is bumped.
 * - **`thoughtSignature` is replayed on the next turn**, matched by tool name and canonical
 *   arguments; a signature rejection drops signatures and retries once.
 * - **The two-layer envelope is unwrapped**, and `[DONE]` is ignored.
 * - **The probe order is the reverse of the inference order**, which is deliberate.
 *
 * @module scripts/source-rewrite/010-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  canonicalArguments,
  canonicalModelId,
  classifyFailure,
  DEFAULT_TIER,
  deriveSessionId,
  ENDPOINTS,
  FALLBACK_MODELS,
  IDENTITY_HEADERS,
  isContextOverflow,
  isEndpointProblem,
  isQuotaLike,
  isSessionOverflow,
  LOAD_CODE_ASSIST_BODY,
  looksLikeSignatureError,
  mapErrorCode,
  marshalAlphabetical,
  MODEL_ID,
  modelSpec,
  PROBE_ENDPOINTS,
  PROVIDER_ID,
  QUOTA_BUCKETS,
  readQuota,
  RATE_LIMIT_COOLDOWN_MS,
  AUTH_COOLDOWN_MS,
  SIGSTORE_LIMIT,
  SignatureCache,
  TIERS,
  TIER_BUDGETS,
  UPSTREAM_FLASH,
} from '../../src/accounts/providers/gemini/product.js'
import { createGeminiAdapter } from '../../src/accounts/providers/gemini/adapter.js'
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

/** Build an SSE response from inner envelope objects. */
function sseResponse(inners) {
  const body = inners.map(inner => `data: ${JSON.stringify({ response: inner })}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/** An adapter over a scripted fetch, with the project probe answered locally. */
function harness({ responses, secrets = { GEMINI_ACCESS_TOKEN: '{"access_token":"tok","project":"proj-1"}' }, pool, cache }) {
  let index = 0
  const requests = []
  const store = new Map(Object.entries(secrets))
  const adapter = createGeminiAdapter({
    fetch: async (url, init) => {
      const target = String(url)
      // The probe is answered without consuming a scripted response: it is infrastructure,
      // not the thing under test in most cases.
      if (target.includes('loadCodeAssist')) {
        requests.push({ url: target, init, probe: true })
        return new Response(JSON.stringify({ cloudaicompanionProject: 'proj-1' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      requests.push({ url: target, init })
      const make = responses[index]
      index += 1
      if (make === undefined) throw new Error(`ran out of scripted responses (attempt ${index})`)
      return make()
    },
    credentials: {
      resolve: async ref => (store.has(ref) ? { value: store.get(ref) } : undefined),
      set: async (ref, value) => { store.set(ref, value) },
    },
    credentialRef: ref => ref,
    accountPool: pool,
    ...(cache === undefined ? {} : { signatureCache: cache }),
    now: () => 1_000_000,
    warn: () => {},
  })
  return { adapter, requests, store }
}

process.stdout.write('SRC-010 Gemini adapter gate\n\n')

// ── 1. the exposed model and its tiers ─────────────────────────────────────
await check('the static catalog is the frozen single row', () => {
  const contracts = JSON.parse(fs.readFileSync(
    new URL('../../工程控制/ORIGIN-REWRITE-01/contracts/baseline-20261122/channel-contracts.json', import.meta.url),
    'utf8',
  ))
  const frozen = contracts.products.find(row => row.id === PROVIDER_ID)
  assert.deepEqual(FALLBACK_MODELS.map(row => row.id), frozen.modelIds)
  assert.equal(FALLBACK_MODELS.length, 1, 'this channel exposes exactly one model id')
})

await check('the tier set and budgets are the frozen ones', () => {
  assert.deepEqual([...TIERS], ['low', 'medium', 'high', 'tiered'])
  assert.deepEqual({ ...TIER_BUDGETS }, { low: 1_000, medium: 4_000, high: 10_000, tiered: -1 })
  assert.equal(DEFAULT_TIER, 'medium')
})

await check('a tier maps onto a suffixed upstream name', () => {
  for (const tier of TIERS) {
    const spec = modelSpec(MODEL_ID, tier)
    assert.equal(spec.upstream, `${UPSTREAM_FLASH}-${tier}`)
    assert.equal(spec.thinkingBudget, TIER_BUDGETS[tier])
    assert.equal(spec.includeThoughts, true, 'thinking must always be included')
  }
})

await check('an unknown tier falls back to the default', () => {
  assert.equal(modelSpec(MODEL_ID, 'xhigh').tier, DEFAULT_TIER)
  assert.equal(modelSpec(MODEL_ID, undefined).tier, DEFAULT_TIER)
})

await check('a model id other than the exposed one is refused', () => {
  assert.throws(() => modelSpec('gemini-9.9-fake', undefined), /unsupported model/)
  assert.throws(() => modelSpec('totally-bogus', undefined), /unsupported model/)
})

await check('a suffixed id is accepted and canonicalised', () => {
  assert.equal(canonicalModelId('gemini-3.8-flash-high'), 'gemini-3.8-flash')
  assert.equal(canonicalModelId('gemini-3.8-flash'), 'gemini-3.8-flash')
  assert.equal(canonicalModelId('gemini-x-high'), 'gemini-x', 'only known tier suffixes may be stripped')
  assert.equal(modelSpec('gemini-3.8-flash-low', undefined).upstream, 'gemini-3.8-flash-medium')
})

// ── 2. serialization ───────────────────────────────────────────────────────
await check('serialization orders keys alphabetically at every level', () => {
  const out = marshalAlphabetical({ b: 1, a: { z: 2, y: { n: 1, m: 2 } }, c: [{ q: 1, p: 2 }] })
  assert.equal(out, '{"a":{"y":{"m":2,"n":1},"z":2},"b":1,"c":[{"p":2,"q":1}]}')
})

await check('canonical arguments ignore key order', () => {
  assert.equal(canonicalArguments('{"b":1,"a":2}'), canonicalArguments('{"a":2,"b":1}'))
})

// ── 3. session identity ────────────────────────────────────────────────────
await check('the session id is stable per conversation and moves with the generation', () => {
  const base = deriveSessionId({ project: 'p', lane: 'infer', firstUserText: 'hello' })
  assert.equal(base, deriveSessionId({ project: 'p', lane: 'infer', firstUserText: 'hello' }), 'the session id is not stable')
  assert.notEqual(base, deriveSessionId({ project: 'p', lane: 'infer', firstUserText: 'other' }))
  assert.notEqual(base, deriveSessionId({ project: 'q', lane: 'infer', firstUserText: 'hello' }))
  assert.notEqual(base, deriveSessionId({ project: 'p', lane: 'infer', firstUserText: 'hello', generation: 1 }))
  assert.match(base, /^-?\d+$/, 'the session id must be a signed decimal string')
})

// ── 4. signature cache ─────────────────────────────────────────────────────
await check('the signature cache keys on tool name and canonical arguments', () => {
  const cache = new SignatureCache({ now: () => 0 })
  cache.store('read', { b: 1, a: 2 }, 'sig-1')
  assert.equal(cache.lookup('read', { a: 2, b: 1 }), 'sig-1', 'the argument order changed the lookup key')
  assert.equal(cache.lookup('read', { a: 3 }), undefined)
  assert.equal(cache.lookup('write', { a: 2, b: 1 }), undefined)
})

await check('the cache falls back to the latest signature for a tool', () => {
  const cache = new SignatureCache({ now: () => 0 })
  cache.store('read', { p: 1 }, 'sig-old')
  cache.store('read', { p: 2 }, 'sig-new')
  assert.equal(cache.latestForTool('read'), 'sig-new')
  assert.equal(cache.latestForTool('write'), undefined)
})

await check('the cache is bounded and drops the least recently used', () => {
  const cache = new SignatureCache({ limit: 2, now: () => 0 })
  cache.store('a', {}, 's1')
  cache.store('b', {}, 's2')
  cache.store('c', {}, 's3')
  assert.equal(cache.size(), 2)
  assert.equal(cache.lookup('a', {}), undefined, 'the oldest entry survived trimming')
  assert.equal(cache.lookup('c', {}), 's3')
  assert.equal(SIGSTORE_LIMIT, 2_000)
})

// ── 5. classification ──────────────────────────────────────────────────────
await check('signature and overflow predicates match their wording', () => {
  assert.equal(looksLikeSignatureError('thought_signature is invalid'), true)
  assert.equal(looksLikeSignatureError('signature missing'), true)
  assert.equal(looksLikeSignatureError('all good'), false)
  assert.equal(isSessionOverflow('request exceeds the maximum number of tokens'), true)
  assert.equal(isContextOverflow('exceeds the maximum number of tokens'), true)
})

await check('an endpoint problem is a 403, a 404, or a 400 naming a project concern', () => {
  assert.equal(isEndpointProblem(403, ''), true)
  assert.equal(isEndpointProblem(404, ''), true)
  assert.equal(isEndpointProblem(400, 'unsupported model'), true)
  assert.equal(isEndpointProblem(400, 'quota exceeded'), true)
  assert.equal(isEndpointProblem(400, 'bad field'), false)
  assert.equal(isEndpointProblem(500, ''), false)
})

await check('quota-like is a 429 or a 400 with quota wording', () => {
  assert.equal(isQuotaLike(429, ''), true)
  assert.equal(isQuotaLike(400, 'quota exceeded'), true)
  assert.equal(isQuotaLike(400, 'bad field'), false)
})

await check('the classifier order puts context overflow before quota', () => {
  assert.equal(classifyFailure(400, 'exceeds the maximum number of tokens'), 'context-overflow')
  assert.equal(mapErrorCode(400, '', 'context-overflow'), 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(classifyFailure(400, 'quota exceeded'), 'quota-exceeded')
  assert.equal(classifyFailure(429, ''), 'soft-rate')
  assert.equal(classifyFailure(403, ''), 'server')
  assert.equal(classifyFailure(401, ''), 'auth')
  assert.equal(classifyFailure(503, ''), 'server')
})

await check('the cooldowns are the frozen values', () => {
  assert.equal(RATE_LIMIT_COOLDOWN_MS, 60_000)
  assert.equal(AUTH_COOLDOWN_MS, 300_000)
})

await check('the endpoint orders are deliberately opposite', () => {
  assert.equal(ENDPOINTS[0], 'https://daily-cloudcode-pa.googleapis.com')
  assert.equal(PROBE_ENDPOINTS[0], 'https://daily-cloudcode-pa.sandbox.googleapis.com',
    'the probe order must stay the reverse of the inference order')
})

await check('the identity headers and probe body are the frozen ones', () => {
  assert.equal(IDENTITY_HEADERS['User-Agent'], 'antigravity')
  assert.equal(LOAD_CODE_ASSIST_BODY, '{"metadata":{"ideType":"ANTIGRAVITY"}}')
})

// ── 6. quota ───────────────────────────────────────────────────────────────
await check('quota buckets are read with the average across windows', () => {
  assert.deepEqual([...QUOTA_BUCKETS], ['gemini-5h', 'gemini-weekly'])
  const result = readQuota({
    buckets: [
      { bucketId: 'gemini-5h', remainingFraction: 0.5, resetTime: '2026-11-22T10:00:00Z' },
      { bucketId: 'gemini-weekly', remainingFraction: 0.25, resetTime: '2026-11-25T10:00:00Z' },
      { bucketId: 'unknown-bucket', remainingFraction: 0.9, resetTime: '2026-11-22T10:00:00Z' },
    ],
  })
  assert.equal(result.buckets.length, 2, 'an unknown bucket was reported')
  assert.equal(result.averageRemaining, 0.375)
})

await check('a bucket with an unparseable reset is dropped rather than reported', () => {
  const result = readQuota({ buckets: [{ bucketId: 'gemini-5h', remainingFraction: 0.5, resetTime: 'not a date' }] })
  assert.equal(result.buckets.length, 0, 'a window with a wrong reset time was reported')
  assert.equal(result.averageRemaining, null)
})

// ── 7. the wire ────────────────────────────────────────────────────────────
await check('the request is a two-layer alphabetical envelope on the streaming path', async () => {
  const { adapter, requests } = harness({
    responses: [() => sseResponse([{ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }])],
  })
  await collect(adapter.stream({ model: MODEL_ID, messages: [{ role: 'user', content: 'hello' }] }))
  const chat = requests.find(entry => !entry.probe)
  assert.ok(chat.url.endsWith('/v1internal:streamGenerateContent?alt=sse'))
  assert.equal(chat.init.headers['User-Agent'], 'antigravity')
  const raw = chat.init.body
  const parsed = JSON.parse(raw)
  assert.equal(parsed.model, 'gemini-3.8-flash-medium')
  assert.equal(parsed.project, 'proj-1')
  assert.ok(parsed.request.contents.length > 0)
  // Alphabetical order: compare the serialized text to a re-sort of the parsed object.
  assert.equal(raw, marshalAlphabetical(parsed), 'the body is not alphabetically ordered')
  assert.equal(parsed.request.generationConfig.thinkingConfig.includeThoughts, true)
  assert.equal(parsed.request.generationConfig.thinkingConfig.thinkingBudget, 4_000)
})

await check('a tiered request omits the thinking budget', async () => {
  const { adapter, requests } = harness({
    responses: [() => sseResponse([{ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] }])],
  })
  await collect(adapter.stream({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'tiered' }))
  const parsed = JSON.parse(requests.find(entry => !entry.probe).init.body)
  assert.equal('thinkingBudget' in parsed.request.generationConfig.thinkingConfig, false)
})

await check('the two-layer envelope is unwrapped, and [DONE] is ignored', async () => {
  const body = [
    `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'answer' }] } }] } })}\n\n`,
    'data: [DONE]\n\n',
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'bare' }] }, finishReason: 'STOP' }] })}\n\n`,
  ].join('')
  const { adapter } = harness({
    responses: [() => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })],
  })
  const chunks = await collect(adapter.stream({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }))
  const texts = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)
  assert.deepEqual(texts, ['answer', 'bare'], 'a wrapped or bare frame was lost, or [DONE] was treated as content')
  assert.equal(chunks.at(-1).finishReason, 'stop')
})

await check('a thought part is separated from answer text', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([
      { candidates: [{ content: { parts: [{ text: 'pondering', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] },
    ])],
  })
  const chunks = await collect(adapter.stream({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }))
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'pondering'))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'answer'))
})

await check('usage keeps the frame with the greatest total', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([
      { candidates: [{ content: { parts: [{ text: 'a' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 } },
      { candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9, totalTokenCount: 14 } },
    ])],
  })
  const chunks = await collect(adapter.stream({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }))
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.equal(usage.totalTokens, 14, 'an early usage frame was reported as final')
  assert.equal(usage.outputTokens, 9)
})

await check('a stream ending without a finish reason is reported as truncated', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([{ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }])],
  })
  const chunks = await collect(adapter.stream({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(chunks.at(-1).truncated, true)
})

// ── 8. signature replay and the retry rules ────────────────────────────────
await check('a signature on a functionCall is stored and replayed next turn', async () => {
  const cache = new SignatureCache({ now: () => 0 })
  const { adapter, requests } = harness({
    cache,
    responses: [
      // Turn one: the model calls a tool and attaches a signature.
      () => sseResponse([{
        candidates: [{
          content: { parts: [{ functionCall: { name: 'read', args: { path: 'a' } }, thoughtSignature: 'sig-abc' }] },
          finishReason: 'STOP',
        }],
      }]),
      // Turn two: the caller sends the history back.
      () => sseResponse([{ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }]),
    ],
  })
  await collect(adapter.stream({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(cache.lookup('read', { path: 'a' }), 'sig-abc', 'the signature was not stored')

  await collect(adapter.stream({
    model: MODEL_ID,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }] },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'file body' },
    ],
  }))
  const second = JSON.parse(requests.filter(entry => !entry.probe)[1].init.body)
  const callPart = second.request.contents[1].parts.find(part => part.functionCall !== undefined)
  assert.equal(callPart.thoughtSignature, 'sig-abc', 'the stored signature was not replayed on the next turn')
})

await check('a signature rejection drops signatures and retries once', async () => {
  const cache = new SignatureCache({ now: () => 0 })
  cache.store('read', { path: 'a' }, 'stale')
  const { adapter, requests } = harness({
    cache,
    responses: [
      () => new Response('thought_signature is invalid', { status: 400 }),
      () => sseResponse([{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]),
    ],
  })
  const chunks = await collect(adapter.stream({
    model: MODEL_ID,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }] },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'x' },
    ],
  }))
  const calls = requests.filter(entry => !entry.probe)
  assert.equal(calls.length, 2, 'the signature retry did not happen')
  const retried = JSON.parse(calls[1].init.body)
  const callPart = retried.request.contents[1].parts.find(part => part.functionCall !== undefined)
  assert.equal(callPart.thoughtSignature, undefined, 'the stale signature was replayed on the retry')
  assert.ok(chunks.some(chunk => chunk.text === 'ok'))
})

await check('a session overflow bumps the generation once', async () => {
  const { adapter, requests } = harness({
    responses: [
      () => new Response('request exceeds the maximum number of tokens', { status: 400 }),
      () => sseResponse([{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]),
    ],
  })
  const chunks = await collect(adapter.stream({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }))
  const calls = requests.filter(entry => !entry.probe)
  assert.equal(calls.length, 2, 'the session bump did not retry')
  const first = JSON.parse(calls[0].init.body)
  const second = JSON.parse(calls[1].init.body)
  assert.notEqual(first.request.sessionId, second.request.sessionId, 'the session id was not bumped')
  assert.ok(chunks.some(chunk => chunk.text === 'ok'))
})

await check('a context overflow is surfaced without consuming a retry', async () => {
  // Only one scripted response: if the adapter retried, it would run out and report a
  // transport failure instead of the context error.
  const { adapter, requests } = harness({
    responses: [() => new Response('the request exceeds the maximum number of tokens for the context window', { status: 400 })],
  })
  await assert.rejects(
    () => collect(adapter.stream({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }] })),
    error => error.code === 'CONTEXT_WINDOW_EXCEEDED',
  )
  assert.equal(requests.filter(entry => !entry.probe).length, 1, 'a non-retryable context error was retried')
})

await check('a session overflow is distinguished from a context overflow', () => {
  // Overlapping wording: the session predicate must not claim a context overflow, or the
  // adapter retries something that cannot succeed.
  assert.equal(isContextOverflow('exceeds the maximum number of tokens'), true)
  assert.equal(isSessionOverflow('the context window exceeds the maximum number of tokens'), false,
    'a context overflow was read as a session overflow')
  assert.equal(isSessionOverflow('session exceeds the maximum number of tokens'), true)
})

await check('an endpoint problem switches endpoint once', async () => {
  const { adapter, requests } = harness({
    responses: [
      () => new Response('project not found', { status: 404 }),
      () => sseResponse([{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]),
    ],
  })
  const chunks = await collect(adapter.stream({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }))
  const calls = requests.filter(entry => !entry.probe)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].url.includes('daily-cloudcode-pa.googleapis.com'))
  assert.ok(calls[1].url.includes('daily-cloudcode-pa.sandbox.googleapis.com'), 'the endpoint was not switched')
  assert.ok(chunks.some(chunk => chunk.text === 'ok'))
})

await check('an unsupported model is refused before any request', async () => {
  const { adapter, requests } = harness({ responses: [] })
  await assert.rejects(
    () => collect(adapter.stream({ model: 'gemini-9.9-fake', messages: [{ role: 'user', content: 'hi' }] })),
    /unsupported model/,
  )
  assert.equal(requests.length, 0, 'a request was sent for an unsupported model')
})

await check('a quota-like failure rotates with the short cooldown', async () => {
  const accounts = [
    { id: 'a', provider: PROVIDER_ID, enabled: true },
    { id: 'b', provider: PROVIDER_ID, enabled: true },
  ]
  const cooldowns = []
  let next = 0
  const pool = {
    getAvailableAccount: async () => {
      const row = accounts[next]
      next += 1
      return row === undefined ? null : { entry: row, credential: { access_token: `t-${row.id}`, project: 'proj-1' } }
    },
    updateModelRateLimit: async (id, model, at) => { cooldowns.push({ id, at }) },
  }
  const { adapter } = harness({
    pool,
    responses: [
      () => new Response('quota exceeded', { status: 429 }),
      () => sseResponse([{ candidates: [{ content: { parts: [{ text: 'from b' }] }, finishReason: 'STOP' }] }]),
    ],
  })
  const chunks = await collect(adapter.stream({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }))
  assert.ok(chunks.some(chunk => chunk.text === 'from b'))
  assert.equal(cooldowns.length, 1)
  assert.equal(cooldowns[0].at, 1_000_000 + RATE_LIMIT_COOLDOWN_MS, 'a rate limit used the wrong cooldown')
})

await check('an abort during the stream ends the turn', async () => {
  const controller = new AbortController()
  const body = new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'first' }] } }] } })}\n\n`,
      ))
    },
  })
  const adapter = createGeminiAdapter({
    fetch: async url => {
      if (String(url).includes('loadCodeAssist')) {
        return new Response(JSON.stringify({ cloudaicompanionProject: 'p' }), { status: 200 })
      }
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
    credentials: { resolve: async () => ({ value: '{"access_token":"t"}' }), set: async () => {} },
    credentialRef: ref => ref,
    now: () => 1_000_000,
  })
  await assert.rejects(async () => {
    for await (const chunk of adapter.stream({
      model: MODEL_ID,
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    })) {
      if (chunk.type === 'text-delta') controller.abort()
    }
  }, error => error.code === ACCOUNT_ERROR_CODES.ABORTED)
})

await check('the single exposed model is listed only when an account exists', async () => {
  const { adapter } = harness({ responses: [] })
  const models = await adapter.listModels()
  assert.deepEqual(models.map(row => row.id), [MODEL_ID])
  assert.equal(models[0].effortOptions.length, 4)
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`010-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`010-test: ${passed} checks passed — the Gemini adapter meets its contract.\n`)
process.stdout.write('Scope reminder: scripted fetch only. Host wiring is SRC-016; a real account is SRC-019.\n')
