/**
 * Loomy channel: product constants, quota detection, and balance-based account ranking.
 *
 * ## Two facts that shape everything here
 *
 * **There is no refresh endpoint.** `refreshable` is always false, and "refresh" means
 * probing whether the stored token still works. Reporting it as refreshable would put a
 * retry path in place that can never succeed.
 *
 * **Balances expire, and some do not.** The account carries a daily allowance that resets
 * and a permanent balance that does not. When the user locks permanent credits, an account
 * with only permanent credit must be treated as unusable — spending it is irreversible and
 * is exactly what the lock exists to prevent.
 *
 * ## Why the balance response envelope matters
 *
 * Business failures arrive as HTTP 200 with a `code` field. `000000` is success and
 * `100002` is an auth failure that must not be retried, because the token is dead rather
 * than expired. Treating the HTTP status as the verdict would read every one of these as a
 * success with an empty body.
 *
 * @module src/accounts/providers/loomy/product
 */

import { ACCOUNT_ERROR_CODES } from '../../core/errors.js'

export const PROVIDER_ID = 'loomy'

export const HOSTS = Object.freeze({
  api: 'https://loomyad.xunfei.cn/api/v1',
  account: 'https://account.xfinfr.com',
})

export const PATHS = Object.freeze({
  chat: '/chat/completions',
  models: '/models',
  pointsRecords: '/points/records',
  dailyClaim: '/points/first-login',
  sendSms: '/login/phone/sendMsgCode',
  verifySms: '/login/phone/checkCode',
})

/** The business-envelope codes. */
export const OK_CODE = '000000'
export const AUTH_DEAD_CODE = '100002'

export const DEFAULT_CREDENTIAL_REF = 'LOOMY_ACCESS_TOKEN'

/** The effort menu every fallback row declares. */
export const EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh'])

/** The preferred default when a model offers it. */
export const PREFERRED_DEFAULT_EFFORT = 'high'

/**
 * The static catalog. `name` carries the provider's own credit multiplier as a suffix,
 * which is display information the remote listing also supplies.
 *
 * No `supportsImage` and no `maxTokens`: the static table declares neither, and the
 * fallback projection hard-codes `supportsImage: false`, so a fallback-only model never
 * claims image input it has not been shown to accept.
 */
export const FALLBACK_MODELS = Object.freeze([
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731 · x3.0', contextWindow: 1_048_576, efforts: [...EFFORTS], defaultEffort: PREFERRED_DEFAULT_EFFORT },
  { id: 'MiniMax-M3', name: 'MiniMax M3 · x4.0', contextWindow: 1_048_576, efforts: [...EFFORTS], defaultEffort: PREFERRED_DEFAULT_EFFORT },
  { id: 'Kimi-k2.6', name: 'Kimi k2.6 · x6.5', contextWindow: 262_144, efforts: [...EFFORTS], defaultEffort: PREFERRED_DEFAULT_EFFORT },
  { id: 'qwen-3.8-max', name: 'Qwen 3.8 Max · x12.0', contextWindow: 1_000_000, efforts: [...EFFORTS], defaultEffort: PREFERRED_DEFAULT_EFFORT },
  { id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash · x0.8', contextWindow: 1_048_576, efforts: [...EFFORTS], defaultEffort: PREFERRED_DEFAULT_EFFORT },
  { id: 'qwen3.8-flash', name: 'qwen 3.8 flash · x0.8', contextWindow: 1_000_000, efforts: [...EFFORTS], defaultEffort: PREFERRED_DEFAULT_EFFORT },
  { id: 'spark-x', name: 'Spark X2.5 · x0.1', contextWindow: 1_048_576, efforts: [...EFFORTS], defaultEffort: PREFERRED_DEFAULT_EFFORT },
  { id: 'mimo-v2.5', name: 'MiMo V2.5 · x3.3', contextWindow: 1_048_576, efforts: [...EFFORTS], defaultEffort: PREFERRED_DEFAULT_EFFORT },
])

/**
 * Does this payload say the allowance is spent?
 *
 * Two signals: a `402` business code, and the insufficient-funds wording. The wording is
 * checked because the provider does not always send the code, and the code is checked
 * because the wording is localised.
 *
 * @param {unknown} value - a parsed body or an error frame
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
 * Read the business envelope.
 *
 * @param {unknown} body
 * @returns {{ ok: boolean, code: string, authDead: boolean, data: unknown }}
 */
export function readEnvelope(body) {
  if (body === null || typeof body !== 'object') return { ok: false, code: '', authDead: false, data: undefined }
  const code = typeof body.code === 'string' ? body.code : typeof body.code === 'number' ? String(body.code) : ''
  return {
    ok: code === OK_CODE,
    code,
    authDead: code === AUTH_DEAD_CODE,
    data: body.data ?? body.result,
  }
}

/**
 * Rank accounts by which balance they can spend.
 *
 * Tiers, best first:
 * 0. daily balance available — spending it is free in the sense that it expires anyway;
 * 1. permanent balance only, and permanent spending is allowed;
 * 2. permanent balance only, but permanent spending is locked — usable only if nothing
 *    better exists, and the caller must know it is a last resort.
 *
 * Ranking is stable within a tier so the user's manual order still decides ties.
 *
 * @param {Array<{ id: string, balance?: number | null, dailyBalance?: number | null }>} accounts
 * @param {{ allowPermanent: boolean }} options
 * @returns {Array<{ id: string, tier: number, balance: number, dailyBalance: number }>}
 */
export function rankByBalance(accounts, { allowPermanent }) {
  const ranked = accounts.map((account, index) => {
    const daily = typeof account.dailyBalance === 'number' && Number.isFinite(account.dailyBalance) ? account.dailyBalance : 0
    const permanent = typeof account.balance === 'number' && Number.isFinite(account.balance) ? account.balance : 0
    let tier
    if (daily > 0) tier = 0
    else if (permanent > 0 && allowPermanent) tier = 1
    else if (permanent > 0) tier = 2
    else tier = 3 // nothing to spend
    return { id: account.id, tier, balance: permanent, dailyBalance: daily, index }
  })
  return ranked
    .filter(entry => entry.tier < 3)
    .sort((a, b) => (a.tier - b.tier) || (a.index - b.index))
    .map(({ index, ...rest }) => rest)
}

/**
 * Classify a failure for the shared channel.
 *
 * A `100002` envelope is auth-dead: the token is not expired, it is revoked, so a refresh
 * cannot help and the user must log in again.
 *
 * @param {number} status
 * @param {string} body
 * @returns {string}
 */
export function classifyHttp(status, body) {
  if (status === 402) return 'quota-exceeded'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'soft-rate'
  if (status >= 500) return 'server'
  if (status >= 400) {
    let parsed
    try { parsed = JSON.parse(body) } catch { return 'client' }
    const envelope = readEnvelope(parsed)
    if (envelope.authDead) return 'auth-dead'
    if (isQuotaError(parsed)) return 'quota-exceeded'
    return 'client'
  }
  return 'none'
}

/**
 * In-band classification. The quota predicate is supplied to the shared consumer, so this
 * only has to handle what is left.
 */
export function classifyInBand(message) {
  if (/积分不足|余额不足|insufficient[_\s]+(?:points|balance|credits)/i.test(message)) return 'quota-exceeded'
  return 'server'
}

/**
 * Only a spent allowance rotates.
 *
 * A 429 is a rate limit, not an exhaustion, and rotating on it would spend another
 * account's allowance on a problem that waiting solves. Auth failures need the user, so
 * rotating would just fail on the next account too.
 */
export function shouldRotate(kind) {
  return kind === 'quota-exceeded'
}

/** A spent allowance cools the model until the daily boundary. */
export function recordsCooldown(kind) {
  return kind === 'quota-exceeded'
}

export function mapErrorCode(status, body, kind) {
  if (kind === 'quota-exceeded') return ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED
  if (kind === 'auth' || kind === 'auth-dead') return ACCOUNT_ERROR_CODES.AUTH
  if (kind === 'soft-rate' || status === 429) return ACCOUNT_ERROR_CODES.RATE_LIMIT
  if (kind === 'server' || status >= 500) return ACCOUNT_ERROR_CODES.SERVER
  return ACCOUNT_ERROR_CODES.INVALID_REQUEST
}

/**
 * Read a balance payload, keeping "unknown" distinct from zero.
 *
 * A failed query returns null rather than 0: zero would mean "this account has nothing",
 * which is a different and much worse conclusion than "we could not ask".
 *
 * @param {unknown} payload
 * @returns {null | { balance: number, dailyBalance: number, availableBalance: number }}
 */
export function readBalance(payload) {
  const envelope = readEnvelope(payload)
  if (!envelope.ok || envelope.data === null || typeof envelope.data !== 'object') return null
  const data = /** @type {Record<string, unknown>} */ (envelope.data)
  const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    balance: num(data.balance),
    dailyBalance: num(data.dailyBalance),
    availableBalance: num(data.availableBalance),
  }
}

/**
 * Resolve the effort to send for a model.
 *
 * Only an effort the model actually declares is sent; anything else would be a value the
 * provider may reject. When the preferred default is available it wins over the row's own
 * default, because that is the level this channel has been tuned against.
 *
 * @param {Record<string, any>} model
 * @param {string | undefined} requested
 * @returns {string | undefined}
 */
export function resolveEffort(model, requested) {
  const menu = Array.isArray(model?.efforts) ? model.efforts : []
  if (requested !== undefined && menu.includes(requested)) return requested
  if (menu.includes(PREFERRED_DEFAULT_EFFORT)) return PREFERRED_DEFAULT_EFFORT
  // The row's own default is only usable when the row declares it *and* the menu contains
  // it; otherwise sending it would be a value the provider never offered.
  if (typeof model?.defaultEffort === 'string' && menu.includes(model.defaultEffort)) return model.defaultEffort
  // No usable level: send nothing. An absent field lets the provider apply its own default,
  // which is always valid, whereas a guessed level may not be.
  return undefined
}

/**
 * Project the static table into the same shape a remote row would take.
 *
 * The image flag is `false`, not absent, because that is what the fallback path has always
 * reported and a caller uses it to decide whether to project images into text.
 *
 * @returns {Array<Record<string, any>>}
 */
export function fallbackAsRemote() {
  return FALLBACK_MODELS.map(row => ({
    ...row,
    supportsImage: false,
    supportsThinking: true,
  }))
}
