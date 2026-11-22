/**
 * SRC-005 gate: the Cline adapter matches its frozen contract.
 *
 * Run: `node scripts/source-rewrite/005-test.mjs`
 *
 * The cases that carry weight:
 *
 * - **A 403 region block must not be treated as auth.** Refreshing cannot fix it, and
 *   reporting AUTH sends the user to a login that changes nothing.
 * - **A 402 rotates but records no cooldown.** The account is out of credit, but the model
 *   is not rate-limited, so parking the model would hide it from every other account.
 * - **Only a 429 cools down**, and its reset time comes from the header first.
 * - **The catalog merge keeps curated metadata** and lets a retired model disappear.
 * - **"No usage frame" is recorded as absence**, never as zero tokens.
 *
 * @module scripts/source-rewrite/005-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyHttp,
  classifyInBand,
  DEFAULT_REASONING_EFFORT,
  FALLBACK_MODELS,
  isFreeModel,
  isRegionForbidden,
  isRotatableFailure,
  mapErrorCode,
  MAX_OUTPUT_TOKENS,
  mergeClineModels,
  parseResetAt,
  PROVIDER_ID,
  REASONING_EFFORTS,
  recordsCooldown,
  shouldRotate,
} from '../../src/accounts/providers/cline/product.js'
import { createClineAdapter, HISTORY_LIMIT } from '../../src/accounts/providers/cline/adapter.js'
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

/** Build an SSE response terminated with [DONE]. */
function sseResponse(frames, { terminate = true } = {}) {
  const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new Response(terminate ? `${body}data: [DONE]\n\n` : body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const delta = (payload, finish) => ({
  choices: [{ delta: payload, ...(finish === undefined ? {} : { finish_reason: finish }) }],
})

/** An adapter over a scripted fetch. */
function harness({ responses, pool, secrets = {} }) {
  let index = 0
  const requests = []
  const cooldowns = []
  const store = new Map(Object.entries(secrets))
  const poolDouble = pool === undefined ? undefined : {
    getAvailableAccount: pool.getAvailableAccount,
    updateModelRateLimit: async (id, model, at) => {
      cooldowns.push({ id, model, at })
    },
  }
  const adapter = createClineAdapter({
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
    accountPool: poolDouble,
    now: () => 1_000_000,
    warn: () => {},
  })
  return { adapter, requests, cooldowns }
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

process.stdout.write('SRC-005 Cline adapter gate\n\n')

// ── 1. region block is not auth ────────────────────────────────────────────
await check('a 403 region block is recognised and only for 403', () => {
  assert.equal(isRegionForbidden(403, 'this service is not available in your region'), true)
  assert.equal(isRegionForbidden(401, 'not available in your region'), false,
    'a 401 with similar wording must stay an auth problem so the refresh can run')
  assert.equal(isRegionForbidden(403, 'forbidden'), false)
})

await check('a region block classifies as permission, not auth', () => {
  assert.equal(classifyHttp(403, 'not available in your region'), 'region-forbidden')
  assert.equal(mapErrorCode(403, 'not available in your region', 'region-forbidden'), 'PERMISSION_DENIED')
  assert.notEqual(mapErrorCode(403, 'not available in your region', 'region-forbidden'), ACCOUNT_ERROR_CODES.AUTH,
    'reporting a region block as AUTH sends the user to a login that cannot help')
})

await check('a region block does not rotate or cool down', () => {
  assert.equal(shouldRotate('region-forbidden'), false)
  assert.equal(recordsCooldown(403), false)
})

// ── 2. rotation and cooldown scoping ───────────────────────────────────────
await check('429 and 402 rotate; quota wording rotates', () => {
  assert.equal(isRotatableFailure(429, ''), true)
  assert.equal(isRotatableFailure(402, ''), true)
  assert.equal(isRotatableFailure(400, '积分不足'), true)
  assert.equal(isRotatableFailure(400, 'malformed field x'), false)
})

await check('only a 429 records a cooldown', () => {
  assert.equal(recordsCooldown(429), true)
  assert.equal(recordsCooldown(402), false, 'a 402 parks the model for every other account')
})

await check('a 402 rotates to the next account without a cooldown', async () => {
  const accounts = [
    { entry: { id: 'a', provider: PROVIDER_ID, enabled: true }, credential: { access_token: 'ta' } },
    { entry: { id: 'b', provider: PROVIDER_ID, enabled: true }, credential: { access_token: 'tb' } },
  ]
  let next = 0
  const { adapter, requests, cooldowns } = harness({
    responses: [
      () => new Response('payment required', { status: 402 }),
      () => sseResponse([delta({ content: 'from b' }, 'stop')]),
    ],
    pool: {
      getAvailableAccount: async () => accounts[next++],
    },
  })
  const chunks = await collect(adapter.stream({ model: 'cline-free/mimo-v2.6-flash', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(requests.length, 2)
  assert.equal(requests[1].init.headers.authorization, 'Bearer tb')
  assert.ok(chunks.some(chunk => chunk.text === 'from b'))
  assert.equal(cooldowns.length, 0, 'a 402 recorded a cooldown and hid the model from other accounts')
})

await check('a 429 rotates and records a cooldown from the header', async () => {
  const accounts = [
    { entry: { id: 'a', provider: PROVIDER_ID, enabled: true }, credential: { access_token: 'ta' } },
    { entry: { id: 'b', provider: PROVIDER_ID, enabled: true }, credential: { access_token: 'tb' } },
  ]
  let next = 0
  const { adapter, cooldowns } = harness({
    responses: [
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
      () => sseResponse([delta({ content: 'ok' }, 'stop')]),
    ],
    pool: { getAvailableAccount: async () => accounts[next++] },
  })
  await collect(adapter.stream({ model: 'stealth/space-bunny-alpha', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(cooldowns.length, 1, 'a 429 recorded no cooldown')
  assert.equal(cooldowns[0].id, 'a')
})

await check('reset time prefers the header, then text, then an absolute stamp', () => {
  const now = 1_000_000
  assert.equal(parseResetAt({ headers: { get: () => '60' }, body: '' }, now), now + 60_000)
  assert.equal(parseResetAt({ headers: { get: () => null }, body: 'Try again in 19h 39m' }, now), now + (19 * 3_600_000) + (39 * 60_000))
  const stamp = '2026-11-22T10:00:00Z'
  assert.equal(parseResetAt({ headers: { get: () => null }, body: `resets at ${stamp}` }, now), Date.parse(stamp))
  assert.equal(parseResetAt({ headers: { get: () => null }, body: 'no hint' }, now), now + 3_600_000)
})

// ── 3. catalog merge ───────────────────────────────────────────────────────
await check('the curated table is the frozen three rows, in order', () => {
  const contracts = JSON.parse(fs.readFileSync(
    new URL('../../工程控制/ORIGIN-REWRITE-01/contracts/baseline-20261122/channel-contracts.json', import.meta.url),
    'utf8',
  ))
  const frozen = contracts.products.find(row => row.id === PROVIDER_ID)
  assert.deepEqual(FALLBACK_MODELS.map(row => row.id), frozen.modelIds)
})

await check('a retired model disappears when the remote no longer lists it', () => {
  const models = mergeClineModels({
    remoteFreeIds: ['cline-free/mimo-v2.6-flash'],
    remoteRecommended: [],
    remoteAllIds: ['cline-free/mimo-v2.6-flash'],
  })
  assert.deepEqual(models.map(row => row.id), ['cline-free/mimo-v2.6-flash'],
    'a curated row the remote dropped was kept anyway')
})

await check('the curated table is used in full when the remote says nothing', () => {
  const models = mergeClineModels({})
  assert.equal(models.length, 3)
  assert.deepEqual(models.map(row => row.id), FALLBACK_MODELS.map(row => row.id))
})

await check('curated metadata survives the merge', () => {
  const models = mergeClineModels({
    remoteFreeIds: ['stealth/space-bunny-alpha'],
    remoteAllIds: ['stealth/space-bunny-alpha'],
  })
  const row = models.find(model => model.id === 'stealth/space-bunny-alpha')
  assert.equal(row.contextWindow, 1_000_000, 'the curated window was replaced by a guess')
  assert.equal(row.maxTokens, 524_288)
  assert.equal(row.supportsImage, true)
})

await check('remote-only ids are added after the curated ones', () => {
  const models = mergeClineModels({
    remoteFreeIds: ['stealth/space-bunny-alpha'],
    remoteAllIds: ['stealth/space-bunny-alpha', 'brand/new-model'],
  })
  assert.deepEqual(models.map(row => row.id), ['stealth/space-bunny-alpha', 'brand/new-model'])
})

await check('models.dev fills gaps but never overrides', () => {
  const models = mergeClineModels({
    remoteAllIds: ['brand/new-model', 'stealth/space-bunny-alpha'],
    modelsDev: [
      { id: 'brand/new-model', name: 'New Model', contextWindow: 200_000, supportsImage: true },
      { id: 'stealth/space-bunny-alpha', name: 'Wrong Name', contextWindow: 1 },
    ],
  })
  const added = models.find(row => row.id === 'brand/new-model')
  assert.equal(added.name, 'New Model')
  assert.equal(added.contextWindow, 200_000)
  const curated = models.find(row => row.id === 'stealth/space-bunny-alpha')
  assert.equal(curated.name, 'Space Bunny Alpha', 'models.dev overrode a curated name')
  assert.equal(curated.contextWindow, 1_000_000, 'models.dev overrode a curated window')
})

await check('models.dev may append an id nothing else knew about', () => {
  const models = mergeClineModels({
    remoteAllIds: ['brand/new-model'],
    modelsDev: [{ id: 'only-in-models-dev', name: 'Only Here', contextWindow: 32_000 }],
  })
  const added = models.find(row => row.id === 'only-in-models-dev')
  assert.ok(added !== undefined, 'a models.dev-only id was dropped')
  assert.equal(added.name, 'Only Here')
})

await check('free detection unions every signal', () => {
  assert.equal(isFreeModel('anything', true), true, 'the remote free set was ignored')
  assert.equal(isFreeModel('x:free'), true)
  assert.equal(isFreeModel('cline-free/x'), true)
  assert.equal(isFreeModel('stealth/space-bunny-alpha'), true, 'the curated isFree flag was ignored')
  assert.equal(isFreeModel('paid/model'), false)
})

// ── 4. request shape ───────────────────────────────────────────────────────
await check('the request carries the documented path, headers and body', async () => {
  const { adapter, requests } = harness({
    responses: [() => sseResponse([delta({ content: 'hi' }, 'stop')])],
    secrets: { CLINE_ACCESS_TOKEN: '{"access_token":"workos:jwt"}' },
  })
  await collect(adapter.stream({
    model: 'cline-free/mimo-v2.6-flash',
    messages: [{ role: 'system', content: 'brief' }, { role: 'user', content: 'hi' }],
    maxTokens: 100,
    reasoningEffort: 'high',
  }))
  const { url, init } = requests[0]
  assert.ok(url.endsWith('/api/v1/chat/completions'))
  assert.equal(init.headers['HTTP-Referer'], 'https://cline.bot')
  assert.equal(init.headers['X-Title'], 'Cline')
  assert.equal(init.headers['X-IS-MULTIROOT'], 'false')
  assert.equal(init.headers['X-CLIENT-TYPE'], 'cline-sdk')
  assert.equal(init.headers.authorization, 'Bearer workos:jwt')
  const body = JSON.parse(init.body)
  assert.equal(body.stream, true)
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.max_tokens, 100)
  assert.deepEqual(body.messages.map(row => row.role), ['system', 'user'])
})

await check('the reasoning effort menu and default are the frozen ones', () => {
  assert.deepEqual([...REASONING_EFFORTS], ['none', 'low', 'medium', 'high', 'max'])
  assert.equal(DEFAULT_REASONING_EFFORT, 'high')
  assert.equal(MAX_OUTPUT_TOKENS, 943_718)
})

// ── 5. streaming and the local request log ─────────────────────────────────
await check('usage is captured and cached tokens excluded from the input total', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([
      delta({ content: 'answer' }, 'stop'),
      { choices: [{ delta: {} }], usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 } } },
    ])],
    secrets: { CLINE_ACCESS_TOKEN: '{"access_token":"t"}' },
  })
  const chunks = await collect(adapter.stream({ model: 'cline-free/mimo-v2.6-flash', messages: [{ role: 'user', content: 'hi' }] }))
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.equal(usage.inputTokens, 12)
  assert.equal(usage.cacheReadTokens, 8)
  assert.equal(usage.outputTokens, 5)
})

await check('the request log records absence of usage as absence, not zero', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([delta({ content: 'hi' }, 'stop')])],
    secrets: { CLINE_ACCESS_TOKEN: '{"access_token":"t"}' },
  })
  await collect(adapter.stream({ model: 'cline-free/mimo-v2.6-flash', messages: [{ role: 'user', content: 'hi' }] }))
  const log = adapter.requestLogSnapshot()
  assert.equal(log.length, 1)
  assert.equal(log[0].usageReported, false, 'a missing usage frame was recorded as zero tokens')
  assert.equal(log[0].inputTokens, undefined)
  assert.equal(log[0].model, 'cline-free/mimo-v2.6-flash')
  assert.equal(typeof log[0].latencyMs, 'number')
})

await check('the request log records usage when it is reported', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([
      delta({ content: 'hi' }, 'stop'),
      { choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ])],
    secrets: { CLINE_ACCESS_TOKEN: '{"access_token":"t"}' },
  })
  await collect(adapter.stream({ model: 'cline-free/mimo-v2.6-flash', messages: [{ role: 'user', content: 'hi' }] }))
  const log = adapter.requestLogSnapshot()
  assert.equal(log[0].usageReported, true)
  assert.equal(log[0].inputTokens, 3)
  assert.equal(log[0].outputTokens, 2)
})

await check('the request log is capped', async () => {
  const { adapter } = harness({
    responses: Array.from({ length: HISTORY_LIMIT + 5 }, () => () => sseResponse([delta({ content: 'x' }, 'stop')])),
    secrets: { CLINE_ACCESS_TOKEN: '{"access_token":"t"}' },
  })
  for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
    await collect(adapter.stream({ model: 'cline-free/mimo-v2.6-flash', messages: [{ role: 'user', content: 'hi' }] }))
  }
  assert.equal(adapter.requestLogSnapshot().length, HISTORY_LIMIT)
})

await check('plan usage is a separate call and a separate record', async () => {
  const { adapter, requests } = harness({
    responses: [() => new Response(JSON.stringify({
      success: true,
      data: { limits: [{ type: 'five_hour', percentUsed: 12, resetsAt: '2026-11-22T12:00:00Z' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })],
    secrets: { CLINE_ACCESS_TOKEN: '{"access_token":"t"}' },
  })
  const usage = await adapter.planUsage()
  assert.equal(requests[0].url, 'https://api.cline.bot/api/v1/users/me/plan/usage-limits')
  assert.deepEqual(usage, [{ window: 'five_hour', percentUsed: 12, resetsAt: '2026-11-22T12:00:00Z' }])
  assert.equal(adapter.requestLogSnapshot().length, 0, 'a usage query was written into the request log')
})

await check('a truncated stream is reported, not passed off as a clean stop', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([delta({ content: 'partial' })], { terminate: false })],
    secrets: { CLINE_ACCESS_TOKEN: '{"access_token":"t"}' },
  })
  const chunks = await collect(adapter.stream({ model: 'cline-free/mimo-v2.6-flash', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(chunks.at(-1).truncated, true)
})

await check('an in-band quota error is classified as quota, not server', () => {
  assert.equal(classifyInBand('insufficient credit'), 'quota-exceeded')
  assert.equal(classifyInBand('something else broke'), 'server')
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`005-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`005-test: ${passed} checks passed — the Cline adapter meets its contract.\n`)
process.stdout.write('Scope reminder: scripted fetch only. Host wiring is SRC-016; a real account is SRC-019.\n')
