/**
 * Backup export and import for the account index.
 *
 * ## The shape, and what is deliberately absent
 *
 * A backup is a complete snapshot of the account index plus the credential values those
 * accounts reference, because a backup that restored accounts without credentials would
 * restore a list of rows that cannot send anything. It is an explicit user action, never
 * automatic.
 *
 * `gatewayEnabled` and `providerOrder` are **not** in the payload. They are per-install
 * preferences, and restoring them would let a backup silently switch a machine's gateway
 * on or reorder its provider list — changes the user did not ask for at import time.
 *
 * ## Validation before any write
 *
 * Import is destructive: it replaces the whole index and writes credentials. So the
 * entire payload is validated first and nothing is written until it passes. A malformed
 * file must fail with a clear message while the user's current state is still intact.
 *
 * ## Why the import writes credentials by ref, not by account row
 *
 * A backup can legitimately contain credential refs that no account row references —
 * each provider's default single-credential ref is the common case. Writing only what
 * accounts point at would lose those on restore.
 *
 * @module src/accounts/core/backup
 */

import { normalizePermanentLocks, normalizeProviderOrder } from './index-store.js'

/** Payload format marker. */
export const BACKUP_FORMAT = 'channel-pack/backup'

/** Payload version. */
export const BACKUP_VERSION = 1

/** Raised when a payload is not a backup this build can import. */
export class BackupFormatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BackupFormatError'
  }
}

/**
 * Validate a payload, throwing {@link BackupFormatError} with a specific reason.
 *
 * The `format` check accepts any `<namespace>/backup` rather than only this one. That is
 * intentional tolerance: the field's purpose is to catch "you picked the wrong file",
 * and a sibling namespace's backup is caught by the version check that follows. The
 * version check is exact — a future version must not be half-imported.
 *
 * @param {unknown} value
 * @returns {asserts value is Record<string, unknown>}
 */
export function assertBackupPayload(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BackupFormatError('backup content is not an object')
  }
  if (typeof value.format !== 'string' || !/^[a-z][a-z0-9-]*\/backup$/i.test(value.format)) {
    throw new BackupFormatError(`not a ${BACKUP_FORMAT} file (format=${String(value.format)})`)
  }
  if (value.version !== BACKUP_VERSION) {
    throw new BackupFormatError(`unsupported backup version: ${String(value.version)} (this build reads v${BACKUP_VERSION})`)
  }
  if (typeof value.exportedAt !== 'string') {
    throw new BackupFormatError('backup is missing exportedAt')
  }
  if (typeof value.credentials !== 'object' || value.credentials === null || Array.isArray(value.credentials)) {
    throw new BackupFormatError('backup credentials field is invalid')
  }
  if (!Array.isArray(value.accounts)) {
    throw new BackupFormatError('backup accounts field is invalid')
  }
  if (typeof value.disabledModels !== 'object' || value.disabledModels === null || Array.isArray(value.disabledModels)) {
    throw new BackupFormatError('backup disabledModels field is invalid')
  }
  // Optional, because older exports predate it. Arrays are rejected explicitly:
  // `typeof [] === 'object'`, so an object-only check would accept a wrongly shaped lock table.
  if (value.permanentLocks !== undefined
    && (typeof value.permanentLocks !== 'object' || Array.isArray(value.permanentLocks))) {
    throw new BackupFormatError('backup permanentLocks field is invalid')
  }
}

/**
 * Export the index and the credentials its accounts reference.
 *
 * A single unreadable credential is a warning, not a failure. Migration between builds
 * is exactly when a backup is most needed, and letting one broken row block the whole
 * export would leave the user with nothing.
 *
 * @param {object} spec
 * @param {{ snapshot: () => any, permanentLocksSnapshot: () => Record<string, true> }} spec.index
 * @param {{ resolve: (ref: string) => Promise<{ value: string } | undefined> }} spec.credentials
 * @param {(ref: string) => string} spec.credentialRef - wraps a raw ref name for the store
 * @param {() => number} [spec.now]
 * @returns {Promise<{ payload: Record<string, unknown>, warnings: string[] }>}
 */
export async function exportBackup({ index, credentials, credentialRef, now = () => Date.now() }) {
  const state = index.snapshot()
  /** @type {Record<string, string>} */
  const exported = {}
  const warnings = []
  for (const entry of state.accounts) {
    try {
      const resolved = await credentials.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined || resolved === null) warnings.push(`${entry.id}: credential not configured`)
      else exported[entry.credentialRef] = resolved.value
    } catch (error) {
      warnings.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const locks = normalizePermanentLocks(index.permanentLocksSnapshot())
  return {
    payload: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date(now()).toISOString(),
      credentials: exported,
      accounts: state.accounts,
      disabledModels: state.disabledModels,
      // The authoritative table and the legacy mirror are written from the same
      // snapshot: an older build reads only the mirror, and a mirror that disagreed
      // with the table would show the user a lock state that is not real.
      permanentLocks: locks,
      loomyPermanentLocked: locks.loomy === true,
    },
    warnings,
  }
}

/**
 * Derive the lock table from a payload, tolerating backups that only carry the legacy
 * field.
 *
 * The three cases must stay distinct, because conflating them makes the user believe
 * credits are locked when they are not:
 * - a table is present → use it, and merge the legacy field only if the table omits it
 *   (there was a released build that wrote the field without the table);
 * - no table but a boolean legacy field → that field is the whole truth, including
 *   `false`, which means "explicitly unlocked" and must not be treated as unknown;
 * - neither → unknown, so the caller keeps the current value.
 *
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, true> | undefined}
 */
export function locksFromPayload(payload) {
  if (payload.permanentLocks !== undefined) {
    const locks = normalizePermanentLocks(payload.permanentLocks)
    if (locks.loomy === undefined && payload.loomyPermanentLocked === true) locks.loomy = true
    return locks
  }
  if (typeof payload.loomyPermanentLocked === 'boolean') {
    return payload.loomyPermanentLocked ? { loomy: true } : {}
  }
  return undefined
}

/**
 * Import a backup: validate, write credentials, then replace the index.
 *
 * Credentials first, index second. If the index were replaced first and a credential
 * write then failed, the index would reference credentials that are not there — the
 * user would see accounts that exist but cannot send, which is worse than the reverse
 * (credentials present, index not yet updated).
 *
 * A credential ref that the store rejects is skipped and reported, never fatal: the
 * store validates ref names, and one bad name in a hand-edited backup must not abort the
 * restore of everything else.
 *
 * @param {object} spec
 * @param {{ set: (ref: string, value: string) => Promise<void> }} spec.credentials
 * @param {{ replaceAll: (accounts: unknown, disabledModels: unknown, locks: unknown) => Promise<void> }} spec.index
 * @param {(ref: string) => string} spec.credentialRef
 * @param {unknown} spec.payload
 * @param {() => number} [spec.now]
 * @returns {Promise<{ credentialsImported: number, accountsImported: number, skipped: string[], expiredAccounts: number, missingCredentials: number }>}
 */
export async function importBackup({ credentials, index, credentialRef, payload, now = () => Date.now() }) {
  assertBackupPayload(payload)
  const skipped = []
  let credentialsImported = 0
  for (const [refName, value] of Object.entries(payload.credentials)) {
    if (typeof value !== 'string') {
      skipped.push(refName)
      continue
    }
    try {
      await credentials.set(credentialRef(refName), value)
      credentialsImported += 1
    } catch {
      skipped.push(refName)
    }
  }
  await index.replaceAll(payload.accounts, payload.disabledModels, locksFromPayload(payload))

  const at = now()
  const expiredAccounts = payload.accounts.filter(entry => typeof entry.expiresAt === 'number'
    && Number.isFinite(entry.expiresAt)
    && entry.expiresAt <= at).length
  // A ref that was present but skipped counts as missing: it genuinely is not in the store.
  const skippedSet = new Set(skipped)
  const missingCredentials = payload.accounts.filter(entry => !Object.prototype.hasOwnProperty.call(payload.credentials, entry.credentialRef)
    || skippedSet.has(entry.credentialRef)).length

  return {
    credentialsImported,
    accountsImported: payload.accounts.length,
    skipped,
    expiredAccounts,
    missingCredentials,
  }
}

export { normalizeProviderOrder }
