const PAGE_NAMES = new Set(['overview', 'models', 'usage', 'extensions', 'eac', 'settings', 'connection'])
export function normalizePage(page) {
  if (page === 'channels') return 'extensions'
  return PAGE_NAMES.has(page) ? page : 'overview'
}

export function extensionPresentation(status) {
  const state = status?.state ?? 'not-installed'
  const connected = state === 'ready' && status?.installed === true && status?.enabled === true
  const descriptions = {
    'not-installed': ['未安装', 'OFM 基础功能可以继续使用。需要账号模型时，可自愿导入独立扩展。'],
    disabled: ['已停用', '扩展不会接收模型请求。启用扩展后，再到独立管理页选择渠道并登录。'],
    stopped: ['已停止', '账号模型已退出清单，后台任务已停止。你可以重新启用扩展。'],
    installing: ['正在安装', '正在校验和复制本机扩展文件。完成后仍需单独启用。'],
    starting: ['正在启用', '正在启动扩展并等待连接确认，核心功能可以继续使用。'],
    stopping: ['正在停用', '正在取消扩展请求并等待后台资源退出。'],
    incompatible: ['不兼容', '扩展的协议或运行环境不符合当前宿主要求，请选择兼容的版本。'],
    failed: ['扩展故障', '扩展未能正常运行。请查看原因，再重试启用或卸载后重新导入。'],
    conflict: ['实例冲突', '已有其他实例占用账号扩展。请先停止冲突实例，再重试。'],
    ready: connected ? ['已连接', status.modelCount > 0 ? '扩展模型已加入统一 API。账号及登录在独立扩展管理页操作。' : '扩展已连接，暂时没有账号模型。可打开管理页，自行选择渠道并登录。'] : ['连接尚未确认', '宿主状态尚未确认安装和启用，请刷新后重试。'],
  }
  const [label, description] = descriptions[state] ?? ['状态待确认', '宿主返回了未知状态，请刷新或检查扩展版本。']
  const busy = ['installing', 'starting', 'stopping'].includes(state)
  return {
    label: state === 'disabled' && status?.installed && !status?.enabled ? '已安装 · 待启用' : label,
    description, busy, canOpen: connected,
    canEnable: status?.installed === true && !busy && !connected && !['incompatible', 'conflict'].includes(state),
    canDisable: status?.installed === true && (status.enabled === true || ['starting', 'failed', 'conflict'].includes(state)) && state !== 'stopping',
    tone: connected ? 'success' : ['failed', 'incompatible', 'conflict'].includes(state) ? 'warning' : 'neutral',
  }
}
