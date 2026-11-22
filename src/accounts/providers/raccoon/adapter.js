/**
 * Raccoon channel: the adapter.
 *
 * Adds two behaviours the shared chat flow does not have:
 *
 * 1. the two-state thinking switch, which rides `extra_body.thinking` rather than a
 *    top-level `reasoning_effort`;
 * 2. a refresh that only replaces the refresh token when the provider returns a new one —
 *    dropping the old token on a response that omitted it would strand the account at the
 *    next expiry.
 *
 * @module src/accounts/providers/raccoon/adapter
 */

import { AccountError, ACCOUNT_ERROR_CODES } from '../../core/errors.js'
import { createOpenAiChatChannel } from '../../core/openai-chat-channel.js'
import { nextUtc8DayStartMs } from '../../core/selection.js'
import {
  classifyHttp,
  classifyInBand,
  DEFAULT_CREDENTIAL_REF,
  DEFAULT_THINKING,
  FALLBACK_MODELS,
  HOSTS,
  isQuotaError,
  isRefreshable,
  mapErrorCode,
  PATHS,
  PROVIDER_ID,
  recordsCooldown,
  REFRESH_WINDOW_MS,
  resolveImageCapability,
  shouldRotate,
  thinkingType,
} from './product.js'

/** Headers the provider's own client sends. */
const CLIENT_HEADERS = Object.freeze({
  'X-Raccoon-Language': 'zh',
  'X-Client-Platform': 'desktop',
})

/**
 * Create the adapter.
 *
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {{ resolve: Function, set: Function }} deps.credentials
 * @param {(ref: string) => string} deps.credentialRef
 * @param {object} [deps.accountPool]
 * @param {() => number} [deps.now]
 * @param {(message: string) => void} [deps.warn]
 * @returns {object}
 */
export function createRaccoonAdapter(deps) {
  const { fetch: fetchImpl, credentials, credentialRef, accountPool, now = () => Date.now(), warn = () => {} } = deps

  /**
   * Refresh a credential.
   *
   * The new refresh token is stored only when the response carries one. A response that
   * omits it is a partial success, and overwriting the stored token with nothing would
   * leave the account unable to refresh at the next expiry — a failure that shows up hours
   * later with no visible cause.
   *
   * @param {{ accountId?: string }} spec
   */
  async function refresh({ accountId }) {
    const ref = accountId === undefined
      ? credentialRef(DEFAULT_CREDENTIAL_REF)
      : credentialRef(String(accountId).toUpperCase().replace(/-/g, '_'))
    const stored = await credentials.resolve(ref)
    if (stored === undefined) throw new AccountError(`${PROVIDER_ID}: no credential to refresh`, ACCOUNT_ERROR_CODES.AUTH)
    const parsed = JSON.parse(stored.value)
    if (!isRefreshable(parsed)) {
      throw new AccountError(`${PROVIDER_ID}: the credential has no refresh token; log in again`, ACCOUNT_ERROR_CODES.AUTH)
    }
    const response = await fetchImpl(`${HOSTS.api}${PATHS.refresh}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CLIENT_HEADERS },
      body: JSON.stringify({ refresh_token: parsed.refresh_token }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || String(body?.code ?? '') === '200003') {
      throw new AccountError(`${PROVIDER_ID}: refresh rejected; log in again`, ACCOUNT_ERROR_CODES.AUTH, { status: response.status })
    }
    const next = body?.data ?? body
    const access = next?.access_token ?? next?.token
    if (typeof access !== 'string' || access.length === 0) {
      throw new AccountError(`${PROVIDER_ID}: refresh returned no access token`, ACCOUNT_ERROR_CODES.AUTH)
    }
    await credentials.set(ref, JSON.stringify({
      ...parsed,
      access_token: access,
      // Preserve the old refresh token when the response omits it.
      ...(typeof next.refresh_token === 'string' && next.refresh_token.length > 0
        ? { refresh_token: next.refresh_token }
        : {}),
      ...(typeof next.expires_in === 'number'
        ? { expires_at: new Date(now() + next.expires_in * 1000).toISOString() }
        : {}),
    }))
  }

  const channel = createOpenAiChatChannel({
    provider: PROVIDER_ID,
    chatUrl: `${HOSTS.api}${PATHS.chat}`,
    defaultCredentialRef: DEFAULT_CREDENTIAL_REF,
    headers: ({ credential }) => ({
      authorization: `Bearer ${credential.access_token ?? ''}`,
      ...(typeof credential.org_code === 'string' && credential.org_code.length > 0
        ? { 'X-Org-Code': credential.org_code }
        : {}),
      ...CLIENT_HEADERS,
    }),
    classifyHttp,
    classifyInBand,
    shouldRotate,
    recordsCooldown,
    errorCode: mapErrorCode,
    maxAttempts: 3,
    cooldownMs: 86_400_000,
    refresh,
    deps: { ...deps, accountPool: poolProxy() },
  })

  /** Cool a spent model to the next UTC+8 day, matching the provider's daily settlement. */
  function poolProxy() {
    if (accountPool === undefined) return undefined
    return {
      getAvailableAccount: (provider, model) => accountPool.getAvailableAccount(provider, model),
      updateModelRateLimit: async (id, model, at) => {
        await accountPool.updateModelRateLimit(id, model, Math.max(at, nextUtc8DayStartMs(now())))
      },
    }
  }

  /**
   * The stream, with the thinking switch applied.
   *
   * Thinking rides `extra_body` rather than a top-level field: the provider reads it there,
   * and a top-level `thinking` would be ignored.
   */
  async function* stream(input) {
    const thinking = input.thinking ?? DEFAULT_THINKING
    yield* channel.stream({
      ...input,
      extra: { ...(input.extra ?? {}), extra_body: { thinking: { type: thinkingType(thinking) } } },
    })
  }

  /**
   * List models from the remote catalog, falling back to the static table.
   *
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function listModels({ signal } = {}) {
    let token
    try {
      if (accountPool !== undefined) {
        const available = await accountPool.getAvailableAccount(PROVIDER_ID, '')
        token = available?.credential?.access_token
      }
      if (token === undefined) {
        const stored = await credentials.resolve(credentialRef(DEFAULT_CREDENTIAL_REF))
        token = stored === undefined ? undefined : JSON.parse(stored.value).access_token
      }
    } catch {
      token = undefined
    }
    if (token === undefined) return FALLBACK_MODELS.map(row => ({ ...row }))
    try {
      const response = await fetchImpl(`${HOSTS.api}${PATHS.modelCatalog}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...CLIENT_HEADERS },
        signal,
        // The catalog is a small listing; a long wait here would stall the picker.
      })
      if (!response.ok) return FALLBACK_MODELS.map(row => ({ ...row }))
      const body = await response.json()
      const rows = body?.data ?? body?.models ?? body
      if (!Array.isArray(rows) || rows.length === 0) return FALLBACK_MODELS.map(row => ({ ...row }))
      return rows.map(row => {
        const id = typeof row?.id === 'string' ? row.id : row?.model
        if (typeof id !== 'string' || id.length === 0) return undefined
        const curated = FALLBACK_MODELS.find(model => model.id === id)
        return {
          id,
          name: typeof row.name === 'string' ? row.name : (curated?.name ?? id),
          contextWindow: typeof row.context_length === 'number' ? row.context_length : (curated?.contextWindow ?? 1_000_000),
          maxTokens: typeof row.max_tokens === 'number' ? row.max_tokens : curated?.maxTokens,
          supportsImage: resolveImageCapability({ id, tags: Array.isArray(row.tags) ? row.tags : undefined }),
        }
      }).filter(row => row !== undefined)
    } catch (error) {
      warn(`[${PROVIDER_ID}] model catalog failed, using the static table: ${String(error)}`)
      return FALLBACK_MODELS.map(row => ({ ...row }))
    }
  }

  /**
   * The account balance, in points.
   *
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function balance({ signal } = {}) {
    const token = await resolveToken()
    if (token === undefined) throw new AccountError(`${PROVIDER_ID}: no credential`, ACCOUNT_ERROR_CODES.MISSING_CREDENTIAL)
    const response = await fetchImpl(`${HOSTS.api}${PATHS.balance}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...CLIENT_HEADERS },
      signal,
    })
    if (!response.ok) {
      throw new AccountError(`${PROVIDER_ID}: balance unavailable (${response.status})`, ACCOUNT_ERROR_CODES.SERVER, { status: response.status })
    }
    const body = await response.json()
    if (isQuotaError(body)) return { points: 0, exhausted: true }
    const data = body?.data ?? body
    return {
      points: typeof data?.points === 'number' ? data.points : 0,
      exhausted: false,
    }
  }

  async function resolveToken() {
    try {
      if (accountPool !== undefined) {
        const available = await accountPool.getAvailableAccount(PROVIDER_ID, '')
        if (available !== null && available !== undefined) return available.credential.access_token
      }
      const stored = await credentials.resolve(credentialRef(DEFAULT_CREDENTIAL_REF))
      return stored === undefined ? undefined : JSON.parse(stored.value).access_token
    } catch {
      return undefined
    }
  }

  return {
    provider: PROVIDER_ID,
    stream,
    listModels,
    balance,
    refresh,
    refreshWindowMs: REFRESH_WINDOW_MS,
    isRefreshable,
  }
}
