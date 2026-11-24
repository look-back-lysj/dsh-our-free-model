/**
 * The free lane's fingerprint as the reference gateway shapes it — the port of
 * opencode2api v1.4.7 (`src/o2a/`), tracked 2026-11-07.
 *
 * The 2026-10-16 v2 gate contract (read + shell verbatim, `tool_choice: 'none'`
 * refused) still holds, and on top of it the reference adds the facts its
 * releases verified: **no foreign client tool name may reach the wire** (another
 * client's vocabulary — Claude Code's `ReportFindings` + `ScheduleWakeup` — is
 * refused), so every named client tool is renamed to an opaque
 * `mcp_<digest>`. An official name is reserved for the official definition:
 * a caller spelling that folds onto one (`bash` → `shell`, `Read` → `read`)
 * still takes a handle, because the upstream compares the declaration at the
 * official name and answers a caller schema there with 429 (measured
 * 2026-11-22 against DSH's own `bash` tool); the **full 13-tool official CLI
 * set** is appended from the captured `ofm-tool-contracts.json`; and **ghost
 * call history is dropped** (calls naming tools this request no longer serves,
 * with their paired results). Each case below is one of the behaviors the
 * shaping must keep.
 *
 * Run: node scripts/fingerprint-test.mjs
 */

import fs from 'node:fs'
import { applyFingerprint, CLIENT_UA, FINGERPRINT_TOOLS, restoreToolName } from '../src/upstream.js'
import { clientToolWireName, CLIENT_TOOL_PREFIX } from '../src/o2a/tool-renames.js'
import { V2_OFFICIAL_TOOL_ORDER, v2ShellDescription } from '../src/o2a/official-tools.js'

/**
 * The transformation this lane applies to a caller tool's own prose: ASCII
 * spaces become NBSP, so a literal phrase cannot match an upstream rule while
 * the model still reads the same words.
 */
const nbsp = text => text.replaceAll(' ', '\u00a0')

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}

const chatTool = (name, extra = {}) => ({
  type: 'function',
  function: { name, description: `the ${name} tool`, parameters: { type: 'object', properties: { x: { type: 'string' } } }, ...extra },
})
const flatTool = (name, extra = {}) => ({ type: 'function', name, description: `the ${name} tool`, parameters: { type: 'object', properties: { x: { type: 'string' } } }, ...extra })
const claudeTool = name => ({ name, description: `the ${name} tool`, input_schema: { type: 'object', properties: { command: { type: 'string' } } } })
const declared = body => (body.tools ?? []).map(tool => tool.function?.name ?? tool.name)
const schemaOf = tool => tool.function?.parameters ?? tool.parameters ?? tool.input_schema
const noteOf = body => JSON.stringify(body.messages?.[0]?.content ?? body.system ?? body.instructions ?? '')
/** An official declaration as the shaper itself produces it, for "already correct" cases. */
const official = (style, name) => {
  const body = {}
  applyFingerprint(body, style)
  return body.tools.find(tool => (tool.function?.name ?? tool.name) === name)
}
/** The opaque wire name the shaper gives a client tool. */
const wireNameOf = name => clientToolWireName(name)

console.log('=== 1. client tools rename; the official set completes the wire ===')
{
  const body = { tools: [chatTool('pwsh'), chatTool('Read'), chatTool('write')] }
  const map = applyFingerprint(body, false)
  check('read and shell are declared', FINGERPRINT_TOOLS.filter(name => declared(body).includes(name)), ['read', 'shell'])
  check('no client name survives the wire', declared(body).some(name => !name.startsWith(CLIENT_TOOL_PREFIX) && !V2_OFFICIAL_TOOL_ORDER.includes(name)), false)
  // A caller spelling that folds onto an official name still takes an opaque
  // handle: the official name is reserved for the official definition.
  check('a case variant is renamed, not bound', declared(body).includes(wireNameOf('Read')), true)
  check('Read does not displace the official read', declared(body).filter(name => name === 'read').length, 1)
  check('write is renamed too', declared(body).filter(name => name === wireNameOf('write')).length, 1)
  check('write does not displace the official write', declared(body).filter(name => name === 'write').length, 1)
  check('the official read keeps the official schema', body.tools.find(tool => tool.function.name === 'read').function.parameters.required, ['path'])
  check('the caller handle maps back to its spelling', restoreToolName(wireNameOf('Read'), map), 'Read')
  check('the opaque rename still maps back', restoreToolName(wireNameOf('pwsh'), map), 'pwsh')
  check('all three caller names were renamed', map.size, 3)
  check('the full official set follows', V2_OFFICIAL_TOOL_ORDER.every(name => declared(body).includes(name)), true)
  check('the handle keeps the caller schema', body.tools.find(tool => tool.function.name === wireNameOf('Read')).function.parameters.properties.x, { type: 'string' })
  check('the official read is not duplicated', body.tools.filter(tool => tool.function.name === 'read').length, 1)
  check('official chat tools carry the client strict flag', body.tools.filter(tool => V2_OFFICIAL_TOOL_ORDER.includes(tool.function?.name) && tool.function.strict !== undefined).every(tool => tool.function.strict === false), true)
  check('renamed caller tools keep the caller’s shape', body.tools.find(tool => tool.function.name === wireNameOf('pwsh')).function.strict, undefined)
  check('the model is told the injected tools are placeholders', /placeholders in this session/.test(noteOf(body)), true)
  check('…and no tool_choice is claimed', body.tool_choice, undefined)
}

console.log('\n=== 1b. an official name never carries a caller schema (live 429, 2026-11-22) ===')
{
  // DSH's own `bash` tool under the official `shell` name answered 429; the
  // same bytes under an opaque handle answered 200. The gate reads what is
  // declared at the official name, so that name must never hold caller bytes.
  const dshBash = {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a bash command (`bash -c`) and return its stdout/stderr.',
      parameters: {
        type: 'object',
        properties: { description: { type: 'string' }, command: { type: 'string' } },
        required: ['description', 'command'],
      },
    },
  }
  const body = { tools: [dshBash] }
  applyFingerprint(body, false)
  check('the caller bash is opaque', declared(body).includes(wireNameOf('bash')), true)
  check('the caller schema stays on the handle', body.tools.find(tool => tool.function.name === wireNameOf('bash')).function.parameters.properties.description, { type: 'string' })
  const officialShell = body.tools.find(tool => tool.function.name === 'shell').function
  check('the official shell is declared verbatim', officialShell.parameters.required, ['command'])
  check('the official shell carries none of the caller properties', Object.hasOwn(officialShell.parameters.properties ?? {}, 'description'), false)
}

console.log('\n=== 1c. a genuine MCP name survives the restore path (regression) ===')
{
  // The handle namespace is `mcp_`, and a real MCP tool is spelled `mcp__…`.
  // A resolver that strips the namespace from anything starting with it turns
  // `mcp__github__search` into `_github__search` — a tool the caller never
  // declared. Handles are recognised by their whole shape, so the real name
  // passes through untouched.
  const body = { tools: [chatTool('mcp__github__search')] }
  const map = applyFingerprint(body, false)
  const handle = wireNameOf('mcp__github__search')
  check('the MCP tool is renamed like any caller tool', declared(body).includes(handle), true)
  check('its handle maps back to the MCP spelling', restoreToolName(handle, map), 'mcp__github__search')
  check('a bare MCP name is not stripped', restoreToolName('mcp__github__search', map), 'mcp__github__search')
  check('an orphan handle is passed through, not trimmed to a digest', restoreToolName('mcp_0123456789ab', map), 'mcp_0123456789ab')
  check('an old clint_ handle that is in the map still maps back', (() => {
    const legacy = new Map([['clint_0123456789ab', 'old_tool']])
    return restoreToolName('clint_0123456789ab', legacy)
  })(), 'old_tool')
}

console.log('\n=== 2. a caller spelling of a gate name takes a handle ===')
{
  const body = { tools: [chatTool('read'), chatTool('read_client'), chatTool('Edit')] }
  const map = applyFingerprint(body, false)
  check('the official read is singular', body.tools.filter(tool => tool.function.name === 'read').length, 1)
  check('the caller read maps back from its handle', restoreToolName(wireNameOf('read'), map), 'read')
  check('Edit takes a handle too', declared(body).includes(wireNameOf('Edit')), true)
  check('the official edit is injected', declared(body).filter(name => name === 'edit').length, 1)
  check('the unmatched spelling still renames opaquely', declared(body).includes(wireNameOf('read_client')), true)
  check('no caller name survives unbound', declared(body).slice(0, 3).every(name => name.startsWith(CLIENT_TOOL_PREFIX)), true)
  check('the official read keeps the official schema', body.tools.find(tool => tool.function.name === 'read').function.parameters.required, ['path'])
}

console.log('\n=== 3. a caller tool that already carries the official definition is the official declaration ===')
{
  const body = { tools: [official(false, 'read'), official(false, 'shell')] }
  const map = applyFingerprint(body, false)
  check('no duplicate and no rename — kept officials stay, the rest appends', declared(body), ['read', 'shell', ...V2_OFFICIAL_TOOL_ORDER.filter(name => name !== 'read' && name !== 'shell')])
  check('nothing was aliased', map.size, 0)
  check('the note never defames the caller\u2019s own tools', /`read`|`shell`/.test(noteOf(body)), false)
  check('environment context is still supplied', /<env>/.test(noteOf(body)), true)
}

console.log('\n=== 4. duplicate declarations: one wire name, one declaration ===')
{
  const body = { tools: [chatTool('shell'), chatTool('shell')] }
  applyFingerprint(body, false)
  const shellWires = declared(body).filter(name => name.startsWith(CLIENT_TOOL_PREFIX))
  check('the duplicate caller declaration is dropped', shellWires.length, 1)
  check('the official shell is singular', declared(body).filter(name => name === 'shell').length, 1)
}

console.log('\n=== 5. tool_choice: never none, retargeted to the wire name, auto on Responses ===')
{
  const chat = { tools: [chatTool('write')], tool_choice: 'none' }
  applyFingerprint(chat, false)
  check('a caller none is dropped (the gate refuses it)', chat.tool_choice, undefined)

  const claude = { tools: [claudeTool('write')], tool_choice: { type: 'none' } }
  applyFingerprint(claude, 'claude')
  check('the Messages shape drops it too', claude.tool_choice, undefined)

  const named = { tools: [chatTool('read')], tool_choice: { type: 'function', function: { name: 'read' } } }
  applyFingerprint(named, false)
  check('a choice naming a renamed tool speaks its handle', named.tool_choice.function.name, wireNameOf('read'))

  const dangling = { tools: [chatTool('pwsh')], tool_choice: { type: 'function', function: { name: 'ghost_tool' } } }
  applyFingerprint(dangling, false)
  check('a choice naming an unserved tool is dropped (v1.4.7)', dangling.tool_choice, undefined)

  const flat = { tools: [flatTool('write')] }
  applyFingerprint(flat, true)
  check('Responses defaults to auto', flat.tool_choice, 'auto')
}

console.log('\n=== 6. history calls follow the wire name; ghosts are dropped ===')
{
  const body = {
    tools: [chatTool('pwsh')],
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'pwsh', arguments: '{}' } }, { id: 'c2', function: { name: 'vanished_tool', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'tool', tool_call_id: 'c2', content: 'orphan' },
    ],
  }
  applyFingerprint(body, false)
  const assistant = body.messages.find(message => Array.isArray(message.tool_calls))
  check('the prior call follows the wire name', assistant.tool_calls[0].function.name, wireNameOf('pwsh'))
  check('the ghost call is dropped (v1.4.7)', assistant.tool_calls.length, 1)
  const results = body.messages.filter(message => message.role === 'tool')
  check('the orphaned result is dropped with it', results.length, 1)
  check('the kept result keeps its call', results[0].tool_call_id, 'c1')
  check('the caller message object is not mutated in place', assistant.tool_calls.length === 2, false)
}

console.log('\n=== 6b. a renamed tool keeps its history under the handle ===')
{
  const body = {
    tools: [chatTool('read')],
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ],
  }
  applyFingerprint(body, false)
  const assistant = body.messages.find(message => Array.isArray(message.tool_calls))
  check('the history call follows the handle', assistant.tool_calls[0].function.name, wireNameOf('read'))
  check('its result survives', body.messages.filter(message => message.role === 'tool').length, 1)
}

console.log('\n=== 6c. an emptied tool_calls field is removed, not forwarded (#787) ===')
{
  const body = {
    tools: [chatTool('pwsh')],
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'nothing to call', tool_calls: [] },
    ],
  }
  applyFingerprint(body, false)
  const assistant = body.messages.find(message => message.role === 'assistant')
  check('a caller tool_calls: [] is removed', Object.hasOwn(assistant, 'tool_calls'), false)
  check('the rest of the message survives', assistant.content, 'nothing to call')
}
{
  const body = {
    tools: [chatTool('pwsh')],
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'ghost-1', type: 'function', function: { name: 'vanished_tool', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'ghost-1', content: 'orphan' },
    ],
  }
  applyFingerprint(body, false)
  check('a turn whose calls are all ghosts is dropped', body.messages.some(message => message.role === 'assistant'), false)
  check('the orphan result goes with the call', body.messages.filter(message => message.role === 'tool').length, 0)
}
{
  const body = {
    tools: [chatTool('pwsh')],
    messages: [
      {
        role: 'assistant',
        content: 'still here',
        tool_calls: [{ id: 'ghost-2', type: 'function', function: { name: 'vanished_tool', arguments: '{}' } }],
      },
    ],
  }
  applyFingerprint(body, false)
  const assistant = body.messages.find(message => message.role === 'assistant')
  check('a turn with text keeps its row after the field is removed', assistant.content, 'still here')
  check('its emptied tool_calls field is gone', Object.hasOwn(assistant, 'tool_calls'), false)
}
{
  const body = {
    tools: [chatTool('pwsh')],
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'keep-1', type: 'function', function: { name: 'pwsh', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'keep-1', content: 'ok' },
    ],
  }
  applyFingerprint(body, false)
  const assistant = body.messages.find(message => message.role === 'assistant')
  check('a served call keeps its array', Array.isArray(assistant.tool_calls), true)
  check('the kept call follows the wire name', assistant.tool_calls[0].function.name, wireNameOf('pwsh'))
  check('the kept result stays paired', body.messages.filter(message => message.role === 'tool').length, 1)
}
{
  const body = {
    tools: [chatTool('pwsh')],
    messages: [
      { role: 'assistant', content: null, tool_calls: [], function_call: { name: 'Bash', arguments: '{}' } },
    ],
  }
  applyFingerprint(body, false)
  const assistant = body.messages.find(message => message.role === 'assistant')
  check('the legacy function_call is retargeted', assistant.function_call?.name, 'shell')
  check('the removed tool_calls array is not carried back', Object.hasOwn(assistant, 'tool_calls'), false)
}

console.log('\n=== 7. the Messages (Claude) shape carries input_schema, not parameters ===')
{
  const body = {}
  applyFingerprint(body, 'claude')
  check('the official set is declared', V2_OFFICIAL_TOOL_ORDER.every(name => declared(body).includes(name)), true)
  check('every declaration uses input_schema', body.tools.every(tool => tool.input_schema?.type === 'object' && tool.function === undefined && tool.parameters === undefined), true)
  check('the read schema is still the official one', body.tools.find(tool => tool.name === 'read').input_schema.required, ['path'])
  check('the placeholder note lands in system', /placeholders in this session/.test(noteOf(body)), true)

  const caller = { tools: [claudeTool('read')] }
  applyFingerprint(caller, 'claude')
  check('a conflicting caller read takes a handle', declared(caller).includes(wireNameOf('read')), true)
  check('the official read is not replaced', declared(caller).filter(name => name === 'read').length, 1)
  check('the official read keeps the captured schema', caller.tools.find(tool => tool.name === 'read').input_schema.required, ['path'])
  check('the handle keeps the caller schema', caller.tools.find(tool => tool.name === wireNameOf('read')).input_schema.properties.command, { type: 'string' })
}

console.log('\n=== 8. the Responses (flat) shape carries a flat declaration ===')
{
  const body = {}
  applyFingerprint(body, true)
  check('the official set is declared', V2_OFFICIAL_TOOL_ORDER.every(name => declared(body).includes(name)), true)
  check('the declarations are flat', body.tools.every(tool => tool.function === undefined && typeof tool.name === 'string'), true)
  check('the shell schema is the official one', body.tools.find(tool => tool.name === 'shell').parameters.required, ['command'])
  check('the placeholder note lands in instructions', /placeholders in this session/.test(String(body.instructions)), true)

  const caller = { tools: [flatTool('shell')] }
  applyFingerprint(caller, true)
  check('a conflicting caller shell takes a handle', declared(caller).includes(wireNameOf('shell')), true)
  check('the official shell is not replaced', declared(caller).filter(name => name === 'shell').length, 1)
  check('the official shell keeps the captured schema', caller.tools.find(tool => tool.name === 'shell').parameters.required, ['command'])
  check('the handle keeps the caller schema', caller.tools.find(tool => tool.name === wireNameOf('shell')).parameters.properties.x, { type: 'string' })
}

console.log('\n=== 9. the injected definitions are byte-for-byte the official ones ===')
{
  // The gate compares description and parameters, so a reworded copy is a 403
  // even though the name is right. The definitions must equal the captured
  // asset (whose property order the reference also emits — Go serialises its
  // maps alphabetically).
  const captured = JSON.parse(fs.readFileSync(new URL('../src/o2a/assets/ofm-tool-contracts.json', import.meta.url), 'utf8'))
  const body = {}
  applyFingerprint(body, false)
  const read = body.tools.find(tool => tool.function.name === 'read').function
  const shell = body.tools.find(tool => tool.function.name === 'shell').function
  check('read equals the captured definition', JSON.stringify({ description: read.description, parameters: read.parameters }), JSON.stringify(captured.read))
  // `shell` carries a platform template upstream; the lane renders it the way a
  // client on this machine would, so compare against the rendered form.
  const renderedShell = v2ShellDescription(captured.shell.description)
  check('shell equals the rendered captured definition', shell.description, renderedShell)
  check('shell schema equals the captured one', JSON.stringify(shell.parameters), JSON.stringify(captured.shell.parameters))
  check('every official tool equals its capture', V2_OFFICIAL_TOOL_ORDER.every(name => {
    const sent = body.tools.find(tool => tool.function.name === name).function
    const wantDescription = name === 'shell' ? renderedShell : captured[name].description
    return sent.description === wantDescription && JSON.stringify(sent.parameters) === JSON.stringify(captured[name].parameters)
  }), true)
  // The template must not survive rendering — a literal `${OS}` on the wire is a
  // body no client ever sends.
  check('no template placeholder reaches the wire', /\$\{/.test(shell.description), false)
  check('the gate names are read + shell', [...FINGERPRINT_TOOLS], ['read', 'shell'])
  check('the official order is the captured order', declared(body).slice(-V2_OFFICIAL_TOOL_ORDER.length), V2_OFFICIAL_TOOL_ORDER)
}

console.log('\n=== 10. shaping twice is a no-op (idempotence) ===')
{
  const body = { tools: [chatTool('pwsh')] }
  applyFingerprint(body, false)
  const once = JSON.stringify(body)
  const secondMap = applyFingerprint(body, false)
  check('the second pass changes nothing', JSON.stringify(body), once)
  // A re-shaped body carries only wire names and officials, so the second
  // pass legitimately renames nothing — the payload that ships always decodes
  // with the map from the pass that built it.
  check('the second pass renames nothing', secondMap.size, 0)

  const bound = { tools: [chatTool('Bash'), chatTool('pwsh')] }
  applyFingerprint(bound, false)
  const boundOnce = JSON.stringify(bound)
  applyFingerprint(bound, false)
  check('a bound body reshapes identically', JSON.stringify(bound), boundOnce)
}

console.log('\n=== 10b. title requests ship unshaped (v1.4.7) ===')
{
  const title = {
    messages: [
      { role: 'system', content: 'You generate conversation titles.' },
      { role: 'user', content: 'Generate a title for this conversation: help me fix a build' },
    ],
  }
  const marker = applyFingerprint(title, false)
  check('a title request is left untouched', JSON.stringify(title), JSON.stringify({
    messages: [
      { role: 'system', content: 'You generate conversation titles.' },
      { role: 'user', content: 'Generate a title for this conversation: help me fix a build' },
    ],
  }))
  check('…and renames nothing', marker.size, 0)

  // The marker is the first line of the upstream base prompt, taken from the
  // pinned tag rather than written by hand.
  const promptMarker = 'You are an AI agent running in OpenCode, a coding agent harness.'
  const chat = { messages: [{ role: 'user', content: 'Generate a title for this conversation: hello' }], tools: [chatTool('read')] }
  applyFingerprint(chat, false)
  check('a title-shaped body with tools is still shaped', noteOf(chat).includes(promptMarker), true)

  const plain = { messages: [{ role: 'user', content: 'hello' }] }
  applyFingerprint(plain, false)
  check('a plain toolless turn is still shaped', noteOf(plain).includes(promptMarker), true)
}

console.log('\n=== 11. the wire names the client release it follows ===')
{
  // The gate matches this whole string, so it is the one version fact that has to
  // be right. Asserting the composed UA rather than a bare semver catches a
  // version bump that forgets one of the other three segments.
  check('the User-Agent is the released client shape', /^opencode\/[a-z]+\/2\.\d+\.\d+\/[a-z]+$/.test(CLIENT_UA), true)
  check('the reported client version is the one the assets came from', CLIENT_UA.includes('/2.2.3/'), true)
}

console.log(failures === 0 ? '\nall fingerprint checks passed' : `\n${failures} fingerprint check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
