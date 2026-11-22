/**
 * The OpenCode v2 fingerprint exists twice — once in this plugin's own free lane
 * (`src/upstream.js`) and once in the vendored channel pack
 * (`vendor/channel-pack/src/opencode*.ts`), because the pack is upstream's code
 * and cannot import ours. Two copies of a fingerprint that must be
 * byte-identical is exactly the shape that rots: one side gets the next upstream
 * change and the other keeps answering 403 FreeTierError.
 *
 * This suite is the drift guard. It imports both implementations and asserts
 * they agree on the things the gate reads: the gate tool names, the tool
 * definitions themselves, the v2 User-Agent shape, and the header set
 * (including the v1 header neither may send). The lane additionally mirrors the
 * opencode2api reference (src/o2a): it renames every client tool opaquely and
 * ships the full official tool set, where the pack keeps its verified two-tool
 * subset — this file pins the overlap, not the superset.
 *
 * Run: node scripts/opencode-parity-test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { CLIENT_TOOL_PREFIX, clientToolWireName } from '../src/o2a/tool-renames.js'
import { V2_OFFICIAL_TOOL_ORDER } from '../src/o2a/official-tools.js'
import * as officialTools from '../src/o2a/official-tools.js'

/** Order-insensitive stringify: the two copies render schemas in their own key orders. */
const canonical = value => JSON.stringify(value, (key, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort()) : val))

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const undiciStub = new URL('./lib/undici-stub.mjs', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (specifier === 'undici') return { url: undiciStub, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (fs.existsSync(target)) return { url: target.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
    }
    return nextLoad(url, context)
  },
})

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}

try {
  const up = await import('../src/upstream.js')
  const messages = await import('../vendor/channel-pack/src/opencode-messages.ts')
  const product = await import('../vendor/channel-pack/src/opencode-product.ts')
  const identity = await import('../vendor/channel-pack/src/opencode.ts')

  const chatShape = tools => tools.map(tool => tool.function ?? tool)
  const laneBody = {}
  up.applyFingerprint(laneBody, false)
  const laneTools = chatShape(laneBody.tools)
  const packBody = messages.buildOpencodePayloadWithToolMap({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }).payload
  const packTools = chatShape(packBody.tools)

  console.log('=== 1. the gate names agree, and the lane ships the full official set ===')
  check('gate names', [...messages.FREE_LANE_GATE_TOOLS], [...up.FINGERPRINT_TOOLS])
  check('the pack injects both', packTools.map(tool => tool.name), ['read', 'shell'])
  // The lane now mirrors the reference gateway (o2a): the full 13-tool official
  // set, of which the pack's two are the gate subset.
  check('the lane declares the full official set', V2_OFFICIAL_TOOL_ORDER.every(name => laneTools.some(tool => tool.name === name)), true)
  check('the lane declares the pack’s gate names', ['read', 'shell'].every(name => laneTools.some(tool => tool.name === name)), true)

  console.log('\n=== 2. both copies carry the upstream definitions verbatim ===')
  // This used to assert that the lane's prose matched a hand-authored rewrite of
  // the official descriptions, on the theory that only the argument shape
  // mattered. That theory was wrong: the free tier compares the description and
  // the parameter schema character for character, and a rewritten description is
  // answered with 429 FreeUsageLimitError rather than a shape error — which is
  // why this check now pins the verbatim upstream text on both sides.
  const contracts = JSON.parse(fs.readFileSync(new URL('../src/o2a/assets/ofm-tool-contracts.json', import.meta.url), 'utf8'))
  for (const name of ['read', 'shell']) {
    const lane = laneTools.find(tool => tool.name === name)
    const pack = packTools.find(tool => tool.name === name)
    // The `shell` description is a template: the client fills `${OS}`/`${shell}`
    // for the machine it runs on, and so does the lane.
    const expected = name === 'shell' ? officialTools.v2ShellDescription(contracts[name].description) : contracts[name].description
    check(`${name}: lane description is the upstream text`, lane.description, expected)
    // The pack still carries the pre-2.2.x wording, which hard-codes Linux/bash.
    // The lane renders the platform template instead, so on a non-Linux host the
    // two legitimately differ — compare them only where they describe the same
    // machine, and otherwise just require that the pack's is the Linux rendering.
    if (process.platform === 'linux') {
      check(`${name}: lane description equals the pack's`, lane.description, pack.description)
    } else if (name === 'shell') {
      check(`${name}: the pack still carries the Linux wording`, pack.description, officialTools.v2ShellDescription(contracts[name].description, 'linux'))
    } else {
      check(`${name}: lane description equals the pack's`, lane.description, pack.description)
    }
    check(`${name}: parameters match the upstream schema`, canonical(lane.parameters), canonical(contracts[name].parameters))
    check(`${name}: parameters match the pack's`, canonical(lane.parameters), canonical(pack.parameters))
    // A parameter description is part of the fingerprint, so it must survive.
    for (const key of Object.keys(contracts[name].parameters.properties)) {
      check(`${name}.${key}: keeps its parameter description`, typeof lane.parameters.properties[key].description, 'string')
    }
  }

  console.log('\n=== 3. the User-Agent is the canonical v2 shape on both sides ===')
  // Both copies must be a bare `opencode/latest/<2.x>/cli` token. The lane takes
  // its version from the o2a port (currently 2.1.1); the pack pins its own —
  // the two may drift in version, never in shape.
  const v2Shape = token => /^opencode\/latest\/2\.\d+\.\d+\/cli$/.test(token)
  check('the lane sends a v2 token', v2Shape(up.CLIENT_UA), true)
  check('the pack defaults to a v2 token', v2Shape(product.OPENCODE.defaultUserAgent), true)
  check('a detected v1 install version is refused', identity.opencodeUserAgentForVersion('1.18.31'), undefined)
  check('a detected v2 install version becomes the v2 shape', identity.opencodeUserAgentForVersion('2.0.29'), 'opencode/latest/2.0.29/cli')
  check('an arbitrary UA override falls back to the pack\u2019s token', identity.opencodeUserAgent('opencode/1.18.31'), product.OPENCODE.defaultUserAgent)
  check('a v2 override passes through', identity.opencodeUserAgent('opencode/latest/2.0.29/desktop'), 'opencode/latest/2.0.29/desktop')

  console.log('\n=== 4. the header sets agree, and neither sends the v1 request header ===')
  const session = 'ses_0123456789abABCDEFGHIJKLMN'
  const laneHeaders = up.gatewayHeaders({ session, stream: true })
  const packHeaders = identity.opencodeHeaders({ projectId: 'a'.repeat(40), generation: 1 }, session, up.CLIENT_UA)
  for (const name of ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']) {
    check(`both send ${name}`, [laneHeaders[name], packHeaders[name]], [session, session])
  }
  check('both report the cli client', [laneHeaders['x-opencode-client'], packHeaders['x-opencode-client']], ['cli', 'cli'])
  check('both carry the v2 UA', [laneHeaders['user-agent'], packHeaders['user-agent']], [up.CLIENT_UA, up.CLIENT_UA])
  check('neither sends x-opencode-request', ['x-opencode-request' in laneHeaders, 'x-opencode-request' in packHeaders], [false, false])

  console.log('\n=== 5. the channel pack lists the free models this change added ===')
  const free = new Map(product.OPENCODE_FALLBACK_MODELS.map(model => [model.id, model]))
  check('deepseek-v4.1-flash-free is free and reachable', [free.has('deepseek-v4.1-flash-free'), free.get('deepseek-v4.1-flash-free')?.isFree], [true, true])
  check('glm-5.3-flash-free is free and reachable', [free.has('glm-5.3-flash-free'), free.get('glm-5.3-flash-free')?.isFree], [true, true])
  check('both carry a positive context window', [free.get('deepseek-v4.1-flash-free').contextWindow > 0, free.get('glm-5.3-flash-free').contextWindow > 0], [true, true])

  console.log('\n=== 6. a caller tool on a gate name moves aside on both sides ===')
  // The lane reserves an official name for the official definition: a caller
  // `read` takes an opaque handle and the official `read` is appended verbatim.
  // A caller schema at the official name is what the upstream answers with 429
  // (measured 2026-11-22 against DSH's own `bash` tool).
  // The pack keeps the read_client alias it verified live — the pack's
  // OpenCode lane is disabled in this product, so its older contract stays
  // pinned as-is. Both must keep the official name singular and restorable.
  const conflict = { type: 'function', function: { name: 'read', description: 'the caller read', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }
  const laneConflict = { tools: [conflict] }
  const laneMap = up.applyFingerprint(laneConflict, false)
  const laneWire = clientToolWireName('read')
  check('the lane moves the caller read to a handle', laneConflict.tools.filter(tool => tool.function.name === laneWire).length, 1)
  check('the lane declares the official read once', laneConflict.tools.filter(tool => tool.function.name === 'read').length, 1)
  check('the official read keeps the official schema', laneConflict.tools.find(tool => tool.function.name === 'read').function.parameters.required, ['path'])
  check('the handle keeps the caller schema', laneConflict.tools.find(tool => tool.function.name === laneWire).function.parameters.properties.x, { type: 'string' })
  check('the lane restores the caller spelling', up.restoreToolName(laneWire, laneMap), 'read')
  const packConflict = messages.buildOpencodePayloadWithToolMap({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read', description: 'the caller read', parameters: { type: 'object', properties: { x: { type: 'string' } } } }] })
  check('the pack aliases it', packConflict.toolNameMap.get('read_client'), 'read')
  check('the pack keeps one official read', packConflict.payload.tools.filter(tool => tool.function?.name === 'read').length, 1)

  // The alias has to reach the conversation history too, not just the declaration
  // list: the model reads its own earlier `read` call as a call to the official
  // tool of that name otherwise, and the two definitions disagree. Both sides
  // must rewrite the same rows — this is the drift the suite exists to catch.
  console.log('\n=== 6b. an aliased tool keeps its history consistent on both sides ===')
  const history = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ]
  const laneHistory = { tools: [conflict], messages: JSON.parse(JSON.stringify(history)) }
  up.applyFingerprint(laneHistory, false)
  const laneName = laneHistory.messages.find(message => Array.isArray(message.tool_calls))?.tool_calls?.[0]?.function?.name
  // The lane's handle is the caller's wire name, so the prior call follows it.
  check('the lane keeps the prior call on the handle', laneName, laneWire)
  check('the lane keeps the result paired', laneHistory.messages.filter(message => message.role === 'tool').length, 1)
  const packHistory = messages.buildOpencodePayloadWithToolMap({ model: 'big-pickle', messages: JSON.parse(JSON.stringify(history)), tools: [{ name: 'read', description: 'the caller read', parameters: { type: 'object', properties: { x: { type: 'string' } } } }] })
  const packName = packHistory.payload.messages.find(message => Array.isArray(message.tool_calls))?.tool_calls?.[0]?.function?.name
  check('the pack rewrites the prior call', packName, 'read_client')
  check('both sides keep history off the conflicting spelling', [packName === 'read_client', laneName === laneWire], [true, true])

  console.log('\n=== 7. neither side sends tool_choice none ===')
  const laneNone = { tools: [], tool_choice: 'none' }
  up.applyFingerprint(laneNone, false)
  check('the lane drops it', laneNone.tool_choice, undefined)
  const packNone = messages.ensureFreeLaneShape({ messages: [{ role: 'user', content: 'hi' }], tools: [], tool_choice: 'none' })
  check('the pack drops it', packNone.tool_choice, undefined)

  console.log('\n=== 8. the channel pack clamps an effort onto the model\'s declared levels ===')
  const adapter = await import('../vendor/channel-pack/src/opencode-adapter.ts')
  const cap = (id, efforts) => ({ id, name: id, modalities: ['text'], contextWindow: 200000, maxOutputTokens: 64000, reasoning: efforts.length > 0, efforts, toolCall: true, isFree: true })
  const deepseek = cap('deepseek-v4.1-flash-free', ['low', 'high', 'max'])
  const toggleOnly = cap('longcat-2.5-preview-free', [])
  check('a declared level goes out unchanged', adapter.resolveOpencodeEffort('deepseek-v4.1-flash-free', 'high', [deepseek]), { effort: 'high', outcome: 'exact' })
  // xhigh(7) is nearest to max(8) among low(3)/high(5)/max(8).
  check('an undeclared level lands on the nearest declared one', adapter.resolveOpencodeEffort('deepseek-v4.1-flash-free', 'xhigh', [deepseek]), { effort: 'max', outcome: 'mapped' })
  // medium(4) sits between low(3) and high(5); the ladder breaks the tie upward.
  check('a tie resolves to the stronger level', adapter.resolveOpencodeEffort('deepseek-v4.1-flash-free', 'medium', [deepseek]), { effort: 'high', outcome: 'mapped' })
  check('a model that declares no menu drops the field', adapter.resolveOpencodeEffort('longcat-2.5-preview-free', 'low', [toggleOnly]), { outcome: 'dropped' })
  check('an unknown model passes the caller value through', adapter.resolveOpencodeEffort('never-seen', 'high', []), { effort: 'high', outcome: 'passthrough' })
  check('no effort asked for, nothing sent', adapter.resolveOpencodeEffort('deepseek-v4.1-flash-free', undefined, [deepseek]), { outcome: 'passthrough' })
} finally {
  hooks.deregister()
}

console.log(failures === 0 ? '\nall opencode parity checks passed' : `\n${failures} opencode parity check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
