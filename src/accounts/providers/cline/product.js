/**
 * Cline channel: product constants, catalog merge, and error classification.
 *
 * ## The catalog is a merge, and the order matters
 *
 * Four sources describe Cline's models and they disagree:
 *
 * 1. the curated static table — the only source with trustworthy `contextWindow`,
 *    `maxTokens` and `supportsImage`;
 * 2. an anonymous "recommended models" listing, whose `free` array is the authoritative
 *    statement of what is currently free;
 * 3. the account-scoped `/models` listing, which carries ids only;
 * 4. models.dev, which fills gaps but must never override.
 *
 * The merge keeps the static table for rows the remote still knows (so a retired model
 * disappears), then adds remote-only rows, then lets models.dev fill missing metadata. An
 * override from a lower-priority source would replace curated facts with guesses.
 *
 * ## Region blocking is not an auth failure
 *
 * A 403 whose body says the service is unavailable in your region cannot be fixed by
 * refreshing a token. Retrying it or refreshing is wasted work and the error message then
 * blames the credential. It is checked first, and reported as a permission problem.
 *
 * @module src/accounts/providers/cline/product
 */

import { AccountError, ACCOUNT_ERROR_CODES } from '../../core/errors.js'

export const PROVIDER_ID = 'cline'

export const HOSTS = Object.freeze({
  api: 'https://api.cline.bot',
  workos: 'https://api.workos.com',
  modelsDev: 'https://models.dev/api.json',
})

export const PATHS = Object.freeze({
  chat: '/api/v1/chat/completions',
  models: '/api/v1/models',
  recommended: '/api/v1/ai/cline/recommended-models',
  deviceAuthorize: '/user_management/authorize/device',
  deviceToken: '/user_management/authenticate',
  register: '/api/v1/auth/register',
  refresh: '/api/v1/auth/refresh',
  planUsage: '/api/v1/users/me/plan/usage-limits',
})

/** Client identity the provider expects; the referer is what its own SDK sends. */
export const CLIENT_HEADERS = Object.freeze({
  'HTTP-Referer': 'https://cline.bot',
  'X-Title': 'Cline',
  'X-IS-MULTIROOT': 'false',
  'X-CLIENT-TYPE': 'cline-sdk',
})

/** Reasoning levels are provider-wide here, not per model. */
export const REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'max'])
export const DEFAULT_REASONING_EFFORT = 'high'

/** Hard ceiling the provider accepts for `max_tokens`. */
export const MAX_OUTPUT_TOKENS = 943_718

/** Credential ref for the single-credential fallback. */
export const DEFAULT_CREDENTIAL_REF = 'CLINE_ACCESS_TOKEN'

/**
 * The curated table. The only source with reliable capability metadata.
 */
export const FALLBACK_MODELS = Object.freeze([
  {
    id: 'stealth/space-bunny-alpha',
    name: 'Space Bunny Alpha',
    contextWindow: 1_000_000,
    maxTokens: 524_288,
    supportsImage: true,
    isFree: true,
  },
  {
    id: 'cline-free/mimo-v2.6-flash',
    name: 'MiMo-V2.6-Flash',
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    supportsImage: true,
    isFree: true,
  },
  {
    id: 'cline-free/muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3 Contributor',
    contextWindow: 1_048_576,
    maxTokens: 943_718,
    supportsImage: true,
    isFree: true,
  },
])

/**
 * Is this model free by any of the provider's own signals?
 *
 * The union is deliberate: the remote `free` set is authoritative, but a row can also
 * declare itself with a `:free` suffix, a `cline-free/` prefix, or the curated table's
 * `isFree`. Any one of them is enough, because being wrong in the "free" direction shows
 * the user a model that costs money only after they pick it.
 *
 * @param {string} id
 * @param {boolean} [remoteFree]
 * @returns {boolean}
 */
export function isFreeModel(id, remoteFree) {
  if (remoteFree === true) return true
  if (id.endsWith(':free')) return true
  if (id.startsWith('cline-free/')) return true
  return FALLBACK_MODELS.some(row => row.id === id && row.isFree === true)
}

/**
 * Merge the catalog sources.
 *
 * @param {object} sources
 * @param {string[]} [sources.remoteFreeIds] - ids in the anonymous listing's `free` array
 * @param {string[]} [sources.remoteRecommended] - ids from `recommended` and `clinePass`
 * @param {string[]} [sources.remoteAllIds] - ids from the account-scoped listing
 * @param {Array<{ id: string, name?: string, contextWindow?: number, supportsImage?: boolean }>} [sources.modelsDev]
 * @returns {Array<Record<string, any>>}
 */
export function mergeClineModels({ remoteFreeIds, remoteRecommended, remoteAllIds, modelsDev } = {}) {
  const free = new Set(remoteFreeIds ?? [])
  const hasRemote = (remoteFreeIds?.length ?? 0) + (remoteRecommended?.length ?? 0) + (remoteAllIds?.length ?? 0) > 0
  const byId = new Map()
  const order = []

  const push = row => {
    if (row === undefined || byId.has(row.id)) return
    byId.set(row.id, row)
    order.push(row.id)
  }

  // 1. Free ids the remote named, with curated metadata where it exists.
  for (const id of remoteFreeIds ?? []) {
    const curated = FALLBACK_MODELS.find(row => row.id === id)
    push(curated === undefined ? { id, name: id, isFree: true } : { ...curated, isFree: true })
  }

  // 2. The curated table, but only for ids the remote still knows — unless the remote
  // said nothing at all, in which case the table is all we have.
  for (const row of FALLBACK_MODELS) {
    if (hasRemote && !free.has(row.id) && !(remoteAllIds ?? []).includes(row.id) && !(remoteRecommended ?? []).includes(row.id)) {
      continue
    }
    push({ ...row, isFree: isFreeModel(row.id, free.has(row.id)) })
  }

  // 3. Recommended and pass rows the table does not cover.
  for (const id of remoteRecommended ?? []) {
    push({ id, name: id, isFree: isFreeModel(id, free.has(id)) })
  }

  // 4. Remaining account-scoped ids.
  for (const id of remoteAllIds ?? []) {
    push({ id, name: id, isFree: isFreeModel(id, free.has(id)) })
  }

  // 5. models.dev fills gaps and may append ids nothing else knew about, but it never
  // overrides a curated name or a known capability. Appending is safe: an extra row only
  // appears in the picker, whereas an override would replace a curated fact with a guess.
  if (Array.isArray(modelsDev)) {
    for (const entry of modelsDev) {
      if (typeof entry?.id !== 'string' || entry.id.length === 0) continue
      const current = byId.get(entry.id)
      if (current === undefined) {
        push({
          id: entry.id,
          name: entry.name ?? entry.id,
          isFree: isFreeModel(entry.id, free.has(entry.id)),
          ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
          ...(entry.supportsImage === undefined ? {} : { supportsImage: entry.supportsImage }),
        })
        continue
      }
      if (entry.name !== undefined && current.name === current.id) current.name = entry.name
      if (current.contextWindow === undefined && entry.contextWindow !== undefined) current.contextWindow = entry.contextWindow
      if (current.supportsImage === undefined && entry.supportsImage !== undefined) current.supportsImage = entry.supportsImage
    }
  }

  return order.map(id => byId.get(id))
}

/** Wording that means the service is blocked for this region. */
const REGION_MARKERS = Object.freeze([
  'not available in your region', 'access forbidden', 'region not supported', 'not available in your country',
])

/**
 * Is this response a region block?
 *
 * Requires 403 specifically: a 401 with similar wording would be an auth problem, and
 * treating it as a region block would skip the refresh that might have fixed it.
 *
 * @param {number} status
 * @param {string} body
 * @returns {boolean}
 */
export function isRegionForbidden(status, body) {
  if (status !== 403) return false
  const lower = body.toLowerCase()
  return REGION_MARKERS.some(marker => lower.includes(marker))
}

/** Wording that means quota or credit, not a transient limit. */
const ROTATABLE_MARKERS = Object.freeze([
  'insufficient', 'quota', 'rate limit', 'too many requests', 'balance', 'credit',
  'payment required', 'exceeded', '积分不足', '额度不足', '余额不足', '频率限制', '超出限制',
])

/**
 * Should this failure move to another account?
 *
 * 429 and 402 always do. Otherwise the body decides: this provider reports an exhausted
 * allowance under several statuses, so the wording is the reliable signal.
 *
 * @param {number} status
 * @param {string} body
 * @returns {boolean}
 */
export function isRotatableFailure(status, body) {
  if (status === 429 || status === 402) return true
  const lower = body.toLowerCase()
  return ROTATABLE_MARKERS.some(marker => lower.includes(marker.toLowerCase()))
}

/**
 * Only a 429 records a cooldown.
 *
 * A 402 rotates but records nothing: the account's credit is gone, but the *model* is not
 * rate-limited, and parking the model would hide it from every other account too.
 *
 * @param {number} status
 * @returns {boolean}
 */
export function recordsCooldown(status) {
  return status === 429
}

/** Classify for the shared channel factory. */
export function classifyHttp(status, body) {
  if (isRegionForbidden(status, body)) return 'region-forbidden'
  if (status === 402) return 'quota-exceeded'
  if (status === 429) return 'soft-rate'
  if (isRotatableFailure(status, body)) return 'quota-exceeded'
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not-found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'none'
}

/**
 * In-band classification.
 *
 * The shared chat consumer supplies no quota predicate for this channel, so the residual
 * case is a server error. That matches the reference behaviour, and it means an in-band
 * failure is retried by the harness rather than by us — which is the intended split.
 */
export function classifyInBand(message) {
  if (isRotatableFailure(200, message)) return 'quota-exceeded'
  return 'server'
}

/** Every non-clean kind rotates; region blocks and auth do not retry the same account. */
export function shouldRotate(kind) {
  return kind === 'quota-exceeded' || kind === 'soft-rate' || kind === 'server'
}

/**
 * Parse a reset time from a 429.
 *
 * Order: the `retry-after` header, then the human-readable "try again in" text, then an
 * absolute timestamp, then a fixed fallback. The header is first because it is the only
 * machine-readable form; the fallback is last and deliberately short so a stale guess
 * cannot outlive the real window.
 *
 * @param {{ headers: { get(name: string): string | null }, body: string }} response
 * @param {number} nowMs
 * @returns {number} absolute reset instant in milliseconds
 */
export function parseResetAt(response, nowMs) {
  const header = response.headers.get('retry-after')
  if (header !== null && header !== '') {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return nowMs + seconds * 1000
    const at = Date.parse(header)
    if (Number.isFinite(at)) return Math.max(nowMs, at)
  }
  const relative = /try again in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i.exec(response.body)
  if (relative !== null && (relative[1] !== undefined || relative[2] !== undefined)) {
    const hours = relative[1] === undefined ? 0 : Number(relative[1])
    const minutes = relative[2] === undefined ? 0 : Number(relative[2])
    return nowMs + (hours * 3_600_000) + (minutes * 60_000)
  }
  const absolute = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/.exec(response.body)
  if (absolute !== null) {
    const at = Date.parse(absolute[1])
    if (Number.isFinite(at)) return Math.max(nowMs, at)
  }
  return nowMs + 3_600_000
}

/**
 * Map a classification to a harness code.
 *
 * A region block is PERMISSION_DENIED, not AUTH: the credential is fine and refreshing it
 * cannot help, so reporting AUTH would send the user to a login that changes nothing.
 */
export function mapErrorCode(status, body, kind) {
  if (kind === 'region-forbidden') return 'PERMISSION_DENIED'
  if (kind === 'quota-exceeded' || kind === 'soft-rate') return ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED
  if (kind === 'auth') return ACCOUNT_ERROR_CODES.AUTH
  if (kind === 'not-found') return ACCOUNT_ERROR_CODES.INVALID_REQUEST
  if (status >= 500 || kind === 'server') return ACCOUNT_ERROR_CODES.SERVER
  return ACCOUNT_ERROR_CODES.INVALID_REQUEST
}

export { AccountError }
