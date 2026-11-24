/**
 * One command to sync the embedded Magpie engine with upstream.
 *
 * The engine is an unmodified build of a pinned upstream revision; the only
 * place the pin lives is `revision` in scripts/build-magpie-engine.mjs, and
 * every other surface (vendor/magpie/engine.json, the wrapper's status report,
 * the tests) reads from there. This script is the fast path that statement
 * promises: resolve the target revision, move the pin, rebuild the binary,
 * refresh the packaged parts, and run the suites that guard the contract —
 * the wrapper's HTTP surface and the channel policy — against the new binary.
 *
 *   node scripts/update-magpie-engine.mjs              # latest upstream HEAD
 *   node scripts/update-magpie-engine.mjs <sha>        # one exact revision
 *   node scripts/update-magpie-engine.mjs --pin-only   # move the pin, build later
 *   node scripts/update-magpie-engine.mjs --skip-tests # build without the suites
 *
 * Everything else about integrating a new engine — wrapper, policy, packaging —
 * is upstream-independent by design and stays untouched. If a suite fails here,
 * the upstream change needs a wrapper or policy answer first. The run restores
 * the tree itself: the pin moves back to the previous revision and the vendored
 * engine (binary, metadata, compressed parts) is put back exactly as it was, so
 * a failed update never leaves the new engine behind.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const upstream = 'https://github.com/yetone/magpie.git'
const root = fileURLToPath(new URL('../', import.meta.url))
const builderFile = path.join(root, 'scripts', 'build-magpie-engine.mjs')
const SHA = /^[0-9a-f]{40}$/

function run(command, args) {
  return new Promise((resolve, reject) => {
    // Live output: a build or suite that fails explains itself as it goes.
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('close', code => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(' ')} failed (${code})`)))
  })
}

/** The revision the builder pins right now; undefined when the line is missing. */
async function readPin() {
  const source = await readFile(builderFile, 'utf8')
  const match = source.match(/^export const revision = '([0-9a-f]{40})'$/m)
  if (!match) throw new Error('build-magpie-engine.mjs no longer carries the pinned revision line')
  return match[1]
}

/**
 * The upstream revision to move to: an explicit full sha, or HEAD of the
 * default branch. ls-remote needs no API token and no clone.
 */
function resolveTarget(requested) {
  if (requested === undefined) {
    const answer = spawnSync('git', ['ls-remote', upstream, 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 120000 })
    if (answer.status !== 0) throw new Error(`Resolving upstream HEAD failed: ${answer.stderr}`)
    const sha = answer.stdout.trim().split(/\s+/)[0]
    if (!SHA.test(sha)) throw new Error(`Upstream HEAD is not a full sha: ${answer.stdout.trim()}`)
    return sha
  }
  if (!SHA.test(requested)) throw new Error(`Not a full 40-hex revision: ${requested}`)
  return requested
}

async function writePin(revision) {
  const source = await readFile(builderFile, 'utf8')
  const updated = source.replace(/^export const revision = '[0-9a-f]{40}'$/m,
    `export const revision = '${revision}'`)
  if (updated === source) throw new Error('The pinned revision line did not change')
  await writeFile(builderFile, updated)
}

/**
 * The generated engine state a run replaces: the vendored binary, its metadata
 * (engine.json records the digest and the compressed parts), and the parts
 * themselves. A failed run restores all of it, not only the pin — otherwise a
 * suite failure would leave the new engine vendored behind an old pin.
 */
const ENGINE_STATE = ['vendor/magpie', 'src/engine-parts']

async function snapshotEngineState() {
  const backup = path.join(await mkdtemp(path.join(os.tmpdir(), 'ofm-engine-backup-')), 'state')
  await mkdir(backup, { recursive: true })
  const captured = []
  try {
    for (const rel of ENGINE_STATE) {
      if (existsSync(path.join(root, rel))) {
        await cp(path.join(root, rel), path.join(backup, rel), { recursive: true })
        captured.push(rel)
      }
    }
  } catch (error) {
    // A partial snapshot cannot restore what it missed; fail before anything is mutated.
    await rm(backup, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return { dir: backup, captured }
}

/** Only directories the snapshot actually captured are replaced; the rest stay untouched. */
async function restoreEngineState(snapshot) {
  if (!snapshot) return
  for (const rel of snapshot.captured) {
    const live = path.join(root, rel)
    await rm(live, { recursive: true, force: true })
    await cp(path.join(snapshot.dir, rel), live, { recursive: true })
  }
}

/** The engine suites that guard the wrapper/policy contract; each exits nonzero on failure. */
const suites = [
  'scripts/magpie-engine-test.mjs',
  'scripts/engine-transport-test.mjs',
  'scripts/magpie-models-test.mjs',
  'scripts/magpie-policy-test.mjs',
  'scripts/magpie-plugin-test.mjs',
  'scripts/engine-payload-test.mjs',
]

const args = process.argv.slice(2)
const requested = args.find(arg => !arg.startsWith('--'))
const flags = args.filter(arg => arg.startsWith('--'))
const pinOnly = flags.includes('--pin-only')
const skipTests = flags.includes('--skip-tests')
if (flags.some(flag => !['--pin-only', '--skip-tests'].includes(flag))
  || args.filter(arg => !arg.startsWith('--')).length > 1) {
  console.error('Usage: node scripts/update-magpie-engine.mjs [<sha>] [--pin-only] [--skip-tests]')
  process.exit(1)
}

const previous = await readPin()
const target = resolveTarget(requested)
if (previous === target && !pinOnly && !skipTests) {
  console.log(`update-magpie-engine: already pinned to ${target}; pass --skip-tests to re-verify only`)
}
if (previous !== target) {
  await writePin(target)
  console.log(`update-magpie-engine: pin moved ${previous.slice(0, 12)} -> ${target.slice(0, 12)}`)
} else {
  console.log(`update-magpie-engine: pin unchanged at ${target.slice(0, 12)}`)
}

let backup = null
try {
  if (!pinOnly) {
    // The engine state is replaced wholesale below; keep the pre-run copy so a
    // failure anywhere after this point can put the working engine back.
    backup = await snapshotEngineState()
    await run('node', ['scripts/build-magpie-engine.mjs'])
    // The parts under src/engine-parts and the compressed block in engine.json
    // must describe the new binary, whatever else the legacy payload pass builds.
    await run('node', ['scripts/build-legacy-payload.mjs'])
    const engine = JSON.parse(await readFile(path.join(root, 'vendor', 'magpie', 'engine.json'), 'utf8'))
    const binary = engine.binaries[`${process.platform}-${process.arch}`]
    const digest = createHash('sha256').update(await readFile(path.join(root, 'vendor', 'magpie', binary.path))).digest('hex')
    if (digest !== binary.sha256) throw new Error('Built binary does not match the manifest it was written with')
    console.log(`update-magpie-engine: built ${binary.path} sha256=${digest.slice(0, 16)}…`)
    if (!skipTests) {
      for (const suite of suites) {
        console.log(`update-magpie-engine: ${path.basename(suite)}`)
        await run('node', [suite])
      }
    }
  }
} catch (error) {
  // A failed run must not leave the new engine behind: put the pin and the
  // vendored engine state (binary, metadata, parts) back the way they were.
  if (!pinOnly && previous !== target) {
    await writePin(previous)
    console.error(`update-magpie-engine: pin moved back to ${previous.slice(0, 12)} after the failure`)
  }
  if (!pinOnly) {
    await restoreEngineState(backup)
    if (backup !== null) console.error('update-magpie-engine: vendored engine restored to its pre-run state')
  }
  throw error
} finally {
  // Nothing failed: the backup of the previous engine is no longer needed.
  if (backup !== null) await rm(path.dirname(backup.dir), { recursive: true, force: true }).catch(() => {})
}
console.log(`update-magpie-engine: done (${previous.slice(0, 12)} -> ${target.slice(0, 12)}${pinOnly ? ', pin only' : ''})`)
