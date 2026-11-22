/**
 * SRC-011 gate: the retained Qoder WASM still satisfies its frozen contract.
 *
 * Run: `node scripts/source-rewrite/011-test.mjs`
 *
 * ## What this proves
 *
 * That the retained binary is the one the contract names, that it still exports what the
 * bridge calls, that both copies a build mode needs are present and identical, and that
 * every load path the packaging uses still resolves. Compiling the module reads its
 * export/import tables; no code is executed, so no credential or network material is
 * touched.
 *
 * ## What this deliberately does not do
 *
 * It does not reimplement, reverse, or validate the cryptography, and it does not treat
 * retention as licence clearance. The redistribution basis stays `UNRESOLVED` and the
 * gate fails if the contract starts claiming otherwise.
 *
 * @module scripts/source-rewrite/011-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  BRIDGE_CONVENTIONS,
  hashRetainedCopy,
  IMPORT_MODULE,
  inspectRetainedWasm,
  LICENSE_STATUS,
  LOAD_PATHS,
  PACKAGING_STEPS,
  PRODUCT_SUPPORT,
  REPO_ROOT,
  REQUIRED_EXPORTS,
  RETAINED_WASM,
} from '../../工程控制/ORIGIN-REWRITE-01/contracts/qoder/wasm-contract.mjs'

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

process.stdout.write('SRC-011 retained-WASM gate\n\n')

// ── 1. bytes ───────────────────────────────────────────────────────────────
for (const copy of RETAINED_WASM.copies) {
  await check(`${copy}: bytes and sha256 match the frozen contract`, () => {
    const actual = hashRetainedCopy(copy)
    assert.equal(actual.bytes, RETAINED_WASM.bytes, `${actual.bytes} bytes, frozen ${RETAINED_WASM.bytes}`)
    assert.equal(actual.sha256, RETAINED_WASM.sha256, `sha256 ${actual.sha256} != frozen ${RETAINED_WASM.sha256}`)
  })
}

await check('both retained copies are byte-identical', () => {
  const [a, b] = RETAINED_WASM.copies.map(copy => hashRetainedCopy(copy))
  assert.equal(a.sha256, b.sha256, 'the two copies diverged; one build mode would run a different binary')
})

// ── 2. the binary still provides what the bridge calls ─────────────────────
const inspected = await inspectRetainedWasm()

await check('the module compiles and exposes a non-empty export table', () => {
  assert.ok(inspected.exports.length > 0)
  assert.ok(inspected.imports.length > 0)
})

for (const [name, role] of REQUIRED_EXPORTS) {
  await check(`export ${name} is present (${role})`, () => {
    const found = inspected.exports.find(entry => entry.name === name)
    assert.ok(found !== undefined, `the retained binary no longer exports ${name}`)
    assert.equal(found.kind, 'function', `${name} is now a ${found.kind}, not a function`)
  })
}

await check('the bridge conventions the adapter depends on are still recorded', () => {
  const ids = BRIDGE_CONVENTIONS.map(entry => entry.id)
  for (const required of ['reversed-getRandomValues', 'two-return-layouts', 'requestresult-url-arg-order', 'malloc-free-pairing']) {
    assert.ok(ids.includes(required), `bridge convention ${required} was dropped from the contract`)
  }
  for (const entry of BRIDGE_CONVENTIONS) {
    assert.ok(entry.detail.length > 20, `${entry.id} has no usable explanation`)
  }
})

await check('the import module name the glue must supply is recorded', () => {
  assert.equal(IMPORT_MODULE, './qoder_auth_wasm_bg.js')
})

await check('the binary imports from the module the glue provides', () => {
  // wasm-bindgen embeds the import module name; if a rebuild changed it the glue would
  // fail to instantiate with an unhelpful error.
  const modules = new Set(inspected.imports.map(entry => entry.module))
  assert.ok(modules.has(IMPORT_MODULE),
    `the binary imports from ${[...modules].join(', ')} — the glue supplies ${IMPORT_MODULE}`)
})

// ── 3. load paths and packaging still resolve ──────────────────────────────
for (const entry of LOAD_PATHS) {
  await check(`load path for ${entry.mode} resolves to an existing file`, () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, entry.resolvedFrom.replace(/\//g, path.sep))),
      `${entry.mode}: the resolving module ${entry.resolvedFrom} is missing`)
    assert.ok(fs.existsSync(path.join(REPO_ROOT, entry.resolvesTo.replace(/\//g, path.sep))),
      `${entry.mode}: ${entry.resolvesTo} does not exist, so this mode could not load the binary`)
  })
}

for (const step of PACKAGING_STEPS) {
  await check(`packaging step ${step.file} still names the binary`, () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, step.file.replace(/\//g, path.sep)), 'utf8')
    // package.json ships the whole directory, so the directory name is the right marker there.
    const marker = step.file === 'package.json' ? 'vendor/channel-pack' : 'qoder-auth-wasm.wasm'
    assert.ok(text.includes(marker),
      `${step.file} no longer mentions ${marker}; ${step.kind} would drop the binary`)
  })
}

// ── 4. per-product support is recorded separately ──────────────────────────
await check('both Qoder products are recorded, separately, sharing the binary', () => {
  assert.equal(PRODUCT_SUPPORT.length, 2)
  const qoder = PRODUCT_SUPPORT.find(entry => entry.provider === 'qoder')
  const cn = PRODUCT_SUPPORT.find(entry => entry.provider === 'qodercn')
  assert.ok(qoder !== undefined && cn !== undefined, 'one of the two products is missing')
  assert.notEqual(qoder.authBase, cn.authBase, 'the two products must not share an auth host')
  assert.notEqual(qoder.encryptedInferBase, cn.encryptedInferBase, 'the two products must not share an inference host')
  assert.equal(qoder.liveAcceptance, 'NOT_RUN', 'live acceptance must not be claimed')
  assert.equal(cn.liveAcceptance, 'NOT_RUN', 'live acceptance must not be claimed')
})

await check('the model row counts match the frozen channel contract', () => {
  const contracts = JSON.parse(fs.readFileSync(path.join(
    REPO_ROOT, '工程控制', 'ORIGIN-REWRITE-01', 'contracts', 'baseline-20261122', 'channel-contracts.json',
  ), 'utf8'))
  for (const entry of PRODUCT_SUPPORT) {
    const product = contracts.products.find(row => row.id === entry.provider)
    assert.ok(product !== undefined, `${entry.provider} missing from the channel contract`)
    assert.equal(product.models.length, entry.modelRows,
      `${entry.provider}: contract has ${product.models.length} rows, WASM contract claims ${entry.modelRows}`)
  }
})

// ── 5. licence honesty ─────────────────────────────────────────────────────
await check('retention is recorded as an instruction, not as a licence clearance', () => {
  assert.equal(LICENSE_STATUS.retainedByUserInstruction, true)
  assert.equal(LICENSE_STATUS.redistributionBasis, 'UNRESOLVED',
    'the redistribution basis must stay UNRESOLVED until it is actually established')
  assert.ok(LICENSE_STATUS.detail.length > 40)
})

await check('no file in the contract claims the WASM may be redistributed', () => {
  const dir = path.join(REPO_ROOT, '工程控制', 'ORIGIN-REWRITE-01', 'contracts', 'qoder')
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    assert.ok(!/redistribution (?:is |has been )?(?:cleared|confirmed|approved)/i.test(text),
      `${name} claims redistribution is cleared`)
  }
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`011-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`011-test: ${passed} checks passed — the retained WASM matches its contract.\n`)
process.stdout.write('Scope reminder: the binary is retained by user instruction. This gate proves it still fits the bridge; it is not a licence clearance and not a live-acceptance result.\n')
