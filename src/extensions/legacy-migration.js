import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { assertSafeDirectoryPath } from './installation.js'

const PROVIDERS = ['codearts','buddy','workbuddy','lobsterai','qoder','qodercn','trae','cline','loomy','raccoon','minimax','zcode','gemini']
const PREFIX = 'OFM_ACCOUNT_CONNECTORS_'
const activeMigrations = globalThis[Symbol.for('ofm.active-migrations')] ??= new Map()
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const validRef = ref => typeof ref === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(ref)
const exists = async file => Boolean(await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error }))
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('迁移数据文件无法解析：' + path.basename(file)) }
}
async function atomic(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + crypto.randomUUID() + '.tmp'
  try { await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file) }
  finally { await fs.rm(temporary, { force: true }) }
}
async function tree(root, relative = '', result = [], budget = { bytes: 0 }) {
  const info = await fs.lstat(path.join(root, relative))
  if (info.isSymbolicLink()) throw new Error('迁移拒绝符号链接或联接')
  if (info.isDirectory()) for (const name of await fs.readdir(path.join(root, relative))) await tree(root, path.join(relative, name), result, budget)
  else if (info.isFile()) {
    budget.bytes += info.size
    if (info.size > 32 * 1024 * 1024 || budget.bytes > 96 * 1024 * 1024 || result.length >= 2048) throw new Error('迁移数据超出边界')
    result.push({ relative, bytes: await fs.readFile(path.join(root, relative)) })
  } else throw new Error('迁移仅支持普通文件')
  return result
}
async function removeOwned(directory, expected) {
  if (path.resolve(directory) !== path.resolve(expected)) throw new Error('拒绝越界清理迁移目录')
  await assertSafeDirectoryPath(directory, { allowMissing: true })
  await fs.rm(directory, { recursive: true, force: true })
}
function paths(dataDir, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('迁移事务编号无效')
  return { stage: dataDir + '.migration-' + id, backup: dataDir + '.before-' + id, journal: dataDir + '.migration.json' }
}
const noop = summary => ({ summary, commit: async () => {}, finish: async () => {}, rollback: async () => {} })

export async function readLegacyState({ legacyHome, legacyState, parseYaml }) {
  if (legacyState !== undefined) {
    const value = typeof legacyState === 'function' ? await legacyState() : legacyState
    if (value?.accounts !== undefined) return structuredClone(value)
  }
  const state = await readJson(path.join(legacyHome, 'channel-pack', 'state.json'))
  if (state !== undefined) return state
  for (const name of ['settings.yaml', 'settings.yaml.imported']) {
    const file = path.join(legacyHome, name)
    if (!await exists(file)) continue
    const text = await fs.readFile(file, 'utf8')
    if (!/^channel-pack\s*:/m.test(text)) continue
    if (typeof parseYaml !== 'function') throw new Error('需要宿主 YAML 解析器才能无损迁移旧账号设置')
    const settings = parseYaml(text)
    if (settings?.['channel-pack']?.accounts !== undefined) return structuredClone(settings['channel-pack'])
  }
  return undefined
}

/** Recover an interrupted copy before any new account runtime is allowed to start. */
export async function recoverLegacyAccountMigration({ dataDir, credentials, ownedTransaction }) {
  const active = activeMigrations.get(path.resolve(dataDir))
  if (active && active !== ownedTransaction) throw new Error('此账号目录已有正在进行的迁移')
  const journalFile = dataDir + '.migration.json'
  const record = await readJson(journalFile)
  if (!record) return { recovered: false }
  if (record.version !== 1 || !Array.isArray(record.newRefs) || record.newRefs.some(entry => !validRef(entry?.ref) || !entry.ref.startsWith(PREFIX) || !/^[a-f0-9]{64}$/.test(entry.sha256))) throw new Error('迁移事务记录损坏，旧数据保留')
  const own = paths(dataDir, record.id)
  if (record.ownerPid !== process.pid && Number.isInteger(record.ownerPid)) {
    let alive = true
    try { process.kill(record.ownerPid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false }
    if (alive) throw new Error('另一进程仍持有迁移事务，请等待它完成')
  }
  const marker = await readJson(path.join(dataDir, 'legacy-migration.json'))
  if (marker?.transactionId === record.id && marker.status === 'complete') {
    await removeOwned(own.stage, own.stage); await removeOwned(own.backup, own.backup)
    await fs.rm(journalFile, { force: true })
    return { recovered: true, committed: true }
  }
  if (await exists(path.join(dataDir, 'instance.lock'))) throw new Error('迁移尚未完成但账号插件仍在运行；先停用扩展后重试')
  // A directory without our transaction marker belongs to someone else.
  if (marker?.transactionId === record.id) await removeOwned(dataDir, dataDir)
  else if (await exists(own.backup) && await exists(dataDir)) throw new Error('迁移目标已被其他进程改动；原目录和备份均保留')
  if (await exists(own.backup)) await fs.rename(own.backup, dataDir)
  if (credentials) for (const entry of [...(record.newRefs ?? [])].reverse()) {
    if (!validRef(entry.ref) || !entry.ref.startsWith(PREFIX) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('迁移凭据记录无效')
    const current = await credentials.resolve(entry.ref)
    if (current?.value === undefined) continue
    if (digest(current.value) !== entry.sha256) throw new Error('新凭据已独立更新，拒绝回退覆盖；旧凭据仍保留')
    await credentials.unset(entry.ref)
  }
  await removeOwned(own.stage, own.stage)
  await fs.rm(journalFile, { force: true })
  return { recovered: true, rolledBack: true }
}

/** Copy old account data; commit/finish surround independent plugin installation. */
export async function prepareLegacyAccountMigration({ legacyHome, dataDir, credentials, legacyState, parseYaml, restoreActive = true }) {
  if (!path.isAbsolute(legacyHome) || !path.isAbsolute(dataDir) || path.resolve(legacyHome) === path.resolve(dataDir)) throw new Error('迁移需要不同的绝对数据目录')
  await assertSafeDirectoryPath(legacyHome)
  await assertSafeDirectoryPath(dataDir, { allowMissing: true })
  await recoverLegacyAccountMigration({ dataDir, credentials })
  const markerFile = path.join(dataDir, 'legacy-migration.json')
  const previous = await readJson(markerFile)
  if (previous?.version === 1 && previous.status === 'complete') return noop({ migrated: false, alreadyMigrated: true, accounts: previous.accounts })
  const state = await readLegacyState({ legacyHome, legacyState, parseYaml })
  const localCredentials = credentials ? undefined : await readJson(path.join(legacyHome, 'channel-credentials.json'))
  if (state === undefined) {
    if (localCredentials && Object.keys(localCredentials).length) throw new Error('旧凭据仍存在但账号索引缺失；拒绝以空账号替代')
    return noop({ migrated: false, noLegacyData: true, accounts: 0 })
  }
  if (!Array.isArray(state.accounts)) throw new Error('旧账号索引格式错误')
  const ids = new Set(), refs = new Set(), oldValues = Object.create(null)
  for (const account of state.accounts) {
    if (!account || typeof account.id !== 'string' || !account.id || ids.has(account.id) || !validRef(account.credentialRef)) throw new Error('旧账号索引包含重复 ID 或无效凭据引用')
    ids.add(account.id); refs.add(account.credentialRef)
  }
  for (const ref of refs) {
    const value = credentials ? (await credentials.resolve(ref))?.value : localCredentials?.[ref]
    if (typeof value !== 'string' || !value) throw new Error('有账号凭据未能读取；旧数据保留，迁移停止')
    oldValues[ref] = value
  }
  const existing = await readJson(path.join(dataDir, 'channel-pack', 'state.json'))
  if (existing?.accounts?.length) throw new Error('独立插件已经有账号，拒绝自动覆盖；请使用合并迁移')
  if (await exists(path.join(dataDir, 'instance.lock'))) throw new Error('账号插件正在运行，必须先停用再迁移')
  const id = crypto.randomUUID(), own = paths(dataDir, id)
  const targetKey = path.resolve(dataDir)
  if (activeMigrations.has(targetKey)) throw new Error('此账号目录已有正在进行的迁移')
  activeMigrations.set(targetKey, id)
  const record = { version: 1, id, phase: 'preparing', ownerPid: process.pid, newRefs: [], createdAt: Date.now() }
  const saveJournal = () => atomic(own.journal, JSON.stringify(record))
  try { await saveJournal() } catch (error) { activeMigrations.delete(targetKey); throw error }
  let swapped = false, finished = false
  try {
    await fs.mkdir(own.stage, { recursive: true, mode: 0o700 })
    if (await exists(dataDir)) for (const item of await tree(dataDir)) await atomic(path.join(own.stage, item.relative), item.bytes)
    const files = []
    if (await exists(path.join(legacyHome, 'channel-pack'))) for (const item of await tree(path.join(legacyHome, 'channel-pack'))) {
      if (item.relative === 'state.json') continue
      const relative = path.join('channel-pack', item.relative)
      await atomic(path.join(own.stage, relative), item.bytes); files.push({ path: relative, sha256: digest(item.bytes) })
    }
    const gatewayKey = path.join(legacyHome, 'openai-gateway', 'api-key')
    if (await exists(gatewayKey)) {
      if (!(await fs.lstat(gatewayKey)).isFile()) throw new Error('旧网关密钥必须是普通文件')
      const bytes = await fs.readFile(gatewayKey)
      await atomic(path.join(own.stage, 'openai-gateway', 'api-key'), bytes); files.push({ path: 'openai-gateway/api-key', sha256: digest(bytes) })
    }
    await atomic(path.join(own.stage, 'channel-pack', 'state.json'), JSON.stringify(state, null, 2))
    const providers = Object.fromEntries(PROVIDERS.map(provider => [provider, restoreActive && state.accounts.some(account => account.provider === provider && account.enabled !== false)]))
    await atomic(path.join(own.stage, 'extension-settings.json'), JSON.stringify({ providers, backgroundRefresh: restoreActive, gatewayEnabled: restoreActive && state.gatewayEnabled !== false }, null, 2))
    await atomic(path.join(own.stage, 'host-activation.json'), JSON.stringify({ version: 1, enabled: restoreActive }))
    if (!credentials) await atomic(path.join(own.stage, 'credentials.json'), JSON.stringify(oldValues, null, 2))
    else for (const [ref, value] of Object.entries(oldValues)) {
      const nextRef = PREFIX + ref, found = await credentials.resolve(nextRef)
      if (found?.value !== undefined && found.value !== value) throw new Error('独立凭据引用已有不同数据，拒绝覆盖')
      if (found?.value === undefined) {
        record.newRefs.push({ ref: nextRef, sha256: digest(value) }); await saveJournal()
        await credentials.set(nextRef, value)
      }
      if ((await credentials.resolve(nextRef))?.value !== value) throw new Error('新凭据回读校验失败')
    }
    for (const file of files) if (digest(await fs.readFile(path.join(own.stage, file.path))) !== file.sha256) throw new Error('迁移文件回读校验失败')
    if (JSON.stringify(await readJson(path.join(own.stage, 'channel-pack', 'state.json'))) !== JSON.stringify(state)) throw new Error('迁移账号状态回读不一致')
    const marker = { version: 1, transactionId: id, status: 'pending', at: Date.now(), accounts: state.accounts.length, sourceStateSha256: digest(JSON.stringify(state)), copiedFiles: files, sourceRetained: true }
    await atomic(path.join(own.stage, 'legacy-migration.json'), JSON.stringify(marker, null, 2))
    record.phase = 'prepared'; await saveJournal()
    return {
      summary: { migrated: true, accounts: state.accounts.length, providers: Object.keys(providers).filter(provider => providers[provider]), copiedFiles: files.length, sourceRetained: true },
      async commit() {
        if (swapped) return
        record.phase = 'committing'; await saveJournal()
        if (await exists(dataDir)) await fs.rename(dataDir, own.backup)
        await fs.rename(own.stage, dataDir); swapped = true
        record.phase = 'committed'; await saveJournal()
      },
      async finish() {
        if (!swapped) throw new Error('迁移尚未提交')
        // Commit receipt precedes backup deletion, so process interruption is recoverable.
        await atomic(markerFile, JSON.stringify({ ...marker, status: 'complete' }, null, 2)); finished = true
        try { await removeOwned(own.backup, own.backup); await fs.rm(own.journal, { force: true }) }
        finally { activeMigrations.delete(targetKey) }
      },
      async rollback() {
        if (finished) throw new Error('迁移已经确认完成，旧源数据仍保留')
        await recoverLegacyAccountMigration({ dataDir, credentials, ownedTransaction: id }); activeMigrations.delete(targetKey); swapped = false
      },
    }
  } catch (error) {
    try { await recoverLegacyAccountMigration({ dataDir, credentials, ownedTransaction: id }); activeMigrations.delete(targetKey) }
    catch { throw new Error('迁移未完成且回退未确认；旧数据保留，请检查迁移事务记录') }
    throw error
  }
}
