/** 宿主工厂失败时保留核心，并保留已退役模型的明确所有权。 */
const RETIRED_ACCOUNT_PROVIDERS = new Set(['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini'])

export function unavailableAccountConnectors(error) {
  const snapshot = {
    state: 'failed', installed: false, enabled: false, providerCount: 0, modelCount: 0,
    error: '账号连接扩展宿主初始化失败，请检查扩展安装或重新启动服务。',
    managementTarget: '/api/management/extensions/account-connectors/ui',
  }
  const reject = async () => { throw Object.assign(new Error(snapshot.error), { statusCode: 503, code: 'EXTENSION_UNAVAILABLE', cause: error }) }
  return {
    state: () => ({ ...snapshot }), publicModelRows: () => [],
    handles: model => typeof model === 'string' && model.includes('/') && RETIRED_ACCOUNT_PROVIDERS.has(model.slice(0, model.indexOf('/'))),
    complete: reject, refresh: async () => [], rpc: reject, enable: reject,
    disable: async () => ({ ...snapshot }), installFromDirectory: reject,
    uninstall: reject, subscribe: () => () => {}, dispose: async () => {},
  }
}

/** 仅暴露扩展公共元信息，避免把宿主内部数据带进管理摘要。 */
export function accountConnectorsStatus(host) {
  const value = host?.state() ?? { state: 'not-installed', installed: false, enabled: false }
  return {
    id: 'ofm.account-connectors',
    state: typeof value.state === 'string' ? value.state : 'failed',
    installed: value.installed === true, enabled: value.enabled === true,
    version: typeof value.version === 'string' ? value.version : null,
    protocolVersion: Number.isInteger(value.protocolVersion) ? value.protocolVersion : null,
    providerCount: Number.isInteger(value.providerCount) ? value.providerCount : 0,
    modelCount: Number.isInteger(value.modelCount) ? value.modelCount : 0,
    managementTarget: '/api/management/extensions/account-connectors/ui',
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  }
}
