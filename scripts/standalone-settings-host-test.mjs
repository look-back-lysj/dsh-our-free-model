import assert from 'node:assert/strict'
import fs from 'node:fs'

const app = fs.readFileSync(new URL('../packages/standalone/frontend/app.tsx', import.meta.url), 'utf8')
const html = fs.readFileSync(new URL('../packages/standalone/frontend/index.html', import.meta.url), 'utf8')
assert.ok(!app.includes("./legacy"), 'React 入口不得依赖 legacy 宿主')
assert.ok(!fs.existsSync(new URL('../packages/standalone/frontend/legacy.js', import.meta.url)), 'legacy 宿主必须删除')
assert.ok(html.includes('id="root"'), '入口必须只提供 React 根节点')
assert.ok(!html.includes('page-connection'), '连接页不得由静态 HTML 承载')
assert.ok(app.includes('function LoginScreen'), '登录页必须由 React 渲染')
assert.ok(app.includes('function LoadingScreen'), '加载页必须由 React 渲染')
assert.ok(app.includes('function EacMount'), '核心 EAC 页必须由 React 生命周期管理')
assert.ok(app.includes("import('./eac.mjs')"), 'EAC 授权与资源池必须按需加载')
assert.ok(app.includes('module?.hide()'), '离开 EAC 页面必须清理其挂载根')
assert.ok(app.includes('<ExtensionsPage'), '核心必须提供扩展安装指引入口')
assert.ok(!app.includes("import('./channels.mjs')"), '核心入口不得加载外置账号页面')
export function verifySettingsHost() { return true }
console.log('standalone-settings-host: React 根入口、登录页、连接页、EAC 生命周期及扩展指引检查通过')
