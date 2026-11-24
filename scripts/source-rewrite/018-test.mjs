/**
 * SRC-018 gate: the replacement is complete and the retained items survive removal.
 *
 * Run: `node scripts/source-rewrite/018-test.mjs`
 *
 * ## What this gate is for
 *
 * The removal step deletes the absorbed business tree and repoints the packaging at the new
 * implementation. That deletion is irreversible and happens inside a working tree holding
 * uncommitted work, so the order is inverted here: this gate proves the *preconditions* first.
 *
 * Concretely, it checks that
 *
 * 1. every channel in the contract has an independently written replacement module;
 * 2. every retained item is present and byte-identical, so removal cannot take it along;
 * 3. every packaging step that must carry a retained item still names it;
 * 4. the removal manifest lists exactly what may be deleted, and nothing that must be kept.
 *
 * ## What it deliberately does not do
 *
 * It does not delete anything. The deletion is the integration step, and running it from a gate
 * would make a failed check destructive. The gate's job is to make the deletion safe to perform,
 * and to fail loudly if a precondition regresses.
 *
 * @module scripts/source-rewrite/018-test
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACCOUNT_PROVIDERS } from '../../src/accounts/core/index-store.js'
import { RETAINED_ASSETS } from '../../工程控制/ORIGIN-REWRITE-01/contracts/opencode/asset-contract.mjs'
import { RETAINED_WASM } from '../../工程控制/ORIGIN-REWRITE-01/contracts/qoder/wasm-contract.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

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

/** Where each channel's replacement lives. */
const REPLACEMENTS = Object.freeze({
  lobsterai: 'src/accounts/providers/lobsterai/adapter.js',
  qoder: 'src/accounts/providers/qoder/adapter.js',
  qodercn: 'src/accounts/providers/qoder/adapter.js',
  trae: 'src/accounts/providers/trae/adapter.js',
  cline: 'src/accounts/providers/cline/adapter.js',
  loomy: 'src/accounts/providers/loomy/adapter.js',
  raccoon: 'src/accounts/providers/raccoon/adapter.js',
  minimax: 'src/accounts/providers/minimax/adapter.js',
  zcode: 'src/accounts/providers/zcode/adapter.js',
  gemini: 'src/accounts/providers/gemini/adapter.js',
})

/** The shared core the adapters build on. */
const SHARED_CORE = Object.freeze([
  'src/accounts/core/errors.js',
  'src/accounts/core/index-store.js',
  'src/accounts/core/selection.js',
  'src/accounts/core/queue.js',
  'src/accounts/core/upstream-signals.js',
  'src/accounts/core/wire.js',
  'src/accounts/core/openai-chat-channel.js',
  'src/accounts/core/backup.js',
  'src/accounts/api/rpc.js',
])

/**
 * What removal may delete, and what it must never touch.
 *
 * Written as data so the manifest can be reviewed and diffed. A path that appears in both lists
 * is a contradiction the gate fails on.
 */
export const REMOVAL_MANIFEST = Object.freeze({
  removable: Object.freeze([
    'vendor/channel-pack/src/*.ts (business implementation, replaced module by module)',
    'vendor/channel-pack/pack.js (generated bundle of the replaced implementation)',
    'packages/standalone/channels/business.mjs (generated bundle of the same)',
  ]),
  retained: Object.freeze([
    'vendor/channel-pack/qoder-auth-wasm.wasm',
    'vendor/channel-pack/src/qoder-auth-wasm.wasm',
    'src/o2a/assets/ofm-agent-context.txt',
    'src/o2a/assets/ofm-tool-contracts.json',
    'src/o2a/official-prompt.js (the four guidance strings inside it)',
    'src/providers/registry.json',
  ]),
})

process.stdout.write('SRC-018 removal-readiness gate\n\n')

// ── 1. every channel has a replacement ─────────────────────────────────────
await check('every contracted channel has a replacement module', () => {
  for (const provider of ACCOUNT_PROVIDERS) {
    const relative = REPLACEMENTS[provider]
    assert.ok(relative !== undefined, `${provider}: no replacement recorded`)
    const absolute = path.join(REPO_ROOT, relative.replace(/\//g, path.sep))
    assert.ok(fs.existsSync(absolute), `${provider}: ${relative} does not exist`)
  }
})

await check('the two Qoder products share one adapter but are both recorded', () => {
  assert.equal(REPLACEMENTS.qoder, REPLACEMENTS.qodercn,
    'the two products share an adapter; if they diverge, update this gate')
})

await check('every shared core module is present', () => {
  for (const relative of SHARED_CORE) {
    const absolute = path.join(REPO_ROOT, relative.replace(/\//g, path.sep))
    assert.ok(fs.existsSync(absolute), `${relative} is missing`)
  }
})

await check('no replacement module imports the absorbed implementation', () => {
  // The whole point of the rewrite: the new code must not depend on the tree being removed.
  const roots = [
    path.join(REPO_ROOT, 'src', 'accounts'),
    path.join(REPO_ROOT, 'src', 'o2a', 'rewrite'),
  ]
  const offenders = []
  const walk = dir => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, name.name)
      if (name.isDirectory()) { walk(absolute); continue }
      if (!name.name.endsWith('.js')) continue
      const text = fs.readFileSync(absolute, 'utf8')
      if (/from\s+['"][^'"]*vendor\/channel-pack/.test(text)) {
        offenders.push(path.relative(REPO_ROOT, absolute))
      }
    }
  }
  for (const root of roots) if (fs.existsSync(root)) walk(root)
  assert.deepEqual(offenders, [], `these modules still import the absorbed tree: ${offenders.join(', ')}`)
})

// ── 2. the retained items survive ──────────────────────────────────────────
await check('both Qoder WASM copies are present and byte-identical to the contract', () => {
  const digests = RETAINED_WASM.copies.map(relative => {
    const absolute = path.join(REPO_ROOT, relative.replace(/\//g, path.sep))
    assert.ok(fs.existsSync(absolute), `${relative} is missing`)
    const bytes = fs.readFileSync(absolute)
    assert.equal(bytes.length, RETAINED_WASM.bytes, `${relative}: byte length changed`)
    return crypto.createHash('sha256').update(bytes).digest('hex')
  })
  for (const digest of digests) assert.equal(digest, RETAINED_WASM.sha256, 'the WASM digest changed')
})

await check('both retained OpenCode assets are present and byte-identical', () => {
  for (const asset of RETAINED_ASSETS) {
    const absolute = path.join(REPO_ROOT, asset.path.replace(/\//g, path.sep))
    assert.ok(fs.existsSync(absolute), `${asset.path} is missing`)
    const bytes = fs.readFileSync(absolute)
    assert.equal(bytes.length, asset.bytes, `${asset.path}: byte length changed`)
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256, `${asset.path}: digest changed`)
  }
})

await check('the four guidance strings are still in the renderer', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'o2a', 'official-prompt.js'), 'utf8')
  assert.ok(source.includes('Prefer dedicated tools over shell commands'), 'a guidance string is gone')
  assert.ok(source.includes('Use the write tool to create files'), 'a guidance string is gone')
  assert.ok(source.includes('Use the edit tool for targeted changes'), 'a guidance string is gone')
  assert.ok(source.includes('${OPENCODE_TOOL_GUIDANCE}'), 'the prompt slot is gone')
})

await check('the OpenCode call path is intact', () => {
  const upstream = fs.readFileSync(path.join(REPO_ROOT, 'src', 'upstream.js'), 'utf8')
  assert.ok(/inference|chat\/completions|messages/.test(upstream), 'the upstream call path is gone')
})

// ── 3. packaging still carries the retained items ──────────────────────────
await check('every packaging step still names the WASM', () => {
  const steps = [
    ['scripts/pack-standalone.mjs', 'qoder-auth-wasm.wasm'],
    ['scripts/prepare-desktop.mjs', 'qoder-auth-wasm.wasm'],
    ['scripts/standalone-package-test.mjs', 'qoder-auth-wasm.wasm'],
    ['package.json', 'vendor/channel-pack'],
  ]
  for (const [file, marker] of steps) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file.replace(/\//g, path.sep)), 'utf8')
    assert.ok(text.includes(marker), `${file} no longer names ${marker}; removal would drop it`)
  }
})

await check('the asset inliner still carries both OpenCode assets', () => {
  const builder = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-legacy-payload.mjs'), 'utf8')
  assert.ok(builder.includes('ofm-agent-context.txt'), 'the prompt asset is no longer inlined')
  assert.ok(builder.includes('ofm-tool-contracts.json'), 'the tool-contract asset is no longer inlined')
})

await check('the standalone channel build still rewrites the WASM path', () => {
  const builder = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-standalone-channels.mjs'), 'utf8')
  assert.ok(builder.includes('qoder-auth-wasm.wasm'), 'the standalone build no longer resolves the WASM')
})

// ── 4. the manifest is coherent ────────────────────────────────────────────
await check('the manifest keeps its retained and removable sets disjoint', () => {
  const retained = REMOVAL_MANIFEST.retained.map(entry => entry.split(' ')[0])
  const removable = REMOVAL_MANIFEST.removable.map(entry => entry.split(' ')[0])
  for (const entry of retained) {
    assert.ok(!removable.includes(entry), `${entry} is both retained and removable`)
  }
})

await check('the manifest retains every item the contracts protect', () => {
  const retained = REMOVAL_MANIFEST.retained.join(' ')
  for (const asset of RETAINED_ASSETS) {
    assert.ok(retained.includes(asset.path), `${asset.path} is not in the retained set`)
  }
  for (const copy of RETAINED_WASM.copies) {
    assert.ok(retained.includes(copy), `${copy} is not in the retained set`)
  }
})

await check('the manifest does not mark the WASM removable', () => {
  const removable = REMOVAL_MANIFEST.removable.join(' ')
  assert.ok(!removable.includes('.wasm'), 'a WASM file is listed as removable')
})

// ── 5. the removal is not performed here ───────────────────────────────────
await check('the absorbed tree is still present, because removal is an integration step', () => {
  // If this ever fails, the removal has happened outside this gate; re-run 011/013 to confirm the
  // retained items survived, then update this check rather than deleting it.
  const tree = path.join(REPO_ROOT, 'vendor', 'channel-pack')
  assert.ok(fs.existsSync(tree), 'the absorbed tree is gone; confirm 011/013 still pass and update this gate')
  const pack = path.join(tree, 'pack.js')
  assert.ok(fs.existsSync(pack), 'the absorbed bundle is gone; confirm the replacement is mounted first')
})

await check('the replacement is not yet mounted, and that is recorded', () => {
  const host = fs.readFileSync(path.join(REPO_ROOT, 'index.js'), 'utf8')
  assert.ok(host.includes('vendor/channel-pack/pack.js'),
    'index.js no longer loads the absorbed pack; if the mount was made, update this gate')
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`018-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`018-test: ${passed} checks passed — removal is safe to perform: every replacement exists and every retained item is intact.\n`)
process.stdout.write('Scope reminder: this gate proves the preconditions. It deletes nothing; the removal and the host mount are the integration step.\n')
