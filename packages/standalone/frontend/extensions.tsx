import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Package, RefreshCw } from 'lucide-react'
import { Badge, Button, Card, Input } from './components/ui'
import { extensionPresentation } from './extension-data.mjs'
import type { ExtensionAction, Host, Summary } from './types'
import './extensions.css'

export function ExtensionsPage({ summary, host }: { summary: Summary; host: Host }) {
  const status = summary.extensions.accountConnectors
  const view = extensionPresentation(status)
  const [directory, setDirectory] = useState('')
  const [trusted, setTrusted] = useState(false)
  const [operation, setOperation] = useState<ExtensionAction>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [uninstallConfirm, setUninstallConfirm] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const controller = useRef<AbortController | undefined>(undefined)
  const feedback = useRef<HTMLParagraphElement>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort() } }, [])
  const run = async (action: ExtensionAction, body: Record<string, unknown> = {}) => {
    if (busyRef.current) return
    busyRef.current = true
    controller.current = new AbortController()
    setOperation(action); setMessage(''); setError('')
    try {
      await host.manageAccountConnectors(action, body, controller.current.signal)
      if (!mounted.current) return
      setUninstallConfirm(false)
      if (action === 'install') { setTrusted(false); setDirectory('') }
      setMessage(action === 'install' ? '扩展已导入，尚未运行。需要使用时请单独点击启用。' : action === 'uninstall' ? '扩展已卸载，扩展数据已保留。' : action === 'disable' ? '停用操作已完成，请以宿主状态确认资源是否全部退出。' : '启用操作已完成，请以宿主状态确认连接结果。')
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '操作失败，请检查扩展状态后重试。')
    } finally {
      busyRef.current = false
      if (mounted.current) { setOperation(undefined); feedback.current?.focus() }
    }
  }
  const busy = operation !== undefined || view.busy
  return <div className="extensions-page" data-testid="extensions-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">MANAGEMENT / EXTENSIONS</div>
      <h1>账号连接扩展</h1><p>使用产品账号连接更多模型。此扩展单独安装，由你选择是否使用；OFM 基础功能无需安装它。</p></div>
      <Badge tone={view.tone as 'success' | 'warning' | 'neutral'}>{view.label}</Badge>
    </header>
    <Card className="extensions-status-card" aria-busy={busy}>
      <div className="extensions-card-heading"><Package size={20} /><div><h2>OFM 账号连接扩展</h2><p>{view.description}</p></div></div>
      <dl className="extensions-facts">
        <div><dt>来源</dt><dd>用户自行导入的本机扩展目录</dd></div>
        <div><dt>扩展版本</dt><dd>{status.version ?? '尚未安装'}</dd></div>
        <div><dt>协议版本</dt><dd>{status.protocolVersion ?? '需要协议 1'}</dd></div>
        <div><dt>可调用模型</dt><dd>{status.modelCount} 个</dd></div>
      </dl>
      {status.error && <p role="alert" className="extensions-error">{status.error}</p>}
      <div className="extensions-actions">
        {view.canOpen && <a className="ui-button ui-button-default" href="/api/management/extensions/account-connectors/ui/">打开扩展管理 <ArrowUpRight size={15} /></a>}
        {view.canEnable && <Button disabled={busy} busy={operation === 'enable'} onClick={() => void run('enable')}>{status.state === 'failed' ? '重试启用' : '启用扩展'}</Button>}
        {view.canDisable && <Button variant="outline" disabled={operation !== undefined} busy={operation === 'disable'} onClick={() => void run('disable')}>停用扩展</Button>}
        <Button variant="outline" disabled={operation !== undefined} onClick={() => { void host.refresh().catch(host.error) }}><RefreshCw size={14} />刷新状态</Button>
        {status.installed && <Button variant="ghost" disabled={busy} onClick={() => setUninstallConfirm(true)}>卸载扩展</Button>}
      </div>
      {uninstallConfirm && <div className="confirm-panel extensions-uninstall"><h3>卸载账号连接扩展？</h3><p>将先停止扩展，再移除扩展代码。扩展数据会保留，重新安装后可继续使用。</p><div className="extensions-actions"><Button variant="outline" disabled={busy} onClick={() => setUninstallConfirm(false)}>取消</Button><Button className="danger-button" busy={operation === 'uninstall'} disabled={busy} onClick={() => void run('uninstall', { deleteData: false })}>确认卸载并保留数据</Button></div></div>}
      <p ref={feedback} tabIndex={-1} role={error ? 'alert' : 'status'} className={error ? 'extensions-error' : 'extensions-feedback'}>{error || message || (operation ? { install: '正在校验并导入扩展…', enable: '正在等待扩展连接…', disable: '正在停止扩展任务…', uninstall: '正在停止并卸载扩展…' }[operation] : '')}</p>
    </Card>
    <section className="extensions-guide" aria-labelledby="extension-install-title">
      <h2 id="extension-install-title">安装方法</h2>
      <p>配套核心更新会随安装包提供账号扩展，并迁移旧账号数据；手动单独安装时也可导入可信的本机开发目录。启用会运行扩展代码。</p>
      <ol><li>从你信任的来源取得独立扩展，将包含 <code>extension.json</code> 的目录保存在本机。</li><li>填写该目录的完整路径，确认信任来源后导入。宿主会检查协议、路径和文件完整性。</li><li>导入后单独启用扩展，再打开它自己的管理页，选择需要的渠道并登录。</li></ol>
      <form onSubmit={event => { event.preventDefault(); if (directory.trim() && trusted && !busy) void run('install', { path: directory.trim(), trustDevelopment: true }) }}>
        <label htmlFor="extension-directory">本机扩展目录的完整路径</label>
        <Input id="extension-directory" value={directory} onChange={event => setDirectory(event.target.value)} placeholder="例如 D:\ofm-account-connectors" disabled={busy || status.installed} autoComplete="off" spellCheck={false} required aria-describedby="extension-import-help" />
        <p id="extension-import-help">目录中需要包含扩展清单和清单声明的运行文件。导入只安装文件；启用才会执行扩展。</p>
        <label className="extensions-trust"><input type="checkbox" checked={trusted} onChange={event => setTrusted(event.target.checked)} disabled={busy || status.installed} /><span>我已确认该本机开发扩展的来源可信，并选择导入。</span></label>
        <Button type="submit" disabled={busy || status.installed || !trusted || !directory.trim()} busy={operation === 'install'}>导入本机扩展</Button>
        {status.installed && <p>如需更换版本，请先卸载当前扩展；扩展数据默认保留。</p>}
      </form>
    </section>
    <p className="extensions-core-note">EAC 授权、匿名与 Kilo 模型、用量统计、服务设置和 API 接入继续由核心提供。<button className="text-button" onClick={() => host.navigate('eac')}>打开 EAC</button></p>
  </div>
}
