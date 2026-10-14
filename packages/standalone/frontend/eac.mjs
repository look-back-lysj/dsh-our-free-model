import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { shared } from 'ofm-shared-client'
import 'ofm-shared-styles.css'

const { EacAuth, useEacLogin, DICT, Tank, usePool, poolReading, capacityText } = shared
const h = React.createElement
const t = key => DICT.zh[key] ?? key
t.locale = 'zh'

function EacPage({ summary }) {
  const [auth, onAuth] = React.useState(summary.eacAuth)
  const login = useEacLogin({ t, summary, onAuth })
  const { pool } = usePool()
  const reading = pool == null ? null : poolReading(pool)
  React.useEffect(() => { login.refresh() }, [login.refresh])
  return h(React.Fragment, null,
    h('header', { className: 'dashboard-heading' },
      h('div', null, h('div', { className: 'heading-eyebrow' }, 'WORKSPACE / EAC'),
        h('h1', null, 'EAC 协付渠道'), h('p', null, '使用本机独立授权，连接共享资源池。'))),
    h(EacAuth, { t, auth, eacLogin: login }),
    login.pending ? h('a', { href: login.pending.url, target: '_blank', rel: 'noreferrer noopener' }, '打开 GitHub 授权页面 ↗') : null,
    h('div', { className: 'ofm_hero' },
      h('h3', null, 'EAC 实时资源池'),
      pool == null ? h('p', null, pool === undefined ? '正在查询资源池…' : '资源池暂时无法查询，请稍后刷新。')
        : h(React.Fragment, null,
          h(Tank, { pct: reading.pct, level: reading.level, size: 'xl' }),
          h('p', null, `当前并发：${pool.inflight} · 24 小时活跃：${reading.active ?? '未知'} · 容量：${pool.pool ?? '未知'}`),
          h('p', null, capacityText(pool, t)))))
}

let root
export function show(summary) {
  if (!root) root = createRoot(document.getElementById('eac-root'))
  root.render(h(EacPage, { summary }))
}
export function hide() {
  root?.unmount()
  root = undefined
}
