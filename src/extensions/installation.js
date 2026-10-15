import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { extensionError } from './worker-bridge.js'

export const EXTENSION_ID = 'ofm.account-connectors'
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_BYTES = 96 * 1024 * 1024
export function relativeExtensionPath(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_@./-]+$/.test(value) || value.startsWith('/') || value.includes('\\') || value.split('/').some(piece => piece === '' || piece === '.' || piece === '..')) {
    throw extensionError('扩展包包含不安全的文件路径', 'EXTENSION_INVALID_PACKAGE', 400)
  }
  return value
}
function contained(root, target) {
  const difference = path.relative(path.resolve(root), path.resolve(target))
  if (difference === '' || difference.startsWith('..' + path.sep) || difference === '..' || path.isAbsolute(difference)) throw extensionError('扩展文件超出安装目录', 'EXTENSION_INVALID_PACKAGE', 400)
  return target
}
export async function assertSafeDirectoryPath(directory, { allowMissing = false } = {}) {
  const resolved = path.resolve(directory), parsed = path.parse(resolved)
  let current = parsed.root
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    let info
    try { info = await fs.lstat(current) } catch (error) { if (allowMissing && error.code === 'ENOENT') return resolved; throw error }
    if (info.isSymbolicLink() || !info.isDirectory()) throw extensionError('扩展目录或其父路径不能是符号链接、联接或普通文件', 'EXTENSION_INVALID_PATH', 400)
  }
  const actual = await fs.realpath(resolved)
  if (path.resolve(actual).toLowerCase() !== resolved.toLowerCase()) throw extensionError('扩展目录实际路径与声明不一致', 'EXTENSION_INVALID_PATH', 400)
  return resolved
}
async function regularFile(root, relative) {
  relativeExtensionPath(relative)
  const target = contained(root, path.join(root, relative))
  let parent = root
  for (const segment of relative.split('/')) {
    parent = path.join(parent, segment)
    const info = await fs.lstat(parent)
    if (info.isSymbolicLink()) throw extensionError('扩展包不能包含符号链接', 'EXTENSION_INVALID_PACKAGE', 400)
  }
  const info = await fs.lstat(target)
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw extensionError('扩展文件类型或大小不符合要求', 'EXTENSION_INVALID_PACKAGE', 400)
  return target
}
export async function inspectExtensionDirectory(directory) {
  const root = await assertSafeDirectoryPath(directory)
  const info = await fs.lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw extensionError('请选择普通的本地扩展目录', 'EXTENSION_INVALID_PACKAGE', 400)
  const manifestFile = await regularFile(root, 'extension.json')
  const raw = await fs.readFile(manifestFile, 'utf8')
  if (Buffer.byteLength(raw) > 256 * 1024) throw extensionError('扩展清单过大', 'EXTENSION_INVALID_PACKAGE', 400)
  let manifest
  try { manifest = JSON.parse(raw) } catch { throw extensionError('扩展清单不是有效的 JSON', 'EXTENSION_INVALID_PACKAGE', 400) }
  if (manifest?.id !== EXTENSION_ID || manifest?.protocolVersion !== 1) throw extensionError('扩展身份或协作协议不兼容', 'EXTENSION_INCOMPATIBLE', 409)
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version ?? '')) throw extensionError('扩展版本格式不正确', 'EXTENSION_INVALID_PACKAGE', 400)
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw extensionError('扩展缺少文件校验清单', 'EXTENSION_INVALID_PACKAGE', 400)
  const entries = Object.entries(manifest.files)
  if (entries.length < 1 || entries.length > 500) throw extensionError('扩展文件清单数量不符合要求', 'EXTENSION_INVALID_PACKAGE', 400)
  const entry = relativeExtensionPath(manifest.runtime?.entry)
  if (!Object.hasOwn(manifest.files, entry)) throw extensionError('扩展运行入口不在文件清单中', 'EXTENSION_INVALID_PACKAGE', 400)
  if (!manifest.ui || typeof manifest.ui !== 'object' || Array.isArray(manifest.ui) || typeof manifest.ui.entry !== 'string' || !Array.isArray(manifest.ui.assets)) throw extensionError('扩展缺少完整的界面入口和资源清单', 'EXTENSION_INVALID_PACKAGE', 400)
  const assets = manifest.ui.assets
  if (!Array.isArray(assets) || assets.length > 200) throw extensionError('扩展界面清单不正确', 'EXTENSION_INVALID_PACKAGE', 400)
  const uiEntry = relativeExtensionPath(manifest.ui?.entry ?? 'web/index.html')
  for (const item of new Set([uiEntry, ...assets])) {
    relativeExtensionPath(item)
    if (!Object.hasOwn(manifest.files, item)) throw extensionError('扩展界面资源未声明', 'EXTENSION_INVALID_PACKAGE', 400)
  }
  let total = 0
  const files = new Map()
  for (const [relative, expected] of entries) {
    relativeExtensionPath(relative)
    if (relative === 'extension.json' || !/^[a-f0-9]{64}$/.test(expected)) throw extensionError('扩展摘要格式不正确', 'EXTENSION_INVALID_PACKAGE', 400)
    const buffer = await fs.readFile(await regularFile(root, relative))
    total += buffer.length
    if (total > MAX_TOTAL_BYTES) throw extensionError('扩展包总大小超出限制', 'EXTENSION_INVALID_PACKAGE', 400)
    if (crypto.createHash('sha256').update(buffer).digest('hex') !== expected) throw extensionError('扩展文件校验失败：' + relative, 'EXTENSION_CHECKSUM_FAILED', 400)
    files.set(relative, buffer)
  }
  return { root, manifest, raw, files, totalBytes: total }
}
export async function removeOwnedExtensionDirectory(root, target) {
  const absoluteRoot = await assertSafeDirectoryPath(root), absoluteTarget = contained(absoluteRoot, target)
  if (path.dirname(absoluteTarget) !== absoluteRoot || !/^(?:ofm\.account-connectors|\.install-[a-f0-9-]+|\.previous-[a-f0-9-]+)$/.test(path.basename(absoluteTarget))) throw extensionError('拒绝清理扩展安装范围以外的目录', 'EXTENSION_INVALID_PATH', 400)
  const targetInfo = await fs.lstat(absoluteTarget).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!targetInfo) return
  if (targetInfo.isSymbolicLink()) throw extensionError('扩展安装目录不能是符号链接', 'EXTENSION_INVALID_PATH', 400)
  await fs.rm(absoluteTarget, { recursive: true, force: false })
}
export async function installExtensionDirectory({ source, installationsRoot, trustDevelopment = false, beforeSwitch = async () => {} }) {
  const inspected = await inspectExtensionDirectory(source)
  // A hash proves integrity, not who published a package. Local development is explicit.
  if (inspected.manifest.development !== true || trustDevelopment !== true) throw extensionError('当前仅接受你明确确认来源的本地开发扩展；正式发行需要发布者验证', 'EXTENSION_TRUST_REQUIRED', 400)
  await assertSafeDirectoryPath(installationsRoot, { allowMissing: true })
  await fs.mkdir(installationsRoot, { recursive: true, mode: 0o700 })
  await assertSafeDirectoryPath(installationsRoot)
  const parentInfo = await fs.lstat(installationsRoot)
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw extensionError('扩展安装根目录不安全', 'EXTENSION_INVALID_PATH', 400)
  const destination = path.join(installationsRoot, EXTENSION_ID)
  const stage = path.join(installationsRoot, '.install-' + crypto.randomUUID())
  const previous = path.join(installationsRoot, '.previous-' + crypto.randomUUID())
  contained(installationsRoot, destination); contained(installationsRoot, stage); contained(installationsRoot, previous)
  await fs.mkdir(stage, { mode: 0o700 })
  let movedPrevious = false, switched = false
  try {
    for (const [relative, buffer] of inspected.files) {
      const output = contained(stage, path.join(stage, relative))
      await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
      await fs.writeFile(output, buffer, { mode: 0o600, flag: 'wx' })
    }
    await fs.writeFile(path.join(stage, 'extension.json'), inspected.raw, { mode: 0o600, flag: 'wx' })
    await inspectExtensionDirectory(stage)
    await beforeSwitch()
    const existing = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (existing?.isSymbolicLink()) throw extensionError('已有扩展目录不安全', 'EXTENSION_INVALID_PATH', 400)
    if (existing) { await fs.rename(destination, previous); movedPrevious = true }
    await fs.rename(stage, destination); switched = true
    let cleanupWarning
    if (movedPrevious) {
      try { await removeOwnedExtensionDirectory(installationsRoot, previous) }
      catch { cleanupWarning = '新版本已安装，但旧版本临时备份暂时无法清理；可在退出后清理安装目录中的备份' }
    }
    return { manifest: inspected.manifest, path: destination, totalBytes: inspected.totalBytes, ...(cleanupWarning ? { cleanupWarning } : {}) }
  } catch (error) {
    if (!switched && movedPrevious) await fs.rename(previous, destination)
    await removeOwnedExtensionDirectory(installationsRoot, stage).catch(() => {})
    throw error
  }
}
