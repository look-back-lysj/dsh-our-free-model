/**
 * SRC-007 gate: the Raccoon adapter matches its frozen contract.
 *
 * Run: `node scripts/source-rewrite/007-test.mjs`
 *
 * The cases that carry weight:
 *
 * - **Thinking is a switch**, carried in `extra_body`, not a level menu.
 * - **A 402 arrives as a status and as an in-band code**; both must classify as quota.
 * - **Only a spent balance rotates**, so a 429 does not burn another account.
 * - **A refresh that omits the new refresh token keeps the old one.** Overwriting it with
 *   nothing strands the account at the next expiry, hours later, with no visible cause.
 * - **An empty answer is an error, never a success.**
 *
 * @module scripts/source-rewrite/007-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyHttp,
  classifyInBand,
  DEFAULT_THINKING,
  FALLBACK_MODELS,
  IMAGE_CAPABILITY_OVERRIDES,
  isQuotaError,
  isRefreshable,
  PROVIDER_ID,
  recordsCooldown,
  REFRESH_WINDOW_MS,
  resolveImageCapability,
  shouldRotate,
  supportsImage,
  THINKING_OFF,
  THINKING_ON,
  THINKING_STATES,
  thinkingType,
} from '../../src/accounts/providers/raccoon/product.js'
import { createRaccoonAdapter } from '../../src/accounts/providers/raccoon/adapter.js'
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

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

function harness({ responses, secrets = { RACCOON_ACCESS_TOKEN: '{"access_token":"tok"}' }, pool }) {
  let index = 0
  const requests = []
  const store = new Map(Object.entries(secrets))
  const adapter = createRaccoonAdapter({
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

process.stdout.write('SRC-007 Raccoon adapter gate\n\n')

// ── 1. catalog ─────────────────────────────────────────────────────────────
await check('the static catalog is the frozen six rows, in order', () => {
  const contracts = JSON.parse(fs.readFileSync(
    new URL('../../工程控制/ORIGIN-REWRITE-01/contracts/baseline-20261122/channel-contracts.json', import.meta.url),
    'utf8',
  ))
  const frozen = contracts.products.find(row => row.id === PROVIDER_ID)
  assert.deepEqual(FALLBACK_MODELS.map(row => row.id), frozen.modelIds)
})

await check('every static row declares image support, context window and output cap', () => {
  for (const row of FALLBACK_MODELS) {
    assert.equal(row.supportsImage, true, `${row.id} lost its image capability`)
    assert.ok(row.contextWindow > 0)
    assert.ok(row.maxTokens > 0)
  }
})

await check('the two image overrides are exactly the documented pair', () => {
  assert.deepEqual([...IMAGE_CAPABILITY_OVERRIDES], ['sn-deepseek-v4-1-flash', 'sn-glm-5-3-flash'])
})

await check('image capability honours the override before the tags', () => {
  assert.equal(supportsImage('sn-deepseek-v4-1-flash', []), true, 'an override was ignored when the tag was absent')
  assert.equal(supportsImage('sn-glm-5-3-flash', undefined), true)
  assert.equal(supportsImage('some-model', ['vision']), true)
  assert.equal(supportsImage('some-model', ['text']), false)
  assert.equal(resolveImageCapability({ id: 'sn-kimi-k3' }), true, 'the static table was not consulted as a last resort')
})

// ── 2. thinking is a switch ────────────────────────────────────────────────
await check('thinking is a two-state switch, not a level menu', () => {
  assert.deepEqual([...THINKING_STATES], ['on', 'off'])
  assert.equal(DEFAULT_THINKING, THINKING_ON)
  assert.equal(thinkingType(THINKING_ON), 'enabled')
  assert.equal(thinkingType(THINKING_OFF), 'disabled')
  assert.equal(thinkingType(undefined), 'enabled', 'an absent request must default to thinking on')
  assert.equal(thinkingType('medium'), 'enabled', 'a level was accepted as a switch value')
})

await check('the switch rides extra_body, not a top-level field', async () => {
  const { adapter, requests } = harness({
    responses: [() => sseResponse([delta({ content: 'hi' }, 'stop')])],
  })
  await collect(adapter.stream({ model: 'sn-kimi-k3', messages: [{ role: 'user', content: 'hi' }], thinking: THINKING_OFF }))
  const body = JSON.parse(requests[0].init.body)
  assert.equal(body.extra_body.thinking.type, 'disabled')
  assert.ok(!('thinking' in body), 'a top-level thinking field was sent; the provider reads extra_body')
  assert.ok(!('reasoning_effort' in body), 'a level field was sent for a switch-only provider')
})

// ── 3. quota classification ────────────────────────────────────────────────
await check('a 402 is detected as a status and as an in-band code', () => {
  assert.equal(isQuotaError({ error: { code: 402 } }), true)
  assert.equal(isQuotaError({ code: '402' }), true)
  assert.equal(isQuotaError({ message: '积分不足' }), true)
  assert.equal(isQuotaError({ message: 'the balance of payments' }), false)
  assert.equal(classifyHttp(402, ''), 'quota-exceeded')
  assert.equal(classifyHttp(400, JSON.stringify({ code: '402' })), 'quota-exceeded')
})

await check('only a spent balance rotates and cools down', () => {
  assert.equal(shouldRotate('quota-exceeded'), true)
  assert.equal(shouldRotate('soft-rate'), false, 'a 429 would burn another account allowance')
  assert.equal(recordsCooldown('quota-exceeded'), true)
  assert.equal(recordsCooldown('soft-rate'), false)
})

await check('classification covers the status ladder', () => {
  assert.equal(classifyHttp(401, ''), 'auth')
  assert.equal(classifyHttp(429, ''), 'soft-rate')
  assert.equal(classifyHttp(503, ''), 'server')
  assert.equal(classifyHttp(400, 'bad'), 'client')
  assert.equal(classifyHttp(200, ''), 'none')
  assert.equal(classifyInBand('余额不足'), 'quota-exceeded')
  assert.equal(classifyInBand('other'), 'server')
})

// ── 4. refresh token handling ──────────────────────────────────────────────
await check('refreshability requires a non-empty refresh token', () => {
  assert.equal(isRefreshable({ refresh_token: 'r' }), true)
  assert.equal(isRefreshable({ refresh_token: '' }), false)
  assert.equal(isRefreshable({}), false)
  assert.equal(isRefreshable(null), false)
  assert.equal(REFRESH_WINDOW_MS, 300_000)
})

await check('a refresh that omits the new refresh token keeps the old one', async () => {
  const { adapter, store } = harness({
    responses: [
      () => new Response(JSON.stringify({ data: { access_token: 'new-access' } }), { status: 200 }),
    ],
    secrets: { RACCOON_ACCESS_TOKEN: JSON.stringify({ access_token: 'old', refresh_token: 'keep-me' }) },
  })
  await adapter.refresh({})
  const stored = JSON.parse(store.get('RACCOON_ACCESS_TOKEN'))
  assert.equal(stored.access_token, 'new-access')
  assert.equal(stored.refresh_token, 'keep-me', 'the refresh token was overwritten with nothing')
})

await check('a refresh that returns a new refresh token stores it', async () => {
  const { adapter, store } = harness({
    responses: [
      () => new Response(JSON.stringify({ data: { access_token: 'new-access', refresh_token: 'rotated' } }), { status: 200 }),
    ],
    secrets: { RACCOON_ACCESS_TOKEN: JSON.stringify({ access_token: 'old', refresh_token: 'old-refresh' }) },
  })
  await adapter.refresh({})
  const stored = JSON.parse(store.get('RACCOON_ACCESS_TOKEN'))
  assert.equal(stored.refresh_token, 'rotated')
})

await check('a 200003 refresh response means log in again, not retry', async () => {
  const { adapter } = harness({
    responses: [
      () => new Response(JSON.stringify({ code: '200003', message: 'please log in again' }), { status: 200 }),
    ],
    secrets: { RACCOON_ACCESS_TOKEN: JSON.stringify({ access_token: 'old', refresh_token: 'r' }) },
  })
  await assert.rejects(() => adapter.refresh({}), error => error.code === ACCOUNT_ERROR_CODES.AUTH)
})

await check('a credential without a refresh token refuses to refresh', async () => {
  const { adapter } = harness({
    responses: [],
    secrets: { RACCOON_ACCESS_TOKEN: JSON.stringify({ access_token: 'only' }) },
  })
  await assert.rejects(() => adapter.refresh({}), /no refresh token/)
})

// ── 5. streaming ───────────────────────────────────────────────────────────
await check('the request carries the provider client headers', async () => {
  const { adapter, requests } = harness({
    responses: [() => sseResponse([delta({ content: 'hi' }, 'stop')])],
    secrets: { RACCOON_ACCESS_TOKEN: JSON.stringify({ access_token: 'tok', org_code: 'org-9' }) },
  })
  await collect(adapter.stream({ model: 'sn-kimi-k3', messages: [{ role: 'user', content: 'hi' }] }))
  const { url, init } = requests[0]
  assert.ok(url.endsWith('/api/web/llm/v2/chat/completions'))
  assert.equal(init.headers['X-Raccoon-Language'], 'zh')
  assert.equal(init.headers['X-Client-Platform'], 'desktop')
  assert.equal(init.headers['X-Org-Code'], 'org-9')
  assert.equal(init.headers.authorization, 'Bearer tok')
})

await check('an empty answer is an error, not a silent success', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([delta({}, 'stop')])],
  })
  const chunks = await collect(adapter.stream({ model: 'sn-kimi-k3', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(chunks.at(-1).empty, true, 'an empty answer was reported as a normal completion')
})

await check('usage and finish flow through, with cache reads separated', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([
      delta({ content: 'answer' }, 'stop'),
      { choices: [{ delta: {} }], usage: { prompt_tokens: 30, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 10 } } },
    ])],
  })
  const chunks = await collect(adapter.stream({ model: 'sn-kimi-k3', messages: [{ role: 'user', content: 'hi' }] }))
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.equal(usage.inputTokens, 20)
  assert.equal(usage.cacheReadTokens, 10)
  assert.equal(usage.outputTokens, 6)
})

await check('a truncated stream is reported', async () => {
  const { adapter } = harness({
    responses: [() => sseResponse([delta({ content: 'partial' })], { terminate: false })],
  })
  const chunks = await collect(adapter.stream({ model: 'sn-kimi-k3', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(chunks.at(-1).truncated, true)
})

await check('a quota failure rotates to the next account', async () => {
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
      return row === undefined ? null : { entry: row, credential: { access_token: `token-${row.id}` } }
    },
    updateModelRateLimit: async (id, model, at) => { cooldowns.push({ id, model, at }) },
  }
  const { adapter, requests } = harness({
    responses: [
      () => new Response(JSON.stringify({ code: '402', message: '余额不足' }), { status: 402 }),
      () => sseResponse([delta({ content: 'from b' }, 'stop')]),
    ],
    pool,
  })
  const chunks = await collect(adapter.stream({ model: 'sn-kimi-k3', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(requests.length, 2, 'a spent balance did not rotate')
  assert.equal(requests[1].init.headers.authorization, 'Bearer token-b')
  assert.ok(chunks.some(chunk => chunk.text === 'from b'))
  assert.equal(cooldowns.length, 1)
  assert.ok(cooldowns[0].at > 1_000_000 + 3_600_000, 'a daily allowance cooled for less than a day')
})

await check('the balance endpoint reports exhaustion rather than a silent zero', async () => {
  const { adapter } = harness({
    responses: [
      () => new Response(JSON.stringify({ code: '402', message: '积分不足' }), { status: 200 }),
    ],
  })
  const result = await adapter.balance()
  assert.equal(result.exhausted, true)
  assert.equal(result.points, 0)
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`007-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`007-test: ${passed} checks passed — the Raccoon adapter meets its contract.\n`)
process.stdout.write('Scope reminder: scripted fetch only. Host wiring is SRC-016; a real account is SRC-019.\n')
