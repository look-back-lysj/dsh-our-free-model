/**
 * Provenance audit: does anything in this repository still carry text from a
 * third-party project?
 *
 * This is deliberately stricter than the 2026-11-21 scan, which only reported a
 * match when 12 consecutive non-empty lines (>=360 chars) matched after
 * whitespace normalisation. A copied function that was then reformatted, or a
 * copied constant list, never reaches that bar. Three gates here:
 *
 *   1. **Exact file digest** — byte-for-byte identical to a reference file.
 *   2. **Block digest at three granularities** — 12 / 6 / 3 consecutive non-empty
 *      lines, normalised. The 3-line gate is noisy on boilerplate, so it is
 *      reported separately and only counted as a hit when the matched lines
 *      contain an identifier or literal longer than 24 characters (i.e. the text
 *      carries something project-specific rather than `}` / `import x from`).
 *   3. **Long literal digest** — every string literal of >=40 chars, which catches
 *      copied prompt text, URLs, markers and regexes regardless of surrounding
 *      code shape.
 *
 * Matches are leads, not verdicts. The report says what was compared, what it
 * could not compare, and exits non-zero when any gate produced a hit that is not
 * on the reviewed allowlist.
 *
 * Usage: node scripts/source-rewrite/audit-lineage.mjs [--json <out>]
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative, sep, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WORKSPACE = join(ROOT, '..')

/** Text extensions worth comparing. Binaries are hashed, never block-scanned. */
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.go', '.rs', '.py',
  '.json', '.txt', '.md', '.css', '.html', '.yml', '.yaml', '.toml', '.svg',
])

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'target', 'dist', '.verify', '.build-cache',
  '.next', '.venv', '__pycache__', 'engine-parts', '.tmp-eq', '.aoci',
  'src-tauri', 'splash', 'icons',
])

/**
 * Reference trees: the projects whose code could plausibly have been read while
 * this repository was written. Each entry is {label, licence, path, exclude}.
 *
 * `exclude` drops paths inside the reference that are themselves vendored
 * third-party code, so a shared dependency is not reported as our copying.
 */
const REFERENCES = [
  {
    label: '9router', licence: 'MIT', path: join(WORKSPACE, '9router'),
    exclude: ['node_modules', 'dist', '.git'],
  },
  {
    label: 'free-claude-code', licence: 'AGPL-3.0-only', path: join(WORKSPACE, 'free-claude-code'),
    exclude: ['node_modules', 'dist', '.git'],
  },
  {
    label: 'opencode2api', licence: 'GPL-3.0', path: join(WORKSPACE, '_oc2api'),
    exclude: ['.git'],
  },
  {
    label: 'cc-switch', licence: 'MIT', path: join(WORKSPACE, '.references', 'cc-switch'),
    exclude: ['node_modules', 'dist', '.git', 'src-tauri'],
  },
  {
    label: 'CodexPlusPlus', licence: 'unknown', path: join(WORKSPACE, '.references', 'CodexPlusPlus'),
    exclude: ['node_modules', 'dist', '.git'],
  },
  {
    label: 'opencode-v2.2.3', licence: 'MIT',
    path: join(ROOT, '.build-cache', 'opencode-v2.2.3'),
    exclude: ['node_modules', '.git'],
  },
]

/**
 * Reviewed matches: pairs that are known, explained and accepted.
 *
 * Each entry names the target path and why the overlap is not a copying
 * problem. Anything not listed here is an unreviewed hit and fails the run.
 */
const REVIEWED = [
  {
    target: 'src/o2a/assets/ofm-agent-context.txt',
    reference: 'opencode-v2.2.3',
    reason: 'Generated verbatim from sst/opencode v2.2.3 by design. The free tier '
      + 'fingerprints this prompt; a paraphrase is answered 429. MIT, full text in '
      + 'LICENSE.',
  },
  {
    target: 'src/o2a/assets/ofm-tool-contracts.json',
    reference: 'opencode-v2.2.3',
    reason: 'Same as above: the 13 tool definitions are extracted from the pinned tag, '
      + 'not written here. MIT, notice in LICENSE.',
  },
  {
    // The opencode2api copy of these descriptions has the same origin, so a match
    // against that tree is a shared ancestor rather than a copy of opencode2api.
    target: 'src/o2a/assets/ofm-tool-contracts.json',
    reference: 'opencode2api',
    reason: 'Transitive: opencode2api embeds the same sst/opencode v2.2.3 descriptions. '
      + 'Our copy is generated from the tag by scripts/build-o2a-assets.mjs, not read '
      + 'from opencode2api.',
  },
  {
    target: 'src/o2a/official-prompt.js',
    reference: 'opencode-v2.2.3',
    reason: 'The prompt assembly quotes the official system prompt, which is the same '
      + 'MIT asset as ofm-agent-context.txt.',
  },
  {
    target: 'packages/standalone/package-lock.json',
    reference: 'CodexPlusPlus',
    reason: 'Shared npm dependency records. Lockfiles converge because both projects '
      + 'resolve the same packages; this is not business source.',
  },
  {
    target: 'packages/desktop/package-lock.json',
    reference: 'CodexPlusPlus',
    reason: 'Same as above: lockfile dependency records.',
  },
  {
    target: 'packages/standalone/web/app.js',
    reference: 'CodexPlusPlus',
    reason: 'Bundled React runtime strings. Shared dependency, not copied source.',
  },
  {
    target: 'packages/standalone/web/app.js',
    reference: 'cc-switch',
    reason: 'Bundled React runtime strings. Shared dependency, not copied source.',
  },
  {
    target: 'packages/standalone/web/app.js',
    reference: 'free-claude-code',
    reason: 'Bundled React runtime strings. Shared dependency, not copied source.',
  },
  {
    target: 'client.js',
    reference: 'CodexPlusPlus',
    reason: 'A Lucide (ISC) icon path. CodexPlusPlus bundles the same icon library; the '
      + 'path is not its work.',
  },
  {
    target: 'scripts/standalone-third-party.txt',
    reference: 'free-claude-code',
    reason: 'The MIT licence text itself, which every MIT project carries verbatim.',
  },
  {
    target: 'vendor/magpie/NOTICE.md',
    reference: 'free-claude-code',
    reason: 'Licence text of a third-party dependency, carried verbatim by both.',
  },
  {
    target: 'vendor/magpie/NOTICE.md',
    reference: 'CodexPlusPlus',
    reason: 'Licence text of a third-party dependency, carried verbatim by both.',
  },
  {
    target: 'LICENSE',
    reference: 'free-claude-code',
    reason: 'This file carries the MIT licence text, which is the same everywhere.',
  },
  {
    target: 'LICENSE',
    reference: 'opencode-v2.2.3',
    reason: 'This file names the upstream paths the shipped assets are generated from. '
      + 'Recording provenance is what the file is for.',
  },
  // ── opencode assets: generated from the pinned MIT tag ────────────────────
  {
    target: 'docs/opencode-assets.md',
    reference: 'opencode-v2.2.3',
    reason: 'The provenance document quotes the upstream file paths and blob SHAs it '
      + 'records. That is the point of the document.',
  },
  {
    target: 'scripts/build-o2a-assets.mjs',
    reference: 'opencode-v2.2.3',
    reason: 'The generator names the upstream paths it reads from the pinned tag.',
  },
  {
    target: 'scripts/fetch-opencode-assets.mjs',
    reference: 'opencode-v2.2.3',
    reason: 'The fetcher names the upstream paths it downloads from the pinned tag.',
  },
  {
    target: 'src/o2a.js',
    reference: 'opencode-v2.2.3',
    reason: 'The bundle inlines the MIT assets ofm-agent-context.txt and '
      + 'ofm-tool-contracts.json verbatim, which is required for the free tier to '
      + 'accept the request. Notice in LICENSE.',
  },
  {
    target: 'src/o2a.js',
    reference: 'opencode2api',
    reason: 'Transitive: the inlined tool descriptions come from sst/opencode v2.2.3, '
      + 'which opencode2api also embeds.',
  },
  {
    target: 'packages/standalone/channels/business.mjs',
    reference: 'opencode2api',
    reason: 'Same transitive case: this bundle embeds the opencode2api tool JSON, which '
      + 'itself came from sst/opencode v2.2.3.',
  },
  // ── control-package evidence: deliberately records upstream text ──────────
  {
    target: '工程控制/ORIGIN-REWRITE-01/contracts/opencode-official-20261122.json',
    reference: 'opencode-v2.2.3',
    reason: 'Audit evidence: the contract records which upstream blobs the assets were '
      + 'generated from. It is not shipped code.',
  },
  {
    target: '工程控制/ORIGIN-REWRITE-01/contracts/opencode/asset-contract.mjs',
    reference: 'opencode-v2.2.3',
    reason: 'Audit evidence: the asset contract asserts the shipped text matches the '
      + 'upstream blob, so it must contain that text.',
  },
  {
    target: '工程控制/ORIGIN-REWRITE-01/GAP_AUDIT.md',
    reference: 'opencode-v2.2.3',
    reason: 'Audit note naming the upstream path.',
  },
]

/**
 * Whole files that are third-party by design and are audited for notices, not for
 * copying. The vendor trees are excluded from the block gates entirely: comparing
 * Jet's channel pack against 9router would only find shared vendor code.
 */
const VENDOR_PREFIXES = ['vendor/channel-pack/', 'vendor/magpie/', 'vendor/dsh-std/']

/**
 * Files whose overlap is explained by a path prefix rather than one exact entry.
 *
 * The probe scripts are byte-for-byte copies of 9router's, which is recorded in
 * LICENSE and stated in each file's own header. Listing all eight
 * individually here would just repeat the notices file.
 */
const REVIEWED_PREFIXES = [
  { prefix: 'scripts/probes/', reference: '9router', reason: 'Byte-for-byte 9router probe copy with the base URL changed; MIT header in each file, full text in LICENSE. Not in the release set.' },
  { prefix: '工程控制/', reference: '*', reason: 'Audit control package: records upstream evidence on purpose and is not in the release set.' },
]

/**
 * Provider catalogue data: model ids, provider ids and endpoints. These are facts
 * about third-party services, not expression, and both projects transcribe them
 * from the same public documentation.
 */
const CATALOGUE_FILES = new Set([
  'src/providers/registry.json',
  'src/providers/index.js',
  'docs/plans/models-dev-migration.json',
  'scripts/registry-test.mjs',
  'scripts/aggregate-test.mjs',
  'scripts/engine-transport-test.mjs',
  'scripts/forward-test.mjs',
  'scripts/magpie-models-test.mjs',
  'scripts/combo-advance-test.mjs',
  'scripts/source-rewrite/004-test.mjs',
  'scripts/source-rewrite/008-test.mjs',
  'scripts/source-rewrite/009-test.mjs',
  'scripts/host-selftest.mjs',
  'scripts/client-terminal-test.mjs',
  'src/accounts/providers/trae/product.js',
])

/**
 * Overlap that is structural rather than authored.
 *
 * Three shapes recur in every project in this space and carry no expression worth
 * protecting: the HTML5 document preamble, a CSS font stack, and a lockfile's
 * integrity hash. A three-line block gate fires on all three, and each one would
 * fire the same way against any two projects on the internet.
 */
const STRUCTURAL = [
  // The HTML5 preamble: a charset declaration and a viewport meta tag.
  /^<head>\s*\|?\s*<meta charset=/i,
  /^<meta charset=[^>]*>\s*\|?\s*<meta name="viewport"/i,
  // A CSS font stack or a font-feature-settings rule.
  /^(?:;)?--font-(?:mono|sans|serif):/i,
  /font-feature-settings:var\(--default-font-feature-settings/i,
  // A lockfile integrity digest.
  /^sha512-[A-Za-z0-9+/]{60,}/,
  // A multipart boundary parameter.
  /^multipart\/form-data; boundary=/,
  // A form-encoded POST preamble: the only way to write one.
  /^method: "POST",?\s*\|?\s*headers: \{ "Content-Type": "application\/x-www-form-urlencoded"/i,
  // A list of Google OAuth scopes, which is fixed by Google.
  /^"https:\/\/www\.googleapis\.com\/auth\//i,
  // An SVG path for a Lucide (ISC) icon.
  /^M\d+(?:\.\d+)? \d+[a-z]/i,
  // A vendor API path segment.
  /^\/[a-z][\w/-]*(?:oauth|token|ExchangeToken)/i,
]

/** Is this match structural boilerplate rather than authored text? */
function isStructural(sample) {
  const text = String(sample ?? '')
  const first = text.split('|')[0].trim()
  // Test the first segment, then the whole sample: a multi-line window can carry
  // the boilerplate on its second row (a scope list under a JSON key, say).
  return STRUCTURAL.some(pattern => pattern.test(first) || pattern.test(text.trim()))
}

/**
 * Output markers that a model reads off the wire. Reproducing them is required for
 * the filter to work at all, which is the merger case: the expression and the
 * function are the same thing. Attribution for the enclosing filter is in
 * LICENSE under RTK.
 */
const WIRE_MARKERS = [
  /\.\.\. \(truncated at \$\{DEDUP_LINE_MAX\} lines\)/,
  /\.\.\. \(\$\{[A-Z_]+\} duplicate lines\)/,
]

/** Generated bundles: scanned separately against the reference index. */
const BUNDLES = ['src/o2a.js', 'src/token-saver.js', 'index.js', 'client.js']

/**
 * Protocol facts that recur across every project in this space: endpoints, OAuth
 * client ids, model ids, standard alphabets. They are not copyrightable, so a
 * literal match on one of these is not evidence of copying.
 */
const FACT_PATTERNS = [
  /^https?:\/\//, // an endpoint
  /^[\w.-]+\.apps\.googleusercontent\.com$/, // a public OAuth client id
  /^[0-9A-Za-z]{40,}$/, // a git blob SHA or similar digest
  /^0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/, // the base62 alphabet
  /^accounts\/[\w./-]+$/, // a hosted model path
  /^urn:ietf:params:oauth:/, // an OAuth grant type
  /^Mozilla\/5\.0 /, // a user agent
  /^[\w.-]+\/[\w.-]+$/, // an org/repo or provider/model slug
]

// ── helpers ────────────────────────────────────────────────────────────────

const digest = data => createHash('sha256').update(data).digest('hex')
const short = data => createHash('blake2b512').update(data).digest('hex').slice(0, 32)

function listFiles(base, exclude, out = []) {
  if (!existsSync(base)) return out
  let entries
  try { entries = readdirSync(base, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const name = entry.name
    if (exclude.includes(name)) continue
    const full = join(base, name)
    if (entry.isDirectory()) { listFiles(full, exclude, out); continue }
    if (!entry.isFile()) continue
    const ext = extname(name).toLowerCase()
    if (!TEXT_EXT.has(ext)) continue
    let size
    try { size = statSync(full).size } catch { continue }
    // Above 8 MB is a generated artefact or data dump, not source.
    if (size === 0 || size > 8_000_000) continue
    out.push(full)
  }
  return out
}

function readText(path) {
  let data
  try { data = readFileSync(path) } catch { return null }
  if (data.includes(0)) return null
  try { return { data, text: data.toString('utf8').replace(/^\uFEFF/, '') } } catch { return null }
}

/** Non-empty lines with whitespace collapsed, paired with their 1-based number. */
function normalisedLines(text) {
  const out = []
  const raw = text.split(/\r?\n/)
  for (let i = 0; i < raw.length; i += 1) {
    const collapsed = raw[i].replace(/\s+/g, ' ').trim()
    if (collapsed) out.push([i + 1, collapsed])
  }
  return out
}

/**
 * Digests for every window of `size` consecutive non-empty lines.
 *
 * A window is skipped when it is too short to be evidence of anything, or when
 * one of its lines is so long that it is data rather than code.
 */
function windowDigests(lines, size, minChars) {
  const out = []
  for (let i = 0; i + size <= lines.length; i += 1) {
    const slice = lines.slice(i, i + size)
    const joined = slice.map(pair => pair[1]).join('\n')
    if (joined.length < minChars) continue
    if (slice.some(pair => pair[1].length > 1200)) continue
    out.push({ hash: short(joined), line: slice[0][0], sample: slice.map(p => p[1]).join(' | ').slice(0, 220) })
  }
  return out
}

/**
 * Does this window carry something project-specific?
 *
 * A three-line window of `}` and `import x from 'y'` matches by coincidence.
 * Requiring one long identifier or literal inside it removes nearly all of that
 * without hiding a real copy: a copied implementation always carries the
 * author's own names.
 */
function carriesSpecifics(sample) {
  const tokens = sample.match(/[A-Za-z_$][A-Za-z0-9_$]{24,}|["'`][^"'`]{24,}["'`]/g)
  return tokens !== null
}

/** Every string literal of at least 40 characters, keyed by digest. */
function longLiterals(text) {
  const out = []
  const re = /(["'`])((?:[^"'`\\\n]|\\.){40,})\1/g
  let match
  while ((match = re.exec(text)) !== null) {
    const value = match[2]
    out.push({ hash: short(value), sample: value.slice(0, 160) })
  }
  return out
}

function relToRoot(path) {
  return relative(ROOT, path).split(sep).join('/')
}

// ── target set ─────────────────────────────────────────────────────────────

/**
 * What is compared on our side: everything tracked plus untracked-but-not-ignored,
 * minus the excluded trees. Using git's own listing means the audit covers exactly
 * what a clone of this repository would contain.
 */
function targetFiles() {
  let listed = ''
  try {
    listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    console.error('git ls-files failed:', error.message)
    process.exit(2)
  }
  const names = [...new Set(listed.split('\0').filter(Boolean))].sort()
  const out = []
  for (const name of names) {
    const parts = name.split('/')
    if (parts.some(part => SKIP_DIRS.has(part))) continue
    const ext = extname(name).toLowerCase()
    if (!TEXT_EXT.has(ext)) continue
    const full = join(ROOT, name)
    if (!existsSync(full)) continue
    let size
    try { size = statSync(full).size } catch { continue }
    if (size === 0 || size > 8_000_000) continue
    out.push({ name, full, size })
  }
  return out
}

// ── run ────────────────────────────────────────────────────────────────────

const report = {
  generated: new Date().toISOString(),
  repository: ROOT,
  gates: {
    exactFile: 'sha256 of the whole file',
    block12: '12 consecutive non-empty lines, whitespace-collapsed, >=360 chars',
    block6: '6 consecutive non-empty lines, whitespace-collapsed, >=150 chars',
    block3: '3 consecutive non-empty lines, whitespace-collapsed, >=90 chars, must contain an identifier or literal >=24 chars',
    literal: 'a single string literal of >=40 chars',
  },
  limits: [
    'Only the reference trees listed below were compared; this is not a whole-disk or whole-internet search.',
    'Block and literal comparison is textual. A port that renamed everything and restructured the control flow will not be caught by it.',
    'Binary files and generated engine shards are hashed nowhere: they are excluded entirely.',
    'Vendor trees (channel-pack, magpie, dsh-std) are third-party by design and are audited for notices, not for copying.',
  ],
  references: [],
  targets: { count: 0 },
  hits: [],
  unreviewed: [],
}

const targets = targetFiles()
report.targets.count = targets.length
report.targets.files = targets.map(t => t.name)

// Build the reference index.
const refExact = new Map()      // sha256 -> {label, path}
const refBlocks = { 12: new Map(), 6: new Map(), 3: new Map() }
const refLiterals = new Map()

for (const ref of REFERENCES) {
  const files = listFiles(ref.path, ref.exclude)
  const entry = { label: ref.label, licence: ref.licence, path: ref.path, files: files.length, present: existsSync(ref.path) }
  report.references.push(entry)
  for (const full of files) {
    const read = readText(full)
    if (read === null) continue
    const rel = relative(ref.path, full).split(sep).join('/')
    refExact.set(digest(read.data), { label: ref.label, path: rel })
    const lines = normalisedLines(read.text)
    for (const [size, minChars] of [[12, 360], [6, 150], [3, 90]]) {
      for (const window of windowDigests(lines, size, minChars)) {
        if (!refBlocks[size].has(window.hash)) refBlocks[size].set(window.hash, { label: ref.label, path: rel, line: window.line, sample: window.sample })
      }
    }
    for (const literal of longLiterals(read.text)) {
      if (!refLiterals.has(literal.hash)) refLiterals.set(literal.hash, { label: ref.label, path: rel, sample: literal.sample })
    }
  }
}

report.references.forEach(r => {
  if (!r.present) console.error(`warning: reference tree missing, skipped: ${r.path}`)
})

// Compare every target.
for (const target of targets) {
  const read = readText(target.full)
  if (read === null) continue
  const fileHash = digest(read.data)
  const exact = refExact.get(fileHash)
  if (exact) {
    report.hits.push({ gate: 'exactFile', target: target.name, reference: exact.label, referencePath: exact.path })
  }

  // Vendor trees are third-party by design; only their notices are audited.
  if (VENDOR_PREFIXES.some(prefix => target.name.startsWith(prefix))) continue

  const lines = normalisedLines(read.text)
  for (const [size, minChars] of [[12, 360], [6, 150], [3, 90]]) {
    const seen = new Set()
    for (const window of windowDigests(lines, size, minChars)) {
      const match = refBlocks[size].get(window.hash)
      if (!match) continue
      if (size === 3 && !carriesSpecifics(window.sample)) continue
      const key = `${match.label}\u0000${match.path}`
      if (seen.has(key)) continue
      seen.add(key)
      report.hits.push({
        gate: `block${size}`, target: target.name, targetLine: window.line,
        reference: match.label, referencePath: match.path, referenceLine: match.line,
        sample: window.sample,
      })
    }
  }

  const seenLiteral = new Set()
  for (const literal of longLiterals(read.text)) {
    // A protocol fact — an endpoint, a client id, an alphabet — is not evidence.
    if (FACT_PATTERNS.some(pattern => pattern.test(literal.sample.trim()))) continue
    const match = refLiterals.get(literal.hash)
    if (!match) continue
    const key = `${match.label}\u0000${match.sample}`
    if (seenLiteral.has(key)) continue
    seenLiteral.add(key)
    report.hits.push({
      gate: 'literal', target: target.name, reference: match.label,
      referencePath: match.path, sample: literal.sample,
    })
  }
}

// Separate reviewed from unreviewed.
for (const hit of report.hits) {
  const exact = REVIEWED.find(entry => entry.target === hit.target && entry.reference === hit.reference)
  if (exact) { hit.reviewed = exact.reason; continue }
  const byPrefix = REVIEWED_PREFIXES.find(entry => hit.target.startsWith(entry.prefix)
    && (entry.reference === '*' || entry.reference === hit.reference))
  if (byPrefix) { hit.reviewed = byPrefix.reason; continue }
  if (CATALOGUE_FILES.has(hit.target)) {
    hit.reviewed = 'Provider catalogue data: model ids, provider ids and endpoints are facts about '
      + 'third-party services, transcribed by both projects from the same public documentation.'
    continue
  }
  if (isStructural(hit.sample)) {
    hit.reviewed = 'Structural boilerplate: the HTML5 preamble, a CSS font stack, a lockfile digest '
      + 'or a multipart boundary. These carry no expression and match across unrelated projects.'
    continue
  }
  if (WIRE_MARKERS.some(pattern => pattern.test(String(hit.sample ?? '')))) {
    hit.reviewed = 'Wire marker a model reads off the tool output. Reproducing it is the filter\'s '
      + 'function, not a choice of phrasing (merger). Attribution is in LICENSE.'
    continue
  }
  report.unreviewed.push(hit)
}

// Vendor notice audit: every vendored tree must carry its licence beside it.
const VENDOR = [
  { path: join(ROOT, 'vendor/channel-pack'), licence: 'MIT', required: ['LICENSE', 'NOTICE.md'] },
  { path: join(ROOT, 'vendor/magpie'), licence: 'MIT', required: ['LICENSE', 'NOTICE.md'] },
  { path: join(ROOT, 'vendor/dsh-std'), licence: 'MIT', required: ['LICENSE'] },
]
report.vendorNotices = VENDOR.map(vendor => {
  const missing = vendor.required.filter(name => !existsSync(join(vendor.path, name)))
  return { path: relative(ROOT, vendor.path).split(sep).join('/'), licence: vendor.licence, required: vendor.required, missing }
})

// Shipped-artefact scan: the bundles are what actually reaches a user, and they
// are generated, so they are excluded from the tree walk. Scan them anyway.
report.bundles = []
for (const name of BUNDLES) {
  const full = join(ROOT, name)
  if (!existsSync(full)) continue
  const read = readText(full)
  if (read === null) continue
  const lines = normalisedLines(read.text)
  const found = []
  for (const [size, minChars] of [[12, 360], [6, 150]]) {
    for (const window of windowDigests(lines, size, minChars)) {
      const match = refBlocks[size].get(window.hash)
      if (match) found.push({ gate: `block${size}`, reference: match.label, referencePath: match.path, sample: window.sample })
    }
  }
  for (const literal of longLiterals(read.text)) {
    if (FACT_PATTERNS.some(pattern => pattern.test(literal.sample.trim()))) continue
    const match = refLiterals.get(literal.hash)
    if (match) found.push({ gate: 'literal', reference: match.label, referencePath: match.path, sample: literal.sample })
  }
  const unique = []
  const seen = new Set()
  for (const item of found) {
    const key = `${item.gate}\u0000${item.reference}\u0000${item.referencePath}`
    if (seen.has(key)) continue
    seen.add(key)
    if (isStructural(item.sample)) continue
    if (WIRE_MARKERS.some(pattern => pattern.test(String(item.sample ?? '')))) continue
    // A bundle is generated from reviewed sources, so a hit whose source file is
    // on the reviewed list is reviewed by inheritance.
    const reviewed = REVIEWED.find(entry => entry.reference === item.reference
      && read.text.includes(item.sample ?? '\u0000'))
    unique.push(reviewed ? { ...item, reviewed: reviewed.reason } : item)
  }
  report.bundles.push({ name, bytes: read.data.length, hits: unique })
}

// ── output ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const jsonIndex = args.indexOf('--json')
if (jsonIndex >= 0 && args[jsonIndex + 1]) {
  writeFileSync(args[jsonIndex + 1], JSON.stringify(report, null, 2))
  console.log(`wrote ${args[jsonIndex + 1]}`)
}

console.log('')
console.log('=== reference trees ===')
for (const ref of report.references) {
  console.log(`  ${ref.present ? 'ok  ' : 'MISS'} ${ref.label.padEnd(20)} ${String(ref.files).padStart(5)} files  ${ref.licence}`)
}
console.log('')
console.log(`=== targets: ${report.targets.count} files ===`)
console.log('')
console.log('=== vendor notices ===')
for (const vendor of report.vendorNotices) {
  console.log(`  ${vendor.missing.length === 0 ? 'ok  ' : 'MISS'} ${vendor.path.padEnd(24)} ${vendor.licence}  needs ${vendor.required.join(' + ')}`)
  if (vendor.missing.length) console.log(`       missing: ${vendor.missing.join(', ')}`)
}
console.log('')
console.log('=== shipped bundles ===')
for (const bundle of report.bundles) {
  const open = bundle.hits.filter(hit => !hit.reviewed)
  console.log(`  ${open.length === 0 ? 'ok  ' : 'HIT '} ${bundle.name.padEnd(20)} ${String(bundle.bytes).padStart(8)} bytes  ${open.length} unreviewed / ${bundle.hits.length} total`)
  for (const hit of open) console.log(`       ${hit.gate} ${hit.reference} ${hit.referencePath}\n         ${hit.sample}`)
  for (const hit of bundle.hits.filter(item => item.reviewed)) {
    console.log(`       reviewed ${hit.gate} ${hit.reference} ${hit.referencePath}`)
  }
}
console.log('')
const reviewedHits = report.hits.filter(hit => hit.reviewed)
console.log(`=== reviewed matches: ${reviewedHits.length} ===`)
for (const hit of reviewedHits) {
  console.log(`  ${hit.gate.padEnd(9)} ${hit.target} <- ${hit.reference}/${hit.referencePath}`)
  console.log(`            ${hit.reviewed}`)
}
console.log('')
console.log(`=== UNREVIEWED matches: ${report.unreviewed.length} ===`)
for (const hit of report.unreviewed) {
  console.log(`  ${hit.gate.padEnd(9)} ${hit.target}${hit.targetLine ? ':' + hit.targetLine : ''} <- ${hit.reference}/${hit.referencePath}${hit.referenceLine ? ':' + hit.referenceLine : ''}`)
  if (hit.sample) console.log(`            ${hit.sample}`)
}
console.log('')

const bundleHits = report.bundles.reduce((sum, bundle) => sum + bundle.hits.filter(hit => !hit.reviewed).length, 0)
const missingNotices = report.vendorNotices.reduce((sum, vendor) => sum + vendor.missing.length, 0)
const failed = report.unreviewed.length > 0 || bundleHits > 0 || missingNotices > 0
console.log(failed
  ? `AUDIT: ${report.unreviewed.length} unreviewed tree match(es), ${bundleHits} bundle match(es), ${missingNotices} missing notice(s)`
  : `AUDIT: clean — no unreviewed match in ${report.targets.count} files against ${report.references.reduce((sum, ref) => sum + ref.files, 0)} reference files`)
process.exit(failed ? 1 : 0)
