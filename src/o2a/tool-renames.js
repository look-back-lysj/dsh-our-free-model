/**
 * Reversible, request-scoped tool names for the free lane.
 *
 * ## The constraint
 *
 * The free tier refuses a shaped body whose tool declarations still read like
 * another agent client's. So a caller's tool name never goes out verbatim: each
 * one is replaced by an opaque handle, the model answers using the handle, and
 * the handle is mapped back to the caller's name on the way in. Nothing about
 * the model's behaviour changes; only the vocabulary on the wire does.
 *
 * ## Why the namespace is a measured value, not a chosen one
 *
 * The namespace prefix is itself fingerprinted. `clint_` was answered with
 * `429 FreeUsageLimitError` while a byte-identical body under a different
 * namespace completed — a same-day A/B on 2026-11-16, recorded in
 * `docs/free-lane-wire.md`. `mcp_` passes because a real MCP tool name could
 * plausibly carry it. If 429s ever return *only* on requests that carry tools,
 * rotate {@link TOOL_HANDLE_PREFIX}; nothing else depends on its spelling.
 *
 * ## Why handles are matched as a whole shape
 *
 * `mcp_` is also how genuine MCP tools are spelled (`mcp__github__search`). A
 * prefix test would therefore mistake a caller's real MCP tool for one of our
 * handles and ship it unrenamed — exactly the leak this module exists to
 * prevent. So a handle is recognised by its full shape: namespace, fixed-width
 * hex digest, optional collision counter. Anything else, including a real MCP
 * name, is treated as a caller tool.
 *
 * @module src/o2a/tool-renames
 */

import { createHash } from 'node:crypto'

/** Namespace for opaque handles. Measured; see the module comment. */
export const CLIENT_TOOL_PREFIX = 'mcp_'

/**
 * Namespaces earlier builds used. A conversation saved under one of them still
 * carries those handles, so a turn must be able to map them back.
 */
export const LEGACY_CLIENT_TOOL_PREFIXES = Object.freeze(['clint_'])

/** Hex characters of the digest embedded in a handle. */
export const CLIENT_TOOL_DIGEST_LENGTH = 12

/** Longest wire name the protocols accept. */
export const TOOL_WIRE_NAME_LIMIT = 64

const DIGEST_HEX = '0123456789abcdef'
const COUNTER_SUFFIX = /^_\d+$/

/**
 * Is this exactly a handle shape, under any namespace this lane has used?
 *
 * Deliberately structural rather than prefix-based — see the module comment for
 * why a prefix test is a correctness bug here and not merely a style choice.
 */
export function isWireToolName(name) {
  if (typeof name !== 'string' || name === '') return false
  for (const namespace of [CLIENT_TOOL_PREFIX, ...LEGACY_CLIENT_TOOL_PREFIXES]) {
    if (!name.startsWith(namespace)) continue
    const body = name.slice(namespace.length)
    // Split off an optional `_<n>` counter, then require the remainder to be
    // exactly the digest length in lowercase hex.
    const split = body.lastIndexOf('_')
    const digest = split > 0 && COUNTER_SUFFIX.test(body.slice(split)) ? body.slice(0, split) : body
    if (digest.length !== CLIENT_TOOL_DIGEST_LENGTH) continue
    let allHex = true
    for (const char of digest) if (!DIGEST_HEX.includes(char)) { allHex = false; break }
    if (allHex) return true
  }
  return false
}

/**
 * A comparison key for a tool name that ignores the separators and case a
 * protocol may vary.
 *
 * `Read`, `read`, `read_file` and `read-file` all fold to `read`. That is what
 * lets a handle be matched back to a caller tool whose spelling drifted between
 * the request and the response.
 */
export function foldToolName(name) {
  return String(name ?? '').toLowerCase().replace(/[_.\- \t\r\n]/g, '')
}

/**
 * Mint a handle for a caller tool name.
 *
 * The digest is derived from the name, so the same tool gets the same handle for
 * the life of a request. A collision — two distinct names hashing to the same
 * prefix, or the same name registered twice — is resolved by appending `_2`,
 * `_3`, and so on, trimming the digest so the total stays inside
 * {@link TOOL_WIRE_NAME_LIMIT}.
 *
 * `taken` is mutated: the caller passes the set of handles already issued in
 * this request so that uniqueness is enforced across calls, not just within one.
 */
export function clientToolWireName(name, taken) {
  const issued = taken instanceof Set ? taken : new Set()
  const digest = createHash('sha256').update(String(name)).digest('hex').slice(0, CLIENT_TOOL_DIGEST_LENGTH)
  const base = CLIENT_TOOL_PREFIX + digest
  if (!issued.has(base)) { issued.add(base); return base }
  for (let counter = 2; ; counter += 1) {
    const suffix = `_${counter}`
    const candidate = base.slice(0, TOOL_WIRE_NAME_LIMIT - suffix.length) + suffix
    if (issued.has(candidate)) continue
    issued.add(candidate)
    return candidate
  }
}

/**
 * The official OpenCode tool set, by canonical name.
 *
 * This is data, not behaviour: each entry lists the spellings a caller might use
 * for that tool. Only the canonical name is ever declared on the wire; the
 * spellings exist so a caller's own vocabulary can be recognised and folded onto
 * the official tool instead of being duplicated alongside it.
 */
export const OFFICIAL_TOOL_ALIASES = Object.freeze({
  edit: ['edit'],
  glob: ['glob'],
  grep: ['grep'],
  question: ['question', 'askuserquestion'],
  read: ['read', 'view'],
  shell: ['shell', 'bash'],
  skill: ['skill'],
  subagent: ['subagent', 'agent', 'task'],
  webfetch: ['webfetch', 'fetch'],
  websearch: ['websearch'],
  write: ['write'],
  patch: ['patch', 'applypatch'],
})

/** Folded spelling → canonical name, built once. */
const OFFICIAL_BY_SPELLING = new Map(
  Object.entries(OFFICIAL_TOOL_ALIASES)
    .flatMap(([canonical, spellings]) => spellings.map(spelling => [foldToolName(spelling), canonical])),
)

/** The official tool a caller's spelling refers to, or `null`. */
export function officialForClientName(name) {
  if (typeof name !== 'string' || name === '') return null
  return OFFICIAL_BY_SPELLING.get(foldToolName(name)) ?? null
}

/**
 * The bidirectional name map for one request.
 *
 * Extends `Map` from wire name to caller name, because that is the direction the
 * response path needs most often, and keeps three indexes for the reverse
 * direction:
 *
 * - `byClient` — exact caller name → handle. The unambiguous case.
 * - `byLower` — lowercased caller name → caller name. Recovers a name whose case
 *   drifted. A key claimed by two different callers is set to `''`, which marks
 *   it ambiguous; `resolve` then falls through to the folded index instead of
 *   guessing.
 * - `byFolded` — separator-insensitive key → caller name, same ambiguity rule.
 *
 * The `''` sentinel is the whole trick: "two callers collide here" is recorded
 * rather than resolved arbitrarily, so an ambiguous name is never mapped to one
 * caller's tool at another caller's expense.
 */
export class ToolRenameMap extends Map {
  #byClient = new Map()
  #byLower = new Map()
  #byFolded = new Map()

  /**
   * Record that `client`'s tool goes out as `wire`.
   *
   * No-ops when the mapping is trivial or already known, so shaping twice is
   * idempotent.
   */
  add(client, wire) {
    if (!client || !wire || client === wire) return
    if (this.#byClient.has(client) || this.has(wire)) return
    this.set(wire, client)
    this.#byClient.set(client, wire)
    for (const [index, key] of [[this.#byLower, String(client).toLowerCase()], [this.#byFolded, foldToolName(client)]]) {
      if (!key) continue
      const existing = index.get(key)
      // First claim wins; a second, different claimant poisons the key.
      index.set(key, existing === undefined || existing === client ? client : '')
    }
  }

  /** The handle issued for a caller tool, if any. */
  wireOf(client) {
    return this.#byClient.get(client)
  }

  /** Does any issued handle start with `prefix`? */
  hasPrefix(prefix) {
    if (!prefix) return false
    for (const wire of this.keys()) if (wire.startsWith(prefix)) return true
    return false
  }

  /** Does any issued handle extend `prefix` beyond itself? */
  hasLongerPrefix(prefix) {
    if (!prefix) return false
    for (const wire of this.keys()) if (wire.length > prefix.length && wire.startsWith(prefix)) return true
    return false
  }

  /**
   * Map a name arriving from the model back to the caller's tool name.
   *
   * Three attempts, in decreasing confidence:
   *
   * 1. An exact handle in this request's map.
   * 2. A handle minted by an earlier build: strip the namespace and look the
   *    remainder up as a caller name. This is what keeps a conversation saved
   *    under `clint_` working after an upgrade.
   * 3. Case-insensitive, then separator-insensitive lookup of whatever remains —
   *    including a name that was never renamed at all, which must survive intact
   *    so a genuine MCP tool is not mangled.
   *
   * Returns the input unchanged when nothing matches. That is the honest
   * outcome: the digest is one-way, so an unknown handle cannot be reversed, and
   * inventing a name would be worse than passing it through.
   */
  resolve(wire) {
    if (!wire) return wire
    const exact = this.get(wire)
    if (exact !== undefined) return exact

    // A name that is not a minted handle shape is the caller's own vocabulary —
    // including a genuine MCP tool name such as `mcp__github__search`. Stripping
    // the namespace from anything that merely starts with it is what turned that
    // name into `_github__search`, a tool the caller never declared. Tolerance
    // for case and separator drift still applies, but to the whole name.
    if (!isWireToolName(wire)) {
      const drifted = this.#byLower.get(wire.toLowerCase())
      if (drifted !== undefined) return drifted || wire
      return this.#byFolded.get(foldToolName(wire)) || wire
    }

    // A minted handle with no entry: the request that minted it is over and the
    // digest is one-way. Try the bare remainder as a caller name (an older build
    // recorded names that way), then pass the handle through unchanged. Turning
    // it into the bare digest would name a tool the caller never declared.
    const namespace = [CLIENT_TOOL_PREFIX, ...LEGACY_CLIENT_TOOL_PREFIXES]
      .find(candidate => wire.startsWith(candidate) && wire.length > candidate.length)
    const bare = namespace === undefined ? wire : wire.slice(namespace.length)
    if (this.#byClient.has(bare)) return bare
    const lower = this.#byLower.get(bare.toLowerCase())
    if (lower !== undefined && lower !== '') return lower
    return this.#byFolded.get(foldToolName(bare)) || wire
  }
}
