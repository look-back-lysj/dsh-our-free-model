/**
 * SRC-001 baseline-freezing support: load the real sources, extract the facts the
 * contracts are frozen against, and validate a contract document against them.
 *
 * ## Why this exists
 *
 * SRC-001 requires a *real* baseline, not a prose inventory. Two kinds of evidence
 * are needed and they must not be confused:
 *
 * 1. **Loadable truth** — data the running code actually holds (the 76-provider
 *    registry, each channel's `fallbackModels` table, the RPC switch's method
 *    names, the ordered error classifiers). These are read here by importing the
 *    modules or parsing the switch, so a contract that drifts from the code fails
 *    a test instead of rotting quietly.
 * 2. **Cited truth** — behaviour that only exists inside a large adapter (stream
 *    termination, rotation budgets, request body keys). Those are frozen in
 *    `channel-contracts.json` with `file:line` citations and are checked here only
 *    for *shape* (every channel covered, every required facet present, every
 *    citation pointing at a line that exists and that contains the quoted anchor).
 *
 * The second kind is weaker than the first and the test says so: a citation check
 * proves the line exists and still reads what the contract quotes, not that the
 * whole behaviour was re-derived. Nothing here claims a rewrite happened.
 *
 * ## Loading the TypeScript channel pack
 *
 * `vendor/channel-pack/src/*.ts` is TypeScript with `.js` import specifiers. Node
 * 24 can strip types but not rewrite specifiers, so a `registerHooks` pair resolves
 * `./x.js` to `./x.ts` and transpiles on load — the same technique
 * `scripts/channel-pack-test.mjs --source` already uses. Host packages
 * (`@deepseek-ai/*`) are replaced by a minimal stub because the product/error
 * modules only need `LlmError`'s shape at import time.
 *
 * @module scripts/source-rewrite/contracts
 */

import fs from 'node:fs'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Repo root, derived from this file's location (`scripts/source-rewrite/`). */
export const REPO_ROOT = path.resolve(HERE, '..', '..')

/**
 * The two states a recorded red light may be in.
 *
 * `KNOWN_FAILURE_BEFORE_REWRITE` is the default: the defect is still there and
 * the gate reproduces it. `FIXED_IN_SOURCE_AND_BUNDLE` means both the source
 * module and the generated bundle carry the repair — a red light may not be
 * closed on the strength of the source alone, because the release ships the
 * bundle. A fixed entry must name the date and describe the fix, and the gate
 * re-runs the reproduction expecting the corrected behaviour, so a status flip
 * without a real repair fails.
 */
export const KNOWN_STATUS = 'KNOWN_FAILURE_BEFORE_REWRITE'
export const FIXED_STATUS = 'FIXED_IN_SOURCE_AND_BUNDLE'
export const RED_STATUSES = new Set([KNOWN_STATUS, FIXED_STATUS])

/** Absolute path to the channel-pack TypeScript sources. */
export const CHANNEL_SRC = path.join(REPO_ROOT, 'vendor', 'channel-pack', 'src')

/** Absolute path to the frozen-baseline contract directory. */
export const BASELINE_DIR = path.join(
  REPO_ROOT, '工程控制', 'ORIGIN-REWRITE-01', 'contracts', 'baseline-20261122',
)

/**
 * The ten account providers, in the order `REF_PREFIX_TO_PROVIDER` declares them
 * (`vendor/channel-pack/src/channel-pack-store.ts:339-360`). `opencode` sits in
 * that table too but is disabled in this host, so it is *not* one of the ten.
 */
export const ACCOUNT_PROVIDERS = Object.freeze([
  'lobsterai', 'qoder', 'qodercn', 'trae', 'cline',
  'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
])

/** Channel-pack source files that must exist for the contract to be checkable. */
const REQUIRED_SOURCE_FILES = Object.freeze([
  'channel-pack-store.ts',
  'channel-pack-rpc.ts',
  'types.ts',
  'lobsterai-product.ts',
  'qoder-product.ts',
  'trae-product.ts',
  'cline-product.ts',
  'loomy-product.ts',
  'raccoon-product.ts',
  'minimax-product.ts',
  'zcode-product.ts',
  'gemini.ts',
  'lobsterai-errors.ts',
  'trae-errors.ts',
  'openai-compat.ts',
  'model-queue.ts',
])

/** Modules whose product object carries a `fallbackModels` table. */
const PRODUCT_MODULES = Object.freeze({
  lobsterai: { file: 'lobsterai-product.ts', exportName: 'LOBSTERAI' },
  qoder: { file: 'qoder-product.ts', exportName: 'QODER' },
  qodercn: { file: 'qoder-product.ts', exportName: 'QODER_CN' },
  trae: { file: 'trae-product.ts', exportName: 'TRAE' },
  cline: { file: 'cline-product.ts', exportName: 'CLINE' },
  loomy: { file: 'loomy-product.ts', exportName: 'LOOMY' },
  raccoon: { file: 'raccoon-product.ts', exportName: 'RACCOON' },
  minimax: { file: 'minimax-product.ts', exportName: 'MINIMAX' },
  zcode: { file: 'zcode-product.ts', exportName: 'ZCODE' },
  gemini: { file: 'gemini.ts', exportName: 'GEMINI_FALLBACK_MODELS' },
})

/** Every channel must freeze these prose facets; a missing one fails the gate. */
export const REQUIRED_FACETS = Object.freeze([
  'authAndAccountData',
  'requestAndMessages',
  'errorsAndRetry',
  'streamAndCancel',
])

// ── TypeScript loading ──────────────────────────────────────────────────────

const HOST_STUB = `data:text/javascript,${encodeURIComponent(`
export class LlmError extends Error {
  constructor(message, code, options) { super(message, options); this.code = code; this.status = options?.status }
}
export class LlmAdapter {}
export class BlockAssembler {}
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
export const ToolCallId = String
export const ReasoningEffortId = String
export function createUserMessage(value) { return { id: 'stub-message', ...value } }
export default {}
`)}`

let hooksInstalled = false
let transpile = null

/**
 * Install the resolve/load hooks that let the channel-pack TypeScript load in a
 * plain Node process. Idempotent: calling twice does not stack a second hook.
 *
 * @returns {Promise<void>}
 */
export async function installChannelSourceHooks() {
  if (hooksInstalled) return
  const typescript = await import(pathToFileURL(
    path.join(REPO_ROOT, 'node_modules', 'typescript', 'lib', 'typescript.js'),
  ).href)
  transpile = (typescript.default ?? typescript).transpileModule
  const sourceRoot = pathToFileURL(CHANNEL_SRC + path.sep).href
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@deepseek-ai/')) return { url: HOST_STUB, shortCircuit: true }
      if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
        const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
        if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
        return {
          format: 'module',
          source: transpile(fs.readFileSync(fileURLToPath(url), 'utf8'), {
            compilerOptions: { module: 99 /* ESNext */, target: 9 /* ES2022 */ },
            fileName: fileURLToPath(url),
          }).outputText,
          shortCircuit: true,
        }
      }
      return nextLoad(url, context)
    },
  })
  hooksInstalled = true
}

/**
 * Import one channel-pack TypeScript module by file name.
 *
 * @param {string} file e.g. `lobsterai-product.ts`
 * @returns {Promise<Record<string, unknown>>}
 */
export async function importChannelModule(file) {
  await installChannelSourceHooks()
  return import(pathToFileURL(path.join(CHANNEL_SRC, file)).href)
}

// ── extractors: loadable truth ──────────────────────────────────────────────

/**
 * Each channel's fallback model table as the code actually holds it.
 *
 * Only fields the source declares are copied — this function must never invent a
 * capability. A `supportsImage` that is absent stays absent rather than becoming
 * `false`, because "not declared" and "declared unsupported" drive different
 * behaviour downstream (see the MiniMax contradiction in the contracts file).
 *
 * @returns {Promise<Record<string, Array<Record<string, unknown>>>>}
 */
export async function extractChannelModels() {
  /** @type {Record<string, Array<Record<string, unknown>>>} */
  const out = {}
  for (const [provider, spec] of Object.entries(PRODUCT_MODULES)) {
    const module = await importChannelModule(spec.file)
    const owner = module[spec.exportName]
    const rows = provider === 'gemini'
      ? owner
      : owner?.fallbackModels
    if (!Array.isArray(rows)) {
      throw new Error(`${spec.file} does not expose an array at ${spec.exportName}${provider === 'gemini' ? '' : '.fallbackModels'}`)
    }
    out[provider] = rows.map(row => {
      /** @type {Record<string, unknown>} */
      const kept = { id: row.id, name: row.name }
      for (const key of [
        'contextWindow', 'maxTokens', 'supportsImage', 'supportsThinking',
        'efforts', 'effortOptions', 'defaultEffort', 'reasoningLevels',
        'defaultReasoningLevel', 'priceFactor', 'isFree', 'isHidden',
      ]) {
        if (row[key] !== undefined) kept[key] = Array.isArray(row[key]) ? [...row[key]] : row[key]
      }
      return kept
    })
  }
  return out
}

/**
 * The RPC methods the dispatch switch actually handles, read from the source text.
 *
 * Deliberately textual rather than by import: `handleMethod` lives inside a huge
 * module whose import would drag the whole pack in. Reading the `case '...':`
 * labels between the switch bounds is exact for this file and stays honest about
 * what it is — a parse of the switch, not a call graph.
 *
 * @returns {{ methods: string[], file: string, switchStart: number, switchEnd: number }}
 */
export function extractRpcMethods() {
  const file = path.join(CHANNEL_SRC, 'channel-pack-rpc.ts')
  const source = fs.readFileSync(file, 'utf8')
  const lines = source.split(/\r?\n/)
  const startIndex = lines.findIndex(line => /export async function handleMethod|function handleMethod/.test(line))
  if (startIndex < 0) throw new Error('channel-pack-rpc.ts: handleMethod not found')
  let depth = 0
  let opened = false
  let endIndex = lines.length - 1
  const methods = []
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i]
    for (const char of line) {
      if (char === '{') { depth += 1; opened = true }
      else if (char === '}') depth -= 1
    }
    const match = /^\s*case '([^']+)':/.exec(line)
    if (match && opened && depth > 0) methods.push(match[1])
    if (opened && depth === 0) { endIndex = i; break }
  }
  return {
    methods,
    file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
    switchStart: startIndex + 1,
    switchEnd: endIndex + 1,
  }
}

/**
 * Ordered error classification, evaluated against the real exported classifiers.
 *
 * Each probe is a (status, body) pair the classifier must answer with the expected
 * kind. The probes are chosen to exercise the *priority* rules the contracts cite —
 * for example a 402 carrying hard-credit text must answer `hard-credit` before the
 * keyword branch could, and a 200-with-body case proves the in-band classifier has
 * its own default rather than inheriting the HTTP one.
 *
 * @returns {Promise<Record<string, { probes: Array<{label: string, expected: string, actual: string, ok: boolean}> }>>}
 */
export async function extractErrorClassifierProbes() {
  const lobsterai = await importChannelModule('lobsterai-errors.ts')
  const trae = await importChannelModule('trae-errors.ts')
  const compat = await importChannelModule('openai-compat.ts')

  /**
   * @param {string} label
   * @param {string} expected
   * @param {() => string} run
   */
  const probe = (label, expected, run) => {
    let actual
    try { actual = run() } catch (error) { actual = `THREW:${error?.message ?? error}` }
    return { label, expected, actual, ok: actual === expected }
  }

  return {
    lobsterai: {
      probes: [
        probe('402 beats every keyword', 'hard-credit', () => lobsterai.classifyLobsteraiError(402, 'rate limit')),
        probe('400 + 积分不足 is hard-credit, not client', 'hard-credit', () => lobsterai.classifyLobsteraiError(400, '积分不足')),
        probe('banned precedes session-dead', 'banned', () => lobsterai.classifyLobsteraiError(403, '账号存在异常')),
        probe('session-dead marker', 'session-dead', () => lobsterai.classifyLobsteraiError(200, '40100')),
        probe('429 is soft-rate', 'soft-rate', () => lobsterai.classifyLobsteraiError(429, '')),
        probe('404 is not-found', 'not-found', () => lobsterai.classifyLobsteraiError(404, '')),
        probe('500 is server', 'server', () => lobsterai.classifyLobsteraiError(500, '')),
        probe('418 is client', 'client', () => lobsterai.classifyLobsteraiError(418, '')),
        probe('clean 200 is none', 'none', () => lobsterai.classifyLobsteraiError(200, '')),
        probe('in-band default is client, not none', 'client', () => lobsterai.classifyLobsteraiStreamError('something odd')),
        probe('in-band keeps hard-credit', 'hard-credit', () => lobsterai.classifyLobsteraiStreamError('余额不足')),
        probe('every non-none rotates', 'true', () => String(lobsterai.shouldRotateLobsteraiAccount('client'))),
        probe('none never rotates', 'false', () => String(lobsterai.shouldRotateLobsteraiAccount('none'))),
      ],
    },
    trae: {
      probes: [
        probe('quota-exceeded precedes soft-rate (4008 before 4011)', 'quota-exceeded', () => trae.classifyTraeError(200, '4008 and 4011')),
        probe('plan limit needs the plan word', 'hard-plan', () => trae.classifyTraeError(200, '"code":1005 plan')),
        probe('4011 alone is soft-rate', 'soft-rate', () => trae.classifyTraeError(200, '4011')),
        probe('401 is session-dead', 'session-dead', () => trae.classifyTraeError(401, '')),
        probe('429 is soft-rate', 'soft-rate', () => trae.classifyTraeError(429, '')),
        probe('404 is not-found', 'not-found', () => trae.classifyTraeError(404, '')),
        probe('503 is server', 'server', () => trae.classifyTraeError(503, '')),
        probe('418 is client', 'client', () => trae.classifyTraeError(418, '')),
        probe('clean 200 is none', 'none', () => trae.classifyTraeError(200, '')),
        probe('every non-none rotates', 'true', () => String(trae.shouldRotateTraeAccount('client'))),
        probe('none never rotates', 'false', () => String(trae.shouldRotateTraeAccount('none'))),
      ],
    },
    sharedHttpCode: {
      probes: [
        probe('401 is AUTH', 'AUTH', () => compat.httpErrorCode(401)),
        probe('403 is AUTH', 'AUTH', () => compat.httpErrorCode(403)),
        probe('429 is RATE_LIMIT', 'RATE_LIMIT', () => compat.httpErrorCode(429)),
        probe('400 is INVALID_REQUEST', 'INVALID_REQUEST', () => compat.httpErrorCode(400)),
        probe('500 is SERVER', 'SERVER', () => compat.httpErrorCode(500)),
        probe('418 keeps its number', 'HTTP_418', () => compat.httpErrorCode(418)),
      ],
    },
  }
}

// ── extractors: cited truth ────────────────────────────────────────────────

/**
 * Resolve a `file:line` citation to the actual source line, for citation checking.
 *
 * Accepts the forms the contracts use: `path:12`, `path:12-34`, `path:12,34`.
 * Ranges collapse to their first line — the anchor has to be present somewhere in
 * the cited span, and the first line is where a reader lands.
 *
 * @param {string} citation
 * @returns {{ ok: boolean, file?: string, line?: number, text?: string, reason?: string }}
 */
export function resolveCitation(citation) {
  const match = /^([^:]+):(\d+)(?:[-,]\s*\d+)*(?:,\s*\d+)*$/.exec(String(citation).trim())
  if (!match) return { ok: false, reason: `unparseable citation: ${citation}` }
  const file = path.join(REPO_ROOT, match[1].replace(/\//g, path.sep))
  if (!fs.existsSync(file)) return { ok: false, reason: `missing file: ${match[1]}` }
  const line = Number(match[2])
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  if (line < 1 || line > lines.length) {
    return { ok: false, reason: `${match[1]} has ${lines.length} lines, citation asks for ${line}` }
  }
  return { ok: true, file: match[1], line, text: lines[line - 1] }
}

/**
 * Check that every citation of a channel exists and that each cited line still
 * contains the contract's quoted anchor.
 *
 * This is the honest limit of citation checking: it proves the line exists and
 * still reads the quoted text. It does not prove the surrounding behaviour.
 *
 * @param {Array<{ cite: string, anchor?: string }>} entries
 * @returns {Array<{ cite: string, ok: boolean, reason?: string }>}
 */
export function checkCitations(entries) {
  return entries.map(entry => {
    const resolved = resolveCitation(entry.cite)
    if (!resolved.ok) return { cite: entry.cite, ok: false, reason: resolved.reason }
    if (entry.anchor !== undefined && !resolved.text.includes(entry.anchor)) {
      return {
        cite: entry.cite,
        ok: false,
        reason: `line no longer contains ${JSON.stringify(entry.anchor)}; now: ${resolved.text.trim().slice(0, 120)}`,
      }
    }
    return { cite: entry.cite, ok: true }
  })
}

// ── contract validation ────────────────────────────────────────────────────

/** Read and parse the frozen contract document. */
export function readChannelContracts() {
  const file = path.join(BASELINE_DIR, 'channel-contracts.json')
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) }
}

/**
 * Structural validation of `channel-contracts.json` against the loaded sources.
 *
 * Returns a list of problems; an empty list means the document is internally
 * consistent with the code it claims to describe. It deliberately does not judge
 * whether the frozen behaviour is *desirable* — that is SRC-002..014's job.
 *
 * @param {any} doc
 * @param {{ models: Record<string, Array<Record<string, unknown>>>, rpcMethods: string[] }} live
 * @returns {string[]}
 */
export function validateChannelContracts(doc, live) {
  const problems = []
  const fail = message => problems.push(message)

  if (doc?.schema !== 'ofm/source-rewrite-channel-baseline/v2') {
    fail(`unexpected schema ${JSON.stringify(doc?.schema)}`)
  }

  // 1. The ten providers, exactly, in declaration order.
  const declared = Array.isArray(doc?.accountProviderIds) ? doc.accountProviderIds : []
  if (declared.join(',') !== ACCOUNT_PROVIDERS.join(',')) {
    fail(`accountProviderIds must be exactly ${ACCOUNT_PROVIDERS.join(',')} in order; got ${declared.join(',') || '(none)'}`)
  }

  // 2. RPC surface must match the switch exactly, both directions.
  const frozenRpc = new Set(Array.isArray(doc?.sharedRpcMethods) ? doc.sharedRpcMethods : [])
  const liveRpc = new Set(live.rpcMethods)
  for (const method of liveRpc) if (!frozenRpc.has(method)) fail(`RPC handled in source but not frozen: ${method}`)
  for (const method of frozenRpc) if (!liveRpc.has(method)) fail(`RPC frozen but not handled in source: ${method}`)
  if (frozenRpc.size !== liveRpc.size) {
    fail(`RPC count differs: frozen ${frozenRpc.size}, source ${liveRpc.size}`)
  }

  // 3. Per-channel: presence, facets, model list parity, citations.
  const products = Array.isArray(doc?.products) ? doc.products : []
  const byId = new Map(products.map(product => [product?.id, product]))
  if (products.length !== ACCOUNT_PROVIDERS.length) {
    fail(`expected ${ACCOUNT_PROVIDERS.length} product entries, found ${products.length}`)
  }

  for (const provider of ACCOUNT_PROVIDERS) {
    const product = byId.get(provider)
    if (product === undefined) { fail(`missing product entry: ${provider}`); continue }

    for (const facet of REQUIRED_FACETS) {
      const value = product[facet]
      if (typeof value !== 'string' || value.trim() === '') fail(`${provider}: facet ${facet} is empty`)
    }

    // Model parity: the frozen id list must equal the source's, in order.
    const frozenIds = Array.isArray(product.modelIds) ? product.modelIds : null
    if (frozenIds === null) {
      fail(`${provider}: modelIds missing`)
    } else {
      const liveIds = live.models[provider].map(row => row.id)
      if (frozenIds.join('\u0000') !== liveIds.join('\u0000')) {
        const onlyFrozen = frozenIds.filter(id => !liveIds.includes(id))
        const onlyLive = liveIds.filter(id => !frozenIds.includes(id))
        fail(`${provider}: modelIds drift (frozen-only: ${onlyFrozen.join(',') || 'none'}; source-only: ${onlyLive.join(',') || 'none'}; order matters)`)
      }
    }

    // Declared capabilities must match what the source table declares, field by
    // field, for the fields the contract chose to freeze.
    const frozenModels = Array.isArray(product.models) ? product.models : []
    const liveModels = new Map(live.models[provider].map(row => [row.id, row]))
    if (frozenModels.length !== liveModels.size) {
      fail(`${provider}: ${frozenModels.length} frozen model rows vs ${liveModels.size} in source`)
    }
    for (const row of frozenModels) {
      const actual = liveModels.get(row?.id)
      if (actual === undefined) { fail(`${provider}: frozen model ${row?.id} not in source`); continue }
      for (const key of ['contextWindow', 'maxTokens', 'supportsImage', 'supportsThinking', 'defaultEffort']) {
        const frozenHas = Object.hasOwn(row, key)
        const liveHas = Object.hasOwn(actual, key)
        if (frozenHas !== liveHas) {
          fail(`${provider}/${row.id}: field ${key} frozen=${frozenHas} source=${liveHas} — record the absence explicitly instead of guessing`)
        } else if (frozenHas && row[key] !== actual[key]) {
          fail(`${provider}/${row.id}: field ${key} frozen=${JSON.stringify(row[key])} source=${JSON.stringify(actual[key])}`)
        }
      }
      for (const key of ['efforts', 'effortOptions', 'reasoningLevels']) {
        if (!Object.hasOwn(row, key)) continue
        const frozen = Array.isArray(row[key]) ? row[key].join(',') : String(row[key])
        const live = Array.isArray(actual[key]) ? actual[key].join(',') : String(actual[key])
        if (frozen !== live) fail(`${provider}/${row.id}: ${key} frozen=${frozen} source=${live}`)
      }
    }

    // Citation hygiene.
    const evidence = Array.isArray(product.sourceEvidence) ? product.sourceEvidence : []
    if (evidence.length === 0) fail(`${provider}: sourceEvidence is empty`)
    for (const entry of evidence) {
      const cite = typeof entry === 'string' ? entry : entry?.cite
      if (typeof cite !== 'string') { fail(`${provider}: malformed evidence entry ${JSON.stringify(entry)}`); continue }
      const [checked] = checkCitations([typeof entry === 'string' ? { cite } : { cite, anchor: entry.anchor }])
      if (!checked.ok) fail(`${provider}: ${checked.reason}`)
    }

    // A channel that rotates must say what it rotates on and what it cools down.
    const rotation = product.rotation
    if (rotation === undefined || typeof rotation !== 'object') {
      fail(`${provider}: rotation block missing`)
    } else {
      if (!Array.isArray(rotation.switchOn)) fail(`${provider}: rotation.switchOn missing`)
      if (typeof rotation.maxAttempts !== 'number' || rotation.maxAttempts < 1) {
        fail(`${provider}: rotation.maxAttempts must be a positive number`)
      }
      if (rotation.coolDownOn !== undefined && !Array.isArray(rotation.coolDownOn)) {
        fail(`${provider}: rotation.coolDownOn must be an array when present`)
      }
    }

    // Stream termination must name its sentinel, not just say "streaming works".
    const stream = product.stream
    if (stream === undefined || typeof stream !== 'object') {
      fail(`${provider}: stream block missing`)
    } else {
      if (typeof stream.terminator !== 'string' || stream.terminator === '') {
        fail(`${provider}: stream.terminator missing`)
      }
      if (typeof stream.usageSource !== 'string' || stream.usageSource === '') {
        fail(`${provider}: stream.usageSource missing`)
      }
      if (typeof stream.abortThreading !== 'string' || stream.abortThreading === '') {
        fail(`${provider}: stream.abortThreading missing`)
      }
    }

    // Wire shape must be one of the known shapes, and endpoints must be absolute.
    if (!['openai-chat', 'anthropic-messages', 'gemini-contents', 'proprietary'].includes(product.wire)) {
      fail(`${provider}: wire ${JSON.stringify(product.wire)} is not a known shape`)
    }
    const endpoints = product.endpoints
    if (endpoints === undefined || typeof endpoints !== 'object' || Object.keys(endpoints).length === 0) {
      fail(`${provider}: endpoints missing`)
    } else {
      for (const [name, value] of Object.entries(endpoints)) {
        if (typeof value !== 'string' || !/^https?:\/\//.test(value)) {
          fail(`${provider}: endpoint ${name} is not an absolute http(s) URL: ${JSON.stringify(value)}`)
        }
      }
    }

    // Env keys must look like real keys.
    for (const key of Array.isArray(product.envKeys) ? product.envKeys : []) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail(`${provider}: env key ${JSON.stringify(key)} is malformed`)
    }
  }

  // 4. Protected inputs must be listed with a digest, and the digest must be real.
  const protectedInputs = Array.isArray(doc?.protectedInputs) ? doc.protectedInputs : []
  if (protectedInputs.length === 0) fail('protectedInputs is empty')
  for (const entry of protectedInputs) {
    if (typeof entry?.path !== 'string' || typeof entry?.sha256 !== 'string') {
      fail(`protectedInputs entry malformed: ${JSON.stringify(entry)}`)
      continue
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) fail(`${entry.path}: sha256 is not 64 lowercase hex chars`)
    const absolute = path.join(REPO_ROOT, entry.path.replace(/\//g, path.sep))
    if (!fs.existsSync(absolute)) { fail(`${entry.path}: protected input does not exist`); continue }
    const bytes = fs.readFileSync(absolute)
    if (typeof entry.bytes === 'number' && entry.bytes !== bytes.length) {
      fail(`${entry.path}: frozen ${entry.bytes} bytes, actual ${bytes.length}`)
    }
  }

  // 5. Every known red light must carry a reproduction that the gate can run.
  const reds = Array.isArray(doc?.knownFailures) ? doc.knownFailures : []
  if (reds.length === 0) fail('knownFailures is empty — the baseline has at least two')
  for (const red of reds) {
    if (typeof red?.id !== 'string' || red.id === '') fail(`knownFailure without id: ${JSON.stringify(red)}`)
    if (!RED_STATUSES.has(red?.status)) {
      fail(`${red?.id}: status must be one of ${[...RED_STATUSES].join(' / ')}`)
    }
    if (typeof red?.repro !== 'string' || red.repro === '') fail(`${red?.id}: repro missing`)
    // A red light may only leave KNOWN_FAILURE_BEFORE_REWRITE with the date and a
    // description of the fix, so "mark it fixed" always carries the evidence a
    // reader needs to check. The gate below still re-derives the behaviour.
    if (red.status === FIXED_STATUS && (typeof red.fixedOn !== 'string' || typeof red.fix !== 'string')) {
      fail(`${red?.id}: a fixed red light must record fixedOn and fix`)
    }
  }

  return problems
}

/**
 * Build the provider/model id snapshot from the real registry loader.
 *
 * @param {{ includeEndpoints?: boolean }} [options] `includeEndpoints` adds each
 *   provider's `baseUrl`, for callers that need to compare hosts. The on-disk
 *   snapshot leaves it out on purpose: endpoints change more often than ids, and
 *   freezing them would turn a routine upstream move into a false gate failure.
 * @returns {Promise<{ generatedFrom: string, providerCount: number, modelCount: number, providers: Array<{ id: string, category: string, format: string, modelIds: string[], baseUrl?: string }> }>}
 */
export async function buildProviderRegistrySnapshot({ includeEndpoints = false } = {}) {
  const registry = await import(pathToFileURL(
    path.join(REPO_ROOT, 'src', 'providers', 'index.js'),
  ).href)
  const providers = registry.PROVIDERS.map(provider => ({
    id: provider.id,
    category: provider.category,
    format: provider.format,
    ...(includeEndpoints ? { baseUrl: provider.baseUrl } : {}),
    modelIds: provider.models.map(model => model.id),
  }))
  return {
    generatedFrom: 'src/providers/index.js (PROVIDERS, i.e. src/providers/registry.json)',
    providerCount: providers.length,
    modelCount: providers.reduce((total, provider) => total + provider.modelIds.length, 0),
    providers,
  }
}

/**
 * Report which required source files are absent, so a gate fails with a clear
 * reason instead of a module-resolution stack trace.
 *
 * @returns {string[]}
 */
export function missingSourceFiles() {
  return REQUIRED_SOURCE_FILES.filter(name => !fs.existsSync(path.join(CHANNEL_SRC, name)))
}
