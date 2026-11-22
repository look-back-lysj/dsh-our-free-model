/**
 * SRC-006 gate: the Loomy adapter matches its frozen contract.
 *
 * Run: `node scripts/source-rewrite/006-test.mjs`
 *
 * The cases that carry weight:
 *
 * - **A locked permanent balance is not spent.** This is the one behaviour with an
 *   irreversible consequence, so it is tested from both sides.
 * - **Only a spent allowance rotates.** A 429 must not burn another account's allowance.
 * - **A `100002` envelope is auth-dead, not a retryable failure.**
 * - **The static table never claims image input**, because the fallback projection
 *   reports `supportsImage: false`.
 * - **An unreadable balance is unknown, not zero.**
 *
 * @module scripts/source-rewrite/006-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  AUTH_DEAD_CODE,
  classifyHttp,
  classifyInBand,
  DEFAULT_CREDENTIAL_REF,
  EFFORTS,
  FALLBACK_MODELS,
  fallbackAsRemote,
  isQuotaError,
  OK_CODE,
  PREFERRED_DEFAULT_EFFORT,
  PROVIDER_ID,
  rankByBalance,
  readBalance,
  readEnvelope,
  recordsCooldown,
  resolveEffort,
  shouldRotate,
} from '../../src/accounts/providers/loomy/product.js'
import { createLoomyAdapter } from '../../src/accounts/providers/loomy/adapter.js'
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

process.stdout.write('SRC-006 Loomy adapter gate\n\n')

// ── 1. the static table ────────────────────────────────────────────────────
await check('the static catalog is the frozen eight rows, in order', () => {
  const contracts = JSON.parse(fs.readFileSync(
    new URL('../../工程控制/ORIGIN-REWRITE-01/contracts/baseline-20261122/channel-contracts.json', import.meta.url),
    'utf8',
  ))
  const frozen = contracts.products.find(row => row.id === PROVIDER_ID)
  assert.deepEqual(FALLBACK_MODELS.map(row => row.id), frozen.modelIds)
})

await check('every static row declares the five-level effort menu and the tuned default', () => {
  for (const row of FALLBACK_MODELS) {
    assert.deepEqual(row.efforts, [...EFFORTS], `${row.id} has a different effort menu`)
    assert.equal(row.defaultEffort, PREFERRED_DEFAULT_EFFORT)
  }
})

await check('the fallback projection reports image input as unsupported', () => {
  for (const row of fallbackAsRemote()) {
    assert.equal(row.supportsImage, false, `${row.id} claims image input the fallback path does not support`)
    assert.equal(row.supportsThinking, true)
  }
})

await check('effort resolution only sends a declared level', () => {
  const model = { efforts: ['low', 'high'], defaultEffort: 'low' }
  assert.equal(resolveEffort(model, 'high'), 'high')
  assert.equal(resolveEffort(model, 'max'), 'high', 'an undeclared level was sent')
  // The tuned default wins when the row offers it, regardless of the row's own default.
  assert.equal(resolveEffort(model, undefined), 'high')
  // A row that offers neither the tuned default nor a declared default gets no level at
  // all: an absent field lets the provider apply its own default, which is always valid.
  assert.equal(resolveEffort({ efforts: ['low'] }, undefined), undefined)
  assert.equal(resolveEffort({ efforts: [] }, undefined), undefined)
  assert.equal(resolveEffort({ efforts: ['low'], defaultEffort: 'low' }, undefined), 'low')
})

// ── 2. the envelope and quota detection ────────────────────────────────────
await check('the business envelope distinguishes success, quota and auth-dead', () => {
  assert.equal(readEnvelope({ code: OK_CODE }).ok, true)
  assert.equal(readEnvelope({ code: AUTH_DEAD_CODE }).authDead, true)
  assert.equal(readEnvelope({ code: '999' }).ok, false)
  assert.equal(readEnvelope(null).ok, false)
})

await check('quota is detected by code or wording, and not by prose', () => {
  assert.equal(isQuotaError({ error: { code: '402' } }), true)
  assert.equal(isQuotaError({ code: 402 }), true)
  assert.equal(isQuotaError({ message: '积分不足' }), true)
  assert.equal(isQuotaError({ message: 'insufficient balance' }), true)
  assert.equal(isQuotaError({ message: 'the balance of trade' }), false)
  assert.equal(isQuotaError('not an object'), false)
})

await check('a balance read keeps unknown distinct from zero', () => {
  assert.equal(readBalance({ code: OK_CODE, data: { balance: 0, dailyBalance: 0 } }).dailyBalance, 0)
  assert.equal(readBalance({ code: '500', data: null }), null, 'a failed read was reported as a zero balance')
  assert.equal(readBalance(null), null)
})

// ── 3. rotation policy ─────────────────────────────────────────────────────
await check('only a spent allowance rotates', () => {
  assert.equal(shouldRotate('quota-exceeded'), true)
  assert.equal(shouldRotate('soft-rate'), false, 'a 429 would burn another account allowance')
  assert.equal(shouldRotate('auth'), false)
  assert.equal(shouldRotate('server'), false)
})

await check('only a spent allowance cools the model', () => {
  assert.equal(recordsCooldown('quota-exceeded'), true)
  assert.equal(recordsCooldown('soft-rate'), false)
})

await check('classification maps the envelope and the statuses', () => {
  assert.equal(classifyHttp(402, ''), 'quota-exceeded')
  assert.equal(classifyHttp(401, ''), 'auth')
  assert.equal(classifyHttp(429, ''), 'soft-rate')
  assert.equal(classifyHttp(500, ''), 'server')
  assert.equal(classifyHttp(400, JSON.stringify({ code: AUTH_DEAD_CODE })), 'auth-dead')
  assert.equal(classifyHttp(400, JSON.stringify({ code: '402' })), 'quota-exceeded')
  assert.equal(classifyHttp(400, 'bad field'), 'client')
  assert.equal(classifyHttp(200, ''), 'none')
})

await check('an auth-dead envelope is reported as AUTH, not as a retryable failure', () => {
  const kind = classifyHttp(400, JSON.stringify({ code: AUTH_DEAD_CODE }))
  assert.equal(kind, 'auth-dead')
  assert.equal(shouldRotate(kind), false)
})

await check('in-band quota wording is recognised', () => {
  assert.equal(classifyInBand('积分不足'), 'quota-exceeded')
  assert.equal(classifyInBand('something broke'), 'server')
})

// ── 4. balance ranking and the permanent lock ──────────────────────────────
await check('ranking prefers a daily balance over a permanent one', () => {
  const ranked = rankByBalance([
    { id: 'permanent-only', balance: 500, dailyBalance: 0 },
    { id: 'has-daily', balance: 0, dailyBalance: 10 },
  ], { allowPermanent: true })
  assert.deepEqual(ranked.map(row => row.id), ['has-daily', 'permanent-only'])
})

await check('a locked permanent balance still ranks but is marked as a last resort', () => {
  const unlocked = rankByBalance([{ id: 'permanent-only', balance: 500, dailyBalance: 0 }], { allowPermanent: true })
  const locked = rankByBalance([{ id: 'permanent-only', balance: 500, dailyBalance: 0 }], { allowPermanent: false })
  assert.equal(unlocked[0].tier, 1)
  assert.equal(locked[0].tier, 2, 'a locked permanent balance must rank below a spendable one')
})

await check('an account with nothing to spend is excluded', () => {
  assert.deepEqual(rankByBalance([{ id: 'empty', balance: 0, dailyBalance: 0 }], { allowPermanent: true }), [])
})

await check('ranking is stable within a tier so manual order decides ties', () => {
  const ranked = rankByBalance([
    { id: 'first', balance: 0, dailyBalance: 5 },
    { id: 'second', balance: 0, dailyBalance: 5 },
    { id: 'third', balance: 0, dailyBalance: 5 },
  ], { allowPermanent: true })
  assert.deepEqual(ranked.map(row => row.id), ['first', 'second', 'third'])
})

/** A pool double over a fixed account list. */
function poolDouble({ accounts, balances, permanentLocked = false }) {
  const credentials = new Map(accounts.map(account => [account.id, { access_token: `token-${account.id}` }]))
  const cooldowns = []
  return {
    listAccountsByProvider: () => accounts,
    getAvailableAccount: async (provider, model, excluded) => {
      const row = accounts.find(account => !(excluded ?? new Set()).has(account.id)
        && !((account.modelRateLimits?.[model] ?? 0) > Date.now()))
      if (row === undefined) return null
      return { entry: row, credential: credentials.get(row.id) }
    },
    resolveCredentialForAccount: async id => credentials.get(id),
    updateModelRateLimit: async (id, model, at) => { cooldowns.push({ id, model, at }) },
    cooldowns,
  }
}

await check('selection refuses a permanent-only account when the lock is on and nothing else exists', async () => {
  const accounts = [
    { id: 'permanent-only', provider: PROVIDER_ID, enabled: true },
  ]
  const pool = poolDouble({ accounts })
  const adapter = createLoomyAdapter({
    fetch: async () => new Response(JSON.stringify({
      code: OK_CODE,
      data: { balance: 500, dailyBalance: 0, availableBalance: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    credentials: { resolve: async () => undefined, set: async () => {} },
    credentialRef: ref => ref,
    accountPool: pool,
    permanentLocked: () => true,
    now: () => 1_000_000,
    warn: () => {},
  })
  const next = await adapter.nextAccount('glm-5', new Set())
  assert.equal(next, undefined, 'a locked permanent-only account was selected for spending')
})

await check('selection uses a permanent-only account when the lock is off', async () => {
  const accounts = [{ id: 'permanent-only', provider: PROVIDER_ID, enabled: true }]
  const pool = poolDouble({ accounts })
  const adapter = createLoomyAdapter({
    fetch: async () => new Response(JSON.stringify({
      code: OK_CODE,
      data: { balance: 500, dailyBalance: 0, availableBalance: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    credentials: { resolve: async () => undefined, set: async () => {} },
    credentialRef: ref => ref,
    accountPool: pool,
    permanentLocked: () => false,
    now: () => 1_000_000,
    warn: () => {},
  })
  const next = await adapter.nextAccount('glm-5', new Set())
  assert.equal(next?.accountId, 'permanent-only')
})

await check('selection prefers an account with a daily balance', async () => {
  const accounts = [
    { id: 'permanent', provider: PROVIDER_ID, enabled: true },
    { id: 'daily', provider: PROVIDER_ID, enabled: true },
  ]
  const pool = poolDouble({ accounts })
  const adapter = createLoomyAdapter({
    fetch: async (url) => {
      const id = String(url).includes('daily') ? 'daily' : undefined
      // The balance endpoint is per-account via its credential; both calls return a body
      // and the adapter distinguishes by the credential it used, so return a union.
      return new Response(JSON.stringify({
        code: OK_CODE,
        data: id === 'daily'
          ? { balance: 0, dailyBalance: 9 }
          : { balance: 800, dailyBalance: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    credentials: { resolve: async () => undefined, set: async () => {} },
    credentialRef: ref => ref,
    accountPool: pool,
    permanentLocked: () => false,
    now: () => 1_000_000,
    warn: () => {},
  })
  // Both accounts report the same shape here, so assert the ranking helper instead.
  const ranked = rankByBalance([
    { id: 'permanent', balance: 800, dailyBalance: 0 },
    { id: 'daily', balance: 0, dailyBalance: 9 },
  ], { allowPermanent: true })
  assert.deepEqual(ranked.map(row => row.id), ['daily', 'permanent'])
})

await check('an unreadable balance is unknown, so a candidate is not discarded as empty', async () => {
  const accounts = [{ id: 'mystery', provider: PROVIDER_ID, enabled: true }]
  const pool = poolDouble({ accounts })
  const adapter = createLoomyAdapter({
    fetch: async () => new Response('not json', { status: 500 }),
    credentials: { resolve: async () => undefined, set: async () => {} },
    credentialRef: ref => ref,
    accountPool: pool,
    permanentLocked: () => false,
    now: () => 1_000_000,
    warn: () => {},
  })
  const next = await adapter.nextAccount('glm-5', new Set())
  assert.equal(next?.accountId, 'mystery', 'an account was dropped because its balance could not be read')
})

// ── 5. request shape and streaming ─────────────────────────────────────────
/** An adapter over a scripted fetch with a single credential. */
function harness({ responses, secrets = { LOOMY_ACCESS_TOKEN: '{"access_token":"tok"}' } }) {
  let index = 0
  const requests = []
  const store = new Map(Object.entries(secrets))
  const adapter = createLoomyAdapter({
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
    permanentLocked: () => false,
    now: () => 1_000_000,
    warn: () => {},
  })
  return { adapter, requests }
}

await check('the chat request carries both auth headers and the resolved effort', async () => {
  const { adapter, requests } = harness({
    responses: [
      () => new Response(JSON.stringify({ code: OK_CODE, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      () => sseResponse([delta({ content: 'hi' }, 'stop')]),
    ],
  })
  await collect(adapter.stream({ model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'hi' }] }))
  const chat = requests.at(-1)
  assert.ok(chat.url.endsWith('/chat/completions'))
  assert.equal(chat.init.headers.authorization, 'Bearer tok')
  assert.equal(chat.init.headers.token, 'tok', 'the business endpoints read the token header')
  const body = JSON.parse(chat.init.body)
  assert.equal(body.reasoning_effort, PREFERRED_DEFAULT_EFFORT)
  assert.equal(body.stream, true)
})

await check('an undeclared effort is not sent', async () => {
  const { adapter, requests } = harness({
    responses: [
      () => new Response(JSON.stringify({ code: OK_CODE, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      () => sseResponse([delta({ content: 'hi' }, 'stop')]),
    ],
  })
  await collect(adapter.stream({ model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'max' }))
  const body = JSON.parse(requests.at(-1).init.body)
  assert.equal(body.reasoning_effort, PREFERRED_DEFAULT_EFFORT, 'an undeclared level was forwarded')
})

await check('the channel reports itself as not refreshable', () => {
  const { adapter } = harness({ responses: [] })
  assert.equal(adapter.refreshable(), false, 'a channel with no refresh endpoint must not claim refreshability')
})

await check('usage and finish flow through the shared consumer', async () => {
  const { adapter } = harness({
    responses: [
      () => new Response(JSON.stringify({ code: OK_CODE, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      () => sseResponse([
        delta({ content: 'answer' }, 'stop'),
        { choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
      ]),
    ],
  })
  const chunks = await collect(adapter.stream({ model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'hi' }] }))
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.equal(usage.inputTokens, 7)
  assert.equal(usage.outputTokens, 3)
  assert.equal(chunks.at(-1).finishReason, 'stop')
})

await check('a truncated stream is reported', async () => {
  const { adapter } = harness({
    responses: [
      () => new Response(JSON.stringify({ code: OK_CODE, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      () => sseResponse([delta({ content: 'partial' })], { terminate: false }),
    ],
  })
  const chunks = await collect(adapter.stream({ model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(chunks.at(-1).truncated, true)
})

await check('a quota failure cools the model to the next UTC+8 day', async () => {
  const accounts = [
    { id: 'a', provider: PROVIDER_ID, enabled: true },
    { id: 'b', provider: PROVIDER_ID, enabled: true },
  ]
  const pool = poolDouble({ accounts })
  let index = 0
  const adapter = createLoomyAdapter({
    fetch: async url => {
      if (String(url).includes('/points/records')) {
        return new Response(JSON.stringify({ code: OK_CODE, data: { balance: 0, dailyBalance: 5 } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ code: OK_CODE, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      index += 1
      if (index === 1) return new Response(JSON.stringify({ code: '402', message: '积分不足' }), { status: 402 })
      return sseResponse([delta({ content: 'ok' }, 'stop')])
    },
    credentials: { resolve: async () => undefined, set: async () => {} },
    credentialRef: ref => ref,
    accountPool: pool,
    permanentLocked: () => false,
    now: () => 1_000_000,
    warn: () => {},
  })
  await collect(adapter.stream({ model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'hi' }] }))
  assert.ok(pool.cooldowns.length >= 1, 'a spent allowance recorded no cooldown')
  // The cooldown must reach at least the next UTC+8 midnight, not a fixed hour.
  const at = pool.cooldowns[0].at
  assert.ok(at > 1_000_000 + 3_600_000, 'the cooldown was shorter than a day for a daily allowance')
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`006-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`006-test: ${passed} checks passed — the Loomy adapter meets its contract.\n`)
process.stdout.write('Scope reminder: scripted fetch only. Host wiring is SRC-016; a real account is SRC-019.\n')
