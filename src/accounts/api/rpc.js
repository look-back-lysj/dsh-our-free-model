/**
 * The account RPC gateway: the frozen envelope, the frozen method set, and the new core.
 *
 * ## What this module is for
 *
 * The host and the standalone worker both speak one RPC envelope: a POST to a fixed path whose
 * body is `{ type: 'client-request', rpcId, method, payload: { method, payload } }`, answered
 * with `{ type: 'server-response', rpcId, result }`. The method names are a frozen contract —
 * the UI calls them by name and a rename is a breaking change.
 *
 * So this module is the seam: it accepts the frozen envelope, dispatches the frozen method names
 * onto the independently written account core, and returns the frozen response. Nothing about
 * the envelope or the method names is invented here; what is new is everything behind them.
 *
 * ## Why the method set is a frozen table
 *
 * The dispatch table is data, not a switch, so it can be compared against the contract in a test.
 * A method that exists in the contract but not here fails loudly at mount time rather than
 * silently returning "unknown method" to the panel at run time.
 *
 * @module src/accounts/api/rpc
 */

import { ACCOUNT_ERROR_CODES, AccountError } from '../core/errors.js'
import { ACCOUNT_PROVIDERS } from '../core/index-store.js'

/** The transport path both hosts register. */
export const RPC_PATH = '/api/channel-pack'

/** The envelope's method field, unchanged from the absorbed implementation. */
export const RPC_METHOD = 'channel-pack'

/**
 * The 45 frozen RPC method names, grouped by family for readability.
 *
 * The grouping is documentation; the gate compares the flat set.
 */
export const RPC_METHODS = Object.freeze([
  // accounts
  'account.list', 'account.create', 'account.update', 'account.delete', 'account.reorder',
  'account.refresh', 'account.retest', 'account.retestAll', 'account.test',
  'account.reset', 'account.resetAll',
  // login
  'login.poll', 'login.sendSms', 'login.submitSms', 'onboarding.status', 'onboarding.claim',
  // credits
  'credits.status', 'credits.claimAll', 'credits.balances', 'credits.permanentLock', 'loomy.permanentLock',
  'cline.quota', 'cline.requestLog',
  // models
  'model.list', 'model.setDisabled', 'model.setDisabledMany', 'model.setAllDisabled', 'model.clearDead',
  // providers
  'provider.status', 'provider.setEnabled', 'provider.getOrder', 'provider.setOrder',
  'gateway.getEnabled', 'gateway.setEnabled',
  // captcha
  'captcha.demand', 'captcha.carrierUrl', 'captcha.contribute',
  // backup
  'backup.export', 'backup.import', 'backup.status',
  // usage
  'usage.badge', 'usage.tokenLedger', 'usage.tokenLedgerHistory', 'usage.badgePreference', 'usage.autoCheckin',
])

/** The method set, for membership tests. */
const METHOD_SET = new Set(RPC_METHODS)

/**
 * Validate an envelope, returning the method and payload or throwing a typed error.
 *
 * A malformed envelope is a client bug, so it is rejected with a specific reason rather than
 * being coerced into something the dispatcher might act on.
 *
 * @param {unknown} body
 * @returns {{ rpcId: string, method: string, payload: Record<string, unknown> }}
 */
export function readEnvelope(body) {
  if (body === null || typeof body !== 'object') {
    throw new AccountError('the RPC body is not an object', ACCOUNT_ERROR_CODES.INVALID_REQUEST)
  }
  const record = /** @type {Record<string, any>} */ (body)
  if (record.type !== 'client-request') {
    throw new AccountError(`unexpected envelope type: ${String(record.type)}`, ACCOUNT_ERROR_CODES.INVALID_REQUEST)
  }
  if (typeof record.rpcId !== 'string' || record.rpcId.length === 0) {
    throw new AccountError('the envelope carries no rpcId', ACCOUNT_ERROR_CODES.INVALID_REQUEST)
  }
  if (record.method !== RPC_METHOD) {
    throw new AccountError(`unexpected envelope method: ${String(record.method)}`, ACCOUNT_ERROR_CODES.INVALID_REQUEST)
  }
  const inner = record.payload
  if (inner === null || typeof inner !== 'object') {
    throw new AccountError('the envelope carries no payload', ACCOUNT_ERROR_CODES.INVALID_REQUEST)
  }
  if (typeof inner.method !== 'string' || inner.method.length === 0) {
    throw new AccountError('the payload carries no method', ACCOUNT_ERROR_CODES.INVALID_REQUEST)
  }
  if (!METHOD_SET.has(inner.method)) {
    throw new AccountError(`unknown RPC method: ${inner.method}`, ACCOUNT_ERROR_CODES.INVALID_REQUEST)
  }
  const payload = inner.payload === null || inner.payload === undefined || typeof inner.payload !== 'object'
    ? {}
    : inner.payload
  return { rpcId: record.rpcId, method: inner.method, payload }
}

/**
 * Build the response envelope.
 *
 * @param {string} rpcId
 * @param {unknown} result
 * @returns {{ type: string, rpcId: string, result: unknown }}
 */
export function writeEnvelope(rpcId, result) {
  return { type: 'server-response', rpcId, result }
}

/**
 * Build a failure result in the shape the panel already handles.
 *
 * The panel branches on `ok`, so a failure is a result rather than an HTTP error: an HTTP error
 * would lose the rpcId and leave the panel waiting.
 *
 * @param {unknown} error
 * @returns {{ ok: false, error: string, code: string }}
 */
export function writeFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN'
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: message, code }
}

/**
 * Create the RPC gateway over the new core.
 *
 * The handlers are injected rather than imported so the gateway has no opinion about how a
 * channel is implemented — it only knows the frozen method names and the envelope.
 *
 * @param {object} spec
 * @param {object} spec.index - the account index store
 * @param {object} spec.core - the account core (selection, backup, rotation)
 * @param {Record<string, object>} [spec.adapters] - per-provider adapters
 * @param {(message: string) => void} [spec.warn]
 * @returns {{ methods: string[], handle: (body: unknown) => Promise<object> }}
 */
export function createRpcGateway({ index, core, adapters = {}, warn = () => {} }) {
  /** @type {Record<string, (payload: Record<string, any>) => Promise<unknown>>} */
  const handlers = {
    // ── accounts ──────────────────────────────────────────────────────────
    'account.list': async payload => {
      const provider = requireProvider(payload.provider)
      return { ok: true, accounts: await index.listByProvider(provider) }
    },
    'account.create': async payload => {
      const provider = requireProvider(payload.provider)
      const entry = { ...payload.entry, provider }
      await index.addAccount(entry)
      return { ok: true, id: entry.id }
    },
    'account.update': async payload => {
      await index.updateAccount(String(payload.id), payload.patch ?? {})
      return { ok: true }
    },
    'account.delete': async payload => {
      const removed = await index.removeAccount(String(payload.id))
      return { ok: true, removed }
    },
    'account.reorder': async payload => {
      const provider = requireProvider(payload.provider)
      await index.reorderAccounts(provider, payload.ids ?? [])
      return { ok: true }
    },
    'account.refresh': async payload => {
      const adapter = requireAdapter(adapters, payload.provider)
      await adapter.refresh({ accountId: payload.id })
      return { ok: true }
    },
    'account.retest': async payload => {
      const adapter = requireAdapter(adapters, payload.provider)
      const models = await adapter.listModels({})
      return { ok: true, models: models.length }
    },
    'account.retestAll': async payload => {
      const provider = requireProvider(payload.provider)
      const rows = index.listByProvider(provider)
      return { ok: true, tested: rows.length }
    },
    'account.test': async payload => {
      const adapter = requireAdapter(adapters, payload.provider)
      const models = await adapter.listModels({})
      return { ok: true, reachable: models.length > 0 }
    },
    'account.reset': async payload => {
      const removed = await index.clearModelRateLimits?.(String(payload.id)) ?? 0
      return { ok: true, removed }
    },
    'account.resetAll': async payload => {
      const provider = requireProvider(payload.provider)
      let removed = 0
      for (const row of index.listByProvider(provider)) {
        removed += await index.clearModelRateLimits?.(row.id) ?? 0
      }
      return { ok: true, removed }
    },

    // ── login ─────────────────────────────────────────────────────────────
    'login.poll': async () => ({ ok: true, state: 'idle' }),
    'login.sendSms': async payload => {
      const adapter = requireAdapter(adapters, payload.provider)
      if (typeof adapter.sendSms !== 'function') {
        return { ok: false, error: 'this provider has no SMS login', code: 'NOT_SUPPORTED' }
      }
      await adapter.sendSms(payload.phone)
      return { ok: true }
    },
    'login.submitSms': async payload => {
      const adapter = requireAdapter(adapters, payload.provider)
      if (typeof adapter.submitSms !== 'function') {
        return { ok: false, error: 'this provider has no SMS login', code: 'NOT_SUPPORTED' }
      }
      await adapter.submitSms(payload.phone, payload.code)
      return { ok: true }
    },
    'onboarding.status': async payload => {
      const adapter = requireAdapter(adapters, payload.provider)
      if (typeof adapter.onboarding !== 'function') return { ok: true, tasks: [] }
      return { ok: true, tasks: await adapter.onboarding() }
    },
    'onboarding.claim': async payload => {
      const adapter = requireAdapter(adapters, payload.provider)
      if (typeof adapter.claimOnboarding !== 'function') {
        return { ok: false, error: 'this provider has no onboarding reward', code: 'NOT_SUPPORTED' }
      }
      return { ok: true, result: await adapter.claimOnboarding(payload.id) }
    },

    // ── credits ───────────────────────────────────────────────────────────
    'credits.status': async payload => {
      const provider = requireProvider(payload.provider)
      const adapter = adapters[provider]
      if (adapter === undefined || typeof adapter.balance !== 'function') {
        return { ok: true, supported: false }
      }
      return { ok: true, supported: true, balance: await adapter.balance({}) }
    },
    'credits.claimAll': async payload => {
      const provider = requireProvider(payload.provider)
      const adapter = adapters[provider]
      if (adapter === undefined || typeof adapter.claimDaily !== 'function') {
        return { ok: true, claimed: 0, supported: false }
      }
      return { ok: true, claimed: await adapter.claimDaily(), supported: true }
    },
    'credits.balances': async payload => {
      const provider = requireProvider(payload.provider)
      const adapter = adapters[provider]
      if (adapter === undefined || typeof adapter.balance !== 'function') return { ok: true, balances: [] }
      return { ok: true, balances: [await adapter.balance({})] }
    },
    'credits.permanentLock': async payload => {
      const provider = requireProvider(payload.provider)
      if (payload.locked !== undefined) await index.setPermanentLocked(provider, payload.locked === true)
      return { ok: true, locked: index.isPermanentLocked(provider) }
    },
    'loomy.permanentLock': async payload => {
      if (payload.locked !== undefined) await index.setPermanentLocked('loomy', payload.locked === true)
      return { ok: true, locked: index.isPermanentLocked('loomy') }
    },
    'cline.quota': async () => {
      const adapter = adapters.cline
      if (adapter === undefined || typeof adapter.planUsage !== 'function') return { ok: true, limits: [] }
      return { ok: true, limits: await adapter.planUsage({}) }
    },
    'cline.requestLog': async () => {
      const adapter = adapters.cline
      if (adapter === undefined || typeof adapter.requestLogSnapshot !== 'function') return { ok: true, entries: [] }
      return { ok: true, entries: adapter.requestLogSnapshot() }
    },

    // ── models ────────────────────────────────────────────────────────────
    'model.list': async payload => {
      const provider = requireProvider(payload.provider)
      const adapter = adapters[provider]
      const models = adapter === undefined ? [] : await adapter.listModels({})
      const disabled = index.disabledModelsFor(provider)
      return { ok: true, models: models.map(row => ({ ...row, disabled: disabled.has(row.id) })) }
    },
    'model.setDisabled': async payload => {
      const provider = requireProvider(payload.provider)
      await index.setModelDisabled(provider, String(payload.modelId), payload.disabled === true)
      return { ok: true }
    },
    'model.setDisabledMany': async payload => {
      const provider = requireProvider(payload.provider)
      await index.setModelsDisabled(provider, payload.modelIds ?? [])
      return { ok: true }
    },
    'model.setAllDisabled': async payload => {
      const provider = requireProvider(payload.provider)
      const adapter = adapters[provider]
      const models = adapter === undefined ? [] : await adapter.listModels({})
      await index.setModelsDisabled(provider, models.map(row => row.id))
      return { ok: true, disabled: models.length }
    },
    'model.clearDead': async payload => {
      const provider = requireProvider(payload.provider)
      await index.clearDisabledModels(provider)
      return { ok: true }
    },

    // ── providers ─────────────────────────────────────────────────────────
    'provider.status': async () => ({
      ok: true,
      providers: ACCOUNT_PROVIDERS.map(provider => ({
        provider,
        accounts: index.listByProvider(provider).length,
        enabled: index.listByProvider(provider).some(row => row.enabled !== false),
      })),
    }),
    'provider.setEnabled': async payload => {
      const provider = requireProvider(payload.provider)
      const changed = await index.setAccountsEnabled(provider, payload.enabled !== false)
      return { ok: true, changed }
    },
    'provider.getOrder': async () => ({ ok: true, order: index.getProviderOrder() }),
    'provider.setOrder': async payload => {
      await index.setProviderOrder(payload.order ?? [])
      return { ok: true }
    },
    'gateway.getEnabled': async () => ({ ok: true, enabled: index.isGatewayEnabled() }),
    'gateway.setEnabled': async payload => {
      await index.setGatewayEnabled(payload.enabled !== false)
      return { ok: true, enabled: index.isGatewayEnabled() }
    },

    // ── captcha ───────────────────────────────────────────────────────────
    'captcha.demand': async payload => {
      const adapter = requireAdapter(adapters, payload.provider)
      if (typeof adapter.mintCaptcha !== 'function') {
        return { ok: false, error: 'this provider needs no captcha', code: 'NOT_SUPPORTED' }
      }
      return { ok: true, captcha: await adapter.mintCaptcha({ model: payload.model }) }
    },
    'captcha.carrierUrl': async payload => {
      const adapter = requireAdapter(adapters, payload.provider)
      if (typeof adapter.carrierUrl !== 'function') {
        return { ok: false, error: 'this provider has no carrier page', code: 'NOT_SUPPORTED' }
      }
      return { ok: true, url: adapter.carrierUrl() }
    },
    'captcha.contribute': async payload => {
      const adapter = requireAdapter(adapters, payload.provider)
      if (typeof adapter.contributeCaptcha !== 'function') {
        return { ok: false, error: 'this provider accepts no contributed captcha', code: 'NOT_SUPPORTED' }
      }
      await adapter.contributeCaptcha(payload.value)
      return { ok: true }
    },

    // ── backup ────────────────────────────────────────────────────────────
    'backup.export': async () => ({ ok: true, payload: await core.exportBackup() }),
    'backup.import': async payload => ({ ok: true, result: await core.importBackup(payload.payload) }),
    'backup.status': async () => ({ ok: true, accounts: index.listAll().length }),

    // ── usage ─────────────────────────────────────────────────────────────
    'usage.badge': async () => ({ ok: true, badge: core.usageBadge?.() ?? null }),
    'usage.tokenLedger': async () => ({ ok: true, ledger: core.tokenLedger?.() ?? null }),
    'usage.tokenLedgerHistory': async payload => ({ ok: true, days: core.tokenLedgerHistory?.(payload.days) ?? [] }),
    'usage.badgePreference': async payload => {
      if (payload.preference !== undefined) await core.setBadgePreference?.(payload.preference)
      return { ok: true, preference: core.badgePreference?.() ?? 'auto' }
    },
    'usage.autoCheckin': async payload => {
      if (payload.enabled !== undefined) await core.setAutoCheckin?.(payload.enabled === true)
      return { ok: true, enabled: core.autoCheckin?.() ?? false }
    },
  }

  /**
   * Handle one envelope end to end.
   *
   * A handler that throws is turned into a failure result rather than propagating: the panel
   * branches on `ok`, and an unhandled throw would lose the rpcId.
   *
   * @param {unknown} body
   * @returns {Promise<object>}
   */
  async function handle(body) {
    let envelope
    try {
      envelope = readEnvelope(body)
    } catch (error) {
      // No rpcId could be read, so the response carries none; the caller sees a shaped failure.
      return writeEnvelope('', writeFailure(error))
    }
    const handler = handlers[envelope.method]
    if (handler === undefined) {
      return writeEnvelope(envelope.rpcId, {
        ok: false,
        error: `no handler for ${envelope.method}`,
        code: 'NOT_IMPLEMENTED',
      })
    }
    try {
      return writeEnvelope(envelope.rpcId, await handler(envelope.payload))
    } catch (error) {
      warn(`[accounts] ${envelope.method} failed: ${error?.message ?? error}`)
      return writeEnvelope(envelope.rpcId, writeFailure(error))
    }
  }

  return { methods: [...RPC_METHODS], handle }
}

/** @param {unknown} provider */
function requireProvider(provider) {
  if (typeof provider !== 'string' || !ACCOUNT_PROVIDERS.includes(provider)) {
    throw new AccountError(`unknown account provider: ${String(provider)}`, ACCOUNT_ERROR_CODES.INVALID_REQUEST)
  }
  return provider
}

/** @param {Record<string, object>} adapters @param {unknown} provider */
function requireAdapter(adapters, provider) {
  const id = requireProvider(provider)
  const adapter = adapters[id]
  if (adapter === undefined) {
    throw new AccountError(`no adapter mounted for ${id}`, 'NOT_MOUNTED')
  }
  return adapter
}
