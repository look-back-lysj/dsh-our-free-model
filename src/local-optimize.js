/**
 * Local answers for housekeeping requests the agent client makes about itself.
 *
 * ## The problem this solves
 *
 * An agent client asks its provider several questions whose answers are already
 * present in the request body: "is my quota still good", "what is the prefix of
 * this command", "give this conversation a title", "suggest what I type next",
 * "which paths does this command touch". Forwarding one of those upstream spends
 * a real completion from a metered lane to compute something the body already
 * states.
 *
 * Each detector below recognises one such request **by its shape** and returns
 * the answer locally. A request that does not match is left completely alone —
 * the cost of a wrong match is a fabricated answer to a real question, so every
 * detector is deliberately narrow and the near-miss is tested alongside the hit.
 *
 * ## Layout
 *
 * {@link readFacts} pulls the handful of properties the detectors need off the
 * body once. Each detector then declares an `id` and a `match` function over
 * those facts, and {@link OPTIMIZATIONS} fixes the order they are tried in. That
 * order is cheapest-and-most-specific first, and it is observable behaviour:
 * a body that could match two detectors always resolves to the earlier one, so
 * reordering the list changes what the product answers.
 *
 * Nothing here executes a command, reads a file or opens a socket. The mocks are
 * pure functions from request shape to text.
 *
 * @module src/local-optimize
 */

import { randomUUID } from 'node:crypto'

/** Commands where the second word names the operation, so both words form the prefix. */
const SUBCOMMAND_TAKING = new Set(['git', 'npm', 'docker', 'kubectl', 'cargo', 'go', 'pip', 'yarn'])

/** Commands whose non-flag arguments are all file paths. */
const FILE_READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'type'])

/** `grep` flags that consume the following word as their value rather than as a path. */
const GREP_VALUE_FLAGS = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '--regexp'])

/** `grep` flags that mean the pattern was supplied explicitly, so no path is displaced. */
const GREP_PATTERN_FLAGS = new Set(['-e', '-f', '--regexp'])

/** `NAME=value` in front of the command; not part of the command itself. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[^\n]*$/

/** Horizontal and vertical whitespace, as the shell splits on. */
const BLANK = /[ \t\n\r\f\v]/

const EMPTY_FILEPATHS = '<filepaths>\n</filepaths>'

/** Concatenate the text of a string or a content-block array; anything else is empty. */
function textOf(value) {
  if (typeof value === 'string') return value
  let result = ''
  if (Array.isArray(value)) {
    for (const item of value) if (typeof item?.text === 'string') result += item.text
  }
  return result
}

/**
 * Split a command line into words the way a POSIX shell would for the subset that
 * appears in these requests.
 *
 * Returns `null` for an unterminated quote rather than guessing, because the two
 * callers want different things from malformed input: the prefix mock still has
 * a usable first word, while the filepath mock must not invent paths. Each
 * caller decides; this function only reports.
 *
 * Handles three quoting cases: single quotes (everything literal), double quotes
 * (backslash escapes only before `"`, `\`, `$` and a backtick), and unquoted
 * backslash escapes only before whitespace or a quote.
 */
function splitCommandWords(value) {
  if (!/[\\'"]/.test(value)) return value.match(/[^ \t\n\r\f\v]+/g) ?? []
  const words = []
  let token = ''
  let quote = ''
  let started = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const next = value[index + 1]
    if (quote !== '' && char === quote) { quote = ''; continue }
    if (quote === '' && BLANK.test(char)) {
      if (started) words.push(token)
      token = ''
      started = false
      continue
    }
    started = true
    if (quote === '' && (char === "'" || char === '"')) { quote = char; continue }
    const escapes = quote === '"'
      ? next !== undefined && '"\\$`'.includes(next)
      : quote === '' && next !== undefined && /[ \t\n\r\f\v'"]/.test(next)
    if (char === '\\' && escapes) { token += next; index += 1 } else token += char
  }
  if (quote !== '') return null
  if (started) words.push(token)
  return words
}

/** Index of the first word that is not a leading `NAME=value` assignment. */
function commandStart(words) {
  let index = 0
  while (index < words.length && ENV_ASSIGNMENT.test(words[index])) index += 1
  return index
}

/** The last path segment of an executable, lowercased, so `/usr/bin/CAT` is `cat`. */
function executableName(word) {
  return word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).toLowerCase()
}

/**
 * The prefix of a command line: what a permission prompt shows the user.
 *
 * A `git status --short` becomes `git status` because the subcommand is the
 * part that matters; `ls -la` becomes `ls` because `-la` is a flag, not an
 * operation. A command substitution is reported rather than evaluated — this
 * module must never be the thing that runs `$(...)`.
 */
export function extractCommandPrefix(command) {
  const text = typeof command === 'string' ? command : ''
  if (text.includes('`') || text.includes('$(')) return 'command_injection_detected'
  const parsed = splitCommandWords(text)
  const words = parsed ?? text.match(/\S+/g) ?? []
  const start = commandStart(words)
  if (start === words.length) return 'none'
  const first = words[start]
  const second = words[start + 1]
  // An unterminated quote leaves no reliable second word, so report only the first.
  if (parsed === null) return first
  if (SUBCOMMAND_TAKING.has(first) && second !== undefined) {
    return second.startsWith('-') ? first : `${first} ${second}`
  }
  return words.slice(0, start + 1).join(' ')
}

/**
 * The paths a command reads or writes, rendered as the `<filepaths>` block the
 * client expects.
 *
 * Only the two command families where the answer is unambiguous are handled:
 * readers, whose non-flag arguments are paths, and `grep`, whose arguments are a
 * pattern plus paths. Anything else — `ls`, `find`, a build tool — yields the
 * empty block, which is still a correct and cheaper answer than a round trip.
 */
export function extractFilepathsFromCommand(command, output) {
  const words = splitCommandWords(typeof command === 'string' ? command : '')
  if (words === null) return EMPTY_FILEPATHS
  const start = commandStart(words)
  if (start === words.length) return EMPTY_FILEPATHS
  const name = executableName(words[start])
  const paths = []
  if (FILE_READERS.has(name)) {
    for (let index = start + 1; index < words.length; index += 1) {
      if (!words[index].startsWith('-')) paths.push(words[index])
    }
  } else if (name === 'grep') {
    let patternGiven = false
    for (let index = start + 1; index < words.length; index += 1) {
      const word = words[index]
      if (!word.startsWith('-')) { paths.push(word); continue }
      if (GREP_PATTERN_FLAGS.has(word) || word.startsWith('--regexp=')) patternGiven = true
      if (GREP_VALUE_FLAGS.has(word)) index += 1
    }
    // Without an explicit pattern flag the first non-flag word is the pattern,
    // not a path, so drop it.
    if (!patternGiven) paths.shift()
  }
  return paths.length > 0 ? `<filepaths>\n${paths.join('\n')}\n</filepaths>` : EMPTY_FILEPATHS
}

/**
 * Everything the detectors read off a request, computed once.
 *
 * `onlyTurn` is the text of the single non-system turn, or `null` when the body
 * carries zero or several — which is how "this is a one-shot housekeeping call,
 * not a conversation" is expressed. `hasTools` collapses an absent, empty and
 * present tool list into a boolean, because a declared tool means the client
 * expects to act, and no local mock may answer for it.
 */
function readFacts(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  const systemTexts = []
  const topLevel = textOf(request?.system)
  if (topLevel) systemTexts.push(topLevel)
  let conversational = 0
  let single
  let suggestionMarked = false
  for (const message of messages) {
    if (message?.role === 'system') {
      const content = textOf(message.content)
      if (content) systemTexts.push(content)
      continue
    }
    conversational += 1
    if (message?.role !== 'user') continue
    single = message
    if (textOf(message.content).includes('[SUGGESTION MODE:')) suggestionMarked = true
  }
  return {
    onlyTurn: conversational === 1 && single ? textOf(single.content) : null,
    system: systemTexts.join('\n').toLowerCase(),
    hasTools: Array.isArray(request?.tools) ? request.tools.length > 0 : Boolean(request?.tools),
    suggestionMarked,
    maxTokens: request?.max_tokens,
  }
}

/** Does the system text read like a title-generation instruction? */
function asksForTitle(system) {
  if (!system.includes('title')) return false
  if (system.includes('sentence-case title')) return true
  return system.includes('return json')
    && system.includes('field')
    && (system.includes('coding session') || system.includes('this session'))
}

/** Does either the turn or the system text ask for a `<filepaths>` extraction? */
function asksForFilepaths(turn, system) {
  if (turn.toLowerCase().includes('filepaths')) return true
  return system.includes('extract any file paths') || system.includes('file paths that this command')
}

/**
 * The detectors, in evaluation order.
 *
 * Each entry returns `{ kind, text, usage }` on a match and `null` otherwise.
 * The order in this array is the product's behaviour, not an implementation
 * detail — see the module comment.
 */
const DETECTORS = [
  {
    id: 'quota',
    match: facts => facts.onlyTurn !== null
      && (facts.maxTokens === 1 || facts.maxTokens === '1')
      && facts.onlyTurn.toLowerCase().includes('quota')
      ? { kind: 'quota', text: 'Quota check passed.', usage: { input: 10, output: 5 } }
      : null,
  },
  {
    id: 'prefix',
    match: facts => {
      if (facts.onlyTurn === null) return null
      const turn = facts.onlyTurn
      if (!turn.includes('<policy_spec>') || !turn.includes('Command:')) return null
      // The last marker wins: the policy spec itself may quote an example
      // command, and the real one is appended after the spec.
      const command = turn.slice(turn.lastIndexOf('Command:') + 8).trim()
      return { kind: 'prefix', text: extractCommandPrefix(command), usage: { input: 100, output: 5 } }
    },
  },
  {
    id: 'title',
    match: facts => facts.hasTools || !asksForTitle(facts.system)
      ? null
      : { kind: 'title', text: 'Conversation', usage: { input: 100, output: 5 } },
  },
  {
    id: 'suggestion',
    match: facts => facts.suggestionMarked
      ? { kind: 'suggestion', text: '', usage: { input: 100, output: 1 } }
      : null,
  },
  {
    id: 'filepath',
    match: facts => {
      if (facts.onlyTurn === null || facts.hasTools) return null
      const turn = facts.onlyTurn
      if (!turn.includes('Command:') || !turn.includes('Output:')) return null
      if (!asksForFilepaths(turn, facts.system)) return null
      const start = turn.indexOf('Command:') + 8
      const end = turn.indexOf('Output:', start)
      if (end < 0) return null
      const command = turn.slice(start, end).trim()
      return { kind: 'filepath', text: extractFilepathsFromCommand(command), usage: { input: 100, output: 10 } }
    },
  },
]

/**
 * Detector ids, in evaluation order.
 *
 * ⚠️ These strings are a persisted configuration key, not an internal label: a
 * user who switched one off has `{ enabled: { quota: false } }` in their settings
 * file. Renaming one would silently re-enable the optimization they turned off, so
 * the names are frozen even though nothing about them is pretty.
 *
 * The order is product behaviour rather than an implementation detail — see the
 * module comment. Deriving it from the table keeps one source of truth.
 */
export const OPTIMIZATIONS = Object.freeze(DETECTORS.map(detector => detector.id))

/** First enabled detector that matches, or `null`. `enabled` is a map of id → boolean. */
function firstAnswer(request, enabled) {
  const facts = readFacts(request)
  for (const detector of DETECTORS) {
    if (enabled?.[detector.id] === false) continue
    const answer = detector.match(facts)
    if (answer !== null) return answer
  }
  return null
}

/** The id of the optimization that would answer this request, or `null`. */
export function detectOptimization(request, enabled) {
  return firstAnswer(request, enabled)?.kind ?? null
}

/**
 * Answer the request locally, or return `null` to let it go upstream.
 *
 * `options.model` overrides the model named in the body so the reply is
 * attributed to whatever the caller routed to.
 */
export function tryOptimizations(request, options = {}) {
  const answer = firstAnswer(request, options?.enabled)
  if (answer === null) return null
  const model = options?.model ?? request?.model
  answer.model = typeof model === 'string' ? model : ''
  return answer
}

/** Wrap a local answer in the Messages response shape. */
export function toMessagesResponse(result, { model, id } = {}) {
  return {
    type: 'message',
    role: 'assistant',
    id: typeof id === 'string' && id ? id : `msg_${randomUUID().replaceAll('-', '')}`,
    model: model ?? result?.model ?? '',
    content: [{ type: 'text', text: result?.text ?? '' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: result?.usage?.input ?? 0, output_tokens: result?.usage?.output ?? 0 },
  }
}
