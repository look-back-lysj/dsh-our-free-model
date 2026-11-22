/**
 * Turn the fetched upstream OpenCode sources into this plugin's asset files.
 *
 * The free tier fingerprints the shaped request: the official system prompt and
 * the official tool definitions (description AND parameter schema, character for
 * character). `scripts/fetch-opencode-assets.mjs` downloads the sources; this
 * script extracts them into `src/o2a/assets/`.
 *
 * Why a real extractor instead of a checked-in copy: a hand-copied asset drifts
 * silently the moment someone tidies a description, and the failure surfaces as
 * an upstream 429 in production rather than as a diff. Reading the upstream
 * schema keeps the asset and its provenance in one place.
 *
 * The upstream schemas are Effect `Schema` values, which cannot be evaluated
 * here (the `effect` package is not a dependency of this repo, and evaluating
 * upstream module code in the build would be far worse than parsing it). So this
 * file implements a deliberately narrow evaluator: it understands exactly the
 * expression shapes the 13 tool schemas use, and it **throws** on anything else
 * instead of guessing. A tool that changes shape upstream breaks the build, which
 * is the correct outcome — a guessed schema is a silent 429.
 *
 * Usage:
 *   node scripts/build-o2a-assets.mjs           # write the assets
 *   node scripts/build-o2a-assets.mjs --check   # fail if the assets are stale
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const checking = process.argv.includes('--check')

/** Must match `V2_CLIENT_VERSION` in src/o2a/version.js and the fetch script. */
const TAG = 'v2.2.3'
/**
 * The year the pinned tag was cut. One tool description embeds
 * `${new Date().getFullYear()}`; the client that produced the captured body
 * resolved it at its own build time, so the asset uses that year rather than
 * today's — the value must not drift as the repository ages.
 */
const SOURCE_YEAR = 2026
const sourceDir = path.join(root, '.build-cache', `opencode-${TAG}`)
const assetDir = path.join(root, 'src', 'o2a', 'assets')

/**
 * The 13 tools the official v2 client ships on `/inference`, in the order the
 * client declares them. The order is part of the wire bytes.
 */
const TOOLS = [
  ['read', 'tool/plugin/read.ts'],
  ['shell', 'tool/plugin/shell.ts'],
  ['edit', 'tool/plugin/edit.ts'],
  ['glob', 'tool/plugin/glob.ts'],
  ['grep', 'tool/plugin/grep.ts'],
  ['write', 'tool/plugin/write.ts'],
  ['patch', 'tool/plugin/patch.ts'],
  ['webfetch', 'tool/plugin/webfetch.ts'],
  ['websearch', 'tool/plugin/websearch.ts'],
  ['question', 'tool/plugin/question.ts'],
  ['skill', 'tool/plugin/skill.ts'],
  ['subagent', 'tool/plugin/subagent.ts'],
  ['todowrite', 'tool/plugin/todo.ts'],
]

const read = relative => {
  const file = path.join(sourceDir, relative)
  if (!fs.existsSync(file)) throw new Error(`missing source ${relative} — run scripts/fetch-opencode-assets.mjs first`)
  return fs.readFileSync(file, 'utf8')
}

// ── a tiny expression reader ────────────────────────────────────────────────
//
// Everything below operates on source TEXT. It is not a JavaScript parser: it
// walks balanced brackets and string literals so it can find the arguments of
// the handful of calls the schemas are built from.

/** Index just past the string literal starting at `at` (a quote). */
function skipString(text, at) {
  const quote = text[at]
  let index = at + 1
  while (index < text.length) {
    if (text[index] === '\\') { index += 2; continue }
    if (text[index] === quote) return index + 1
    index += 1
  }
  throw new Error('unterminated string literal')
}

/**
 * Index of the bracket that closes the one at `at`, skipping strings and
 * comments. `open`/`close` are the pair to balance.
 */
function matchBracket(text, at, open = '(', close = ')') {
  let depth = 0
  let index = at
  while (index < text.length) {
    const char = text[index]
    if (char === '"' || char === "'" || char === '`') { index = skipString(text, index); continue }
    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index)
      index = newline === -1 ? text.length : newline + 1
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index
    }
    index += 1
  }
  throw new Error(`unbalanced ${open}${close}`)
}

/** Split `text` on top-level commas (strings and nested brackets respected). */
function splitTopLevel(text) {
  const parts = []
  let start = 0
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"' || char === "'" || char === '`') { index = skipString(text, index); continue }
    if ('([{'.includes(char)) { index = matchBracket(text, index, char, { '(': ')', '[': ']', '{': '}' }[char]) + 1; continue }
    if (char === ',') { parts.push(text.slice(start, index)); start = index + 1 }
    index += 1
  }
  const tail = text.slice(start)
  if (tail.trim() !== '') parts.push(tail)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

/**
 * Evaluate one JS string literal (single, double, or template) to its value.
 *
 * A template literal may interpolate a numeric constant this build knows
 * (`${DEFAULT_TIMEOUT_MS}`, `${FileSystem.DEFAULT_SEARCH_LIMIT}`). The upstream
 * client renders those at build time, so the asset must carry the number. An
 * interpolation of anything else — notably the runtime `${OS}`/`${shell}` of the
 * shell description — is rejected: those are rendered per request by the plugin,
 * and `literal()` is never called on them.
 */
function literal(node, constants) {
  const text = node.trim()
  const quote = text[0]
  if (!['"', "'", '`'].includes(quote) || skipString(text, 0) !== text.length) {
    throw new Error(`not a single string literal: ${text.slice(0, 60)}`)
  }
  const body = text.slice(1, -1)
  const unescape = value => value.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, escape) => {
    if (escape.startsWith('u{')) return String.fromCodePoint(parseInt(escape.slice(2, -1), 16))
    if (escape[0] === 'u') return String.fromCharCode(parseInt(escape.slice(1), 16))
    if (escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16))
    return { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"', '`': '`', 0: '\0' }[escape] ?? escape
  })
  if (quote !== '`') return unescape(body)
  // Template: substitute known numeric constants and keep runtime placeholders.
  // `keepPlaceholders` marks the shell sentence, whose `${OS}`/`${shell}` are
  // rendered by the plugin at request time and must survive this build verbatim.
  if (constants === null) return unescape(body.replace(/\\`/g, '`'))
  const known = constants ?? CONSTANTS
  return body.replace(/\$\{([^}]*)\}/g, (_, expression) => {
    const key = expression.trim()
    const value = known[key]
    if (value !== undefined) return String(value)
    if (key === 'new Date().getFullYear()') return String(SOURCE_YEAR)
    throw new Error(`template interpolates a value this build cannot resolve: \${${key}}`)
  }).replace(/\\`/g, '`')
}

/** Find `export const <name> = <expr>` and return the expression text. */
function exportedExpression(text, name) {
  const pattern = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*`, 'g')
  const found = pattern.exec(text)
  if (found === null) return undefined
  const start = found.index + found[0].length
  return expressionAt(text, start)
}

/** Find a non-exported `const <name> = <expr>` in the same file. */
function localExpression(text, name) {
  const pattern = new RegExp(`(?:^|\\n)\\s*const\\s+${name}\\s*=\\s*`, 'g')
  const found = pattern.exec(text)
  if (found === null) return undefined
  const start = found.index + found[0].length
  return expressionAt(text, start)
}

/** Slice one expression starting at `start` (up to a top-level `;` or newline-break). */
function expressionAt(text, start) {
  let index = start
  let sawValue = false
  while (index < text.length) {
    const char = text[index]
    if (char === '"' || char === "'" || char === '`') { index = skipString(text, index); sawValue = true; continue }
    if ('([{'.includes(char)) {
      index = matchBracket(text, index, char, { '(': ')', '[': ']', '{': '}' }[char]) + 1
      sawValue = true
      continue
    }
    // A `;` at depth 0 always ends the expression.
    if (char === ';') return text.slice(start, index)
    // A line break ends it only when the expression is complete AND the next
    // line does not continue it with `.`, `?` or `:` — that is what keeps a
    // multi-line `.join("\n")` chain in one piece while stopping at the comma
    // that separates two properties.
    if (char === '\n' && sawValue) {
      const rest = text.slice(index).replace(/^\n\s*/, '')
      if (!rest.startsWith('.') && !rest.startsWith('?') && !rest.startsWith(':') && !rest.startsWith(',')) {
        return text.slice(start, index)
      }
    }
    // A top-level comma closes the property being read.
    if (char === ',' && sawValue) return text.slice(start, index)
    if (!/\s/.test(char)) sawValue = true
    index += 1
  }
  return text.slice(start)
}

// ── the schema evaluator ────────────────────────────────────────────────────

/**
 * A minimal JSON Schema builder for the Effect Schema subset these tools use.
 *
 * Every branch corresponds to a construct that actually appears in the 13 tool
 * inputs. An unknown construct throws; the message names the expression so the
 * fix is a small, obvious edit here rather than a silent bad asset.
 */
function makeEvaluator({ constants, fragments, schemaFiles, local }) {
  /**
   * Resolve a bare identifier declared in the same file (`const LocationInput =
   * Schema.Struct({...})`), which `read` uses to alias its exported Input. One
   * level only: these files never chain local aliases.
   */
  function resolveLocal(text) {
    if (local === undefined) return undefined
    return exportedExpression(local, text) ?? localExpression(local, text)
  }

  const numberValue = expr => {
    const text = expr.trim()
    if (constants[text] !== undefined) return constants[text]
    // `2 * 60 * 1_000` and friends: evaluate arithmetic over integer literals.
    if (!/^[\d_\s*+\-/()]+$/.test(text)) throw new Error(`not an integer expression: ${text.slice(0, 60)}`)
    // eslint-disable-next-line no-new-func
    const value = Function(`"use strict";return (${text.replace(/_/g, '')})`)()
    if (!Number.isFinite(value)) throw new Error(`integer expression is not finite: ${text}`)
    return value
  }

  /** Resolve `<Module>.<Path>` or `<Module>.<Path>.fields.<key>` to an expression. */
  function resolveFragment(expr) {
    const text = expr.trim()
    const direct = fragments[text]
    if (direct !== undefined) return direct
    // `.fields.<key>` reads one field's schema out of a shared struct. The field
    // expression is what the tool's own `.annotate()` is layered onto, so the
    // base type (not the shared description) is what belongs here.
    const field = /^(.+)\.fields\.([A-Za-z_$][\w$]*)$/.exec(text)
    if (field !== null) {
      const parent = fragments[field[1]]
      if (parent === undefined) throw new Error(`unresolved schema reference: ${field[1]}`)
      return fieldExpression(parent, field[2])
    }
    const declared = resolveLocal(text)
    if (declared !== undefined) return declared
    throw new Error(`unresolved schema reference: ${text}`)
  }

  /** Pull one field's expression out of a `Schema.Struct({...})` literal. */
  function fieldExpression(structExpr, key) {
    const match = /^Schema\.Struct\s*\(/.exec(structExpr.trim())
    if (match === null) throw new Error(`not a Struct: ${structExpr.slice(0, 60)}`)
    const open = structExpr.indexOf('(', match.index)
    let body = structExpr.slice(open + 1, matchBracket(structExpr, open)).trim()
    if (body.startsWith('{') && matchBracket(body, 0, '{', '}') === body.length - 1) body = body.slice(1, -1)
    for (const field of splitTopLevel(body)) {
      const colon = field.indexOf(':')
      if (colon === -1) continue
      const name = field.slice(0, colon).trim()
      if (name === key) return field.slice(colon + 1).trim()
    }
    throw new Error(`field ${key} not found in the shared struct`)
  }

  /**
   * Split `expr` into its primary expression and the chain applied to it.
   *
   * `Schema.String.annotate(…)` and `FileSystem.GlobInput` are lexically
   * identical (identifier, dot, identifier), so the split is driven by the
   * method names that actually appear as chain segments. Every other dotted
   * identifier is part of the primary path.
   */
  const CHAIN_METHODS = new Set(['annotate', 'check', 'pipe', 'brand'])

  function splitChain(expr) {
    const text = expr.trim()
    // Scan at depth 0 only: a `.annotate()` inside `Schema.Struct({...})` belongs
    // to a field, not to the struct.
    const method = /\.([A-Za-z_$][\w$]*)\s*\(/g
    let splitAt = -1
    let index = 0
    while (index < text.length) {
      const char = text[index]
      if (char === '"' || char === "'" || char === '`') { index = skipString(text, index); continue }
      if ('([{'.includes(char)) {
        index = matchBracket(text, index, char, { '(': ')', '[': ']', '{': '}' }[char]) + 1
        continue
      }
      if (char === '.') {
        method.lastIndex = index
        const match = method.exec(text)
        if (match !== null && match.index === index && CHAIN_METHODS.has(match[1])) { splitAt = index; break }
      }
      index += 1
    }
    if (splitAt === -1) return { primary: text, segments: [] }

    const primary = text.slice(0, splitAt).trim()
    const segments = []
    index = splitAt
    const name = /[A-Za-z_$][\w$]*/g
    while (index < text.length) {
      if (/\s/.test(text[index])) { index += 1; continue }
      if (text[index] !== '.') throw new Error(`unexpected token in schema expression: ${text.slice(index, index + 40)}`)
      name.lastIndex = index + 1
      const match = name.exec(text)
      if (match === null || match.index !== index + 1) throw new Error(`bad chain segment: ${text.slice(index, index + 40)}`)
      index = name.lastIndex
      while (/\s/.test(text[index] ?? '')) index += 1
      if (text[index] !== '(') throw new Error(`chain segment .${match[0]} has no arguments: ${text.slice(index, index + 40)}`)
      const close = matchBracket(text, index)
      segments.push({ name: match[0], args: text.slice(index + 1, close) })
      index = close + 1
    }
    return { primary, segments }
  }

  /**
   * Evaluate a schema expression to JSON Schema.
   *
   * `context` carries what the enclosing `.annotate({ description })` needs; the
   * caller applies the description, because in the upstream source the
   * description is attached to the value, not the type.
   */
  function evaluate(rawExpr) {
    const { primary, segments } = splitChain(rawExpr)
    const annotations = []

    // Peel the chain from the outside in. `.annotate` carries the description,
    // `.check` carries the constraints, `.pipe` may mark the key optional, and
    // `.brand` is a no-op for JSON Schema.
    for (let position = segments.length - 1; position >= 0; position -= 1) {
      const { name, args } = segments[position]
      if (name === 'annotate') annotations.unshift(...readAnnotations(args))
      else if (name === 'check') annotations.unshift(...readChecks(args))
      else if (name === 'brand') continue
      else if (name === 'pipe') {
        if (/\boptional\b/.test(args)) annotations.unshift({ optional: true })
        // `.pipe(Schema.withDecodingDefaultKey(...))` and brand pipes only
        // affect decoding, not the wire shape the model sees.
      } else throw new Error(`unsupported chain method .${name}()`)
    }

    const result = evaluateBase(primary)
    return applyAnnotations(result, annotations)
  }

  /** `{ description: "..." }` or `{ identifier: "..." }`. */
  function readAnnotations(args) {
    const text = args.trim()
    if (!text.startsWith('{')) return []
    const out = []
    for (const entry of splitTopLevel(text.slice(1, matchBracket(text, 0, '{', '}')))) {
      const colon = entry.indexOf(':')
      if (colon === -1) throw new Error(`annotation is not a key/value pair: ${entry.slice(0, 60)}`)
      const key = entry.slice(0, colon).trim()
      const value = entry.slice(colon + 1).trim()
      if (key === 'description') out.push({ description: literal(value) })
      else if (key === 'identifier') out.push({ identifier: literal(value) })
      else if (key === 'message') out.push({ message: literal(value) })
      else throw new Error(`unsupported annotation key: ${key}`)
    }
    return out
  }

  /** `Schema.isMinLength(1, { message })`, `Schema.isGreaterThan(0)`, … */
  function readChecks(args) {
    const out = []
    for (const call of splitTopLevel(args)) {
      const match = /^Schema\.(\w+)\s*\(/.exec(call.trim())
      if (match === null) throw new Error(`unsupported check: ${call.slice(0, 60)}`)
      const open = call.indexOf('(', match.index)
      const inner = splitTopLevel(call.slice(open + 1, matchBracket(call, open)))
      const name = match[1]
      if (name === 'isMinLength') out.push({ minLength: numberValue(inner[0]) })
      else if (name === 'isGreaterThan') out.push({ exclusiveMinimum: numberValue(inner[0]) })
      else if (name === 'isGreaterThanOrEqualTo') out.push({ minimum: numberValue(inner[0]) })
      else if (name === 'isLessThanOrEqualTo') out.push({ maximum: numberValue(inner[0]) })
      else if (name === 'isNonEmpty') out.push({ minItems: 1 })
      else throw new Error(`unsupported check Schema.${name}`)
    }
    return out
  }

  function applyAnnotations(schema, annotations) {
    let out = { ...schema }
    for (const annotation of annotations) {
      if (annotation.optional === true) continue // handled by the parent Struct
      if (annotation.description !== undefined) out.description = annotation.description
      if (annotation.minLength !== undefined) out.minLength = annotation.minLength
      if (annotation.exclusiveMinimum !== undefined) out.exclusiveMinimum = annotation.exclusiveMinimum
      if (annotation.minimum !== undefined) out.minimum = annotation.minimum
      if (annotation.maximum !== undefined) out.maximum = annotation.maximum
      if (annotation.minItems !== undefined) out.minItems = annotation.minItems
      if (annotation.identifier !== undefined) out['x-identifier'] = annotation.identifier
    }
    return out
  }

  /** Evaluate an expression with no `.pipe`/`.annotate` layers left. */
  function evaluateBase(expr) {
    const text = expr.trim()

    if (text === 'Schema.String') return { type: 'string' }
    if (text === 'Schema.Boolean') return { type: 'boolean' }
    if (text === 'Schema.Number' || text === 'Schema.Finite') return { type: 'number' }
    if (text === 'Schema.Int') return { type: 'integer' }
    if (text === 'PositiveInt') return { type: 'integer', exclusiveMinimum: 0 }
    if (text === 'NonNegativeInt') return { type: 'integer', minimum: 0 }
    if (text === 'RelativePath' || text === 'AbsolutePath') return { type: 'string' }
    if (text === 'Timeout') return { type: 'number', exclusiveMinimum: 0, maximum: constants.MAX_TIMEOUT_SECONDS }

    const literals = /^Schema\.Literals?\s*\(/.exec(text)
    if (literals !== null) {
      const open = literals.index + literals[0].length - 1
      const inner = text.slice(open + 1, matchBracket(text, open))
      const values = inner.trim().startsWith('[')
        ? splitTopLevel(inner.trim().slice(1, matchBracket(inner.trim(), 0, '[', ']'))).map(literal)
        : [literal(inner)]
      return { enum: values }
    }

    const optionalKey = /^Schema\.optionalKey\s*\(/.exec(text)
    if (optionalKey !== null) {
      const open = optionalKey.index + optionalKey[0].length - 1
      return { ...evaluate(text.slice(open + 1, matchBracket(text, open))), 'x-optional': true }
    }

    const array = /^Schema\.Array\s*\(/.exec(text)
    if (array !== null) {
      const open = array.index + array[0].length - 1
      return { type: 'array', items: evaluate(text.slice(open + 1, matchBracket(text, open))) }
    }

    const struct = /^Schema\.Struct\s*\(/.exec(text)
    if (struct !== null) {
      const open = struct.index + struct[0].length - 1
      return structBody(text.slice(open + 1, matchBracket(text, open)))
    }

    // A shared fragment: `ReadToolFileSystem.PageInput`, `Skill.ID`, …
    return evaluate(resolveFragment(text))
  }

  /** `{ a: <schema>, ...Spread }` → an object schema with required/properties. */
  function structBody(body) {
    const properties = {}
    const required = []
    let text = body.trim()
    // `Schema.Struct({...})` hands over the braces; strip them so the field
    // splitter sees `a: x, b: y` rather than one bracket-balanced blob.
    if (text.startsWith('{') && matchBracket(text, 0, '{', '}') === text.length - 1) {
      text = text.slice(1, -1).trim()
    }
    if (text === '') return { type: 'object', properties, additionalProperties: false }
    for (const field of splitTopLevel(text)) {
      if (field.startsWith('...')) {
        // `...FileSystem.Content.fields` — spread a resolved fragment's fields.
        const spread = evaluate(resolveFragment(field.slice(3).trim().replace(/\.fields$/, '')))
        if (spread.type !== 'object') throw new Error(`spread of a non-object schema: ${field.slice(0, 60)}`)
        for (const [key, value] of Object.entries(spread.properties ?? {})) {
          properties[key] = value
          if (spread.required?.includes(key)) required.push(key)
        }
        continue
      }
      const colon = field.indexOf(':')
      if (colon === -1) throw new Error(`struct field is not a key/value pair: ${field.slice(0, 60)}`)
      const keyText = field.slice(0, colon).trim()
      const key = keyText.startsWith('"') || keyText.startsWith("'") ? literal(keyText) : keyText
      const value = evaluate(field.slice(colon + 1))
      const optional = value['x-optional'] === true
      delete value['x-optional']
      properties[key] = value
      if (!optional) required.push(key)
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    }
  }

  return { evaluate, structBody }
}

// ── schema fragments the tool inputs reference ──────────────────────────────

/**
 * The named sub-schemas the 13 tool inputs build on, mapped to their source
 * expressions. Kept explicit rather than auto-imported: the set is small, and a
 * new reference showing up is exactly the kind of change that should fail the
 * build loudly.
 */
const FRAGMENTS = {
  'ReadToolFileSystem.PageInput': 'Schema.Struct({ offset: Schema.optionalKey(NonNegativeInt), limit: Schema.optionalKey(NonNegativeInt) })',
  'FileSystem.GlobInput': 'Schema.Struct({ pattern: Schema.String, path: Schema.optionalKey(RelativePath), hidden: Schema.optionalKey(Schema.Boolean), limit: Schema.optionalKey(PositiveInt) })',
  'FileSystem.GrepInput': 'Schema.Struct({ pattern: Schema.String, path: Schema.optionalKey(RelativePath), include: Schema.optionalKey(Schema.String), literal: Schema.optionalKey(Schema.Boolean), caseSensitive: Schema.optionalKey(Schema.Boolean), limit: Schema.optionalKey(PositiveInt) })',
  'Skill.ID': 'Schema.String',
  'Question.Prompt': 'Schema.Struct({ question: Schema.String, header: Schema.String, options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })), multiple: Schema.optionalKey(Schema.Boolean) })',
  'SessionSchema.ID': 'Schema.String',
}

const CONSTANTS = {
  'DEFAULT_TIMEOUT_MS': 2 * 60 * 1000,
  'MAX_TIMEOUT_SECONDS': 120,
  'FileSystem.DEFAULT_SEARCH_LIMIT': 100,
}

// ── extraction ──────────────────────────────────────────────────────────────

const evaluator = makeEvaluator({ constants: CONSTANTS, fragments: FRAGMENTS })

/**
 * A fresh evaluator bound to one source file, so bare identifiers resolve
 * against that file's own `const` declarations.
 */
const evaluatorFor = text => makeEvaluator({ constants: CONSTANTS, fragments: FRAGMENTS, local: text })

/**
 * The description a tool declares. Two shapes upstream:
 *   - `description: "literal"` on the `editor.add({...})` call
 *   - `export const description = ["line", "line"].join("\n")` (or a template)
 *
 * `shell` interpolates `${OS}` and `${shell}`, which are runtime values; they are
 * preserved verbatim so the plugin renders them the same way the client does.
 */
function toolDescription(name, text) {
  // Two declaration shapes upstream:
  //   - `description: <expr>` inside `editor.add({...})` (the tool's own prose)
  //   - `export const description = <expr>` used as the shorthand `description,`
  // The exported form is checked first because the inline search would otherwise
  // latch onto an unrelated `description:` further down in the tool body (a form
  // field or a result mapping).
  let raw = exportedExpression(text, 'description')
  if (raw === undefined) {
    const base = text.indexOf('editor.add')
    const inline = base === -1 ? null : /\bdescription:\s*/.exec(text.slice(base))
    if (inline !== null) raw = expressionAt(text, base + inline.index + inline[0].length)
  }
  if (raw === undefined) throw new Error(`${name}: no description found`)
  const trimmed = raw.trim().replace(/,$/, '')

  // `description: description()` — the upstream builds the prose from an array
  // so it can drop one sentence when no shell is known. Reproduce that array.
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed)
  if (call !== null && !['Schema'].includes(call[1])) {
    return localFunctionDescription(name, text, call[1], trimmed.slice(trimmed.indexOf('(') + 1, matchBracket(trimmed, trimmed.indexOf('('))))
  }

  // `[...].join("\n")`
  const join = /^\[([\s\S]*)\]\.join\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)$/.exec(trimmed)
  if (join !== null) {
    const separator = literal(join[2])
    return splitTopLevel(join[1]).map(item => literal(item)).join(separator)
  }
  // A bare identifier naming a local constant (`description: DESCRIPTION`), or
  // one imported from a `.txt` file (`import DESCRIPTION from "../patch.txt"`).
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const imported = new RegExp(`import\\s+${trimmed}\\s+from\\s+["']([^"']+\\.txt)["']`).exec(text)
    if (imported !== null) {
      const fromPlugin = `packages/core/src/tool/plugin/${imported[1]}`
      const normalized = path.posix.normalize(fromPlugin)
      return read(normalized)
    }
    const declared = localExpression(text, trimmed) ?? exportedExpression(text, trimmed)
    if (declared === undefined) throw new Error(`${name}: description constant ${trimmed} not found`)
    return resolveDescriptionExpression(name, text, declared)
  }
  return literal(trimmed)
}

/** Evaluate a constant's expression the same way an inline description is read. */
function resolveDescriptionExpression(name, text, expression) {
  const trimmed = expression.trim().replace(/,$/, '')
  const join = /^\[([\s\S]*)\]\.join\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)$/.exec(trimmed)
  if (join !== null) {
    const separator = literal(join[2])
    return splitTopLevel(join[1]).map(item => literal(item)).join(separator)
  }
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed)
  if (call !== null) {
    return localFunctionDescription(name, text, call[1], trimmed.slice(trimmed.indexOf('(') + 1, matchBracket(trimmed, trimmed.indexOf('('))))
  }
  return literal(trimmed)
}

/**
 * Evaluate a local `const description = (shell?: string) => [...].join(" ")`.
 *
 * The array may carry a conditional spread (`...(shell ? [...] : [])`). This is
 * evaluated with the shell argument ABSENT — the same state the client is in when
 * it registers the tool — so the runtime `${OS}`/`${shell}` sentence is dropped
 * from the stored asset and re-added by the plugin at request time.
 */
function localFunctionDescription(name, text, functionName, args) {
  const declaration = new RegExp(`const\\s+${functionName}\\s*=\\s*[^=]*=>\\s*`).exec(text)
  if (declaration === null) throw new Error(`${name}: description function ${functionName} not found`)
  const body = expressionAt(text, declaration.index + declaration[0].length).trim()
  const join = /^\[([\s\S]*)\]\.join\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)$/.exec(body)
  if (join === null) throw new Error(`${name}: description function body is not an array join`)
  const separator = literal(join[2])
  const hasArgument = args.trim() !== ''
  const pieces = []
  for (const item of splitTopLevel(join[1])) {
    if (item.startsWith('...')) {
      // A conditional spread is only ever the optional shell sentence here. The
      // client appends it once it knows which shell it has, so the asset keeps
      // the sentence as a placeholder and the plugin renders it per request
      // (`v2ShellDescription`). Dropping it would ship a description the
      // upstream client never sends on any platform.
      const conditional = /^\.\.\.\s*\(\s*(\w+)\s*\?/.exec(item)
      if (conditional === null) throw new Error(`${name}: unsupported spread in description: ${item.slice(0, 60)}`)
      const taken = /\[([\s\S]*?)\]\s*:/.exec(item)
      if (taken === null) throw new Error(`${name}: unsupported conditional spread: ${item.slice(0, 60)}`)
      for (const branch of splitTopLevel(taken[1])) pieces.push(literal(branch, null))
      continue
    }
    pieces.push(literal(item))
  }
  return pieces.join(separator)
}

const assets = {}
const provenance = {}

for (const [name, relative] of TOOLS) {
  const source = `packages/core/src/${relative}`
  const text = read(source)
  const inputExpr = exportedExpression(text, 'Input')
  if (inputExpr === undefined) throw new Error(`${name}: no exported Input schema`)
  const schema = evaluatorFor(text).evaluate(inputExpr)
  const parameters = {
    type: 'object',
    properties: schema.properties ?? {},
    ...(schema.required === undefined ? {} : { required: schema.required }),
    additionalProperties: false,
  }
  assets[name] = { description: toolDescription(name, text), parameters }
  provenance[source] = shaOf(source)
}

function shaOf(relative) {
  const file = path.join(sourceDir, `${relative}.sha`)
  if (!fs.existsSync(file)) throw new Error(`missing sha record for ${relative}`)
  return fs.readFileSync(file, 'utf8').trim()
}

// ── system prompt ───────────────────────────────────────────────────────────

const promptFile = 'packages/core/src/session/runner/prompt/system.txt'
const promptText = read(promptFile)
if (!promptText.includes('${OPENCODE_TOOL_GUIDANCE}')) {
  // The placeholder is what the client substitutes its per-tool guidance into;
  // without it the rendered prompt silently loses three instructions.
  throw new Error(`${promptFile}: the ${'${OPENCODE_TOOL_GUIDANCE}'} placeholder is gone; the upstream prompt changed shape`)
}
provenance[promptFile] = shaOf(promptFile)

// ── write ───────────────────────────────────────────────────────────────────

const banner = tool => `/* eslint-disable */
/**
 * GENERATED — do not edit by hand.
 *
 * Source: ${'sst/opencode'} tag ${TAG} (MIT). Regenerate with:
 *   node scripts/fetch-opencode-assets.mjs && node scripts/build-o2a-assets.mjs
 * Provenance and per-file digests: docs/opencode-assets.md
 *
 * The free tier fingerprints this content byte for byte, so any edit here that
 * the upstream client does not also make turns into a 429 FreeUsageLimitError.
 */
`

const jsonBody = `${JSON.stringify(assets, null, 2)}\n`
const promptBody = promptText

function write(relative, body) {
  const target = path.join(root, relative)
  const bytes = Buffer.from(body, 'utf8')
  if (checking) {
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) {
      throw new Error(`${relative} is stale — run node scripts/build-o2a-assets.mjs`)
    }
    return
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes)
}

write('src/o2a/assets/ofm-tool-contracts.json', jsonBody)
write('src/o2a/assets/ofm-agent-context.txt', promptBody)

if (!checking) {
  // Provenance goes to docs/, not to the published asset directory: the release
  // manifest has a hard file ceiling, and the digests only matter to reviewers.
  const rows = Object.entries(provenance).sort(([a], [b]) => a.localeCompare(b))
  const doc = `# OpenCode official assets — provenance

The free lane must reproduce the official OpenCode client's request body byte for
byte: the system prompt and the 13 tool definitions (description **and** parameter
schema). The free tier fingerprints both, and a body that differs is answered with
\`429 FreeUsageLimitError\` rather than a shape error — which is why a rewritten
description surfaces as "the quota is exhausted" and sends people looking in the
wrong place.

## Source

| | |
| --- | --- |
| Repository | \`sst/opencode\` (MIT) |
| Tag | \`${TAG}\` |
| Client version this lane reports | \`${TAG.replace(/^v/, '')}\` (\`V2_CLIENT_VERSION\` in \`src/o2a/version.js\`) |
| Generated | \`node scripts/fetch-opencode-assets.mjs && node scripts/build-o2a-assets.mjs\` |

The tag is pinned rather than following \`dev\` on purpose: the fingerprint is a
property of one released client, and tracking a moving branch would make the
asset change without a corresponding decision.

## Files read

| Path | Blob SHA |
| --- | --- |
${rows.map(([file, sha]) => `| \`${file}\` | \`${sha}\` |`).join('\n')}

## What the builder does

\`scripts/build-o2a-assets.mjs\` evaluates the Effect \`Schema\` expressions those
files declare and writes two assets:

- \`src/o2a/assets/ofm-tool-contracts.json\` — name → \`{ description, parameters }\`
  for all 13 tools, in declaration order.
- \`src/o2a/assets/ofm-agent-context.txt\` — the system prompt verbatim, keeping the
  \`\${OPENCODE_TOOL_GUIDANCE}\` placeholder the client fills with its per-tool
  instructions.

The evaluator understands only the expression shapes these schemas use and throws
on anything else. A schema change upstream therefore fails the build instead of
silently producing a body the upstream rejects.

## Runtime rendering

Two values in the assets are templates, rendered per request:

- \`\${OPENCODE_TOOL_GUIDANCE}\` in the system prompt — replaced by the guidance
  lines for \`shell\`, \`write\` and \`edit\` when the body declares those tools
  (\`packages/core/src/session/system-prompt.ts\`).
- \`\${OS}\` and \`\${shell}\` in the \`shell\` tool description — \`OS\` maps
  \`win32\`→\`Windows\`, \`darwin\`→\`macOS\`, \`linux\`→\`Linux\`; \`shell\` is the
  name of the compat-priority shell (\`packages/core/src/shell/select.ts\`), which
  is \`powershell\`-family on Windows and \`bash\`/\`zsh\` elsewhere.
`
  write('docs/opencode-assets.md', doc)
}

console.log(`${checking ? 'checked' : 'wrote'} src/o2a/assets/ofm-tool-contracts.json (${Object.keys(assets).length} tools)`)
console.log(`${checking ? 'checked' : 'wrote'} src/o2a/assets/ofm-agent-context.txt (${promptText.length} B)`)
