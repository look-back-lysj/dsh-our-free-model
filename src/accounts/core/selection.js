/**
 * Account selection and per-model cooldown.
 *
 * ## The one rule that shapes this module
 *
 * Selection order is the user's own drag order. Nothing here sorts. An earlier design
 * ordered candidates by "earliest rate-limit expiry", which made dragging an account
 * to the top pure decoration: as long as some other account's cooldown ended sooner,
 * that one got picked anyway. The current rule is "manual order wins, cooldown
 * exempts": the order is entirely the user's, and accounts currently cooling down for
 * the target model are filtered out before the first is taken.
 *
 * ## Cooldown is per (account, model), never per account
 *
 * Quotas are metered per model on every provider this product speaks to. A single
 * exhausted model must not take the whole account out of rotation — that would strand
 * capacity the user paid for.
 *
 * @module src/accounts/core/selection
 */

import { normalizeRateLimits } from './index-store.js'

/**
 * Is this account cooling down for the given model right now?
 *
 * An absent stamp, a zero stamp, and a stamp in the past all mean "available". The
 * zero case matters because older documents used `0` to mean "not limited"; treating
 * it as a real timestamp would park the account until 1970 passed.
 *
 * @param {Record<string, any>} entry
 * @param {string} modelId - empty means "unknown target", which disables the filter
 * @param {number} now
 * @returns {boolean}
 */
export function isCoolingDown(entry, modelId, now) {
  if (modelId.length === 0) return false
  const resetAt = entry.modelRateLimits?.[modelId]
  if (resetAt === undefined || resetAt === 0) return false
  return now < resetAt
}

/**
 * The candidates that could serve this request, in manual order.
 *
 * Three filters, in this order: right provider, enabled, not cooling down for this
 * model. `exclude` exists because rotation has to be able to ask for "the next one":
 * a failure class that records no cooldown (a 5xx, say) leaves the failed account at
 * the head of the list, so a caller that could not exclude it would retry the same
 * account forever while believing it was rotating.
 *
 * @param {readonly Record<string, any>[]} accounts
 * @param {string} provider
 * @param {string} modelId
 * @param {number} now
 * @param {ReadonlySet<string>} [exclude]
 * @returns {Array<Record<string, any>>}
 */
export function selectCandidates(accounts, provider, modelId, now, exclude) {
  return accounts.filter(entry => entry.provider === provider
    && entry.enabled !== false
    && (exclude === undefined || !exclude.has(entry.id))
    && !isCoolingDown(entry, modelId, now))
}

/**
 * Prove that every enabled account of a provider is cooling down for this model.
 *
 * This exists to fix a specific wrong diagnosis. When a provider has exactly one
 * account and that account is cooling down, the candidate set is empty and the caller
 * ends up telling the user to log in again — while the credential is perfectly fine
 * and the account is enabled. Returning the earliest release time lets the caller say
 * "every account is limited for this model until X" instead.
 *
 * Both boundaries are narrow on purpose:
 * - An empty `modelId` returns undefined, matching the selection rule that an unknown
 *   model applies no filter. Without this, a stray `modelRateLimits['']` written by a
 *   caller that did not validate its input would be reported as a real limit.
 * - A single account without a live stamp disproves the claim, because then the
 *   candidate set was never empty and this function has nothing to say.
 *
 * @param {readonly Record<string, any>[]} accounts - already filtered to enabled rows
 * @param {string} modelId
 * @param {number} now
 * @returns {undefined | { resetAtMs: number, accountCount: number }}
 */
export function allAccountsCoolingDownForModel(accounts, modelId, now) {
  if (modelId.length === 0) return undefined
  let earliest
  for (const entry of accounts) {
    if (!isCoolingDown(entry, modelId, now)) return undefined
    const resetAt = entry.modelRateLimits[modelId]
    earliest = earliest === undefined ? resetAt : Math.min(earliest, resetAt)
  }
  return earliest === undefined ? undefined : { resetAtMs: earliest, accountCount: accounts.length }
}

/**
 * Record a cooldown, keeping whichever deadline is later.
 *
 * Only-extend is deliberate. Every provider's rate-limit parser ends in a fallback
 * when it cannot read a duration, and that fallback is short (an hour, say) while the
 * real wait can be most of a day. Without this rule the same account/model pair gets
 * its true deadline overwritten by the fallback of a request that merely arrived
 * later, and the user watches a countdown that expires into the same failure.
 *
 * A non-finite incoming value is rejected outright: stored, it would compare false
 * against every later `now`, parking the model permanently with no way to sweep it out.
 *
 * @param {Record<string, any>} entry
 * @param {string} modelId
 * @param {number} resetAtMs
 * @returns {undefined | Record<string, any>} the updated row, or undefined for no change
 */
export function withCooldown(entry, modelId, resetAtMs) {
  if (modelId.length === 0) return undefined
  if (typeof resetAtMs !== 'number' || !Number.isFinite(resetAtMs)) return undefined
  const current = entry.modelRateLimits?.[modelId]
  // Equal is also a no-op: nothing to gain, one write saved.
  if (typeof current === 'number' && Number.isFinite(current) && current >= resetAtMs) return undefined
  return {
    ...entry,
    modelRateLimits: { ...(entry.modelRateLimits ?? {}), [modelId]: resetAtMs },
  }
}

/**
 * Drop expired cooldown stamps.
 *
 * Expired stamps are already ignored at selection time, so this is housekeeping, not
 * correctness: it keeps the document from growing without bound.
 *
 * @param {readonly Record<string, any>[]} accounts
 * @param {number} now
 * @returns {undefined | Array<Record<string, any>>} updated list, or undefined for no change
 */
export function sweepExpiredCooldowns(accounts, now) {
  let changed = false
  const next = accounts.map(entry => {
    if (entry.modelRateLimits === undefined) return entry
    const limits = { ...entry.modelRateLimits }
    for (const [modelId, resetAt] of Object.entries(limits)) {
      if (resetAt > 0 && now >= resetAt) {
        delete limits[modelId]
        changed = true
      }
    }
    if (!changed) return entry
    const normalized = normalizeRateLimits(limits)
    const updated = { ...entry }
    if (normalized === undefined) delete updated.modelRateLimits
    else updated.modelRateLimits = normalized
    return updated
  })
  return changed ? next : undefined
}

/**
 * Monotonic counter update: record `next` only when it moves forward.
 *
 * Used for the two generation counters the index carries (TRAE check-in device
 * generation and OpenCode fingerprint generation). Out-of-order or repeated callbacks
 * writing a smaller value would let a rotated identity revert to the one that was
 * already rate-limited, which looks to the user like the rotation did nothing.
 *
 * @param {number} current
 * @param {number} next
 * @returns {boolean} whether the value should be written
 */
export function shouldAdvanceCounter(current, next) {
  if (typeof next !== 'number' || !Number.isFinite(next) || next <= 0) return false
  const base = typeof current === 'number' && Number.isFinite(current) && current > 0 ? current : 0
  return next > base
}

/**
 * Milliseconds until the next UTC+8 midnight.
 *
 * Qoder settles "daily count" on the server's calendar, and that calendar is UTC+8 —
 * confirmed independently by its daily-reward copy. Computing the boundary with
 * `Date#setHours` would use the *local* zone and produce a wrong release time whenever
 * the user travels or changes their clock: too far east and the stamp expires early
 * (the user hits the wall again immediately), too far west and they wait hours for
 * nothing.
 *
 * Arithmetic rather than a timezone database: the requirement is one fixed offset, and
 * a literal is more predictable and trivially testable.
 *
 * @param {number} nowMs
 * @returns {number} the UTC+8 next-midnight instant, strictly greater than `nowMs`
 */
export function nextUtc8DayStartMs(nowMs) {
  const OFFSET = 8 * 3_600_000
  const DAY = 86_400_000
  const shifted = nowMs + OFFSET
  const msIntoDay = ((shifted % DAY) + DAY) % DAY
  return nowMs + (DAY - msIntoDay)
}
