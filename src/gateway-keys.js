/**
 * Domain rules for additional, scoped API credentials accepted by the local
 * gateway. This module is deliberately storage- and HTTP-agnostic: callers own
 * persistence and request handling, while this seam owns credential shape,
 * validation, scope checks, and secret-safe projections.
 *
 * Persisted records contain a digest of a freshly generated high-entropy key,
 * never its plaintext. The plaintext is returned once by createGatewayKey().
 */
import crypto from 'node:crypto'

export const GATEWAY_KEY_SCOPES = Object.freeze([
  'models:read',
  'chat:write',
  'responses:write',
  'messages:write',
])

export const MAX_GATEWAY_KEYS = 64
export const MAX_GATEWAY_KEY_MODELS = 200
export const MAX_GATEWAY_KEY_LABEL_LENGTH = 80

const SCOPE_SET = new Set(GATEWAY_KEY_SCOPES)
const SCOPE_INDEX = new Map(GATEWAY_KEY_SCOPES.map((scope, index) => [scope, index]))
const TOKEN_PREFIX = 'ofm_sk_'
const TOKEN_RANDOM_LENGTH = 43 // 32 random bytes encoded as unpadded base64url.
const PREFIX_LENGTH = TOKEN_PREFIX.length + 8
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST_RE = /^[0-9a-f]{64}$/
const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/
const ownKeys = value => Object.keys(value).sort()
const sameKeys = (value, expected) => {
  const actual = ownKeys(value)
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function fail(message, code = 'INVALID_GATEWAY_KEY') {
  return Object.assign(new TypeError(message), { code })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeLabel(value) {
  if (typeof value !== 'string') throw fail('label must be a string')
  const label = value.trim()
  if (label.length === 0 || label.length > MAX_GATEWAY_KEY_LABEL_LENGTH || /[\x00-\x1f\x7f]/.test(label)) {
    throw fail(`label must contain 1 to ${MAX_GATEWAY_KEY_LABEL_LENGTH} printable characters`)
  }
  return label
}

function normalizeScopes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > GATEWAY_KEY_SCOPES.length) {
    throw fail('scopes must be a non-empty array of supported scopes')
  }
  const seen = new Set()
  for (const scope of value) {
    if (typeof scope !== 'string' || !SCOPE_SET.has(scope) || seen.has(scope)) {
      throw fail('scopes contains an unsupported or duplicate value')
    }
    seen.add(scope)
  }
  return [...seen].sort((left, right) => SCOPE_INDEX.get(left) - SCOPE_INDEX.get(right))
}

function normalizeModels(value) {
  if (!Array.isArray(value) || value.length > MAX_GATEWAY_KEY_MODELS) {
    throw fail(`models must be an array with at most ${MAX_GATEWAY_KEY_MODELS} entries`)
  }
  const seen = new Set()
  for (const model of value) {
    if (typeof model !== 'string' || model.length === 0 || model.length > 240 ||
        model.trim() !== model || !MODEL_RE.test(model) || seen.has(model)) {
      throw fail('models contains an invalid or duplicate model id')
    }
    seen.add(model)
  }
  return [...seen]
}

function normalizeCreatedAt(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw fail('createdAt must be a non-negative safe integer')
  return value
}

/** Validate and clone the complete persisted collection; corruption fails closed. */
function normalizeRecords(records) {
  if (!Array.isArray(records) || records.length > MAX_GATEWAY_KEYS) {
    throw fail(`records must be an array with at most ${MAX_GATEWAY_KEYS} entries`, 'INVALID_GATEWAY_KEY_STORE')
  }
  const ids = new Set()
  const prefixes = new Set()
  const digests = new Set()
  return records.map(record => {
    if (!isRecord(record)) throw fail('record is not an object', 'INVALID_GATEWAY_KEY_STORE')
    const allowedKeys = ['id', 'digest', 'prefix', 'label', 'createdAt', 'scopes', 'models']
    if (!sameKeys(record, record.models === undefined ? allowedKeys.filter(key => key !== 'models') : allowedKeys)) {
      throw fail('record has an invalid shape', 'INVALID_GATEWAY_KEY_STORE')
    }
    if (typeof record.id !== 'string' || !ID_RE.test(record.id) || ids.has(record.id)) {
      throw fail('record id is invalid or duplicated', 'INVALID_GATEWAY_KEY_STORE')
    }
    if (typeof record.digest !== 'string' || !DIGEST_RE.test(record.digest) || digests.has(record.digest)) {
      throw fail('record digest is invalid or duplicated', 'INVALID_GATEWAY_KEY_STORE')
    }
    if (typeof record.prefix !== 'string' || record.prefix.length !== PREFIX_LENGTH ||
        !record.prefix.startsWith(TOKEN_PREFIX) || !/^[A-Za-z0-9_-]+$/.test(record.prefix.slice(TOKEN_PREFIX.length)) ||
        prefixes.has(record.prefix)) {
      throw fail('record prefix is invalid or duplicated', 'INVALID_GATEWAY_KEY_STORE')
    }
    const normalized = {
      id: record.id,
      digest: record.digest,
      prefix: record.prefix,
      label: normalizeLabel(record.label),
      createdAt: normalizeCreatedAt(record.createdAt),
      scopes: normalizeScopes(record.scopes),
    }
    if (record.models !== undefined) normalized.models = normalizeModels(record.models)
    ids.add(normalized.id)
    prefixes.add(normalized.prefix)
    digests.add(normalized.digest)
    return normalized
  })
}

/** A safe public shape; it never includes the digest or the plaintext key. */
function metadataOf(record) {
  return {
    id: record.id,
    prefix: record.prefix,
    label: record.label,
    createdAt: record.createdAt,
    scopes: [...record.scopes],
    ...(record.models === undefined ? {} : { models: [...record.models] }),
  }
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest()
}

function validToken(token) {
  return typeof token === 'string' &&
    token.length === TOKEN_PREFIX.length + TOKEN_RANDOM_LENGTH &&
    token.startsWith(TOKEN_PREFIX) &&
    /^[A-Za-z0-9_-]+$/.test(token.slice(TOKEN_PREFIX.length))
}

function validateCreateInput(input) {
  if (!isRecord(input) || !sameKeys(input,
    input.models === undefined ? ['label', 'scopes'] : ['label', 'scopes', 'models'])) {
    throw fail('input must contain only label, scopes, and optional models')
  }
  return {
    label: normalizeLabel(input.label),
    scopes: normalizeScopes(input.scopes),
    ...(input.models === undefined ? {} : { models: normalizeModels(input.models) }),
  }
}

/**
 * Create a key. `records` is the caller's current stored array; the returned
 * array is safe to persist. Keep `key` only long enough to show it once.
 * @returns {{records: object[], key: string, metadata: object}}
 */
export function createGatewayKey(records, input, { now = Date.now() } = {}) {
  const current = normalizeRecords(records)
  if (current.length >= MAX_GATEWAY_KEYS) throw fail(`at most ${MAX_GATEWAY_KEYS} gateway keys are allowed`, 'GATEWAY_KEY_LIMIT')
  const parsed = validateCreateInput(input)
  const createdAt = normalizeCreatedAt(now)
  const key = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url')
  const record = {
    id: crypto.randomUUID(),
    digest: tokenDigest(key).toString('hex'),
    prefix: key.slice(0, PREFIX_LENGTH),
    label: parsed.label,
    createdAt,
    scopes: parsed.scopes,
    ...(parsed.models === undefined ? {} : { models: parsed.models }),
  }
  const next = [...current, record]
  return { records: next, key, metadata: metadataOf(record) }
}

/** Return safe metadata only. Invalid persisted state throws; no entry is leaked. */
export function listGatewayKeys(records) {
  return normalizeRecords(records).map(metadataOf)
}

/** Revoke one key by its opaque ID. Throws NOT_FOUND for unknown IDs. */
export function revokeGatewayKey(records, id) {
  const current = normalizeRecords(records)
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('id is invalid')
  const next = current.filter(record => record.id !== id)
  if (next.length === current.length) throw fail('gateway key not found', 'NOT_FOUND')
  return next
}

/** Authenticate a bearer token with constant-time digest comparisons. */
export function authenticateGatewayKey(records, key) {
  const current = normalizeRecords(records)
  const supplied = validToken(key) ? tokenDigest(key) : Buffer.alloc(32)
  let matched = null
  for (const record of current) {
    const expected = Buffer.from(record.digest, 'hex')
    const equal = crypto.timingSafeEqual(supplied, expected)
    if (validToken(key) && equal) matched = record
  }
  return matched === null ? null : metadataOf(matched)
}

/** Check a key's operation scope and, where supplied, its exact model allowlist. */
export function gatewayKeyAllows(principal, { scope, model } = {}) {
  if (!isRecord(principal) || !SCOPE_SET.has(scope)) return false
  let scopes
  try { scopes = normalizeScopes(principal.scopes) } catch { return false }
  if (!scopes.includes(scope)) return false
  if (model !== undefined && (typeof model !== 'string' || model.length === 0)) return false
  if (principal.models !== undefined) {
    let models
    try { models = normalizeModels(principal.models) } catch { return false }
    if (model !== undefined && !models.includes(model)) return false
  }
  return true
}
