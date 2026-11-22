/**
 * LobsterAI channel: error classification and retry policy.
 *
 * ## Why the classification order is the interesting part
 *
 * This provider reports an exhausted allowance as **HTTP 400 with a Chinese body**, not
 * as 402. Classifying by status code first therefore files it under "client error",
 * which is retryable, and the retry loop keeps hammering an account that cannot succeed.
 * So body keywords outrank status codes — except 402, which is unambiguous and checked
 * first because a payment-required status can never mean anything else.
 *
 * Two more orderings are load-bearing:
 *
 * - A banned account is checked before a dead session. Both mean "stop using this
 *   account", but a ban cannot be recovered by logging in again, and getting it wrong
 *   sends the user through a pointless re-login.
 * - The in-band classifier (errors delivered as a frame inside HTTP 200) cannot use any
 *   status branch, because the status is always 200. It reuses only the keyword half and
 *   defaults the remainder to "rotate" rather than "none", since an in-band error is a
 *   definite failure of this account for this request.
 *
 * @module src/accounts/providers/lobsterai/errors
 */

/** Kinds this provider's classifier can return. */
export const LOBSTERAI_KINDS = Object.freeze([
  'hard-credit', 'banned', 'session-dead', 'soft-rate', 'not-found', 'server', 'client', 'none',
])

/**
 * Wording that means the allowance is spent.
 *
 * Kept as explicit phrases rather than bare words: "quota" and "balance" appear in
 * ordinary model output, and matching them would turn a normal answer into a rotation.
 */
const HARD_CREDIT_MARKERS = Object.freeze([
  'insufficient balance', 'insufficient credit', 'credit exhausted', 'quota exceeded',
  'payment required', 'no remaining quota', '积分不足', '余额不足', '额度不足', '额度已用完',
])

/** Wording that means the account is disabled by risk control. */
const BANNED_MARKERS = Object.freeze([
  'account suspended', 'account disabled', 'account banned', 'risk control',
  '违反', '异常行为', '已被限制使用', '账号存在异常', '账号已被限制', '风控',
])

/** Markers that mean the session itself is gone and a re-login is required. */
const SESSION_DEAD_MARKERS = Object.freeze(['40100', '40101', 'token rejected', 'refresh token was rejected'])

/**
 * Classify an HTTP response.
 *
 * @param {number} status
 * @param {string} body
 * @returns {string} one of {@link LOBSTERAI_KINDS}
 */
export function classifyHttp(status, body) {
  // 402 first: the status alone settles it, and no body keyword can override a
  // payment-required status with something weaker.
  if (status === 402) return 'hard-credit'

  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard-credit'
  }
  // Ban before dead session: a ban needs no re-login and must not be retried either way,
  // but reporting it as a dead session sends the user to a login that cannot help.
  for (const marker of BANNED_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'banned'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session-dead'
  }

  if (status === 429) return 'soft-rate'
  if (status === 404) return 'not-found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'none'
}

/**
 * Classify an error delivered inside a successful HTTP response.
 *
 * The status is 200 by definition here, so every status branch in {@link classifyHttp}
 * is inert. That leaves the keywords, and the residual case must become a rotation
 * trigger: an in-band error frame is a definite failure of this attempt, and treating it
 * as `none` would surface it to the user while other accounts were still available.
 *
 * @param {string} message
 * @returns {string}
 */
export function classifyInBand(message) {
  const byKeyword = classifyHttp(200, message)
  return byKeyword === 'none' ? 'client' : byKeyword
}

/**
 * Should this kind move to the next account?
 *
 * Everything except a clean response rotates. That mirrors the reference behaviour where
 * every non-success branch continues to the next account rather than returning, and it is
 * deliberate: returning early on one account's transient failure is how a request fails
 * while capacity is sitting idle.
 *
 * @param {string} kind
 * @returns {boolean}
 */
export function shouldRotate(kind) {
  return kind !== 'none'
}

/**
 * Should this kind record a per-model cooldown badge?
 *
 * Only kinds that genuinely mean "this model is limited for this account". A 5xx or a
 * generic client error rotates without a badge: the badge's meaning is "this model is
 * restricted", and recording it for a transient fault hides usable capacity for an hour.
 *
 * @param {string} kind
 * @returns {boolean}
 */
export function recordsCooldown(kind) {
  return kind === 'hard-credit' || kind === 'soft-rate' || kind === 'not-found' || kind === 'banned'
}

/**
 * Is this kind terminal for the credential (as opposed to the request)?
 *
 * A dead session needs a refresh before any request can succeed; the others do not.
 *
 * @param {string} kind
 * @returns {boolean}
 */
export function isCredentialTerminal(kind) {
  return kind === 'session-dead'
}

/** How many requests one turn may make, including the first. */
export const MAX_ATTEMPTS = 3

/** Cooldown when the provider gives no usable reset time. */
export const COOLDOWN_FALLBACK_MS = 3_600_000
