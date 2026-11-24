/**
 * Download the upstream OpenCode release assets this plugin's free lane must
 * reproduce verbatim.
 *
 * Why a download step at all: the free tier fingerprints the shaped body — the
 * official system prompt and the tool definitions (description AND parameter
 * schema, character for character). A hand-authored rewrite of either is
 * refused with `FreeUsageLimitError`, which is what issue #888/#890 report.
 * `scripts/build-o2a-assets.mjs` turns these files into the plugin's own asset
 * format; this script only fetches and records provenance.
 *
 * Source: `sst/opencode` (MIT), tag pinned to the version this lane claims to be
 * on (`V2_CLIENT_VERSION` in `src/o2a/version.js`). Nothing here is vendored
 * into the repository: the download lands in `.build-cache/`, which is ignored.
 *
 * Usage:
 *   node scripts/fetch-opencode-assets.mjs            # fetch the pinned tag
 *   node scripts/fetch-opencode-assets.mjs --force    # ignore the cache
 *
 * Any file that cannot be fetched is a hard failure. A partial asset set would
 * produce a body that is byte-different from the official client, which is
 * exactly the failure mode this script exists to prevent — so it never degrades.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

/** The upstream tag to read. Must match `V2_CLIENT_VERSION` in src/o2a/version.js. */
const TAG = 'v2.2.3'
const REPO = 'sst/opencode'

/**
 * Every file the asset builder reads. The tool list is the 13 the official v2
 * client ships on `/inference`; `shell-select` decides the shell NAME that the
 * shell tool description interpolates, so it is an input too, not a nicety.
 */
const FILES = [
  'packages/core/src/session/runner/prompt/system.txt',
  'packages/core/src/session/system-prompt.ts',
  'packages/core/src/tool/plugin/read.ts',
  'packages/core/src/tool/plugin/shell.ts',
  'packages/core/src/tool/plugin/edit.ts',
  'packages/core/src/tool/plugin/glob.ts',
  'packages/core/src/tool/plugin/grep.ts',
  'packages/core/src/tool/plugin/write.ts',
  'packages/core/src/tool/plugin/patch.ts',
  'packages/core/src/tool/plugin/webfetch.ts',
  'packages/core/src/tool/plugin/websearch.ts',
  'packages/core/src/tool/plugin/question.ts',
  'packages/core/src/tool/plugin/skill.ts',
  'packages/core/src/tool/plugin/subagent.ts',
  'packages/core/src/tool/plugin/todo.ts',
  // Two tool descriptions are whole files rather than string literals.
  'packages/core/src/tool/patch.txt',
  'packages/core/src/tool/todowrite.txt',
  // `read` and `glob` build their Input from shared schema fragments, so the
  // builder needs those definitions to reproduce the parameter schema exactly.
  'packages/core/src/tool/read-filesystem.ts',
  'packages/core/src/filesystem.ts',
  'packages/core/src/schema.ts',
  'packages/core/src/skill.ts',
  'packages/schema/src/question.ts',
  'packages/core/src/shell/select.ts',
]

const cacheDir = path.join(root, '.build-cache', `opencode-${TAG}`)
const force = process.argv.includes('--force')

/** One `gh api` call, retried on the transient failures a shared runner sees. */
async function gh(args, attempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { stdout } = await run('gh', args, { maxBuffer: 32 * 1024 * 1024, cwd: root })
      return stdout
    } catch (error) {
      lastError = error
      const message = String(error?.stderr ?? error?.message ?? error)
      // A rate limit and a network blip both deserve the backoff; a 404 does not.
      if (/HTTP 404|Not Found/.test(message)) break
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1500 * attempt))
    }
  }
  throw lastError
}

/** Fetch one file's bytes at the pinned tag. */
async function fetchFile(relative) {
  const encoded = relative.split('/').map(encodeURIComponent).join('/')
  const meta = JSON.parse(await gh(['api', `repos/${REPO}/contents/${encoded}?ref=${TAG}`]))
  if (meta.type !== 'file' || typeof meta.sha !== 'string') {
    throw new Error(`${relative}: not a file at ${TAG}`)
  }
  // The contents endpoint inlines base64 for files up to 1 MB; every asset here
  // is far smaller, and a larger one would be a sign the path moved.
  if (typeof meta.content !== 'string' || meta.content === '') {
    throw new Error(`${relative}: no inline content (size ${meta.size}); the path may have moved`)
  }
  const bytes = Buffer.from(meta.content, 'base64')
  if (bytes.length !== meta.size) {
    throw new Error(`${relative}: decoded ${bytes.length} bytes, expected ${meta.size}`)
  }
  return { bytes, sha: meta.sha, size: meta.size }
}

const manifest = { repo: REPO, tag: TAG, fetchedAt: new Date().toISOString(), files: {} }
fs.mkdirSync(cacheDir, { recursive: true })

for (const relative of FILES) {
  const target = path.join(cacheDir, relative)
  const cached = path.join(cacheDir, `${relative}.sha`)
  if (!force && fs.existsSync(target) && fs.existsSync(cached)) {
    const sha = fs.readFileSync(cached, 'utf8').trim()
    const bytes = fs.readFileSync(target)
    manifest.files[relative] = { sha, size: bytes.length, cached: true }
    console.log(`cached   ${relative} (${bytes.length} B)`)
    continue
  }
  const { bytes, sha } = await fetchFile(relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes)
  fs.writeFileSync(cached, `${sha}\n`)
  manifest.files[relative] = { sha, size: bytes.length, cached: false }
  console.log(`fetched  ${relative} (${bytes.length} B, ${sha.slice(0, 12)})`)
}

fs.writeFileSync(path.join(cacheDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`\n${Object.keys(manifest.files).length} files under ${path.relative(root, cacheDir)}`)
console.log('Next: node scripts/build-o2a-assets.mjs')
