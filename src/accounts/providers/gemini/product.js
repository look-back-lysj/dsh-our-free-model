/**
 * Gemini channel: product constants, the contents wire, session identity and the signature cache.
 *
 * ## Three facts that make this channel unlike the others
 *
 * **The body is serialized alphabetically.** The upstream is sensitive to field order, and the
 * original implementation achieved that by relying on Go's automatic map-key ordering. JSON
 * here preserves insertion order, so the ordering has to be applied explicitly. Sending an
 * unsorted body is accepted sometimes and rejected others, which is the worst kind of bug.
 *
 * **`thoughtSignature` is cross-turn state.** A signature attached to a `functionCall` part must
 * be stored and replayed on the next turn, matched by tool name and canonicalized arguments.
 * Without it, a multi-turn tool conversation is rejected upstream. It lives in its own cache
 * rather than the main state document, because that document is replaced wholesale and would
 * drop it.
 *
 * **There is no model listing endpoint.** One model is exposed, with four thinking tiers that
 * map to suffixed upstream names. Any other id is rejected rather than passed through, because
 * a permissive id would be accepted by the local gateway and then fail upstream with a message
 * that names the wrong cause.
 *
 * @module src/accounts/providers/gemini/product
 */

import { ACCOUNT_ERROR_CODES } from '../../core/errors.js'

export const PROVIDER_ID = 'gemini'

/** Endpoint order for inference: daily first, sandbox as the fallback. */
export const ENDPOINTS = Object.freeze([
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
])

/**
 * Project probing uses the reverse order.
 *
 * Recorded because it is not an oversight: the probe and the inference call have different
 * availability characteristics, and matching them would have been the "tidy" change that broke
 * the probe.
 */
export const PROBE_ENDPOINTS = Object.freeze([
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://daily-cloudcode-pa.googleapis.com',
])

export const PATHS = Object.freeze({
  generate: '/v1internal:generateContent',
  stream: '/v1internal:streamGenerateContent?alt=sse',
  quota: '/v1internal:retrieveUserQuotaSummary',
  loadCodeAssist: '/v1internal:loadCodeAssist',
})

export const DEFAULT_CREDENTIAL_REF = 'GEMINI_ACCESS_TOKEN'

/** The one exposed model id. */
export const MODEL_ID = 'gemini-3.8-flash'

/** The upstream base name the tier suffix is appended to. */
export const UPSTREAM_FLASH = 'gemini-3.8-flash'

export const CONTEXT_WINDOW = 1_000_000
export const MAX_OUTPUT_TOKENS = 64_000

/** The four thinking tiers and their budgets. `tiered` means "let the provider decide". */
export const TIERS = Object.freeze(['low', 'medium', 'high', 'tiered'])
export const TIER_BUDGETS = Object.freeze({ low: 1_000, medium: 4_000, high: 10_000, tiered: -1 })
export const DEFAULT_TIER = 'medium'

/** The static catalog: one row, four tiers. */
export const FALLBACK_MODELS = Object.freeze([
  {
    id: MODEL_ID,
    name: 'Gemini 3.8 Flash',
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    supportsImage: true,
    effortOptions: [...TIERS],
    defaultEffort: DEFAULT_TIER,
  },
])

/** Identity headers, frozen: the upstream rejects a request without them. */
export const IDENTITY_HEADERS = Object.freeze({
  'User-Agent': 'antigravity',
  'X-Client-Name': 'antigravity',
})

/** The project probe body. */
export const LOAD_CODE_ASSIST_BODY = '{"metadata":{"ideType":"ANTIGRAVITY"}}'

/** Request and idle timeouts. */
export const REQUEST_TIMEOUT_MS = 120_000
export const IDLE_TIMEOUT_MS = 120_000

/** How many signatures the cache holds. */
export const SIGSTORE_LIMIT = 2_000

/**
 * Normalize a model id by stripping a known tier suffix.
 *
 * Used for rate-limit stamps and test lookups, which may carry the suffixed name while the
 * catalog exposes the bare one. Only known suffixes are stripped: a future model whose real
 * name ends in a tier word would otherwise be silently truncated.
 *
 * @param {string} modelId
 * @returns {string}
 */
export function canonicalModelId(modelId) {
  for (const tier of TIERS) {
    if (modelId.endsWith(`-${tier}`)) return modelId.slice(0, -(tier.length + 1))
  }
  return modelId
}

/**
 * Resolve the upstream model name and thinking budget for a request.
 *
 * An id that is not the exposed model is rejected rather than forwarded. The alternative —
 * passing any id through — was measured to answer 200 upstream because the name never reached
 * the request, which makes the failure appear only for real users.
 *
 * @param {string} modelId
 * @param {string | undefined} effort
 * @returns {{ upstream: string, tier: string, thinkingBudget: number, includeThoughts: true }}
 */
export function modelSpec(modelId, effort) {
  if (canonicalModelId(modelId) !== MODEL_ID) {
    throw Object.assign(
      new AccountErrorLike(`unsupported model "${modelId}"; this channel exposes only ${MODEL_ID}`),
      { code: 'INVALID_REQUEST', status: 404 },
    )
  }
  const tier = TIERS.includes(effort) ? effort : DEFAULT_TIER
  return {
    upstream: `${UPSTREAM_FLASH}-${tier}`,
    tier,
    thinkingBudget: TIER_BUDGETS[tier],
    includeThoughts: true,
  }
}

/** A minimal error carrying a code, so the shape matches {@link AccountError}. */
class AccountErrorLike extends Error {
  constructor(message) {
    super(message)
    this.name = 'AccountError'
  }
}

/**
 * Serialize a value with object keys in alphabetical order at every level.
 *
 * The upstream is field-order sensitive. Applying this once at the top level would leave nested
 * objects in insertion order, so it recurses.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function marshalAlphabetical(value) {
  return JSON.stringify(sortKeys(value))
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
  return out
}

/**
 * Derive the session id for a conversation.
 *
 * A stable id per (project, lane, first user text) keeps a conversation on the same session
 * across turns, which is what the upstream's context cache keys on. A generation counter is
 * appended when the session overflowed, so a bumped session is a different id.
 *
 * @param {{ project: string, lane: string, firstUserText: string, generation?: number }} spec
 * @returns {string} a signed 64-bit decimal string
 */
export function deriveSessionId({ project, lane, firstUserText, generation = 0 }) {
  const seed = `${project}\u0000${lane}\u0000${firstUserText}${generation > 0 ? `\u0000${generation}` : ''}`
  // FNV-1a 64-bit over the seed, as a signed decimal string.
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= BigInt(seed.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  const signed = hash > 0x7fffffffffffffffn ? hash - 0x10000000000000000n : hash
  return signed.toString()
}

/** Canonicalize tool arguments for the signature cache key. */
export function canonicalArguments(args) {
  if (typeof args === 'string') {
    try {
      return marshalAlphabetical(JSON.parse(args))
    } catch {
      return args
    }
  }
  return marshalAlphabetical(args ?? {})
}

/**
 * The signature cache.
 *
 * Keyed by tool name plus canonicalized arguments, because the upstream checks the signature
 * against the exact call it was issued for. An entry is kept until the cache is trimmed: a
 * signature that is dropped early forces an unsigned retry, which the upstream may reject.
 */
export class SignatureCache {
  /**
   * @param {object} [options]
   * @param {number} [options.limit]
   * @param {() => number} [options.now]
   */
  constructor({ limit = SIGSTORE_LIMIT, now = () => Date.now() } = {}) {
    this.limit = limit
    this.now = now
    /** @type {Map<string, { signature: string, at: number, name: string }>} */
    this.entries = new Map()
  }

  /** @param {string} name @param {unknown} args */
  static key(name, args) {
    return `tool:${name}:${canonicalArguments(args)}`
  }

  /** @param {string} name @param {unknown} args @param {string} signature */
  store(name, args, signature) {
    const key = SignatureCache.key(name, args)
    // Re-inserting moves the entry to the end so trimming drops the least recently used.
    this.entries.delete(key)
    this.entries.set(key, { signature, at: this.now(), name })
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /** @param {string} name @param {unknown} args @returns {string | undefined} */
  lookup(name, args) {
    return this.entries.get(SignatureCache.key(name, args))?.signature
  }

  /** The most recent signature for a tool, used when the exact arguments do not match. */
  latestForTool(name) {
    let found
    for (const entry of this.entries.values()) {
      if (entry.name === name) found = entry.signature
    }
    return found
  }

  size() {
    return this.entries.size
  }
}

/** Does this body look like a signature rejection? */
export function looksLikeSignatureError(body) {
  return /thought_?signature|signature (?:is )?(?:invalid|missing|required)/i.test(body)
}

/**
 * Does this body report a **session** token overflow?
 *
 * Narrower than the context case on purpose. A session overflow means the cached session is
 * full and a new generation id lets the conversation continue; a context overflow means the
 * conversation itself does not fit and no retry can help. The two arrive with overlapping
 * wording, so the session predicate requires a session-specific signal — otherwise a context
 * overflow would be retried once for nothing.
 */
export function isSessionOverflow(body) {
  if (/context (?:window|length)/i.test(body)) return false
  return /session[^.]{0,40}(?:exceeds|too (?:long|large))|exceeds the maximum number of tokens/i.test(body)
}

/** Does this body report a context-window overflow? */
export function isContextOverflow(body) {
  return /exceeds the maximum number of tokens|context (?:window|length)/i.test(body)
}

/** Does this body carry quota wording? */
export function isQuotaText(body) {
  return /quota|rate limit|resource_exhausted/i.test(body)
}

/**
 * Should the endpoint be switched rather than the account rotated?
 *
 * A 403, a 404, or a 400 mentioning quota, permission, an unsupported model or the project all
 * suggest the endpoint or the project binding is wrong, which a different account would not fix.
 *
 * @param {number} status
 * @param {string} body
 * @returns {boolean}
 */
export function isEndpointProblem(status, body) {
  if (status === 403 || status === 404) return true
  if (status !== 400) return false
  return /quota|permission|unsupported|project/i.test(body)
}

/**
 * Is this a quota-like failure that should rotate?
 *
 * @param {number} status
 * @param {string} body
 * @returns {boolean}
 */
export function isQuotaLike(status, body) {
  if (status === 429) return true
  return status === 400 && isQuotaText(body)
}

/**
 * The ordered classifier used when nothing above decided.
 *
 * @param {number} status
 * @param {string} body
 * @returns {string}
 */
export function classifyFailure(status, body) {
  if (status === 400 && isContextOverflow(body)) return 'context-overflow'
  if (status === 400 && isQuotaText(body)) return 'quota-exceeded'
  if (status === 429) return 'soft-rate'
  if (status === 403 || status === 404) return 'server'
  if (status === 401) return 'auth'
  if (status >= 500) return 'server'
  return 'client'
}

export function mapErrorCode(status, body, kind) {
  if (kind === 'context-overflow') return 'CONTEXT_WINDOW_EXCEEDED'
  if (kind === 'quota-exceeded' || kind === 'soft-rate') return ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED
  if (kind === 'auth') return ACCOUNT_ERROR_CODES.AUTH
  if (status >= 500 || kind === 'server') return ACCOUNT_ERROR_CODES.SERVER
  return ACCOUNT_ERROR_CODES.INVALID_REQUEST
}

/** Cooldowns: a rate limit is short, an auth failure longer. */
export const RATE_LIMIT_COOLDOWN_MS = 60_000
export const AUTH_COOLDOWN_MS = 300_000

/** How many accounts one turn may try. */
export const MAX_ROTATIONS = 3

/** The quota buckets this channel reports. */
export const QUOTA_BUCKETS = Object.freeze(['gemini-5h', 'gemini-weekly'])

/**
 * Read the quota payload into per-window percentages.
 *
 * A bucket with an unparseable reset time is dropped rather than reported with a wrong reset:
 * a stale reset is worse than an absent window, because the user plans around it.
 *
 * @param {unknown} payload
 * @returns {{ buckets: Array<{ id: string, remainingFraction: number, resetTime: string }>, averageRemaining: number | null }}
 */
export function readQuota(payload) {
  const rows = Array.isArray(payload?.buckets) ? payload.buckets : []
  const buckets = []
  for (const row of rows) {
    const id = typeof row?.bucketId === 'string' ? row.bucketId : undefined
    if (id === undefined || !QUOTA_BUCKETS.includes(id)) continue
    const fraction = typeof row.remainingFraction === 'number' && Number.isFinite(row.remainingFraction)
      ? row.remainingFraction
      : undefined
    if (fraction === undefined) continue
    if (typeof row.resetTime === 'string' && Number.isNaN(Date.parse(row.resetTime))) continue
    buckets.push({ id, remainingFraction: fraction, resetTime: row.resetTime })
  }
  if (buckets.length === 0) return { buckets: [], averageRemaining: null }
  const average = buckets.reduce((sum, row) => sum + row.remainingFraction, 0) / buckets.length
  return { buckets, averageRemaining: average }
}
