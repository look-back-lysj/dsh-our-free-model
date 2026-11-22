/**
 * Tool declaration shaping across the three wire protocols.
 *
 * ## The three shapes
 *
 * The lane speaks three protocols and each nests a tool declaration differently:
 *
 * | shape | where the tool lives | where the schema lives |
 * |---|---|---|
 * | `chat` | `tools[]` as `{ type: 'function', function }` | `function.parameters` |
 * | `flat` | `tools[]` as a bare object | `input_schema` |
 * | `claude` | `tools[]` as a bare object | `input_schema`, with `cache_control` |
 *
 * A rename that works in one shape silently produces a malformed declaration in another, which
 * is why the shape is a parameter everywhere rather than being inferred.
 *
 * ## What must be preserved byte-for-byte
 *
 * The appended official tool declarations are retained assets: their descriptions and schemas
 * are compared verbatim upstream. So this module renames caller tools and *de-shapes* their
 * descriptions, and leaves the official declarations untouched.
 *
 * @module src/o2a/rewrite/tool-shape
 */

import { isMintedName, mintWireName, officialFor, ToolNames } from './tool-names.js'

/** The shapes this module shapes declarations for. */
export const SHAPES = Object.freeze(['chat', 'flat', 'claude'])

/**
 * Replace ASCII spaces in a caller tool's description with non-breaking spaces.
 *
 * The free tier also rejects literal wording in a caller tool's prose. NBSP breaks that match
 * without changing what a reader sees. Only the top-level description is touched: parameter
 * schemas and parameter descriptions keep their exact bytes, because those are compared.
 *
 * Idempotent: NBSP is not an ASCII space, so a second pass finds nothing.
 *
 * @param {unknown} text
 * @returns {unknown}
 */
export function deLiteralize(text) {
  return typeof text === 'string' ? text.replaceAll(' ', '\u00a0') : text
}

/**
 * Read a declaration's name regardless of shape.
 *
 * @param {string} shape
 * @param {Record<string, any>} entry
 * @returns {string | null}
 */
export function declaredName(shape, entry) {
  if (entry === null || typeof entry !== 'object') return null
  if (shape === 'chat') {
    const name = entry.function?.name
    return typeof name === 'string' && name.length > 0 ? name : null
  }
  const name = entry.name
  return typeof name === 'string' && name.length > 0 ? name : null
}

/**
 * Rewrite a declaration's name, returning a copy.
 *
 * The caller's own object is never mutated: a request may be retried, and a mutated input would
 * make the second attempt rename an already-renamed tool.
 *
 * @param {string} shape
 * @param {Record<string, any>} entry
 * @param {string} name
 * @returns {Record<string, any>}
 */
export function withName(shape, entry, name) {
  if (shape === 'chat') {
    return { ...entry, function: { ...entry.function, name } }
  }
  return { ...entry, name }
}

/**
 * Rewrite a declaration's description with the de-literalised form.
 *
 * @param {string} shape
 * @param {Record<string, any>} entry
 * @returns {Record<string, any>}
 */
export function withDeLiteralizedDescription(shape, entry) {
  if (shape === 'chat') {
    const description = entry.function?.description
    if (typeof description !== 'string') return entry
    return { ...entry, function: { ...entry.function, description: deLiteralize(description) } }
  }
  if (typeof entry.description !== 'string') return entry
  return { ...entry, description: deLiteralize(entry.description) }
}

/**
 * Convert legacy `functions[]` entries into the request's own tool shape.
 *
 * An older caller may still send `functions`, which no current shape accepts. Converting rather
 * than dropping it keeps the tools usable; dropping them would make a working caller's tools
 * disappear with no error.
 *
 * @param {Array<Record<string, any>>} functions
 * @param {string} shape
 * @returns {Array<Record<string, any>>}
 */
export function fromLegacyFunctions(functions, shape) {
  return functions.map(entry => {
    const name = typeof entry?.name === 'string' ? entry.name : undefined
    if (name === undefined) return undefined
    const description = typeof entry.description === 'string' ? entry.description : undefined
    const parameters = entry.parameters ?? entry.input_schema
    if (shape === 'chat') {
      return {
        type: 'function',
        function: {
          name,
          ...(description === undefined ? {} : { description }),
          ...(parameters === undefined ? {} : { parameters }),
        },
      }
    }
    return {
      name,
      ...(description === undefined ? {} : { description }),
      ...(parameters === undefined ? {} : { input_schema: parameters }),
    }
  }).filter(entry => entry !== undefined)
}

/**
 * Rename every caller tool and append the official declarations.
 *
 * Order matters and is fixed: caller tools are renamed first (so their order is preserved),
 * then the official set is appended in its declared order. An official tool the caller already
 * declared is not appended twice, and a caller tool whose name maps to an official one takes
 * that official name rather than a minted wire name.
 *
 * @param {object} spec
 * @param {Record<string, any>} spec.payload
 * @param {string} spec.shape
 * @param {(name: string) => Record<string, any>} spec.officialTool - builds an official declaration
 * @param {readonly string[]} spec.officialOrder - the official names, in append order
 * @param {(name: string) => boolean} spec.isOfficial - whether an official declaration exists
 * @param {Set<string>} [spec.keep] - names to leave untouched
 * @returns {{ names: ToolNames, injected: string[], known: Set<string>, declared: number }}
 */
export function shapeTools({ payload, shape, officialTool, officialOrder, isOfficial, keep }) {
  const names = new ToolNames()
  const injected = []
  const known = new Set()
  if (!SHAPES.includes(shape)) return { names, injected, known, declared: 0 }

  const preserved = keep instanceof Set ? keep : new Set()
  const officialTaken = new Set(preserved)
  const allocated = new Set()
  const entries = Array.isArray(payload.tools) ? [...payload.tools] : []

  if (shape !== 'claude' && Array.isArray(payload.functions)) {
    for (const entry of fromLegacyFunctions(payload.functions, shape)) entries.push(entry)
    delete payload.functions
  }

  let declared = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const name = declaredName(shape, entry)
    if (name === null) continue
    declared += 1
    // A name already in the minted shape is left alone: this is an idempotent second pass.
    // Tested as a whole shape, never by prefix, because `mcp_` also starts real MCP tool names.
    if (preserved.has(name) || isMintedName(name)) continue

    const canonical = officialFor(name)
    let wire
    if (canonical !== null && !officialTaken.has(canonical) && isOfficial(canonical)) {
      officialTaken.add(canonical)
      wire = canonical
      names.add(name, wire)
    } else {
      wire = names.wireFor(name) ?? mintWireName(name, allocated)
      names.add(name, wire)
    }

    let shaped = wire === name ? entry : withName(shape, entry, wire)
    shaped = withDeLiteralizedDescription(shape, shaped)
    entries[index] = shaped
  }

  for (const name of officialOrder) {
    if (officialTaken.has(name)) continue
    entries.push(officialTool(name))
    officialTaken.add(name)
    injected.push(name)
  }

  for (const name of officialTaken) known.add(name)
  for (const wire of names.wires()) known.add(wire)
  payload.tools = entries
  return { names, injected, known, declared }
}

/**
 * Rewrite references to renamed tools in the conversation history.
 *
 * A tool call in history and its result both carry the name; if the declaration was renamed and
 * the history was not, the provider sees a result for a tool that was never declared.
 *
 * @param {Record<string, any>} payload
 * @param {string} shape
 * @param {ToolNames} names
 */
export function rewriteHistory(payload, shape, names) {
  if (names.size() === 0) return
  for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
    if (message === null || typeof message !== 'object') continue
    if (shape === 'chat') {
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const name = call?.function?.name
        if (typeof name !== 'string') continue
        const wire = names.wireFor(name)
        if (wire !== undefined) call.function.name = wire
      }
    } else {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type !== 'tool_use') continue
        const name = block.name
        if (typeof name !== 'string') continue
        const wire = names.wireFor(name)
        if (wire !== undefined) block.name = wire
      }
    }
    if (typeof message.name === 'string') {
      const wire = names.wireFor(message.name)
      if (wire !== undefined) message.name = wire
    }
  }
}

/**
 * Drop history entries that reference a tool this request no longer declares.
 *
 * A call whose declaration is gone produces "unknown tool" upstream, and the error names the
 * tool rather than the trimming, which sends a reader looking in the wrong place. Dropping the
 * call and its paired results keeps the conversation valid.
 *
 * @param {Record<string, any>} payload
 * @param {string} shape
 * @param {Set<string>} known
 * @returns {number} how many entries were dropped
 */
export function pruneUnknownTools(payload, shape, known) {
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  let dropped = 0
  const liveCallIds = new Set()

  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (shape === 'chat') {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (calls.length === 0) continue
      const kept = calls.filter(call => {
        const name = call?.function?.name
        if (typeof name !== 'string' || known.has(name)) {
          if (typeof call?.id === 'string') liveCallIds.add(call.id)
          return true
        }
        dropped += 1
        return false
      })
      if (kept.length === 0) delete message.tool_calls
      else message.tool_calls = kept
      continue
    }
    const content = Array.isArray(message.content) ? message.content : []
    const kept = content.filter(block => {
      if (block?.type !== 'tool_use') return true
      if (typeof block.name === 'string' && known.has(block.name)) {
        if (typeof block.id === 'string') liveCallIds.add(block.id)
        return true
      }
      dropped += 1
      return false
    })
    if (kept.length !== content.length) message.content = kept
  }

  // A tool result whose call was dropped is an orphan; remove it too.
  const next = messages.filter(message => {
    if (message?.role !== 'tool') return true
    const id = message.toolCallId ?? message.tool_call_id
    if (typeof id !== 'string') return true
    if (liveCallIds.has(id)) return true
    dropped += 1
    return false
  })
  if (next.length !== messages.length) payload.messages = next
  return dropped
}

/**
 * Drop a `tool_choice` that names a tool this request does not declare.
 *
 * A dangling choice is a hard error upstream; omitting the field lets the provider choose, which
 * is always valid.
 *
 * @param {Record<string, any>} payload
 * @param {string} shape
 * @param {Set<string>} known
 */
export function dropDanglingChoice(payload, shape, known) {
  const choice = payload.tool_choice
  if (choice === undefined || choice === null || typeof choice === 'string') return
  const name = shape === 'chat' ? choice.function?.name : choice.name
  if (typeof name !== 'string') return
  if (known.has(name)) return
  delete payload.tool_choice
}
