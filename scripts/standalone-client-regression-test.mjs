import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { computeMembership, createModelRuntime } from '../src/core/runtime.js'
import { buildModelVisibility, hiddenIdsFor, isModelHidden, isModelHiddenByGroup, publicModelVisibility, validateModelVisibility } from '../src/store.js'
import { buildCatalog, buildEacCatalog, buildExtensionCatalog, buildKiloCatalog, catalogFamilyKeys } from '../src/catalog.js'
import { buildAggregateCatalog } from '../src/aggregate.js'
import { buildComboCatalog, normalizeCombos } from '../src/combos.js'
import { subscriptionCatalog } from '../src/subscription-adapter.js'
import { filterModels } from '../packages/standalone/frontend/models-data.mjs'
import { visibilityCopy } from '../packages/standalone/frontend/visibility-data.mjs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { Shell, FreePage, ChannelCard, DICT, Roster, ModelCard, Preferences, ModelPicker, ChainEditor, ChainCard, ChainCapacity,')
let bundle
const window = {
  __ModuleLoader__: { load: value => { bundle = value } },
  localStorage: { getItem: key => key === 'ofm.tab' ? 'free' : null },
}
let cursor = 0
const cells = []
let captureEffects = false
const effects = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'fragment',
  useState(initial) {
    const at = cursor++
    if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial
    return [cells[at], value => { cells[at] = typeof value === 'function' ? value(cells[at]) : value }]
  },
  useRef(initial) { const at = cursor++; return cells[at] ??= { current: initial } },
  useEffect(effect) { if (captureEffects) effects.push(effect) },
  useMemo: callback => callback(),
  useCallback: callback => callback,
}
let release, reject
const calls = []
const fetch = async (url, options) => {
  calls.push({ url, options })
  if (url.endsWith('/combos/preview')) {
    const { models } = JSON.parse(options.body)
    const capacity = buildComboCatalog([{ id: 'combo:preview', models }], capacityModels)[0] ?? null
    return { ok: true, text: async () => JSON.stringify({ capacity }) }
  }
  return new Promise((resolve, fail) => {
    release = () => resolve({ ok: true, text: async () => '{}' })
    reject = fail
  })
}
new Function('window', 'fetch', source)(window, fetch)
const { Shell, FreePage, ChannelCard, DICT, Roster, ModelCard, Preferences, ModelPicker, ChainEditor, ChainCard, ChainCapacity } = bundle.factory(() => react).__test
const t = key => DICT.zh[key] ?? key
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes)
  : tree && typeof tree === 'object' ? [tree, ...nodes(tree.children)] : []
const render = (Component, props) => { cursor = 0; return Component(props) }
const correctionFailures = []
const verifyCorrection = (name, actual, expected) => {
  try { assert.deepEqual(actual, expected) } catch { correctionFailures.push(name) }
}
let summaryReads = 0, statsReads = 0
const props = {
  t, data: { catalog: [], settings: {} }, counts: {}, busy: false,
  summary: { status: 'ready', reload: () => { summaryReads++ } },
  stats: { reload: () => { statsReads++ } },
  setBusy: () => assert.fail('catalog requests must not lock settings writes'),
}
const page = () => nodes(render(Shell, props)).find(node => node.type === FreePage)
const first = page().props.reprobe()
const duplicate = page().props.refresh()
assert.equal(calls.length, 1, 'a pending probe excludes duplicate catalog operations')
assert.equal(page().props.catalogBusy, true)
assert.equal(page().props.busy, false, 'other settings remain available while probing')
await duplicate
release()
await first
assert.equal(page().props.catalogBusy, false)
assert.equal(summaryReads, 1)
assert.equal(statsReads, 1)
const failed = page().props.reprobe()
reject(new Error('isolated probe failure'))
await failed
assert.equal(page().props.catalogBusy, false, 'failure must release the probe controls')
const retry = page().props.refresh()
assert.equal(calls.length, 3, 'a failed probe can be retried')
release()
await retry

cells.length = 0
let models = [{ id: 'retired', dead: true, disabled: true }]
let accounts = [{ id: 'account', nickname: 'Fixture', enabled: true }]
const rpcCalls = []
let changed = 0
const channelProps = {
  t, channel: { id: 'lobsterai', name: 'LobsterAI' }, status: {},
  onError: (_provider, error) => { throw error },
  onChanged: () => { changed++ },
  rpc: async (method, payload) => {
    rpcCalls.push({ method, payload })
    if (method === 'model.clearDead') models = models.map(model => ({ ...model, dead: false }))
    if (method === 'model.setDisabled') models = models.map(model => ({ ...model, disabled: payload.disabled }))
    if (method === 'account.update') accounts = accounts.map(row => ({ ...row, ...payload.patch }))
    return { models, accounts }
  },
}
const button = (tree, text) => nodes(tree).find(node => node.type === 'button' && node.children.includes(text))
let card = render(ChannelCard, channelProps)
await button(card, '模型').props.onClick()
card = render(ChannelCard, channelProps)
assert.ok(nodes(card).some(node => node.children.includes('已隐藏')))
await button(card, '恢复显示').props.onClick()
assert.equal(rpcCalls.find(call => call.method === 'model.clearDead').payload.modelId, 'retired')
assert.equal(models[0].disabled, true, 'restoring a retired model preserves the user blacklist')
assert.equal(rpcCalls.some(call => call.method === 'model.setDisabled'), false)
card = render(ChannelCard, channelProps)
await button(card, '开启').props.onClick()
assert.equal(models[0].disabled, false)
card = render(ChannelCard, channelProps)
await button(card, '账号').props.onClick()
card = render(ChannelCard, channelProps)
assert.ok(nodes(card).some(node => node.children.includes('已启用')))
await button(card, '停用').props.onClick()
card = render(ChannelCard, channelProps)
assert.ok(nodes(card).some(node => node.children.includes('已停用')))
assert.ok(button(card, '启用'))
assert.equal(changed, 3)
console.log('ok  client probe isolation/retry, account action labels, hidden status and retired model restoration')

const catalog = [
  { id: 'free' }, { id: 'region' }, { id: 'kilo', channel: 'kilo' },
  { id: 'eac', channel: 'eac' }, { id: 'aggregate', channel: 'aggregate' },
  { id: 'combo', channel: 'combo' }, { id: 'account', channel: 'lobsterai' },
]
const refused = { results: { free: { state: 'unavailable' }, region: { state: 'unavailable' } } }
const membership = settings => Object.values(computeMembership(catalog, refused, settings)).flat()
assert.deepEqual(membership({}), catalog.map(row => row.id), 'default fallback preserves the advertised catalog')
assert.deepEqual(membership({ hideFreeModels: true }), ['eac', 'aggregate', 'combo', 'account'])
assert.deepEqual(membership({ hideEacModels: true, hiddenModelIds: ['free'] }), ['region', 'kilo', 'aggregate', 'combo', 'account'])
assert.deepEqual(membership({ hideFreeModels: true, hideEacModels: true, hiddenModelIds: ['combo'] }), ['aggregate', 'account'],
  'refusedAll cannot restore preferences; unrelated channels remain isolated')
const region = computeMembership(catalog, { results: { region: { state: 'region-blocked' } } }, { hiddenModelIds: ['region'] })
assert.equal(Object.values(region).flat().includes('region'), false)
for (const patch of [{ hideFreeModels: 1 }, { hideEacModels: null }, { hiddenModelIds: [''] }, { hiddenModelIds: [3] }, null, []]) {
  assert.throws(() => validateModelVisibility(patch), error => error.statusCode === 400)
}
assert.deepEqual(publicModelVisibility({ hiddenModelIds: ['free', 'free', null], forwardKey: 'private' }),
  { hiddenModelIds: ['free'], hideFreeModels: false, hideEacModels: false })

const visibilitySettings = ids => ({ hiddenModelIds: ids })
const mergeForView = rows => {
  const seen = new Set()
  return rows.filter(row => {
    if (!row || seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
}
const directoryVisibility = (candidates, settings) =>
  buildModelVisibility(settings, catalogFamilyKeys(candidates))
const directoryView = (candidates, settings, availability = {}) => {
  const catalog = mergeForView(candidates)
  const visibility = directoryVisibility(candidates, settings)
  return {
    catalog,
    visibility,
    visible: Object.values(computeMembership(catalog, availability, settings, visibility)).flat(),
  }
}
const memoryStore = value => {
  let current = structuredClone(value)
  return {
    get: () => current,
    edit: change => (current = change(current)),
    update: patch => (current = { ...current, ...patch }),
    flush() {},
    dispose() {},
  }
}
const visibilityRuntime = ({ entries = [], sealIds = [], kiloRows = [], settings = {} }) => createModelRuntime({
  settings: memoryStore({
    enabled: true, hiddenModelIds: [], hideFreeModels: false, hideEacModels: false,
    exposeRegionModels: true, combos: [], aggregate: { enabled: false, providers: {} }, ...settings,
  }),
  stats: memoryStore({ models: {} }),
  availability: memoryStore({ results: {} }),
  catalogStore: memoryStore({ entries, sealIds, kiloRows }),
  sealedCredential: () => sealIds.length > 0 ? 'fixture-only' : null,
  logger: { warn() {} },
})

const sourceBeam = [buildCatalog(['beam-free'])[0], buildEacCatalog(['opencode/beam-free'])[0],
  buildKiloCatalog([{ id: 'reflection/beam-free', isFree: true }])[0]]
const sourceNemotron = [buildCatalog(['nemotron-3.5-lightning-free'])[0],
  buildEacCatalog(['opencode/nemotron-3.5-lightning-free'])[0],
  buildKiloCatalog([{ id: 'nvidia/nemotron-3.5-lightning:free', isFree: true }])[0]]
const familyMap = catalogFamilyKeys([...sourceBeam, ...sourceNemotron])
verifyCorrection('the directory gives each Beam alias the same family key',
  sourceBeam.map(row => familyMap.get(row.id)), ['beam', 'beam', 'beam'])
verifyCorrection('the directory gives each Lightning alias the same family key',
  sourceNemotron.map(row => familyMap.get(row.id)),
  ['nemotron-3.5-lightning', 'nemotron-3.5-lightning', 'nemotron-3.5-lightning'])
for (const row of sourceBeam) {
  verifyCorrection(`hide Beam from ${row.channel ?? 'anonymous'}`, directoryView(sourceBeam, visibilitySettings([row.id])).visible, [])
}
for (const row of sourceNemotron) {
  verifyCorrection(`hide Lightning from ${row.channel ?? 'anonymous'}`, directoryView(sourceNemotron, visibilitySettings([row.id])).visible, [])
}
const allBeamSaved = ['foreign', ...sourceBeam.map(row => row.id)]
const savedBeamView = directoryView(sourceBeam, visibilitySettings(allBeamSaved))
for (const row of sourceBeam) {
  verifyCorrection(`Beam rows recover only the real saved family ids: ${row.id}`,
    hiddenIdsFor(row, savedBeamView.visibility), sourceBeam.map(saved => saved.id))
}
const beamRuntime = visibilityRuntime({
  entries: ['beam-free'], sealIds: ['opencode/beam-free'], kiloRows: [sourceBeam[2]],
  settings: visibilitySettings(['beam-free']),
})
const beamRuntimeState = beamRuntime.state()
verifyCorrection('the runtime state uses the same pre-dedupe directory evidence for routing and restore ids', [
  Object.values(beamRuntimeState.membership).flat(),
  hiddenIdsFor(sourceBeam[0], beamRuntimeState.visibility),
], [[], ['beam-free']])
beamRuntime.dispose()
verifyCorrection('the direct three-argument membership call derives the complete directory',
  Object.values(computeMembership(sourceBeam, {}, visibilitySettings(['beam-free']))).flat(), [])
verifyCorrection('refusedAll cannot restore an explicitly hidden family',
  directoryView(sourceBeam, visibilitySettings(['beam-free']), {
    results: { 'beam-free': { state: 'unavailable' } },
  }).visible, [])
verifyCorrection('a hidden directory family leaves neither the main nor region route',
  computeMembership(sourceBeam, { results: { 'beam-free': { state: 'region-blocked' } } },
    visibilitySettings(['beam-free']), directoryVisibility(sourceBeam, visibilitySettings(['beam-free']))), {})

const pickleFamily = [buildCatalog(['big-pickle'])[0], buildEacCatalog(['opencode/big-pickle'])[0]]
for (const row of pickleFamily) {
  verifyCorrection(`hide Big Pickle from ${row.channel ?? 'anonymous'}`,
    directoryView(pickleFamily, visibilitySettings([row.id])).visible, [])
}
for (const [eacId, kiloId] of [
  ['nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3-ultra-550b-a55b:free'],
  ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'],
]) {
  const aliases = [buildEacCatalog([eacId])[0], buildKiloCatalog([{ id: kiloId, isFree: true }])[0]]
  for (const row of aliases) {
    verifyCorrection(`hide NVIDIA alias from ${row.channel}`,
      directoryView(aliases, visibilitySettings([row.id])).visible, [])
  }
}
for (const name of ['longcat-2.5', 'tidepool-alpha', 'iceman', 'flint-40b', 'nemotron-3.5-super-vl']) {
  const aliases = [buildCatalog([`${name}-free`])[0], buildEacCatalog([`opencode/${name}`])[0],
    buildKiloCatalog([{ id: `opencode/${name}:free`, isFree: true }])[0]]
  for (const row of aliases) {
    verifyCorrection(`hide registered ${name} alias from ${row.channel ?? 'anonymous'}`,
      directoryView(aliases, visibilitySettings([row.id])).visible, [])
  }
}

const providerPrefixFamilies = [
  [buildEacCatalog(['openai/gpt-oss-20b'])[0], buildCatalog(['gpt-oss-20b-free'])[0]],
  [buildEacCatalog(['cohere/north-mini-code'])[0],
    buildKiloCatalog([{ id: 'cohere/north-mini-code:free', isFree: true }])[0]],
]
for (const family of providerPrefixFamilies) {
  for (const hidden of family) {
    verifyCorrection(`hide shared-prefix family from ${hidden.id}`,
      directoryView(family, visibilitySettings([hidden.id])).visible, [])
  }
}

const deepseekFree = buildCatalog(['deepseek-v4.1-flash-free'])[0]
const deepseekPro = buildEacCatalog(['deepseek-v4.1-flash-pro'])[0]
const negativeRows = [
  deepseekFree, deepseekPro,
  buildCatalog(['glm-5.3-flash-free'])[0], buildCatalog(['glm-5.3-free'])[0],
  buildKiloCatalog([{ id: 'openrouter/free', isFree: true }])[0],
  buildKiloCatalog([{ id: 'kilo-auto/free', isFree: true }])[0],
  buildEacCatalog(['vendor-a/shared-model'])[0],
  buildKiloCatalog([{ id: 'vendor-b/shared-model:free', isFree: true }])[0],
]
verifyCorrection('negative fixtures use real directory rows', negativeRows.map(row => row?.id ?? null), [
  'deepseek-v4.1-flash-free', 'deepseek-v4.1-flash-pro', 'glm-5.3-flash-free', 'glm-5.3-free',
  'openrouter/free', 'kilo-auto/free', 'vendor-a/shared-model', 'vendor-b/shared-model:free',
])
const negativeMap = catalogFamilyKeys(negativeRows)
const negativeInitial = directoryView(negativeRows, visibilitySettings([]))
verifyCorrection('the paid lookalike is an eligible row and starts public beside the free id', [
  negativeMap.has(deepseekFree.id),
  negativeMap.has(deepseekPro.id),
  negativeInitial.visible.includes(deepseekFree.id),
  negativeInitial.visible.includes(deepseekPro.id),
], [true, true, true, true])
verifyCorrection('bare free ids do not acquire a family key',
  [negativeMap.get('openrouter/free'), negativeMap.get('kilo-auto/free')], [null, null])
verifyCorrection('different namespaces with the same suffix remain distinct',
  [negativeMap.get('vendor-a/shared-model'), negativeMap.get('vendor-b/shared-model:free')],
  ['vendor-a/shared-model', 'vendor-b/shared-model'])
const hiddenDeepseek = directoryView(negativeRows, visibilitySettings([deepseekFree.id]))
verifyCorrection('hiding the free id leaves the real paid lookalike public with no recovery ids', [
  hiddenDeepseek.visible.includes(deepseekPro.id),
  hiddenIdsFor(deepseekPro, hiddenDeepseek.visibility),
], [true, []])
const paidLookalikeRuntime = visibilityRuntime({
  entries: [deepseekFree.id], sealIds: [deepseekPro.id], settings: visibilitySettings([deepseekFree.id]),
})
verifyCorrection('the public model rows keep the paid lookalike when only its free near-name is hidden',
  paidLookalikeRuntime.publicModelRows().map(row => row.id), [deepseekPro.id])
paidLookalikeRuntime.dispose()
for (const [saved, target] of [
  ['deepseek-v4.1-flash-free', 'deepseek-v4.1-flash-pro'],
  ['glm-5.3-flash-free', 'glm-5.3-free'],
  ['openrouter/free', 'kilo-auto/free'],
  ['kilo-auto/free', 'openrouter/free'],
  ['vendor-a/shared-model', 'vendor-b/shared-model:free'],
  ['vendor-b/shared-model:free', 'vendor-a/shared-model'],
]) {
  const settings = visibilitySettings([saved])
  const targetRow = negativeRows.find(row => row.id === target)
  verifyCorrection(`negative target ${target} is present in the directory`, Boolean(targetRow), true)
  verifyCorrection(`${saved} must not hide lookalike ${target}`,
    isModelHidden(targetRow, settings, directoryVisibility(negativeRows, settings)), false)
}

const aggregateOff = { enabled: false, providers: {} }
const aggregateRow = buildAggregateCatalog({ providers: {
  opencode_zen: { enabled: true, apiKey: 'fixture-only' },
} }).find(row => row.id === 'opencode_zen/nemotron-3.5-lightning-free')
const slashCombo = buildComboCatalog(normalizeCombos([
  { id: 'combo:fixture/beam-free', name: 'Beam chain', models: ['beam-free'] },
]), sourceBeam)[0]
const subscriptionRow = subscriptionCatalog({
  catalog: () => [{ id: 'subscription:fixture/beam-free', name: 'Beam subscription' }],
  complete() {},
})[0]
const extensionRow = buildExtensionCatalog({ id: 'fixture-extension', name: 'Fixture' }, [{
  id: 'extension-shared-model',
}])[0]
assert.ok(aggregateRow && slashCombo && subscriptionRow && extensionRow)
const zenRuntime = visibilityRuntime({
  entries: ['nemotron-3.5-lightning-free'], sealIds: ['opencode/nemotron-3.5-lightning-free'],
  kiloRows: [sourceNemotron[2]],
  settings: {
    ...visibilitySettings([aggregateRow.id]),
    aggregate: { providers: { opencode_zen: {
      enabled: true, apiKey: 'fixture-only', models: ['nemotron-3.5-lightning-free'],
    } } },
  },
})
const zenRuntimeState = zenRuntime.state()
verifyCorrection('the runtime keeps the three Lightning lanes visible when only its default OpenCode Zen row is saved', [
  Object.values(zenRuntimeState.membership).flat().sort(),
  hiddenIdsFor(sourceNemotron[0], zenRuntimeState.visibility),
], [sourceNemotron.map(row => row.id).sort(), []])
zenRuntime.dispose()
const foreignHiddenIds = [aggregateRow.id, slashCombo.id, subscriptionRow.id, extensionRow.id]
const mixedCandidates = [...sourceBeam, ...sourceNemotron, aggregateRow, slashCombo, subscriptionRow, extensionRow]
const foreignView = directoryView(mixedCandidates, visibilitySettings(foreignHiddenIds))
verifyCorrection('foreign saved ids hide only their exact non-family rows',
  foreignView.visible, [...sourceBeam, ...sourceNemotron].map(row => row.id))
for (const row of [...sourceBeam, ...sourceNemotron]) {
  verifyCorrection(`non-family ids stay out of ${row.channel ?? 'anonymous'} hiddenIds`,
    hiddenIdsFor(row, foreignView.visibility), [])
}
for (const row of [aggregateRow, slashCombo, subscriptionRow, extensionRow]) {
  verifyCorrection(`exact matching still works for ${row.channel}`, [
    hiddenIdsFor(row, directoryVisibility(mixedCandidates, visibilitySettings([foreignHiddenIds[0], row.id]))),
    hiddenIdsFor(row, directoryVisibility(mixedCandidates, visibilitySettings([row.id, row.id]))),
  ], [[row.id], [row.id]])
}
const groupOnlyVisibility = directoryVisibility(mixedCandidates, visibilitySettings([]))
verifyCorrection('group-only hiding exposes no restore ids but still disables pure-free combos', [
  hiddenIdsFor(slashCombo, groupOnlyVisibility),
  isModelHiddenByGroup(slashCombo, { hideFreeModels: true }),
  isModelHidden(slashCombo, { hideFreeModels: true }, groupOnlyVisibility),
], [[], true, true])

const zenConfigs = [
  { providers: { opencode_zen: { enabled: true, apiKey: 'fixture-only' } } },
  { providers: { opencode_zen: { enabled: true, apiKey: 'fixture-only', models: [] } } },
  { providers: { opencode_zen: { enabled: true, apiKey: 'fixture-only', models: ['nemotron-3.5-lightning-free'] } } },
  { providers: { opencode_zen: { enabled: true, apiKey: 'fixture-only', discovered: ['nemotron-3.5-lightning-free'] } } },
]
for (const [index, config] of zenConfigs.entries()) {
  const row = buildAggregateCatalog(config).find(candidate => candidate.id === 'opencode_zen/nemotron-3.5-lightning-free')
  assert.ok(row, `OpenCode Zen config ${index} builds its default row`)
  const candidates = [...sourceNemotron, row]
  const oneSaved = directoryView(candidates, visibilitySettings([row.id]))
  verifyCorrection(`OpenCode Zen config ${index} hides only its aggregate row`, oneSaved.visible,
    sourceNemotron.map(source => source.id))
  const bothSaved = visibilitySettings([row.id, sourceNemotron[2].id])
  const bothView = directoryView(candidates, bothSaved)
  verifyCorrection(`restoring the Kilo Lightning row keeps the OpenCode Zen config ${index} record`,
    bothSaved.hiddenModelIds.filter(id => !new Set(hiddenIdsFor(sourceNemotron[2], bothView.visibility)).has(id)),
    [row.id])
}
const retiredAggregateId = 'opencode_zen/beam-free'
const retiredSettings = visibilitySettings([retiredAggregateId])
verifyCorrection('a retired aggregate id stays exact without directory qualification', [
  directoryView(sourceBeam, retiredSettings).visible,
  hiddenIdsFor(sourceBeam[0], directoryView(sourceBeam, retiredSettings).visibility),
], [sourceBeam.map(row => row.id), []])

const cohereEac = buildEacCatalog(['cohere/north-mini-code'])[0]
const cohereKilo = buildKiloCatalog([{ id: 'cohere/north-mini-code:free', isFree: true }])[0]
const sameIdAggregate = buildAggregateCatalog({ providers: { cohere: {
  enabled: true, apiKey: 'fixture-only', models: ['north-mini-code:free'],
} } }).find(row => row.id === cohereKilo.id)
assert.ok(sameIdAggregate, 'the Cohere aggregate row can share Kilo\'s full id')
const collisionCandidates = [cohereEac, cohereKilo, sameIdAggregate]
const collisionOne = directoryView(collisionCandidates, visibilitySettings([sameIdAggregate.id]))
verifyCorrection('a cross-category shared id stays exact and cannot hide the EAC sibling',
  collisionOne.visible, [cohereEac.id])
verifyCorrection('the EAC sibling receives no restore ids from the ambiguous shared id',
  hiddenIdsFor(cohereEac, collisionOne.visibility), [])
const collisionRuntime = visibilityRuntime({
  entries: ['other-free'], sealIds: [cohereEac.id], kiloRows: [cohereKilo],
  settings: {
    ...visibilitySettings([sameIdAggregate.id]),
    aggregate: { providers: { cohere: {
      enabled: true, apiKey: 'fixture-only', models: ['north-mini-code:free'],
    } } },
  },
})
const collisionRuntimeState = collisionRuntime.state()
verifyCorrection('the runtime preserves dedupe priority while dropping ambiguous family matching', [
  Object.values(collisionRuntimeState.membership).flat(),
  collisionRuntimeState.visibility.familyKeysById.has(sameIdAggregate.id),
  hiddenIdsFor(cohereEac, collisionRuntimeState.visibility),
], [['other-free', cohereEac.id], false, []])
collisionRuntime.dispose()
const bothCohereSaved = [sameIdAggregate.id, cohereEac.id]
const bothCohereView = directoryView(collisionCandidates, visibilitySettings(bothCohereSaved))
verifyCorrection('restoring EAC removes only EAC and keeps the shared aggregate/Kilo record', [
  hiddenIdsFor(cohereEac, bothCohereView.visibility),
  bothCohereSaved.filter(id => !new Set(hiddenIdsFor(cohereEac, bothCohereView.visibility)).has(id)),
], [[cohereEac.id], [sameIdAggregate.id]])
verifyCorrection('restoring the shared row removes only the shared id and keeps EAC',
  bothCohereSaved.filter(id => !new Set(hiddenIdsFor(cohereKilo, bothCohereView.visibility)).has(id)),
  [cohereEac.id])
const withoutAggregate = directoryView([cohereEac, cohereKilo], visibilitySettings([cohereKilo.id]))
verifyCorrection('after the aggregate lane leaves the directory the shared id regains family matching',
  withoutAggregate.visible, [])

const layeredAggregate = buildAggregateCatalog({ providers: { cohere: {
  enabled: true, apiKey: 'fixture-only', models: ['cohere/north-mini-code:free'],
} } }).find(row => row.id === 'cohere/cohere/north-mini-code:free')
assert.ok(layeredAggregate, 'a provider-prefixed Cohere name composes a distinct aggregate id')
const layeredCandidates = [cohereEac, cohereKilo, layeredAggregate]
const layeredOnly = directoryView(layeredCandidates, visibilitySettings([layeredAggregate.id]))
verifyCorrection('the two-layer Cohere aggregate id leaves both lane rows visible',
  layeredOnly.visible, [cohereEac.id, cohereKilo.id])
const layeredAndEac = [layeredAggregate.id, cohereEac.id]
const layeredView = directoryView(layeredCandidates, visibilitySettings(layeredAndEac))
verifyCorrection('restoring EAC keeps only the two-layer aggregate record',
  layeredAndEac.filter(id => !new Set(hiddenIdsFor(cohereEac, layeredView.visibility)).has(id)),
  [layeredAggregate.id])

const sharedFree = buildCatalog(['shared-model-free'])[0]
const sharedEac = buildEacCatalog(['shared-model-free'])[0]
const sharedCandidates = [sharedFree, sharedEac]
const sharedMap = catalogFamilyKeys(sharedCandidates)
verifyCorrection('two eligible lanes may share one full id and retain family matching',
  [sharedMap.get(sharedFree.id), mergeForView(sharedCandidates).map(row => row.id)],
  ['shared-model', [sharedFree.id]])

const vanishingKilo = sourceBeam[2]
const stillHereFree = sourceBeam[0]
const stillHereEac = sourceBeam[1]
const retainedDeparture = visibilitySettings([vanishingKilo.id])
verifyCorrection('the same-family departure fixture starts fully linked',
  directoryView(sourceBeam, retainedDeparture).visible, [])
const departedView = directoryView([stillHereFree, stillHereEac], retainedDeparture)
verifyCorrection('a departed Kilo record pauses family impact on the free and EAC siblings', [
  departedView.visible,
  hiddenIdsFor(stillHereFree, departedView.visibility),
], [[stillHereFree.id, stillHereEac.id], []])
const restoreWhileAway = visibilitySettings([vanishingKilo.id, stillHereFree.id])
const awayWithBothSaved = directoryView([stillHereFree, stillHereEac], restoreWhileAway)
const stillHereHidden = hiddenIdsFor(stillHereFree, awayWithBothSaved.visibility)
const afterPresentRestore = restoreWhileAway.hiddenModelIds.filter(id => !new Set(stillHereHidden).has(id))
verifyCorrection('restoring the present free sibling preserves the departed Kilo record', [
  awayWithBothSaved.visible,
  stillHereHidden,
  afterPresentRestore,
  directoryView([stillHereFree, stillHereEac], visibilitySettings(afterPresentRestore)).visible,
], [[], [stillHereFree.id], [vanishingKilo.id], [stillHereFree.id, stillHereEac.id]])
verifyCorrection('a returned Kilo row reacquires the retained saved record',
  directoryView(sourceBeam, retainedDeparture).visible, [])

for (const language of ['zh', 'en']) {
  cells.length = 0
  const translate = key => DICT[language][key]
  const writes = []
  const summary = { settings: { hiddenModelIds: ['free'], hideFreeModels: false, hideEacModels: false },
    catalog: [{ id: 'free', name: 'Free fixture', route: null, hiddenByUser: true, availability: 'available' }] }
  const roster = render(Roster, { summary, t: translate, onApply: patch => writes.push(patch), only: 'free' })
  const row = nodes(roster).find(node => node.type === ModelCard)
  assert.ok(row, 'route:null entries must retain a recovery control')
  const card = render(ModelCard, row.props)
  const control = nodes(card).find(node => node.props.label === translate('visibility.showModel'))
  assert.equal(control.props.checked, false)
  control.props.onChange()
  assert.deepEqual(writes.pop(), { hiddenModelIds: [] })
  nodes(roster).find(node => node.props.label === translate('pref.hideFreeModels')).props.onChange()
  assert.deepEqual(writes.pop(), { hideFreeModels: true })
  cells.length = 0
  const preferences = render(Preferences, { summary, t: translate, onApply: patch => writes.push(patch) })
  nodes(preferences).find(node => node.props.label === translate('pref.hideEacModels')).props.onChange()
  assert.deepEqual(writes.pop(), { hideEacModels: true })
}

cells.length = 0
const familyWrites = []
const foreignSaved = [...foreignHiddenIds, 'foreign-probe']
const familyRow = sourceBeam.map(row => row.id)
const familyUiSettings = { hiddenModelIds: [...familyRow, ...foreignSaved], hideFreeModels: false, hideEacModels: false }
const familyUiVisibility = directoryVisibility(sourceBeam, familyUiSettings)
const familySummary = {
  settings: familyUiSettings,
  catalog: [{ ...sourceBeam[0], name: 'Beam fixture', route: null, hiddenByUser: true,
    hiddenIds: hiddenIdsFor(sourceBeam[0], familyUiVisibility), availability: 'available' }],
}
const familyRoster = render(Roster, { summary: familySummary, t, onApply: patch => familyWrites.push(patch), only: 'free' })
const familyCard = render(ModelCard, nodes(familyRoster).find(node => node.type === ModelCard).props)
nodes(familyCard).find(node => node.props.label === t('visibility.showModel')).props.onChange()
verifyCorrection('the plugin restore action preserves aggregate, subscription, combo, and foreign ids',
  familyWrites.pop(), { hiddenModelIds: foreignSaved })
console.log('ok  visibility fallback isolation, validation, recovery controls and bilingual plugin actions')

const capacityModels = [
  { id: 'large', name: 'Large', contextWindow: 1000000, maxOutput: 64000, vision: true },
  { id: 'small', name: 'Small', contextWindow: 128000, maxOutput: 16000, vision: false },
]
cells.length = 0
const picker = render(ModelPicker, { t, models: capacityModels, chosen: [], onPick() {} })
assert.ok(nodes(picker).some(node => node.children.includes(`${t('tag.context')} 1.0M`)))
captureEffects = true
const editorProps = { t, models: capacityModels, chain: { name: 'Fixture', models: ['small', 'large'] } }
render(ChainEditor, editorProps)
for (const effect of effects.splice(0)) effect()
await new Promise(resolve => setImmediate(resolve))
let editor = render(ChainEditor, editorProps)
let capacity = nodes(editor).find(node => node.type === ChainCapacity).props.capacity
assert.equal(capacity.contextWindow, 128000)
assert.equal(capacity.maxOutput, 16000)
assert.equal(capacity.vision, false)
effects.length = 0
button(editor, t('routing.removeMember')).props.onClick()
render(ChainEditor, editorProps)
for (const effect of effects.splice(0)) effect()
await new Promise(resolve => setImmediate(resolve))
editor = render(ChainEditor, editorProps)
capacity = nodes(editor).find(node => node.type === ChainCapacity).props.capacity
assert.equal(capacity.contextWindow, 1000000, 'removing the small member refreshes the real intersection')
captureEffects = false
effects.length = 0
const savedCard = render(ChainCard, { t, chain: { id: 'combo:fixture', name: 'Fixture', models: ['large'] },
  resolved: ['large'], missing: [], lookup: new Map(capacityModels.map(row => [row.id, row])), capacity, onEdit() {} })
assert.equal(nodes(savedCard).find(node => node.type === ChainCapacity).props.capacity.contextWindow, 1000000)
assert.ok(nodes(ChainCapacity({ t, capacity })).some(node => node.children.includes(`${t('tag.context')} 1.0M`)))
console.log('ok  combo picker capacities, saved card and live server intersection refresh')

// Compile the actual standalone page in memory, without rebuilding web output.
const require = createRequire(import.meta.url)
let transformSync
try { ({ transformSync } = createRequire(new URL('../packages/standalone/package.json', import.meta.url))('esbuild')) } catch {}
if (transformSync) {
const modelsSource = fs.readFileSync(new URL('../packages/standalone/frontend/models.tsx', import.meta.url), 'utf8')
const modelsBody = modelsSource.slice(modelsSource.indexOf('const availabilityNames')).replace('export function Models', 'function Models')
cells.length = 0
const standaloneSummary = { settings: { enabled: true, hiddenModelIds: [], hideFreeModels: false, hideEacModels: false },
  catalog: [{ id: 'free', name: 'Free', channel: 'anonymous', routable: true }, { id: 'account', name: 'Account', channel: 'lobsterai', routable: true }] }
const savedPatches = []
const context = {
  ...react, h: react.createElement, Fragment: 'fragment', providers: [], filterModels, visibilityCopy,
  document: { documentElement: { lang: 'en' } },
  defaultRangeExtractor: () => [],
  useVirtualizer: ({ count }) => ({ getTotalSize: () => count * 112,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 112 })), measureElement() {} }),
  ...Object.fromEntries(['Badge', 'Button', 'Input', 'Boxes', 'Check', 'CircleAlert', 'CircleCheck', 'Copy', 'Eye', 'EyeOff',
    'LoaderCircle', 'Play', 'RefreshCw', 'Search', 'SlidersHorizontal', 'Square', 'X'].map(name => [name, name])),
}
vm.createContext(context)
vm.runInContext(transformSync(modelsBody + '\nglobalThis.Page = Models', { loader: 'tsx', jsxFactory: 'h', jsxFragment: 'Fragment' }).code, context)
const standaloneProps = { active: true, summary: standaloneSummary, host: {
  saveSettings: async patch => {
    savedPatches.push(JSON.parse(JSON.stringify(patch)))
    Object.assign(standaloneSummary.settings, patch)
    for (const model of standaloneSummary.catalog) {
      model.hiddenByUser = isModelHidden(model, standaloneSummary.settings)
      model.hiddenByGroup = isModelHidden(model, { ...standaloneSummary.settings, hiddenModelIds: [] })
    }
  },
  refresh: async () => {}, error: error => { throw error },
} }
let standaloneTree = render(context.Page, standaloneProps)
nodes(standaloneTree).find(node => node.props['aria-label'] === 'Hide model：free').props.onClick()
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(savedPatches.pop(), { hiddenModelIds: ['free'] })
standaloneTree = render(context.Page, standaloneProps)
const group = nodes(standaloneTree).find(node => node.type === 'input' && node.props.role === 'switch')
group.props.onChange({ target: { checked: true } })
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(savedPatches.pop(), { hideFreeModels: true })
standaloneTree = render(context.Page, standaloneProps)
assert.equal(nodes(standaloneTree).find(node => node.props['aria-label'] === 'Show model：free').props.disabled, true)
assert.equal(nodes(standaloneTree).some(node => /(?:Hide|Show) model：account/.test(node.props['aria-label'] ?? '')), false)
nodes(standaloneTree).find(node => node.type === 'input' && node.props.role === 'switch').props.onChange({ target: { checked: false } })
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(Array.from(standaloneSummary.settings.hiddenModelIds), ['free'], 'group restore preserves individual choices')
standaloneTree = render(context.Page, standaloneProps)
nodes(standaloneTree).find(node => node.props['aria-label'] === 'Show model：free').props.onClick()
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(savedPatches.pop(), { hiddenModelIds: [] })
const standaloneFamily = ['beam-free', 'opencode/beam-free', 'reflection/beam-free']
standaloneSummary.settings.hiddenModelIds = [...standaloneFamily, ...foreignSaved]
const standaloneFamilyVisibility = directoryVisibility(sourceBeam, standaloneSummary.settings)
standaloneSummary.catalog.unshift({ id: 'beam-free', name: 'Beam', channel: 'anonymous', routable: true,
  hiddenByUser: true, hiddenByGroup: false,
  hiddenIds: hiddenIdsFor({ id: 'beam-free' }, standaloneFamilyVisibility) })
cells.length = 0
standaloneTree = render(context.Page, standaloneProps)
nodes(standaloneTree).find(node => node.props['aria-label'] === 'Show model：beam-free').props.onClick()
await new Promise(resolve => setImmediate(resolve))
verifyCorrection('the standalone source restore preserves foreign saved ids', savedPatches.pop(),
  { hiddenModelIds: foreignSaved })
console.log('ok  standalone actual model-row and group controls save preferences and isolate account channels')
} else {
  console.log('ok  standalone TSX visibility controls skipped: esbuild is not installed')
}

// Execute the JavaScript the standalone service actually serves, rather than
// trusting a fresh in-memory build of models.tsx.
const standaloneWeb = new URL('../packages/standalone/web/', import.meta.url)
const servedAssets = JSON.parse(fs.readFileSync(new URL('assets.json', standaloneWeb), 'utf8'))
const modelAsset = servedAssets.find(name => /^models-.*\.js$/.test(name))
assert.ok(modelAsset, 'assets.json names a models chunk')
verifyCorrection('the served models asset was rebuilt from the current source',
  modelAsset !== 'models-DKeafDX5.js', true)
const modelSource = fs.readFileSync(new URL(modelAsset, standaloneWeb), 'utf8')
const hiddenMarker = modelSource.indexOf('.settings.hiddenModelIds??[]')
const clickStart = modelSource.lastIndexOf('onClick:', hiddenMarker)
const clickEnd = modelSource.indexOf(',children:', hiddenMarker)
assert.ok(hiddenMarker > 0 && clickStart > 0 && clickEnd > clickStart, 'the served model visibility handler is present')
const shippedHandler = modelSource.slice(clickStart + 'onClick:'.length, clickEnd)
const summaryName = shippedHandler.match(/([A-Za-z_$][\w$]*)\.settings\.hiddenModelIds/)?.[1]
const saveName = shippedHandler.match(/([A-Za-z_$][\w$]*)\(\{hiddenModelIds:/)?.[1]
const modelName = shippedHandler.match(/([A-Za-z_$][\w$]*)\.hiddenByUser/)?.[1]
  ?? shippedHandler.match(/([A-Za-z_$][\w$]*)\.id\)/)?.[1]
assert.ok(summaryName && saveName && modelName, 'the served visibility handler can be invoked directly')
const servedHidden = ['beam-free', 'reflection/beam-free', ...foreignSaved]
const servedSettings = { hiddenModelIds: servedHidden }
const servedVisibility = directoryVisibility(sourceBeam, servedSettings)
const servedKilo = { id: 'reflection/beam-free', hiddenByUser: true,
  hiddenIds: hiddenIdsFor({ id: 'reflection/beam-free', channel: 'kilo' }, servedVisibility) }
const invokeServedVisibility = (settings, model) => {
  let write
  new Function(summaryName, saveName, modelName, `return (${shippedHandler})`)(
    { settings }, patch => { write = patch }, model)()
  return write
}
verifyCorrection('the served standalone asset restores the family from a saved Kilo row',
  invokeServedVisibility(servedSettings, servedKilo), { hiddenModelIds: foreignSaved })
for (const family of providerPrefixFamilies) {
  for (const [saved, clicked] of [family, [family[1], family[0]]]) {
    const settings = { hiddenModelIds: [saved.id], aggregate: aggregateOff }
    const hiddenIds = hiddenIdsFor(clicked, directoryVisibility(family, settings))
    verifyCorrection(`served restore finds ${saved.id} from ${clicked.id}`, hiddenIds, [saved.id])
    verifyCorrection(`served restore clears the shared-prefix family from ${clicked.id}`,
      invokeServedVisibility(settings, { ...clicked, hiddenByUser: true, hiddenIds }),
      { hiddenModelIds: [] })
  }
}

assert.deepEqual(correctionFailures, [], `review correction checks failed: ${correctionFailures.join(', ')}`)
