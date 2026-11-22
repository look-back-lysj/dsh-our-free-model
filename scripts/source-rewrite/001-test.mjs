/**
 * SRC-001 gate: freeze a real baseline and prove the frozen contract still matches
 * the code it describes.
 *
 * Run: `node scripts/source-rewrite/001-test.mjs`
 *
 * ## What this proves, and what it does not
 *
 * It proves the baseline is real rather than asserted:
 *   - the 76-provider / 507-model-id registry snapshot was generated from the
 *     actual loader and still matches it;
 *   - the RPC surface frozen in the contract equals the dispatch switch, both
 *     directions, with no extra and no missing method;
 *   - every channel's frozen model id list equals the source table, in order, and
 *     every frozen capability field matches what the source declares — including
 *     the *absence* of a field, so a guess cannot slip in as `false`;
 *   - the ordered error classifiers are *executed* against priority probes, not
 *     read;
 *   - every `file:line` citation exists and still contains its quoted anchor;
 *   - every protected input's bytes and SHA-256 match;
 *   - every known red light still reproduces, so nobody can mark it fixed by
 *     editing the contract.
 *
 * It does NOT prove any rewrite happened, that live endpoints accept us, or that a
 * real account works. Those are SRC-002..020. A pass here means "the baseline is
 * trustworthy", nothing more.
 *
 * Exit code 0 = every check passed. Any failure exits 1 and names the check.
 *
 * @module scripts/source-rewrite/001-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  REPO_ROOT,
  BASELINE_DIR,
  ACCOUNT_PROVIDERS,
  buildProviderRegistrySnapshot,
  checkCitations,
  extractChannelModels,
  extractErrorClassifierProbes,
  extractRpcMethods,
  missingSourceFiles,
  readChannelContracts,
  validateChannelContracts,
} from './contracts.mjs'

const failures = []
let passed = 0

/**
 * Run one named check. A thrown error or a rejected promise is a failure with the
 * thrown message; anything else counts as a pass.
 *
 * @param {string} name
 * @param {() => unknown | Promise<unknown>} body
 */
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

/** Run a child Node command and return { code, stdout, stderr }. */
function runNode(args) {
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return { code: error?.status ?? 1, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? '') }
  }
}

process.stdout.write('SRC-001 baseline gate\n\n')

// ── 0. the sources the contract describes must be present ───────────────────
await check('every required channel-pack source file exists', () => {
  const missing = missingSourceFiles()
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`)
})

// ── 1. registry snapshot is real and current ────────────────────────────────
const snapshotPath = path.join(BASELINE_DIR, 'provider-registry-ids.json')
await check('provider-registry-ids.json is a real snapshot, not a placeholder', () => {
  const raw = fs.readFileSync(snapshotPath, 'utf8')
  assert.ok(raw.trim().length > 1000, `snapshot is only ${raw.trim().length} bytes — looks like the 1-byte placeholder`)
  const snapshot = JSON.parse(raw)
  assert.equal(typeof snapshot.providerCount, 'number')
  assert.ok(Array.isArray(snapshot.providers) && snapshot.providers.length > 0)
})

await check('registry snapshot still matches the live loader (76 providers / 507 model ids)', async () => {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
  const live = await buildProviderRegistrySnapshot()
  assert.equal(snapshot.providerCount, 76, `snapshot says ${snapshot.providerCount} providers, expected 76`)
  assert.equal(snapshot.modelCount, 507, `snapshot says ${snapshot.modelCount} model ids, expected 507`)
  assert.equal(live.providerCount, 76, `live loader now reports ${live.providerCount} providers`)
  assert.equal(live.modelCount, 507, `live loader now reports ${live.modelCount} model ids`)
  assert.deepEqual(
    snapshot.providers.map(provider => provider.id),
    live.providers.map(provider => provider.id),
    'provider id list drifted from the snapshot',
  )
  assert.deepEqual(
    snapshot.providers.map(provider => provider.modelIds),
    live.providers.map(provider => provider.modelIds),
    'a provider model-id list drifted from the snapshot',
  )
})

// ── 2. contract loads and validates against the sources ─────────────────────
const { data: doc } = readChannelContracts()
const models = await extractChannelModels()
const rpc = extractRpcMethods()

await check('RPC switch parses to exactly 45 handled methods', () => {
  assert.equal(rpc.methods.length, 45, `parsed ${rpc.methods.length}: ${rpc.methods.join(', ')}`)
  assert.equal(new Set(rpc.methods).size, 45, 'duplicate case labels in the switch')
})

await check('channel-contracts.json validates against the live sources', () => {
  const problems = validateChannelContracts(doc, { models, rpcMethods: rpc.methods })
  assert.deepEqual(problems, [], problems.join('\n'))
})

await check('the ten account providers are frozen in declaration order', () => {
  assert.deepEqual(doc.accountProviderIds, ACCOUNT_PROVIDERS)
  assert.equal(doc.products.length, 10)
  assert.deepEqual(doc.products.map(product => product.id), ACCOUNT_PROVIDERS)
})

// ── 3. per-channel model parity, spelled out so a failure is legible ────────
for (const provider of ACCOUNT_PROVIDERS) {
  await check(`${provider}: frozen model ids equal the source table, in order`, () => {
    const product = doc.products.find(entry => entry.id === provider)
    assert.ok(product !== undefined, `no product entry for ${provider}`)
    assert.deepEqual(product.modelIds, models[provider].map(row => row.id))
    assert.deepEqual(product.models.map(row => row.id), product.modelIds, 'models[] and modelIds[] disagree')
  })
}

// ── 4. error classifiers are executed, not merely cited ─────────────────────
const probes = await extractErrorClassifierProbes()
for (const [family, group] of Object.entries(probes)) {
  for (const probe of group.probes) {
    await check(`${family}: ${probe.label}`, () => {
      assert.equal(probe.actual, probe.expected, `expected ${probe.expected}, classifier answered ${probe.actual}`)
    })
  }
}

// ── 5. citations still point at the lines they quote ────────────────────────
await check('every channel citation exists and still contains its quoted anchor', () => {
  /** @type {Array<{cite: string, anchor?: string}>} */
  const entries = []
  for (const product of doc.products) {
    for (const entry of product.sourceEvidence) {
      entries.push(typeof entry === 'string' ? { cite: entry } : { cite: entry.cite, anchor: entry.anchor })
    }
  }
  const bad = checkCitations(entries).filter(result => !result.ok)
  assert.deepEqual(bad, [], bad.map(result => `${result.cite}: ${result.reason}`).join('\n'))
  assert.ok(entries.length >= 50, `only ${entries.length} citations — the contract looks thin`)
})

await check('every shared-contract citation exists', () => {
  const cites = [
    ...(doc.sharedDataContract?.references ?? []),
    ...(doc.sharedRuntimeContract?.evidence ?? []),
  ].flatMap(entry => String(entry).split(/,(?=\s*[a-z])/).map(part => part.trim()))
  const bad = checkCitations(cites.map(cite => ({ cite }))).filter(result => !result.ok)
  assert.deepEqual(bad, [], bad.map(result => `${result.cite}: ${result.reason}`).join('\n'))
})

// ── 6. protected inputs are byte-identical ──────────────────────────────────
await check('every protected input matches its frozen bytes and SHA-256', async () => {
  const crypto = await import('node:crypto')
  for (const entry of doc.protectedInputs) {
    const absolute = path.join(REPO_ROOT, entry.path.replace(/\//g, path.sep))
    const bytes = fs.readFileSync(absolute)
    assert.equal(bytes.length, entry.bytes, `${entry.path}: ${bytes.length} bytes, frozen ${entry.bytes}`)
    const digest = crypto.createHash('sha256').update(bytes).digest('hex')
    assert.equal(digest, entry.sha256, `${entry.path}: sha256 ${digest} != frozen ${entry.sha256}`)
  }
})

await check('the two Qoder WASM copies are still the same binary', () => {
  const a = fs.readFileSync(path.join(REPO_ROOT, 'vendor/channel-pack/qoder-auth-wasm.wasm'))
  const b = fs.readFileSync(path.join(REPO_ROOT, 'vendor/channel-pack/src/qoder-auth-wasm.wasm'))
  assert.equal(a.length, b.length, 'the two WASM copies differ in length')
  assert.ok(a.equals(b), 'the two WASM copies differ in content')
})

await check('the retained OpenCode assets are still referenced by the build', () => {
  const builder = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-legacy-payload.mjs'), 'utf8')
  assert.ok(builder.includes('ofm-agent-context.txt'), 'build-legacy-payload no longer inlines the system prompt')
  assert.ok(builder.includes('ofm-tool-contracts.json'), 'build-legacy-payload no longer inlines the tool contracts')
})

// ── 7. known red lights still reproduce ─────────────────────────────────────
const redLights = new Map((doc.knownFailures ?? []).map(red => [red.id, red]))

await check('red light OR-011-core-bundle-source-drift is fixed on both sides', () => {
  const red = redLights.get('OR-011-core-bundle-source-drift')
  assert.ok(red !== undefined, 'the core drift red light was removed from the contract')
  assert.equal(red.status, 'FIXED_IN_SOURCE_AND_BUNDLE', 'the drift was repaired on 2026-11-22; the contract must say so')
  // Re-derive the direction rather than trusting the contract's prose. The two
  // call shapes still differ — that is why `idsOnly` exists — but the sealed
  // roster now uses the one that works.
  const result = runNode(['--input-type=module', '-e', `
    import { parseListing, buildEacCatalog } from './src/catalog.js'
    const payload = { data: [{ id: 'a/b' }] }
    const whole = buildEacCatalog(parseListing(payload)).map(entry => entry.id)
    const ids = buildEacCatalog(parseListing(payload, { idsOnly: true })).map(entry => entry.id)
    process.stdout.write(JSON.stringify({ whole, ids }))
  `])
  assert.equal(result.code, 0, `probe failed: ${result.stderr}`)
  const { whole, ids } = JSON.parse(result.stdout)
  // `buildEacCatalog` unwraps a row defensively, so a caller that forgets
  // `idsOnly` no longer collapses the roster to one bogus entry.
  assert.deepEqual(whole, ['a/b'], 'a whole row no longer unwraps — the defensive path regressed')
  assert.deepEqual(ids, ['a/b'], 'idsOnly no longer yields bare ids — re-examine the red light')
  // Both sides must now agree, and the generated bundle must be the source's
  // output rather than a hand edit.
  const bundle = fs.readFileSync(path.join(REPO_ROOT, 'src', 'core.js'), 'utf8')
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'core', 'runtime.js'), 'utf8')
  assert.ok(bundle.includes('{ idsOnly: true }'), 'src/core.js no longer passes idsOnly')
  assert.ok(source.includes('{ idsOnly: true }'), 'src/core/runtime.js stopped passing idsOnly — the drift is back')
})

await check('red light OR-011-gateway-scoped-key-forwarding still fails as recorded', () => {
  const red = redLights.get('OR-011-gateway-scoped-key-forwarding')
  assert.ok(red !== undefined, 'the scoped-key red light was removed from the contract')
  assert.equal(red.status, 'KNOWN_FAILURE_BEFORE_REWRITE')
  const result = runNode(['scripts/gateway-key-forward-test.mjs'])
  assert.notEqual(result.code, 0, 'the scoped-key forwarding test now passes — the red light is stale, update the contract')
  assert.match(result.stderr, /401 !== 200/, `failure is no longer the recorded 401 !== 200:\n${result.stderr.slice(0, 400)}`)
  assert.match(result.stderr, /gateway-key-forward-test\.mjs:36/, 'the failure moved; re-examine before updating the contract')
})

await check('red light SRC-001-opencode-tool-name-restore is fixed in the shipped resolver', () => {
  const red = redLights.get('SRC-001-opencode-tool-name-restore')
  assert.ok(red !== undefined, 'the tool-name red light was removed from the contract')
  assert.equal(red.status, 'FIXED_IN_SOURCE_AND_BUNDLE', 'the tool-name restore was repaired on 2026-11-22; the contract must say so')
  const result = runNode(['--input-type=module', '-e', `
    import { ToolRenameMap } from './src/o2a/tool-renames.js'
    const map = new ToolRenameMap()
    map.add('local_tool', 'mcp_0123456789ab')
    process.stdout.write(JSON.stringify({
      mapped: map.resolve('mcp_0123456789ab'),
      external: map.resolve('mcp__github__search'),
      orphan: map.resolve('mcp_bbbbbbbbbbbb'),
    }))
  `])
  assert.equal(result.code, 0, `probe failed: ${result.stderr}`)
  const actual = JSON.parse(result.stdout)
  assert.equal(actual.mapped, 'local_tool', 'the mapped name no longer round-trips')
  // A genuine MCP name must survive whole; stripping the namespace turned it
  // into `_github__search`, a tool the caller never declared.
  assert.equal(actual.external, 'mcp__github__search', 'a real mcp__ name is still being stripped')
  assert.equal(actual.orphan, 'mcp_bbbbbbbbbbbb', 'an unmatched handle must pass through, not lose its namespace')
  // The shipped bundle must carry the same behaviour, or the release still has
  // the defect even though the source module is clean.
  const bundle = fs.readFileSync(path.join(REPO_ROOT, 'src', 'o2a.js'), 'utf8')
  assert.ok(bundle.includes('isWireToolName(wire)'), 'src/o2a.js was not regenerated from the fixed resolver')
})

await check('red light SRC-001-minimax-sse-abort-not-honoured still reproduces', () => {
  const red = redLights.get('SRC-001-minimax-sse-abort-not-honoured')
  assert.ok(red !== undefined, 'the minimax abort red light was removed from the contract')
  assert.equal(red.status, 'KNOWN_FAILURE_BEFORE_REWRITE')
  const file = path.join(REPO_ROOT, 'vendor', 'channel-pack', 'src', 'minimax-messages.ts')
  const source = fs.readFileSync(file, 'utf8')
  const signalUses = source.match(/signal/g) ?? []
  assert.equal(signalUses.length, 1, `expected exactly one "signal" mention (the unused declaration), found ${signalUses.length} — the consumer may now honour abort, update the contract`)
})

// ── 8. the two lanes stay separate contracts ───────────────────────────────
await check('a name shared by the registry and the account channels is still two different contracts', async () => {
  // `minimax` and `gemini` exist in BOTH namespaces, which is exactly the hazard
  // HANDOFF.md calls out. The invariant is not "no shared names" — it is that a
  // shared name must denote a genuinely different endpoint, wire and auth, so no
  // caller can treat the aggregate record as the account channel or vice versa.
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
  const registry = new Map(snapshot.providers.map(provider => [provider.id, provider]))
  // The snapshot freezes ids and model lists only, so the endpoint comparison
  // reads the live loader rather than assuming the snapshot carries baseUrl.
  const liveRegistry = new Map(
    (await buildProviderRegistrySnapshot({ includeEndpoints: true })).providers.map(provider => [provider.id, provider]),
  )
  const shared = ACCOUNT_PROVIDERS.filter(id => registry.has(id))
  const allowed = new Set(['minimax', 'gemini'])
  assert.deepEqual(
    shared.filter(id => !allowed.has(id)), [],
    `new name collision between the registry and the account channels: ${shared.join(', ')}`,
  )
  const registryFormats = new Map(snapshot.providers.map(provider => [provider.id, provider.format]))
  for (const id of shared) {
    const product = doc.products.find(entry => entry.id === id)
    assert.ok(product !== undefined, `${id}: missing account-channel contract entry`)
    const accountHosts = Object.values(product.endpoints).map(url => new URL(url).host)
    const registryBase = liveRegistry.get(id)?.baseUrl
    assert.equal(typeof registryBase, 'string', `${id}: registry entry has no baseUrl to compare`)
    const registryHost = new URL(registryBase).host
    assert.ok(
      !accountHosts.includes(registryHost),
      `${id}: the account channel and the registry entry now share host ${registryHost} — re-check whether these are still two contracts`,
    )
    assert.notEqual(
      registryFormats.get(id), product.wire,
      `${id}: the registry wire (${registryFormats.get(id)}) and the account wire (${product.wire}) now match — re-check`,
    )
  }
})

await check('the registry does not carry an opencode account provider', () => {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
  const registryIds = new Set(snapshot.providers.map(provider => provider.id))
  assert.ok(!registryIds.has('opencode'), 'opencode appeared in the 76-provider registry; the free lane and the account channels are separate')
  assert.equal(doc.opencodeAccountProvider?.inSourceTable, true, 'the contract should still record that opencode is in the source account table')
  assert.equal(doc.opencodeAccountProvider?.enabledInHost, false, 'the contract should still record that opencode is disabled in this host')
})

// ── 9. the offline baseline that already existed is still green ────────────
await check('registry-test.mjs still reports 76 providers / 507 model ids', () => {
  const result = runNode(['scripts/registry-test.mjs'])
  assert.equal(result.code, 0, `registry-test failed:\n${result.stderr.slice(0, 800)}`)
  assert.match(result.stdout, /76 providers, 507 model ids/, `unexpected registry-test summary:\n${result.stdout.slice(-300)}`)
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`001-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.stdout.write('\nThis gate only freezes the baseline. A failure here means the contract and the code disagree, not that a rewrite regressed.\n')
  process.exit(1)
}
process.stdout.write(`001-test: ${passed} checks passed — baseline frozen, contract matches the sources.\n`)
process.stdout.write('Scope reminder: this proves the baseline is trustworthy. It does not prove any rewrite, live endpoint or real account works.\n')
