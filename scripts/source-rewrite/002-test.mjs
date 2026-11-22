/**
 * SRC-002 gate: the independent account core behaves as the frozen contract requires.
 *
 * Run: `node scripts/source-rewrite/002-test.mjs`
 *
 * ## What this proves
 *
 * The account core was written from the SRC-001 contract, not translated from the
 * TypeScript original, so "it looks the same" is not evidence. Each check below pins a
 * behaviour that the contract names and that a plausible-looking implementation could
 * still get wrong:
 *
 * - the write queue cannot reorder concurrent writes (the resurrection bug);
 * - a removal that awaits cannot drop a concurrent append (the lost-login bug);
 * - selection follows manual order and never sorts;
 * - cooldown is per (account, model) and only ever extends;
 * - an invalid timestamp is rejected at the boundary, not stored;
 * - rotation never replays after output, and refresh budgets are per account per kind;
 * - a queue error is recognised in all three wire shapes, and only there;
 * - retry-after honours `0` and never lets a bare number reach `Date.parse`;
 * - backup validates before writing and tolerates the legacy lock field;
 * - legacy index recovery works from credential refs alone.
 *
 * Every test uses an isolated in-memory or temp-directory backend. No credentials, no
 * network, no user data. Exit 0 = all checks passed.
 *
 * @module scripts/source-rewrite/002-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AccountError,
  ACCOUNT_ERROR_CODES,
  ModelQueuedError,
} from '../../src/accounts/core/errors.js'
import {
  AccountIndexStore,
  accountCredentialRef,
  accountFromCredentialRef,
  ACCOUNT_REF_PATTERN,
  ACCOUNT_PROVIDERS,
  isKnownProvider,
  normalizeAccountRow,
  normalizeDisabledModels,
  normalizeGatewayEnabled,
  normalizePermanentLocks,
  normalizeProviderOrder,
  normalizeRateLimits,
} from '../../src/accounts/core/index-store.js'
import {
  allAccountsCoolingDownForModel,
  isCoolingDown,
  nextUtc8DayStartMs,
  selectCandidates,
  shouldAdvanceCounter,
  sweepExpiredCooldowns,
  withCooldown,
} from '../../src/accounts/core/selection.js'
import {
  ModelGate,
  QUEUE_MAX_DELAY_MS,
  SerialQueue,
  sleepWithSignal,
  withQueueRotation,
} from '../../src/accounts/core/queue.js'
import {
  checkQueuedResponse,
  hasPricingHint,
  hasPricingHintText,
  isBillingCode,
  isQueueCode,
  looksLikeBillingText,
  parseQueueInfo,
  parseRetryAfterMs,
  queueDelayMs,
  retryAfterMsFromHeaders,
  throwIfQueued,
} from '../../src/accounts/core/upstream-signals.js'
import {
  assertBackupPayload,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupFormatError,
  exportBackup,
  importBackup,
  locksFromPayload,
} from '../../src/accounts/core/backup.js'

const failures = []
let passed = 0

/**
 * @param {string} name
 * @param {() => unknown | Promise<unknown>} body
 */
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

/** A store backed by a plain object, with a controllable save delay. */
function memoryStore({ initial, saveDelay = () => 0, persistent = true } = {}) {
  let document = initial
  const saves = []
  const store = new AccountIndexStore({
    load: () => document,
    save: async state => {
      saves.push(JSON.parse(JSON.stringify(state)))
      const delay = saveDelay(saves.length)
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      document = JSON.parse(JSON.stringify(state))
    },
    persistent,
    now: () => 1_000,
  })
  return { store, saves, document: () => document }
}

process.stdout.write('SRC-002 account-core gate\n\n')

// ── 1. index store: persistence ordering ───────────────────────────────────
await check('concurrent writes land in call order, so a delete cannot resurrect', async () => {
  // The first save is slow, the second fast: without a write queue the fast one lands
  // first and the slow one then overwrites it with the older document.
  const { store, document } = memoryStore({
    initial: {
      accounts: [
        { id: 'a', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_AAAAAA' },
        { id: 'b', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_BBBBBB' },
        { id: 'keep', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_KEEPKEEP' },
      ],
      disabledModels: {},
    },
    saveDelay: call => (call === 1 ? 40 : 0),
  })
  store.ensureLoaded()
  const first = store.removeAccount('a')
  const second = store.removeAccount('b')
  await Promise.all([first, second])
  const ids = document().accounts.map(row => row.id).sort()
  assert.deepEqual(ids, ['keep'], `disk has ${JSON.stringify(ids)} — a deleted account came back`)
  assert.deepEqual(store.listAll().map(row => row.id).sort(), ['keep'], 'memory and disk disagree')
})

await check('a removal that awaits does not drop a concurrent append', async () => {
  const { store, document } = memoryStore({
    initial: {
      accounts: [{ id: 'victim', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_VVVVVV' }],
      disabledModels: {},
    },
  })
  store.ensureLoaded()
  // The credential clear is what makes removal async; a login finishing in that window
  // must survive.
  const removal = store.removeAccount('victim', async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    await store.addAccount({ id: 'added', provider: 'trae', credentialRef: 'TRAE_ACCOUNT_AAAAAA' })
  })
  await removal
  const ids = document().accounts.map(row => row.id).sort()
  assert.deepEqual(ids, ['added'], `disk has ${JSON.stringify(ids)} — the concurrent login was lost`)
})

await check('a failing save rejects its caller but does not wedge later writes', async () => {
  let document
  let calls = 0
  const store = new AccountIndexStore({
    load: () => document,
    save: async state => {
      calls += 1
      if (calls === 1) throw new Error('disk full')
      document = JSON.parse(JSON.stringify(state))
    },
    now: () => 1_000,
  })
  store.ensureLoaded()
  await assert.rejects(() => store.addAccount({ id: 'a', provider: 'trae', credentialRef: 'TRAE_ACCOUNT_AAAAAA' }), /disk full/)
  // The second write must still be attempted: a rejected chain would refuse forever.
  await store.addAccount({ id: 'b', provider: 'trae', credentialRef: 'TRAE_ACCOUNT_BBBBBB' })
  assert.equal(calls, 2, `save was called ${calls} times; the chain was wedged after the failure`)
  assert.deepEqual(document.accounts.map(row => row.id), ['a', 'b'])
})

await check('re-enabling a model deletes the key instead of storing false', async () => {
  const { store, document } = memoryStore({ initial: { accounts: [], disabledModels: {} } })
  store.ensureLoaded()
  await store.setModelDisabled('zcode', 'GLM-5.3', true)
  assert.deepEqual(store.listDisabledModels('zcode'), { 'GLM-5.3': true })
  await store.setModelDisabled('zcode', 'GLM-5.3', false)
  assert.deepEqual(store.listDisabledModels('zcode'), {}, 'the key survived as false')
  assert.equal(document().disabledModels.zcode, undefined, 'the empty provider table was kept in the document')
})

await check('"disable all" merges with earlier single disables instead of replacing them', async () => {
  const { store } = memoryStore({ initial: { accounts: [], disabledModels: {} } })
  store.ensureLoaded()
  await store.setModelDisabled('trae', 'glm-5', true)
  await store.setModelsDisabled('trae', ['kimi-k3', 'summary'])
  const disabled = store.disabledModelsFor('trae')
  assert.ok(disabled.has('glm-5'), 'the earlier single disable was lost')
  assert.ok(disabled.has('kimi-k3') && disabled.has('summary'))
})

await check('a grouped re-enable touches only its own ids', async () => {
  const { store } = memoryStore({
    initial: { accounts: [], disabledModels: { trae: { 'glm-5': true, 'kimi-k3': true, summary: true } } },
  })
  store.ensureLoaded()
  await store.clearModelsDisabled('trae', ['glm-5'])
  const disabled = store.disabledModelsFor('trae')
  assert.ok(!disabled.has('glm-5'))
  assert.ok(disabled.has('kimi-k3') && disabled.has('summary'), 'a grouped enable opened models outside its group')
})

await check('clearing a provider blacklist drops every key, including off-catalog ones', async () => {
  const { store } = memoryStore({
    initial: { accounts: [], disabledModels: { trae: { 'retired-model': true, 'glm-5': true } } },
  })
  store.ensureLoaded()
  await store.clearDisabledModels('trae')
  assert.equal(store.disabledModelsFor('trae').size, 0, 'a retired key survived, and could later hide a reused id')
})

await check('reordering rejects a stale list instead of appending the missing rows', async () => {
  const { store } = memoryStore({
    initial: {
      accounts: [
        { id: 'a', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_AAAAAA' },
        { id: 'b', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_BBBBBB' },
        { id: 'c', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_CCCCCC' },
      ],
      disabledModels: {},
    },
  })
  store.ensureLoaded()
  await assert.rejects(() => store.reorderAccounts('loomy', ['b', 'a']), /refresh and retry/)
  await assert.rejects(() => store.reorderAccounts('loomy', ['b', 'a', 'zzz']), /refresh and retry/)
  await store.reorderAccounts('loomy', ['c', 'a', 'b'])
  assert.deepEqual(store.listAll().map(row => row.id), ['c', 'a', 'b'])
})

await check('reordering one provider leaves other providers in place', async () => {
  const { store } = memoryStore({
    initial: {
      accounts: [
        { id: 'x1', provider: 'trae', credentialRef: 'TRAE_ACCOUNT_111111' },
        { id: 'l1', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_111111' },
        { id: 'x2', provider: 'trae', credentialRef: 'TRAE_ACCOUNT_222222' },
      ],
      disabledModels: {},
    },
  })
  store.ensureLoaded()
  await store.reorderAccounts('trae', ['x2', 'x1'])
  assert.deepEqual(store.listAll().map(row => row.id), ['x2', 'l1', 'x1'], 'a foreign row moved')
})

await check('setAccountsEnabled reports changed rows, not matched rows', async () => {
  const { store } = memoryStore({
    initial: {
      accounts: [
        { id: 'a', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_AAAAAA', enabled: true },
        { id: 'b', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_BBBBBB', enabled: false },
      ],
      disabledModels: {},
    },
  })
  store.ensureLoaded()
  assert.equal(await store.setAccountsEnabled('loomy', false), 1, 'reported a change for a row that was already disabled')
  assert.equal(await store.setAccountsEnabled('loomy', false), 0, 'a no-op toggle reported a change')
})

// ── 2. normalisers ─────────────────────────────────────────────────────────
await check('a row missing id, provider or credentialRef is dropped', () => {
  assert.equal(normalizeAccountRow({ provider: 'trae', credentialRef: 'TRAE_ACCOUNT_AAAAAA' }, 1), null)
  assert.equal(normalizeAccountRow({ id: 'a', credentialRef: 'TRAE_ACCOUNT_AAAAAA' }, 1), null)
  assert.equal(normalizeAccountRow({ id: 'a', provider: 'trae' }, 1), null)
  const kept = normalizeAccountRow({ id: 'a', provider: 'trae', credentialRef: 'TRAE_ACCOUNT_AAAAAA' }, 1)
  assert.equal(kept.enabled, true, 'enabled must default true so an older document behaves as before')
  assert.equal(kept.refreshable, true)
  assert.equal(kept.nickname, 'a')
  assert.equal(kept.createdAt, 1)
})

await check('a non-finite rate-limit stamp is rejected, never stored', () => {
  assert.equal(normalizeRateLimits({ model: Number.NaN }), undefined)
  assert.equal(normalizeRateLimits({ model: Number.POSITIVE_INFINITY }), undefined)
  assert.equal(normalizeRateLimits({ '': 5 }), undefined, 'an empty model key was kept')
  assert.deepEqual(normalizeRateLimits({ model: 42 }), { model: 42 })
})

await check('blacklist keeps only explicit true', () => {
  assert.deepEqual(normalizeDisabledModels({ p: { a: true, b: false, c: 'yes', d: 1 } }), { p: { a: true } })
  assert.deepEqual(normalizeDisabledModels({ p: [] }), {}, 'an array was accepted as a provider table')
})

await check('permanent locks keep only explicit true', () => {
  assert.deepEqual(normalizePermanentLocks({ loomy: true, trae: 'yes', cline: false }), { loomy: true })
})

await check('provider order keeps first occurrence and drops non-strings', () => {
  assert.deepEqual(normalizeProviderOrder(['a', 'b', 'a', '', 5, null]), ['a', 'b'])
  assert.deepEqual(normalizeProviderOrder('not-an-array'), [])
})

await check('only an explicit false disables the gateway', () => {
  assert.equal(normalizeGatewayEnabled(undefined), true, 'a missing key must mean enabled')
  assert.equal(normalizeGatewayEnabled('false'), true, 'a string must not disable the gateway')
  assert.equal(normalizeGatewayEnabled(false), false)
})

// ── 3. credential refs and legacy recovery ─────────────────────────────────
await check('credential refs round-trip through the provider table', () => {
  for (const provider of ACCOUNT_PROVIDERS) {
    const ref = accountCredentialRef(provider, 'ABCDEF12')
    assert.match(ref, ACCOUNT_REF_PATTERN, `${provider} produced an unrecognised ref: ${ref}`)
    const row = accountFromCredentialRef(ref, 7)
    assert.equal(row?.provider, provider, `${provider} recovered as ${row?.provider}`)
    assert.equal(row?.id, `${provider}-abcdef12`)
    assert.equal(row?.createdAt, 7)
  }
})

await check('QODERCN is never attributed to QODER', () => {
  // Both prefixes share a stem; only explicit longest-first ordering keeps them apart.
  const cn = accountFromCredentialRef('QODERCN_ACCOUNT_ABCDEF')
  assert.equal(cn?.provider, 'qodercn', `CN recovered as ${cn?.provider} — the account would land on the wrong panel`)
})

await check('a ref with an unknown prefix is refused', () => {
  assert.equal(accountFromCredentialRef('NOSUCH_ACCOUNT_ABCDEF'), null)
  assert.equal(accountFromCredentialRef('QODER_ACCOUNT_'), null, 'an empty suffix was accepted')
  assert.equal(accountFromCredentialRef('QODER_ACCOUNT_XYZ'), null, 'a non-hex suffix was accepted')
})

await check('the ten contracted providers are exactly the non-opencode table entries', () => {
  assert.equal(ACCOUNT_PROVIDERS.length, 10)
  assert.ok(!ACCOUNT_PROVIDERS.includes('opencode'), 'opencode must not be one of the ten')
  assert.ok(isKnownProvider('opencode'), 'opencode must still be recoverable from a ref')
  assert.ok(!isKnownProvider('nosuch'))
})

// ── 4. selection and cooldown ──────────────────────────────────────────────
const rows = [
  { id: 'a', provider: 'trae', enabled: true },
  { id: 'b', provider: 'trae', enabled: true, modelRateLimits: { 'glm-5': 5_000 } },
  { id: 'c', provider: 'trae', enabled: false },
  { id: 'd', provider: 'trae', enabled: true, modelRateLimits: { 'glm-5': 0 } },
  { id: 'e', provider: 'loomy', enabled: true },
]

await check('selection keeps manual order and never sorts', () => {
  const picked = selectCandidates(rows, 'trae', 'kimi-k3', 1_000)
  assert.deepEqual(picked.map(row => row.id), ['a', 'b', 'd'], 'a filtered candidate set must preserve array order')
})

await check('cooldown excludes only the model it applies to', () => {
  assert.deepEqual(selectCandidates(rows, 'trae', 'glm-5', 1_000).map(row => row.id), ['a', 'd'])
  assert.deepEqual(selectCandidates(rows, 'trae', 'glm-5', 6_000).map(row => row.id), ['a', 'b', 'd'], 'an expired stamp still filtered')
})

await check('an empty model id applies no cooldown filter', () => {
  assert.deepEqual(selectCandidates(rows, 'trae', '', 1_000).map(row => row.id), ['a', 'b', 'd'])
})

await check('a zero stamp means available, not 1970', () => {
  assert.equal(isCoolingDown({ modelRateLimits: { m: 0 } }, 'm', 1_000), false)
})

await check('exclusion is honoured, which is what makes rotation advance', () => {
  assert.deepEqual(selectCandidates(rows, 'trae', 'kimi-k3', 1_000, new Set(['a'])).map(row => row.id), ['b', 'd'])
})

await check('all-cooling-down is proven only when every enabled row is limited', () => {
  const limited = [
    { id: 'a', provider: 'trae', modelRateLimits: { m: 3_000 } },
    { id: 'b', provider: 'trae', modelRateLimits: { m: 1_000 } },
  ]
  assert.deepEqual(allAccountsCoolingDownForModel(limited, 'm', 500), { resetAtMs: 1_000, accountCount: 2 })
  assert.equal(allAccountsCoolingDownForModel(limited, 'other', 500), undefined)
  assert.equal(allAccountsCoolingDownForModel(limited, '', 500), undefined, 'an empty model id must not be reported as limited')
  assert.equal(allAccountsCoolingDownForModel([limited[0], { id: 'c', provider: 'trae' }], 'm', 500), undefined,
    'one unrestricted row must disprove the claim')
})

await check('a cooldown only ever extends', () => {
  const row = { id: 'a', modelRateLimits: { m: 10_000 } }
  assert.equal(withCooldown(row, 'm', 5_000), undefined, 'a shorter deadline overwrote a longer one')
  assert.equal(withCooldown(row, 'm', 10_000), undefined, 'an equal deadline caused a needless write')
  assert.deepEqual(withCooldown(row, 'm', 20_000)?.modelRateLimits.m, 20_000)
})

await check('a non-finite cooldown is refused', () => {
  assert.equal(withCooldown({ id: 'a' }, 'm', Number.NaN), undefined)
  assert.equal(withCooldown({ id: 'a' }, 'm', Number.POSITIVE_INFINITY), undefined)
  assert.equal(withCooldown({ id: 'a' }, '', 5_000), undefined, 'an empty model key was written')
})

await check('sweeping drops expired stamps and reports no change when clean', () => {
  const dirty = [{ id: 'a', modelRateLimits: { old: 100, live: 9_000 } }]
  const swept = sweepExpiredCooldowns(dirty, 1_000)
  assert.deepEqual(swept?.[0].modelRateLimits, { live: 9_000 })
  assert.equal(sweepExpiredCooldowns([{ id: 'a' }], 1_000), undefined)
  assert.deepEqual(sweepExpiredCooldowns([{ id: 'a', modelRateLimits: { only: 100 } }], 1_000)?.[0].modelRateLimits, undefined,
    'an emptied map must be removed, not left as {}')
})

await check('generation counters only move forward', () => {
  assert.equal(shouldAdvanceCounter(3, 4), true)
  assert.equal(shouldAdvanceCounter(3, 3), false)
  assert.equal(shouldAdvanceCounter(3, 2), false)
  assert.equal(shouldAdvanceCounter(0, 1), true)
  assert.equal(shouldAdvanceCounter(0, 0), false)
  assert.equal(shouldAdvanceCounter(0, -1), false)
})

await check('the UTC+8 day boundary is strictly in the future and lands on midnight', () => {
  const now = Date.UTC(2026, 10, 22, 3, 15, 0) // 11:15 UTC = 19:15 UTC+8
  const next = nextUtc8DayStartMs(now)
  assert.ok(next > now, 'the boundary must be in the future')
  const shifted = next + 8 * 3_600_000
  assert.equal(shifted % 86_400_000, 0, 'the boundary is not a UTC+8 midnight')
  // Exactly at a boundary the next one is a full day away, never zero.
  assert.equal(nextUtc8DayStartMs(next), next + 86_400_000)
})

// ── 5. serial queue and gate ───────────────────────────────────────────────
await check('the serial queue is first-come-first-served and never overlaps', async () => {
  const queue = new SerialQueue()
  const events = []
  let active = 0
  let peak = 0
  const task = id => async () => {
    active += 1
    peak = Math.max(peak, active)
    events.push(`start:${id}`)
    await new Promise(resolve => setTimeout(resolve, 5))
    events.push(`end:${id}`)
    active -= 1
  }
  await Promise.all([queue.run(task('a')), queue.run(task('b')), queue.run(task('c'))])
  assert.equal(peak, 1, `${peak} tasks ran at once`)
  assert.deepEqual(events, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
  assert.equal(queue.stats().completed, 3)
})

await check('a failed task still releases the queue', async () => {
  const queue = new SerialQueue()
  await assert.rejects(() => queue.run(async () => { throw new Error('boom') }), /boom/)
  const value = await queue.run(async () => 'after')
  assert.equal(value, 'after', 'the queue was welded shut by the failure')
})

await check('a queued caller can abort its wait', async () => {
  const queue = new SerialQueue()
  const controller = new AbortController()
  let releaseFirst
  const first = queue.run(() => new Promise(resolve => { releaseFirst = resolve }))
  const second = queue.run(async () => 'never', { signal: controller.signal })
  controller.abort()
  await assert.rejects(() => second, error => error.code === ACCOUNT_ERROR_CODES.ABORTED)
  releaseFirst()
  await first
})

await check('the model gate serialises and applies the per-model gap', async () => {
  let clock = 0
  const slept = []
  const gate = new ModelGate({
    gaps: { 'glm-5.3': 350 },
    now: () => clock,
    sleep: async ms => { slept.push(ms); clock += ms },
  })
  let active = 0
  let peak = 0
  const task = async () => {
    active += 1
    peak = Math.max(peak, active)
    clock += 10
    active -= 1
    return 'ok'
  }
  await gate.run('GLM-5.3', task)
  await gate.run('glm-5.3', task)
  assert.equal(peak, 1, 'two upstream requests were in flight at once')
  assert.equal(slept.length, 1, 'the second dispatch did not wait for the gap')
  assert.equal(slept[0], 340, `gap wait was ${slept[0]}ms, expected 350 - 10 elapsed`)
})

await check('the gate applies no gap to an unlisted model', async () => {
  const slept = []
  const gate = new ModelGate({ gaps: { 'glm-5.3': 350 }, sleep: async ms => { slept.push(ms) } })
  await gate.run('other', async () => 'ok')
  await gate.run('other', async () => 'ok')
  assert.deepEqual(slept, [])
})

await check('sleepWithSignal resolves normally and rejects on abort', async () => {
  await sleepWithSignal(1)
  const controller = new AbortController()
  const pending = sleepWithSignal(5_000, controller.signal)
  controller.abort()
  await assert.rejects(() => pending, error => error.code === ACCOUNT_ERROR_CODES.ABORTED)
})

// ── 6. rotation wrapper ────────────────────────────────────────────────────
/**
 * Build a wrapper over a fake adapter that plays a scripted list of attempts.
 *
 * `create` receives the wrapper's scoped options, which is how a scripted attempt gets
 * at the budgeted `refresh` and the proxied `accountPool` — the real adapters receive
 * them the same way, through their constructor options.
 *
 * @param {object} spec
 * @param {Array<(ctx: { input: any, refresh?: Function, accountPool?: any }) => any>} spec.attempts
 * @param {object} [spec.options]
 * @param {object} [spec.timing]
 */
function rotationHarness({ attempts, options = {}, timing = {} }) {
  let attemptIndex = 0
  const opened = []
  let scoped
  const adapter = {
    stream(input) {
      const script = attempts[attemptIndex]
      attemptIndex += 1
      opened.push(input.model)
      const { refresh, accountPool } = scoped
      return (async function* () {
        if (script === undefined) throw new Error('ran out of scripted attempts')
        yield* script({ input, refresh, accountPool })
      })()
    },
  }
  const wrapped = withQueueRotation({
    provider: 'trae',
    options,
    create: received => { scoped = received; return adapter },
    timing: { sleep: async () => {}, ...timing },
  })
  return { wrapped, opened: () => opened }
}

/** Yield the given values then return. */
const yields = (...values) => async function* () { for (const value of values) yield value }

await check('a queue error before any output retries on the same turn', async () => {
  const { wrapped, opened } = rotationHarness({
    attempts: [
      async function* () { throw new ModelQueuedError('queued', { retryAfterMs: 1 }) },
      yields('hello'),
    ],
  })
  const out = []
  for await (const chunk of wrapped.stream({ model: 'm' })) out.push(chunk)
  assert.deepEqual(out, ['hello'])
  assert.equal(opened().length, 2, 'the turn did not retry')
})

await check('a queue error after output is rethrown, never replayed', async () => {
  const { wrapped, opened } = rotationHarness({
    attempts: [
      async function* () {
        yield 'partial'
        throw new ModelQueuedError('queued', { retryAfterMs: 1 })
      },
      yields('duplicate'),
    ],
  })
  const out = []
  await assert.rejects(async () => {
    for await (const chunk of wrapped.stream({ model: 'm' })) out.push(chunk)
  }, error => error.code === ACCOUNT_ERROR_CODES.QUEUE)
  assert.deepEqual(out, ['partial'], 'output was replayed after being delivered')
  assert.equal(opened().length, 1, 'a second attempt was opened after visible output')
})

await check('a non-queue error is never retried', async () => {
  const { wrapped, opened } = rotationHarness({
    attempts: [
      async function* () { throw new AccountError('boom', ACCOUNT_ERROR_CODES.SERVER) },
      yields('never'),
    ],
  })
  await assert.rejects(async () => {
    for await (const chunk of wrapped.stream({ model: 'm' })) void chunk
  }, /boom/)
  assert.equal(opened().length, 1)
})

await check('a caller abort during a queue wait stops the turn', async () => {
  const controller = new AbortController()
  const { wrapped } = rotationHarness({
    attempts: [async function* () { throw new ModelQueuedError('queued', { retryAfterMs: 5_000 }) }],
    timing: { sleep: async () => { controller.abort() } },
  })
  await assert.rejects(async () => {
    for await (const chunk of wrapped.stream({ model: 'm', signal: controller.signal })) void chunk
  }, error => error.code === ACCOUNT_ERROR_CODES.ABORTED || error.name === 'AbortError')
})

await check('queue retries are bounded', async () => {
  let opens = 0
  const adapter = {
    stream() {
      opens += 1
      return (async function* () { throw new ModelQueuedError('queued', { retryAfterMs: 0 }) })()
    },
  }
  const wrapped = withQueueRotation({
    provider: 'trae',
    options: {},
    create: () => adapter,
    timing: { sleep: async () => {} },
  })
  await assert.rejects(async () => {
    for await (const chunk of wrapped.stream({ model: 'm' })) void chunk
  }, /retries or wait time exhausted|queue wait timed out/)
  assert.ok(opens <= 181, `${opens} attempts — the retry cap did not hold`)
})

await check('the refresh budget is per account and per kind', async () => {
  const refreshed = []
  const options = {
    refresh: async (id, reason) => { refreshed.push(`${id}:${reason}`) },
  }
  // The adapter calls refresh twice per attempt; the second call must be refused.
  const { wrapped } = rotationHarness({
    options,
    attempts: [
      async function* ({ refresh }) {
        await refresh('acct-1', 'auth')
        await refresh('acct-1', 'auth')
        yield 'x'
      },
    ],
  })
  await assert.rejects(async () => {
    for await (const chunk of wrapped.stream({ model: 'm' })) void chunk
  }, error => error.code === ACCOUNT_ERROR_CODES.AUTH)
  assert.deepEqual(refreshed, ['acct-1:auth'], 'the refresh budget did not stop the second refresh')
})

await check('a credential refresh and an auth refresh are separate budgets', async () => {
  const refreshed = []
  const options = {
    refresh: async (id, reason) => { refreshed.push(`${id}:${reason}`) },
  }
  const { wrapped } = rotationHarness({
    options,
    attempts: [
      async function* ({ refresh }) {
        await refresh('acct-1')
        await refresh('acct-1', 'auth')
        yield 'ok'
      },
    ],
  })
  const out = []
  for await (const chunk of wrapped.stream({ model: 'm' })) out.push(chunk)
  assert.deepEqual(out, ['ok'])
  assert.deepEqual(refreshed, ['acct-1:undefined', 'acct-1:auth'], 'the two refresh kinds shared one budget')
})

await check('rotation excludes already-tried accounts instead of re-picking them', async () => {
  const selections = []
  const accounts = [
    { entry: { id: 'a', provider: 'trae', enabled: true }, credential: { token: 'a' } },
    { entry: { id: 'b', provider: 'trae', enabled: true }, credential: { token: 'b' } },
  ]
  const options = {
    accountPool: {
      getAvailableAccount: async (provider, model, excluded) => {
        selections.push([...(excluded ?? [])])
        return accounts.find(row => !(excluded ?? new Set()).has(row.entry.id)) ?? null
      },
      listAccountsByProvider: () => accounts.map(row => row.entry),
      findAccountIdByIdentityField: async () => '',
    },
  }
  // Each attempt selects through the pool, as a real adapter does, then queues. With two
  // accounts the turn must reach exhaustion: if rotation failed to exclude, the same
  // account would be handed back forever and the pool would never run dry.
  const selectAndQueue = async function* ({ input, accountPool }) {
    const picked = await accountPool.getAvailableAccount('trae', input.model)
    if (picked === null) throw new AccountError('pool exhausted', ACCOUNT_ERROR_CODES.MISSING_CREDENTIAL)
    throw new ModelQueuedError('queued', { retryAfterMs: 0 })
  }
  const { wrapped } = rotationHarness({
    options,
    attempts: [selectAndQueue, selectAndQueue, selectAndQueue, selectAndQueue],
  })
  await assert.rejects(async () => {
    for await (const chunk of wrapped.stream({ model: 'm' })) void chunk
  }, /pool exhausted/, 'the turn never exhausted the pool, so rotation kept re-picking a tried account')
  // The first selection excludes nothing; later ones must exclude what was already used.
  assert.deepEqual(selections[0], [], 'the first selection should not exclude anything')
  assert.ok(selections.some(set => set.length > 0), `no selection carried an exclusion set: ${JSON.stringify(selections)}`)
})

// ── 7. upstream signals ────────────────────────────────────────────────────
await check('a queue body is recognised in the HTTP shape', () => {
  const body = JSON.stringify({ code: '10605', message: JSON.stringify({ isQueued: true, retryAfterSeconds: 30 }) })
  const info = parseQueueInfo(body)
  assert.equal(info?.retryAfterSeconds, 30)
  assert.equal(queueDelayMs(info), QUEUE_MAX_DELAY_MS, 'a 30s wait must be capped at 10s')
})

await check('a queue body is recognised in the SSE inner shape (no code field)', () => {
  // This is the shape the first fix missed: the inner message carries no business code.
  const info = parseQueueInfo(JSON.stringify({ isQueued: true, serviceAvailable: false, retryAfterSeconds: 5 }))
  assert.equal(info?.retryAfterSeconds, 5)
})

await check('an instantaneous queue is still a queue', () => {
  const info = parseQueueInfo(JSON.stringify({
    isQueued: false, serviceAvailable: true, waitTime: 0, retryAfterSeconds: 2,
  }))
  assert.ok(info !== undefined, 'isQueued:false with serviceAvailable was rejected')
  assert.equal(queueDelayMs(info), 2_000, 'the declared 2s wait was replaced by the 1s fallback')
})

await check('a non-queue body is not mistaken for a queue', () => {
  assert.equal(parseQueueInfo(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })), undefined)
  assert.equal(parseQueueInfo('not json'), undefined)
  assert.equal(parseQueueInfo(null), undefined)
})

await check('throwIfQueued raises with a capped delay', () => {
  assert.throws(
    () => throwIfQueued({ code: '10605', message: JSON.stringify({ isQueued: true, retryAfterSeconds: 60 }) }),
    error => error instanceof ModelQueuedError && error.retryAfterMs === QUEUE_MAX_DELAY_MS,
  )
  assert.doesNotThrow(() => throwIfQueued({ ok: true }))
})

await check('billing codes and wording are distinct from queue codes', () => {
  assert.equal(isQueueCode('10605'), true)
  assert.equal(isQueueCode(10605), true)
  assert.equal(isQueueCode('110'), false)
  assert.equal(isBillingCode('110'), true)
  assert.equal(isBillingCode(112), true)
  assert.equal(isBillingCode('10605'), false)
  assert.equal(looksLikeBillingText('Billing daily count exceeded'), true)
  assert.equal(looksLikeBillingText('explain how a billing system works'), false, 'prose was mistaken for an error')
})

await check('a pricing hint is recognised by key, not by prose', () => {
  assert.equal(hasPricingHint({ error: { pricingUrl: 'https://x' } }), true)
  assert.equal(hasPricingHint({ text: 'pricing is interesting' }), false)
  assert.equal(hasPricingHintText('{"pricing_url":"https://x"}'), true)
  assert.equal(hasPricingHintText('the pricing page is here'), false)
})

await check('retry-after honours 0 and never sends a bare number to Date.parse', () => {
  assert.equal(parseRetryAfterMs('0'), 0, '0 must mean "released now", not "unknown"')
  assert.equal(parseRetryAfterMs('30'), 30_000)
  assert.equal(parseRetryAfterMs('900'), 900_000, 'a bare number was treated as a date, giving a 1970 timestamp')
  assert.equal(parseRetryAfterMs('-5'), undefined, 'a negative value must be invalid, not a year')
  assert.equal(parseRetryAfterMs(''), undefined)
  assert.equal(parseRetryAfterMs(null), undefined)
  const at = Date.UTC(2026, 10, 22, 0, 0, 0)
  assert.equal(parseRetryAfterMs(new Date(at + 5_000).toUTCString(), at), 5_000)
  assert.equal(retryAfterMsFromHeaders({ get: () => '7' }), 7_000)
})

await check('a queued JSON 200 response is converted to a thrown queue error', async () => {
  const response = new Response(JSON.stringify({ code: '10605', message: JSON.stringify({ isQueued: true }) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  const checked = await checkQueuedResponse(response)
  // The detection happens while the body streams, so the error surfaces on read —
  // which is exactly when a caller would otherwise start parsing a queue body as a
  // completion.
  await assert.rejects(() => checked.text(), error => error instanceof ModelQueuedError)
})

await check('a normal JSON 200 response passes through untouched', async () => {
  const response = new Response(JSON.stringify({ choices: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  const checked = await checkQueuedResponse(response)
  assert.deepEqual(await checked.json(), { choices: [] })
})

// ── 8. backup ──────────────────────────────────────────────────────────────
const validPayload = () => ({
  format: BACKUP_FORMAT,
  version: BACKUP_VERSION,
  exportedAt: '2026-11-22T00:00:00.000Z',
  credentials: { LOOMY_ACCOUNT_AAAAAA: '{"access_token":"x"}' },
  accounts: [{ id: 'a', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_AAAAAA' }],
  disabledModels: { loomy: { m: true } },
  permanentLocks: { loomy: true },
  loomyPermanentLocked: true,
})

await check('a valid payload passes validation', () => {
  assert.doesNotThrow(() => assertBackupPayload(validPayload()))
})

await check('malformed payloads are rejected with a specific reason', () => {
  const cases = [
    [{ ...validPayload(), format: 'nope' }, /not a .* file/],
    [{ ...validPayload(), version: 2 }, /unsupported backup version/],
    [{ ...validPayload(), exportedAt: undefined }, /exportedAt/],
    [{ ...validPayload(), credentials: [] }, /credentials field is invalid/],
    [{ ...validPayload(), accounts: {} }, /accounts field is invalid/],
    [{ ...validPayload(), disabledModels: null }, /disabledModels field is invalid/],
    [{ ...validPayload(), permanentLocks: [] }, /permanentLocks field is invalid/],
    [[], /not an object/],
  ]
  for (const [payload, pattern] of cases) {
    assert.throws(() => assertBackupPayload(payload), error => error instanceof BackupFormatError && pattern.test(error.message))
  }
})

await check('an old backup with only the legacy lock field is honoured, including false', () => {
  assert.deepEqual(locksFromPayload({ loomyPermanentLocked: true }), { loomy: true })
  assert.deepEqual(locksFromPayload({ loomyPermanentLocked: false }), {},
    'an explicit unlock must be honoured, not treated as unknown')
  assert.equal(locksFromPayload({}), undefined, 'an absent lock state must stay unknown so the current value is kept')
})

await check('a lock table that omits loomy still merges the legacy field', () => {
  assert.deepEqual(locksFromPayload({ permanentLocks: { trae: true }, loomyPermanentLocked: true }), { trae: true, loomy: true })
  assert.deepEqual(locksFromPayload({ permanentLocks: { loomy: true }, loomyPermanentLocked: false }), { loomy: true })
})

await check('export captures credentials and reports a missing one as a warning', async () => {
  const { store } = memoryStore({
    initial: {
      accounts: [
        { id: 'a', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_AAAAAA' },
        { id: 'b', provider: 'trae', credentialRef: 'TRAE_ACCOUNT_BBBBBB' },
      ],
      disabledModels: {},
    },
  })
  store.ensureLoaded()
  const credentials = {
    resolve: async ref => (ref === 'LOOMY_ACCOUNT_AAAAAA' ? { value: '{"token":"x"}' } : undefined),
  }
  const { payload, warnings } = await exportBackup({ index: store, credentials, credentialRef: ref => ref })
  assert.equal(payload.format, BACKUP_FORMAT)
  assert.deepEqual(Object.keys(payload.credentials), ['LOOMY_ACCOUNT_AAAAAA'])
  assert.equal(warnings.length, 1, 'a missing credential must warn, not abort the export')
  assert.ok(!('gatewayEnabled' in payload), 'a per-install preference leaked into the backup')
  assert.ok(!('providerOrder' in payload), 'a per-install preference leaked into the backup')
})

await check('import writes credentials before replacing the index', async () => {
  const order = []
  const credentials = { set: async () => { order.push('credential') } }
  const index = { replaceAll: async () => { order.push('index') } }
  const result = await importBackup({
    credentials, index, credentialRef: ref => ref, payload: validPayload(), now: () => Date.parse('2026-11-22T00:00:00Z'),
  })
  assert.deepEqual(order, ['credential', 'index'], 'the index was replaced before the credentials were written')
  assert.equal(result.credentialsImported, 1)
  assert.equal(result.accountsImported, 1)
})

await check('import validates before touching anything', async () => {
  let touched = false
  await assert.rejects(() => importBackup({
    credentials: { set: async () => { touched = true } },
    index: { replaceAll: async () => { touched = true } },
    credentialRef: ref => ref,
    payload: { format: 'nope' },
  }), BackupFormatError)
  assert.equal(touched, false, 'a malformed backup wrote something before failing')
})

await check('import skips a rejected credential ref and still restores the rest', async () => {
  const payload = validPayload()
  payload.credentials = { GOOD_REF: 'v', BAD_REF: 'v' }
  const written = []
  const result = await importBackup({
    credentials: {
      set: async (ref) => {
        if (ref === 'BAD_REF') throw new Error('invalid ref')
        written.push(ref)
      },
    },
    index: { replaceAll: async () => {} },
    credentialRef: ref => ref,
    payload,
  })
  assert.deepEqual(written, ['GOOD_REF'])
  assert.deepEqual(result.skipped, ['BAD_REF'])
})

await check('import counts expired accounts and missing credentials', async () => {
  const payload = validPayload()
  payload.accounts = [
    { id: 'expired', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_AAAAAA', expiresAt: 1 },
    { id: 'no-cred', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_ZZZZZZ' },
  ]
  payload.credentials = { LOOMY_ACCOUNT_AAAAAA: 'v' }
  const result = await importBackup({
    credentials: { set: async () => {} },
    index: { replaceAll: async () => {} },
    credentialRef: ref => ref,
    payload,
    now: () => 1_000,
  })
  assert.equal(result.expiredAccounts, 1)
  assert.equal(result.missingCredentials, 1)
})

// ── 9. legacy state migration, end to end ─────────────────────────────────
await check('a legacy document loads, migrates and survives a round trip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-002-'))
  const file = path.join(dir, 'state.json')
  // A document as an older build would have written it: no providerOrder, no
  // gatewayEnabled, a dirty account row, and a false-valued blacklist entry.
  fs.writeFileSync(file, JSON.stringify({
    accounts: [
      { id: 'ok', provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_AAAAAA' },
      { provider: 'loomy', credentialRef: 'LOOMY_ACCOUNT_NOID' },
      { id: 'dirty', provider: 'trae', credentialRef: 'TRAE_ACCOUNT_BBBBBB', enabled: 'yes' },
    ],
    disabledModels: { trae: { 'glm-5': true, 'kimi-k3': false } },
    loomyPermanentLocked: true,
  }))
  const store = new AccountIndexStore({
    load: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    save: async state => fs.writeFileSync(file, JSON.stringify(state)),
  })
  store.ensureLoaded()
  assert.deepEqual(store.listAll().map(row => row.id), ['ok', 'dirty'], 'the row without an id was kept')
  assert.equal(store.isGatewayEnabled(), true, 'a missing gateway key must mean enabled')
  assert.deepEqual(store.getProviderOrder(), [])
  assert.equal(store.isPermanentLocked('loomy'), true, 'the legacy mirror was not migrated')
  assert.deepEqual([...store.disabledModelsFor('trae')], ['glm-5'], 'a false blacklist entry was kept')

  await store.setProviderOrder(['trae', 'loomy'])
  const reloaded = new AccountIndexStore({
    load: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    save: async state => fs.writeFileSync(file, JSON.stringify(state)),
  })
  reloaded.ensureLoaded()
  assert.deepEqual(reloaded.getProviderOrder(), ['trae', 'loomy'])
  assert.equal(reloaded.isPermanentLocked('loomy'), true, 'the lock was lost on the round trip')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ── summary ───────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`002-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`002-test: ${passed} checks passed — the account core meets the frozen contract.\n`)
process.stdout.write('Scope reminder: this is module-level evidence. Host wiring is SRC-016, package contents are SRC-018, real accounts are SRC-019.\n')
