/**
 * SRC-013 gate: the retained OpenCode assets and render semantics are unchanged.
 *
 * Run: `node scripts/source-rewrite/013-test.mjs`
 *
 * ## What this proves
 *
 * That the two retained assets are byte-identical to the frozen contract, that the 13
 * tool names and four guidance strings still match verbatim, that the renderer still
 * fills the slot and gates by family, and that every build step that must carry the
 * assets still names them.
 *
 * The renderer checks run the *real* renderer rather than a copy, so a change to the
 * injection behaviour fails here instead of surfacing as a subtly different request body
 * in production.
 *
 * ## What it does not do
 *
 * It does not send anything to OpenCode, and it makes no originality claim about the
 * retained text.
 *
 * @module scripts/source-rewrite/013-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ASSET_DELIVERY,
  ATTRIBUTION,
  GUIDANCE,
  GUIDANCE_SLOT,
  guidanceLineCount,
  hashAsset,
  PROMPT_MARKER,
  readPromptBody,
  readToolContracts,
  RENDER_RULES,
  REPO_ROOT,
  RETAINED_ASSETS,
  TOOL_NAMES,
} from '../../工程控制/ORIGIN-REWRITE-01/contracts/opencode/asset-contract.mjs'

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

process.stdout.write('SRC-013 retained-OpenCode-asset gate\n\n')

// ── 1. bytes ───────────────────────────────────────────────────────────────
for (const asset of RETAINED_ASSETS) {
  await check(`${asset.path}: bytes and sha256 match the frozen contract`, () => {
    const actual = hashAsset(asset.path)
    assert.equal(actual.bytes, asset.bytes, `${actual.bytes} bytes, frozen ${asset.bytes}`)
    assert.equal(actual.sha256, asset.sha256, `sha256 ${actual.sha256} != frozen ${asset.sha256}`)
  })
}

await check('the channel contract pins the same digests', () => {
  const contracts = JSON.parse(fs.readFileSync(path.join(
    REPO_ROOT, '工程控制', 'ORIGIN-REWRITE-01', 'contracts', 'baseline-20261122', 'channel-contracts.json',
  ), 'utf8'))
  for (const asset of RETAINED_ASSETS) {
    const pinned = contracts.protectedInputs.find(entry => entry.path === asset.path)
    assert.ok(pinned !== undefined, `${asset.path} is missing from the channel contract's protected inputs`)
    assert.equal(pinned.sha256, asset.sha256, `${asset.path}: the two contracts disagree on the digest`)
    assert.equal(pinned.bytes, asset.bytes)
  }
})

// ── 2. the 13 tools ────────────────────────────────────────────────────────
await check('the tool asset declares exactly 13 tools, in contract order', () => {
  const tools = readToolContracts()
  const names = Object.keys(tools)
  assert.equal(names.length, 13, `${names.length} tools`)
  assert.deepEqual(names, TOOL_NAMES, `tool order or membership drifted: ${names.join(', ')}`)
})

await check('every tool carries a description and an input schema', () => {
  const tools = readToolContracts()
  for (const [name, definition] of Object.entries(tools)) {
    assert.equal(typeof definition, 'object', `${name} is not an object`)
    const description = definition.description
    assert.equal(typeof description, 'string', `${name} has no description`)
    assert.ok(description.length > 0, `${name} has an empty description`)
    const schema = definition.input_schema ?? definition.parameters ?? definition.inputSchema
    assert.ok(schema !== undefined, `${name} has no input schema`)
  }
})

// ── 3. the guidance strings ────────────────────────────────────────────────
await check('there are exactly four guidance strings across three families', () => {
  assert.equal(GUIDANCE.length, 3, `${GUIDANCE.length} families`)
  assert.equal(guidanceLineCount(), 4, `${guidanceLineCount()} guidance strings, expected 4`)
})

await check('the guidance families still gate on their own tool name', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'o2a', 'official-prompt.js'), 'utf8')
  for (const group of GUIDANCE) {
    assert.ok(source.includes(`'${group.family}'`), `the ${group.family} family is no longer referenced`)
  }
})

// ── 4. the prompt body and slot ────────────────────────────────────────────
await check('the prompt body still carries the guidance slot exactly once', () => {
  const body = readPromptBody()
  const occurrences = body.split(GUIDANCE_SLOT).length - 1
  assert.equal(occurrences, 1, `the slot appears ${occurrences} times`)
})

await check('the prompt body still opens with the injection marker', () => {
  const body = readPromptBody()
  assert.ok(body.startsWith(PROMPT_MARKER), `the body no longer starts with the marker; first line: ${body.split('\n')[0]}`)
})

// ── 5. render semantics, run against the real renderer ─────────────────────
const prompt = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'o2a', 'official-prompt.js')).href)

await check('every guidance string still reaches the rendered prompt verbatim', () => {
  // Checked against the rendered output rather than the source text: the source escapes
  // apostrophes, and what must not change is the string the model receives, not how the
  // file happens to quote it.
  const rendered = prompt.officialPrompt()
  for (const group of GUIDANCE) {
    for (const line of group.lines) {
      assert.ok(rendered.includes(line), `a guidance string was reworded or removed:\n  ${line.slice(0, 80)}...`)
    }
  }
})

await check('render fills the slot and never leaves the token on the wire', () => {
  const rendered = prompt.officialPrompt()
  assert.ok(!rendered.includes(GUIDANCE_SLOT), 'the slot token survived rendering — that body never appears on a real wire')
  assert.ok(rendered.startsWith(PROMPT_MARKER))
})

await check('an omitted or empty tool set renders the standard guidance', () => {
  const omitted = prompt.officialPrompt()
  const empty = prompt.officialPrompt(new Set())
  const emptyArray = prompt.officialPrompt([])
  assert.equal(empty, omitted, 'an empty set rendered differently from an omitted one')
  assert.equal(emptyArray, omitted, 'an empty array rendered differently from an omitted one')
  // The standard set includes shell, write and edit, so all four strings must appear.
  for (const group of GUIDANCE) {
    for (const line of group.lines) {
      assert.ok(omitted.includes(line), `the standard render is missing a ${group.family} string`)
    }
  }
})

await check('a family whose tool is absent contributes nothing', () => {
  const onlyRead = prompt.officialPrompt(new Set(['read']))
  assert.ok(!onlyRead.includes('Prefer dedicated tools over shell commands'), 'shell guidance appeared without the shell tool')
  assert.ok(!onlyRead.includes('Use the write tool to create files'), 'write guidance appeared without the write tool')
  assert.ok(!onlyRead.includes('Use the edit tool for targeted changes'), 'edit guidance appeared without the edit tool')
})

await check('a declared family contributes its strings', () => {
  const withShell = prompt.officialPrompt(new Set(['shell']))
  assert.ok(withShell.includes('Prefer dedicated tools over shell commands'))
  assert.ok(!withShell.includes('Use the write tool to create files'), 'an undeclared family leaked in')
})

await check('the declared guidance order is shell, then write, then edit', () => {
  const all = prompt.officialPrompt(new Set(['shell', 'write', 'edit']))
  const shellAt = all.indexOf('Prefer dedicated tools over shell commands')
  const writeAt = all.indexOf('Use the write tool to create files')
  const editAt = all.indexOf('Use the edit tool for targeted changes')
  assert.ok(shellAt >= 0 && writeAt >= 0 && editAt >= 0, 'a family is missing from a full render')
  assert.ok(shellAt < writeAt && writeAt < editAt, 'the guidance order changed')
})

await check('rendering twice is stable', () => {
  const once = prompt.officialPrompt()
  const twice = prompt.officialPrompt()
  assert.equal(once, twice, 'the renderer is not deterministic')
})

// ── 6. delivery into builds ────────────────────────────────────────────────
for (const step of ASSET_DELIVERY) {
  await check(`${step.file} still carries both assets`, () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, step.file.replace(/\//g, path.sep)), 'utf8')
    for (const marker of step.evidence) {
      assert.ok(text.includes(marker), `${step.file} no longer mentions ${marker}`)
    }
  })
}

await check('the bundled asset source still inlines both assets', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'o2a', 'asset-source.js'), 'utf8')
  // Development form reads from disk; the build replaces this module. Either way the
  // two asset names must be reachable from it.
  assert.ok(/ofm-agent-context|OFFICIAL_PROMPT/.test(source), 'asset-source.js lost the prompt reference')
  assert.ok(/ofm-tool-contracts|OFFICIAL_TOOLS/.test(source), 'asset-source.js lost the tool-contract reference')
})

// ── 7. attribution honesty ─────────────────────────────────────────────────
await check('the assets are recorded as retained, not as original work', () => {
  assert.equal(ATTRIBUTION.retainedByUserInstruction, true)
  assert.equal(ATTRIBUTION.originalityClaim, false, 'the contract must not claim the retained text is original')
  assert.ok(ATTRIBUTION.detail.length > 40)
})

await check('the render rules cover the behaviours the gate exercised', () => {
  const ids = RENDER_RULES.map(rule => rule.id)
  for (const required of ['slot-always-filled', 'empty-selection-uses-standard-set', 'family-gating', 'group-order', 'marker-once']) {
    assert.ok(ids.includes(required), `render rule ${required} was dropped from the contract`)
  }
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`013-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`013-test: ${passed} checks passed — the retained OpenCode assets and render semantics are unchanged.\n`)
process.stdout.write('Scope reminder: the assets are retained by user instruction. This is not an originality claim and not a live OpenCode acceptance.\n')
