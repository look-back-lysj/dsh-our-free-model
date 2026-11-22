/**
 * LobsterAI channel: the adapter, built on the shared OpenAI-chat flow.
 *
 * Only the four things that differ from every other chat channel are specified here:
 * where to POST, which client headers the provider demands, how to classify a failure, and
 * how to refresh a credential. Everything else — pairing, streaming, truncation, usage,
 * abort — is the shared implementation, so a fix there reaches this channel too.
 *
 * @module src/accounts/providers/lobsterai/adapter
 */

import { AccountError, ACCOUNT_ERROR_CODES } from '../../core/errors.js'
import { createOpenAiChatChannel } from '../../core/openai-chat-channel.js'
import {
  classifyHttp,
  classifyInBand,
  COOLDOWN_FALLBACK_MS,
  MAX_ATTEMPTS,
  recordsCooldown,
  shouldRotate,
} from './errors.js'
import {
  CLIENT_HEADERS,
  DEFAULT_CREDENTIAL_REF,
  HOSTS,
  PATHS,
  PROVIDER_ID,
  resolveModels,
} from './product.js'

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
export function createLobsteraiAdapter(deps) {
  const { fetch: fetchImpl, credentials, credentialRef, accountPool, now = () => Date.now(), warn = () => {} } = deps

  /**
   * Refresh one account's credential.
   *
   * The account id is mapped back to its credential ref by the same rule the index uses,
   * so a refreshed token lands on the row that needed it rather than on the default ref.
   *
   * @param {{ accountId?: string }} spec
   */
  async function refresh({ accountId }) {
    const ref = accountId === undefined
      ? credentialRef(DEFAULT_CREDENTIAL_REF)
      : credentialRef(String(accountId).toUpperCase().replace(/-/g, '_'))
    const stored = await credentials.resolve(ref)
    if (stored === undefined) {
      throw new AccountError(`${PROVIDER_ID}: no credential to refresh`, ACCOUNT_ERROR_CODES.AUTH)
    }
    const parsed = JSON.parse(stored.value)
    const token = parsed.refresh_token
    if (typeof token !== 'string' || token.length === 0) {
      throw new AccountError(`${PROVIDER_ID}: the credential carries no refresh token`, ACCOUNT_ERROR_CODES.AUTH)
    }
    const response = await fetchImpl(`${HOSTS.api}${PATHS.refresh}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CLIENT_HEADERS },
      body: JSON.stringify({ refresh_token: token }),
    })
    if (!response.ok) {
      throw new AccountError(`${PROVIDER_ID}: credential refresh failed (${response.status})`, ACCOUNT_ERROR_CODES.AUTH, { status: response.status })
    }
    const body = await response.json().catch(() => ({}))
    const next = body?.data ?? body
    if (typeof next?.access_token !== 'string') {
      throw new AccountError(`${PROVIDER_ID}: credential refresh returned no access token`, ACCOUNT_ERROR_CODES.AUTH)
    }
    await credentials.set(ref, JSON.stringify({
      ...parsed,
      access_token: next.access_token,
      ...(typeof next.refresh_token === 'string' ? { refresh_token: next.refresh_token } : {}),
      ...(typeof next.expires_in === 'number' ? { expires_at: new Date(now() + next.expires_in * 1000).toISOString() } : {}),
    }))
  }

  const channel = createOpenAiChatChannel({
    provider: PROVIDER_ID,
    chatUrl: `${HOSTS.api}${PATHS.chat}`,
    defaultCredentialRef: DEFAULT_CREDENTIAL_REF,
    headers: ({ credential }) => ({
      authorization: `Bearer ${credential.access_token ?? ''}`,
      accept: 'text/event-stream, application/json',
      ...CLIENT_HEADERS,
    }),
    classifyHttp,
    classifyInBand,
    shouldRotate,
    recordsCooldown,
    errorCode: mapErrorCode,
    maxAttempts: MAX_ATTEMPTS,
    cooldownMs: COOLDOWN_FALLBACK_MS,
    refresh,
    deps,
  })

  /**
   * List models, preferring the remote listing.
   *
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async function listModels({ signal } = {}) {
    let remote
    try {
      const stored = accountPool !== undefined
        ? (await accountPool.getAvailableAccount(PROVIDER_ID, ''))?.credential
        : JSON.parse((await credentials.resolve(credentialRef(DEFAULT_CREDENTIAL_REF)))?.value ?? '{}')
      const response = await fetchImpl(`${HOSTS.api}${PATHS.models}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${stored?.access_token ?? ''}`,
          accept: 'application/json',
          ...CLIENT_HEADERS,
        },
        signal,
      })
      if (response.ok) {
        const body = await response.json()
        remote = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : undefined
      }
    } catch (error) {
      warn(`[${PROVIDER_ID}] model listing failed, using the static table: ${String(error)}`)
    }
    return resolveModels(remote)
  }

  return { provider: PROVIDER_ID, listModels, stream: channel.stream, refresh }
}

/**
 * Map a classification onto the harness error vocabulary.
 *
 * A dead session, a ban, and a bare 401/403 all mean "this credential will not work", which
 * is AUTH. An exhausted allowance is QUOTA_EXCEEDED so callers do not retry it. Everything
 * else keeps the status-derived meaning.
 *
 * @param {number} status
 * @param {string} body
 * @param {string} kind
 * @returns {string}
 */
export function mapErrorCode(status, body, kind) {
  if (kind === 'hard-credit' || kind === 'soft-rate') return ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED
  if (kind === 'session-dead' || kind === 'banned' || status === 401 || status === 403) return ACCOUNT_ERROR_CODES.AUTH
  if (status === 429) return ACCOUNT_ERROR_CODES.RATE_LIMIT
  if (status >= 500) return ACCOUNT_ERROR_CODES.SERVER
  return ACCOUNT_ERROR_CODES.INVALID_REQUEST
}
