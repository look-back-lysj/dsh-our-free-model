/** Assemble OFM request context while retaining the caller's instruction blocks. */
import { officialPromptText } from './asset-source.js'

/**
 * The first line of the upstream base prompt, used as the "already injected"
 * marker. Taken from the pinned tag rather than written by hand: if the upstream
 * rewrites its opening sentence, a stale marker here would double-inject.
 */
export const OFFICIAL_PROMPT_MARKER = 'You are an AI agent running in OpenCode, a coding agent harness.'
export const OFFICIAL_SKILLS = 'Use only skills explicitly provided by the host; do not assume built-in skills are available.'
let cachedDirectory

/**
 * The per-tool guidance the client substitutes into `${OPENCODE_TOOL_GUIDANCE}`.
 *
 * Verbatim from `packages/core/src/session/system-prompt.ts` at the pinned tag:
 * one block per tool family the session declares, in the order shell → write →
 * edit, joined by a newline, and left empty when none is declared.
 */
const TOOL_GUIDANCE = [
  ['shell', [
    '- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.',
    '- Do not chain shell commands with separators like `echo "====";` or `printf \'---\'`; the output becomes noisy in a way that makes the user\'s side of the conversation worse.',
  ]],
  ['write', [
    '- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.',
  ]],
  ['edit', [
    '- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.',
  ]],
]

/**
 * Render the base prompt, filling its tool-guidance slot.
 *
 * `toolNames` is the tool set the outbound body declares — the caller's tools
 * after renaming plus the appended official set. Omitted or empty means "render
 * the guidance for the standard agent set", which is what this lane always
 * ships; the slot is never left unfilled, because a literal `${...}` reaching
 * the wire is a body no client ever sends.
 */
export function officialPrompt(toolNames) {
  const base = officialPromptText()
  if (base === '') return ''
  const declared = toolNames instanceof Set ? toolNames
    : Array.isArray(toolNames) ? new Set(toolNames) : null
  const lines = []
  for (const [family, guidance] of TOOL_GUIDANCE) {
    if (declared === null || declared.size === 0 || declared.has(family)) lines.push(...guidance)
  }
  return base.replace('${OPENCODE_TOOL_GUIDANCE}', lines.join('\n'))
}

export function officialEnvironment(model, directory) {
  if (directory === undefined) {
    if (cachedDirectory === undefined) {
      // cwd can disappear when the containing directory is removed externally.
      try { cachedDirectory = process.cwd().trim() || '/workspace' }
      catch { cachedDirectory = '/workspace' }
    }
    directory = cachedDirectory
  }
  const id = String(model ?? '').replace(/^opencode\//, '').trim() || 'unknown'
  const now = new Date()
  const date = now.toUTCString().slice(0, 16).replace(',', '')
  return `Model: ${id}\n<env>\n  Working directory: ${directory}\n  Workspace root folder: ${directory}\n  Platform: ${process.platform}\n  Today's date: ${date}\n</env>`
}

export function officialSystemPrompt(model, directory, toolNames) {
  const base = officialPrompt(toolNames)
  return base === '' ? '' : `${base}${officialEnvironment(model, directory)}\n${OFFICIAL_SKILLS}`
}

export function textFragments(value) {
  const result = [], pending = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') { if (item.trim()) result.push(item) }
    else if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index--) pending.push(item[index])
    } else if (item && typeof item === 'object') {
      if (typeof item.text === 'string') pending.push(item.text)
      else if (item.content !== undefined) pending.push(item.content)
    }
  }
  return result
}

export function carriesOpenCodePrompt(value) {
  return textFragments(value).some(text => text.includes(OFFICIAL_PROMPT_MARKER))
}

export function injectOfficialPrompt(payload, shape, { workDir, model, toolNames } = {}) {
  if (!payload || typeof payload !== 'object' || !['chat', 'flat', 'claude'].includes(shape)) return false
  const prompt = officialSystemPrompt(model ?? payload.model, workDir, toolNames)
  if (!prompt) return false
  const prepend = (value, blocks) => {
    if (blocks && Array.isArray(value)) return [{ type: 'text', text: prompt }, ...value]
    return typeof value === 'string' && value.trim() ? `${prompt}\n\n${value}` : prompt
  }
  if (shape !== 'chat') {
    const key = shape === 'flat' ? 'instructions' : 'system'
    if (carriesOpenCodePrompt(payload[key])) return false
    payload[key] = prepend(payload[key], shape === 'claude')
    return true
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  let anchor = -1
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message?.role !== 'system' && message?.role !== 'developer') continue
    if (carriesOpenCodePrompt(message.content)) return false
    if (anchor < 0) anchor = index
  }
  if (anchor < 0) payload.messages = [{ role: 'system', content: prompt }, ...messages]
  else messages[anchor] = { ...messages[anchor], content: prepend(messages[anchor].content, true) }
  return true
}
