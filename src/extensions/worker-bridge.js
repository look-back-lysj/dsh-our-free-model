import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'

export function extensionError(message, code = 'EXTENSION_UNAVAILABLE', statusCode = 503) {
  return Object.assign(new Error(message), { code, statusCode })
}
export function safeExtensionMessage(value) {
  return String(value ?? '扩展操作失败')
    .replace(/\b(?:sk|nvapi)-[A-Za-z0-9_-]{8,}/g, '[已脱敏]')
    .replace(/(["']?(?:access_token|refresh_token|api_key|apiKey|password|client_secret|signingSecret)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1"[已脱敏]"')
    .replace(/\bBearer\s+[^\s,"'}]+/gi, 'Bearer [已脱敏]').slice(0, 700)
}
export function validateExtensionDescriptor(value) {
  const states = ['ready', 'disabled', 'failed', 'conflict', 'starting', 'stopping']
  const capabilities = ['hostModels', 'ofmApi', 'managementUi']
  if (value?.id !== 'ofm.account-connectors' || value.protocolVersion !== 1 || typeof value.instanceId !== 'string' || value.instanceId.length < 1 || value.instanceId.length > 128 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version ?? '') || !states.includes(value.state) || !Array.isArray(value.capabilities) || value.capabilities.some(item => !capabilities.includes(item))) throw extensionError('账号连接扩展版本或协作协议不兼容', 'EXTENSION_INCOMPATIBLE', 409)
  return value
}
export function extensionEnvironment(dataDir) {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TZ', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'OFM_CONNECTORS_GOOGLE_CLIENT_ID', 'OFM_CONNECTORS_GOOGLE_CLIENT_SECRET', 'CMDC_PAK_GOOGLE_CLIENT_ID', 'CMDC_PAK_GOOGLE_CLIENT_SECRET']
  const env = Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  return { ...env, OFM_ACCOUNT_CONNECTORS_HOME: dataDir, OFM_CODEARTS_CACHE_DIR: dataDir + '/codearts-cache' }
}

/** Transport only: account code belongs to the independently installed worker. */
export async function startExtensionWorker({ entry, dataDir, extensionRoot, logger = console, onChanged = () => {}, workerFactory = (file, options) => new Worker(file, options), startupTimeoutMs = 15000 }) {
  const instanceId = randomUUID()
  const worker = workerFactory(entry, {
    workerData: { dataDir, extensionRoot, instanceId, protocolVersion: 1 },
    execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type') && !arg.startsWith('--inspect')),
    env: extensionEnvironment(dataDir),
  })
  const pending = new Map()
  let closed = false, exited = false, terminalError, closing, closeResolve, sequence = 0, descriptor, startupResolve, startupReject
  const ready = new Promise((resolve, reject) => { startupResolve = resolve; startupReject = reject })
  const rejectAll = error => { startupReject(error); for (const task of [...pending.values()]) task.reject(error) }
  const fail = error => {
    const safe = extensionError(safeExtensionMessage(error?.message), error?.code ?? 'EXTENSION_FAILED')
    const firstFailure = !closed
    terminalError = safe; closed = true
    rejectAll(safe)
    if (firstFailure) onChanged({ state: 'failed', error: safe.message })
  }
  worker.on('error', fail)
  worker.on('exit', code => { exited = true; closeResolve?.(); if (!closed) fail(extensionError('扩展运行进程已退出（' + code + '）', 'EXTENSION_EXITED')) })
  worker.on('message', message => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'closed') { closeResolve?.(); return }
    if (closed) return
    if (message.type === 'ready') {
      let candidate
      try { candidate = validateExtensionDescriptor(message.descriptor); if (candidate.state !== 'ready') throw extensionError('扩展没有进入可用状态', candidate.state === 'conflict' ? 'EXTENSION_CONFLICT' : 'EXTENSION_START_FAILED') }
      catch (error) { fail(error); return }
      descriptor = { ...candidate, instanceId }
      startupResolve(descriptor); return
    }
    if (message.type === 'log') { logger[message.level === 'error' ? 'error' : message.level === 'warn' ? 'warn' : 'info']?.(safeExtensionMessage(message.message)); return }
    if (message.type === 'changed') { onChanged(); return }
    const task = pending.get(message.id)
    if (!task) return
    if (message.type === 'chunk') {
      try { task.onChunk?.(message.chunk) } catch (error) { task.reject(error); worker.postMessage({ type: 'cancel', id: message.id }) }
    } else if (message.type === 'error') task.reject(extensionError(safeExtensionMessage(message.message), message.code ?? 'EXTENSION_REQUEST_FAILED', Number.isInteger(message.statusCode) ? message.statusCode : 502))
    else if (message.type === 'result') task.resolve(message.value)
  })
  function call(type, payload = {}, signal, onChunk, timeoutMs = 120000) {
    if (closed) return Promise.reject(terminalError ?? extensionError('账号连接扩展已停止', 'EXTENSION_DISABLED'))
    if (signal?.aborted) return Promise.reject(signal.reason ?? extensionError('请求已取消', 'ABORTED', 499))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      let timer
      const finish = fn => value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id); fn(value) }
      const task = { resolve: finish(resolve), reject: finish(reject), onChunk }
      const abort = () => { if (!pending.has(id)) return; worker.postMessage({ type: 'cancel', id }); task.reject(signal?.reason ?? extensionError('扩展请求超时或已取消', 'ABORTED', 499)) }
      timer = setTimeout(abort, timeoutMs); timer.unref?.()
      pending.set(id, task); signal?.addEventListener('abort', abort, { once: true })
      try { worker.postMessage({ type, id, ...payload }) } catch (error) { task.reject(error) }
    })
  }
  async function close() {
    if (closing) return closing
    closed = true
    rejectAll(extensionError('账号连接扩展正在停止', 'EXTENSION_DISABLED'))
    closing = (async () => {
      let acknowledged = false, timer
      await new Promise(resolve => {
        if (exited) { acknowledged = true; resolve(); return }
        closeResolve = () => { acknowledged = true; resolve() }
        timer = setTimeout(resolve, 2000); timer.unref?.()
        try { worker.postMessage({ type: 'close' }) } catch { resolve() }
      })
      clearTimeout(timer)
      await worker.terminate()
      return { stopped: true, acknowledged }
    })()
    return closing
  }
  let startupTimer
  try {
    startupTimer = setTimeout(() => startupReject(extensionError('扩展初始化超时', 'EXTENSION_START_TIMEOUT')), startupTimeoutMs)
    startupTimer.unref?.()
    await ready
    return { descriptor, call, close, get closed() { return closed } }
  } catch (error) { await close(); throw error }
  finally { clearTimeout(startupTimer) }
}
