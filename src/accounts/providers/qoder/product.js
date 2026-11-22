/**
 * Qoder and Qoder CN: product constants, model tables and the shared error chain.
 *
 * ## One adapter family, two products
 *
 * The two products share the WASM, the wire and the error chain, and differ in hosts, client
 * ids and model tables. That sharing is a fact about the implementation, not a licence to test
 * one and call both done: their hosts and model keys differ, so a success on one says nothing
 * about the other.
 *
 * ## The inference path is produced by the WASM
 *
 * The request URL, the headers and the encrypted body all come from the retained binary. This
 * module therefore owns the *plaintext* payload and the routing decisions, and treats the
 * encrypted result as opaque. That boundary is the whole reason the binary can be retained
 * without reimplementing its cryptography.
 *
 * ## Model keys are not model names
 *
 * The upstream recognises the catalog *key* (`qfmodel`, `dmodel`, …), not a display name. A
 * caller passing a display name gets a request the transport accepts and the server rejects.
 *
 * @module src/accounts/providers/qoder/product
 */

import { ACCOUNT_ERROR_CODES } from '../../core/errors.js'

/** The two product ids. */
export const PROVIDER_QODER = 'qoder'
export const PROVIDER_QODER_CN = 'qodercn'

/**
 * Per-product constants. Kept as data so the two products cannot drift into each other's hosts
 * through a copy-paste.
 */
export const PRODUCTS = Object.freeze({
  [PROVIDER_QODER]: Object.freeze({
    id: PROVIDER_QODER,
    displayName: 'Qoder',
    authBase: 'https://qoder.com',
    openApiBase: 'https://openapi.qoder.sh',
    encryptedInferBase: 'https://api2.qoder.sh',
    clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
    defaultCredentialRef: 'QODER_ACCESS_TOKEN',
  }),
  [PROVIDER_QODER_CN]: Object.freeze({
    id: PROVIDER_QODER_CN,
    displayName: 'Qoder CN',
    authBase: 'https://qoder.cn',
    openApiBase: 'https://openapi.qoder.com.cn',
    encryptedInferBase: 'https://gateway.qoder.com.cn',
    clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
    defaultCredentialRef: 'QODERCN_ACCESS_TOKEN',
  }),
})

export const PATHS = Object.freeze({
  deviceSelect: '/device/selectAccounts',
  poll: '/api/v1/deviceToken/poll',
  refresh: '/api/v1/deviceToken/refresh',
  userinfo: '/api/v1/userinfo',
  usage: '/sash/api/v2/me/usage',
  campaigns: '/sash/api/v1/me/campaigns',
})

/** Qoder's business codes. */
export const QUEUE_CODE = '10605'
export const BILLING_CODES = Object.freeze(['110', '112'])

/** How many queue attempts one turn may make. */
export const QUEUE_MAX_ATTEMPTS = 180

/** Cap on a single queue wait. */
export const QUEUE_MAX_DELAY_MS = 10_000

/** Total time one turn may spend queueing. */
export const QUEUE_DEADLINE_MS = 30 * 60_000

/** How many accounts one turn may try. */
export const MAX_ATTEMPTS = 3

/**
 * The international model table.
 *
 * `supportsThinking` drives `is_reasoning`, `supportsImage` drives `is_vl`, and `priceFactor`
 * is display information the provider publishes.
 */
export const QODER_MODELS = Object.freeze([
  { id: 'auto', name: 'Auto', contextWindow: 200_000, supportsImage: true, supportsThinking: false, priceFactor: 0.5 },
  { id: 'ultimate', name: 'Ultimate', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 2, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high', supportsDisable: true },
  { id: 'performance', name: 'Performance', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 1.1, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'medium', supportsDisable: true },
  { id: 'efficient', name: 'Efficient', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 0.3 },
  { id: 'smodel', name: 'Sonus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 8, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high' },
  { id: 'cmodel', name: 'Cantus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 4, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high' },
  { id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.2, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'xhigh', isFree: true, supportsDisable: true },
  { id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0, isFree: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium', supportsDisable: true },
  { id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 0.1, supportsDisable: true },
  { id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 0.04, supportsDisable: true },
  { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 1.4, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5, efforts: ['high', 'max'], defaultEffort: 'max', supportsDisable: true },
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max', 'low'], defaultEffort: 'max', supportsDisable: true },
  { id: 'mmodel', name: 'MiniMax-M3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 0.2 },
])

/**
 * The CN model table.
 *
 * Fourteen rows, with `q37fmodel` and `gm51model` and without the five international-only rows.
 * The differences are the provider's, not an omission.
 */
export const QODER_CN_MODELS = Object.freeze([
  { id: 'auto', name: 'Auto', contextWindow: 200_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5 },
  { id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.2, isFree: true, supportsDisable: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium' },
  { id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0, isFree: true, supportsDisable: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium' },
  { id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, supportsDisable: true },
  { id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.04, supportsDisable: true },
  { id: 'q37fmodel', name: 'Qwen3.7-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1 },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5, supportsDisable: true, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1_000_000, supportsImage: true, priceFactor: 0.1, supportsDisable: true, efforts: ['high', 'max', 'low'], defaultEffort: 'max' },
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'gm51model', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.6, supportsDisable: true, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImage: true, priceFactor: 1.4, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'mmodel', name: 'MiniMax-M2.7', contextWindow: 200_000, priceFactor: 0.2 },
])

/**
 * The model table for a product.
 *
 * @param {string} provider
 * @returns {readonly Record<string, any>[]}
 */
export function modelsFor(provider) {
  return provider === PROVIDER_QODER_CN ? QODER_CN_MODELS : QODER_MODELS
}

/**
 * Resolve the effort to send.
 *
 * The declared menu plus `none` when the model can disable thinking, then strength-ordered.
 * An undeclared request falls to the model's own default, and nothing is sent when the model
 * declares no menu — an absent field is always valid, a guessed level may not be.
 *
 * @param {Record<string, any>} model
 * @param {string | undefined} requested
 * @returns {string | undefined}
 */
export function resolveEffort(model, requested) {
  const menu = Array.isArray(model?.efforts) ? model.efforts : []
  if (requested !== undefined && (menu.includes(requested) || (requested === 'none' && model?.supportsDisable === true))) {
    return requested
  }
  if (typeof model?.defaultEffort === 'string' && menu.includes(model.defaultEffort)) return model.defaultEffort
  return undefined
}

/**
 * The effort menu to present, in strength order with `none` first when disabling is allowed.
 *
 * @param {Record<string, any>} model
 * @returns {string[]}
 */
export function effortMenu(model) {
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const menu = Array.isArray(model?.efforts) ? [...model.efforts] : []
  if (model?.supportsDisable === true && !menu.includes('none')) menu.push('none')
  return menu.sort((a, b) => {
    const left = order.indexOf(a)
    const right = order.indexOf(b)
    if (left === -1 && right === -1) return 0
    if (left === -1) return 1
    if (right === -1) return -1
    return left - right
  })
}

/** Does this payload declare a queue? */
export function isQueuePayload(payload) {
  if (payload === null || typeof payload !== 'object') return false
  if (String(payload.code) === QUEUE_CODE) return true
  return payload.isQueued === true || payload.model_queued === true
}

/**
 * The queue delay from a payload, in milliseconds, capped.
 *
 * Priority: `retry_after_ms`, `retryAfterMs`, `retryAfterSeconds`. A non-finite or negative
 * value is ignored rather than treated as zero, because zero means "retry immediately", which
 * burns the attempt budget in a tight loop.
 *
 * @param {Record<string, any> | undefined} payload
 * @returns {number | undefined}
 */
export function queueDelayMs(payload) {
  if (payload === null || payload === undefined || typeof payload !== 'object') return undefined
  const ms = finite(payload.retry_after_ms) ?? finite(payload.retryAfterMs)
  const seconds = finite(payload.retryAfterSeconds)
  const raw = ms ?? (seconds === undefined ? undefined : seconds * 1000)
  if (raw === undefined || raw < 0) return undefined
  return Math.min(Math.trunc(raw), QUEUE_MAX_DELAY_MS)
}

/** @param {unknown} value */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Does this payload declare an exhausted allowance? */
export function isBillingPayload(payload) {
  if (payload === null || typeof payload !== 'object') return false
  if (BILLING_CODES.includes(String(payload.code))) return true
  const text = typeof payload.message === 'string' ? payload.message : ''
  return /billing\s+daily\s+count\s+exceeded|daily\s+count\s+exceeded|billing_error/i.test(text)
}

/** Does this payload carry a purchase prompt? */
export function hasPricingHint(payload) {
  if (payload === null || typeof payload !== 'object') return false
  if (Array.isArray(payload)) return payload.some(hasPricingHint)
  for (const [key, value] of Object.entries(payload)) {
    if (/^pricing[_-]?url$/i.test(key) && typeof value === 'string' && value.length > 0) return true
    if (typeof value === 'object' && value !== null && hasPricingHint(value)) return true
  }
  return false
}

/**
 * The HTTP-layer classification, in order.
 *
 * The order is the contract: a queue notice first (it is recoverable by waiting), then an
 * exhausted allowance (recoverable by rotating), then a single credential refresh, then auth.
 *
 * @param {{ status: number, body: unknown }} response
 * @returns {string}
 */
export function classifyHttp({ status, body }) {
  if (isQueuePayload(body)) return 'queue'
  if (isBillingPayload(body) || hasPricingHint(body)) return 'quota-exceeded'
  if (status === 401 || status === 403) return 'auth'
  if (status === 409) return 'duplicate'
  if (status === 429) return 'soft-rate'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'none'
}

/**
 * The in-band classification, in order.
 *
 * The default is a server error, which is the reference behaviour: an in-band frame the adapter
 * cannot attribute is a failure of this attempt.
 *
 * @param {Record<string, any>} frame
 * @returns {string}
 */
export function classifyInBand(frame) {
  if (isQueuePayload(frame)) return 'queue'
  if (isBillingPayload(frame) || hasPricingHint(frame)) return 'quota-exceeded'
  return 'server'
}

export function mapErrorCode(kind, status) {
  if (kind === 'queue') return ACCOUNT_ERROR_CODES.QUEUE
  if (kind === 'quota-exceeded') return ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED
  if (kind === 'auth') return ACCOUNT_ERROR_CODES.AUTH
  if (kind === 'soft-rate' || status === 429) return ACCOUNT_ERROR_CODES.RATE_LIMIT
  if (kind === 'server' || status >= 500) return ACCOUNT_ERROR_CODES.SERVER
  return ACCOUNT_ERROR_CODES.INVALID_REQUEST
}

/**
 * Build the plaintext inference payload.
 *
 * The key names and nesting mirror what the retained WASM expects to encrypt; a rename here
 * produces a body the server cannot read, which presents as an auth or format failure rather
 * than a naming mistake.
 *
 * @param {object} spec
 * @returns {Record<string, unknown>}
 */
export function buildInferPayload(spec) {
  const model = spec.model
  return {
    request_id: spec.requestId,
    chat_record_id: spec.chatRecordId ?? '',
    session_id: spec.sessionId,
    stream: true,
    chat_task: 'agent',
    chat_context: {
      text: spec.text ?? '',
      features: [],
      extra: {
        context: {},
        modelConfig: {
          key: model.id,
          is_reasoning: model.supportsThinking === true,
        },
        originalContent: '',
      },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: false,
    is_retry: false,
    source: 'plugin',
    version: spec.version ?? '1.0.0',
    agent_id: spec.agentId ?? 'agent_common',
    task_id: spec.taskId ?? spec.requestId,
    session_type: 'app',
    aliyun_user_type: 'normal',
    model_config: {
      key: model.id,
      display_name: model.name,
      model: model.id,
      format: 'openai',
      // Only a declared capability is stated. The upstream treats an absent flag differently
      // from an explicit false for some rows, so a row that never declared image support must
      // not have it invented here.
      // Absent when the row never declared image support, so the upstream can apply its own
      // default rather than being told "no" on a model that actually accepts images.
      ...(model.supportsImage === undefined ? {} : { is_vl: model.supportsImage === true }),
      is_reasoning: model.supportsThinking === true,
      api_key: '',
      url: '',
      source: 'catalog',
      max_input_tokens: model.contextWindow ?? 200_000,
    },
    custom_model: false,
    system: spec.system ?? '',
    messages: spec.messages ?? [],
    tools: spec.tools ?? [],
    parameters: {
      ...(spec.maxTokens === undefined ? {} : { max_tokens: spec.maxTokens }),
      ...(spec.reasoningEffort === undefined ? {} : { reasoning_effort: spec.reasoningEffort }),
      ...(spec.enableThinking === undefined ? {} : { enable_thinking: spec.enableThinking }),
      context_length: model.contextWindow ?? 200_000,
    },
    business: { type: 'agent' },
  }
}
