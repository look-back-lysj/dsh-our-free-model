export type Page = 'overview' | 'models' | 'usage' | 'extensions' | 'eac' | 'settings' | 'connection' | 'upgrade'
export interface AccountConnectorsStatus {
  id: 'ofm.account-connectors'
  state: 'not-installed' | 'disabled' | 'starting' | 'ready' | 'failed' | 'incompatible' | 'stopping' | string
  installed: boolean
  enabled: boolean
  version: string | null
  protocolVersion: number | null
  providerCount: number
  modelCount: number
  managementTarget: string
  error?: string
}
export type ExtensionAction = 'install' | 'enable' | 'disable' | 'uninstall'
export interface Model {
  id: string
  name: string
  channel: string
  routable: boolean
  vision?: boolean
  reasoning?: boolean
  contextWindow?: number
  maxOutput?: number
  availability?: string
  detail?: string
  ttftMs?: number | null
}
export interface ModelTestResult { ok: boolean; text: string; latencyMs: number }
export interface ServiceSettings {
  enabled: boolean
  exposeRegionModels: boolean
  streamRecovery: boolean
  standaloneProbe: boolean
  probeIntervalMinutes: number
  defaultMaxTokens: number
}
export interface Summary {
  version: string
  baseUrl: string
  dataDir: string
  networkMode: string
  automaticRefresh: boolean
  catalogSyncedAt: number
  settings: ServiceSettings
  extensions: { accountConnectors: AccountConnectorsStatus }
  channels?: AccountConnectorsStatus
  eacAuth?: { local?: boolean; authorized?: boolean; login?: string }
  catalog: Model[]
}
export interface Stats {
  requests: number
  requestFailures: number
  requestFailuresEstimated?: boolean
  logicalEstimated?: boolean
  turns: number
  failedTurns: number
  recoveredTurns: number
  days: { day: string; total: number }[]
  grand: { input: number; output: number; reasoning: number }
  models: UsageModel[]
  samples: { model?: string; ok?: boolean; error?: string; at?: number; ms?: number }[]
}
export interface UsageModel {
  model: string
  name: string
  calls: number
  turns: number
  input: number
  output: number
  reasoning: number
  failed: number
  failedTurns: number
  recoveredTurns: number
  avgTtftMs?: number | null
  tps?: number | null
}
export interface Snapshot { summary: Summary; stats: Stats }
export interface Host {
  navigate(page: Page | 'channels'): void
  refresh(): Promise<void>
  manageAccountConnectors(action: ExtensionAction, body?: Record<string, unknown>, signal?: AbortSignal): Promise<AccountConnectorsStatus>
  copy(value: string): Promise<void>
  getApiKey(): Promise<string>
  rotateKey(): Promise<string>
  logout(): Promise<void>
  error(error: Error): void
  testModel(model: string, signal: AbortSignal): Promise<ModelTestResult>
  refreshModels(probe: boolean, signal: AbortSignal): Promise<void>
  saveSettings(settings: ServiceSettings): Promise<ServiceSettings>
}
