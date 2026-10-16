import { installPairedStandalonePlugin } from '../../src/extensions/paired-update.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createModelRuntime, createRuntimeStores } from '../../src/core/runtime.js'
import { generateKey, startForwardServer } from '../../src/forward.js'
import { isLoopbackHost } from '../../src/trust.js'
import { createManagement } from './management.mjs'
import { createStandaloneEac } from './eac.mjs'
import { createAccountConnectorsHost, combineCoreWithAccountConnectors } from '../../src/extensions/account-connectors.js'
import { unavailableAccountConnectors } from './extensions.mjs'

const PRODUCT = 'our-free-model-standalone'
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export function resolveStandaloneDataDir(env = process.env, home = os.homedir()) {
  const configured = typeof env.OFM_HOME === 'string' ? env.OFM_HOME.trim() : ''
  return configured === '' ? path.join(home, '.our-free-model') : path.resolve(configured)
}

/** 直接创建核心和 HTTP 服务，不加载插件入口、Cordis 或 DSH 凭据。 */
export async function startStandalone({
  dataDir = resolveStandaloneDataDir(), host = '127.0.0.1', port,
  logger = console, refresh = true, probe,
  accountConnectorsFactory = createAccountConnectorsHost, eacFactory = createStandaloneEac, pairedUpdate = true,
} = {}) {
  if (!isLoopbackHost(host)) throw new TypeError('the standalone service binds a loopback address only')
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path')
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new TypeError('port must be an integer between 0 and 65535')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const lockFile = path.join(dataDir, 'service.lock')
  const lock = fs.openSync(lockFile, 'wx', 0o600)
  let stores
  let runtime
  let listener
  let management
  let accountConnectors
  let coreRuntime
  let eac
  let timer
  let refreshInFlight
  let closing
  let stopped = false
  const releaseLock = () => {
    fs.closeSync(lock)
    fs.unlinkSync(lockFile)
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, product: PRODUCT }))
    stores = createRuntimeStores({ dataDir, logger })
    const { settings } = stores
    const savedPort = settings.get().standalonePort
    const requestedPort = port ?? (Number.isInteger(savedPort) && savedPort >= 0 && savedPort <= 65535 ? savedPort : 18900)
    const existingKey = settings.get().forwardKey
    const key = typeof existingKey === 'string' && existingKey !== '' ? existingKey : generateKey()
    settings.update({ forwardKey: key, ...probe === undefined ? {} : { standaloneProbe: probe === true } })
    settings.flush()
    if (settings.writeFailed) throw new Error('could not persist the standalone API key')
    eac = eacFactory({
      dataDir,
      onSaved: () => { void runtime?.refreshSealedLane().catch(error => logger.warn?.(`EAC 清单刷新失败：${error.message}`)) },
    })
    coreRuntime = createModelRuntime({
      ...stores, logger, attributionUserAgent: `${PRODUCT}/${VERSION}`,
      sealedCredential: eac.credential,
    })
    try {
      accountConnectors = await accountConnectorsFactory({ dataDir, logger, stats: stores.stats })
      if(pairedUpdate&&typeof accountConnectors.installFromDirectory==='function')await installPairedStandalonePlugin(accountConnectors,{dataDir})
    } catch (error) {
      logger.warn?.('账号连接扩展初始化失败；核心服务继续运行')
      accountConnectors = unavailableAccountConnectors(error)
    }
    runtime = combineCoreWithAccountConnectors(coreRuntime, accountConnectors)
    const capabilities = () => ({
      anonymous: true, kilo: true, eac: true, webUi: true, accountConnectors: true,
      accountChannels: accountConnectors.state().state === 'ready',
    })
    management = createManagement({
      stores, runtime, accountConnectors, eac,
      info: () => ({
        product: PRODUCT, version: VERSION, dataDir,
        baseUrl: `http://${host === '::1' ? '[::1]' : host}:${listener?.port ?? requestedPort}`,
        automaticRefresh: refresh,
        networkMode: process.env.OFM_TEST_UPSTREAM ? 'fixture' : 'live',
        capabilities: capabilities(),
      }),
      onSettingsChanged: () => { if (!refreshInFlight) scheduleRefresh() },
    })
    listener = await startForwardServer({
      config: () => ({ host, port: requestedPort, enabled: settings.get().enabled !== false, key: settings.get().forwardKey }),
      complete: runtime.complete,
      modelRows: runtime.publicModelRows,
      health: () => ({
        ok: true, service: PRODUCT, product: 'standalone', version: VERSION,
        capabilities: capabilities(),
      }),
      handleRequest: management.handleRequest,
      log: message => logger.warn?.(`our-free-model standalone: ${message}`),
    })
    management.setPort(listener.port)
    settings.update({ standalonePort: listener.port })
    settings.flush()

    function scheduleRefresh() {
      clearTimeout(timer)
      if (stopped || !refresh) return
      const minutes = Number(settings.get().probeIntervalMinutes)
      timer = setTimeout(() => { void refreshModels() }, (Number.isFinite(minutes) && minutes > 0 ? Math.max(1, minutes) : 15) * 60_000)
      timer.unref?.()
    }
    function refreshModels(force = false) {
      if (refreshInFlight) return refreshInFlight
      refreshInFlight = runtime.refreshCatalog({ probe: settings.get().standaloneProbe === true, force })
        .catch(error => {
          if (!stopped) logger.warn?.(`our-free-model standalone: catalog refresh failed (${error?.message ?? error})`)
        })
        .finally(() => { refreshInFlight = undefined; scheduleRefresh() })
      return refreshInFlight
    }
    // 启动可强制探测；后续周期刷新遵守核心的限流退避。
    const ready = refresh ? refreshModels(settings.get().standaloneProbe === true) : Promise.resolve()
    return {
      product: PRODUCT, version: VERSION, dataDir,
      url: `http://${host === '::1' ? '[::1]' : host}:${listener.port}`,
      managementUrl: `http://${host === '::1' ? '[::1]' : host}:${listener.port}/${management.bootstrapFragment}`,
      port: listener.port,
      keyFile: path.join(dataDir, 'settings.json'),
      runtime, accountConnectors, channels: accountConnectors, ready,
      close() {
        if (closing !== undefined) return closing
        stopped = true
        clearTimeout(timer)
        management.dispose()
        eac.dispose()
        coreRuntime.dispose()
        closing = (async () => {
          try {
            const results = await Promise.allSettled([listener.close(), accountConnectors.dispose()])
            const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
            if (failures.length) throw new AggregateError(failures, '独立服务停止时有资源未能退出')
          } finally {
            stores.dispose()
            releaseLock()
          }
        })()
        return closing
      },
    }
  } catch (error) {
    stopped = true
    clearTimeout(timer)
    management?.dispose()
    eac?.dispose()
    coreRuntime?.dispose()
    if (listener) await listener.close()
    await accountConnectors?.dispose()
    stores?.dispose()
    releaseLock()
    throw error
  }
}
