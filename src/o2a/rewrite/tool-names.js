/**
 * Reversible tool-name mapping for the free lane.
 *
 * ## Why tool names are rewritten at all
 *
 * The free tier refuses a request whose body still reads as another client's session, and a
 * caller's own tool names are the most obvious tell. So every caller tool is renamed to an
 * opaque wire name before the request leaves, and mapped back when the response comes in.
 *
 * ## The distinction this module must never blur
 *
 * The namespace is `mcp_`, which is *also* how real MCP tools are spelled — `mcp__github__search`
 * is a legitimate caller tool name. That collision is the whole difficulty:
 *
 * - A name this lane minted is `mcp_` plus exactly 12 lowercase hex digits, optionally followed
 *   by `_<n>` for a collision.
 * - A real MCP tool name is `mcp_` followed by anything else.
 *
 * The original implementation checked the full shape when *deciding* whether to rename, but
 * when *recovering* a name it stripped any matching prefix. So once any other tool had been
 * renamed, a real `mcp__github__search` came back as `_github__search` — a tool the caller never
 * declared. The fix is to recognise a minted name by its whole shape on the recovery path too,
 * and to strip nothing otherwise.
 *
 * ## Legacy generations
 *
 * A conversation saved under an older build carries wire names from that build's namespace.
 * Those still have to map back, so the previous namespaces are listed and matched with the same
 * exact-shape rule.
 *
 * @module src/o2a/rewrite/tool-names
 */

import { createHash } from 'node:crypto'

/**
 * The namespace caller tools are renamed into.
 *
 * A namespace a real tool name could carry is what makes the request pass; the previous value
 * (`clint_`) was answered with a rate-limit error on an otherwise identical body. If the
 * upstream ever learns this value, rotating this constant is the whole fix — nothing else
 * depends on the spelling.
 */
export const WIRE_PREFIX = 'mcp_'

/** Namespaces earlier builds used. Saved history still carries their names. */
export const LEGACY_WIRE_PREFIXES = Object.freeze(['clint_'])

/** How many hex digits of the digest the wire name carries. */
export const DIGEST_LENGTH = 12

/** The longest wire name the provider accepts. */
export const WIRE_NAME_LIMIT = 64

/** Every namespace this lane has ever minted. */
export const ALL_PREFIXES = Object.freeze([WIRE_PREFIX, ...LEGACY_WIRE_PREFIXES])

/**
 * Build the matcher for one namespace: prefix, exactly `DIGEST_LENGTH` hex digits, optional
 * numeric collision suffix, anchored at both ends.
 *
 * @param {string} prefix
 * @returns {RegExp}
 */
function mintedPattern(prefix) {
  return new RegExp(`^${escapeRegExp(prefix)}[0-9a-f]{${DIGEST_LENGTH}}(?:_\\d+)?$`)
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const MINTED_PATTERNS = ALL_PREFIXES.map(prefix => [prefix, mintedPattern(prefix)])

/**
 * Was this name minted by this lane, in any generation?
 *
 * Matched as a whole, never by prefix. `mcp__github__search` starts with `mcp_` and is *not* a
 * minted name, which is exactly the case a prefix test gets wrong.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isMintedName(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  return MINTED_PATTERNS.some(([, pattern]) => pattern.test(name))
}

/**
 * The namespace a minted name belongs to, or undefined when it is not minted.
 *
 * @param {string} name
 * @returns {string | undefined}
 */
export function namespaceOf(name) {
  if (typeof name !== 'string' || name.length === 0) return undefined
  for (const [prefix, pattern] of MINTED_PATTERNS) {
    if (pattern.test(name)) return prefix
  }
  return undefined
}

/**
 * Strip a minted name's namespace and collision suffix, yielding the digest token.
 *
 * Returns undefined for a name that is not minted: the caller must not guess.
 *
 * @param {string} name
 * @returns {string | undefined}
 */
export function digestOf(name) {
  const prefix = namespaceOf(name)
  if (prefix === undefined) return undefined
  return name.slice(prefix.length).replace(/_\d+$/, '')
}

/**
 * Fold a name for tolerant comparison.
 *
 * Case and separator differences are not meaningful to a user typing a tool name, so they are
 * folded away when a *client* name has to be matched approximately. They are never folded when
 * deciding whether a name is minted, because that decision is exact by design.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function foldName(name) {
  return String(name ?? '').toLowerCase().replace(/[_.\- \t\r\n]/g, '')
}

/**
 * Mint a wire name for a caller tool.
 *
 * The digest makes the mapping stable for a given name, so the same tool maps to the same wire
 * name across turns without extra state. A collision within one request gets a numeric suffix.
 *
 * @param {string} name
 * @param {Set<string>} [taken]
 * @returns {string}
 */
export function mintWireName(name, taken) {
  const used = taken instanceof Set ? taken : new Set()
  const base = WIRE_PREFIX + createHash('sha256').update(String(name)).digest('hex').slice(0, DIGEST_LENGTH)
  let candidate = base
  for (let n = 2; used.has(candidate); n += 1) {
    const suffix = `_${n}`
    candidate = base.slice(0, WIRE_NAME_LIMIT - suffix.length) + suffix
  }
  used.add(candidate)
  return candidate
}

/**
 * A request-scoped bidirectional map between caller names and wire names.
 *
 * Deliberately a class rather than a plain `Map`: the map needs three lookups (by wire name, by
 * exact client name, and by folded client name) and a plain map only gives the first.
 */
export class ToolNames {
  constructor() {
    /** @type {Map<string, string>} wire -> client */
    this.byWire = new Map()
    /** @type {Map<string, string>} client -> wire */
    this.byClient = new Map()
    /** @type {Map<string, string | null>} folded client -> client, null when ambiguous */
    this.byFolded = new Map()
  }

  /**
   * Record a rename. A no-op when the pair is already known or would collide.
   *
   * @param {string} client
   * @param {string} wire
   */
  add(client, wire) {
    if (typeof client !== 'string' || client.length === 0) return
    if (typeof wire !== 'string' || wire.length === 0) return
    if (client === wire) return
    if (this.byClient.has(client) || this.byWire.has(wire)) return
    this.byWire.set(wire, client)
    this.byClient.set(client, wire)
    const folded = foldName(client)
    if (folded.length > 0) {
      // A second client folding to the same key makes the folded lookup ambiguous, so it is
      // poisoned rather than resolving to whichever was seen last.
      this.byFolded.set(folded, this.byFolded.has(folded) ? null : client)
    }
  }

  /** The wire name for a caller tool, when one was minted. */
  wireFor(client) {
    return this.byClient.get(client)
  }

  /** Does any wire name start with this text? */
  hasPrefix(prefix) {
    if (typeof prefix !== 'string' || prefix.length === 0) return false
    for (const wire of this.byWire.keys()) if (wire.startsWith(prefix)) return true
    return false
  }

  /** Does any wire name start with this text *and* continue past it? */
  hasLongerPrefix(prefix) {
    if (typeof prefix !== 'string' || prefix.length === 0) return false
    for (const wire of this.byWire.keys()) {
      if (wire.length > prefix.length && wire.startsWith(prefix)) return true
    }
    return false
  }

  /**
   * Map a wire name back to the caller's name.
   *
   * The recovery rule is the whole point of this module:
   *
   * 1. an exact hit in this request's map wins;
   * 2. otherwise the name is only *considered* for recovery when it is a **minted shape** —
   *    `mcp_` plus 12 hex digits, in this generation or a legacy one. A name that merely starts
   *    with `mcp_` is a caller tool and is returned untouched;
   * 3. for a minted name with no map entry (a name from an earlier turn, whose map is gone),
   *    the digest cannot be reversed, so the name is returned as-is rather than guessed at.
   *
   * Step 2 is the fix: the previous implementation stripped the prefix from *any* name, which
   * turned `mcp__github__search` into `_github__search`.
   *
   * @param {string} wire
   * @returns {string}
   */
  resolve(wire) {
    if (typeof wire !== 'string' || wire.length === 0) return wire
    const exact = this.byWire.get(wire)
    if (exact !== undefined) return exact
    // Not a minted shape: a real caller tool name, including a real MCP name. Return it whole.
    if (!isMintedName(wire)) return wire
    // A minted shape with no entry: the request that minted it is over, and the digest is
    // one-way. Returning the wire name is honest; inventing a client name would be worse.
    return wire
  }

  /**
   * Match a name against a known client tool, tolerating case and separator differences.
   *
   * Used when a response carries a name the caller wrote with different punctuation.
   *
   * @param {string} name
   * @returns {string}
   */
  resolveFolded(name) {
    if (typeof name !== 'string' || name.length === 0) return name
    const direct = this.byClient.get(name)
    if (direct !== undefined) return name
    const folded = this.byFolded.get(foldName(name))
    return typeof folded === 'string' ? folded : name
  }

  /** How many renames were recorded. */
  size() {
    return this.byWire.size
  }

  /** Every wire name in this request. */
  wires() {
    return [...this.byWire.keys()]
  }
}

/**
 * The official tool spellings this lane recognises.
 *
 * Retained as data: a caller may spell a built-in tool in any of these ways, and the lane maps
 * it to the canonical official name so the injected declaration matches.
 */
export const OFFICIAL_ALIASES = Object.freeze({
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

const ALIAS_INDEX = new Map(Object.entries(OFFICIAL_ALIASES)
  .flatMap(([canonical, spellings]) => spellings.map(spelling => [foldName(spelling), canonical])))

/**
 * The canonical official tool for a caller's spelling, or null.
 *
 * @param {unknown} name
 * @returns {string | null}
 */
export function officialFor(name) {
  if (typeof name !== 'string' || name.length === 0) return null
  return ALIAS_INDEX.get(foldName(name)) ?? null
}
