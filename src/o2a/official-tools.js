/** Render authored transport tool contracts in each supported wire format. */
import { officialToolsText } from './asset-source.js'

/**
 * The 13 tools the official 2.2.3 client declares, in the order this lane sends
 * them (alphabetical, so the body is byte-stable across runs).
 *
 * The set is not free choice: `read` and `shell` are the two the free tier
 * validates the definition of, and the rest are what makes the request read as a
 * CLI agent session. `execute` used to sit here — it belongs to an older client
 * generation and 2.2.3 does not ship it — and `todowrite` was missing. Both are
 * corrected against the tag pinned in `src/o2a/version.js`.
 */
export const V2_OFFICIAL_TOOL_ORDER = Object.freeze([
  'edit', 'glob', 'grep', 'patch', 'question', 'read', 'shell',
  'skill', 'subagent', 'todowrite', 'webfetch', 'websearch', 'write',
])
let definitions
export function officialToolDefinition(name) {
  definitions ??= new Map(Object.entries(JSON.parse(officialToolsText())))
  return definitions.get(name)
}

/** `process.platform` → the OS word the client's shell sentence uses. */
const SHELL_OS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

/**
 * The compat-priority shell name for this platform, as
 * `packages/core/src/shell/select.ts` resolves it: the first executable among
 * `pwsh`, `powershell`, git-bash and `%COMSPEC%` on Windows; `/etc/shells`'
 * first entry (or `bash`) elsewhere. The gateway cannot know which of those the
 * user has installed, so it names the one every Windows install carries and the
 * one every Unix install carries.
 */
const SHELL_NAME = { win32: 'powershell', darwin: 'bash', linux: 'bash' }

/**
 * Render the `shell` tool description.
 *
 * The stored asset keeps the client's template (`Commands run on ${OS} using
 * ${shell}.`) because those two values are resolved by the client on the machine
 * it runs on, not by the build. The free tier compares this description, so the
 * rendering has to match what a real client on the same platform would send.
 */
export function v2ShellDescription(base, platform = process.platform) {
  return base
    .replace(/\$\{OS\}/g, SHELL_OS[platform] ?? platform)
    .replace(/\$\{shell\}/g, SHELL_NAME[platform] ?? 'bash')
}

export function officialTool(shape, name) {
  const definition = officialToolDefinition(name)
  let description = definition?.description ?? `Agent tool ${name}`
  const parameters = definition?.parameters == null ? { type: 'object', properties: {} } : structuredClone(definition.parameters)
  if (name === 'shell') description = v2ShellDescription(description)
  if (shape === 'claude') return { name, description, input_schema: parameters }
  const fn = { name, description, parameters }
  return shape === 'flat' ? { type: 'function', ...fn } : { type: 'function', function: { ...fn, strict: false } }
}

export function officialToolset(shape) {
  return V2_OFFICIAL_TOOL_ORDER.map(name => officialTool(shape, name))
}

export function renamableToolName(shape, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  if (shape !== 'chat') {
    const type = typeof entry.type === 'string' ? entry.type : ''
    if (shape === 'flat' && !['', 'function', 'custom'].includes(type)) return null
    if (shape === 'claude' && !['', 'custom'].includes(type)) return null
  }
  const name = shape === 'chat' ? entry.function?.name : entry.name
  return typeof name === 'string' && name.length > 0 ? name : null
}
