import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { gunzipSync, gzipSync } from 'node:zlib'
import crypto from 'node:crypto'
import { prepareLegacyAccountMigration } from './legacy-migration.js'
import { assertSafeDirectoryPath } from './installation.js'

const ID = 'ofm.account-connectors', NAME = 'dsh-ofm-account-connectors'
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const payloadDefault = fileURLToPath(new URL('../../companions/account-connectors.json.gz', import.meta.url))
const jobs = globalThis[Symbol.for('ofm.paired-install.jobs')] ??= new Map()
const validRelative = value => typeof value === 'string' && !/[\\:%]/.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..')
const service = (ctx, name) => { try { return ctx.get?.(name) ?? ctx[name] } catch { return undefined } }
async function json(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error } }
async function save(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = file + '.' + crypto.randomUUID() + '.tmp'
  try { await fs.writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file) }
  finally { await fs.rm(temp, { force: true }) }
}
async function exclusive(key, body) {
  if (jobs.has(key)) return jobs.get(key)
  const job = Promise.resolve().then(body).finally(() => { if (jobs.get(key) === job) jobs.delete(key) })
  jobs.set(key, job); return job
}
export async function inspectPairedPayload(file = payloadDefault) {
  let bytes
  try { bytes = await fs.readFile(file) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  if (bytes.length > 4 * 1024 * 1024) throw new Error('配套插件载荷过大')
  const content = JSON.parse(gunzipSync(bytes, { maxOutputLength: 24 * 1024 * 1024 }).toString('utf8'))
  if (content?.format !== 'ofm-paired-plugin/v1' || content.name !== NAME || !Array.isArray(content.files) || content.files.length > 80) throw new Error('配套插件载荷格式错误')
  const seen = new Set(); let total = 0
  for (const file of content.files) {
    const folded = typeof file?.path === 'string' ? file.path.toLowerCase() : ''
    if (!validRelative(file?.path) || seen.has(folded) || typeof file.base64 !== 'string') throw new Error('配套插件文件路径错误')
    seen.add(folded)
    const raw = Buffer.from(file.base64, 'base64'); total += raw.length
    if (total > 20 * 1024 * 1024 || raw.length !== file.size || hash(raw) !== file.sha256) throw new Error('配套插件文件校验失败')
  }
  for (const file of ['package.json','extension.json','host/index.mjs']) if (!seen.has(file)) throw new Error('配套插件缺少入口')
  const body = name => JSON.parse(Buffer.from(content.files.find(file => file.path === name).base64, 'base64').toString('utf8'))
  const manifest = body('extension.json'), pkg = body('package.json')
  if (pkg.name !== NAME || manifest.id !== ID || pkg.version !== content.version || manifest.version !== content.version || !manifest.files) throw new Error('配套插件身份不符')
  for (const [name, digest] of Object.entries(manifest.files)) {
    const file = content.files.find(item => item.path === name)
    if (!file || file.sha256 !== digest) throw new Error('配套插件清单校验失败')
  }
  if (pkg.scripts?.prepare || pkg.scripts?.preinstall || pkg.scripts?.install || pkg.scripts?.postinstall) throw new Error('配套插件不能包含安装执行脚本')
  return { ...content, payloadSha256: hash(bytes) }
}
export async function unpackPairedPayload(payload, root) {
  await assertSafeDirectoryPath(root, { allowMissing: true })
  const destination = path.join(root, payload.payloadSha256), stamp = path.join(destination, '.paired-extracted.json')
  await assertSafeDirectoryPath(destination, { allowMissing: true })
  const previous = await json(stamp)
  if (previous?.sha256 === payload.payloadSha256) {
    for (const file of payload.files) if (hash(await fs.readFile(path.join(destination, file.path))) !== file.sha256) throw new Error('已解包的配套插件发生变化')
    return destination
  }
  await fs.mkdir(destination, { recursive: true, mode: 0o700 })
  for (const file of payload.files) {
    const target = path.join(destination, file.path)
    await assertSafeDirectoryPath(path.dirname(target), { allowMissing: true })
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('配套插件文件不能是符号链接') } catch (error) { if (error.code !== 'ENOENT') throw error }
    await fs.writeFile(target, Buffer.from(file.base64, 'base64'), { mode: 0o600 })
    if (hash(await fs.readFile(target)) !== file.sha256) throw new Error('配套插件写入回读失败')
  }
  await save(stamp, { sha256: payload.payloadSha256 }); return destination
}
/** Local tarball avoids pnpm's directory/link: installation on Windows desktop. */
export async function pairedPackageTarball(payload, directory) {
  const file = directory + '.tgz', blocks = []
  const octal = (header, offset, width, value) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii')
  for (const item of payload.files) {
    const name = 'package/' + item.path, bytes = Buffer.from(item.base64, 'base64')
    if (Buffer.byteLength(name) > 99) throw new Error('配套插件归档路径过长')
    const header = Buffer.alloc(512)
    header.write(name, 0, 100); octal(header, 100, 8, 0o644); octal(header, 108, 8, 0); octal(header, 116, 8, 0)
    octal(header, 124, 12, bytes.length); octal(header, 136, 12, 0)
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
    const checksum = header.reduce((sum, value) => sum + value, 0)
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  const bytes = gzipSync(Buffer.concat(blocks), { level: 9 })
  try { if (hash(await fs.readFile(file)) === hash(bytes)) return file } catch (error) { if (error.code !== 'ENOENT') throw error }
  await assertSafeDirectoryPath(path.dirname(file)); await fs.writeFile(file, bytes, { mode: 0o600 })
  if (hash(await fs.readFile(file)) !== hash(bytes)) throw new Error('配套安装包回读校验失败')
  return file
}
/** pnpm must not restore the pre-hot-update core from an old file:/registry spec. */
export async function pinCurrentCorePackage(profile, root, packageRoot = fileURLToPath(new URL('../../', import.meta.url))) {
  const manifestFile = profile?.dir && path.join(profile.dir, 'package.json')
  if (!manifestFile) return { rollback: async () => {} }
  const original = await fs.readFile(manifestFile).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (!original) return { rollback: async () => {} }
  const profileManifest = JSON.parse(original)
  if (!profileManifest.dependencies?.['dsh-our-free-model']) return { rollback: async () => {} }
  const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  if (pkg.name !== 'dsh-our-free-model' || pkg.ofm?.pairedAccountUpdate !== 'ofm-paired-plugin/v1') throw new Error('核心安装来源无法确认为双插件版本')
  const rows = []
  const collect = async relative => {
    if (!validRelative(relative)) throw new Error('核心安装包路径无效')
    const target = path.join(packageRoot, relative), info = await fs.lstat(target)
    if (info.isSymbolicLink()) throw new Error('核心安装包不能包含目录链接')
    if (info.isDirectory()) { for (const name of (await fs.readdir(target)).sort()) if (!name.startsWith('.') && name !== 'node_modules') await collect(relative + '/' + name) }
    else if (info.isFile()) { const bytes = await fs.readFile(target); rows.push({ path: relative, size: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') }) }
  }
  for (const relative of ['package.json', ...pkg.files]) await collect(relative)
  const identity = hash(JSON.stringify(rows.map(({ path, sha256 }) => ({ path, sha256 }))))
  const directory = path.join(root, 'core-artifacts'); await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const archive = await pairedPackageTarball({ files: rows }, path.join(directory, identity))
  const pinnedSpec = 'file:' + archive.replaceAll('\\', '/')
  if (profileManifest.dependencies['dsh-our-free-model'] === pinnedSpec) return { rollback: async () => {}, unchanged: true }
  profileManifest.dependencies['dsh-our-free-model'] = pinnedSpec
  await save(manifestFile, profileManifest)
  return { pinned: true, async rollback() {
    const current = await json(manifestFile)
    // Restore only our one dependency field; retain any separately installed plugin entries.
    if (current?.dependencies?.['dsh-our-free-model'] === pinnedSpec) {
      current.dependencies['dsh-our-free-model'] = JSON.parse(original).dependencies['dsh-our-free-model']
      await save(manifestFile, current)
    }
  } }
}
function parseYamlFrom(profile) {
  for (const anchor of [profile?.installAnchor, profile?.dir && path.join(profile.dir, 'package.json')].filter(Boolean)) {
    try { return createRequire(anchor)('yaml').parse } catch { /* older official host uses js-yaml */ }
    try { return createRequire(anchor)('js-yaml').load } catch { /* no parser at this anchor */ }
  }
}
async function namespaceState(ctx) {
  const settings = service(ctx, 'settings')
  if (typeof settings?.describe !== 'function') return undefined
  try { const descriptor = await settings.describe('channel-pack', { redactSecrets: false }); return descriptor?.value?.accounts ? descriptor.value : undefined }
  catch { return undefined }
}
export async function pairedUpdateStatus(home, profileDir) {
  if (!home) return { phase: 'not-applicable' }
  const record = await json(path.join(home, 'our-free-model', 'paired-update', ...(profileDir ? [hash(path.resolve(profileDir)).slice(0, 16)] : []), 'status.json'))
  return record ? { phase: record.phase, accounts: record.accounts ?? 0, error: record.error ?? '', sourceRetained: record.sourceRetained === true } : { phase: 'not-started' }
}
export async function installPairedDshPlugin(ctx, { payloadFile = payloadDefault, legacyHome, legacyState } = {}) {
  const profile = service(ctx, 'profileContext'), manager = service(ctx, 'pluginManager'), credentials = service(ctx, 'credentials')
  if (!profile?.home || typeof manager?.installBundle !== 'function' || !credentials) throw new Error('宿主未提供配套插件热安装所需服务')
  return exclusive(path.resolve(profile.home) + ':' + path.resolve(profile.dir ?? profile.home), async () => {
    const payload = await inspectPairedPayload(payloadFile)
    if (!payload) return { installed: false, noPayload: true }
    // Installation is profile-specific, while old account data is DSH-home-specific.
    const profileId = hash(path.resolve(profile.dir ?? profile.home)).slice(0, 16)
    const root = path.join(profile.home, 'our-free-model', 'paired-update', profileId), statusFile = path.join(root, 'status.json')
    await assertSafeDirectoryPath(root, { allowMissing: true })
    const prior = await json(statusFile)
    const list = typeof manager.listBundles === 'function' ? await manager.listBundles() : undefined
    const installed = (Array.isArray(list) ? list : list?.bundles)?.find(bundle => bundle.name === NAME && bundle.installed)
    // Keep the updated core pinned even when the independent plugin has been disabled/uninstalled.
    if (prior?.phase === 'complete') { await pinCurrentCorePackage(profile, root); return { installed: Boolean(installed ?? service(ctx, 'ofmAccountConnectors')), alreadyProcessed: true, migratedAccounts: prior.accounts } }
    if (installed && !prior) return { installed: true, existingIndependentPlugin: true }
    const source = await unpackPairedPayload(payload, path.join(root, 'payloads'))
    const home = legacyHome ?? process.env.DSH_CHANNEL_PACK_STATE_DIR ?? profile.home
    const dataDir = path.join(profile.home, 'extensions-data', ID)
    const migration = await prepareLegacyAccountMigration({ legacyHome: home, dataDir, credentials, legacyState: legacyState ?? await namespaceState(ctx), parseYaml: parseYamlFrom(profile) })
    const base = { version: 1, payloadSha256: payload.payloadSha256, accounts: migration.summary.accounts ?? 0, sourceRetained: true, profileId }
    const status = async (phase, error = '') => { await save(statusFile, { ...base, phase, error }); await save(path.join(profile.home, 'our-free-model', 'paired-update', 'status.json'), { ...base, phase, error }) }
    await status('prepared')
    let completed = false, corePin
    try {
      await migration.commit(); await status('installing')
      corePin = await pinCurrentCorePackage(profile, root)
      // An earlier failed install can have left a disabled, fully copied package.
      const archive = await pairedPackageTarball(payload, source)
      const result = installed ? await manager.setBundleEnabled(NAME, true) : await manager.installBundle(archive, { enabled: true })
      if (result?.application !== 'applied') throw new Error('配套插件未完成热加载：' + String(result?.application ?? 'unknown'))
      const api = service(ctx, 'ofmAccountConnectors')
      if (!api || typeof api.describe !== 'function') throw new Error('独立账号插件未注册合作服务')
      await api.ready?.()
      const descriptor = await api.describe()
      if (!['ready','disabled'].includes(descriptor.state) || migration.summary.accounts > 0 && descriptor.state !== 'ready') throw new Error('独立账号插件未完成迁移后的启动')
      await migration.finish(); completed = true
      await status('complete')
      return { installed: true, independent: true, migration: migration.summary }
    } catch (error) {
      if (completed) throw new Error('账号迁移已完成，但结果记录失败；新旧账号数据均保留')
      try { await manager.setBundleEnabled?.(NAME, false) } catch { await status('recovery-required', '独立插件停用未确认，旧数据保留'); throw new Error('独立插件停用未确认，迁移副本保留待恢复') }
      await corePin?.rollback()
      try { await migration.rollback() } catch { await status('recovery-required', '迁移回退未确认，旧数据保留'); throw new Error('迁移回退未确认，旧数据仍保留') }
      const message = error?.message?.startsWith('配套插件') || error?.message?.startsWith('独立账号插件') ? error.message : '配套安装失败；旧账号数据仍保留'
      await status('rolled-back', message)
      throw new Error(message)
    }
  })
}
export function mountPairedDshUpdate(ctx, logger = console) {
  let stopped = false
  const scoped = ctx.inject(['pluginManager','profileContext','credentials'], scope => {
    const timer = setTimeout(() => {
      if (!stopped) void installPairedDshPlugin(scope).then(() => { try { ctx.emit?.('ofm/paired-update') } catch {} }).catch(error => logger.error?.('双插件热更新未完成：' + error.message))
    }, 0)
    timer.unref?.(); scope.effect?.(() => () => clearTimeout(timer))
  })
  return () => { stopped = true; scoped?.dispose?.() }
}
export async function installPairedStandalonePlugin(host, { dataDir, payloadFile = payloadDefault } = {}) {
  return exclusive(path.resolve(dataDir) + ':standalone', async () => {
    const payload = await inspectPairedPayload(payloadFile)
    if (!payload) return { installed: false, noPayload: true }
    if (host.state().installed) return { installed: true, existingIndependentPlugin: true }
    const source = await unpackPairedPayload(payload, path.join(dataDir, 'paired-update', 'payloads'))
    const migration = await prepareLegacyAccountMigration({ legacyHome: dataDir, dataDir: path.join(dataDir, 'extensions-data', ID) })
    let complete = false
    try {
      await migration.commit(); await host.installFromDirectory(source, { trustDevelopment: true })
      if (migration.summary.migrated) await host.enable()
      await migration.finish(); complete = true
      return { installed: true, migration: migration.summary }
    } catch (error) {
      if (!complete) { await host.disable(); await host.uninstall(); await migration.rollback() }
      throw error
    }
  })
}
