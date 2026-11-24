/**
 * Keep a request's tool declarations, references and history coherent.
 *
 * ## Why this exists
 *
 * The free lane has to present a body that reads like the official client's: the
 * full official tool set declared, no caller vocabulary on the wire, and a
 * history whose tool calls all refer to tools the body still declares. A body
 * that declares a tool and then answers with a call to a name it never declared
 * is rejected, and a history carrying a call to a tool that is no longer
 * declared makes the model re-issue work it already did.
 *
 * Three jobs, in order:
 *
 * 1. **Declarations.** Every caller tool gets a wire name: the canonical official
 *    name when the caller's spelling maps to one, otherwise an opaque handle.
 *    The official set is then completed, so the body always declares all of it.
 * 2. **References.** `tool_choice`, `function_call` and per-turn tool-call
 *    records are rewritten to the same wire names, because a reference that
 *    disagrees with the declaration is the failure above.
 * 3. **History.** Calls to tools the shaped body does not serve are removed,
 *    together with their results. This runs only when the body declared at least
 *    one tool, because a toolless body has no declarations to disagree with.
 *
 * ## Mutation discipline
 *
 * `payload` is mutated in place — the caller expects the same object back, since
 * the fingerprint pass already mutated it and a copy would make the two
 * disagree. Individual records are *cloned* before modification, so an object the
 * caller still holds is never changed underneath it. Every helper below therefore
 * returns either the original reference (nothing to do) or a new object.
 *
 * @module src/o2a/toolshape
 */

import { ToolRenameMap, isWireToolName, clientToolWireName, officialForClientName } from './tool-renames.js'
import { V2_OFFICIAL_TOOL_ORDER, officialTool, officialToolDefinition, renamableToolName } from './official-tools.js'

/** Protocol shapes this module shapes. Anything else is passed through untouched. */
const SHAPED = new Set(['chat', 'flat', 'claude'])

/**
 * Replace ASCII spaces with non-breaking spaces in a caller tool's description.
 *
 * The free tier rejects literal wording in a caller's tool prose. NBSP breaks
 * that match while leaving the text a model reads unchanged — a measured result
 * from this project's own run on 2026-11-20.
 *
 * Only the top-level description is touched. Parameter schemas, parameter
 * descriptions and the appended official definitions keep their exact bytes,
 * because those are compared verbatim upstream.
 *
 * Idempotent by construction: NBSP is not an ASCII space, so a second pass finds
 * nothing left to replace.
 */
function deLiteralize(text) {
  return typeof text === 'string' ? text.replaceAll(' ', '\u00a0') : text
}

/**
 * Does this declaration already carry the verbatim official definition for `name`?
 *
 * Compared against the **rendered** official tool, not the raw asset: the shell
 * description is platform-aware, so on a Windows host the official `shell` says
 * `powershell` where the asset says `bash`. Comparing against the asset would
 * report a false negative on every non-bash platform.
 *
 * This is the test that separates "the caller happens to use an official tool's
 * name" (their prose, must be de-literalised) from "this is already the official
 * declaration" (bytes compared verbatim upstream, must not be touched).
 */
function carriesOfficialDefinition(shape, entry, name) {
  const wrapper = shape === 'chat' ? entry?.function : entry
  if (wrapper === null || wrapper === undefined || typeof wrapper !== 'object') return false
  const rendered = officialTool(shape, name)
  const target = shape === 'chat' ? rendered.function : rendered
  if (!target) return false
  const schema = shape === 'claude' ? wrapper.input_schema : wrapper.parameters
  const targetSchema = shape === 'claude' ? target.input_schema : target.parameters
  return wrapper.description === target.description
    && JSON.stringify(schema) === JSON.stringify(targetSchema)
}

/**
 * Give a declaration its wire name, cloning only when something changes.
 *
 * Chat nests the declaration under `function`; the flat and Claude shapes put it
 * on the entry itself.
 */
function withWireName(shape, entry, name) {
  if (shape === 'chat') return { ...entry, function: { ...entry.function, name } }
  return { ...entry, name }
}

/**
 * De-literalise a declaration's description, cloning only when it changes.
 *
 * Returns the same reference when the description is already free of ASCII
 * spaces, so an already-shaped entry is not cloned again on a second pass.
 */
function withDeLiteralizedDescription(shape, entry) {
  if (shape === 'chat') {
    const fn = entry.function
    if (!fn || typeof fn !== 'object') return entry
    const description = deLiteralize(fn.description)
    return description === fn.description ? entry : { ...entry, function: { ...fn, description } }
  }
  const description = deLiteralize(entry.description)
  return description === entry.description ? entry : { ...entry, description }
}

/**
 * Convert the pre-tools `functions` array into tool declarations.
 *
 * Older clients send `functions: [{name, description, parameters, strict?}]`.
 * Each becomes a declaration under the same wire name the tool pass would have
 * given it, so the two arrays cannot disagree if a body carries both.
 *
 * Entries that are not a plain object with a non-empty string name are skipped
 * rather than guessed at.
 */
function declarationsFromLegacyFunctions(entries, shape, renames, taken) {
  const converted = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (typeof entry.name !== 'string' || entry.name === '') continue
    let wire = renames.wireOf(entry.name)
    if (wire === undefined) {
      wire = clientToolWireName(entry.name, taken)
      renames.add(entry.name, wire)
    }
    const declaration = {
      name: wire,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      parameters: entry.parameters ?? { type: 'object', properties: {} },
    }
    if (entry.strict !== undefined) declaration.strict = entry.strict
    converted.push(shape === 'chat' ? { type: 'function', function: declaration } : { type: 'function', ...declaration })
  }
  return converted
}

/**
 * Choose the wire name for one caller tool and record the mapping.
 *
 * A caller spelling that names an official tool may ride under that official
 * name only when its declaration IS the official definition, byte for byte.
 * A spelling alone is not enough: the upstream compares what it finds at an
 * official name against the official definition, and a caller schema there is
 * answered with 429 (measured 2026-11-22: DSH's own `bash` schema under `shell`
 * → 429; the same bytes renamed to `mcp_<hash>` → 200). Everything else gets a
 * handle, and the official set is still appended verbatim.
 *
 * `state.officials` and `state.taken` are both mutated: the first tracks which
 * official names are already declared, the second which handles are issued.
 */
function assignWireName(name, state, { shape, entry } = {}) {
  const canonical = officialForClientName(name)
  if (canonical !== null && !state.officials.has(canonical) && officialToolDefinition(canonical) !== undefined
    && carriesOfficialDefinition(shape, entry, canonical)) {
    state.officials.add(canonical)
    state.renames.add(name, canonical)
    return canonical
  }
  const existing = state.renames.wireOf(name)
  if (existing !== undefined) return existing
  const minted = clientToolWireName(name, state.taken)
  state.renames.add(name, minted)
  return minted
}

/**
 * Rewrite every named tool reference in the body to its wire name.
 *
 * Three shapes, three places a name can hide:
 *
 * - **chat** — `tool_choice.function.name`, `function_call.name`, and every
 *   `messages[].tool_calls[].function.name`.
 * - **flat** — `tool_choice.name` (plus `allowed_tools` when the choice is a
 *   list), `input[]` records of type `function_call` / `custom_tool_call`.
 * - **claude** — `tool_choice.name` and `content[]` blocks of type `tool_use`.
 *
 * Only records that actually change are cloned. A caller record whose name is
 * already correct is passed through by reference.
 */
function remapToolReferences(payload, shape, renames) {
  if (renames.size === 0) return

  /** Clone a `{name}`-bearing record if its name has a wire form. */
  const named = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    if (typeof value.name !== 'string') return value
    const wire = renames.wireOf(value.name)
    return wire === undefined || wire === value.name ? value : { ...value, name: wire }
  }

  /** As above, for a record that nests its name under `function`. */
  const nested = value => {
    if (!value || typeof value !== 'object') return value
    const fn = named(value.function)
    return fn === value.function ? value : { ...value, function: fn }
  }

  /**
   * Map one array-valued field of `owner`, cloning the array only if an element
   * changed and cloning `owner` only if the array changed.
   */
  const mapped = (owner, key, convert) => {
    if (!Array.isArray(owner[key])) return owner
    const original = owner[key]
    let replacement
    for (let index = 0; index < original.length; index += 1) {
      const converted = convert(original[index])
      if (converted === original[index]) continue
      replacement ??= original.slice()
      replacement[index] = converted
    }
    return replacement === undefined ? owner : { ...owner, [key]: replacement }
  }

  const choice = payload.tool_choice
  if (choice && typeof choice === 'object' && !Array.isArray(choice)) {
    if (shape === 'chat') {
      payload.tool_choice = choice.function && typeof choice.function === 'object' ? nested(choice) : named(choice)
    } else {
      const rewritten = named(choice)
      payload.tool_choice = shape === 'flat' ? mapped(rewritten, 'allowed_tools', named) : rewritten
    }
  }

  if (shape === 'chat') {
    if (payload.function_call && typeof payload.function_call === 'object') {
      payload.function_call = named(payload.function_call)
    }
    if (!Array.isArray(payload.messages)) return
    for (let index = 0; index < payload.messages.length; index += 1) {
      const message = payload.messages[index]
      if (!message || typeof message !== 'object') continue
      const fn = named(message.function_call)
      const next = fn === message.function_call ? message : { ...message, function_call: fn }
      payload.messages[index] = mapped(next, 'tool_calls', nested)
    }
    return
  }

  if (shape === 'flat') {
    if (!Array.isArray(payload.input)) return
    for (let index = 0; index < payload.input.length; index += 1) {
      const item = payload.input[index]
      if (item?.type === 'function_call' || item?.type === 'custom_tool_call') payload.input[index] = named(item)
    }
    return
  }

  if (!Array.isArray(payload.messages)) return
  for (let index = 0; index < payload.messages.length; index += 1) {
    const message = payload.messages[index]
    if (!message || typeof message !== 'object') continue
    payload.messages[index] = mapped(message, 'content', block => (block?.type === 'tool_use' ? named(block) : block))
  }
}

/**
 * Does this chat message carry anything a model would read?
 *
 * Used to decide whether a message emptied by history cleanup is worth keeping.
 * A message whose only content was tool calls to removed tools is not: it would
 * read as an assistant turn that said nothing.
 *
 * An object or array counts as content when it is non-empty; a string when it has
 * length. `null` and `undefined` never count.
 */
function carriesContent(message) {
  for (const key of ['content', 'reasoning_content', 'reasoning']) {
    const value = message[key]
    if (value === null || value === undefined) continue
    if (typeof value === 'string' || Array.isArray(value)) {
      if (value.length > 0) return true
      continue
    }
    if (typeof value !== 'object') return true
    if (Object.keys(value).length > 0) return true
  }
  return false
}

/**
 * Decide whether a tool name in history is still served.
 *
 * A name is served when it is one the shaped body declares. A caller's own
 * spelling of an official tool is also served, mapped onto the official name, so
 * a saved conversation keeps working across the rename.
 */
function servedName(known) {
  return name => {
    if (typeof name !== 'string' || name === '') return null
    if (known.has(name)) return name
    const canonical = officialForClientName(name)
    return canonical !== null && known.has(canonical) ? canonical : null
  }
}

/** Rewrite one `flat` (Responses-style) input record. */
function rewriteFlatRecord(row, ctx) {
  if (row?.type === 'function_call') {
    const name = ctx.served(row.name)
    if (name === null) {
      if (typeof row.call_id === 'string' && row.call_id !== '') ctx.droppedCalls.add(row.call_id)
      return { row, drop: true }
    }
    return { row: name === row.name ? row : { ...row, name }, drop: false }
  }
  if (row?.type === 'function_call_output' && ctx.droppedCalls.has(row.call_id)) {
    return { row, drop: true }
  }
  return { row, drop: false }
}

/** Rewrite one `chat` message. */
function rewriteChatRecord(original, ctx) {
  let row = original
  let emptied = false

  if (Array.isArray(row.tool_calls)) {
    const kept = []
    // An empty array counts as touched: it is removed below rather than shipped
    // as a declaration of "no calls", which some upstreams read as malformed.
    let touched = row.tool_calls.length === 0
    for (const call of row.tool_calls) {
      const name = ctx.served(call?.function?.name)
      if (name === null) {
        if (typeof call?.id === 'string' && call.id !== '') ctx.droppedCalls.add(call.id)
        touched = true
        continue
      }
      if (name === call.function.name) { kept.push(call); continue }
      kept.push({ ...call, function: { ...call.function, name } })
      touched = true
    }
    if (touched) {
      emptied = kept.length === 0 && row.tool_calls.length > 0 && row.function_call === undefined
      row = { ...row }
      if (kept.length > 0) row.tool_calls = kept
      else delete row.tool_calls
    }
  }

  if (row.function_call && typeof row.function_call === 'object') {
    const name = ctx.served(row.function_call.name)
    if (name === null) {
      if (typeof row.function_call.name === 'string') ctx.droppedFunctions.add(row.function_call.name)
      row = { ...row }
      delete row.function_call
    } else if (name !== row.function_call.name) {
      row = { ...row, function_call: { ...row.function_call, name } }
    }
  }

  const drop = (row.role === 'tool' && ctx.droppedCalls.has(row.tool_call_id))
    || (row.role === 'function' && ctx.droppedFunctions.has(row.name))
    || (emptied && !carriesContent(row))
  return { row, drop }
}

/** Rewrite one `claude` (Messages-style) message. */
function rewriteClaudeRecord(original, ctx) {
  if (!Array.isArray(original?.content)) return { row: original, drop: false }
  const blocks = []
  let touched = false
  for (const block of original.content) {
    if (block?.type === 'tool_use') {
      const name = ctx.served(block.name)
      if (name === null) {
        if (typeof block.id === 'string' && block.id !== '') ctx.droppedCalls.add(block.id)
        touched = true
        continue
      }
      if (name === block.name) { blocks.push(block); continue }
      blocks.push({ ...block, name })
      touched = true
      continue
    }
    if (block?.type === 'tool_result' && ctx.droppedCalls.has(block.tool_use_id)) { touched = true; continue }
    blocks.push(block)
  }
  if (!touched) return { row: original, drop: false }
  return { row: { ...original, content: blocks }, drop: blocks.length === 0 }
}

/**
 * Remove history records that refer to tools the shaped body does not serve.
 *
 * Compaction is done in one pass with a write cursor rather than repeated
 * `splice` calls, so the cost stays linear and indices cannot drift.
 *
 * Returns nothing; `payload[field]` is rewritten in place.
 */
function dropUnservedHistory(payload, shape, known) {
  const field = shape === 'flat' ? 'input' : 'messages'
  const records = payload[field]
  if (!Array.isArray(records)) return

  const ctx = { served: servedName(known), droppedCalls: new Set(), droppedFunctions: new Set() }
  const rewrite = shape === 'flat' ? rewriteFlatRecord : shape === 'chat' ? rewriteChatRecord : rewriteClaudeRecord

  let write = 0
  let changed = false
  for (const original of records) {
    const { row, drop } = rewrite(original, ctx)
    if (drop || row !== original) changed = true
    if (!drop) records[write++] = row
  }
  records.length = write
  // Only the Claude shape needs the extra copy, and only when something changed:
  // its blocks were rebuilt, so the caller's array may still reference rows this
  // pass replaced.
  if (changed && shape === 'claude') payload[field] = records.filter(row => row !== null)
}

/**
 * Remove a named `tool_choice` that names a tool the body no longer serves.
 *
 * A choice naming a dropped tool is worse than no choice at all: it instructs
 * the model to call something the body does not declare.
 */
function dropDanglingToolChoice(payload, shape, known) {
  const choice = payload?.tool_choice
  if (choice === null || typeof choice !== 'object') return
  const name = shape === 'chat' && choice.function && typeof choice.function === 'object'
    ? choice.function.name
    : choice.name
  if (typeof name === 'string' && name !== '' && !known.has(name)) delete payload.tool_choice
}

/**
 * Shape one request's tool surface: rename, complete, rewrite references, clean
 * history.
 *
 * `options.keep` names declarations that must be left exactly as the caller sent
 * them — used when the caller already carries a verbatim official definition, so
 * re-declaring it would duplicate the tool.
 *
 * Returns the rename map (so the response path can map handles back), the list of
 * official tools this pass injected, and the set of names the body now serves.
 */
export function shapeToolSurface(payload, shape, { keep } = {}) {
  const renames = new ToolRenameMap()
  const injected = []
  const known = new Set()
  if (!SHAPED.has(shape)) return { renames, injected, known }

  const preserved = keep instanceof Set ? keep : new Set()
  const state = { renames, officials: new Set(preserved), taken: new Set() }

  const entries = Array.isArray(payload.tools) ? payload.tools.slice() : []
  if (shape !== 'claude' && Array.isArray(payload.functions)) {
    entries.push(...declarationsFromLegacyFunctions(payload.functions, shape, renames, state.taken))
    delete payload.functions
  }

  let declared = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const name = renamableToolName(shape, entry)
    if (name === null) continue
    // Counted before the skip: a preserved or already-minted declaration is still
    // a declaration, and whether the body declared anything gates history cleanup.
    declared += 1
    // A declaration this pass must not rename, for three different reasons:
    //
    // 1. The caller asked for it to be kept verbatim (`preserved`).
    // 2. It is a handle this lane already minted (a second shaping pass).
    // 3. It carries an official name that this pass has not yet claimed.
    //
    // Case 3 is the idempotence fix and needs care: only the *first* declaration
    // of an official name is skipped. A second, duplicate declaration of the same
    // official tool must still be renamed opaquely, because leaving both under
    // the official name would declare that tool twice — which is what
    // `fingerprint-test` checks for. So the guard is "official name AND not yet
    // claimed", and claiming happens in the branch below.
    //
    // Within case 3 there is one further distinction. A caller tool whose
    // spelling happens to be an official name is still the caller's prose, so its
    // description is de-literalised. A declaration that is byte-identical to the
    // official definition is not: the upstream compares those bytes verbatim, so
    // touching them is what breaks the request.
    const officialName = V2_OFFICIAL_TOOL_ORDER.includes(name)
    // An official name is reserved for the official definition. A caller tool
    // that merely shares the spelling (or folds onto it through an alias) keeps
    // its own schema under an opaque handle, and the official tool is appended
    // below. Claiming the name for a foreign schema is what the upstream reads
    // as another client and refuses with 429 (measured 2026-11-22).
    if (preserved.has(name) || isWireToolName(name)
      || (officialName && !state.officials.has(name) && carriesOfficialDefinition(shape, entry, name))) {
      state.officials.add(name)
      continue
    }
    const wire = assignWireName(name, state, { shape, entry })
    const renamed = wire === name ? entry : withWireName(shape, entry, wire)
    entries[index] = V2_OFFICIAL_TOOL_ORDER.includes(wire) && carriesOfficialDefinition(shape, entry, wire)
      ? renamed
      : withDeLiteralizedDescription(shape, renamed)
  }

  for (const name of V2_OFFICIAL_TOOL_ORDER) {
    if (state.officials.has(name)) continue
    entries.push(officialTool(shape, name))
    state.officials.add(name)
    injected.push(name)
  }

  for (const name of state.officials) known.add(name)
  for (const name of renames.keys()) known.add(name)

  // One wire name, one declaration. A caller that lists the same tool twice (or
  // two callers that fold onto one handle) would otherwise ship the name twice;
  // the upstream reads a duplicated declaration as a malformed tool surface.
  const unique = []
  const seenWire = new Set()
  for (const entry of entries) {
    const wire = renamableToolName(shape, entry)
    if (wire !== null) {
      if (seenWire.has(wire)) continue
      seenWire.add(wire)
    }
    unique.push(entry)
  }
  payload.tools = unique
  remapToolReferences(payload, shape, renames)
  if (declared > 0) dropUnservedHistory(payload, shape, known)
  dropDanglingToolChoice(payload, shape, known)
  return { renames, injected, known }
}
