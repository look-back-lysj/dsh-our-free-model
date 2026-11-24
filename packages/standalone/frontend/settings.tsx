import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CircleAlert, Check, LoaderCircle, RotateCcw, Save, Settings2, RefreshCw, ShieldCheck } from 'lucide-react'
import { Badge, Button, Card, Input } from './components/ui'
import { settingsDraft, settingsChanged, syncSettings, validateSettingsDraft } from './settings-data.mjs'
import { visibilityCopy } from './visibility-data.mjs'
import type { Host, Summary } from './types'
import './settings.css'

type Draft = ReturnType<typeof settingsDraft>
type NumberField = 'defaultMaxTokens' | 'probeIntervalMinutes' | 'laneMaxTries'
const connectionError = (reason: unknown) => reason instanceof Error
  ? reason.name === 'TimeoutError' ? '保存请求超时，结果尚未确认。请重试或检查服务状态。'
    : reason instanceof TypeError && /fetch/i.test(reason.message) ? '无法连接本地服务，修改已保留，请确认服务正在运行后重试。'
    : reason.message : '保存失败，修改已保留，请重试。'

export function Settings({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const visibility = visibilityCopy(document.documentElement.lang)
  const [state, setState] = useState(() => ({ saved: summary.settings, draft: settingsDraft(summary.settings) }))
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<NumberField, string>>>({})
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [exitNote, setExitNote] = useState('')
  const [clearingExits, setClearingExits] = useState(false)
  const savingRef = useRef(false)
  const mounted = useRef(true)
  const activeRef = useRef(active)
  const generation = useRef(0)
  activeRef.current = active
  useEffect(() => () => { mounted.current = false; generation.current++ }, [])
  useEffect(() => {
    if (!active) { generation.current++; setMessage(''); setError('') }
  }, [active])
  useEffect(() => {
    setState(previous => syncSettings(previous, summary.settings, savingRef.current))
  }, [summary.settings])
  const dirty = settingsChanged(state.draft, state.saved)
  // Masked labels only — the addresses themselves never reach this page.
  const laneExitLabels: string[] = summary.settings.freeLane?.proxies ?? []
  const clearExits = async () => {
    if (clearingExits || !activeRef.current) return
    setClearingExits(true)
    setExitNote('')
    try {
      const cleared = await host.clearLaneExits()
      if (!mounted.current) return
      setExitNote(`已清除 ${cleared} 个出口的冷却。`)
      try { await host.refresh() } catch { /* 冷却已清，刷新失败不影响结论 */ }
    } catch (reason) {
      if (mounted.current) setExitNote(connectionError(reason))
    } finally {
      if (mounted.current) setClearingExits(false)
    }
  }
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setState(previous => ({ ...previous, draft: { ...previous.draft, [key]: value } }))
    setErrors(previous => ({ ...previous, [key]: undefined }))
    setMessage(''); setError('')
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (savingRef.current || !activeRef.current) return
    const validation = validateSettingsDraft(state.draft)
    setErrors(validation.errors); setMessage(''); setError('')
    if (!validation.patch) return
    const started = ++generation.current
    const feedbackCurrent = () => mounted.current && activeRef.current && started === generation.current
    savingRef.current = true
    setSaving(true)
    try {
      const saved = await host.saveSettings(validation.patch)
      if (!mounted.current) return
      setState({ saved, draft: settingsDraft(saved) })
      if (feedbackCurrent()) setMessage('设置已保存并生效')
      // 保存结果已确认；后续读取失败不能误报为保存失败。
      try { await host.refresh() } catch {
        if (feedbackCurrent()) setMessage('设置已保存；状态刷新失败，稍后会自动重试。')
      }
    } catch (reason) {
      if (feedbackCurrent()) setError(connectionError(reason))
    } finally {
      savingRef.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const toggle = (name: 'enabled' | 'exposeRegionModels' | 'streamRecovery' | 'standaloneProbe' | 'hideFreeModels' | 'hideEacModels', label: string, help: string, disabled = false) =>
    <label className="settings-field" key={name}>
      <span><strong>{label}</strong><small>{help}</small></span>
      <input type="checkbox" role="switch" name={name} className="settings-toggle" disabled={disabled}
        checked={state.draft[name]} onChange={event => update(name, event.target.checked)} />
    </label>
  const numeric = (name: NumberField, label: string, help: string, min: number, max: number) =>
    <div className="settings-field settings-number-field">
      <label htmlFor={`setting-${name}`}><strong>{label}</strong><small>{help}</small></label>
      <div className="settings-number"><Input id={`setting-${name}`} name={name} type="number" min={min} max={max} step={1}
        value={state.draft[name]} onChange={event => update(name, event.target.value)}
        aria-invalid={!!errors[name]} aria-describedby={errors[name] ? `setting-error-${name}` : undefined} />
        {errors[name] ? <p id={`setting-error-${name}`} className="settings-field-error" role="alert"><CircleAlert size={12} />{errors[name]}</p>
          : <span className="settings-hint">{min}–{max}</span>}
      </div>
    </div>
  if (!active) return null
  const statusClass = saving ? 'settings-status-saving' : dirty ? 'settings-status-dirty' : message ? 'settings-status-saved' : ''
  return <div className="settings-browser" data-testid="settings-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">MANAGEMENT / SETTINGS</div>
      <h1>服务设置</h1><p>调整本机推理与模型刷新，保存后生效。</p></div>
      <Badge tone={summary.settings.enabled ? 'success' : 'warning'}>{summary.settings.enabled ? '推理服务已启用' : '推理服务已暂停'}</Badge>
    </header>
    <form onSubmit={event => { void submit(event) }} noValidate>
      <fieldset disabled={saving} className="settings-fieldset">
        <Card className="settings-card"><div className="settings-card-heading"><Settings2 size={16} /><div><h2>推理与模型</h2><p>控制客户端调用与模型展示。</p></div></div>
          {toggle('enabled', '启用推理服务', '关闭后暂停 API 推理，管理页面仍可访问。')}
          {toggle('exposeRegionModels', '显示地区受限模型', '保留受当前出口地区限制的模型供客户端选择。')}
          {toggle('hideFreeModels', visibility.hideFree, '仅从选择器和 API 模型清单隐藏，保留历史模型调用。')}
          {toggle('hideEacModels', visibility.hideEac, '保留授权和历史模型调用，可随时恢复显示。')}
          {toggle('streamRecovery', '自动恢复断流', '允许从已生成的检查点继续回答。')}
          {numeric('defaultMaxTokens', '单次最大输出 Token', '512–131072，实际输出还受模型能力限制。', 512, 131072)}
        </Card>
        <Card className="settings-card"><div className="settings-card-heading"><RefreshCw size={16} /><div><h2>模型刷新</h2><p>管理模型清单的周期更新与探测。</p></div></div>
          {numeric('probeIntervalMinutes', '刷新间隔（分钟）', '1–1440 分钟，保存后重新安排下一轮。', 1, 1440)}
          {toggle('standaloneProbe', '自动探测可用性（已停用）', '自动探测已关闭：周期刷新只更新模型清单，不会发送探测请求。', true)}
          <p className="settings-note" role="note"><CircleAlert size={15} /><span>{summary.automaticRefresh
            ? '自动刷新已启用，保存间隔后会重新安排下一轮。'
            : '当前以 --no-refresh 启动。设置会保存，但自动任务保持暂停；手动刷新仍可用。'}</span></p>
        </Card>
        <Card className="settings-card"><div className="settings-card-heading"><ShieldCheck size={16} /><div><h2>免费车道出口</h2><p>只让 OpenCode 免费车道走这些出口；免费额度按出口 IP 计数。</p></div></div>
          <div className="settings-field">
            <label htmlFor="setting-laneExits"><strong>出口地址（一行一条）</strong><small>http / https / socks5 / socks5h；加 #pool 表示轮换池端点（每次连接换 IP，因此不会被冷却）。</small></label>
            <textarea id="setting-laneExits" name="laneExits" rows={4} className="settings-textarea"
              placeholder={'http://127.0.0.1:7890\nsocks5://127.0.0.1:1080'}
              value={state.draft.laneExits} onChange={event => update('laneExits', event.target.value)} />
            <p className="settings-hint">地址按凭据对待：面板只显示掩码，改动请整段重新粘贴；留空则保持已存列表不变。</p>
          </div>
          {numeric('laneMaxTries', '每回合最多换几个出口', '1–8。只在出口被限流（429）或 IP 被标记滥用（403）时才换。', 1, 8)}
          <div className="settings-field">
            <span><strong>当前出口</strong><small>{laneExitLabels.length === 0 ? '未配置专属出口，回落到全局出口或直连。' : '冷却中的出口会在本回合被跳过。'}</small></span>
            <ul className="settings-exit-list">
              {laneExitLabels.map((label, index) => <li key={`${label}:${index}`}><code>{label}</code></li>)}
            </ul>
          </div>
          <div className="settings-field">
            <span><strong>出口冷却</strong><small>上游解除封禁后，可用这里立即恢复全部出口。</small></span>
            <Button variant="outline" disabled={saving || clearingExits} onClick={() => { void clearExits() }}>
              {clearingExits ? <LoaderCircle size={15} className="spinning" /> : <RotateCcw size={15} />}{clearingExits ? '正在清除' : '清除冷却'}
            </Button>
          </div>
          {exitNote && <p className="settings-hint" role="status">{exitNote}</p>}
        </Card>
        <div className="settings-footer"><span role="status" aria-live="polite" className={statusClass}><span className="settings-status-dot" aria-hidden="true" />{saving ? '正在保存，请稍候…' : dirty ? '有尚未保存的修改' : message || '当前设置已同步'}</span>
          <div className="settings-actions"><Button variant="outline" disabled={!dirty || saving} onClick={() => {
            setState(previous => ({ ...previous, draft: settingsDraft(previous.saved) }))
            setErrors({}); setError(''); setMessage('')
          }}><RotateCcw size={15} />撤销修改</Button>
            <Button type="submit" disabled={!dirty || saving}>{saving ? <LoaderCircle size={15} className="spinning" /> : message && !dirty ? <Check size={15} /> : <Save size={15} />}{saving ? '正在保存' : '保存设置'}</Button></div>
        </div>
      </fieldset>
      {error && <p className="settings-save-error" role="alert"><CircleAlert size={16} /><span>{error}</span></p>}
    </form>
    <p className="footnote">配置保存在当前独立服务的数据目录中。页面读取和保存设置不会直接发送模型推理请求。</p>
  </div>
}
