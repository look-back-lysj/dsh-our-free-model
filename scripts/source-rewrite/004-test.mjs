/**
 * SRC-004 gate: the TRAE adapter matches its frozen contract.
 *
 * Run: `node scripts/source-rewrite/004-test.mjs`
 *
 * The cases that carry weight:
 *
 * - **`4008` must be checked before `4011`.** One body can carry both, and the lighter
 *   class gives the shorter cooldown, so checking it first parks an exhausted account for
 *   sixty seconds and then retries it — the "countdown keeps resetting" symptom.
 * - **The plan class needs the word "plan"**, because `1005` alone also means the allowance.
 * - **An in-band frame needs both a code and a message** to count as an error.
 * - **The SOLO transform** renames the model, forces streaming, and stringifies tool
 *   parameters; sending the OpenAI body would be accepted and then rejected upstream.
 * - **A 5xx rotates without a cooldown badge**, because the badge means "limited".
 *
 * @module scripts/source-rewrite/004-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyHttp,
  classifyInBandFrame,
  COOLDOWN_FALLBACK_MS,
  DEFAULT_CHANNELS,
  DEFAULT_FUNCTION,
  deriveCheckinDeviceId,
  FALLBACK_MODELS,
  isRotatableStreamCode,
  mapErrorCode,
  MAX_ATTEMPTS,
  MAX_COMPLETION_TOKENS,
  parseBatchModels,
  PROVIDER_ID,
  recordsCooldown,
  shouldRotate,
  toSoloBody,
} from '../../src/accounts/providers/trae/product.js'
import { createTraeAdapter } from '../../src/accounts/providers/trae/adapter.js'
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

/** Build a named-event SSE response. */
function eventResponse(events, { terminate = true } = {}) {
  const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  return new Response(terminate ? body : body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

function harness({ responses, secrets = { TRAE_ACCESS_TOKEN: '{"access_token":"tok"}' }, pool }) {
  let index = 0
  const requests = []
  const store = new Map(Object.entries(secrets))
  const adapter = createTraeAdapter({
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
    now: () => 1_000_000,
    warn: () => {},
  })
  return { adapter, requests, store }
}

process.stdout.write('SRC-004 TRAE adapter gate\n\n')

// ── 1. classifier priority ─────────────────────────────────────────────────
await check('quota-exceeded outranks soft-rate when one body carries both codes', () => {
  // The whole point: 4008 needs a long cooldown, 4011 a short one. Checking the light one
  // first parks an exhausted account briefly and then retries it.
  assert.equal(classifyHttp(200, '{"code":4008} and {"code":4011}'), 'quota-exceeded')
  assert.equal(classifyHttp(400, '4008 exceeded the quota'), 'quota-exceeded')
})

await check('the plan class requires the word "plan"', () => {
  assert.equal(classifyHttp(200, '{"code":1005} plan limit reached'), 'hard-plan')
  assert.equal(classifyHttp(200, '{"code":1005}'), 'quota-exceeded',
    'a bare 1005 without "plan" is the allowance case, not the plan case')
})

await check('soft-rate is recognised from 4011 alone', () => {
  assert.equal(classifyHttp(200, '4011'), 'soft-rate')
  assert.equal(classifyHttp(429, ''), 'soft-rate')
})

await check('a dead session is recognised', () => {
  assert.equal(classifyHttp(401, ''), 'session-dead')
  assert.equal(classifyHttp(401, 'token rejected'), 'session-dead')
})

await check('the status ladder maps as the contract says', () => {
  assert.equal(classifyHttp(404, ''), 'not-found')
  assert.equal(classifyHttp(500, ''), 'server')
  assert.equal(classifyHttp(418, ''), 'client')
  assert.equal(classifyHttp(200, ''), 'none')
})

await check('every non-clean kind rotates; only limited kinds cool down', () => {
  for (const kind of ['hard-plan', 'quota-exceeded', 'soft-rate', 'session-dead', 'not-found', 'server', 'client']) {
    assert.equal(shouldRotate(kind), true, `${kind} must rotate`)
  }
  assert.equal(shouldRotate('none'), false)
  assert.equal(recordsCooldown('server'), false, 'a transient fault parked the model')
  assert.equal(recordsCooldown('client'), false)
  assert.equal(recordsCooldown('session-dead'), false)
  for (const kind of ['hard-plan', 'soft-rate', 'not-found', 'quota-exceeded']) {
    assert.equal(recordsCooldown(kind), true, `${kind} must record a cooldown`)
  }
})

// ── 2. in-band frames ──────────────────────────────────────────────────────
await check('an in-band frame needs both a code and a message to count', () => {
  assert.equal(classifyInBandFrame({ code: 1005 }), undefined, 'a code with no message was treated as an error')
  assert.equal(classifyInBandFrame({ message: 'x' }), undefined, 'a message with no code was treated as an error')
  // With both present, the code decides. A bare 1005 is the allowance case; the plan class
  // needs the "plan" wording, which this frame-level classifier does not attempt to read.
  assert.equal(classifyInBandFrame({ code: 1005, message: 'quota' })?.kind, 'quota-exceeded')
  assert.equal(classifyInBandFrame({ code: 4008, message: 'quota' })?.kind, 'quota-exceeded')
  assert.equal(classifyInBandFrame({ code: 4011, message: 'slow down' })?.kind, 'soft-rate')
})

await check('only 1005, 4008 and 4011 are rotatable in-band', () => {
  assert.equal(isRotatableStreamCode(1005), true)
  assert.equal(isRotatableStreamCode(4008), true)
  assert.equal(isRotatableStreamCode(4011), true)
  assert.equal(isRotatableStreamCode(4001), false)
  assert.equal(classifyInBandFrame({ code: 4001, message: 'x' })?.rotatable, false)
})

// ── 3. the SOLO transform ──────────────────────────────────────────────────
await check('the transform forces streaming and adds the routing function', () => {
  const out = toSoloBody({ model: 'glm-5', messages: [] }, { functionName: 'solo_agent' })
  assert.equal(out.stream, true)
  assert.equal(out.function, 'solo_agent')
})

await check('the transform renames the model into config_name plus model', () => {
  const out = toSoloBody({ model: 'glm-5__dev', messages: [] })
  assert.equal(out.model, 'glm-5', 'the __dev suffix was not stripped')
  assert.equal(out.config_name, 'glm-5')
})

await check('the transform defaults the routing function', () => {
  const out = toSoloBody({ model: 'glm-5', messages: [] })
  assert.equal(out.function, DEFAULT_FUNCTION)
})

await check('the transform stringifies tool parameters', () => {
  const out = toSoloBody({
    model: 'glm-5',
    messages: [],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
  })
  assert.equal(typeof out.tools[0].function.parameters, 'string', 'parameters were not stringified')
  assert.deepEqual(JSON.parse(out.tools[0].function.parameters), { type: 'object' })
})

await check('the transform reshapes assistant tool calls into function_call', () => {
  const out = toSoloBody({
    model: 'glm-5',
    messages: [{ role: 'assistant', content: 'hi', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] }],
  })
  const message = out.messages[0]
  assert.ok(!('tool_calls' in message), 'tool_calls survived; the provider reads function_call')
  assert.equal(message.function_call[0].name, 'read')
  assert.deepEqual(message.content, [{ type: 'text', text: 'hi' }])
})

// ── 4. catalog parsing ─────────────────────────────────────────────────────
await check('the static catalog is the frozen 32 rows, in order', () => {
  const contracts = JSON.parse(fs.readFileSync(
    new URL('../../工程控制/ORIGIN-REWRITE-01/contracts/baseline-20261122/channel-contracts.json', import.meta.url),
    'utf8',
  ))
  const frozen = contracts.products.find(row => row.id === PROVIDER_ID)
  assert.deepEqual(FALLBACK_MODELS.map(row => row.id), frozen.modelIds)
})

await check('the static catalog marks exactly four hidden rows', () => {
  const hidden = FALLBACK_MODELS.filter(row => row.isHidden === true).map(row => row.id)
  assert.deepEqual(hidden, ['browser_use_subagent', 'explore_sub_agent_v13', 'explore_sub_agent_v2', 'summary'])
})

await check('batch parsing drops rows outside the channel whitelist', () => {
  const parsed = parseBatchModels({
    data: [
      { function: 'solo_agent', models: [{ id: 'keep-me', usage: 'chat_completion' }] },
      { function: 'not_a_channel', models: [{ id: 'drop-me', usage: 'chat_completion' }] },
    ],
  })
  assert.deepEqual(parsed.map(row => row.id), ['keep-me'])
})

await check('batch parsing drops non-chat, disabled and invisible rows', () => {
  const parsed = parseBatchModels({
    data: [{
      function: 'solo_agent',
      models: [
        { id: 'good', usage: 'chat_completion' },
        { id: 'embedding', usage: 'embedding' },
        { id: 'switched-off', usage: 'chat_completion', config_switch: false },
        { id: 'invisible', usage: 'chat_completion', is_invisible_to_user: true },
      ],
    }],
  })
  assert.deepEqual(parsed.map(row => row.id), ['good'])
})

await check('the channel whitelist is the frozen fifteen entries', () => {
  assert.equal(DEFAULT_CHANNELS.length, 15)
  assert.equal(DEFAULT_CHANNELS[0], 'solo_agent')
})

// ── 5. check-in device derivation ──────────────────────────────────────────
await check('generation zero keeps the base device id', () => {
  assert.equal(deriveCheckinDeviceId('base-device', 0), 'base-device')
  assert.equal(deriveCheckinDeviceId('base-device', -1), 'base-device')
})

await check('a generation change produces a different, stable device id', () => {
  const first = deriveCheckinDeviceId('base-device', 1)
  const second = deriveCheckinDeviceId('base-device', 2)
  assert.notEqual(first, 'base-device')
  assert.notEqual(first, second, 'two generations produced the same device id')
  assert.equal(first, deriveCheckinDeviceId('base-device', 1), 'the derivation is not deterministic')
  assert.match(first, /^[0-9a-f]{32}$/)
})

// ── 6. request and streaming ───────────────────────────────────────────────
await check('the request goes to the SOLO path with the transformed body', async () => {
  const { adapter, requests } = harness({
    responses: [() => eventResponse([{ event: 'done', data: { finish_reason: 'stop' } }])],
  })
  await collect(adapter.stream({
    model: 'glm-5',
    messages: [{ role: 'system', content: 'brief' }, { role: 'user', content: 'hi' }],
    maxTokens: 500,
  }))
  const { url, init } = requests[0]
  assert.ok(url.endsWith('/api/agent/v3/llm_utils_chat'))
  assert.equal(init.headers.authorization, 'Bearer tok')
  const body = JSON.parse(init.body)
  assert.equal(body.stream, true)
  assert.equal(body.config_name, 'glm-5')
  assert.equal(body.function, DEFAULT_FUNCTION)
  assert.equal(body.max_tokens, 500)
  assert.deepEqual(body.messages.map(row => row.role), ['system', 'user'])
})

await check('the output cap is clamped', async () => {
  const { adapter, requests } = harness({
    responses: [() => eventResponse([{ event: 'done', data: { finish_reason: 'stop' } }])],
  })
  await collect(adapter.stream({
    model: 'glm-5',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: MAX_COMPLETION_TOKENS * 2,
  }))
  assert.equal(JSON.parse(requests[0].init.body).max_tokens, MAX_COMPLETION_TOKENS)
})

await check('the done event terminates the stream', async () => {
  const { adapter } = harness({
    responses: [() => eventResponse([
      { event: 'message', data: { choices: [{ delta: { content: 'answer' } }] } },
      { event: 'done', data: { finish_reason: 'stop' } },
    ])],
  })
  const chunks = await collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }))
  assert.ok(chunks.some(chunk => chunk.text === 'answer'))
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.truncated, false)
})

await check('a stream that ends without a done event is reported as truncated', async () => {
  const { adapter } = harness({
    responses: [() => eventResponse([
      { event: 'message', data: { choices: [{ delta: { content: 'partial' } }] } },
    ])],
  })
  const chunks = await collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(chunks.at(-1).truncated, true)
})

await check('the token_usage event supplies usage', async () => {
  const { adapter } = harness({
    responses: [() => eventResponse([
      { event: 'message', data: { choices: [{ delta: { content: 'a' } }] } },
      { event: 'token_usage', data: { usage: { prompt_tokens: 11, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } } },
      { event: 'done', data: { finish_reason: 'stop' } },
    ])],
  })
  const chunks = await collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }))
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.equal(usage.inputTokens, 8)
  assert.equal(usage.cacheReadTokens, 3)
  assert.equal(usage.outputTokens, 4)
})

await check('an incomplete in-band error frame does not abort the stream', async () => {
  const { adapter } = harness({
    responses: [() => eventResponse([
      { event: 'error', data: { code: 1005 } },
      { event: 'message', data: { choices: [{ delta: { content: 'still fine' } }] } },
      { event: 'done', data: { finish_reason: 'stop' } },
    ])],
  })
  const chunks = await collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }))
  assert.ok(chunks.some(chunk => chunk.text === 'still fine'), 'a frame with only a code aborted the stream')
})

await check('an in-band error after output is surfaced, not retried', async () => {
  const accounts = [
    { id: 'a', provider: PROVIDER_ID, enabled: true },
    { id: 'b', provider: PROVIDER_ID, enabled: true },
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
    responses: [() => eventResponse([
      { event: 'message', data: { choices: [{ delta: { content: 'partial' } }] } },
      { event: 'error', data: { code: 4008, message: 'quota' } },
    ])],
  })
  const out = []
  await assert.rejects(async () => {
    for await (const chunk of adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] })) out.push(chunk)
  })
  assert.ok(out.some(chunk => chunk.text === 'partial'), 'the delivered content was lost')
  assert.equal(requests.length, 1, 'a retry was opened after output had been delivered')
})

await check('a 5xx rotates without a cooldown', async () => {
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
      return row === undefined ? null : { entry: row, credential: { access_token: `t-${row.id}` } }
    },
    updateModelRateLimit: async (id, model, at) => { cooldowns.push({ id, model, at }) },
  }
  const { adapter, requests } = harness({
    pool,
    responses: [
      () => new Response('upstream exploded', { status: 503 }),
      () => eventResponse([
        { event: 'message', data: { choices: [{ delta: { content: 'from b' } }] } },
        { event: 'done', data: { finish_reason: 'stop' } },
      ]),
    ],
  })
  await collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(requests.length, 2, 'a 5xx did not rotate')
  assert.equal(cooldowns.length, 0, 'a transient fault recorded a cooldown')
})

await check('rotation is bounded', async () => {
  const accounts = Array.from({ length: MAX_ATTEMPTS + 2 }, (_, index) => ({ id: `a${index}`, provider: PROVIDER_ID, enabled: true }))
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
    responses: Array.from({ length: MAX_ATTEMPTS }, () => () => new Response('{"code":4008}', { status: 400 })),
  })
  await assert.rejects(
    () => collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] })),
    error => error.code === ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED,
  )
  assert.equal(requests.length, MAX_ATTEMPTS)
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`004-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`004-test: ${passed} checks passed — the TRAE adapter meets its contract.\n`)
process.stdout.write('Scope reminder: scripted fetch only. Host wiring is SRC-016; a real account is SRC-019.\n')
