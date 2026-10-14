import fs from 'node:fs/promises'
import path from 'node:path'
import { foldForwardOutcome } from '../core/completion.js'
import { recordTurn, recordUsage } from '../store.js'
import { buildComboCatalog, comboChain, normalizeCombos } from '../combos.js'
import { classifyFailure, shouldAdvance } from '../route/classify.js'
import { ROUTE_MAIN } from '../adapter.js'
import { startExtensionWorker, extensionError, safeExtensionMessage, validateExtensionDescriptor } from './worker-bridge.js'
import { EXTENSION_ID, inspectExtensionDirectory, installExtensionDirectory, removeOwnedExtensionDirectory, relativeExtensionPath, assertSafeDirectoryPath } from './installation.js'

export { EXTENSION_ID }
export const ACCOUNT_PROVIDERS = Object.freeze(['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini'])
const MODEL_FIELDS = ['id', 'object', 'created', 'owned_by', 'name', 'description', 'context_window', 'contextWindow', 'max_tokens', 'maxOutput', 'vision', 'reasoning_efforts', 'input', 'output', 'channel', 'pricing']
function modelRows(value) {
  if (!Array.isArray(value) || value.length > 5000) throw extensionError('扩展返回的模型清单格式不正确', 'EXTENSION_INVALID_RESPONSE', 502)
  const seen = new Set()
  const strings = ['id', 'object', 'owned_by', 'name', 'description', 'channel']
  const numbers = ['created', 'context_window', 'contextWindow', 'max_tokens', 'maxOutput']
  const lists = ['reasoning_efforts', 'input', 'output', 'supported_reasoning_efforts']
  return value.map(row => {
    if (!row || typeof row.id !== 'string' || row.id.length > 300 || !ACCOUNT_PROVIDERS.some(provider => row.id.startsWith(provider + '/')) || seen.has(row.id)) throw extensionError('扩展模型标识不正确或重复', 'EXTENSION_INVALID_RESPONSE', 502)
    seen.add(row.id)
    const output = {}
    for (const key of strings) if (typeof row[key] === 'string') output[key] = row[key].slice(0, key === 'description' ? 3000 : 500)
    for (const key of numbers) if (Number.isFinite(row[key]) && row[key] >= 0) output[key] = row[key]
    for (const key of lists) if (Array.isArray(row[key]) && row[key].every(item => typeof item === 'string' && item.length <= 100)) output[key] = row[key].slice(0, 30)
    for (const key of ['vision', 'reasoning', 'canDisableThinking']) if (typeof row[key] === 'boolean') output[key] = row[key]
    if (row.pricing && typeof row.pricing === 'object') output.pricing = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].filter(key => Number.isFinite(row.pricing[key]) && row.pricing[key] >= 0).map(key => [key, row.pricing[key]]))
    return { ...output, id: row.id, object: 'model', source: 'extension:' + EXTENSION_ID, channel: output.channel ?? output.owned_by ?? row.id.split('/')[0] }
  })
}
function eventHub() {
  const listeners = new Set()
  return { emit(value) { for (const listener of [...listeners]) { try { listener(value) } catch { /* isolated consumers */ } } }, subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('listener must be a function'); listeners.add(listener); return () => listeners.delete(listener) }, clear() { listeners.clear() } }
}
function missingStatus(state = 'not-installed', error = '') { return { state, error, installed: false, enabled: false, version: null, protocolVersion: 1, providerCount: 0, modelCount: 0, managementTarget: null } }
function descriptorStatus(descriptor, rows, installed = true) {
  return { state: descriptor.state === 'disabled' ? 'disabled' : descriptor.state === 'conflict' ? 'conflict' : descriptor.state === 'failed' ? 'failed' : 'ready', installed, enabled: descriptor.state !== 'disabled', version: String(descriptor.version ?? ''), protocolVersion: 1, providerCount: Number.isInteger(descriptor.providerCount) ? descriptor.providerCount : ACCOUNT_PROVIDERS.length, modelCount: rows.length, managementTarget: descriptor.managementTarget === '/ofm-account-connectors' ? descriptor.managementTarget : '/extensions/account-connectors', error: safeExtensionMessage(descriptor.error ?? '').replace(/^扩展操作失败$/, '') }
}
const validateDescriptor = validateExtensionDescriptor
function rejectUnavailable(status) { return extensionError(status.error || (status.state === 'not-installed' ? '该模型需要独立安装账号连接扩展' : '账号连接扩展当前未启用或不可用'), status.state === 'incompatible' ? 'EXTENSION_INCOMPATIBLE' : 'EXTENSION_UNAVAILABLE') }
async function consumeStream(request, onChunk, streamFactory, { stats, active = () => true } = {}) {
  const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
  const started = Date.now(); let first = 0, ok = false
  try {
    const stream = await streamFactory()
    for await (const chunk of stream) {
      if (!active()) throw extensionError('账号连接扩展已停止', 'EXTENSION_DISABLED')
      if (request.signal?.aborted) throw request.signal.reason ?? extensionError('请求已取消', 'ABORTED', 499)
      if (!first) first = Date.now()
      foldForwardOutcome(outcome, chunk); onChunk?.(chunk)
    }
    if (!active()) throw extensionError('账号连接扩展已停止', 'EXTENSION_DISABLED')
    if (request.signal?.aborted) throw request.signal.reason ?? extensionError('请求已取消', 'ABORTED', 499)
    ok = outcome.error === undefined
    return outcome
  } finally {
    if (stats && active()) {
      const usage = outcome.usage
      recordUsage(stats, { model: request.model, at: Date.now(), input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0, reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0, cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? 0, ok, origin: 'forward', ttftMs: first ? first - started : undefined, decodeMs: first ? Date.now() - first : 0, decodeTokens: usage?.completion_tokens ?? 0, noUsage: usage === undefined, elapsedMs: Date.now() - started, aborted: request.signal?.aborted === true })
      recordTurn(stats, { model: request.model, ok, recovered: false })
    }
  }
}

/** DSH cooperation is optional. Disposing OFM never owns the other plugin's lifetime. */
export function createOptionalAccountBridge({ getService, logger = console, stats }) {
  const hub = eventHub(), controllers = new Set()
  let service, unsubscribe, descriptor, rows = [], status = missingStatus(), disposed = false, generation = 0, refreshSlot
  function invalidate() { generation++; refreshSlot = undefined; rows = []; for (const controller of controllers) controller.abort(extensionError('账号扩展连接已断开', 'EXTENSION_DISABLED')); controllers.clear() }
  function detach() { invalidate(); unsubscribe?.(); unsubscribe = undefined; service = undefined; descriptor = undefined }
  const deadline = promise => {
    let timer
    return Promise.race([Promise.resolve(promise), new Promise((_, reject) => { timer = setTimeout(() => reject(extensionError('扩展状态响应超时', 'EXTENSION_RESPONSE_TIMEOUT')), 10000); timer.unref?.() })]).finally(() => clearTimeout(timer))
  }
  async function refresh() {
    if (disposed) return []
    let next
    try { next = getService?.() } catch (error) { detach(); status = missingStatus('failed', safeExtensionMessage(error.message)); hub.emit(status); return [] }
    if (!next) { if (service) detach(); status = missingStatus(); hub.emit(status); return [] }
    if (next !== service) {
      detach(); service = next
      if (typeof next.subscribe === 'function') unsubscribe = next.subscribe(() => { void refresh().catch(error => logger.warn?.(safeExtensionMessage(error.message))) })
    }
    if (refreshSlot?.service === service && refreshSlot.generation === generation) return refreshSlot.promise
    const selected = service, slot = { service: selected, generation }
    slot.promise = (async () => {
      let fence = slot.generation
      try {
        const info = validateDescriptor(await deadline(selected.describe()))
        if (disposed || fence !== generation || service !== selected) return []
        if (descriptor && (descriptor.instanceId !== info.instanceId || descriptor.state === 'ready' && info.state !== 'ready')) { invalidate(); fence = generation }
        descriptor = info
        if (info.state !== 'ready' || !info.capabilities.includes('ofmApi')) {
          rows = []; status = descriptorStatus(info, rows)
          if (info.state === 'starting' || info.state === 'stopping') status = { ...status, state: info.state, enabled: false }
          if (!info.capabilities.includes('ofmApi') && info.state === 'ready') status = { ...status, state: 'incompatible', enabled: false, error: '此扩展尚未提供 OFM API 协作能力' }
        } else {
          const listing = modelRows(await deadline(selected.listModels()))
          if (disposed || fence !== generation || service !== selected) return []
          rows = listing; status = descriptorStatus(info, rows)
        }
      } catch (error) {
        if (disposed || fence !== generation || service !== selected) return []
        invalidate(); status = { ...missingStatus(error.code === 'EXTENSION_INCOMPATIBLE' ? 'incompatible' : 'failed', safeExtensionMessage(error.message)), installed: true }
      }
      hub.emit(status); return rows
    })().finally(() => { if (refreshSlot === slot) refreshSlot = undefined })
    refreshSlot = slot
    return slot.promise
  }
  const bridge = {
    state: () => ({ ...status }), publicModelRows: () => rows, handles: model => typeof model === 'string' && ACCOUNT_PROVIDERS.some(provider => model.startsWith(provider + '/')),
    refresh, subscribe: hub.subscribe,
    async complete(request, onChunk) {
      await refresh()
      if (status.state !== 'ready' || !rows.some(row => row.id === request.model) || typeof service?.stream !== 'function') throw rejectUnavailable(status)
      const selected = service, fence = generation, controller = new AbortController()
      controllers.add(controller)
      const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
      try { return await consumeStream({ ...request, signal }, onChunk, () => selected.stream({ ...request, signal: undefined }, { signal }), { stats, active: () => !disposed && generation === fence && service === selected && status.state === 'ready' }) }
      finally { controllers.delete(controller) }
    },
    dispose() { if (disposed) return; disposed = true; detach(); status = missingStatus('disabled'); hub.emit(status); hub.clear() },
    close() { this.dispose(); return Promise.resolve() },
  }
  return bridge
}

/** Stable core behavior plus only an explicitly available account extension. */
export function combineCoreWithAccountConnectors(core, bridge) {
  const extraCatalog = () => bridge.publicModelRows().map(row => ({ ...row, contextWindow: row.contextWindow ?? row.context_window, maxOutput: row.maxOutput ?? row.max_tokens }))
  function composition() {
    const base = core.state(), extras = extraCatalog(), original = core.publicModelRows()
    const coreIds = new Set(base.catalog.map(row => row.id)), publicIds = new Set(original.map(row => row.id))
    const additional = extras.filter(row => !coreIds.has(row.id))
    const allModels = [...base.catalog.filter(row => row.channel !== 'combo'), ...additional]
    const combinedChains = buildComboCatalog(normalizeCombos(base.settings?.combos ?? []), allModels)
    const extensionIds = new Set(extras.map(row => row.id))
    const cooperativeChains = combinedChains.filter(row => row.combo.some(id => extensionIds.has(id)))
    const cooperativeIds = new Set(cooperativeChains.map(row => row.id))
    const catalog = [...base.catalog.filter(row => !cooperativeIds.has(row.id)), ...additional, ...cooperativeChains]
    const membership = Object.fromEntries(Object.entries(base.membership ?? {}).map(([key, ids]) => [key, [...ids]]))
    membership[ROUTE_MAIN] = [...new Set([...(membership[ROUTE_MAIN] ?? []), ...additional.map(row => row.id), ...cooperativeChains.map(row => row.id)])]
    const rows = [...original.filter(row => !cooperativeIds.has(row.id)), ...bridge.publicModelRows().filter(row => !publicIds.has(row.id)), ...cooperativeChains.map(row => ({ id: row.id, object: 'model', owned_by: 'our-free-model', context_window: row.contextWindow, source: 'core-route' }))]
    return { base, catalog, rows, cooperativeChains, membership }
  }
  const commits = chunk => chunk?.type === 'text-delta' ? typeof chunk.text === 'string' && chunk.text.trim() !== '' : chunk?.type === 'tool-call-delta' || chunk?.type === 'block-end' && chunk.block?.type !== 'reasoning' && (chunk.block?.type !== 'text' || typeof chunk.block.text === 'string' && chunk.block.text.trim() !== '')
  async function direct(request, onChunk) {
    const coreOwned = core.publicModelRows().some(row => row.id === request.model)
    const extensionOwned = bridge.publicModelRows().some(row => row.id === request.model)
    if (coreOwned && extensionOwned) throw extensionError('核心与账号扩展存在同名模型，请先处理来源冲突', 'EXTENSION_MODEL_CONFLICT', 409)
    if (coreOwned) return core.complete(request, onChunk)
    if (extensionOwned || bridge.handles(request.model)) return bridge.complete(request, onChunk)
    return core.complete(request, onChunk)
  }
  return {
    ...core,
    get egress() { return core.egress }, get gatewayLatency() { return core.gatewayLatency },
    get catalog() { return composition().catalog },
    state() { const view = composition(); return { ...view.base, catalog: view.catalog, membership: view.membership } },
    publicModelRows: () => composition().rows,
    async complete(request, onChunk) {
      const view = composition(), chain = view.cooperativeChains.find(row => row.id === request.model)
      if (view.base.settings?.enabled === false) throw extensionError('OFM 推理已暂停', 'CONFIG_DISABLED')
      if (!chain) return direct(request, onChunk)
      if (view.base.settings?.enabled === false) throw extensionError('OFM 推理已暂停', 'CONFIG_DISABLED')
      const candidates = comboChain(chain, view.catalog)
      let lastError
      for (const candidate of candidates) {
        if (request.signal?.aborted) throw request.signal.reason ?? extensionError('请求已取消', 'ABORTED', 499)
        const held = []; let committed = false, failure
        try {
          const result = await direct({ ...request, model: candidate.id, openAi: request.openAi ? { ...request.openAi, model: candidate.id } : undefined }, chunk => {
            if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) failure = chunk.reason.failure ?? { code: chunk.reason.kind }
            if (committed) { onChunk?.(chunk); return }
            held.push(chunk)
            if (commits(chunk)) { committed = true; for (const item of held) onChunk?.(item); held.length = 0 }
          })
          if (committed || !result.error) { for (const item of held) onChunk?.(item); return result }
          lastError = extensionError(result.error, failure?.code ?? 'EXTENSION_REQUEST_FAILED', failure?.status ?? 502)
          if (request.signal?.aborted || ['ABORTED', 'EXTENSION_DISABLED'].includes(lastError.code) || !shouldAdvance(classifyFailure({ status: lastError.statusCode, code: lastError.code, message: lastError.message }))) { for (const item of held) onChunk?.(item); return result }
        } catch (error) {
          if (committed || request.signal?.aborted || ['ABORTED', 'EXTENSION_DISABLED'].includes(error.code) || !shouldAdvance(classifyFailure({ status: error.statusCode, code: error.code, message: error.message }))) throw error
          lastError = error
        }
      }
      throw lastError ?? extensionError('该路由链当前没有可用模型', 'ROUTE_EXHAUSTED')
    },
    async refreshCatalog(options) { const value = await core.refreshCatalog(options); await bridge.refresh().catch(() => {}); return value },
  }
}

/** Local extension host for standalone and the desktop wrapper. No package is auto-loaded. */
export async function createAccountConnectorsHost({ dataDir, logger = console, stats, extensionDir, workerFactory, startupTimeoutMs }) {
  await assertSafeDirectoryPath(dataDir, { allowMissing: true })
  const installationsRoot = path.resolve(extensionDir ?? path.join(dataDir, 'extensions'))
  await assertSafeDirectoryPath(installationsRoot, { allowMissing: true })
  const installPath = path.join(installationsRoot, EXTENSION_ID)
  const settingsPath = path.join(dataDir, 'account-connectors-settings.json')
  const ownData = path.join(dataDir, 'extensions-data', EXTENSION_ID)
  const hub = eventHub()
  let manifest, status = missingStatus(), driver, rows = [], enabled = false, disposed = false, disposal, generation = 0, refreshing, transition = Promise.resolve(), recovery = Promise.resolve(), unsubscribeRefresh
  function enqueue(operation) { const next = transition.then(operation, operation); transition = next.catch(() => {}); return next }
  async function save() { await fs.mkdir(dataDir, { recursive: true, mode: 0o700 }); const temporary = settingsPath + '.tmp'; await fs.writeFile(temporary, JSON.stringify({ version: 1, enabled }) + '\n', { mode: 0o600 }); await fs.rename(temporary, settingsPath) }
  function publish() { hub.emit({ ...status }) }
  async function stopOwnedWorker(selected) {
    if (!selected) return undefined
    const result = await selected.close()
    // The parent only removes the lock for the worker whose termination it observed.
    // No stale PID guessing, old profile scan or takeover of another instance.
    try {
      await assertSafeDirectoryPath(ownData)
      const lockFile = path.join(ownData, 'instance.lock')
      const info = await fs.lstat(lockFile)
      if (info.isSymbolicLink() || !info.isFile() || info.size > 4096) return result
      const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'))
      if (lock.id === EXTENSION_ID && lock.instanceId === selected.descriptor.instanceId && lock.pid === process.pid) await fs.unlink(lockFile)
    } catch (error) { if (error.code !== 'ENOENT') logger.warn?.('扩展已终止；本实例锁的清理未确认，重新启用时会明确检查冲突') }
    return result
  }
  async function inspect() {
    try { const found = await inspectExtensionDirectory(installPath); manifest = found.manifest; status = { ...missingStatus('disabled'), installed: true, version: manifest.version, providerCount: manifest.providers?.length ?? ACCOUNT_PROVIDERS.length, managementTarget: '/extensions/account-connectors' }; return found }
    catch (error) { if (error.code === 'ENOENT') { manifest = undefined; status = missingStatus(); return null } status = { ...missingStatus(error.code === 'EXTENSION_INCOMPATIBLE' ? 'incompatible' : 'failed', safeExtensionMessage(error.message)), installed: true }; return null }
  }
  async function refresh() {
    if (!driver || !enabled || disposed) return []
    if (refreshing) return refreshing
    const selected = driver, fence = generation
    refreshing = selected.call('models').then(value => { if (disposed || selected !== driver || fence !== generation || !enabled) return []; rows = modelRows(value); status = { ...status, modelCount: rows.length }; publish(); return rows }).finally(() => { refreshing = undefined })
    return refreshing
  }
  async function disableInner({ persist = true } = {}) {
    enabled = false; generation++; refreshing = undefined; rows = []; clearTimeout(unsubscribeRefresh)
    const selected = driver; driver = undefined
    status = { ...status, enabled: false, state: selected ? 'stopping' : manifest ? 'disabled' : 'not-installed', modelCount: 0 }; publish()
    await recovery
    const closeResult = await stopOwnedWorker(selected)
    status = { ...status, state: manifest ? 'disabled' : 'not-installed', error: closeResult?.acknowledged === false ? '扩展进程已终止，部分退出操作未确认；可查看扩展日志' : '' }; publish()
    if (persist) await save()
    return { ...status }
  }
  async function enableInner() {
    if (disposed) throw extensionError('OFM 已停止', 'EXTENSION_DISABLED')
    await recovery
    if (driver && enabled && !driver.closed && status.state === 'ready') return { ...status }
    if (driver) await disableInner({ persist: false })
    const found = await inspect()
    if (!found) throw rejectUnavailable(status)
    await fs.mkdir(ownData, { recursive: true, mode: 0o700 })
    generation++; const fence = generation
    status = { ...status, state: 'starting', enabled: false, error: '' }; publish()
    try {
      const current = await startExtensionWorker({ entry: path.join(installPath, manifest.runtime.entry), dataDir: ownData, extensionRoot: installPath, logger, workerFactory, startupTimeoutMs, onChanged(update) {
        if (disposed || fence !== generation) return
        if (update?.state === 'failed') { const failedDriver = driver; driver = undefined; enabled = false; generation++; refreshing = undefined; status = { ...status, state: 'failed', error: update.error, enabled: false, modelCount: 0 }; rows = []; publish(); recovery = stopOwnedWorker(failedDriver).catch(() => {}); return }
        clearTimeout(unsubscribeRefresh); unsubscribeRefresh = setTimeout(() => { void refresh().catch(error => { status = { ...status, error: safeExtensionMessage(error.message) }; publish() }) }, 100); unsubscribeRefresh.unref?.()
      } })
      if (disposed || fence !== generation) { await current.close(); throw extensionError('扩展启动已取消', 'EXTENSION_DISABLED') }
      driver = current; enabled = true
      status = { ...descriptorStatus(current.descriptor, rows), enabled: true, managementTarget: '/extensions/account-connectors' }
      await save(); await refresh(); publish()
      return { ...status }
    } catch (error) { await disableInner({ persist: false }); status = { ...status, installed: true, state: error.code === 'EXTENSION_INCOMPATIBLE' ? 'incompatible' : 'failed', error: safeExtensionMessage(error.message) }; publish(); throw error }
  }
  const host = {
    state: () => ({ ...status }), publicModelRows: () => rows, handles: model => typeof model === 'string' && ACCOUNT_PROVIDERS.some(provider => model.startsWith(provider + '/')),
    subscribe: hub.subscribe, refresh,
    enable: () => enqueue(enableInner), disable: () => enqueue(() => disableInner()),
    async complete(request, onChunk) {
      if (!driver || !enabled || status.state !== 'ready') throw rejectUnavailable(status)
      if (!rows.some(row => row.id === request.model)) throw extensionError('扩展当前没有该模型，请刷新账号模型清单', 'EXTENSION_MODEL_NOT_FOUND', 404)
      const selected = driver, fence = generation, outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
      const started = Date.now(); let first = 0, ok = false
      try {
        const { signal, ...wire } = request
        await selected.call('complete', { request: wire }, signal, chunk => { if (fence !== generation || selected !== driver) return; if (!first) first = Date.now(); foldForwardOutcome(outcome, chunk); onChunk?.(chunk) }, 30 * 60000)
        if (fence !== generation || selected !== driver) throw extensionError('账号连接扩展已停用', 'EXTENSION_DISABLED')
        ok = outcome.error === undefined; return outcome
      } finally {
        if (stats && !disposed) { const usage = outcome.usage; recordUsage(stats, { model: request.model, at: Date.now(), input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0, reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0, cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? 0, ok, origin: 'forward', ttftMs: first ? first - started : undefined, decodeMs: first ? Date.now() - first : 0, decodeTokens: usage?.completion_tokens ?? 0, noUsage: usage === undefined, elapsedMs: Date.now() - started, aborted: request.signal?.aborted === true }); recordTurn(stats, { model: request.model, ok, recovered: false }) }
      }
    },
    async rpc(body, signal) {
      if (!driver || !enabled || status.state !== 'ready') throw rejectUnavailable(status)
      if (typeof body?.method !== 'string' || !Object.hasOwn(body, 'payload')) throw extensionError('扩展管理请求缺少 method 或 payload', 'EXTENSION_INVALID_REQUEST', 400)
      if (body.method === 'backup.export') throw extensionError('备份包含账号凭据，请使用扩展自己的本机导出功能', 'EXTENSION_PRIVATE_OPERATION', 403)
      return driver.call('rpc', { call: { method: body.method, payload: body.payload } }, signal, undefined, 10 * 60000)
    },
    installFromDirectory(source, { trustDevelopment = false } = {}) { return enqueue(async () => { if (disposed) throw extensionError('OFM 已停止', 'EXTENSION_DISABLED'); const result = await installExtensionDirectory({ source, installationsRoot, trustDevelopment, beforeSwitch: () => disableInner() }); manifest = result.manifest; enabled = false; await save(); await inspect(); if (result.cleanupWarning) status = { ...status, warning: result.cleanupWarning }; publish(); return { ...status } }) },
    uninstall({ deleteData = false } = {}) { return enqueue(async () => { if (deleteData) throw extensionError('删除账号数据需要独立的数据管理操作；卸载默认保留数据', 'EXTENSION_DELETE_CONFIRMATION_REQUIRED', 400); await disableInner(); await removeOwnedExtensionDirectory(installationsRoot, installPath); manifest = undefined; status = missingStatus(); await save(); publish(); return { ...status, dataRetained: true } }) },
    async readUiAsset(relative = 'index.html') {
      if (!manifest) throw rejectUnavailable(status)
      const candidate = relative === 'index.html' ? manifest.ui.entry : relativeExtensionPath(relative)
      const allowed = new Set([manifest.ui.entry, ...(manifest.ui.assets ?? [])])
      if (!allowed.has(candidate)) throw extensionError('扩展界面资源不存在', 'EXTENSION_ASSET_NOT_FOUND', 404)
      const found = await inspectExtensionDirectory(installPath)
      const bytes = found.files.get(candidate)
      if (!bytes) throw extensionError('扩展界面资源不存在', 'EXTENSION_ASSET_NOT_FOUND', 404)
      return { bytes, path: candidate }
    },
    dispose() { if (disposal) return disposal; disposed = true; disposal = enqueue(() => disableInner({ persist: false })).then(() => { hub.clear() }); return disposal },
    close() { return this.dispose() },
  }
  await inspect()
  try { const stored = JSON.parse(await fs.readFile(settingsPath, 'utf8')); enabled = stored?.version === 1 && stored.enabled === true } catch { enabled = false }
  // Only a previous explicit enable is resumed. A newly copied package is always disabled.
  if (enabled && manifest) await enableInner().catch(error => logger.warn?.(safeExtensionMessage(error.message)))
  else enabled = false
  return host
}
