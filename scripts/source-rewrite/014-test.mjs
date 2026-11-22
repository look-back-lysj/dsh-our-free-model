/**
 * SRC-014 gate: the rewritten free-lane implementation matches the frozen contract.
 *
 * Run: `node scripts/source-rewrite/014-test.mjs`
 *
 * ## The defect this gate exists for
 *
 * The original recovery path stripped any namespace prefix from any name, so once any tool had
 * been renamed, a real `mcp__github__search` came back as `_github__search` — a tool the caller
 * never declared. Several checks below pin that exact case from both sides: the real MCP name
 * must survive, and a genuinely minted name must still map back.
 *
 * ## What else is pinned
 *
 * - The three wire shapes each nest a declaration differently, and a rename must be applied in
 *   the right place for each.
 * - The appended official declarations keep their exact bytes.
 * - History references are renamed with the declarations, and a call whose declaration is gone
 *   is dropped together with its result.
 * - The retained assets are byte-identical, and the OpenCode call path still exists.
 *
 * @module scripts/source-rewrite/014-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ALL_PREFIXES,
  DIGEST_LENGTH,
  digestOf,
  foldName,
  isMintedName,
  mintWireName,
  namespaceOf,
  OFFICIAL_ALIASES,
  officialFor,
  ToolNames,
  WIRE_NAME_LIMIT,
  WIRE_PREFIX,
} from '../../src/o2a/rewrite/tool-names.js'
import {
  declaredName,
  deLiteralize,
  dropDanglingChoice,
  fromLegacyFunctions,
  pruneUnknownTools,
  rewriteHistory,
  shapeTools,
  SHAPES,
  withDeLiteralizedDescription,
  withName,
} from '../../src/o2a/rewrite/tool-shape.js'
import { REPO_ROOT as CONTRACT_ROOT, RETAINED_ASSETS, TOOL_NAMES } from '../../工程控制/ORIGIN-REWRITE-01/contracts/opencode/asset-contract.mjs'

const failures = []
let passed = 0

/** @param {string} name @param {() => unknown | Promise<unknown>} body */
async function check(name, body) {
  try {
    await body()
    passed += 1
    process.stdout.write(`  ok  ${name}\n`)
  } catch (error) {
    failures.push({ name, message: error?.message ?? String(error) })
    process.stdout.write(`  FAIL ${name}\n        ${String(error?.message ?? error).split('\n').join('\n        ')}\n`)
  }
}

/** A minimal official declaration builder for the tests. */
function officialTool(name) {
  return { type: 'function', function: { name, description: `official ${name}`, parameters: { type: 'object' } } }
}
const OFFICIAL_ORDER = ['shell', 'write', 'edit']
const isOfficial = name => OFFICIAL_ORDER.includes(name)

/** A caller tool in the chat shape. */
function chatTool(name, description = `does ${name}`) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } } }
}

process.stdout.write('SRC-014 free-lane rewrite gate\n\n')

// ── 1. the minted-shape rule ───────────────────────────────────────────────
await check('a minted name is recognised by its whole shape', () => {
  const minted = mintWireName('local_tool')
  assert.equal(isMintedName(minted), true)
  assert.equal(isMintedName(`${WIRE_PREFIX}0123456789ab`), true)
  assert.equal(isMintedName(`${WIRE_PREFIX}0123456789ab_2`), true, 'a collision suffix was not accepted')
})

await check('a real MCP tool name is not minted', () => {
  // The whole reason the rule is exact: this starts with the namespace but is a caller tool.
  assert.equal(isMintedName('mcp__github__search'), false)
  assert.equal(isMintedName('mcp_github_search'), false)
  assert.equal(isMintedName(`${WIRE_PREFIX}0123456789`), false, 'an 11-hex name was accepted')
  assert.equal(isMintedName(`${WIRE_PREFIX}0123456789abc`), false, 'a 13-hex name was accepted')
  assert.equal(isMintedName(`${WIRE_PREFIX}0123456789AB`), false, 'an uppercase digest was accepted')
  assert.equal(isMintedName('clint_0123456789ab'), true, 'a legacy namespace was not recognised')
  assert.equal(isMintedName(''), false)
  assert.equal(isMintedName(undefined), false)
})

await check('the namespace and digest of a minted name are recoverable', () => {
  assert.equal(namespaceOf(`${WIRE_PREFIX}0123456789ab`), WIRE_PREFIX)
  assert.equal(namespaceOf('clint_0123456789ab'), 'clint_')
  assert.equal(namespaceOf('mcp__github__search'), undefined)
  assert.equal(digestOf(`${WIRE_PREFIX}0123456789ab_3`), '0123456789ab', 'the collision suffix was not stripped')
  assert.equal(digestOf('mcp__github__search'), undefined)
})

await check('minting is stable per name and avoids collisions', () => {
  const first = mintWireName('local_tool')
  assert.equal(first, mintWireName('local_tool'), 'the same name minted two different wire names')
  assert.equal(first.length, WIRE_PREFIX.length + DIGEST_LENGTH)
  const taken = new Set([first])
  const second = mintWireName('local_tool', taken)
  assert.notEqual(second, first)
  assert.equal(second, `${first}_2`)
  assert.ok(second.length <= WIRE_NAME_LIMIT)
})

// ── 2. the recovery defect ─────────────────────────────────────────────────
await check('a real MCP tool name survives alongside a renamed tool', () => {
  // This is the recorded red light: the old code returned `_github__search` here.
  const names = new ToolNames()
  names.add('local_tool', mintWireName('local_tool'))
  assert.equal(names.resolve('mcp__github__search'), 'mcp__github__search',
    'a real MCP name was stripped, which is the defect this rewrite exists to fix')
  assert.equal(names.resolve('local_tool'), 'local_tool')
})

await check('a renamed tool still maps back', () => {
  const names = new ToolNames()
  const wire = mintWireName('local_tool')
  names.add('local_tool', wire)
  assert.equal(names.resolve(wire), 'local_tool')
})

await check('a minted name with no map entry is returned whole, not guessed at', () => {
  // A name from an earlier turn: the digest is one-way, so inventing a client name would be worse
  // than returning what arrived.
  const names = new ToolNames()
  names.add('other', mintWireName('other'))
  const orphan = `${WIRE_PREFIX}aaaaaaaaaaaa`
  assert.equal(names.resolve(orphan), orphan)
})

await check('an unmapped legacy minted name is returned whole', () => {
  const names = new ToolNames()
  assert.equal(names.resolve('clint_0123456789ab'), 'clint_0123456789ab')
})

await check('a legacy minted name maps back when the map knows it', () => {
  const names = new ToolNames()
  names.add('old_tool', 'clint_0123456789ab')
  assert.equal(names.resolve('clint_0123456789ab'), 'old_tool')
})

await check('folded lookup tolerates case and separators, and refuses ambiguity', () => {
  const names = new ToolNames()
  names.add('read_file', mintWireName('read_file'))
  assert.equal(names.resolveFolded('readFile'), 'read_file')
  assert.equal(names.resolveFolded('READ_FILE'), 'read_file')
  names.add('readFile', mintWireName('readFile'))
  assert.equal(names.resolveFolded('read-file'), 'read-file', 'an ambiguous folded lookup picked one arbitrarily')
})

await check('the alias table maps every documented spelling', () => {
  for (const [canonical, spellings] of Object.entries(OFFICIAL_ALIASES)) {
    for (const spelling of spellings) {
      assert.equal(officialFor(spelling), canonical, `${spelling} did not map to ${canonical}`)
    }
  }
  assert.equal(officialFor('askUserQuestion'), 'question')
  assert.equal(officialFor('nonesuch'), null)
  assert.equal(officialFor(''), null)
})

// ── 3. the three shapes ────────────────────────────────────────────────────
await check('the declared name is read from the right place per shape', () => {
  assert.equal(declaredName('chat', chatTool('a')), 'a')
  assert.equal(declaredName('flat', { name: 'b' }), 'b')
  assert.equal(declaredName('claude', { name: 'c' }), 'c')
  assert.equal(declaredName('chat', { name: 'wrong-shape' }), null)
})

await check('a rename lands in the right place per shape and never mutates the input', () => {
  const chat = chatTool('local')
  const chatOut = withName('chat', chat, 'renamed')
  assert.equal(chatOut.function.name, 'renamed')
  assert.equal(chat.function.name, 'local', 'the caller object was mutated')

  const flat = { name: 'local', input_schema: { type: 'object' } }
  assert.equal(withName('flat', flat, 'renamed').name, 'renamed')

  const claude = { name: 'local', input_schema: { type: 'object' } }
  const claudeOut = withName('claude', claude, 'renamed')
  assert.equal(claudeOut.name, 'renamed')
  assert.deepEqual(claudeOut.input_schema, { type: 'object' }, 'the schema was disturbed')
})

await check('de-literalising only touches the top-level description', () => {
  const chat = {
    type: 'function',
    function: {
      name: 'local',
      description: 'does a thing',
      parameters: { type: 'object', properties: { q: { type: 'string', description: 'the query' } } },
    },
  }
  const out = withDeLiteralizedDescription('chat', chat)
  assert.equal(out.function.description.includes('\u00a0'), true)
  assert.equal(out.function.description.includes(' '), false, 'an ASCII space survived')
  assert.equal(out.function.parameters.properties.q.description, 'the query', 'a parameter description was rewritten')
  assert.equal(chat.function.description, 'does a thing', 'the caller object was mutated')
  // Idempotent: a second pass changes nothing.
  assert.equal(withDeLiteralizedDescription('chat', out).function.description, out.function.description)
})

await check('legacy functions[] entries convert into the request shape', () => {
  const converted = fromLegacyFunctions([{ name: 'legacy', description: 'old', parameters: { type: 'object' } }], 'chat')
  assert.equal(converted[0].type, 'function')
  assert.equal(converted[0].function.name, 'legacy')
  assert.deepEqual(converted[0].function.parameters, { type: 'object' })
  const flat = fromLegacyFunctions([{ name: 'legacy', input_schema: { type: 'object' } }], 'flat')
  assert.deepEqual(flat[0].input_schema, { type: 'object' })
})

// ── 4. shaping end to end ──────────────────────────────────────────────────
await check('caller tools are renamed, official tools appended, and order preserved', () => {
  const payload = { tools: [chatTool('local_one'), chatTool('local_two')] }
  const result = shapeTools({ payload, shape: 'chat', officialTool, officialOrder: OFFICIAL_ORDER, isOfficial })
  assert.equal(result.declared, 2)
  const names = payload.tools.map(entry => entry.function.name)
  // The two caller tools keep their positions and are renamed.
  assert.equal(isMintedName(names[0]), true, `first caller tool became ${names[0]}`)
  assert.equal(isMintedName(names[1]), true)
  // The official set follows, in its declared order.
  assert.deepEqual(names.slice(2), OFFICIAL_ORDER)
  assert.deepEqual(result.injected, OFFICIAL_ORDER)
})

await check('a caller tool named like an official one takes the official name', () => {
  const payload = { tools: [chatTool('bash')] }
  const result = shapeTools({ payload, shape: 'chat', officialTool, officialOrder: OFFICIAL_ORDER, isOfficial })
  const names = payload.tools.map(entry => entry.function.name)
  assert.equal(names[0], 'shell', 'a caller alias did not map to its official name')
  assert.equal(names.filter(name => name === 'shell').length, 1, 'the official tool was appended twice')
  assert.deepEqual(result.injected, ['write', 'edit'])
})

await check('a second shaping pass is idempotent', () => {
  const payload = { tools: [chatTool('local_one')] }
  shapeTools({ payload, shape: 'chat', officialTool, officialOrder: OFFICIAL_ORDER, isOfficial })
  const afterFirst = payload.tools.map(entry => entry.function.name)
  shapeTools({ payload, shape: 'chat', officialTool, officialOrder: OFFICIAL_ORDER, isOfficial })
  const afterSecond = payload.tools.map(entry => entry.function.name)
  assert.deepEqual(afterSecond, afterFirst, 'a second pass renamed already-minted tools')
})

await check('a real MCP tool declaration is renamed, not passed through', () => {
  // It must not reach the wire verbatim: that is the lane's whole rule.
  const payload = { tools: [chatTool('mcp__github__search')] }
  shapeTools({ payload, shape: 'chat', officialTool, officialOrder: OFFICIAL_ORDER, isOfficial })
  const name = payload.tools[0].function.name
  assert.equal(isMintedName(name), true, `a real MCP name was shipped verbatim as ${name}`)
})

await check('an unsupported shape is left alone', () => {
  const payload = { tools: [chatTool('local')] }
  const result = shapeTools({ payload, shape: 'nonesuch', officialTool, officialOrder: OFFICIAL_ORDER, isOfficial })
  assert.equal(result.declared, 0)
  assert.equal(payload.tools[0].function.name, 'local')
})

await check('history references are renamed with the declarations', () => {
  const payload = {
    tools: [chatTool('local_tool')],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'local_tool', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ],
  }
  const result = shapeTools({ payload, shape: 'chat', officialTool, officialOrder: OFFICIAL_ORDER, isOfficial })
  rewriteHistory(payload, 'chat', result.names)
  const wire = result.names.wireFor('local_tool')
  assert.equal(payload.messages[1].tool_calls[0].function.name, wire, 'a history call kept the caller name')
  assert.equal(payload.messages[2].tool_call_id, 'c1', 'the pairing id was disturbed')
})

await check('an undeclared tool call and its result are dropped together', () => {
  const payload = {
    tools: [chatTool('kept')],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'gone-1', type: 'function', function: { name: 'vanished', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'gone-1', content: 'orphan' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'keep-1', type: 'function', function: { name: 'kept', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'keep-1', content: 'kept result' },
    ],
  }
  const known = new Set(['kept'])
  const dropped = pruneUnknownTools(payload, 'chat', known)
  assert.ok(dropped >= 2, `dropped ${dropped} entries`)
  assert.equal(payload.messages.some(message => message.tool_call_id === 'gone-1'), false, 'an orphan result survived')
  assert.equal(payload.messages.some(message => message.tool_call_id === 'keep-1'), true, 'a live result was dropped')
})

await check('a dangling tool_choice is removed', () => {
  const payload = { tool_choice: { type: 'function', function: { name: 'vanished' } } }
  dropDanglingChoice(payload, 'chat', new Set(['kept']))
  assert.equal('tool_choice' in payload, false)
  const valid = { tool_choice: { type: 'function', function: { name: 'kept' } } }
  dropDanglingChoice(valid, 'chat', new Set(['kept']))
  assert.ok('tool_choice' in valid, 'a valid choice was dropped')
})

await check('the flat shape renames at the top level', () => {
  const payload = { tools: [{ name: 'local', input_schema: { type: 'object', properties: {} } }] }
  shapeTools({ payload, shape: 'flat', officialTool, officialOrder: OFFICIAL_ORDER, isOfficial })
  assert.equal(isMintedName(payload.tools[0].name), true)
  assert.deepEqual(payload.tools[0].input_schema, { type: 'object', properties: {} })
})

await check('the claude shape does not convert legacy functions', () => {
  const payload = { tools: [{ name: 'local', input_schema: { type: 'object' } }], functions: [{ name: 'legacy', parameters: {} }] }
  shapeTools({ payload, shape: 'claude', officialTool, officialOrder: OFFICIAL_ORDER, isOfficial })
  assert.ok('functions' in payload, 'the claude shape consumed functions it does not accept')
})

// ── 5. the retained assets and the call path ───────────────────────────────
await check('the retained assets are byte-identical to the frozen contract', async () => {
  const crypto = await import('node:crypto')
  for (const asset of RETAINED_ASSETS) {
    const bytes = fs.readFileSync(path.join(CONTRACT_ROOT, asset.path.replace(/\//g, path.sep)))
    assert.equal(bytes.length, asset.bytes)
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256)
  }
})

await check('the 13 retained tool definitions are still declared', () => {
  const raw = fs.readFileSync(path.join(CONTRACT_ROOT, RETAINED_ASSETS[1].path.replace(/\//g, path.sep)), 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(raw)), [...TOOL_NAMES])
})

await check('the OpenCode call path still exists', () => {
  const upstream = fs.readFileSync(path.join(CONTRACT_ROOT, 'src', 'upstream.js'), 'utf8')
  // The lane must still reach the provider; the rewrite is of the surrounding code, not the call.
  assert.ok(/inference|chat\/completions|messages/.test(upstream), 'the upstream call path is gone')
  const prompt = fs.readFileSync(path.join(CONTRACT_ROOT, 'src', 'o2a', 'official-prompt.js'), 'utf8')
  assert.ok(prompt.includes('${OPENCODE_TOOL_GUIDANCE}'), 'the prompt renderer lost its guidance slot')
})

await check('the rewrite did not touch the retained source files', () => {
  // The new implementation lives under src/o2a/rewrite/; the retained assets and the existing
  // renderer must be untouched by it.
  const rewriteDir = path.join(CONTRACT_ROOT, 'src', 'o2a', 'rewrite')
  const files = fs.readdirSync(rewriteDir).sort()
  assert.deepEqual(files, ['tool-names.js', 'tool-shape.js'], `unexpected files in the rewrite directory: ${files.join(', ')}`)
  for (const file of files) {
    const text = fs.readFileSync(path.join(rewriteDir, file), 'utf8')
    assert.ok(!text.includes('ofm-agent-context.txt'), `${file} reads the retained prompt asset`)
    assert.ok(!text.includes('ofm-tool-contracts.json'), `${file} reads the retained tool asset`)
  }
})

// ── 6. the three protocols round-trip ──────────────────────────────────────
await check('every shape round-trips a caller tool through rename and back', () => {
  for (const shape of SHAPES) {
    const names = new ToolNames()
    const wire = mintWireName('local_tool')
    names.add('local_tool', wire)
    const payload = { tools: [shape === 'chat' ? chatTool('local_tool') : { name: 'local_tool', input_schema: {} }] }
    const result = shapeTools({ payload, shape, officialTool, officialOrder: OFFICIAL_ORDER, isOfficial })
    const declared = declaredName(shape, payload.tools[0])
    assert.equal(isMintedName(declared), true, `${shape}: the caller tool was not renamed`)
    assert.equal(result.names.resolve(declared), 'local_tool', `${shape}: the name did not map back`)
    // And a real MCP name in the same request survives.
    assert.equal(result.names.resolve('mcp__github__search'), 'mcp__github__search', `${shape}: an MCP name was stripped`)
  }
})

await check('foldName removes separators and case only', () => {
  assert.equal(foldName('Read_File'), 'readfile')
  assert.equal(foldName('read-file'), 'readfile')
  assert.equal(foldName('readFile'), 'readfile')
  assert.equal(foldName(''), '')
  assert.equal(foldName(undefined), '')
})

await check('the namespace list is the current one plus the legacy one', () => {
  assert.deepEqual([...ALL_PREFIXES], [WIRE_PREFIX, 'clint_'])
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`014-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`014-test: ${passed} checks passed — the free-lane rewrite meets its contract.\n`)
process.stdout.write('Scope reminder: the rewrite lives under src/o2a/rewrite/. Host wiring is SRC-016; a live OpenCode request is SRC-019.\n')
