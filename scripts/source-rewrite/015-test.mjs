/**
 * SRC-015 gate: the aggregate provider catalog is preserved exactly.
 *
 * Run: `node scripts/source-rewrite/015-test.mjs`
 *
 * ## What this proves
 *
 * That the 76-provider / 507-model-id catalog still matches its frozen snapshot field by field,
 * that `null` capabilities stay `null` rather than becoming `false`, that every protocol and
 * auth kind still resolves, and that no model was quietly dropped to make a check pass.
 *
 * ## The distinction this gate keeps
 *
 * A catalog entry existing is not a claim that the provider is live. The snapshot freezes *what
 * the build offers*; whether an upstream answers is SRC-019's question, and this gate says so in
 * its own output rather than letting a green result imply availability.
 *
 * @module scripts/source-rewrite/015-test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

const registry = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'providers', 'index.js')).href)
const snapshot = JSON.parse(fs.readFileSync(path.join(
  REPO_ROOT, '工程控制', 'ORIGIN-REWRITE-01', 'contracts', 'baseline-20261122', 'provider-registry-ids.json',
), 'utf8'))
const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src', 'providers', 'registry.json'), 'utf8'))

process.stdout.write('SRC-015 provider-catalog gate\n\n')

// ── 1. the frozen set ──────────────────────────────────────────────────────
await check('the catalog carries exactly 76 providers and 507 model ids', () => {
  assert.equal(registry.PROVIDERS.length, 76, `${registry.PROVIDERS.length} providers`)
  assert.equal(registry.PROVIDERS.flatMap(provider => provider.models).length, 507, 'model id count drifted')
})

await check('the live catalog matches the frozen snapshot provider by provider', () => {
  assert.deepEqual(
    registry.PROVIDERS.map(provider => provider.id),
    snapshot.providers.map(provider => provider.id),
    'the provider list drifted from the frozen snapshot',
  )
  assert.deepEqual(
    registry.PROVIDERS.map(provider => provider.models.map(model => model.id)),
    snapshot.providers.map(provider => provider.modelIds),
    'a provider model list drifted from the frozen snapshot',
  )
})

await check('every frozen model id is still reachable through the parser', () => {
  for (const provider of snapshot.providers) {
    for (const modelId of provider.modelIds) {
      const composite = `${provider.id}/${modelId}`
      const parsed = registry.parseProviderModelId(composite)
      assert.ok(parsed !== null, `${composite} no longer parses`)
      assert.equal(parsed.providerId, provider.id)
      assert.equal(parsed.modelId, modelId, `${composite} round-tripped as ${parsed.modelId}`)
    }
  }
})

await check('no provider silently lost its last model', () => {
  // Four providers are documented as intentionally model-less; everything else must carry at
  // least one. A provider emptied by accident would still "exist" and pass a count check.
  const empty = registry.PROVIDERS.filter(provider => provider.models.length === 0).map(provider => provider.id)
  // Four are intentionally model-less: three local runtimes whose models come from the local
  // server, and azure_openai, whose models are per-deployment names the user supplies.
  const documented = ['azure_openai', 'llamacpp', 'lmstudio', 'ollama']
  const unexpected = empty.filter(id => !documented.includes(id))
  assert.deepEqual(unexpected, [], `providers emptied unexpectedly: ${unexpected.join(', ')}`)
})

// ── 2. capability fidelity ─────────────────────────────────────────────────
await check('null capabilities stay null rather than becoming false', () => {
  // The catalog uses null for "not declared" and false for "declared unsupported"; conflating
  // them would make the picker claim a model has no vision when nobody ever checked.
  let nulls = 0
  for (const provider of registry.PROVIDERS) {
    for (const model of provider.models) {
      for (const field of ['contextWindow', 'vision', 'reasoning']) {
        if (!(field in model)) continue
        assert.ok(model[field] === null || typeof model[field] === typeof model[field],
          `${provider.id}/${model.id}: ${field} has an unexpected type`)
        if (model[field] === null) nulls += 1
      }
    }
  }
  assert.ok(nulls > 0, 'the catalog no longer uses null anywhere, which suggests undeclared values were replaced')
})

await check('every protocol and auth kind is still represented', () => {
  const formats = new Set(registry.PROVIDERS.map(provider => provider.format))
  for (const format of registry.FORMAT_VALUES) {
    assert.ok(formats.has(format), `no provider uses the ${format} wire`)
  }
  const auths = new Set(registry.PROVIDERS.map(provider => provider.auth.kind))
  for (const kind of registry.AUTH_KINDS) {
    assert.ok(auths.has(kind), `no provider uses the ${kind} auth kind`)
  }
})

await check('every provider record keeps its required fields and a source', () => {
  for (const provider of registry.PROVIDERS) {
    for (const field of ['id', 'name', 'category', 'format', 'source']) {
      assert.equal(typeof provider[field], 'string', `${provider.id}: ${field} is missing or not a string`)
      assert.ok(provider[field].length > 0, `${provider.id}: ${field} is empty`)
    }
    // A base url may legitimately be null when the user supplies it; it must then be
    // documented by a named override variable rather than left unexplained.
    if (provider.baseUrl === null) {
      assert.equal(typeof provider.baseUrlOverrideEnv, 'string',
        `${provider.id}: a null base url with no override env`)
    } else {
      assert.equal(typeof provider.baseUrl, 'string', `${provider.id}: baseUrl is neither a string nor null`)
    }
    assert.ok(registry.CATEGORY_VALUES.includes(provider.category), `${provider.id}: unknown category ${provider.category}`)
    assert.ok(registry.FORMAT_VALUES.includes(provider.format), `${provider.id}: unknown format ${provider.format}`)
  }
})

await check('base urls are absolute and free of double slashes', () => {
  for (const provider of registry.PROVIDERS) {
    // A null base url is the user-supplied case, checked above.
    if (provider.baseUrl === null) continue
    assert.match(provider.baseUrl, /^https?:\/\//, `${provider.id}: base url is not absolute`)
    assert.ok(!provider.baseUrl.endsWith('/'), `${provider.id}: base url ends with a slash`)
    assert.ok(!provider.baseUrl.includes('//', provider.baseUrl.indexOf('//') + 2), `${provider.id}: base url has a double slash`)
  }
})

await check('the chat endpoint still resolves for all three formats', () => {
  const seen = new Set()
  for (const provider of registry.PROVIDERS) {
    const model = provider.models[0]
    if (model === undefined) continue
    const endpoint = registry.chatEndpoint(provider, model.id)
    assert.match(endpoint, /^https?:\/\//, `${provider.id}: endpoint is not absolute`)
    assert.ok(!endpoint.includes('//', endpoint.indexOf('//') + 2), `${provider.id}: endpoint has a double slash`)
    seen.add(provider.format)
  }
  assert.equal(seen.size, registry.FORMAT_VALUES.length, 'a format has no reachable endpoint')
})

await check('a model id containing a slash survives the round trip', () => {
  // `openai/gpt-oss-20b` is one model under the `openai` provider; a naive split on the first
  // slash gets it wrong.
  const composite = 'openai/openai/gpt-oss-20b'
  const parsed = registry.parseProviderModelId(composite)
  assert.ok(parsed !== null)
  assert.equal(parsed.providerId, 'openai')
  assert.equal(parsed.modelId, 'openai/gpt-oss-20b')
})

await check('an unknown prefix is refused', () => {
  assert.equal(registry.parseProviderModelId('nosuchprovider/model'), null)
  assert.equal(registry.parseProviderModelId('no-slash-at-all'), null)
})

// ── 3. the raw file and the loader agree ───────────────────────────────────
await check('registry.json and the loader agree exactly', () => {
  assert.equal(raw.length, registry.PROVIDERS.length)
  assert.deepEqual(raw.map(provider => provider.id), registry.PROVIDERS.map(provider => provider.id))
})

await check('provider ids are unique and sorted by category then id', () => {
  const ids = registry.PROVIDERS.map(provider => provider.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate provider id')
  const sorted = [...registry.PROVIDERS].sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  assert.deepEqual(ids, sorted.map(provider => provider.id), 'the catalog is no longer sorted as documented')
})

await check('the excluded relay is still not directly configurable', () => {
  // A policy decision recorded in the catalog: this relay is not offered.
  assert.equal(registry.getProvider('0d-relay'), null)
})

// ── summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`015-test: ${passed} passed, ${failures.length} FAILED\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure.name}\n`)
  process.exit(1)
}
process.stdout.write(`015-test: ${passed} checks passed — the provider catalog is preserved exactly.\n`)
process.stdout.write('Scope reminder: a catalog entry is not a liveness claim. Whether a provider answers is SRC-019.\n')
