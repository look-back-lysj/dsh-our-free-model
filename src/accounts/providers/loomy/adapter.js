/**
 * Loomy channel: the adapter, with the cancel-before-refresh rule and balance selection.
 *
 * ## The rule this channel has and the others do not
 *
 * On an auth failure the previous response body is cancelled **before** the credential is
 * refreshed and before the request is re-sent. Leaving the old body open while a refresh
 * and a second request run means two live upstream connections for one turn, and the
 * abandoned one keeps consuming the account's rate budget until the socket times out.
 *
 * ## Balance selection is a routing decision, not a display preference
 *
 * Which account is picked depends on what it can spend. With permanent credits locked, an
 * account holding only permanent credit must not be chosen at all — spending it is
 * irreversible, and the lock exists precisely to prevent that. So the selection hook is
 * supplied here rather than left to the generic pool.
 *
 * @module src/accounts/providers/loomy/adapter
 */

import { AccountError, ACCOUNT_ERROR_CODES } from '../../core/errors.js'
import { createOpenAiChatChannel } from '../../core/openai-chat-channel.js'
import { nextUtc8DayStartMs } from '../../core/selection.js'
import {
  classifyHttp,
  classifyInBand,
  DEFAULT_CREDENTIAL_REF,
  fallbackAsRemote,
  HOSTS,
  mapErrorCode,
  PATHS,
  PROVIDER_ID,
  rankByBalance,
  readBalance,
  recordsCooldown,
  resolveEffort,
  shouldRotate,
} from './product.js'

/**
 * Create the adapter.
 *
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {{ resolve: Function, set: Function }} deps.credentials
 * @param {(ref: string) => string} deps.credentialRef
 * @param {object} [deps.accountPool]
 * @param {() => boolean} [deps.permanentLocked] - whether permanent credits are locked
 * @param {() => number} [deps.now]
 * @param {(message: string) => void} [deps.warn]
 * @returns {object}
 */
export function createLoomyAdapter(deps) {
  const {
    fetch: fetchImpl,
    credentials,
    credentialRef,
    accountPool,
    permanentLocked = () => false,
    now = () => Date.now(),
    warn = () => {},
  } = deps

  /** Cached balances, with a short failure TTL so one bad read does not stick. */
  const balanceCache = new Map()
  const BALANCE_TTL_MS = 60_000
  const BALANCE_FAILURE_TTL_MS = 5_000

  /**
   * Read one account's balance, caching both outcomes.
   *
   * The failure TTL is much shorter than the success TTL: a failed read is usually a blip,
   * while a successful one describes a state that changes slowly.
   *
   * @param {Record<string, any>} entry
   * @param {Record<string, any>} credential
   * @returns {Promise<null | Record<string, number>>}
   */
  async function balanceOf(entry, credential) {
    const cached = balanceCache.get(entry.id)
    const at = now()
    if (cached !== undefined && at < cached.expiresAt) return cached.value
    let value = null
    try {
      const response = await fetchImpl(`${HOSTS.api}${PATHS.pointsRecords}?pageNo=1&pageSize=1&recordType=all`, {
        headers: { authorization: `Bearer ${credential.access_token ?? ''}`, token: credential.access_token ?? '' },
      })
      if (response.ok) value = readBalance(await response.json())
    } catch (error) {
      warn(`[${PROVIDER_ID}] balance query failed for ${entry.id}: ${String(error)}`)
    }
    balanceCache.set(entry.id, {
      value,
      expiresAt: at + (value === null ? BALANCE_FAILURE_TTL_MS : BALANCE_TTL_MS),
    })
    return value
  }

  /**
   * Choose the next account by what it can spend.
   *
   * Returns undefined rather than throwing so the shared wrapper can fall back to the pool
   * when this channel has nothing to add.
   *
   * @param {string} model
   * @param {ReadonlySet<string>} tried
   * @returns {Promise<undefined | { accountId: string, credential: Record<string, any> }>}
   */
  async function nextAccount(model, tried) {
    if (accountPool === undefined) return undefined
    const candidates = accountPool.listAccountsByProvider(PROVIDER_ID)
      .filter(entry => entry.enabled !== false && !tried.has(entry.id))
      .filter(entry => !((entry.modelRateLimits?.[model] ?? 0) > now()))
    if (candidates.length === 0) return undefined

    const withBalance = []
    for (const entry of candidates) {
      const credential = await accountPool.resolveCredentialForAccount?.(entry.id)
      if (credential === undefined || credential === null) continue
      const balance = await balanceOf(entry, credential)
      withBalance.push({
        id: entry.id,
        credential,
        // An unreadable balance is treated as unknown, which ranks below a known-good
        // daily balance but above nothing at all.
        balance: balance === null ? null : balance.balance,
        dailyBalance: balance === null ? null : balance.dailyBalance,
        unknown: balance === null,
      })
    }
    if (withBalance.length === 0) return undefined

    const unknown = withBalance.filter(entry => entry.unknown)
    const known = withBalance.filter(entry => !entry.unknown)
    const allowPermanent = !permanentLocked()
    const ranked = rankByBalance(known, { allowPermanent })
    // Only a spendable tier may be chosen. Tier 2 means "permanent credit only, and
    // permanent spending is locked" — selecting it would spend credit the user asked us to
    // protect, and that spend cannot be undone.
    const spendable = ranked.filter(entry => entry.tier <= 1)
    if (spendable.length > 0) {
      const chosen = withBalance.find(entry => entry.id === spendable[0].id)
      if (chosen !== undefined) return { accountId: chosen.id, credential: chosen.credential }
    }
    // Nothing has a spendable balance. An account whose balance could not be read is still
    // a candidate: refusing it would strand capacity over a transient read failure, and the
    // provider will reject the request if the balance really is empty.
    if (unknown.length > 0) {
      return { accountId: unknown[0].id, credential: unknown[0].credential }
    }
    return undefined
  }

  const channel = createOpenAiChatChannel({
    provider: PROVIDER_ID,
    chatUrl: `${HOSTS.api}${PATHS.chat}`,
    defaultCredentialRef: DEFAULT_CREDENTIAL_REF,
    headers: ({ credential }) => ({
      // Both headers are sent: the business endpoints read `token`, the chat endpoint
      // reads `Authorization`, and omitting either fails on some endpoints.
      authorization: `Bearer ${credential.access_token ?? ''}`,
      token: credential.access_token ?? '',
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

  /**
   * Present the pool so that a quota failure cools the model to the next UTC+8 day and the
   * selection hook is used.
   */
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
   * "Refresh" for this channel: probe the token, because there is no refresh endpoint.
   *
   * @param {{ accountId?: string }} spec
   */
  async function refresh({ accountId }) {
    const ref = accountId === undefined
      ? credentialRef(DEFAULT_CREDENTIAL_REF)
      : credentialRef(String(accountId).toUpperCase().replace(/-/g, '_'))
    const stored = await credentials.resolve(ref)
    if (stored === undefined) throw new AccountError(`${PROVIDER_ID}: no credential to probe`, ACCOUNT_ERROR_CODES.AUTH)
    const parsed = JSON.parse(stored.value)
    const response = await fetchImpl(`${HOSTS.api}${PATHS.pointsRecords}?pageNo=1&pageSize=1`, {
      headers: { authorization: `Bearer ${parsed.access_token ?? ''}`, token: parsed.access_token ?? '' },
    })
    if (!response.ok) {
      throw new AccountError(`${PROVIDER_ID}: the stored token is no longer accepted`, ACCOUNT_ERROR_CODES.AUTH, { status: response.status })
    }
    const envelope = await response.json().catch(() => ({}))
    if (envelope?.code === '100002') {
      throw new AccountError(`${PROVIDER_ID}: the session is revoked; log in again`, ACCOUNT_ERROR_CODES.AUTH)
    }
    balanceCache.delete(accountId ?? '')
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
    if (token === undefined) return fallbackAsRemote()
    try {
      const response = await fetchImpl(`${HOSTS.api}${PATHS.models}`, {
        headers: { authorization: `Bearer ${token}`, token, accept: 'application/json' },
        signal,
      })
      if (!response.ok) return fallbackAsRemote()
      const body = await response.json()
      const rows = body?.data ?? body?.models ?? body
      if (!Array.isArray(rows)) return fallbackAsRemote()
      const mapped = rows
        .filter(row => row?.type === 'chat')
        .map(row => ({
          id: row.id ?? row.name,
          name: typeof row.name === 'string' ? row.name : String(row.id ?? ''),
          contextWindow: typeof row.context_length === 'number' ? row.context_length : 1_048_576,
          supportsImage: Array.isArray(row.capabilities?.input_modalities)
            && row.capabilities.input_modalities.includes('image'),
          supportsThinking: row.capabilities?.reasoning === true,
          ...(Array.isArray(row.reasoning_efforts) && row.reasoning_efforts.length > 0
            ? { efforts: row.reasoning_efforts, defaultEffort: row.default_reasoning_effort ?? 'high' }
            : {}),
        }))
        .filter(row => typeof row.id === 'string' && row.id.length > 0)
      return mapped.length === 0 ? fallbackAsRemote() : mapped
    } catch (error) {
      warn(`[${PROVIDER_ID}] model listing failed, using the static table: ${String(error)}`)
      return fallbackAsRemote()
    }
  }

  /**
   * The stream, with the cancel-before-refresh rule applied.
   *
   * The shared channel handles rotation; this wrapper only adds the one behaviour specific
   * to this provider: nothing about a turn may overlap the next one.
   */
  async function* stream(input) {
    const model = (await listModels()).find(row => row.id === input.model)
    const effort = resolveEffort(model, input.reasoningEffort)
    yield* channel.stream({ ...input, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
  }

  return {
    provider: PROVIDER_ID,
    stream,
    listModels,
    nextAccount,
    balanceOf,
    refresh,
    /** Always false: this channel has no refresh endpoint. */
    refreshable: () => false,
  }
}
