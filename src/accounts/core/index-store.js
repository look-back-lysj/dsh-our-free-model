/**
 * Account index: the persisted record of which accounts exist, which are enabled,
 * and what each has spent.
 *
 * ## The design decision this module encodes
 *
 * The index is **the authority in memory, and the whole document on disk**. Every
 * mutation reads the in-memory list, applies the change, then rewrites the entire
 * document. That is not laziness: the alternative (per-field patches) requires the
 * storage layer to understand account semantics, and it does not survive the case
 * this product actually hits — several providers' accounts interleaved in one array,
 * edited from several panels at once.
 *
 * The price of whole-document writes is that a stale snapshot silently resurrects
 * deleted rows, so two rules are structural rather than advisory:
 *
 * 1. **Only one write is in flight.** Writes queue on a promise chain and each one
 *    takes its snapshot *when its turn comes*, not when it was requested. Two
 *    concurrent writers therefore cannot land out of order.
 * 2. **A mutation that awaits must re-read.** Removing an account awaits the
 *    credential store; during that await another caller can append. Re-filtering the
 *    pre-await snapshot would drop the newcomer, so the filter happens after.
 *
 * ## What is deliberately NOT here
 *
 * Credential *values*. The index stores opaque `credentialRef` names; the bytes live
 * in the host's credential service. Backup export is the one explicit operation that
 * crosses that line, and it does so through the caller's credential handle.
 *
 * @module src/accounts/core/index-store
 */

import { ACCOUNT_ERROR_CODES, AccountError } from './errors.js'

/** Fields every account row must carry to be usable at all. */
const REQUIRED_STRING_FIELDS = Object.freeze(['id', 'provider', 'credentialRef'])

/**
 * A provider's credential-ref prefix. The ref names are
 * `{PREFIX}_ACCOUNT_{HEX}` by long-standing convention, so the provider can be
 * recovered from the ref alone — which is what makes index recovery possible when
 * the state document is lost but the credential file survives.
 *
 * Order matters and is enforced below: `QODERCN` must be tried before `QODER`.
 * Relying on regex backtracking to sort that out works today but makes the result
 * depend on engine behaviour rather than on a rule, and the failure mode is silent
 * misattribution — a CN account appearing on the international Qoder panel.
 */
export const PROVIDER_REF_PREFIXES = Object.freeze([
  ['LOBSTERAI', 'lobsterai'],
  ['QODERCN', 'qodercn'],
  ['QODER', 'qoder'],
  ['TRAE', 'trae'],
  ['CLINE', 'cline'],
  ['LOOMY', 'loomy'],
  ['RACCOON', 'raccoon'],
  ['MINIMAX', 'minimax'],
  ['ZCODE', 'zcode'],
  ['OPENCODE', 'opencode'],
  ['GEMINI', 'gemini'],
])

/** The ten providers the account index is contracted to serve. */
export const ACCOUNT_PROVIDERS = Object.freeze(
  PROVIDER_REF_PREFIXES.map(([, provider]) => provider).filter(provider => provider !== 'opencode'),
)

const PREFIX_BY_PROVIDER = new Map(PROVIDER_REF_PREFIXES.map(([prefix, provider]) => [provider, prefix]))
const PROVIDER_BY_PREFIX = new Map(PROVIDER_REF_PREFIXES.map(([prefix, provider]) => [prefix, provider]))

/**
 * The ref matcher, with prefixes ordered longest-first so a longer prefix always
 * wins regardless of how the engine would have backtracked.
 */
export const ACCOUNT_REF_PATTERN = new RegExp(
  `^(${[...PROVIDER_BY_PREFIX.keys()].sort((a, b) => b.length - a.length).join('|')})_ACCOUNT_([0-9A-Fa-f]{6,})$`,
)

/** Is this a provider the index knows how to store? */
export function isKnownProvider(provider) {
  return typeof provider === 'string' && PREFIX_BY_PROVIDER.has(provider)
}

/**
 * Build the canonical credential-ref name for a new account.
 *
 * @param {string} provider
 * @param {string} suffix - 6+ hex characters
 * @returns {string}
 */
export function accountCredentialRef(provider, suffix) {
  const prefix = PREFIX_BY_PROVIDER.get(provider)
  if (prefix === undefined) throw new AccountError(`unknown account provider: ${provider}`, 'UNKNOWN_PROVIDER')
  return `${prefix}_ACCOUNT_${suffix.toUpperCase()}`
}

/**
 * Recover an account row from a credential-ref name, or null when the ref is not an
 * account ref this build knows.
 *
 * Nickname, ordering and rate-limit stamps are unrecoverable from a ref — the caller
 * must treat a recovered row as "present but unconfigured" rather than pretending it
 * is identical to a row that was written normally.
 *
 * @param {string} ref
 * @param {number} [now]
 * @returns {null | { id: string, provider: string, nickname: string, enabled: boolean, credentialRef: string, createdAt: number, refreshable: boolean }}
 */
export function accountFromCredentialRef(ref, now = Date.now()) {
  const match = ACCOUNT_REF_PATTERN.exec(String(ref))
  if (match === null) return null
  const provider = PROVIDER_BY_PREFIX.get(match[1])
  if (provider === undefined) return null
  const suffix = match[2].toLowerCase()
  const id = `${provider}-${suffix}`
  return {
    id,
    provider,
    nickname: id,
    enabled: true,
    credentialRef: ref,
    createdAt: now,
    refreshable: true,
  }
}

/**
 * Normalise a stored account row.
 *
 * Only rows carrying the three required strings survive: without any one of them the
 * credential cannot be resolved, so keeping the row guarantees a failure later with a
 * worse message. Defaults fill in the fields older documents omitted, and they are
 * chosen so that a row written by an older build behaves as it did before the field
 * existed — `enabled` and `refreshable` default true, `nickname` falls back to the id.
 *
 * @param {unknown} raw
 * @param {number} [now]
 * @returns {null | Record<string, unknown>}
 */
export function normalizeAccountRow(raw, now = Date.now()) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = raw[field]
    if (typeof value !== 'string' || value.length === 0) return null
  }
  const row = { ...raw }
  row.enabled = raw.enabled !== false
  row.refreshable = raw.refreshable !== false
  row.nickname = typeof raw.nickname === 'string' ? raw.nickname : raw.id
  row.createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : now
  if (raw.modelRateLimits !== undefined) {
    const limits = normalizeRateLimits(raw.modelRateLimits)
    if (limits === undefined) delete row.modelRateLimits
    else row.modelRateLimits = limits
  }
  return row
}

/**
 * Normalise a `modelId -> resetAtMs` map, dropping anything unusable.
 *
 * A non-finite reset time must not be stored: every later comparison against it is
 * false, which reads as "limited forever", and the sweep that clears expired stamps
 * can never remove it. Dropping the key at the boundary is the only place that can be
 * fixed cheaply.
 *
 * @param {unknown} raw
 * @returns {undefined | Record<string, number>}
 */
export function normalizeRateLimits(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  /** @type {Record<string, number>} */
  const limits = {}
  for (const [modelId, value] of Object.entries(raw)) {
    if (modelId.length === 0) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    limits[modelId] = value
  }
  return Object.keys(limits).length === 0 ? undefined : limits
}

/**
 * Normalise the model blacklist.
 *
 * Blacklist semantics: a model is hidden only when its key is present *and* true.
 * Everything else — absent, false, a string, a nested array — means "shown". Keeping
 * only explicit `true` means the document does not accumulate noise as the user
 * toggles models, and an absent key can never be mistaken for a disable.
 *
 * @param {unknown} raw
 * @returns {Record<string, Record<string, true>>}
 */
export function normalizeDisabledModels(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  /** @type {Record<string, Record<string, true>>} */
  const out = {}
  for (const [provider, perProvider] of Object.entries(raw)) {
    if (typeof perProvider !== 'object' || perProvider === null || Array.isArray(perProvider)) continue
    /** @type {Record<string, true>} */
    const kept = {}
    for (const [modelId, flag] of Object.entries(perProvider)) {
      if (flag === true && modelId.length > 0) kept[modelId] = true
    }
    if (Object.keys(kept).length > 0) out[provider] = kept
  }
  return out
}

/**
 * Normalise the "permanent credit locked" map.
 *
 * Same shape rule as the blacklist and for the same reason, but the consequence of
 * getting it wrong is asymmetric: treating a dirty value as locked merely hides
 * accounts, while treating a genuine lock as absent spends credits that do not
 * refresh. So only an explicit `true` locks.
 *
 * @param {unknown} raw
 * @returns {Record<string, true>}
 */
export function normalizePermanentLocks(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  /** @type {Record<string, true>} */
  const out = {}
  for (const [provider, value] of Object.entries(raw)) {
    if (value === true && provider.length > 0) out[provider] = true
  }
  return out
}

/**
 * Normalise the provider display order.
 *
 * Deliberately does *not* validate provider ids against the current build: the set of
 * providers changes between versions, and filtering here would make an order written
 * by a newer build unrecoverable by an older one. Rendering tolerates unknown and
 * missing ids, so dirty entries are harmless.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeProviderOrder(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Normalise the gateway switch.
 *
 * Only an explicit `false` turns the gateway off. Everything else means on, because
 * a missing key, a hand-edited document, or a rewrite by an older build must all fall
 * back to the behaviour the user had before upgrading. The reverse rule would turn any
 * single read failure into "the gateway was silently disabled", which the user never
 * asked for and cannot see.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function normalizeGatewayEnabled(raw) {
  return raw !== false
}

/**
 * An in-memory-first account index with whole-document persistence.
 *
 * The storage port is injected as three functions rather than a class, because that is
 * the entire surface needed and it keeps the module testable without a fake hierarchy.
 */
export class AccountIndexStore {
  /**
   * @param {object} options
   * @param {(state: object) => unknown} options.load - synchronous read; `undefined` means "no document"
   * @param {(state: object) => Promise<void>} options.save - whole-document write
   * @param {(message: string) => void} [options.warn]
   * @param {(message: string) => void} [options.info]
   * @param {() => number} [options.now]
   * @param {boolean} [options.persistent] - false for a memory-only backend
   */
  constructor({ load, save, warn = () => {}, info = () => {}, now = () => Date.now(), persistent = true }) {
    this.loadDocument = load
    this.saveDocument = save
    this.warn = warn
    this.info = info
    this.now = now
    this.persistent = persistent

    /** @type {Array<Record<string, any>>} */
    this.accounts = []
    /** @type {Record<string, Record<string, true>>} */
    this.disabledModels = {}
    /** @type {Record<string, true>} */
    this.permanentLocks = {}
    this.gatewayEnabled = true
    /** @type {string[]} */
    this.providerOrder = []
    this.loaded = false
    /** Serialises document writes; each writer snapshots when its turn arrives. */
    this.writeChain = Promise.resolve()
  }

  /** Load once, then trust the in-memory copy as the read source. */
  ensureLoaded() {
    if (this.loaded) return
    this.loaded = true
    let state
    try {
      state = this.loadDocument()
    } catch (error) {
      this.warn(`[accounts] failed to load the state document, starting empty: ${String(error)}`)
      return
    }
    if (state === undefined || state === null) return
    this.accounts = Array.isArray(state.accounts)
      ? state.accounts.map(row => normalizeAccountRow(row, this.now())).filter(row => row !== null)
      : []
    this.disabledModels = normalizeDisabledModels(state.disabledModels)
    // The lock table is authoritative, but documents written before it existed carry
    // only the legacy mirror. Migrating it here is what stops a long-standing lock from
    // silently vanishing on upgrade — the consequence of which is spending credits the
    // user asked us to protect, and there is no undo.
    //
    // The migration triggers on the *table* being absent, not on a key missing from it:
    // an absent key in a present table means "the user unlocked this", so consulting the
    // stale mirror then would produce a switch that cannot be turned off.
    if (state.permanentLocks === undefined) {
      this.permanentLocks = state.loomyPermanentLocked === true ? { loomy: true } : {}
    } else {
      this.permanentLocks = normalizePermanentLocks(state.permanentLocks)
    }
    this.gatewayEnabled = normalizeGatewayEnabled(state.gatewayEnabled)
    this.providerOrder = normalizeProviderOrder(state.providerOrder)
  }

  /**
   * Queue a whole-document write.
   *
   * The snapshot is taken inside the queued callback so that everything already
   * queued lands first. Taking it at call time would let two writers persist in
   * reverse order, and the later-finishing one would carry the older document —
   * the exact mechanism that resurrects deleted accounts.
   *
   * A failed write still rejects to its caller (a login that cannot persist must
   * report failure) but the chain itself is kept alive, so one bad write does not
   * wedge every later one.
   */
  queueSave() {
    if (!this.persistent) return Promise.resolve()
    const next = this.writeChain.then(async () => {
      await this.saveDocument({
        accounts: this.accounts,
        disabledModels: this.disabledModels,
        permanentLocks: this.permanentLocks,
        loomyPermanentLocked: this.permanentLocks.loomy === true,
        gatewayEnabled: this.gatewayEnabled,
        providerOrder: this.providerOrder,
      })
    })
    this.writeChain = next.catch(() => {})
    return next
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** @returns {Array<Record<string, any>>} */
  listAll() {
    this.ensureLoaded()
    return this.accounts
  }

  /** @returns {Array<Record<string, any>>} */
  listByProvider(provider) {
    return this.listAll().filter(entry => entry.provider === provider)
  }

  /** @param {string} id */
  findById(id) {
    return this.listAll().find(entry => entry.id === id)
  }

  /** The disabled model ids for a provider, as a set. */
  disabledModelsFor(provider) {
    this.ensureLoaded()
    const perProvider = this.disabledModels[provider]
    if (perProvider === undefined) return EMPTY_SET
    return new Set(Object.keys(perProvider))
  }

  /** The full blacklist record for a provider, including explicit falses if present. */
  listDisabledModels(provider) {
    this.ensureLoaded()
    return { ...(this.disabledModels[provider] ?? {}) }
  }

  /** @param {string} provider */
  isPermanentLocked(provider) {
    this.ensureLoaded()
    return this.permanentLocks[provider] === true
  }

  /** @returns {string[]} */
  listPermanentLocked() {
    this.ensureLoaded()
    return Object.keys(this.permanentLocks)
  }

  /** @returns {Record<string, true>} */
  permanentLocksSnapshot() {
    this.ensureLoaded()
    return { ...this.permanentLocks }
  }

  /** @returns {boolean} */
  isGatewayEnabled() {
    this.ensureLoaded()
    return this.gatewayEnabled
  }

  /** @returns {string[]} */
  getProviderOrder() {
    this.ensureLoaded()
    return this.providerOrder
  }

  /**
   * A detached copy of the persisted state, for backup export.
   *
   * Deep-copies the blacklist because a shallow copy would share the inner
   * provider tables, so a caller editing the result would edit live state.
   */
  snapshot() {
    this.ensureLoaded()
    /** @type {Record<string, Record<string, true>>} */
    const disabledModels = {}
    for (const [provider, models] of Object.entries(this.disabledModels)) {
      disabledModels[provider] = { ...models }
    }
    return {
      accounts: this.accounts.map(entry => ({ ...entry })),
      disabledModels,
      permanentLocks: { ...this.permanentLocks },
      loomyPermanentLocked: this.permanentLocks.loomy === true,
      gatewayEnabled: this.gatewayEnabled,
      providerOrder: [...this.providerOrder],
    }
  }

  // ── account mutations ────────────────────────────────────────────────────

  /** @param {Record<string, any>} entry */
  async addAccount(entry) {
    const row = normalizeAccountRow(entry, this.now())
    if (row === null) throw new AccountError('account row is missing id, provider or credentialRef', 'INVALID_ACCOUNT')
    this.accounts = [...this.listAll(), row]
    this.loaded = true
    await this.queueSave()
  }

  /**
   * @param {string} id
   * @param {Partial<Record<'nickname' | 'enabled' | 'expiresAt' | 'refreshable', unknown>>} patch
   */
  async updateAccount(id, patch) {
    const accounts = this.listAll()
    const index = accounts.findIndex(entry => entry.id === id)
    if (index === -1) throw new AccountError(`account ${id} not found`, 'ACCOUNT_NOT_FOUND')
    const next = [...accounts]
    next[index] = { ...next[index], ...patch }
    this.accounts = next
    this.loaded = true
    await this.queueSave()
  }

  /**
   * Remove one account.
   *
   * `beforeWrite` runs *before* the list is re-read, so an async side effect (clearing
   * the credential) cannot interleave with a concurrent append and cause it to be
   * dropped. Re-reading after that await is what makes the removal safe under
   * concurrency; without it, a login that finishes during the await would vanish.
   *
   * @param {string} id
   * @param {() => Promise<void>} [beforeWrite]
   * @returns {Promise<boolean>} whether a row was removed
   */
  async removeAccount(id, beforeWrite) {
    const entry = this.findById(id)
    if (entry === undefined) return false
    if (beforeWrite !== undefined) {
      try {
        await beforeWrite()
      } catch {
        // The credential may already be gone; the index row still has to go.
      }
    }
    this.accounts = this.listAll().filter(candidate => candidate.id !== id)
    this.loaded = true
    await this.queueSave()
    return true
  }

  /**
   * Reorder one provider's accounts in place.
   *
   * The array order *is* the selection priority, so this is a routing change, not a
   * display preference. Only the slots that provider already occupies are refilled,
   * leaving other providers' rows where they were.
   *
   * `orderedIds` must be a permutation of that provider's current ids. A partial list
   * is rejected rather than tolerated: silently appending the missing rows to the end
   * would look to the user like "the order changed by itself".
   *
   * @param {string} provider
   * @param {readonly string[]} orderedIds
   */
  async reorderAccounts(provider, orderedIds) {
    const accounts = this.listAll()
    const slots = []
    const currentIds = []
    accounts.forEach((entry, index) => {
      if (entry.provider !== provider) return
      slots.push(index)
      currentIds.push(entry.id)
    })
    const expected = new Set(currentIds)
    const received = new Set(orderedIds)
    const isPermutation = orderedIds.length === currentIds.length
      && received.size === orderedIds.length
      && orderedIds.every(id => expected.has(id))
    if (!isPermutation) {
      throw new AccountError(
        `account list changed, refresh and retry (expected ${currentIds.length} ids, received ${orderedIds.length})`,
        'ACCOUNT_LIST_STALE',
      )
    }
    const next = [...accounts]
    const byId = new Map(accounts.map(entry => [entry.id, entry]))
    slots.forEach((accountIndex, position) => {
      next[accountIndex] = byId.get(orderedIds[position])
    })
    this.accounts = next
    this.loaded = true
    await this.queueSave()
  }

  /**
   * Enable or disable every account of one provider, returning how many actually
   * changed.
   *
   * Returns the changed count rather than the matched count so a caller's message
   * ("disabled 2 accounts") never claims a change that did not happen.
   *
   * @param {string} provider
   * @param {boolean} enabled
   * @returns {Promise<number>}
   */
  async setAccountsEnabled(provider, enabled) {
    this.ensureLoaded()
    let changed = 0
    const next = this.accounts.map(entry => {
      if (entry.provider !== provider) return entry
      const current = entry.enabled !== false
      if (current === enabled) return entry
      changed += 1
      return { ...entry, enabled }
    })
    if (changed === 0) return 0
    this.accounts = next
    await this.queueSave()
    return changed
  }

  // ── model blacklist mutations ────────────────────────────────────────────

  /**
   * Disable or re-enable one model.
   *
   * Re-enabling deletes the key instead of writing `false`, so the document only ever
   * records genuine disables and does not grow with every toggle.
   */
  async setModelDisabled(provider, modelId, disabled) {
    const next = { ...this.disabledModels }
    const perProvider = { ...(next[provider] ?? {}) }
    if (disabled) perProvider[modelId] = true
    else delete perProvider[modelId]
    if (Object.keys(perProvider).length === 0) delete next[provider]
    else next[provider] = perProvider
    await this.writeDisabledModels(next)
  }

  /**
   * Disable a batch of models in one write.
   *
   * One write rather than N matters twice over: N writes mean N full-document
   * rewrites and N catalog broadcasts, and a failure halfway leaves a half-disabled
   * list. Existing disables are merged, not replaced.
   */
  async setModelsDisabled(provider, modelIds) {
    if (modelIds.length === 0) return
    this.ensureLoaded()
    const next = { ...this.disabledModels }
    const perProvider = { ...(next[provider] ?? {}) }
    for (const id of modelIds) perProvider[id] = true
    next[provider] = perProvider
    await this.writeDisabledModels(next)
  }

  /**
   * Re-enable a batch of models, touching only the ids given.
   *
   * Distinct from {@link clearDisabledModels} on purpose: a grouped "enable this
   * group" must not open models the user deliberately disabled in another group.
   * No-op when nothing would change, so a redundant toggle costs no write.
   */
  async clearModelsDisabled(provider, modelIds) {
    if (modelIds.length === 0) return
    this.ensureLoaded()
    const perProvider = this.disabledModels[provider]
    if (perProvider === undefined) return
    const nextPerProvider = { ...perProvider }
    let changed = false
    for (const id of modelIds) {
      if (nextPerProvider[id] === true) {
        delete nextPerProvider[id]
        changed = true
      }
    }
    if (!changed) return
    const next = { ...this.disabledModels }
    if (Object.keys(nextPerProvider).length === 0) delete next[provider]
    else next[provider] = nextPerProvider
    await this.writeDisabledModels(next)
  }

  /**
   * Clear a provider's entire blacklist.
   *
   * Deliberately ignores the live model catalog and drops every key: a model that was
   * disabled and has since been removed upstream would otherwise be unclearable, and
   * a lingering key could later hide a different model that reuses the id.
   */
  async clearDisabledModels(provider) {
    this.ensureLoaded()
    if (this.disabledModels[provider] === undefined) return
    const next = { ...this.disabledModels }
    delete next[provider]
    await this.writeDisabledModels(next)
  }

  /** @param {Record<string, Record<string, true>>} disabledModels */
  async writeDisabledModels(disabledModels) {
    this.disabledModels = disabledModels
    this.loaded = true
    if (!this.persistent) {
      this.warn('[accounts] no persistent backend; model blacklist changes are session-only')
      return
    }
    await this.queueSave()
  }

  // ── switches ─────────────────────────────────────────────────────────────

  /** @param {boolean} enabled */
  async setGatewayEnabled(enabled) {
    this.ensureLoaded()
    if (this.gatewayEnabled === enabled) return
    this.gatewayEnabled = enabled
    if (!this.persistent) {
      this.warn('[accounts] no persistent backend; the gateway switch is session-only')
      return
    }
    await this.queueSave()
  }

  /** @param {string[]} order */
  async setProviderOrder(order) {
    this.ensureLoaded()
    const next = normalizeProviderOrder(Array.isArray(order) ? order : [])
    const unchanged = this.providerOrder.length === next.length
      && this.providerOrder.every((id, index) => id === next[index])
    if (unchanged) return
    this.providerOrder = next
    if (!this.persistent) {
      this.warn('[accounts] no persistent backend; the provider order is session-only')
      return
    }
    await this.queueSave()
  }

  /**
   * @param {string} provider
   * @param {boolean} locked
   */
  async setPermanentLocked(provider, locked) {
    if (provider.length === 0) return
    this.ensureLoaded()
    const next = { ...this.permanentLocks }
    if (locked) next[provider] = true
    else delete next[provider]
    this.permanentLocks = next
    if (!this.persistent) {
      this.warn('[accounts] no persistent backend; the permanent-credit lock is session-only')
      return
    }
    await this.queueSave()
  }

  // ── bulk replace (backup import) ─────────────────────────────────────────

  /**
   * Replace the whole account list and blacklist at once.
   *
   * The input is user-supplied and may have been hand-edited, so it is normalised
   * first: unusable rows are dropped rather than admitted and left to fail later at
   * selection time, where the message would be much worse.
   *
   * An absent `permanentLocks` keeps the current value instead of clearing it —
   * importing an older backup that predates the field must not silently unlock credits.
   *
   * @param {unknown} accounts
   * @param {unknown} disabledModels
   * @param {unknown} [permanentLocks]
   */
  async replaceAll(accounts, disabledModels, permanentLocks) {
    this.accounts = Array.isArray(accounts)
      ? accounts.map(row => normalizeAccountRow(row, this.now())).filter(row => row !== null)
      : []
    this.disabledModels = normalizeDisabledModels(disabledModels)
    if (permanentLocks !== undefined) this.permanentLocks = normalizePermanentLocks(permanentLocks)
    this.loaded = true
    await this.queueSave()
  }
}

const EMPTY_SET = new Set()

/**
 * Whether a provider should appear in the model catalog at all.
 *
 * The point is to keep the model picker from listing providers the user has not
 * logged into. The catalog builder already drops empty groups, so returning "no
 * models" is the supported way to hide one — and it is advisory only: hidden models
 * remain routable, so this can never deny a request.
 *
 * Fails open. A credential-store hiccup must not make every model disappear with no
 * explanation, so any error answers "visible".
 *
 * @param {unknown} index - the store, or undefined in tests that do not need it
 * @param {string} provider
 * @param {(credentialRef: string) => Promise<unknown>} resolveCredential
 * @returns {Promise<boolean>}
 */
export async function isProviderVisible(index, provider, resolveCredential) {
  if (index === undefined || index === null) return true
  if (typeof index.listByProvider !== 'function') return true
  try {
    for (const entry of index.listByProvider(provider)) {
      const credential = await resolveCredential(entry.credentialRef)
      if (credential !== undefined && credential !== null) return true
    }
    return false
  } catch {
    return true
  }
}

export { ACCOUNT_ERROR_CODES }
