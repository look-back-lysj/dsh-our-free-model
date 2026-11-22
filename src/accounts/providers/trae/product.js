/**
 * TRAE channel: product constants, the SOLO wire transform, and error classification.
 *
 * ## The wire is proprietary, and the transform is where the work is
 *
 * The request is not OpenAI-chat. Messages go through a translation that renames the model
 * to a `config_name` plus `model` pair, forces streaming, adds a `function` routing field,
 * and stringifies each tool's parameters. Sending the OpenAI body directly would be accepted
 * by the transport and then rejected — or worse, silently ignored — upstream.
 *
 * ## Two error codes can arrive in one body, and the heavier one must win
 *
 * `4008` (allowance exhausted) and `4011` (rate limited) can both appear in a single
 * response, because the gateway concatenates error codes into one message. The exhausted
 * case needs a long cooldown and the rate-limited case a short one, so checking the lighter
 * code first parks an exhausted account for sixty seconds and then retries it — which the
 * user experiences as "it keeps failing and the countdown resets".
 *
 * ## In-band errors need both a code and a message
 *
 * A frame with only one of the two is incomplete, and treating it as an error produces
 * spurious rotations. Only a frame carrying both counts.
 *
 * @module src/accounts/providers/trae/product
 */

import { ACCOUNT_ERROR_CODES } from '../../core/errors.js'

export const PROVIDER_ID = 'trae'

export const HOSTS = Object.freeze({
  agent: 'https://trae-api-cn.mchost.guru',
  oauth: 'https://api.trae.com.cn',
  console: 'https://www.trae.cn',
  ug: 'https://api.trae.cn',
})

export const PATHS = Object.freeze({
  chat: '/api/agent/v3/llm_utils_chat',
  batchModels: '/api/ide/v1/batch_get_detail_param',
  exchange: '/cloudide/api/v3/trae/oauth/ExchangeToken',
  userInfo: '/cloudide/api/v3/trae/GetUserInfo',
  checkinStatus: '/trae/api/v2/ug/checkin_credits/status',
  checkinClaim: '/trae/api/v2/ug/checkin_credits/claim',
})

export const DEFAULT_CREDENTIAL_REF = 'TRAE_ACCESS_TOKEN'

/** The routing field default when a model declares no `function`. */
export const DEFAULT_FUNCTION = 'solo_work_lite'

/** The provider's hard output ceiling. */
export const MAX_COMPLETION_TOKENS = 64_000

/** Cooldown used for every limited kind. */
export const COOLDOWN_FALLBACK_MS = 3_600_000

/** How many requests one turn may make. */
export const MAX_ATTEMPTS = 3

/**
 * The channel whitelist, in priority order. A model whose `function` is not in this list is
 * dropped from the catalog, because the request would be routed to a surface this build
 * does not implement.
 */
export const DEFAULT_CHANNELS = Object.freeze([
  'solo_agent', 'solo_work_lite', 'solo_agent_remote', 'solo_work_remote', 'solo_agent_lite',
  'chat_v3', 'builder_v3', 'solo_coder', 'solo_design_lite', 'solo_design_remote',
  'git_ai', 'code_reviewer', 'code_review_summary', 'multimodal', 'system_diagnosis',
])

/**
 * The static catalog. `isHidden` marks rows the provider exposes internally and that the
 * picker should not show, but that must stay resolvable because a saved session may name one.
 */
export const FALLBACK_MODELS = Object.freeze([
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek V4 Flash Official', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.1-Pro', name: 'Doubao Seed 2.1 Pro', contextWindow: 200_000 },
  { id: 'seed-code-pro-0430', name: 'Seed Code Pro 0430', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.1-Turbo', name: 'Doubao Seed 2.1 Turbo', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.0-Code', name: 'Doubao Seed 2.0 Code', contextWindow: 200_000 },
  { id: 'browser_use_subagent', name: 'Browser Use Subagent', contextWindow: 200_000, isHidden: true },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000 },
  { id: 'glm-5-turbo', name: 'GLM 5 Turbo', contextWindow: 200_000 },
  { id: 'glm-5', name: 'GLM-5', contextWindow: 200_000 },
  { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', contextWindow: 200_000 },
  { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', contextWindow: 200_000 },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 200_000 },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 200_000 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 200_000 },
  { id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 200_000 },
  { id: 'qwen-3.7-plus', name: 'Qwen 3.7 Plus', contextWindow: 200_000 },
  { id: 'sagitta', name: 'Sagitta', contextWindow: 200_000 },
  { id: 'aquila', name: 'Aquila', contextWindow: 200_000 },
  { id: 'custom_model_gemini', name: 'Custom Gemini', contextWindow: 200_000 },
  { id: 'custom_model_placeholder', name: 'Custom Placeholder', contextWindow: 200_000 },
  { id: 'custom_model_1M_text', name: 'Custom 1M Text', contextWindow: 200_000 },
  { id: 'custom_model_1M', name: 'Custom 1M', contextWindow: 200_000 },
  { id: 'custom_model_kimi', name: 'Custom Kimi', contextWindow: 200_000 },
  { id: 'custom_model_claude', name: 'Custom Claude', contextWindow: 200_000 },
  { id: 'custom_model_gpt-5', name: 'Custom GPT-5', contextWindow: 200_000 },
  { id: 'custom_model_no-fc', name: 'Custom No-FC', contextWindow: 200_000 },
  { id: 'custom_model_deepseek_chat', name: 'Custom DeepSeek Chat', contextWindow: 200_000 },
  { id: 'custom_model_deepseek_reasoner', name: 'Custom DeepSeek Reasoner', contextWindow: 200_000 },
  { id: 'custom_model_deepseek_v4', name: 'Custom DeepSeek V4', contextWindow: 200_000 },
  { id: 'explore_sub_agent_v13', name: 'Explore Sub Agent V13', contextWindow: 200_000, isHidden: true },
  { id: 'explore_sub_agent_v2', name: 'Explore Sub Agent V2', contextWindow: 200_000, isHidden: true },
  { id: 'summary', name: 'Summary', contextWindow: 200_000, isHidden: true },
])

/** Kinds this classifier can return. */
export const TRAE_KINDS = Object.freeze([
  'hard-plan', 'quota-exceeded', 'soft-rate', 'session-dead', 'not-found', 'server', 'client', 'none',
])

/** Markers that mean the plan entitlement is exhausted. */
const PLAN_MARKERS = Object.freeze(['"code":1005', '1005'])

/** Markers that mean the model's allowance is spent. */
const QUOTA_MARKERS = Object.freeze(['4008', '"code":4008', 'quota', 'exceeded the quota'])

/**
 * The bare allowance code, with no wording to disambiguate it.
 *
 * `1005` means "allowance exhausted" on its own; it only means "plan entitlement" when the
 * body also says "plan". So after the plan branch has had its chance, a remaining `1005` is
 * the allowance case — treating it as unrecognised would surface it as a server error and
 * the harness would retry an account that cannot succeed today.
 */
const BARE_PLAN_CODE = '1005'

/** Markers that mean the session is gone. */
const SESSION_MARKERS = Object.freeze(['40100', '40101', 'token rejected', 'session expired'])

/**
 * Classify an HTTP response, in the order the contract fixes.
 *
 * @param {number} status
 * @param {string} body
 * @returns {string}
 */
export function classifyHttp(status, body) {
  const lower = body.toLowerCase()
  // 1. Plan entitlement: needs the word "plan" alongside the code, because `1005` alone is
  //    used for the allowance case too.
  for (const marker of PLAN_MARKERS) {
    if (body.includes(marker) && lower.includes('plan')) return 'hard-plan'
  }
  // 2. Exhausted allowance before rate limiting: one body can carry both codes, and the
  //    heavier class must win so the longer cooldown applies.
  for (const marker of QUOTA_MARKERS) {
    if (body.includes(marker)) return 'quota-exceeded'
  }
  // 2b. A bare 1005 with no "plan" wording is the allowance case (see BARE_PLAN_CODE).
  if (body.includes(BARE_PLAN_CODE)) return 'quota-exceeded'
  // 3. Rate limit.
  if (body.includes('4011') || body.includes('"code":4011')) return 'soft-rate'
  // 4. Dead session.
  if (status === 401) {
    for (const marker of SESSION_MARKERS) {
      if (lower.includes(marker.toLowerCase())) return 'session-dead'
    }
    return 'session-dead'
  }
  if (status === 429) return 'soft-rate'
  if (status === 404) return 'not-found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'none'
}

/**
 * Which in-band error codes are worth rotating for.
 *
 * @param {number} code
 * @returns {boolean}
 */
export function isRotatableStreamCode(code) {
  return code === 1005 || code === 4008 || code === 4011
}

/**
 * Classify an in-band error frame.
 *
 * The frame must carry both a code and a message to count. A frame with one of the two is
 * incomplete, and treating it as an error would rotate for a heartbeat.
 *
 * @param {{ code?: unknown, message?: unknown }} frame
 * @returns {undefined | { kind: string, rotatable: boolean }}
 */
export function classifyInBandFrame(frame) {
  const code = frame?.code
  const message = frame?.message
  if (code === undefined || typeof message !== 'string' || message.length === 0) return undefined
  const numeric = typeof code === 'number' ? code : Number(code)
  const rotatable = Number.isFinite(numeric) && isRotatableStreamCode(numeric)
  if (numeric === 1005 || numeric === 4008) return { kind: 'quota-exceeded', rotatable }
  if (numeric === 4011) return { kind: 'soft-rate', rotatable }
  return { kind: 'server', rotatable: false }
}

/**
 * Every non-clean HTTP kind rotates.
 *
 * Including `client`: this provider's 400s are frequently about the account rather than the
 * request, and returning early leaves other accounts idle.
 */
export function shouldRotate(kind) {
  return kind !== 'none'
}

/** Only the kinds that mean "limited" cool down. */
export function recordsCooldown(kind) {
  return kind === 'hard-plan' || kind === 'soft-rate' || kind === 'not-found' || kind === 'quota-exceeded'
}

export function mapErrorCode(status, body, kind) {
  if (kind === 'quota-exceeded' || kind === 'hard-plan' || kind === 'soft-rate') return ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED
  if (kind === 'session-dead') return ACCOUNT_ERROR_CODES.AUTH
  if (status >= 500 || kind === 'server') return ACCOUNT_ERROR_CODES.SERVER
  return ACCOUNT_ERROR_CODES.INVALID_REQUEST
}

/**
 * Translate an OpenAI-chat body into the SOLO body this provider expects.
 *
 * The transforms, in order:
 * - `stream` forced true, since the endpoint only streams;
 * - `function` set from the model's routing channel;
 * - `model` split into `config_name` and `model`, with the `__dev` suffix stripped;
 * - tool `parameters` stringified, because the provider parses them as a string;
 * - assistant `tool_calls` reshaped into `function_call` with list content.
 *
 * @param {Record<string, any>} body
 * @param {{ model?: string, functionName?: string }} routing
 * @returns {Record<string, any>}
 */
export function toSoloBody(body, routing = {}) {
  const out = { ...body, stream: true }
  out.function = routing.functionName ?? DEFAULT_FUNCTION
  if (typeof body.model === 'string') {
    const model = body.model.replace(/__dev$/, '')
    out.model = model
    out.config_name = model
  }
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map(tool => {
      if (tool?.type !== 'function') return tool
      const parameters = tool.function?.parameters
      return {
        ...tool,
        function: {
          ...tool.function,
          parameters: typeof parameters === 'string' ? parameters : JSON.stringify(parameters ?? {}),
        },
      }
    })
  }
  if (Array.isArray(body.messages)) {
    out.messages = body.messages.map(message => {
      if (message?.role !== 'assistant') return message
      const next = { ...message }
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        next.function_call = message.tool_calls.map(call => ({
          name: call.function?.name,
          arguments: call.function?.arguments,
        }))
        delete next.tool_calls
      }
      if (typeof message.content === 'string' && message.content.length > 0) {
        next.content = [{ type: 'text', text: message.content }]
      }
      return next
    })
  }
  return out
}

/**
 * Parse the batch model listing into catalog rows.
 *
 * Filtering is by the channel whitelist, `usage`, the `config_switch` flag, and the
 * `is_invisible_to_user` marker. A model failing any of them would be routed to a surface
 * this build does not implement, so it is dropped rather than shown and failing later.
 *
 * @param {unknown} payload
 * @param {{ channels?: readonly string[] }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function parseBatchModels(payload, { channels = DEFAULT_CHANNELS } = {}) {
  const allowed = new Set(channels)
  const groups = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  const byId = new Map()
  for (const group of groups) {
    const fn = group?.function
    if (typeof fn === 'string' && !allowed.has(fn)) continue
    const rows = Array.isArray(group?.models) ? group.models : Array.isArray(group?.list) ? group.list : []
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : undefined
      if (id === undefined || id.length === 0) continue
      if (row?.usage !== undefined && row.usage !== 'chat_completion') continue
      if (row?.config_switch === false) continue
      if (row?.is_invisible_to_user === true) continue
      if (byId.has(id)) continue
      byId.set(id, {
        id,
        name: typeof row.display_name === 'string' ? row.display_name : id,
        contextWindow: typeof row.context_window === 'number' ? row.context_window : 200_000,
        ...(typeof fn === 'string' ? { function: fn } : {}),
      })
    }
  }
  return [...byId.values()]
}

/**
 * Derive the check-in device id for a generation.
 *
 * The provider rate-limits check-in per device rather than per account, so a hit is escaped
 * by presenting a different derived device id. The derivation is deterministic from the base
 * id and the generation, which is why only the integer generation is stored: the credential's
 * own `device_id` is a fingerprint and rewriting it would touch risk control.
 *
 * @param {string} baseDeviceId
 * @param {number} generation
 * @returns {string}
 */
export function deriveCheckinDeviceId(baseDeviceId, generation) {
  if (!Number.isFinite(generation) || generation <= 0) return baseDeviceId
  // Deterministic 32-hex derivation; the exact hash is not security-relevant, only stability.
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const seed = `${baseDeviceId}#gen${generation}`
  for (let i = 0; i < seed.length; i += 1) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0
    h2 = Math.imul(h2 + seed.charCodeAt(i), 0x85ebca6b) >>> 0
  }
  const part = (value) => value.toString(16).padStart(8, '0')
  return `${part(h1)}${part(h2)}${part(Math.imul(h1, h2) >>> 0)}${part((h1 ^ h2) >>> 0)}`
}
