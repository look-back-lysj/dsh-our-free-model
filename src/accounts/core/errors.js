/**
 * Error vocabulary shared by the account core.
 *
 * The channel pack reports failures to the harness through a small set of stable
 * codes, and the harness's retry policy keys off those codes. Getting a code wrong
 * is not cosmetic: a quota exhaustion reported as a retryable server error burns
 * the user's remaining attempts on an account that cannot possibly succeed, and a
 * queue condition reported as a hard failure surfaces a temporary wait as a
 * permanent defect.
 *
 * So this module owns the codes as frozen data, not as scattered string literals.
 *
 * @module src/accounts/core/errors
 */

/** Codes the account core itself raises. Adapters add their own on top. */
export const ACCOUNT_ERROR_CODES = Object.freeze({
  /** Nothing usable is configured or every candidate is unusable. */
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  /** The provider refused the credential and a refresh did not help. */
  AUTH: 'AUTH',
  /** The provider put this request in a queue; waiting and retrying is correct. */
  QUEUE: 'QUEUE',
  /** The account's allowance for this model is spent; waiting will not help today. */
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  /** Too many requests in a window; a short wait may help. */
  RATE_LIMIT: 'RATE_LIMIT',
  /** The connection failed or stalled; retrying may help. */
  TRANSPORT: 'TRANSPORT',
  /** The upstream failed on its own side; retrying elsewhere may help. */
  SERVER: 'SERVER',
  /** The request itself is malformed; retrying will not help. */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** The caller aborted while waiting for a slot. */
  ABORTED: 'ABORTED',
})

/**
 * An account-core failure carrying a stable `code`.
 *
 * The shape is deliberately minimal — `code`, optional `status`, optional
 * `retryAfterMs` — because that is all any caller reads. `cause` is preserved for
 * diagnostics but never inspected by control flow, so a wrapped error can never
 * change how a failure is classified.
 */
export class AccountError extends Error {
  /**
   * @param {string} message - human-readable, already provider-prefixed by the caller
   * @param {string} code - one of {@link ACCOUNT_ERROR_CODES} or a provider code
   * @param {{ status?: number, retryAfterMs?: number, cause?: unknown }} [details]
   */
  constructor(message, code, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'AccountError'
    this.code = code
    if (details.status !== undefined) this.status = details.status
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs
  }
}

/** Raised when a provider declares the request queued; carries the suggested wait. */
export class ModelQueuedError extends AccountError {
  /**
   * @param {string} message
   * @param {{ queueInfo?: Record<string, unknown>, retryAfterMs?: number }} [details]
   */
  constructor(message, details = {}) {
    super(message, ACCOUNT_ERROR_CODES.QUEUE, details.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: details.retryAfterMs })
    this.name = 'ModelQueuedError'
    this.queueInfo = Object.freeze({ ...(details.queueInfo ?? {}) })
  }
}

/** Raised when a waiting caller aborts before its slot opens. */
export class SlotAbortedError extends AccountError {
  constructor(message = 'request aborted while waiting for a slot') {
    super(message, ACCOUNT_ERROR_CODES.ABORTED)
    this.name = 'SlotAbortedError'
  }
}

/**
 * True when a thrown value is one of this module's errors with the given code.
 *
 * Accepts any object with `code`, so an adapter that raises its own
 * `code`-bearing error is treated identically to one from here.
 *
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
export function hasCode(error, code) {
  return typeof error === 'object' && error !== null && /** @type {any} */ (error).code === code
}
