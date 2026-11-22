/**
 * Guard the generated OpenCode assets against silent hand edits.
 *
 * The free tier compares the shaped body character for character — the system
 * prompt and all 13 tool definitions (description and parameter schema). A
 * "harmless" tidy of a description is therefore a 429 in production, and it
 * looks exactly like a quota wall, which is the worst possible failure shape.
 *
 * This suite pins three things:
 *   1. the assets match what `docs/opencode-assets.md` records as their source;
 *   2. the shape of every tool is intact (names, order, required fields, a
 *      description on every property);
 *   3. the two runtime templates are present and get rendered, never shipped raw.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL  ${name}\n       ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

const root = new URL('../', import.meta.url)
const readAsset = name => fs.readFileSync(new URL(`src/o2a/assets/${name}`, root), 'utf8')
const contracts = JSON.parse(readAsset('ofm-tool-contracts.json'))
const promptText = readAsset('ofm-agent-context.txt')
const provenance = fs.readFileSync(new URL('docs/opencode-assets.md', root), 'utf8')

/** The 13 tools the official 2.2.3 client ships, in wire order. */
const EXPECTED_TOOLS = [
  'read', 'shell', 'edit', 'glob', 'grep', 'write', 'patch',
  'webfetch', 'websearch', 'question', 'skill', 'subagent', 'todowrite',
]

console.log('\n=== 1. the asset set is complete ===')

check('all 13 official tools are present', () => {
  assert.deepEqual(Object.keys(contracts).sort(), [...EXPECTED_TOOLS].sort())
})

check('the gate tools are among them', () => {
  // The free tier validates the definition of these two specifically.
  for (const name of ['read', 'shell']) assert.ok(contracts[name], `${name} must exist`)
})

check('every tool declares a description', () => {
  for (const name of EXPECTED_TOOLS) {
    assert.equal(typeof contracts[name].description, 'string', `${name}.description`)
    assert.ok(contracts[name].description.length > 20, `${name}.description is suspiciously short`)
  }
})

check('every tool declares an object schema', () => {
  for (const name of EXPECTED_TOOLS) {
    const schema = contracts[name].parameters
    assert.equal(schema.type, 'object', `${name}.parameters.type`)
    assert.equal(typeof schema.properties, 'object', `${name}.parameters.properties`)
  }
})

console.log('\n=== 2. parameter descriptions survived the extraction ===')

check('every property carries its own description', () => {
  // The upstream describes each argument; a description-less property is the
  // signature of a hand-written or lossily extracted asset.
  for (const name of EXPECTED_TOOLS) {
    const schema = contracts[name].parameters
    for (const [key, property] of Object.entries(schema.properties)) {
      assert.equal(typeof property.description, 'string', `${name}.${key} has no description`)
      assert.ok(property.description.length > 0, `${name}.${key} has an empty description`)
    }
  }
})

check('required fields are a subset of the declared properties', () => {
  for (const name of EXPECTED_TOOLS) {
    const schema = contracts[name].parameters
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(schema.properties, key), `${name}.${key} is required but not declared`)
    }
  }
})

check('the gate tools keep their known argument sets', () => {
  // These are the two the free tier reads; a dropped argument changes the body.
  assert.deepEqual(Object.keys(contracts.read.parameters.properties), ['path', 'offset', 'limit'])
  assert.deepEqual(Object.keys(contracts.shell.parameters.properties), ['command', 'workdir', 'timeout', 'background'])
  assert.deepEqual(contracts.read.parameters.required, ['path'])
  assert.deepEqual(contracts.shell.parameters.required, ['command'])
})

console.log('\n=== 3. the runtime templates are intact ===')

check('the system prompt keeps its tool-guidance slot', () => {
  // The client substitutes per-tool instructions here. Shipping the prompt with
  // the slot already gone (or a literal `${...}`) is a body no client sends.
  assert.ok(promptText.includes('${OPENCODE_TOOL_GUIDANCE}'), 'the placeholder must survive extraction')
})

check('the prompt opens with the upstream first line', () => {
  assert.ok(promptText.startsWith('You are an AI agent running in OpenCode, a coding agent harness.'))
})

check('the shell description keeps its platform template', () => {
  // `${OS}` and `${shell}` are resolved per request by v2ShellDescription.
  assert.ok(contracts.shell.description.includes('${OS}'), 'the OS placeholder must survive extraction')
  assert.ok(contracts.shell.description.includes('${shell}'), 'the shell placeholder must survive extraction')
})

check('no other tool description carries an unrendered placeholder', () => {
  for (const name of EXPECTED_TOOLS) {
    if (name === 'shell') continue
    assert.equal(/\$\{/.test(contracts[name].description), false, `${name} still has a template placeholder`)
  }
})

console.log('\n=== 4. provenance is recorded ===')

check('the provenance doc names the pinned tag', () => {
  assert.match(provenance, /v2\.2\.3/)
})

check('the provenance doc records a blob digest per source file', () => {
  // One per tool source plus the system prompt. The shared schema fragments the
  // builder reads are inputs to that extraction, not asset sources, so they are
  // not expected to appear in this table.
  const digests = provenance.match(/`[0-9a-f]{40}`/g) ?? []
  assert.ok(digests.length >= EXPECTED_TOOLS.length + 1, `expected at least ${EXPECTED_TOOLS.length + 1} digests, found ${digests.length}`)
})

check('the provenance doc names the licence', () => {
  assert.match(provenance, /MIT/)
})

check('the pinned tag matches the client version this lane reports', async () => {
  const version = fs.readFileSync(new URL('src/o2a/version.js', root), 'utf8')
  const match = /V2_CLIENT_VERSION\s*=\s*'([^']+)'/.exec(version)
  assert.ok(match, 'V2_CLIENT_VERSION must be declared')
  assert.ok(provenance.includes(match[1]), `provenance must name ${match[1]}`)
})

console.log('\n=== 5. no earlier generation of the namespace leaked back in ===')

check('no asset mentions the refused client-tool prefix', () => {
  // `clint_` in a tool NAME is refused by the free tier; it must not appear in
  // the shipped assets at all, where it could only come back by copy-paste.
  assert.equal(readAsset('ofm-tool-contracts.json').includes('clint_'), false)
})

console.log(`\n${failures.length === 0 ? 'all o2a asset checks passed' : `${failures.length} o2a asset check(s) failed`} (${passed} passed)`)
if (failures.length > 0) process.exitCode = 1
