/**
 * SRC-003 gate: the LobsterAI adapter matches its frozen contract.
 *
 * Run: `node scripts/source-rewrite/003-test.mjs`
 *
 * ## What this exercises
 *
 * The classifier is run directly against the priority cases the contract names, and the
 * adapter is driven through a scripted `fetch` so the rotation, cooldown and stream
 * behaviour are observed rather than asserted. No network, no credentials: the credential
 * store is an in-memory map and every response is fabricated.
 *
 * ## The cases that matter most
 *
 * - **400 + 积分不足 must not be "client"**. The provider reports an exhausted allowance
 *   with a 400, so a status-first classifier rotates forever.
 * - **A 5xx must rotate without a cooldown badge**. The badge means "this model is
 *   limited", and recording it for a transient fault hides working capacity.
 * - **An in-band error under HTTP 200 must still classify**, and must not be retried once
 *   output has been delivered.
 * - **A stream with no finish signal must be reported as truncated**, never as an empty
 *   success.
 * - **Usage is only reported when the provider reported it**; a missing usage frame must
 *   not become zero tokens.
 *
 * @module scripts/source-rewrite/003-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyHttp,
  classifyInBand,
  isCredentialTerminal,
  MAX_ATTEMPTS,
  recordsCooldown,
  shouldRotate,
} from '../../src/accounts/providers/lobsterai/errors.js'
import {
  CLIENT_HEADERS,
  FALLBACK_MODELS,
  HOSTS,
  PATHS,
  PROVIDER_ID,
  resolveModels,
} from '../../src/accounts/providers/lobsterai/product.js'
import { createLobsteraiAdapter } from '../../src/accounts/providers/lobsterai/adapter.js'
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

/** Build an SSE response from a list of payload objects, terminated with [DONE]. */
function sseResponse(frames, { terminate = true } = {}) {
  const body = frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('')
  return new Response(terminate ? `${body}data: [DONE]\n\n` : body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** A chunk delta in the provider's shape. */
const delta = (payload, finish) => ({
  choices: [{ delta: payload, ...(finish === undefined ? {} : { finish_reason: finish }) }],
})

/**
 * Build an adapter over a scripted fetch.
 *
 * @param {object} spec
 * @param {Array<() => Response | Promise<Response>>} spec.responses - one per attempt
 * @param {object} [spec.pool] - account pool double
 * @param {Record<string, string>} [spec.secrets]
 */
function harness({ responses, pool, secrets = {} }) {
  let index = 0
  const requests = []
  const store = new Map(Object.entries(secrets))
  const cooldowns = []
  const poolDouble = pool === undefined ? undefined : {
    getAvailableAccount: pool.getAvailableAccount,
    updateModelRateLimit: async (id, model, at) => {
      cooldowns.push({ id, model, at })
      if (pool.updateModelRateLimit !== undefined) await pool.updateModelRateLimit(id, model, at)
    },
  }
  const adapter = createLobsteraiAdapter({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      const make = responses[index]
      index += 1
      if (make === undefined) throw new Error(`ran out of scripted responses (attempt ${index})`)
      return make()
    },
    credentials: {
      resolve: async ref => {
        const value = store.get(ref)
        return value === undefined ? undefined : { value }
      },
      set: async (ref, value) => { store.set(ref, value) },
    },
    credentialRef: ref => ref,
    accountPool: poolDouble,
    now: () => 1_000_000,
    warn: () => {},
  })
  return { adapter, requests, cooldowns, store }
}

/** Collect a stream to completion. */
async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

process.stdout.write('SRC-003 LobsterAI adapter gate\n\n')

// ── 1. classifier priority ─────────────────────────────────────────────────
await check('402 is hard-credit before any keyword', () => {
  assert.equal(classifyHttp(402, 'rate limit'), 'hard-credit')
})

await check('400 with an exhausted-allowance body is hard-credit, not client', () => {
  // The real failure mode: status-first classification makes this retryable forever.
  assert.equal(classifyHttp(400, '{"msg":"积分不足"}'), 'hard-credit')
  assert.equal(classifyHttp(400, 'insufficient balance'), 'hard-credit')
})

await check('a banned account outranks a dead session', () => {
  assert.equal(classifyHttp(403, '账号存在异常 40100'), 'banned')
})

await check('a dead session is recognised', () => {
  assert.equal(classifyHttp(200, '40100'), 'session-dead')
  assert.equal(classifyHttp(200, 'token rejected'), 'session-dead')
})

await check('status-only branches map as the contract says', () => {
  assert.equal(classifyHttp(429, ''), 'soft-rate')
  assert.equal(classifyHttp(404, ''), 'not-found')
  assert.equal(classifyHttp(500, ''), 'server')
  assert.equal(classifyHttp(503, ''), 'server')
  assert.equal(classifyHttp(418, ''), 'client')
  assert.equal(classifyHttp(200, ''), 'none')
})

await check('ordinary prose is not mistaken for an error', () => {
  assert.equal(classifyHttp(200, 'here is how a quota system works'), 'none')
  assert.equal(classifyHttp(200, 'the balance of trade'), 'none')
})

await check('the in-band classifier defaults to rotate, not none', () => {
  assert.equal(classifyInBand('something odd happened'), 'client')
  assert.equal(classifyInBand('余额不足'), 'hard-credit')
})

await check('every non-clean kind rotates and only limited kinds cool down', () => {
  for (const kind of ['hard-credit', 'banned', 'session-dead', 'soft-rate', 'not-found', 'server', 'client']) {
    assert.equal(shouldRotate(kind), true, `${kind} must rotate`)
  }
  assert.equal(shouldRotate('none'), false)
  assert.equal(recordsCooldown('server'), false, 'a transient fault must not park the model')
  assert.equal(recordsCooldown('client'), false)
  assert.equal(recordsCooldown('session-dead'), false)
  for (const kind of ['hard-credit', 'soft-rate', 'not-found', 'banned']) {
    assert.equal(recordsCooldown(kind), true, `${kind} must record a cooldown`)
  }
})

await check('only a dead session is credential-terminal', () => {
  assert.equal(isCredentialTerminal('session-dead'), true)
  assert.equal(isCredentialTerminal('hard-credit'), false)
})

// ── 2. product table ───────────────────────────────────────────────────────
await check('the static catalog is the frozen 19 rows, in order', () => {
  const contracts = JSON.parse(fs.readFileSync(
    new URL('../../工程控制/ORIGIN-REWRITE-01/contracts/baseline-20261122/channel-contracts.json', import.meta.url),
    'utf8',
  ))
  const frozen = contracts.products.find(row => row.id === PROVIDER_ID)
  assert.equal(FALLBACK_MODELS.length, 19)
  assert.deepEqual(FALLBACK_MODELS.map(row => row.id), frozen.modelIds, 'the static table drifted from the frozen contract')
})

await check('the static table declares no image or effort capability', () => {
  for (const row of FALLBACK_MODELS) {
    assert.ok(!('supportsImage' in row), `${row.id} invents an image capability`)
    assert.ok(!('efforts' in row), `${row.id} invents an effort menu`)
  }
})

await check('the remote listing wins and only advertises what it declares', () => {
  const models = resolveModels([
    { id: 'deepseek-v4-flash', name: 'DeepSeek Flash', contextWindow: 200_000, supportsImage: true },
    { id: 'brand-new', name: 'Brand New', contextWindow: 64_000 },
  ])
  assert.equal(models.length, 2, 'a remote row was dropped')
  assert.equal(models[0].contextWindow, 200_000, 'the remote window was ignored')
  assert.equal(models[0].supportsImage, true)
  assert.ok(!('supportsImage' in models[1]), 'image support was invented for a row that did not declare it')
  assert.equal(models[1].contextWindow, 64_000)
})

await check('an empty or missing listing falls back to the static table', () => {
  assert.equal(resolveModels(undefined).length, 19)
  assert.equal(resolveModels([]).length, 19)
})

await check('client identity headers are the ones the provider expects', () => {
  assert.equal(CLIENT_HEADERS['X-LobsterAI-Client-Capabilities'], 'kimi-k3-agentic-v1,thinking-level-control-v1')
  assert.equal(CLIENT_HEADERS['User-Agent'], 'LobsterAI/0.1.0')
})

// ── 3. request shape ───────────────────────────────────────────────────────
await check('the request carries the documented path, headers and body keys', async () => {
  const { adapter, requests } = harness({
    responses: [() => sseResponse([delta({ content: 'hi' }, 'stop')])],
    secrets: { LOBSTERAI_ACCESS_TOKEN: '{"access_token":"tok"}' },
  })
  await collect(adapter.stream({
    model: 'glm-5',
    messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }],
    tools: [{ name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: {} } }],
    maxTokens: 128,
    temperature: 0.2,
  }))
  const { url, init } = requests[0]
  assert.equal(url, `${HOSTS.api}${PATHS.chat}`)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, 'Bearer tok')
  assert.equal(init.headers['X-LobsterAI-Client-Capabilities'], CLIENT_HEADERS['X-LobsterAI-Client-Capabilities'])
  const body = JSON.parse(init.body)
  assert.equal(body.model, 'glm-5')
  assert.equal(body.stream, true, 'streaming must be forced on; this provider only streams')
  assert.deepEqual(body.messages.map(row => row.role), ['system', 'user'], 'the system prompt was not hoisted to the front')
  assert.equal(body.max_tokens, 128)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.tools[0].type, 'function')
  assert.equal(body.tools[0].function.name, 'read')
  assert.ok(!('tool_choice' in body), 'tool_choice must not be emitted')
})

await check('an orphan tool result is dropped instead of sent', async () => {
  const { adapter, requests } = harness({
    responses: [() => sseResponse([delta({ content: 'ok' }, 'stop')])],
    secrets: { LOBSTERAI_ACCESS_TOKEN: '{"access_token":"tok"}' },
  })
  await collect(adapter.stream({
    model: 'glm-5',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'tool', toolCallId: 'missing-call', content: 'result' },
    ],
  }))
  const body = JSON.parse(requests[0].init.body)
  assert.equal(body.messages.length, 1, 'an unpaired tool result reached the wire, which the provider rejects')
})

await check('a paired tool call and result survive', async () => {
  const { adapter, requests } = harness({
    responses: [() => sseResponse([delta({ content: 'ok' }, 'stop')])],
    secrets: { LOBSTERAI_ACCESS_TOKEN: '{"access_token":"tok"}' },
  })
  await collect(adapter.stream({
    model: 'glm-5',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call-1', content: 'file body' },
    ],
  }))
  const body = JSON.parse(requests[0].init.body)
  assert.equal(body.messages.length, 3)
  assert.equal(body.messages[1].tool_calls[0].id, 'call-1')
  assert.equal(body.messages[2].tool_call_id, 'call-1')
})

// ── 4. streaming ───────────────────────────────────────────────────────────
await check('text, reasoning and usage map to their own chunk kinds', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([
      delta({ reasoning_content: 'thinking...' }),
      delta({ content: 'answer' }),
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } },
    ])],
    secrets: { LOBSTERAI_ACCESS_TOKEN: '{"access_token":"tok"}' },
  })
  const chunks = await collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }))
  const kinds = chunks.map(chunk => chunk.type)
  assert.ok(kinds.includes('reasoning-delta'), 'reasoning was not separated from answer text')
  assert.ok(kinds.includes('text-delta'))
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.ok(usage !== undefined, 'usage was dropped')
  assert.equal(usage.inputTokens, 8, 'cached tokens must be excluded from the input total')
  assert.equal(usage.cacheReadTokens, 2)
  assert.equal(usage.outputTokens, 4)
})

await check('a stream with no usage frame reports no usage at all', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([delta({ content: 'hi' }, 'stop')])],
    secrets: { LOBSTERAI_ACCESS_TOKEN: '{"access_token":"tok"}' },
  })
  const chunks = await collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }))
  assert.ok(!chunks.some(chunk => chunk.type === 'usage'), 'a missing usage frame became a zero-token report')
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.truncated, false)
})

await check('a tool call accumulates across deltas and is emitted once complete', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([
      delta({ tool_calls: [{ index: 0, id: 'call-9', function: { name: 'read', arguments: '{"pa' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])],
    secrets: { LOBSTERAI_ACCESS_TOKEN: '{"access_token":"tok"}' },
  })
  const chunks = await collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }))
  const call = chunks.find(chunk => chunk.type === 'tool-call')
  assert.ok(call !== undefined, 'no completed tool call was emitted')
  assert.equal(call.id, 'call-9')
  assert.equal(call.name, 'read')
  assert.equal(call.arguments, '{"path":"a"}')
  assert.equal(chunks.at(-1).finishReason, 'tool-calls')
})

await check('a stream that ends with no terminator is reported as truncated', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([delta({ content: 'partial answer' })], { terminate: false })],
    secrets: { LOBSTERAI_ACCESS_TOKEN: '{"access_token":"tok"}' },
  })
  const chunks = await collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }))
  const finish = chunks.at(-1)
  assert.equal(finish.truncated, true, 'a cut-off stream was reported as a normal stop')
})

await check('an empty stream is flagged rather than reported as a clean empty answer', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([delta({}, 'stop')])],
    secrets: { LOBSTERAI_ACCESS_TOKEN: '{"access_token":"tok"}' },
  })
  const chunks = await collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(chunks.at(-1).empty, true)
})

// ── 5. rotation and cooldown ───────────────────────────────────────────────
/** A pool double that hands out two accounts in order. */
function twoAccountPool() {
  const accounts = [
    { entry: { id: 'acct-a', provider: PROVIDER_ID, enabled: true }, credential: { access_token: 'token-a' } },
    { entry: { id: 'acct-b', provider: PROVIDER_ID, enabled: true }, credential: { access_token: 'token-b' } },
  ]
  let index = 0
  return {
    getAvailableAccount: async () => {
      const row = accounts[index]
      index += 1
      return row ?? null
    },
    updateModelRateLimit: async () => {},
  }
}

await check('an exhausted allowance rotates to the next account and records a cooldown', async () => {
  const pool = twoAccountPool()
  const { adapter, requests, cooldowns } = harness({
    responses: [
      () => new Response('{"msg":"积分不足"}', { status: 400 }),
      () => sseResponse([delta({ content: 'from b' }, 'stop')]),
    ],
    pool,
  })
  const chunks = await collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(requests.length, 2, 'the request was not retried on another account')
  assert.equal(requests[1].init.headers.authorization, 'Bearer token-b')
  assert.ok(chunks.some(chunk => chunk.text === 'from b'))
  assert.equal(cooldowns.length, 1, 'no cooldown was recorded for an exhausted allowance')
  assert.equal(cooldowns[0].id, 'acct-a')
  assert.equal(cooldowns[0].model, 'glm-5', 'the cooldown must be scoped to the model')
})

await check('a 5xx rotates without recording a cooldown', async () => {
  const pool = twoAccountPool()
  const { adapter, requests, cooldowns } = harness({
    responses: [
      () => new Response('upstream exploded', { status: 503 }),
      () => sseResponse([delta({ content: 'ok' }, 'stop')]),
    ],
    pool,
  })
  await collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(requests.length, 2, 'a 5xx did not rotate')
  assert.equal(cooldowns.length, 0, 'a transient fault recorded a cooldown and parked the model')
})

await check('rotation is bounded by the attempt cap and reports the real cause', async () => {
  // Give the pool more accounts than the cap so the cap, not the pool, is what stops it.
  const accounts = Array.from({ length: MAX_ATTEMPTS + 2 }, (_, index) => ({
    entry: { id: `acct-${index}`, provider: PROVIDER_ID, enabled: true },
    credential: { access_token: `token-${index}` },
  }))
  let next = 0
  const pool = {
    getAvailableAccount: async () => {
      const row = accounts[next]
      next += 1
      return row ?? null
    },
    updateModelRateLimit: async () => {},
  }
  const { adapter, requests } = harness({
    responses: Array.from({ length: MAX_ATTEMPTS }, () => () => new Response('{"msg":"积分不足"}', { status: 400 })),
    pool,
  })
  await assert.rejects(
    () => collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] })),
    error => error.code === ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED,
  )
  assert.equal(requests.length, MAX_ATTEMPTS, `made ${requests.length} requests, expected the cap of ${MAX_ATTEMPTS}`)
})

await check('rotation stops when the pool runs dry', async () => {
  const pool = twoAccountPool()
  const { adapter, requests } = harness({
    responses: Array.from({ length: MAX_ATTEMPTS }, () => () => new Response('{"msg":"积分不足"}', { status: 400 })),
    pool,
  })
  await assert.rejects(
    () => collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] })),
    error => error.code === ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED,
  )
  assert.equal(requests.length, 2, 'a two-account pool cannot make three requests')
})

await check('without a pool the error surfaces instead of retrying', async () => {
  const { adapter, requests } = harness({
    responses: [() => new Response('{"msg":"积分不足"}', { status: 400 })],
    secrets: { LOBSTERAI_ACCESS_TOKEN: '{"access_token":"tok"}' },
  })
  await assert.rejects(
    () => collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] })),
    error => error.code === ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED,
  )
  assert.equal(requests.length, 1, 'a single-credential setup retried with no alternative')
})

await check('a 401 refreshes once and retries without consuming a rotation slot', async () => {
  let refreshed = 0
  const store = new Map([['LOBSTERAI_ACCESS_TOKEN', JSON.stringify({ access_token: 'old', refresh_token: 'r1' })]])
  const adapter = createLobsteraiAdapter({
    fetch: async url => {
      if (String(url).endsWith(PATHS.refresh)) {
        refreshed += 1
        return new Response(JSON.stringify({ data: { access_token: 'new', refresh_token: 'r2' } }), { status: 200 })
      }
      if (refreshed === 0) return new Response('unauthorized', { status: 401 })
      return sseResponse([delta({ content: 'after refresh' }, 'stop')])
    },
    credentials: {
      resolve: async ref => (store.has(ref) ? { value: store.get(ref) } : undefined),
      set: async (ref, value) => { store.set(ref, value) },
    },
    credentialRef: ref => ref,
    now: () => 1_000_000,
  })
  const chunks = await collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(refreshed, 1, `refreshed ${refreshed} times`)
  assert.ok(chunks.some(chunk => chunk.text === 'after refresh'))
  const stored = JSON.parse(store.get('LOBSTERAI_ACCESS_TOKEN'))
  assert.equal(stored.access_token, 'new', 'the refreshed token was not persisted')
  assert.equal(stored.refresh_token, 'r2')
})

await check('a second 401 is surfaced as AUTH rather than refreshing again', async () => {
  const store = new Map([['LOBSTERAI_ACCESS_TOKEN', JSON.stringify({ access_token: 'old', refresh_token: 'r1' })]])
  const adapter = createLobsteraiAdapter({
    fetch: async url => {
      if (String(url).endsWith(PATHS.refresh)) {
        return new Response(JSON.stringify({ data: { access_token: 'still-bad' } }), { status: 200 })
      }
      return new Response('unauthorized', { status: 401 })
    },
    credentials: {
      resolve: async ref => (store.has(ref) ? { value: store.get(ref) } : undefined),
      set: async (ref, value) => { store.set(ref, value) },
    },
    credentialRef: ref => ref,
    now: () => 1_000_000,
  })
  await assert.rejects(
    () => collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] })),
    error => error.code === ACCOUNT_ERROR_CODES.AUTH,
  )
})

await check('an in-band error frame under HTTP 200 is classified, not treated as content', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([{ error: { message: '额度不足' } }], { terminate: false })],
    secrets: { LOBSTERAI_ACCESS_TOKEN: '{"access_token":"tok"}' },
  })
  // An in-band allowance error must arrive as QUOTA_EXCEEDED: reporting it as a generic
  // server error would make the harness retry an account that cannot succeed.
  await assert.rejects(
    () => collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] })),
    error => error.code === ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED,
  )
})

await check('a missing credential fails without attempting a request', async () => {
  const { adapter, requests } = harness({ responses: [] })
  await assert.rejects(
    () => collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] })),
    error => error.code === ACCOUNT_ERROR_CODES.MISSING_CREDENTIAL,
  )
  assert.equal(requests.length, 0)
})

await check('an abort during the request is reported as aborted, not as a transport fault', async () => {
  const controller = new AbortController()
  const adapter = createLobsteraiAdapter({
    fetch: async () => {
      controller.abort()
      throw new Error('socket closed')
    },
    credentials: { resolve: async () => ({ value: '{"access_token":"tok"}' }), set: async () => {} },
    credentialRef: ref => ref,
    now: () => 1_000_000,
  })
  await assert.rejects(
    () => collect(adapter.stream({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }], signal: controller.signal })),
    error => error.code === ACCOUNT_ERROR_CODES.ABORTED,
  )
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`003-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`003-test: ${passed} checks passed — the LobsterAI adapter meets its contract.\n`)
process.stdout.write('Scope reminder: scripted fetch only. Host wiring is SRC-016; a real account is SRC-019.\n')
