/**
 * MiniMax channel: product constants, the Anthropic message shape, and the image contract.
 *
 * ## The image story, stated accurately
 *
 * Two of the four models advertise image input and two do not. The adapter inlines an image
 * only when the model declares support *and* an attachment reader is available; otherwise it
 * raises an explicit error rather than sending a request with the image stripped. Silent
 * removal would let the user believe the model saw an image it never received.
 *
 * The original adapter's header comment still says images are unimplemented while the code
 * inlines them. The code is the truth here; the comment is stale, and a rewrite that trusted
 * the comment would regress working behaviour.
 *
 * ## Thinking is per-model
 *
 * Only one model requires `thinking.type = 'adaptive'`; sending `disabled` to it is rejected
 * upstream. The other three accept a request with no thinking field at all and think by
 * default. So the thinking field is conditional on the model, not on the caller.
 *
 * @module src/accounts/providers/minimax/product
 */

import { ACCOUNT_ERROR_CODES } from '../../core/errors.js'

export const PROVIDER_ID = 'minimax'

export const HOSTS = Object.freeze({
  account: 'https://account.minimax.cn',
  api: 'https://agent.minimax.cn',
})

export const PATHS = Object.freeze({
  infer: '/mavis/api/v1/llm/v1/messages',
  models: '/mavis/api/v1/models',
  deviceCode: '/oauth2/device/code',
  token: '/oauth2/token',
  signinStatus: '/minimax-cloud/api/v1/signin/status',
})

export const DEFAULT_CREDENTIAL_REF = 'MINIMAX_ACCESS_TOKEN'

/** The only model that requires adaptive thinking. */
export const ADAPTIVE_ONLY_PREFIX = 'MiniMax-M3.1'

/**
 * The static catalog.
 *
 * `thinkingMode` is the per-model fact that decides whether a thinking field is sent:
 * `forced_on` means the model thinks and the field is omitted (or set adaptive where the
 * prefix requires it), `switchable` means the caller may turn it off.
 */
export const FALLBACK_MODELS = Object.freeze([
  {
    id: 'MiniMax-M3.1-Flash-Preview',
    name: 'M3.1-Flash-Preview',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: true,
    effortOptions: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'default',
    thinkingMode: 'forced_on',
  },
  {
    id: 'MiniMax-M3',
    name: 'M3',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: true,
    thinkingMode: 'switchable',
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    name: 'M2.7-highspeed',
    contextWindow: 200_000,
    maxTokens: 128_000,
    supportsImage: false,
    thinkingMode: 'forced_on',
  },
  {
    id: 'MiniMax-M2.7',
    name: 'M2.7',
    contextWindow: 200_000,
    maxTokens: 128_000,
    supportsImage: false,
    thinkingMode: 'forced_on',
  },
])

/**
 * Which models advertise image input?
 *
 * @returns {string[]}
 */
export function imageCapableModels() {
  return FALLBACK_MODELS.filter(row => row.supportsImage === true).map(row => row.id)
}

/**
 * Build the reasoning menu for a model.
 *
 * A `switchable` model gets two extra ids appended: `on` and `none`, with their display
 * names. `defaultEffort` is only reported when the model actually declares a menu that
 * contains it — reporting a default the model does not offer would let the picker select a
 * level the provider rejects.
 *
 * @param {Record<string, any>} model
 * @returns {{ efforts?: string[], defaultEffort?: string }}
 */
export function reasoningInfo(model) {
  const options = Array.isArray(model?.effortOptions) ? [...model.effortOptions] : []
  if (model?.thinkingMode === 'switchable') options.push('on', 'none')
  if (options.length === 0) return {}
  const out = { efforts: options }
  if (typeof model.defaultEffort === 'string' && options.includes(model.defaultEffort)) {
    out.defaultEffort = model.defaultEffort
  }
  return out
}

/**
 * Decide the `thinking` field for a request.
 *
 * Three cases:
 * - the adaptive-only model always sends `adaptive`, because `disabled` is rejected;
 * - a `switchable` model sends `disabled` only when the caller explicitly asked for `none`;
 * - everything else sends nothing, which the provider accepts and treats as "think".
 *
 * @param {Record<string, any>} model
 * @param {string | undefined} requested
 * @returns {undefined | { type: string }}
 */
export function thinkingField(model, requested) {
  if (typeof model?.id === 'string' && model.id.startsWith(ADAPTIVE_ONLY_PREFIX)) return { type: 'adaptive' }
  if (model?.thinkingMode === 'switchable') {
    return requested === 'none' ? { type: 'disabled' } : undefined
  }
  return undefined
}

/**
 * Does this request carry images the model cannot take?
 *
 * @param {Record<string, any>} model
 * @param {boolean} hasImages
 * @param {boolean} hasReader
 * @returns {undefined | string} a reason, when the request must be refused
 */
export function refuseReason(model, hasImages, hasReader) {
  if (!hasImages) return undefined
  if (model?.supportsImage !== true) return `model "${model?.id ?? 'unknown'}" does not accept image input`
  if (!hasReader) return 'image input needs the attachment service, which is not wired'
  return undefined
}

/**
 * HTTP classification.
 *
 * There is no ordered in-band classifier for this channel: an SSE error event and a
 * zero-content stream are both plain failures. Reporting a status-derived class is all this
 * endpoint supports.
 *
 * @param {number} status
 * @returns {string}
 */
export function classifyHttp(status) {
  if (status === 402) return 'quota-exceeded'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'soft-rate'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'none'
}

export function mapErrorCode(status, kind) {
  if (kind === 'quota-exceeded') return ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED
  if (kind === 'auth') return ACCOUNT_ERROR_CODES.AUTH
  if (kind === 'soft-rate' || status === 429) return ACCOUNT_ERROR_CODES.RATE_LIMIT
  if (kind === 'server' || status >= 500) return ACCOUNT_ERROR_CODES.SERVER
  return ACCOUNT_ERROR_CODES.INVALID_REQUEST
}

/** No rotation: this adapter surfaces failures rather than spending another account. */
export function shouldRotate() {
  return false
}

export function recordsCooldown() {
  return false
}

/**
 * Map an Anthropic stop reason onto the harness vocabulary.
 *
 * @param {unknown} reason
 * @param {boolean} sawToolUse
 * @returns {string}
 */
export function mapStopReason(reason, sawToolUse) {
  if (sawToolUse) return 'tool-calls'
  if (reason === 'max_tokens') return 'max-tokens'
  if (reason === 'refusal') return 'refusal'
  return 'stop'
}

export { ADAPTIVE_ONLY_PREFIX as ADAPTIVE_PREFIX }
