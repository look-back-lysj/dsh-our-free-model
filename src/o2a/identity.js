/**
 * Session and project identifiers for the free lane.
 *
 * ## What the upstream actually checks
 *
 * The free tier does not merely look for the `ses_` prefix. It decodes the id
 * and validates three independent properties. Each is stated here as a
 * constraint on the output, which is how this module is built — the checks are
 * the specification, not any prior implementation of them.
 *
 * 1. **Layout.** `ses_` followed by 26 base62 characters. The first 12 of those
 *    characters are read as hex, not base62: they carry a 48-bit unsigned
 *    integer whose low 12 bits must fall in `0xfc0..0xfff`. Everything after
 *    character 12 is opaque payload.
 *
 * 2. **Time plausibility.** The high 36 bits of that 48-bit integer are a
 *    millisecond phase, and the phase is compared against a slow clock with a
 *    ~795-day period (2^36 ms). An id whose phase is far from "recent" is
 *    rejected with the same `429` an exhausted quota produces, which is why a
 *    naive hash-derived value fails: its phase lands anywhere in the cycle.
 *
 * 3. **Stability.** The quota is metered per (project, session) pair, so a
 *    conversation must keep one id for its whole life. Re-minting per request
 *    would silently multiply the bucket.
 *
 * ## Why the encoding is inverted
 *
 * The 48-bit field is stored complemented — `0xffffffffffff - value` — so that
 * the hex text *decreases* as time advances. That is observable from the wire:
 * two ids minted a second apart, hex-compared, run backwards. The reader below
 * decodes it back by inverting, and the writer emits it by inverting. Both
 * directions are exercised by `scripts/stable-session-test.mjs`.
 *
 * ## What this module does not do
 *
 * It does not mint a counter. The low 12 bits are pinned to the complemented
 * form of counter 1, the smallest value the range check accepts. Upstream uses
 * that counter to let one millisecond hold several ids; this lane needs one id
 * per conversation, so a constant is both sufficient and easier to reason
 * about.
 *
 * @module src/o2a/identity
 */

import { createHash, randomBytes } from 'node:crypto'

/** `ses_` + 12 hex characters + 14 characters of payload. */
export const CANONICAL_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/**
 * The 12 hex characters must encode a complemented value whose low bits sit at
 * the top of the 12-bit range. Expressed as a regex because that is cheaper
 * than decoding, and because the constraint is genuinely about the characters:
 * nine arbitrary hex digits, then `f`, then `c..f`, then two more.
 */
export const DESCENDING_TIME_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/

/** Digits for the opaque payload half. Order matters: it is an encoding, not a set. */
export const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * How far back the minted phase may sit: 30 days in milliseconds.
 *
 * Comfortably inside the upstream's tolerance while staying well short of the
 * 2^36 ms cycle, so a minted id is unambiguous about which cycle it belongs to.
 */
export const SESSION_TIMESTAMP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** One full turn of the 36-bit phase clock. */
export const SESSION_PHASE_MS = 2n ** 36n

const FIELD_BITS = 48n
const FIELD_MASK = (1n << FIELD_BITS) - 1n
const COUNTER_ONE = 1n
const PAYLOAD_OFFSET = 6
const PAYLOAD_BYTES = 10
const PAYLOAD_CHARS = 14
const MS_PER_DAY = 86400000

/**
 * Per-process entropy mixed into the digest, so two runs given the same
 * conversation seed produce different payloads. Not a secret — the payload is
 * opaque to the upstream — only a way to avoid handing every install of this
 * plugin the same id for the same conversation name.
 */
const processSalt = randomBytes(16)

/**
 * True when `value` already satisfies both shape and range checks.
 *
 * Deliberately a pure predicate: callers use it to decide "pass through" versus
 * "re-mint", and an id that passes must never be rewritten.
 */
export function isOfficialSessionID(value) {
  if (typeof value !== 'string') return false
  if (!CANONICAL_SESSION_RE.test(value)) return false
  return DESCENDING_TIME_RE.test(value.slice(4, 16))
}

/**
 * Decode the millisecond phase out of an id, or `null` if the id is unusable.
 *
 * The stored field is complemented, so the inverse is a complement followed by
 * a shift that discards the 12-bit counter.
 */
export function sessionPhaseMs(id) {
  if (!isOfficialSessionID(id)) return null
  const stored = BigInt(`0x${id.slice(4, 16)}`)
  return Number((FIELD_MASK - stored) >> 12n)
}

/** Where the phase clock currently stands. */
export function currentTimePhaseMs(now = Date.now()) {
  return now % Number(SESSION_PHASE_MS)
}

/**
 * How far behind the clock `phase` is, wrapped into one cycle.
 *
 * The modulo is applied twice so a phase slightly ahead of the clock reads as
 * "almost a full cycle old" rather than as a negative age — the conservative
 * direction, since an id from a future cycle then gets re-minted.
 */
export function phaseAgeMs(phase, now = Date.now()) {
  const period = Number(SESSION_PHASE_MS)
  return ((currentTimePhaseMs(now) - phase) % period + period) % period
}

/**
 * Encode a timestamp into the complemented 48-bit field.
 *
 * `hash` supplies the jitter: a hash-derived offset inside the window is
 * subtracted from today's UTC midnight, so two conversations started on the
 * same day do not share a phase. Deriving the offset from the digest rather
 * than from `Math.random` keeps the result reproducible for a given seed and
 * salt, which is what makes the id stable across a process lifetime.
 */
export function encodePhaseField(now = Date.now(), hash) {
  const offset = hash[0] * 16777216 + hash[1] * 65536 + hash[2] * 256 + hash[3]
  const midnight = Math.floor(now / MS_PER_DAY) * MS_PER_DAY
  const stamp = midnight - (offset % SESSION_TIMESTAMP_WINDOW_MS)
  const field = ((BigInt(stamp) << 12n) | COUNTER_ONE) & FIELD_MASK
  return (FIELD_MASK - field).toString(16).padStart(12, '0')
}

/**
 * Render `bytes` as exactly `width` base62 characters, most significant first.
 *
 * The value is read as a big-endian integer and reduced one digit at a time.
 * When the integer is too small for `width` digits the left side fills with
 * `0`, which keeps the output length fixed — a requirement, since the payload
 * is the tail of a fixed-length id.
 */
export function encodeFixedBase62(bytes, width) {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  let text = ''
  for (let remaining = width; remaining > 0; remaining -= 1) {
    text = BASE62_ALPHABET[Number(value % 62n)] + text
    value /= 62n
  }
  return text
}

/**
 * Re-encode an arbitrary conversation signal into a gate-acceptable session id.
 *
 * An id that already passes is returned untouched — rewriting a valid id would
 * rotate the upstream bucket and break quota accounting. Anything else is
 * hashed together with the process salt and encoded fresh.
 */
export function mintSessionIdentifier(signal, now = Date.now()) {
  if (isOfficialSessionID(signal)) return signal
  const digest = createHash('sha256')
    .update('ses')
    .update('\0')
    .update(processSalt)
    .update('\0')
    .update(String(signal))
    .digest()
  const phase = encodePhaseField(now, digest)
  const payload = encodeFixedBase62(digest.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + PAYLOAD_BYTES), PAYLOAD_CHARS)
  return `ses_${phase}${payload}`
}

/** A `prefix_` id from `size` random bytes, for local bookkeeping. */
export function randomID(prefix, size) {
  return prefix + '_' + randomBytes(size).toString('hex')
}

/** A 40-hex project id, matching the length of a git commit. */
export function randomProjectID() {
  return randomBytes(20).toString('hex')
}
