import { ArrowUpRight, PackageCheck, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card } from './components/ui'
import type { Host, Summary } from './types'
import './upgrade.css'

/** Standalone packages are replaced by the user; DSH owns its plugin hot-upgrader. */
export function UpgradePage({ summary, host }: { summary: Summary; host: Host }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const refresh = async () => {
    setBusy(true); setMessage('')
    try { await host.refresh(); setMessage('已刷新当前运行版本。发行版本请在发布页核对。') }
    catch { setMessage('版本信息刷新失败，请确认本地服务仍在运行后重试。') }
    finally { setBusy(false) }
  }
  return <div className="upgrade-page" data-testid="standalone-upgrade-page">
    <header className="dashboard-heading"><div><h1>插件升级</h1><p>查看当前运行版本，按当前运行方式更新 OFM。</p></div><Badge>独立本地服务</Badge></header>
    <Card className="upgrade-version"><div className="upgrade-card-heading"><PackageCheck size={20} /><div><h2>当前运行版本</h2><p>本地服务返回的版本信息</p></div></div>
      <p className="upgrade-version-value">v{summary.version || '未知'}</p>
      <div className="upgrade-actions"><a className="ui-button ui-button-default" href="https://github.com/Ebony-Vinyl/dsh-our-free-model/releases" target="_blank" rel="noopener noreferrer">查看发行版本<ArrowUpRight size={15} /></a><Button variant="outline" busy={busy} onClick={() => void refresh()}><RefreshCw size={14} />刷新版本信息</Button></div>
      <p className="upgrade-feedback" role="status" aria-live="polite">{message}</p>
    </Card>
    <section className="upgrade-guide" aria-labelledby="standalone-upgrade-guide"><h2 id="standalone-upgrade-guide">独立服务如何升级</h2><p>当前独立服务没有应用内安装和热重载接口，请使用与你当前安装方式相同的发行包。</p><ol><li>在发行版本页核对版本与平台，取得需要的安装包。</li><li>停止当前独立服务，保留本机数据目录，按发行包说明更新程序。</li><li>重新启动，再到本页刷新并核对运行版本。</li></ol><p>如果使用 DSH 内的 OFM 插件，可在插件设置的“网关设置”后打开“插件升级”，检查更新、升级和热重载。</p><Button variant="ghost" onClick={() => host.navigate('extensions')}>查看独立账号连接扩展</Button></section>
  </div>
}
