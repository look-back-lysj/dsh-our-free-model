/**
 * SRC-009 gate: the ZCode adapter matches its frozen contract.
 *
 * Run: `node scripts/source-rewrite/009-test.mjs`
 *
 * The cases that carry weight:
 *
 * - **No captcha is prefetched.** The first attempt of a turn sends none; a mint happens only
 *   after a `3007` or when this account/model is known to need one.
 * - **The requirement is scoped to account × model** and cleared after a success without a
 *   captcha, so a stale flag cannot gate an unrelated model.
 * - **`3007` classifies as a rate class**, not quota — reading it as quota parks the model for
 *   a day over something that resolves in seconds.
 * - **`3009` is a concurrency retry, not an exhaustion.**
 * - **The idle window is separate from the request deadline**, so a long reasoning turn is not
 *   killed while a dead socket is.
 *
 * @module scripts/source-rewrite/009-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  CAPTCHA_TTL_MS,
  CaptchaRequirements,
  classifyHttp,
  classifyInBand,
  FALLBACK_MODELS,
  FAST_EMPTY_MS,
  isCaptchaRejected,
  isConcurrencyLimited,
  isQuotaExhausted,
  isUnusualActivity,
  LEVEL_ORDER,
  mapErrorCode,
  PROVIDER_ID,
  shouldRotate,
  sortLevels,
  TUNING,
} from '../../src/accounts/providers/zcode/product.js'
import { createZcodeAdapter } from '../../src/accounts/providers/zcode/adapter.js'
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

function anthropicResponse(events) {
  const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

function harness({ responses, secrets = { ZCODE_ACCESS_TOKEN: '{"zcode_jwt":"jwt"}' }, mintCaptcha }) {
  let index = 0
  const requests = []
  const store = new Map(Object.entries(secrets))
  const adapter = createZcodeAdapter({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
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
    ...(mintCaptcha === undefined ? {} : { mintCaptcha }),
    now: () => 1_000_000,
    warn: () => {},
  })
  return { adapter, requests }
}

process.stdout.write('SRC-009 ZCode adapter gate\n\n')

// ── 1. catalog and tuning ──────────────────────────────────────────────────
await check('the static catalog is the frozen two rows, in order', () => {
  const contracts = JSON.parse(fs.readFileSync(
    new URL('../../工程控制/ORIGIN-REWRITE-01/contracts/baseline-20261122/channel-contracts.json', import.meta.url),
    'utf8',
  ))
  const frozen = contracts.products.find(row => row.id === PROVIDER_ID)
  assert.deepEqual(FALLBACK_MODELS.map(row => row.id), frozen.modelIds)
})

await check('only the flash model declares image input', () => {
  assert.deepEqual(FALLBACK_MODELS.filter(row => row.supportsImage === true).map(row => row.id), ['GLM-5.3-Flash'])
})

await check('the tuning constants are the frozen ones', () => {
  assert.equal(TUNING.requestTimeoutMs, 15 * 60_000)
  assert.equal(TUNING.streamIdleTimeoutMs, 600_000)
  assert.equal(TUNING.concurrencyRetryMax, 2)
  assert.equal(TUNING.concurrencyRetryBaseMs, 1_500)
  assert.equal(TUNING.quotaSwitchMax, 2)
  assert.equal(TUNING.toolCacheBreakpoint, true)
  assert.deepEqual(TUNING.modelGapMs, { 'glm-5.3': 350, 'glm-5.3-flash': 0 })
})

await check('levels sort into strength order with unknowns last', () => {
  assert.deepEqual(LEVEL_ORDER, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(sortLevels(['max', 'low', 'xhigh', 'weird', 'minimal']), ['minimal', 'low', 'xhigh', 'max', 'weird'])
})

// ── 2. classification order ────────────────────────────────────────────────
await check('3007 is a captcha, not a quota problem', () => {
  assert.equal(isCaptchaRejected('{"code":3007}'), true)
  assert.equal(classifyHttp(200, '{"code":3007}'), 'captcha')
  assert.equal(mapErrorCode(200, '', 'captcha'), ACCOUNT_ERROR_CODES.RATE_LIMIT,
    'reading a captcha as quota would park the model for a day')
})

await check('3009 is a concurrency signal and never counts as exhaustion', () => {
  assert.equal(isConcurrencyLimited('{"code":3009}'), true)
  assert.equal(isQuotaExhausted(200, '{"code":3009}'), false, '3009 was read as an exhaustion')
})

await check('exhaustion is recognised from its codes and wording', () => {
  assert.equal(isQuotaExhausted(200, '1113'), true)
  assert.equal(isQuotaExhausted(200, '余额不足'), true)
  assert.equal(isQuotaExhausted(200, 'exceed quota limit'), true)
  assert.equal(isQuotaExhausted(200, 'everything is fine'), false)
})

await check('unusual activity is a permission class', () => {
  assert.equal(isUnusualActivity('unusual activity detected'), true)
  assert.equal(classifyHttp(200, 'unusual activity'), 'permission')
  assert.equal(mapErrorCode(200, '', 'permission'), 'PERMISSION_DENIED')
})

await check('the classifier order is captcha, permission, quota, auth, rate, server', () => {
  assert.equal(classifyHttp(401, '3007'), 'captcha', 'captcha must outrank the status')
  assert.equal(classifyHttp(401, ''), 'auth')
  assert.equal(classifyHttp(200, '1002'), 'auth')
  assert.equal(classifyHttp(429, ''), 'soft-rate')
  assert.equal(classifyHttp(503, ''), 'server')
  assert.equal(classifyHttp(400, ''), 'client')
  assert.equal(classifyHttp(200, ''), 'server', 'the default must be server, not none')
})

await check('in-band classification maps only an overloaded error to a rate class', () => {
  assert.equal(classifyInBand('overloaded_error'), 'soft-rate')
  assert.equal(classifyInBand('something_else'), 'server')
})

await check('only exhaustion rotates and cools', () => {
  assert.equal(shouldRotate('quota-exceeded'), true)
  assert.equal(shouldRotate('captcha'), false, 'a captcha rotated the account instead of re-minting')
  assert.equal(shouldRotate('soft-rate'), false)
})

// ── 3. captcha requirement memory ──────────────────────────────────────────
await check('the requirement is scoped to one account and model', () => {
  let clock = 0
  const memory = new CaptchaRequirements({ now: () => clock, ttlMs: 100 })
  memory.markRequired('acct-a', 'glm-5.3')
  assert.equal(memory.required('acct-a', 'glm-5.3'), true)
  assert.equal(memory.required('acct-b', 'glm-5.3'), false, 'the requirement leaked to another account')
  assert.equal(memory.required('acct-a', 'glm-5.3-flash'), false, 'the requirement leaked to another model')
})

await check('the requirement expires and can be cleared', () => {
  let clock = 0
  const memory = new CaptchaRequirements({ now: () => clock, ttlMs: 100 })
  memory.markRequired('a', 'm')
  clock = 50
  assert.equal(memory.required('a', 'm'), true)
  clock = 101
  assert.equal(memory.required('a', 'm'), false, 'an expired requirement still gated the request')
  memory.markRequired('a', 'm')
  memory.clear('a', 'm')
  assert.equal(memory.required('a', 'm'), false)
  assert.equal(CAPTCHA_TTL_MS, 120_000)
})

await check('the first attempt of a turn sends no captcha', async () => {
  const { adapter, requests } = harness({
    responses: [() => anthropicResponse([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ])],
  })
  await collect(adapter.stream({ model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] }))
  const headers = requests[0].init.headers
  assert.ok(!Object.keys(headers).some(key => /captcha/i.test(key)), 'a captcha was prefetched on the first attempt')
})

await check('a 3007 rejection records the requirement and retries with a fresh captcha', async () => {
  let minted = 0
  const { adapter, requests } = harness({
    mintCaptcha: async () => { minted += 1; return { 'x-captcha-token': `token-${minted}` } },
    responses: [
      () => new Response(JSON.stringify({ code: 3007, message: 'captcha required' }), { status: 400 }),
      () => anthropicResponse([
        { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
    ],
  })
  const chunks = await collect(adapter.stream({ model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(minted, 1, `minted ${minted} captchas`)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].init.headers['x-captcha-token'], 'token-1', 'the fresh captcha did not reach the retry')
  assert.ok(chunks.some(chunk => chunk.text === 'ok'))
})

await check('a success without a captcha clears the recorded requirement', async () => {
  let minted = 0
  const { adapter } = harness({
    mintCaptcha: async () => { minted += 1; return { 'x-captcha-token': 't' } },
    responses: [
      // First turn: rejected, then succeeds with a captcha.
      () => new Response(JSON.stringify({ code: 3007 }), { status: 400 }),
      () => anthropicResponse([
        { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
      // Second turn: no captcha needed, and success must clear the flag.
      () => anthropicResponse([
        { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'again' } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
    ],
  })
  await collect(adapter.stream({ model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] }))
  await collect(adapter.stream({ model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] }))
  // After the second turn succeeded without needing a captcha, the requirement is cleared.
  assert.equal(adapter.captchaRequirements(), 0, 'the requirement survived a successful turn')
})

// ── 4. the wire ────────────────────────────────────────────────────────────
await check('the request is an Anthropic body on the documented path', async () => {
  const { adapter, requests } = harness({
    responses: [() => anthropicResponse([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 2 } } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ])],
  })
  await collect(adapter.stream({
    model: 'GLM-5.3',
    messages: [{ role: 'system', content: 'brief' }, { role: 'user', content: 'hi' }],
    tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object', properties: {} } }],
    maxTokens: 512,
    reasoningEffort: 'max',
  }))
  const { url, init } = requests[0]
  assert.ok(url.endsWith('/api/v1/zcode-plan/anthropic/v1/messages'))
  assert.equal(init.headers['anthropic-version'], '2023-06-01')
  assert.equal(init.headers.authorization, 'Bearer jwt')
  const body = JSON.parse(init.body)
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 512)
  assert.deepEqual(body.system, [{ type: 'text', text: 'brief' }])
  assert.deepEqual(body.output_config, { effort: 'max' })
  assert.deepEqual(body.tools[0].cache_control, { type: 'ephemeral' }, 'the tool cache breakpoint was dropped')
})

await check('an image on a text-only model is refused', async () => {
  const { adapter, requests } = harness({ responses: [] })
  await assert.rejects(
    () => collect(adapter.stream({
      model: 'GLM-5.3',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'i' } }] }],
    })),
    error => error.code === 'UNSUPPORTED_CONTENT',
  )
  assert.equal(requests.length, 0)
})

await check('a concurrency collision retries in place rather than rotating', async () => {
  const { adapter, requests } = harness({
    responses: [
      () => new Response(JSON.stringify({ code: 3009 }), { status: 429 }),
      () => anthropicResponse([
        { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
    ],
  })
  const chunks = await collect(adapter.stream({ model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(requests.length, 2, 'a concurrency collision did not retry')
  assert.ok(chunks.some(chunk => chunk.text === 'ok'))
})

await check('usage is emitted once with a total only when both halves are known', async () => {
  const { adapter } = harness({
    responses: [() => anthropicResponse([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 6 } } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ])],
  })
  const chunks = await collect(adapter.stream({ model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] }))
  const usages = chunks.filter(chunk => chunk.type === 'usage')
  assert.equal(usages.length, 1)
  assert.equal(usages[0].inputTokens, 6)
  assert.equal(usages[0].outputTokens, 4)
  assert.equal(usages[0].totalTokens, 10)
})

await check('a stream with no message_stop is reported as truncated', async () => {
  const { adapter } = harness({
    responses: [() => anthropicResponse([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } },
    ])],
  })
  const chunks = await collect(adapter.stream({ model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(chunks.at(-1).truncated, true)
})

await check('an in-band error event is surfaced', async () => {
  const { adapter } = harness({
    responses: [() => anthropicResponse([
      { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } },
    ])],
  })
  await assert.rejects(
    () => collect(adapter.stream({ model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] })),
    error => error.code === ACCOUNT_ERROR_CODES.RATE_LIMIT,
  )
})

await check('a silent stream times out on the idle window', async () => {
  const body = new ReadableStream({ start() { /* never enqueues */ } })
  const adapter = createZcodeAdapter({
    fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    credentials: { resolve: async () => ({ value: '{"zcode_jwt":"jwt"}' }), set: async () => {} },
    credentialRef: ref => ref,
    now: () => 1_000_000,
  })
  await assert.rejects(
    () => collect(adapter.stream({
      model: 'GLM-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      streamIdleTimeoutMs: 50,
    })),
    error => error.code === ACCOUNT_ERROR_CODES.TRANSPORT,
  )
})

await check('an abort during the stream ends the turn', async () => {
  const controller = new AbortController()
  const body = new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } })}\n\n`,
      ))
    },
  })
  const adapter = createZcodeAdapter({
    fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    credentials: { resolve: async () => ({ value: '{"zcode_jwt":"jwt"}' }), set: async () => {} },
    credentialRef: ref => ref,
    now: () => 1_000_000,
  })
  await assert.rejects(async () => {
    for await (const chunk of adapter.stream({
      model: 'GLM-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    })) {
      if (chunk.type === 'text-delta') controller.abort()
    }
  }, error => error.code === ACCOUNT_ERROR_CODES.ABORTED)
})

await check('the fast-empty window is the frozen value', () => {
  assert.equal(FAST_EMPTY_MS, 3_000)
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`009-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`009-test: ${passed} checks passed — the ZCode adapter meets its contract.\n`)
process.stdout.write('Scope reminder: scripted fetch only, no browser automation. Host wiring is SRC-016; a real account is SRC-019.\n')
