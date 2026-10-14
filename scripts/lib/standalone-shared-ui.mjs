/** Reuse only OFM core visual components. Account UI is in the external extension. */
import fs from 'node:fs'
import vm from 'node:vm'
let source = fs.readFileSync(new URL('../../client.js', import.meta.url), 'utf8')
function replaceOnce(from, to, { optional = false } = {}) {
  const count = source.split(from).length - 1
  if (optional && count === 0) return
  if (count !== 1) throw new Error('核心共享页面转换位置改变：' + from.slice(0, 90))
  source = source.replace(from, to)
}
const api = "try { return new URL('api/our-free-model', document.baseURI).pathname } catch { return '/api/our-free-model' }"
replaceOnce(api, "return '/api/management'")
replaceOnce("api('/pool', { timeout: 25_000 })", "api('/eac/pool', { timeout: 25_000 })")
replaceOnce("...body === undefined ? {} : { body: JSON.stringify(body) },", "body: JSON.stringify(body ?? {}),")
let record
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { record = value } } } })
if (!record || typeof record.factory !== 'function') throw new Error('核心客户端模块无法读取')
const shared = record.factory(() => ({})).standalone
if (!shared || ['EacAuth', 'useEacLogin', 'DICT', 'CSS', 'Tank', 'usePool', 'poolReading', 'capacityText'].some(name => shared[name] === undefined)) throw new Error('核心 EAC 共享组件缺失')
if (['ChannelsPage', 'ChannelCard', 'CHANNEL_PROVIDERS'].some(name => Object.hasOwn(shared, name))) throw new Error('核心共享页面仍含账号渠道实现')
const css = shared.CSS + `
.ofm_root{max-width:none}
.ofm_root button,.ofm_root input,.ofm_root select{font-family:inherit}
.ofm_root img{max-width:100%}
.ofm_root input,.ofm_root select{max-width:100%;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--radius,8px);background:var(--surface,white);color:inherit}
.ofm_root input[type=checkbox]{padding:0}
`
export function standaloneSharedUi() {
  return { name: 'OFM core EAC shared UI',
    resolveId(id) { if (id === 'ofm-shared-client' || id === 'ofm-shared-styles.css') return '\0' + id },
    load(id) {
      if (id === '\0ofm-shared-client') return 'import * as React from "react"; export const shared = (' + record.factory.toString() + ')(() => React).standalone;'
      if (id === '\0ofm-shared-styles.css') return css
    },
  }
}
