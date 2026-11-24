/**
 * Raccoon channel: product constants, quota detection and the two-state thinking switch.
 *
 * ## Thinking is a switch here, not a level menu
 *
 * Every other channel on this wire exposes a set of effort levels. This one exposes on/off,
 * carried in `extra_body.thinking`. Offering levels would be inventing a menu the provider
 * never published, and a caller picking "medium" would silently get on.
 *
 * ## The 402 shape arrives two ways
 *
 * As an HTTP status and as a `code: "402"` inside a success-status body. Only checking the
 * status leaves the in-band form classified as a server error, which the harness then
 * retries against an account that is out of credit.
 *
 * @module src/accounts/providers/raccoon/product
 */

import { ACCOUNT_ERROR_CODES } from '../../core/errors.js'

export const PROVIDER_ID = 'raccoon'

export const HOSTS = Object.freeze({
  api: 'https://xiaohuanxiong.com',
})

export const PREFIXES = Object.freeze({
  auth: '/api/web/auth/v1',
  llm: '/api/web/llm/v2',
  points: '/api/web/points/v1',
})

export const PATHS = Object.freeze({
  chat: `${PREFIXES.llm}/chat/completions`,
  modelCatalog: `${PREFIXES.llm}/model_catalog`,
  refresh: `${PREFIXES.auth}/refresh`,
  userInfo: `${PREFIXES.auth}/user_info`,
  balance: `${PREFIXES.points}/balance`,
})

export const DEFAULT_CREDENTIAL_REF = 'RACCOON_ACCESS_TOKEN'

/** The two thinking states. There is no level menu. */
export const THINKING_ON = 'on'
export const THINKING_OFF = 'off'
export const THINKING_STATES = Object.freeze([THINKING_ON, THINKING_OFF])
export const DEFAULT_THINKING = THINKING_ON

/** How long before expiry a refresh is attempted. */
export const REFRESH_WINDOW_MS = 300_000

/**
 * The static catalog.
 *
 * All six rows declare image support: this provider's own catalog does, and the adapter's
 * image overrides add the two that the tag scan would otherwise miss.
 */
export const FALLBACK_MODELS = Object.freeze([
  { id: 'sn-sensenova-6-8-flash', name: 'SenseNova-6.8-Flash · 免费', contextWindow: 256_000, maxTokens: 63_999, supportsImage: true },
  { id: 'sn-sensenova-6-8-flash-lite', name: 'SenseNova-6.8-Flash-Lite · 免费', contextWindow: 256_000, maxTokens: 63_999, supportsImage: true },
  { id: 'sn-glm-5-3', name: 'GLM-5-3 · x0.75', contextWindow: 1_000_000, maxTokens: 100_000, supportsImage: true },
  { id: 'sn-kimi-k3', name: 'Kimi-K3 · x1', contextWindow: 1_000_000, maxTokens: 100_000, supportsImage: true },
  { id: 'sn-glm-5-3-flash', name: 'GLM-5-3-Flash · x0.2→x0.1', contextWindow: 1_000_000, maxTokens: 100_000, supportsImage: true },
  { id: 'sn-deepseek-v4-1-flash', name: 'DeepSeek-V4.1-Flash · x0.25', contextWindow: 1_000_000, maxTokens: 100_000, supportsImage: true },
])

/**
 * Models whose image support the tag scan would miss.
 *
 * The catalog tags are the primary signal, but these two are known to accept images while
 * their tags do not say so. Adding them here is a fact about the provider, not a guess.
 */
export const IMAGE_CAPABILITY_OVERRIDES = Object.freeze([
  'sn-deepseek-v4-1-flash',
  'sn-glm-5-3-flash',
])

/**
 * Does this model accept image input?
 *
 * @param {string} id
 * @param {readonly string[]} [tags]
 * @returns {boolean}
 */
export function supportsImage(id, tags) {
  if (IMAGE_CAPABILITY_OVERRIDES.includes(id)) return true
  if (!Array.isArray(tags)) return FALLBACK_MODELS.some(row => row.id === id && row.supportsImage === true)
  return tags.some(tag => ['vision', 'image', 'image-understanding'].includes(tag))
}

/**
 * Does this payload say the balance is spent?
 *
 * The `402` code is checked as a string and as a number because the provider sends both
 * forms in different endpoints.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isQuotaError(value) {
  if (value === null || typeof value !== 'object') return false
  const record = /** @type {Record<string, unknown>} */ (value.error ?? value)
  if (record === null || typeof record !== 'object') return false
  const code = /** @type {Record<string, unknown>} */ (record).code
  if (String(code) === '402') return true
  const message = /** @type {Record<string, unknown>} */ (record).message ?? /** @type {Record<string, unknown>} */ (record).msg
  if (typeof message !== 'string') return false
  return /积分不足|余额不足|insufficient[_\s]+(?:points|balance|credits)/i.test(message)
}

/**
 * Map a thinking request onto the wire value.
 *
 * @param {string | undefined} requested
 * @returns {'enabled' | 'disabled'}
 */
export function thinkingType(requested) {
  return requested === THINKING_OFF ? 'disabled' : 'enabled'
}

export function classifyHttp(status, body) {
  if (status === 402) return 'quota-exceeded'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'soft-rate'
  if (status >= 500) return 'server'
  if (status >= 400) {
    let parsed
    try { parsed = JSON.parse(body) } catch { return 'client' }
    if (isQuotaError(parsed)) return 'quota-exceeded'
    return 'client'
  }
  return 'none'
}

/** The quota predicate is supplied to the shared consumer, so only the residue is here. */
export function classifyInBand(message) {
  if (/积分不足|余额不足|insufficient[_\s]+(?:points|balance|credits)/i.test(message)) return 'quota-exceeded'
  return 'server'
}

/** Only a spent balance rotates: a 429 is a window, not an exhaustion. */
export function shouldRotate(kind) {
  return kind === 'quota-exceeded'
}

export function recordsCooldown(kind) {
  return kind === 'quota-exceeded'
}

export function mapErrorCode(status, body, kind) {
  if (kind === 'quota-exceeded') return ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED
  if (kind === 'auth') return ACCOUNT_ERROR_CODES.AUTH
  if (kind === 'soft-rate' || status === 429) return ACCOUNT_ERROR_CODES.RATE_LIMIT
  if (kind === 'server' || status >= 500) return ACCOUNT_ERROR_CODES.SERVER
  return ACCOUNT_ERROR_CODES.INVALID_REQUEST
}

/**
 * Is this credential refreshable?
 *
 * True only when a non-empty refresh token is present. Reporting a credential refreshable
 * without one puts a retry path in place that cannot succeed and hides the real remedy,
 * which is a fresh login.
 *
 * @param {unknown} credential
 * @returns {boolean}
 */
export function isRefreshable(credential) {
  return typeof credential?.refresh_token === 'string' && credential.refresh_token.length > 0
}

/**
 * Resolve the image flag for a remote catalog row.
 *
 * @param {{ id: string, tags?: string[] }} row
 * @returns {boolean}
 */
export function resolveImageCapability(row) {
  return supportsImage(row.id, row.tags)
}
