/**
 * Cline channel: the adapter, plus the request log that is *not* the provider's usage.
 *
 * ## Two accounting records that must not be confused
 *
 * The provider publishes plan usage (`/users/me/plan/usage-limits`), and this adapter keeps
 * a local log of the requests it made. They answer different questions:
 *
 * | | provider plan usage | local request log |
 * |---|---|---|
 * | covers | every request on the account, including other clients | only requests this plugin sent |
 * | carries | cost in USD, per-window percentages | latency, time-to-first-token, tokens |
 * | lifetime | the provider's windows | in-memory, cleared on restart |
 *
 * Reporting one as the other is wrong in a way the user cannot detect: a local log is not a
 * quota, and provider usage is not a latency record. So both exist and neither substitutes
 * for the other.
 *
 * ## "No usage reported" is not "zero usage"
 *
 * The stream carries a usage frame only sometimes. Recording `0` when it is absent would
 * make every aggregate understate real consumption, and nothing downstream could tell the
 * difference. The log therefore records whether usage was reported at all.
 *
 * @module src/accounts/providers/cline/adapter
 */

import { AccountError, ACCOUNT_ERROR_CODES } from '../../core/errors.js'
import { createOpenAiChatChannel } from '../../core/openai-chat-channel.js'
import {
  classifyHttp,
  classifyInBand,
  CLIENT_HEADERS,
  DEFAULT_CREDENTIAL_REF,
  HOSTS,
  isRegionForbidden,
  mapErrorCode,
  MAX_OUTPUT_TOKENS,
  PATHS,
  PROVIDER_ID,
  parseResetAt,
  recordsCooldown,
  shouldRotate,
} from './product.js'

/** How many request-log rows are kept in memory. */
export const HISTORY_LIMIT = 100

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
export function createClineAdapter(deps) {
  const { fetch: fetchImpl, credentials, credentialRef, accountPool, now = () => Date.now(), warn = () => {} } = deps

  /** The local request log. In-memory on purpose: it is a diagnostic, not a ledger. */
  const requestLog = []

  /**
   * Refresh one account's credential.
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
    const token = parsed.refresh_token ?? parsed.access_token
    if (typeof token !== 'string' || token.length === 0) {
      throw new AccountError(`${PROVIDER_ID}: the credential carries no token to refresh`, ACCOUNT_ERROR_CODES.AUTH)
    }
    const response = await fetchImpl(`${HOSTS.api}${PATHS.refresh}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CLIENT_HEADERS },
      body: JSON.stringify({ refreshToken: token }),
    })
    if (!response.ok) {
      throw new AccountError(`${PROVIDER_ID}: credential refresh failed (${response.status})`, ACCOUNT_ERROR_CODES.AUTH, { status: response.status })
    }
    const body = await response.json().catch(() => ({}))
    const next = body?.data ?? body
    const access = next?.accessToken ?? next?.access_token
    if (typeof access !== 'string') {
      throw new AccountError(`${PROVIDER_ID}: credential refresh returned no token`, ACCOUNT_ERROR_CODES.AUTH)
    }
    await credentials.set(ref, JSON.stringify({
      ...parsed,
      access_token: access,
      ...(typeof next?.refreshToken === 'string' ? { refresh_token: next.refreshToken } : {}),
    }))
  }

  const channel = createOpenAiChatChannel({
    provider: PROVIDER_ID,
    chatUrl: `${HOSTS.api}${PATHS.chat}`,
    defaultCredentialRef: DEFAULT_CREDENTIAL_REF,
    headers: ({ credential }) => ({
      // The provider's own SDK sends `Bearer workos:<jwt>`; the prefix is part of the
      // token, so it is preserved rather than re-added here.
      authorization: `Bearer ${credential.access_token ?? ''}`,
      ...CLIENT_HEADERS,
    }),
    classifyHttp,
    classifyInBand,
    shouldRotate,
    recordsCooldown: kind => kind === 'soft-rate',
    errorCode: mapErrorCode,
    maxAttempts: 3,
    cooldownMs: 3_600_000,
    refresh,
    deps,
  })

  /**
   * Wrap the stream so each turn leaves a request-log row.
   *
   * The row records whether usage was reported, and the first-token and first-content
   * timings, because those are the two things the provider's own usage endpoint cannot
   * tell you.
   */
  async function* stream(input) {
    const startedAt = now()
    let ttftMs
    let ttfcMs
    let usage
    let error
    try {
      for await (const chunk of channel.stream(input)) {
        if (ttftMs === undefined) ttftMs = now() - startedAt
        if (ttfcMs === undefined && (chunk.type === 'text-delta' || chunk.type === 'tool-call-delta')) {
          ttfcMs = now() - startedAt
        }
        if (chunk.type === 'usage') usage = chunk
        yield chunk
      }
    } catch (caught) {
      error = caught
      throw caught
    } finally {
      record({
        model: input.model,
        startedAt,
        latencyMs: now() - startedAt,
        ttftMs,
        ttfcMs,
        // Absence is recorded as absence, never as zero.
        usageReported: usage !== undefined,
        ...(usage === undefined ? {} : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }),
        errorCode: error === undefined ? undefined : error?.code,
      })
    }
  }

  /** Append one row, trimming to the cap. */
  function record(row) {
    requestLog.push({ ...row, at: new Date(row.startedAt).toISOString() })
    if (requestLog.length > HISTORY_LIMIT) requestLog.splice(0, requestLog.length - HISTORY_LIMIT)
  }

  /**
   * List models by merging the four sources.
   *
   * Each source is fetched independently and a failure in one degrades that source only:
   * the anonymous listing failing must not lose the curated table.
   *
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function listModels({ signal } = {}) {
    const token = await resolveToken()
    const [freeIds, recommended, allIds] = await Promise.all([
      fetchRecommended(signal),
      fetchRecommendedExtra(signal),
      fetchAllIds(token, signal),
    ])
    const { mergeClineModels } = await import('./product.js')
    return mergeClineModels({ remoteFreeIds: freeIds, remoteRecommended: recommended, remoteAllIds: allIds })
  }

  /** Best-effort token for the account-scoped listing. */
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

  /** The anonymous listing's free set. */
  async function fetchRecommended(signal) {
    try {
      const response = await fetchImpl(`${HOSTS.api}${PATHS.recommended}`, {
        headers: { accept: 'application/json', ...CLIENT_HEADERS },
        signal,
      })
      if (!response.ok) return []
      const body = await response.json()
      const rows = body?.data?.free ?? body?.free
      return Array.isArray(rows)
        ? rows.map(row => (typeof row === 'string' ? row : row?.id)).filter(id => typeof id === 'string')
        : []
    } catch (error) {
      warn(`[${PROVIDER_ID}] recommended listing failed: ${String(error)}`)
      return []
    }
  }

  /** Recommended and pass entries that are not in the free set. */
  async function fetchRecommendedExtra(signal) {
    try {
      const response = await fetchImpl(`${HOSTS.api}${PATHS.recommended}`, {
        headers: { accept: 'application/json', ...CLIENT_HEADERS },
        signal,
      })
      if (!response.ok) return []
      const body = await response.json()
      const rows = [
        ...(body?.data?.recommended ?? body?.recommended ?? []),
        ...(body?.data?.clinePass ?? body?.clinePass ?? []),
      ]
      return rows.map(row => (typeof row === 'string' ? row : row?.id)).filter(id => typeof id === 'string')
    } catch {
      return []
    }
  }

  /** The account-scoped id list. */
  async function fetchAllIds(token, signal) {
    if (token === undefined) return []
    try {
      const response = await fetchImpl(`${HOSTS.api}${PATHS.models}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...CLIENT_HEADERS },
        signal,
      })
      if (!response.ok) return []
      const body = await response.json()
      const rows = body?.data ?? body?.models ?? body
      return Array.isArray(rows)
        ? rows.map(row => (typeof row === 'string' ? row : row?.id)).filter(id => typeof id === 'string')
        : []
    } catch (error) {
      warn(`[${PROVIDER_ID}] model listing failed: ${String(error)}`)
      return []
    }
  }

  /**
   * The provider's plan usage, which is not the local log.
   *
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function planUsage({ signal } = {}) {
    const token = await resolveToken()
    if (token === undefined) throw new AccountError(`${PROVIDER_ID}: no credential`, ACCOUNT_ERROR_CODES.MISSING_CREDENTIAL)
    const response = await fetchImpl(`${HOSTS.api}${PATHS.planUsage}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...CLIENT_HEADERS },
      signal,
    })
    if (!response.ok) {
      throw new AccountError(`${PROVIDER_ID}: plan usage unavailable (${response.status})`, ACCOUNT_ERROR_CODES.SERVER, { status: response.status })
    }
    const body = await response.json()
    const limits = body?.data?.limits ?? body?.limits ?? []
    return Array.isArray(limits)
      ? limits.map(limit => ({
        window: limit?.type,
        percentUsed: limit?.percentUsed,
        resetsAt: limit?.resetsAt,
      }))
      : []
  }

  /** A copy of the local request log, newest last. */
  function requestLogSnapshot() {
    return requestLog.map(row => ({ ...row }))
  }

  return {
    provider: PROVIDER_ID,
    stream,
    listModels,
    planUsage,
    requestLogSnapshot,
    refresh,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    isRegionForbidden,
    parseResetAt,
  }
}

export { recordsCooldown }
