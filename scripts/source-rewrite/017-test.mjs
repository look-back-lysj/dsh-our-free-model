/**
 * SRC-017 gate: the dependency register is complete, honest and still accurate.
 *
 * Run: `node scripts/source-rewrite/017-test.mjs`
 *
 * ## What this proves
 *
 * That every carried third-party artifact is classified, that each entry's evidence still
 * exists, that every artifact the register names is actually present, that the user's retained
 * items are marked as retained rather than as original work, and that nothing claims a
 * redistribution clearance it does not have.
 *
 * ## What it deliberately does not prove
 *
 * That redistribution is permitted. An entry with `UNRESOLVED` stays unresolved until a real
 * basis is established, and this gate fails if that marker is quietly replaced with a clearance.
 *
 * @module scripts/source-rewrite/017-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEPENDENCIES,
  missingArtifacts,
  missingEvidence,
  NOT_DEPENDENCIES,
  REPO_ROOT,
  USAGE_CLASSES,
} from '../../工程控制/ORIGIN-REWRITE-01/contracts/dependencies/register.mjs'

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

process.stdout.write('SRC-017 dependency-boundary gate\n\n')

// ── 1. structural completeness ─────────────────────────────────────────────
await check('every entry has an id, a known usage class and at least one path', () => {
  const ids = new Set()
  for (const entry of DEPENDENCIES) {
    assert.equal(typeof entry.id, 'string', `an entry has no id: ${JSON.stringify(entry)}`)
    assert.ok(entry.id.length > 0)
    assert.ok(!ids.has(entry.id), `duplicate id: ${entry.id}`)
    ids.add(entry.id)
    assert.ok(USAGE_CLASSES.includes(entry.usage), `${entry.id}: unknown usage class ${entry.usage}`)
    assert.ok(Array.isArray(entry.paths) && entry.paths.length > 0, `${entry.id}: no paths`)
    assert.equal(typeof entry.evidence, 'string', `${entry.id}: no evidence pointer`)
  }
})

await check('every entry records a licence basis and a handling note', () => {
  for (const entry of DEPENDENCIES) {
    assert.equal(typeof entry.licenceBasis, 'string', `${entry.id}: no licence basis`)
    assert.ok(entry.licenceBasis.length > 0)
    assert.equal(typeof entry.licenceNote, 'string', `${entry.id}: no licence note`)
    assert.ok(entry.licenceNote.length > 30, `${entry.id}: the licence note is too thin to be useful`)
    assert.equal(typeof entry.handling, 'string', `${entry.id}: no handling note`)
    assert.ok(entry.handling.length > 10, `${entry.id}: the handling note is too thin to be useful`)
  }
})

await check('every entry states whether it is retained by user instruction', () => {
  for (const entry of DEPENDENCIES) {
    assert.equal(typeof entry.retainedByUserInstruction, 'boolean', `${entry.id}: retention is unstated`)
  }
})

// ── 2. the retained items are the ones the user named ──────────────────────
await check('the user\'s retained items are all present and marked retained', () => {
  const retained = new Set(DEPENDENCIES.filter(entry => entry.retainedByUserInstruction).map(entry => entry.id))
  for (const id of ['qoder-auth-wasm', 'opencode-system-prompt', 'opencode-tool-contracts', 'opencode-tool-guidance']) {
    assert.ok(retained.has(id), `${id} must be recorded as retained by user instruction`)
  }
})

await check('Magpie is recorded as excluded, not as something to rewrite', () => {
  const magpie = DEPENDENCIES.find(entry => entry.id === 'magpie-engine')
  assert.ok(magpie !== undefined, 'Magpie is missing from the register')
  assert.equal(magpie.licenceBasis, 'EXCLUDED')
  assert.match(magpie.handling, /Untouched/)
})

await check('the OpenCode assets record the MIT basis, not an originality claim', () => {
  for (const id of ['opencode-system-prompt', 'opencode-tool-contracts', 'opencode-tool-guidance']) {
    const entry = DEPENDENCIES.find(candidate => candidate.id === id)
    assert.equal(entry.licenceBasis, 'MIT', `${id}: the licence basis is not recorded as MIT`)
    assert.match(entry.licenceNote, /verbatim|Verbatim|attribution/i, `${id}: the note does not say the content is upstream`)
  }
})

await check('the Qoder WASM basis stays UNRESOLVED', () => {
  const wasm = DEPENDENCIES.find(entry => entry.id === 'qoder-auth-wasm')
  assert.equal(wasm.licenceBasis, 'UNRESOLVED',
    'the WASM redistribution basis must stay UNRESOLVED until it is actually established')
  assert.match(wasm.licenceNote, /not a redistribution clearance/i,
    'the note must say retention is not a clearance')
})

await check('no entry claims a clearance it does not have', () => {
  const overclaim = /(?:redistribution|redistribute|shipping)\s+(?:is|has been)\s+(?:cleared|approved|confirmed)/i
  for (const entry of DEPENDENCIES) {
    assert.ok(!overclaim.test(`${entry.licenceNote} ${entry.handling}`), `${entry.id} claims a clearance`)
  }
})

// ── 3. evidence and artifacts still exist ──────────────────────────────────
await check('every evidence pointer resolves', () => {
  const missing = missingEvidence()
  assert.deepEqual(missing, [], missing.join('\n'))
})

await check('every non-build artifact the register names is present', () => {
  const { missing } = missingArtifacts()
  assert.deepEqual(missing, [], missing.join('\n'))
})

await check('the two Qoder WASM copies are both present and identical', async () => {
  const crypto = await import('node:crypto')
  const wasm = DEPENDENCIES.find(entry => entry.id === 'qoder-auth-wasm')
  const digests = wasm.paths.map(relative => crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(REPO_ROOT, relative.replace(/\//g, path.sep))))
    .digest('hex'))
  assert.equal(digests[0], digests[1], 'the two WASM copies diverged')
})

await check('the retained OpenCode assets match the frozen digests', async () => {
  const crypto = await import('node:crypto')
  const contracts = JSON.parse(fs.readFileSync(path.join(
    REPO_ROOT, '工程控制', 'ORIGIN-REWRITE-01', 'contracts', 'baseline-20261122', 'channel-contracts.json',
  ), 'utf8'))
  for (const entry of DEPENDENCIES.filter(row => row.id.startsWith('opencode-'))) {
    if (entry.id === 'opencode-tool-guidance') continue
    for (const relative of entry.paths) {
      const pinned = contracts.protectedInputs.find(row => row.path === relative)
      assert.ok(pinned !== undefined, `${relative} is not pinned in the channel contract`)
      const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(REPO_ROOT, relative.replace(/\//g, path.sep))))
        .digest('hex')
      assert.equal(actual, pinned.sha256, `${relative}: digest drift`)
    }
  }
})

// ── 4. the negative list ───────────────────────────────────────────────────
await check('the negative list covers the things most likely to be over-claimed', () => {
  const whats = NOT_DEPENDENCIES.map(entry => entry.what).join(' ')
  for (const marker of ['protocol', 'model ids', 'status codes']) {
    assert.ok(whats.toLowerCase().includes(marker), `the negative list omits ${marker}`)
  }
  for (const entry of NOT_DEPENDENCIES) {
    assert.ok(entry.why.length > 20, `the reason for excluding "${entry.what}" is too thin`)
  }
})

// ── 5. the register's own file domain ──────────────────────────────────────
await check('the register lives in its declared file domain', () => {
  const dir = path.join(REPO_ROOT, '工程控制', 'ORIGIN-REWRITE-01', 'contracts', 'dependencies')
  assert.ok(fs.existsSync(dir))
  const files = fs.readdirSync(dir).sort()
  assert.deepEqual(files, ['register.mjs'], `unexpected files: ${files.join(', ')}`)
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`017-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`017-test: ${passed} checks passed — the dependency register is complete and honest.\n`)
process.stdout.write('Scope reminder: this proves the register is accurate. It does not prove redistribution is permitted for anything marked UNRESOLVED.\n')
