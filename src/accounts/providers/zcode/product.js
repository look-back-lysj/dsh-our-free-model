/**
 * ZCode channel: product constants, captcha policy, and the ordered classifier.
 *
 * ## Captcha is fetched on demand, never prefetched
 *
 * The provider rejects with a `3007` code when it wants a captcha. Acquiring one
 * speculatively on the first request of a turn spends a browser automation slot on the
 * majority of turns that never needed one. So the first attempt of a turn sends no captcha,
 * and a mint happens only when this account and model are *known* to require one, or when
 * this attempt was actually rejected.
 *
 * The "known required" memory is process-scoped, keyed by account and model, short-lived, and
 * cleared the moment a request succeeds without a captcha. Persisting it would carry a stale
 * requirement across restarts, and a shared key would make one model's requirement block
 * another's.
 *
 * ## The classifier has a fixed order, and 3007 comes first
 *
 * A captcha rejection is a rate-limit class, not a quota problem. Classifying it as quota
 * would cool the model for a day over something that resolves in seconds.
 *
 * @module src/accounts/providers/zcode/product
 */

import { ACCOUNT_ERROR_CODES } from '../../core/errors.js'

export const PROVIDER_ID = 'zcode'

export const HOSTS = Object.freeze({
  origin: 'https://zcode.z.ai',
  codingPlan: 'https://api.z.ai',
})

export const PATHS = Object.freeze({
  startPlanInfer: '/api/v1/zcode-plan/anthropic/v1/messages',
  codingPlanInfer: '/api/anthropic/v1/messages',
  balance: '/api/v1/zcode-plan/billing/balance',
  claim: '/api/v1/zcode-plan/billing/claim',
  oauthInit: '/api/v1/oauth/cli/init',
})

export const DEFAULT_CREDENTIAL_REF = 'ZCODE_ACCESS_TOKEN'

/** Captcha requirement TTL: long enough to cover a turn, short enough to self-heal. */
export const CAPTCHA_TTL_MS = 120_000

/** A response faster than this with no content is treated as a fast empty failure. */
export const FAST_EMPTY_MS = 3_000

/** The static catalog. */
export const FALLBACK_MODELS = Object.freeze([
  {
    id: 'GLM-5.3-Flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: true,
    reasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: 'max',
  },
  {
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: false,
    reasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: 'max',
  },
])

/** Product tuning, all of it behaviour the provider's own limits imply. */
export const TUNING = Object.freeze({
  requestTimeoutMs: 15 * 60_000,
  streamIdleTimeoutMs: 600_000,
  concurrencyRetryMax: 2,
  concurrencyRetryBaseMs: 1_500,
  quotaSwitchMax: 2,
  /** Per-model minimum dispatch gap; 0 means no extra wait. */
  modelGapMs: Object.freeze({ 'glm-5.3': 350, 'glm-5.3-flash': 0 }),
  toolCacheBreakpoint: true,
})

/** The level menu, in strength order, used when a remote row declares levels. */
export const LEVEL_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Sort a level list into strength order, keeping unknown ids at the end in their original
 * order.
 *
 * @param {readonly string[]} levels
 * @returns {string[]}
 */
export function sortLevels(levels) {
  const known = levels.filter(level => LEVEL_ORDER.includes(level))
    .slice()
    .sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b))
  const unknown = levels.filter(level => !LEVEL_ORDER.includes(level))
  return [...known, ...unknown]
}

/**
 * Does this body mean the allowance is spent?
 *
 * `3009` is excluded first: it is a concurrency signal, not an exhaustion, and treating it as
 * one would park the model for a day over a collision that clears in seconds.
 *
 * @param {number} status
 * @param {string} body
 * @returns {boolean}
 */
export function isQuotaExhausted(status, body) {
  if (body.includes('3009')) return false
  if (body.includes('1113') || body.includes('余额不足')) return true
  if (body.includes('1005')) return true
  return /exceed quota limit|quota (has been )?exhausted/i.test(body)
}

/**
 * Is this a captcha rejection?
 *
 * @param {string} body
 * @returns {boolean}
 */
export function isCaptchaRejected(body) {
  return body.includes('3007')
}

/**
 * Is this a concurrency collision, which is retried in place rather than rotated?
 *
 * @param {string} body
 * @returns {boolean}
 */
export function isConcurrencyLimited(body) {
  return body.includes('3009')
}

/**
 * Is this an unusual-activity block, which is a permission problem?
 *
 * @param {string} body
 * @returns {boolean}
 */
export function isUnusualActivity(body) {
  return /unusual activity|异常活动|risk control/i.test(body)
}

/**
 * The ordered classifier.
 *
 * @param {number} status
 * @param {string} body
 * @returns {string}
 */
export function classifyHttp(status, body) {
  // Captcha first: it is a rate class, and reading it as quota parks the model for a day.
  if (isCaptchaRejected(body)) return 'captcha'
  if (isUnusualActivity(body)) return 'permission'
  if (body.includes('1113') || body.includes('余额不足')) return 'quota-exceeded'
  if (status === 401 || body.includes('1002')) return 'auth'
  if (status === 429) return 'soft-rate'
  if (status >= 500) return 'server'
  if (status === 400) return 'client'
  return 'server'
}

/**
 * In-band classification: an error event is a rate class, everything else a server error.
 *
 * @param {string} eventType
 * @returns {string}
 */
export function classifyInBand(eventType) {
  return eventType === 'overloaded_error' ? 'soft-rate' : 'server'
}

/** Only an exhausted allowance rotates the account. */
export function shouldRotate(kind) {
  return kind === 'quota-exceeded'
}

export function recordsCooldown(kind) {
  return kind === 'quota-exceeded'
}

export function mapErrorCode(status, body, kind) {
  if (kind === 'quota-exceeded') return ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED
  if (kind === 'auth') return ACCOUNT_ERROR_CODES.AUTH
  if (kind === 'permission') return 'PERMISSION_DENIED'
  if (kind === 'captcha' || kind === 'soft-rate') return ACCOUNT_ERROR_CODES.RATE_LIMIT
  if (kind === 'server' || status >= 500) return ACCOUNT_ERROR_CODES.SERVER
  return ACCOUNT_ERROR_CODES.INVALID_REQUEST
}

/**
 * The captcha requirement memory.
 *
 * Deliberately in-process and short-lived: a persisted flag would outlive the condition, and
 * a global flag would make one model's requirement gate every model.
 */
export class CaptchaRequirements {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now]
   * @param {number} [options.ttlMs]
   */
  constructor({ now = () => Date.now(), ttlMs = CAPTCHA_TTL_MS } = {}) {
    this.now = now
    this.ttlMs = ttlMs
    /** @type {Map<string, number>} */
    this.entries = new Map()
  }

  /** @param {string} accountId @param {string} model */
  static key(accountId, model) {
    return `${accountId}|${model}`
  }

  /**
   * Is a captcha known to be required for this account and model?
   *
   * @param {string} accountId
   * @param {string} model
   * @returns {boolean}
   */
  required(accountId, model) {
    const key = CaptchaRequirements.key(accountId, model)
    const at = this.entries.get(key)
    if (at === undefined) return false
    if (this.now() >= at) {
      this.entries.delete(key)
      return false
    }
    return true
  }

  /** Record that a rejection proved a captcha is needed. */
  markRequired(accountId, model) {
    this.entries.set(CaptchaRequirements.key(accountId, model), this.now() + this.ttlMs)
  }

  /** Clear the requirement after a request succeeds without one. */
  clear(accountId, model) {
    this.entries.delete(CaptchaRequirements.key(accountId, model))
  }

  /** How many entries are currently live (diagnostics). */
  size() {
    for (const [key, at] of this.entries) if (this.now() >= at) this.entries.delete(key)
    return this.entries.size
  }
}

/**
 * Build the system blocks for a request.
 *
 * The identity block is separated from the caller's own system text so a provider-side change
 * to the identity copy does not have to be threaded through the caller's prompt.
 *
 * @param {string[]} system
 * @returns {Array<{ type: string, text: string }>}
 */
export function buildSystemBlocks(system) {
  return system
    .filter(text => typeof text === 'string' && text.length > 0)
    .map(text => ({ type: 'text', text }))
}

/**
 * Map a stop reason.
 *
 * @param {unknown} reason
 * @param {boolean} sawToolUse
 * @returns {string}
 */
export function mapStopReason(reason, sawToolUse) {
  if (sawToolUse) return 'tool-calls'
  if (reason === 'max_tokens') return 'max-tokens'
  return 'stop'
}
