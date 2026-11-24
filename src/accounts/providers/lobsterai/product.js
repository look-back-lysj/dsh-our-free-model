/**
 * LobsterAI channel: product constants and the model catalog.
 *
 * ## Catalog precedence
 *
 * The remote listing wins when it answers, and the static table is the fallback. That
 * direction matters: the static table is a compile-time snapshot, so a model the provider
 * has retired must stop appearing even though it is still in the table, while a model the
 * provider has added must appear without a release.
 *
 * Capabilities are only advertised when the *remote* entry declares them. The static rows
 * carry no image flag at all, and defaulting that to "supported" would make the harness
 * project images into a request the provider then rejects.
 *
 * @module src/accounts/providers/lobsterai/product
 */

/** Hosts this channel talks to. */
export const HOSTS = Object.freeze({
  api: 'https://lobsterai-server.youdao.com',
  portal: 'https://lobsterai.youdao.com',
  clientVersion: 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update',
})

/** Paths, relative to {@link HOSTS.api} unless stated otherwise. */
export const PATHS = Object.freeze({
  chat: '/api/proxy/v1/chat/completions',
  models: '/api/models/available',
  exchange: '/api/auth/exchange',
  refresh: '/api/auth/refresh',
})

/** Client identity the provider expects; omitting it yields an opaque rejection. */
export const CLIENT_HEADERS = Object.freeze({
  'X-LobsterAI-Client-Capabilities': 'kimi-k3-agentic-v1,thinking-level-control-v1',
  'User-Agent': 'LobsterAI/0.1.0',
})

/**
 * The static fallback catalog.
 *
 * `contextWindow` only: this table declares no image or effort capability, and inventing
 * one here would be a guess the provider has not confirmed.
 */
export const FALLBACK_MODELS = Object.freeze([
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', contextWindow: 131_072 },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', contextWindow: 131_072 },
  { id: 'MiniMax-M3', name: 'MiniMax-M3', contextWindow: 131_072 },
  { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', contextWindow: 131_072 },
  { id: 'qwen3.7-max', name: 'qwen3.7-max', contextWindow: 131_072 },
  { id: 'qwen3.7-plus', name: 'qwen3.7-plus', contextWindow: 131_072 },
  { id: 'qwen3.6-plus', name: 'qwen3.6-plus', contextWindow: 131_072 },
  { id: 'qwen3.5-plus-2026-04-20', name: 'qwen3.5-plus-2026-04-20', contextWindow: 131_072 },
  { id: 'kimi-k2.7-code', name: 'kimi-k2.7-code', contextWindow: 131_072 },
  { id: 'kimi-k2.7-code-highspeed', name: 'kimi-k2.7-code-highspeed', contextWindow: 131_072 },
  { id: 'kimi-k2.6', name: 'kimi-k2.6', contextWindow: 131_072 },
  { id: 'kimi-k2.5', name: 'kimi-k2.5', contextWindow: 131_072 },
  { id: 'doubao-seed-2-1-pro-260628', name: 'doubao-seed-2-1-pro-260628', contextWindow: 131_072 },
  { id: 'doubao-seed-2-1-turbo-260628', name: 'doubao-seed-2-1-turbo-260628', contextWindow: 131_072 },
  { id: 'doubao-seed-2-0-code-preview-260215', name: 'doubao-seed-2-0-code-preview-260215', contextWindow: 131_072 },
  { id: 'glm-5.2', name: 'glm-5.2', contextWindow: 131_072 },
  { id: 'glm-5.1', name: 'glm-5.1', contextWindow: 131_072 },
  { id: 'glm-5v-turbo', name: 'glm-5v-turbo', contextWindow: 131_072 },
  { id: 'glm-5', name: 'glm-5', contextWindow: 131_072 },
])

/** Credential ref this channel uses when no account row is selected. */
export const DEFAULT_CREDENTIAL_REF = 'LOBSTERAI_ACCESS_TOKEN'

/** The provider id, used for account lookups and ledger attribution. */
export const PROVIDER_ID = 'lobsterai'

/** Reasoning levels the wire accepts. `xhigh` is the top value; there is no `max`. */
export const EFFORT_LEVELS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

/**
 * Build the model list to present.
 *
 * @param {Array<Record<string, any>> | undefined} remote - the provider's listing, if any
 * @returns {Array<Record<string, any>>}
 */
export function resolveModels(remote) {
  if (!Array.isArray(remote) || remote.length === 0) return FALLBACK_MODELS.map(row => ({ ...row }))
  const fallbackById = new Map(FALLBACK_MODELS.map(row => [row.id, row]))
  return remote.map(entry => {
    const id = typeof entry?.id === 'string' ? entry.id : undefined
    if (id === undefined) return undefined
    const fallback = fallbackById.get(id)
    /** @type {Record<string, any>} */
    const row = {
      id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : (fallback?.name ?? id),
      contextWindow: typeof entry.contextWindow === 'number' ? entry.contextWindow : (fallback?.contextWindow ?? 131_072),
    }
    // Image support is advertised only when the remote entry says so; the static table
    // never does.
    if (entry.supportsImage === true) row.supportsImage = true
    // Effort menu likewise comes from the remote thinking config, not from a guess.
    if (Array.isArray(entry.thinkingLevels) && entry.thinkingLevels.length > 0) {
      row.efforts = entry.thinkingLevels.filter(level => EFFORT_LEVELS.includes(level))
      if (row.efforts.length === 0) delete row.efforts
    }
    return row
  }).filter(row => row !== undefined)
}
