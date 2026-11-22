/**
 * SRC-008 gate: the MiniMax adapter matches its frozen contract.
 *
 * Run: `node scripts/source-rewrite/008-test.mjs`
 *
 * The cases that carry weight:
 *
 * - **Abort must reach the reader.** The original consumer declared a signal and never read
 *   it, so a cancelled turn kept its upstream connection alive. This gate cancels mid-stream
 *   and requires the turn to end promptly.
 * - **An image the model cannot take is refused, not stripped.** Stripping produces a
 *   successful-looking turn in which the model never saw the picture.
 * - **The adaptive-only model always sends `adaptive`**, because `disabled` is rejected.
 * - **Usage is emitted once, at the end**, since the start event carries only a floor.
 * - **`message_delta.stop_reason` is the finish signal**, not a `[DONE]` sentinel.
 *
 * @module scripts/source-rewrite/008-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  ADAPTIVE_ONLY_PREFIX,
  classifyHttp,
  FALLBACK_MODELS,
  imageCapableModels,
  mapErrorCode,
  mapStopReason,
  PROVIDER_ID,
  reasoningInfo,
  refuseReason,
  shouldRotate,
  thinkingField,
} from '../../src/accounts/providers/minimax/product.js'
import { createMinimaxAdapter } from '../../src/accounts/providers/minimax/adapter.js'
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

/** Build an Anthropic event stream. */
function anthropicResponse(events) {
  const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

function harness({ responses, secrets = { MINIMAX_ACCESS_TOKEN: '{"access_token":"tok"}' }, readImage, pool }) {
  let index = 0
  const requests = []
  const store = new Map(Object.entries(secrets))
  const adapter = createMinimaxAdapter({
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
    accountPool: pool,
    ...(readImage === undefined ? {} : { readImage }),
    now: () => 1_000_000,
    warn: () => {},
  })
  return { adapter, requests, store }
}

process.stdout.write('SRC-008 MiniMax adapter gate\n\n')

// ── 1. catalog ─────────────────────────────────────────────────────────────
await check('the static catalog is the frozen four rows, in order', () => {
  const contracts = JSON.parse(fs.readFileSync(
    new URL('../../工程控制/ORIGIN-REWRITE-01/contracts/baseline-20261122/channel-contracts.json', import.meta.url),
    'utf8',
  ))
  const frozen = contracts.products.find(row => row.id === PROVIDER_ID)
  assert.deepEqual(FALLBACK_MODELS.map(row => row.id), frozen.modelIds)
})

await check('exactly two models advertise image input', () => {
  assert.deepEqual(imageCapableModels(), ['MiniMax-M3.1-Flash-Preview', 'MiniMax-M3'])
})

await check('only one model declares an effort menu', () => {
  const withMenu = FALLBACK_MODELS.filter(row => Array.isArray(row.effortOptions))
  assert.deepEqual(withMenu.map(row => row.id), ['MiniMax-M3.1-Flash-Preview'],
    'an effort menu was invented for a model that declares none')
})

await check('reasoning info appends the on/off ids only for a switchable model', () => {
  const adaptive = reasoningInfo(FALLBACK_MODELS.find(row => row.id === 'MiniMax-M3.1-Flash-Preview'))
  assert.deepEqual(adaptive.efforts, ['default', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(adaptive.defaultEffort, 'default')

  const switchable = reasoningInfo(FALLBACK_MODELS.find(row => row.id === 'MiniMax-M3'))
  assert.deepEqual(switchable.efforts, ['on', 'none'], 'a switchable model did not get its on/off ids')
  assert.equal(switchable.defaultEffort, undefined, 'a default was reported for a model that declares none')
})

// ── 2. thinking field ──────────────────────────────────────────────────────
await check('the adaptive-only model always sends adaptive', () => {
  const model = FALLBACK_MODELS.find(row => row.id === 'MiniMax-M3.1-Flash-Preview')
  assert.equal(model.id.startsWith(ADAPTIVE_ONLY_PREFIX), true)
  assert.deepEqual(thinkingField(model, 'none'), { type: 'adaptive' },
    'a disabled request was forwarded to a model that rejects it')
  assert.deepEqual(thinkingField(model, undefined), { type: 'adaptive' })
})

await check('a switchable model sends disabled only when asked for none', () => {
  const model = FALLBACK_MODELS.find(row => row.id === 'MiniMax-M3')
  assert.deepEqual(thinkingField(model, 'none'), { type: 'disabled' })
  assert.equal(thinkingField(model, 'on'), undefined)
  assert.equal(thinkingField(model, undefined), undefined)
})

await check('a forced-on model sends no thinking field at all', () => {
  const model = FALLBACK_MODELS.find(row => row.id === 'MiniMax-M2.7')
  assert.equal(thinkingField(model, undefined), undefined)
  assert.equal(thinkingField(model, 'none'), undefined, 'a forced-on model was told to disable thinking')
})

// ── 3. image refusal ───────────────────────────────────────────────────────
await check('an image is refused when the model does not accept one', () => {
  const model = FALLBACK_MODELS.find(row => row.id === 'MiniMax-M2.7')
  const reason = refuseReason(model, true, true)
  assert.ok(reason !== undefined, 'an image was accepted by a text-only model')
  assert.match(reason, /does not accept image/)
})

await check('an image is refused when no attachment reader is wired', () => {
  const model = FALLBACK_MODELS.find(row => row.id === 'MiniMax-M3')
  const reason = refuseReason(model, true, false)
  assert.ok(reason !== undefined, 'an image was accepted with no way to read it')
  assert.match(reason, /attachment service/)
})

await check('a capable model with a reader is allowed', () => {
  const model = FALLBACK_MODELS.find(row => row.id === 'MiniMax-M3')
  assert.equal(refuseReason(model, true, true), undefined)
  assert.equal(refuseReason(model, false, false), undefined, 'a text-only request was refused')
})

await check('an image on a text-only model fails before any request is sent', async () => {
  const { adapter, requests } = harness({ responses: [] })
  await assert.rejects(
    () => collect(adapter.stream({
      model: 'MiniMax-M2.7',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'img-1' } }] }],
    })),
    error => error.code === 'UNSUPPORTED_CONTENT',
  )
  assert.equal(requests.length, 0, 'a request was sent despite the refusal')
})

await check('an image that cannot be inlined is refused rather than sent without it', async () => {
  const { adapter, requests } = harness({
    responses: [],
    readImage: async () => undefined,
  })
  await assert.rejects(
    () => collect(adapter.stream({
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'img-1' } }] }],
    })),
    error => error.code === 'UNSUPPORTED_CONTENT',
  )
  assert.equal(requests.length, 0)
})

await check('an inlined image reaches the wire as a bare-base64 block', async () => {
  const { adapter, requests } = harness({
    readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
    responses: [() => anthropicResponse([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 5 } } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ])],
  })
  await collect(adapter.stream({
    model: 'MiniMax-M3',
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'img-1' } }] }],
  }))
  const body = JSON.parse(requests[0].init.body)
  const block = body.messages[0].content[0]
  assert.equal(block.type, 'image')
  assert.equal(block.source.type, 'base64')
  assert.equal(block.source.data, Buffer.from([1, 2, 3]).toString('base64'), 'the image was sent as a URL instead of base64')
  assert.ok(!block.source.data.startsWith('data:'), 'a data: prefix was sent')
})

// ── 4. classification ──────────────────────────────────────────────────────
await check('classification maps the status ladder', () => {
  assert.equal(classifyHttp(402), 'quota-exceeded')
  assert.equal(classifyHttp(401), 'auth')
  assert.equal(classifyHttp(429), 'soft-rate')
  assert.equal(classifyHttp(503), 'server')
  assert.equal(classifyHttp(400), 'client')
  assert.equal(classifyHttp(200), 'none')
  assert.equal(mapErrorCode(402, 'quota-exceeded'), ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED)
  assert.equal(mapErrorCode(401, 'auth'), ACCOUNT_ERROR_CODES.AUTH)
})

await check('this channel does not rotate inside the adapter', () => {
  assert.equal(shouldRotate(), false, 'the adapter spends another account instead of surfacing the failure')
})

await check('stop reasons map to the harness vocabulary', () => {
  assert.equal(mapStopReason('end_turn', false), 'stop')
  assert.equal(mapStopReason('max_tokens', false), 'max-tokens')
  assert.equal(mapStopReason('refusal', false), 'refusal')
  assert.equal(mapStopReason('end_turn', true), 'tool-calls')
})

// ── 5. the wire ────────────────────────────────────────────────────────────
await check('the request is an Anthropic messages body on the documented path', async () => {
  const { adapter, requests } = harness({
    responses: [() => anthropicResponse([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 4 } } } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ])],
  })
  await collect(adapter.stream({
    model: 'MiniMax-M3.1-Flash-Preview',
    messages: [{ role: 'system', content: 'brief' }, { role: 'user', content: 'hi' }],
    tools: [{ name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: {} } }],
    maxTokens: 256,
    reasoningEffort: 'high',
  }))
  const { url, init } = requests[0]
  assert.ok(url.endsWith('/mavis/api/v1/llm/v1/messages'))
  assert.equal(init.headers['anthropic-version'], '2023-06-01')
  const body = JSON.parse(init.body)
  assert.equal(body.stream, true)
  assert.equal(body.system, 'brief', 'the system prompt was not hoisted')
  assert.equal(body.max_tokens, 256)
  assert.equal(body.tools[0].input_schema !== undefined, true, 'tools were not sent in the Anthropic flat shape')
  assert.deepEqual(body.thinking, { type: 'adaptive' })
  assert.deepEqual(body.output_config, { effort: 'high' })
})

await check('text, thinking and tool input deltas map to their own chunk kinds', async () => {
  const { adapter } = harness({
    responses: [() => anthropicResponse([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 9 } } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu-1', name: 'read' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"p":1}' } } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ])],
  })
  const chunks = await collect(adapter.stream({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }] }))
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'pondering'))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'answer'))
  const call = chunks.find(chunk => chunk.type === 'tool-call')
  assert.equal(call.id, 'tu-1')
  assert.equal(call.arguments, '{"p":1}')
  assert.equal(chunks.at(-1).finishReason, 'tool-calls')
})

await check('usage is emitted once, from the merged start and delta counts', async () => {
  const { adapter } = harness({
    responses: [() => anthropicResponse([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 40, cache_read_input_tokens: 7 } } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ])],
  })
  const chunks = await collect(adapter.stream({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }] }))
  const usages = chunks.filter(chunk => chunk.type === 'usage')
  assert.equal(usages.length, 1, `${usages.length} usage chunks; the start floor was emitted as final`)
  assert.equal(usages[0].inputTokens, 40)
  assert.equal(usages[0].outputTokens, 12, 'the output count from the delta was lost')
  assert.equal(usages[0].cacheReadTokens, 7)
})

await check('a stream with no message_stop is reported as truncated', async () => {
  const { adapter } = harness({
    responses: [() => anthropicResponse([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } },
    ])],
  })
  const chunks = await collect(adapter.stream({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(chunks.at(-1).truncated, true)
})

// ── 6. abort reaches the reader ────────────────────────────────────────────
await check('an abort during the stream ends the turn promptly', async () => {
  const controller = new AbortController()
  // A stream that sends one frame and then never finishes: only an abort can end this.
  const body = new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } })}\n\n`,
      ))
      // Deliberately never closed.
    },
  })
  const adapter = createMinimaxAdapter({
    fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    credentials: { resolve: async () => ({ value: '{"access_token":"tok"}' }), set: async () => {} },
    credentialRef: ref => ref,
    now: () => 1_000_000,
  })
  const received = []
  const started = Date.now()
  await assert.rejects(async () => {
    for await (const chunk of adapter.stream({
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    })) {
      received.push(chunk)
      if (chunk.type === 'text-delta') controller.abort()
    }
  }, error => error.code === ACCOUNT_ERROR_CODES.ABORTED || error.name === 'AccountError' || String(error?.message).includes('abort'))
  assert.ok(received.some(chunk => chunk.type === 'text-delta'), 'the first frame never arrived')
  assert.ok(Date.now() - started < 5_000, 'the abort did not end the read; the reader is still ignoring the signal')
})

await check('an idle stream times out rather than hanging forever', async () => {
  const body = new ReadableStream({ start() { /* never enqueues, never closes */ } })
  const adapter = createMinimaxAdapter({
    fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    credentials: { resolve: async () => ({ value: '{"access_token":"tok"}' }), set: async () => {} },
    credentialRef: ref => ref,
    now: () => 1_000_000,
  })
  await assert.rejects(
    () => collect(adapter.stream({
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
      firstTokenMs: 50,
    })),
    error => error.code === ACCOUNT_ERROR_CODES.TRANSPORT,
  )
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`008-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`008-test: ${passed} checks passed — the MiniMax adapter meets its contract.\n`)
process.stdout.write('Scope reminder: scripted fetch only. Host wiring is SRC-016; a real account is SRC-019.\n')
