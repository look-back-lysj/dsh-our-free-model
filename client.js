/**
 * Our Free Model — browser half.
 *
 * Contributes three things to the web shell:
 *   1. a settings section (`settings.section` id `our-free-model`) holding the
 *      model roster with live availability, the usage dashboard, the OpenAI
 *      forward listener and the plugin's own switches;
 *   2. a first-run announcement (`settings.onboarding`) that is versioned, so
 *      bumping the copy re-announces once and never nags again;
 *   3. nothing else — no shadowing of the stock model picker, whose grouping by
 *      provider route is exactly the mechanism this plugin uses for its tag.
 *
 * Data is read over the plugin's own same-origin `/api/our-free-model/*` routes
 * rather than a typed Remote binding, because those routes are served by the same
 * host process on every kernel line this plugin targets.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. All colour comes from theme variables so
 * the page survives a scheme switch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-our-free-model',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const ReactDOM = require('react-dom')
    const { createElement: h, Fragment, useState, useEffect, useMemo, useRef, useCallback } = React

    const NS = 'settings.ourFreeModel'
    const inject = ['slots', 'locale']

    // ── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        'dash.modelTitle': '模型用量',
        'dash.requests': '请求数',
        'meta.title': 'Our Free Model',
        'meta.description': '在 DeepSeek Harness 内直连免密免费模型：清单随上游更新、地区可用性自动探测、思考强度真实生效，并附 Token 看板与 OpenAI 兼容转发端口。',
        'ann.pitch': '你只需在 dsh 里装上这个插件，无需登录、注册、填 API Key 或任何其它操作，就能用上包括 Muse Spark 1.3、MiMo V2.6 在内的前沿模型——完全免费，不限量。',
        nav: 'Our Free Model',
        title: 'Our Free Model',
        refresh: '刷新清单',
        reprobe: '重新探测可用性',
        probing: '探测中…',
        loading: '正在加载…',
        loadFailed: '无法连接插件后端',
        retry: '重试',
        'state.available': '可用',
        'state.region-blocked': '地区受限',
        'state.unavailable': '暂不可用',
        'state.throttled': '暂不可用',
        'state.unknown': '未探测',
        'state.access-restricted': '使用资格受限',
        'state.listed': '清单已收录',
        'hint.listed': '模型已配置并收录，但清单成功不代表回答已验证。可按需测试一次，调用可能使用对应渠道额度。',
        'hint.access': '上游限制当前客户端使用这个免费渠道。免费标价不代表第三方客户端已获放行，反复重试或重新登录不保证恢复。',
        'hint.region': '该模型按出口地区放行。开启网络代理后，插件会在下一次探测自动把它移入可用分组。',
        'hint.unknown': '尚未探测，默认保持可达。',
        'hint.hidden': '探测显示网关点名了它却不路由它，因此已从模型选择器中移除；某一次探测重新通过，它会自己回来。',
        'hint.sharedBudget': '该模型思考不可关闭：思考与可见回答共用同一份额度，档位越低留给正文的越少。',
        'tag.vision': '视觉',
        'tag.text': '纯文本',
        'tag.thinking': '可调思考',
        'tag.thinkingShared': '思考不可关',
        'tag.rung': '默认档上限',
        'tag.rungTitle': '各档位实际发出的输出上限：{ladder}。档位是思考与回答共用的额度，且不会超过上面的最长输出与设置里的单次上限。',
        'tag.context': '上下文',
        'tag.output': '最长输出',
        'tag.latency': '首字',
        'tag.eacChannel': 'EAC 渠道 · 协付',
        'tag.kiloChannel': 'Kilo 渠道 · 免费池（prompt 可能被上游记录用于改进服务，勿发送敏感内容）',
        'roster.noLane': 'EAC 协付模型在当前运行环境不可用：宿主未提供可识别的桌面 / Web 配置，因此不加载该渠道。',
        'section.models': '模型清单',
        'section.modelsHint': '名称与能力来自上游清单与公开能力表，可用性由本机出口实测得出。',
        'section.dash': '用量看板',
        'section.dashHint': '数据只写入本机，不会上传。',
        'pool.levelOk': '畅通',
        'pool.levelBusy': '繁忙',
        'pool.capacity': '号池容量',
        'pool.levelOver': '过载',
        'pool.reach': '容量占用',
        'pool.formula': 'Star {stars} × 1.5',
        'pool.configured': '按实际配号数',
        'pool.active': '24h 活跃',
        'pool.live': '进行中',
        'pool.unavailable': '号池数据暂不可用 · {reason}',
        'pool.reasonNoLane': '当前运行环境未解锁协付车道',
        'pool.reasonGateway': '网关应答异常',
        'pool.reasonMalformed': '网关数据异常',
        'pool.reasonUnreachable': '网关暂不可达',
        'pool.reasonUnknown': '原因未知',
        'pool.capacityUnknown': 'Star 数据暂不可用',
        'section.eac': 'EAC 渠道授权',
        'section.eacHint': 'EAC（协付）模型需要 GitHub 登录并 star 仓库；免费车道的模型不受影响。',
        'eac.pillOk': '已授权',
        'eac.pillLocked': '未授权',
        'eac.pillRequired': '已开启强制',
        'eac.pillCompat': '兼容期',
        'eac.pillUnknown': '授权策略未确认',
        'eac.pollFailed': '领取授权失败（{reason}），正在自动重试；无需重新授权。',
        'eac.saveFailed': '授权已完成，但本机无法保存登录记录。请检查 DSH_HOME 目录权限；修复后将自动重试。',
        'eac.cancel': '取消此次登录',
        'eac.cancelFailed': '无法确认取消登录，请稍后重试。',
        'eac.pillUnverified': '网关暂不可达',
        'eac.intro': 'EAC 渠道的对话在服务器侧校验授权：用 GitHub 登录，并给 {repo} 点一个 Star，即可解锁。登录在浏览器里完成，无需复制粘贴；取消 Star 后授权会自动失效。',
        'eac.login': '使用 GitHub 登录',
        'eac.starting': '正在打开浏览器…',
        'eac.waiting': '已打开浏览器授权页；若没有自动打开，请手动访问下面的地址完成授权。完成后本页会自动确认。',
        'eac.copy': '复制链接',
        'eac.copied': '已复制',
        'eac.done': '授权成功：@{login}，现在可以使用 EAC 模型了。',
        'eac.needStar': '已用 @{login} 登录，但还没有 star 仓库；请先 Star，再在授权页点「我已 star，重新检查」。',
        'eac.expired': '这次登录等待超时了，请重新发起。',
        'eac.sessionExpired': '登录链接已失效（服务器不再认识它），请重新发起 GitHub 登录。',
        'eac.openManually': '浏览器没有自动打开，请手动访问下面的地址完成授权。',
        'eac.startFailed': '无法发起登录（{reason}）。',
        'eac.loggedIn': '已授权：@{login} · 上次复查 {when}',
        'eac.recheck': '重新检查',
        'eac.logout': '退出登录',
        'eac.noLane': '当前运行环境未解锁 EAC 协付车道，无法进行 GitHub 授权。',
        'eac.lockedTitle': '需要 GitHub 授权并 star 仓库后使用',
        'eac.lockedNote': '未授权：点下方按钮用 GitHub 登录并 star 仓库，或到「EAC 渠道授权」区完成。',
        'section.forward': '本地转发（OpenAI 兼容）',
        'section.forwardHint': '让其它本地工具用一个 base URL 调用这些模型。',
        'section.egress': '出口代理（订阅分流）',
        'section.egressHint': '把推理与探测请求从代理出口发出，缓解按 IP 的频率限制。',
        'egress.enabled': '启用出口',
        'egress.modeSubscription': '订阅模式（本地 mihomo 自动测速分流）',
        'egress.url': '订阅 / 代理 URL',
        'egress.urlNew': '替换订阅地址',
        'egress.urlPlaceholder': '粘贴新的订阅 / 代理地址（留空则保持当前不变）',
        'egress.urlNone': '未设置',
        'egress.urlClear': '清除',
        'egress.urlClearWarn': '清除本机保存的订阅 / 代理地址，并关闭出口',
        'egress.mihomoPath': 'mihomo 路径',
        'egress.mihomoHint': '订阅模式留空则自动查找本机 mihomo（如 Clash Verge）。',
        'egress.apply': '应用',
        'egress.active': '出口生效中',
        'egress.inactive': '未启用',
        'egress.outlet': '当前出口',
        'egress.node': '当前最佳节点',
        'egress.latency': '访问 opencode',
        'egress.measuring': '测量中…',
        'egress.direct': '关闭时请求直连发出；订阅地址按密钥对待——只存在本机设置里，不随常规接口数据下发，仅点「显示」时读取，面板默认打码。',
        'egress.error': '出口启动失败：{message}',
        'section.prefs': '插件设置',
        'section.prefsHint': '改动在下一次加载完全生效。',
        'heat.title': 'Token 热力图',
        'heat.legend': '少',
        'heat.legendMore': '多',
        'heat.empty': '还没有用量记录。用一次对话后回来看看。',
        'curve.title': '总量曲线',
        'curve.tokens': 'Token',
        'curve.requests': '请求数',
        'curve.total': '总计',
        'stat.output': '输出 Token',
        'stat.reasoning': '推理 Token',
        'col.reason': '推理',
        'col.output': '输出',
        'last.title': '最近一回合',
        'last.justNow': '刚刚',
        'last.minAgo': '{n} 分钟前',
        'last.hourAgo': '{n} 小时前',
        'last.dayAgo': '{n} 天前',
        'last.input': '输入',
        'last.originChat': '对话',
        'last.originHarness': '桌面',
        'last.originForward': '转发',
        'last.originBench': '测速',
        'speed.title': '速度',
        'speed.tps': '输出速度',
        'speed.ttft': '首帧延迟',
        'speed.model': '模型',
        'speed.calls': '上游请求',
        'speed.failed': '请求失败',
        'speed.turns': '对话回合',
        'speed.turnFailed': '回合失败',
        'speed.recovered': '已恢复',
        'speed.estimated': '升级前历史按上游请求估算；升级后回合按最终结果精确记录。',
        'speed.scope': '请求、回合和 Token 为累计；速度和首帧按最近 40 次调用计算，热力图按天汇总。',
        'speed.none': '暂无样本',
        'speed.note': '输出速度只统计 {n}/{total} 次可测的调用：那些没流式送出的思考 token 不计入分子，解码窗口短到测不出的也不算。',
        'unit.tokPerSec': 'tok/s',
        'unit.ms': 'ms',
        'forward.enabled': '启用转发端口',
        'forward.host': '监听地址',
        'forward.port': '端口',
        'forward.apply': '应用',
        'settings.failed': '设置未保存',
        'forward.running': '正在监听',
        'forward.stopped': '未启用',
        'forward.baseUrl': 'Base URL',
        'forward.key': 'API Key',
        'forward.show': '显示',
        'forward.hide': '隐藏',
        'forward.rotate': '重新生成',
        'forward.rotateWarn': '重新生成后，所有使用旧 Key 的工具都会失效。',
        'forward.copy': '复制',
        'forward.copied': '已复制',
        'forward.example': '调用示例',
        'forward.error': '启动失败：{message}',
        'forward.notice': '端口提示：{message}',
        'forward.lanTitle': '局域网访问',
        'forward.lanHint': '让同一网络里的其它设备也用这个转发端口。默认关闭；开启后中继需要一把单独的 Key。',
        'forward.lanEnabled': '允许局域网访问',
        'forward.lanPort': '局域网端口',
        'forward.lanAuto': '0 = 自动分配',
        'forward.lanApply': '应用局域网设置',
        'forward.lanRunning': '局域网中继已监听',
        'forward.lanStopped': '局域网中继未启用',
        'forward.lanError': '局域网中继启动失败：{message}',
        'forward.lanKey': '局域网 Key',
        'forward.lanRotateWarn': '重新生成后，局域网里的设备都要换新 Key；本机工具不受影响。',
        'forward.lanWarn': '开启后，能连到这台机器的任何人都可以用这个 Key 花掉本机的免费额度。请只在信任的网络里开启，必要时用防火墙限制来源。',
        'forward.lanUrl': '局域网地址',
        'forward.lanNoAddress': '没有检测到局域网 IPv4 地址',
        'forward.lanAlso': '其它地址：{list}',
        'pref.enabled': '启用免费模型',
        'pref.exposeRegion': '展示地区受限模型',
        'pref.interval': '自动探测间隔（分钟）',
        'pref.maxTokens': '单次输出上限（token）',
        'pref.egress': '当前出口',
        'pref.probedAt': '最近探测',
        'bench.run': '测一次',
        'bench.running': '测量中…',
        'bench.result': '首帧 {ttft}ms · 输出 {tps} tok/s · 推理 {reasoning} tok',
        'ann.preamble': '前言',
        'ann.models': '模型清单',
        'ann.steps': '使用步骤',
        'ann.features': '功能介绍',
        'ann.later': '稍后再说',
        'ann.page': '第 {n} / {total} 页',
        'ann.openSettings': '打开设置页',
        'ann.p1': '免密：安装即可用，不需要注册、不需要填任何 API Key。',
        'ann.p2': '清单跟随上游：模型集合、上下文长度与能力每次刷新都重新拉取。',
        'ann.p3': '诚实的能力声明：探测不出来的能力不会显示，思考强度档位是真实生效的输出预算上限。',
        'ann.s1': '在输入框的模型选择器里选 “Our Free Model” 分组下的任意模型。',
        'ann.s2': '需要更强推理时点开 Effort 档位；它是真实下发的输出预算，不是提示词。',
        'ann.s3': '想被其它本地工具调用：设置页 → 本地转发 → 启用，把 Base URL 和 Key 填进去。',
        'ann.s4': '地区受限模型会在你切换网络出口后自动重新归类，无需手动操作。',
        'ann.f1': '模型清单：可用性、上下文长度、是否支持视觉、是否可调思考。',
        'ann.f2': 'Token 热力图与总量曲线，支持总计与按模型分别查看。',
        'ann.f3': '输出速度（tok/s）与首字延迟（TTFT）逐次采样。',
        'ann.f4': 'OpenAI 兼容转发端口 + 可生成的 API Key。',
        'ann.f5': '全部数据留在本机，不上传任何遥测。',
        'ann.updates': '公告与升级',
        'ann.u1': '公告中心：仓库主人推送的新公告会实时到达，支持图文排版（HTML）。',
        'ann.u2': '系统通知：开启后，新公告与插件更新会弹出系统级通知。',
        'ann.u3': '应用内升级：新版本发布后可直接在设置页升级，无需重新安装。',
        'ann.u4': '热重载：升级与本插件的代码更新即时生效，不需要重启应用。',
        'section.news': '公告中心',
        'section.newsHint': '公告由仓库主人推送，本页实时接收。',
        'section.upgrade': '插件升级',
        'section.upgradeHint': '在应用内直接升级插件，无需重新安装或重启。',
        'news.unread': '{n} 条未读',
        'news.allRead': '全部已读',
        'news.markRead': '标记已读',
        'news.expand': '展开公告',
        'news.collapse': '收起公告',
        'news.refresh': '检查新公告',
        'news.refreshing': '检查中…',
        'news.empty': '暂无公告。仓库主人推送的新公告会出现在这里。',
        'news.emptyHint': '公告内容支持图文排版，由仓库主人在插件仓库中编辑发布。',
        'news.osEnable': '开启系统通知',
        'news.osOn': '系统通知已开启',
        'news.osOff': '系统通知未开启',
        'news.osDenied': '浏览器拒绝了通知权限；需要在系统/浏览器设置里手动恢复。',
        'news.link': '查看详情',
        'news.urgentTitle': '重要公告',
        'news.gotIt': '知道了',
        'news.lastFetch': '最近拉取',
        'news.fetchFailed': '公告源暂不可达（显示的是缓存）',
        'level.info': '通知',
        'level.update': '更新',
        'level.warn': '注意',
        'level.urgent': '紧急',
        'upgrade.current': '运行版本',
        'upgrade.installed': '磁盘版本',
        'upgrade.mismatch': '运行版本与磁盘版本不一致，请先确认安装状态，再重载或重启。',
        'upgrade.recovery': '上次升级未完整恢复。请关闭应用，使用保留的备份恢复安装目录，重新启动后检查更新。',
        'upgrade.backup': '恢复备份',
        'upgrade.latest': '最新版本',
        'upgrade.checkedAt': '上次检查',
        'upgrade.never': '从未检查',
        'upgrade.open': '打开插件升级',
        'upgrade.check': '检查更新',
        'upgrade.star': '去 GitHub 点 Star',
        'upgrade.checking': '检查中…',
        'upgrade.upToDate': '已是最新版本',
        'upgrade.available': '可升级到 {version}',
        'upgrade.apply': '立即升级',
        'upgrade.applying': '升级中…',
        'upgrade.phase.download': '正在下载新版本…',
        'upgrade.phase.install': '正在安装文件…',
        'upgrade.phase.reload': '正在热重载…',
        'upgrade.done': '已升级到 {version}，插件已热重载生效。',
        'upgrade.doneRefresh': '已升级到 {version}。点击刷新页面加载新界面。',
        'upgrade.failed': '升级失败：{message}',
        'upgrade.history': '最近一次升级',
        'upgrade.from': '由 {from} 升级',
        'upgrade.notes': '更新说明',
        'upgrade.auto': '自动检查：每 {n} 小时',
        'upgrade.autoOff': '自动检查已关闭',
        'reload.now': '热重载插件',
        'reload.reloading': '重载中…',
        'reload.done': '插件已热重载（第 {n} 次）。',
        'reload.refresh': '刷新页面',
        'reload.auto': '文件变化自动热重载',
        'toast.annTitle': '新公告',
        'toast.updateTitle': '插件可升级',
        'toast.updateBody': '发现新版本 {latest}（当前 {current}），可到设置页升级。',
        'nav.tab.free': '免费模型',
        'nav.tab.eac': 'EAC 模型',
        'star.cta': '点个 Star',
        'star.title': '在 GitHub 上给本仓库点 Star',
        'free.title': '免费模型',
        'free.sub': '模型清单跟随上游刷新。免费标价、调用资格和实际可用性分别确认，状态由这台机器探测。',
        'free.tankLabel': '免费车道可用度',
        'free.tankNote': '水位 = 当前可用模型占比（{ok}/{total}）',
        'free.tankEmpty': '尚未探测，水位按已声明模型占位。',
        'eac.title': 'EAC 模型',
        'eac.sub': '桌面端协付渠道：GitHub 登录并 star 本仓库后解锁，与免费车道互不影响。',
        'eac.tankLabel': '协付池压力',
        'nav.tab.ledger': '数据看板',
        'nav.tab.logs': '运行日志',
        'nav.tab.gateway': '网关设置',
        'nav.tab.upgrade': '插件升级',
        'dash.title': '数据看板',
        'dash.sub': 'OFM 核心请求与 Token 用量：免费、EAC、Kilo、官方 API 聚合和路由的统一记录。',
        'dash.today': '今日数据',
        'dash.all': '全部历史',
        'dash.refresh': '刷新',
        'dash.kpiToday': '今日消耗 Token',
        'dash.kpiScopeAll': '范围内消耗 Token',
        'dash.kpiCumulative': '累计消耗 Token',
        'dash.kpiSpeed': '平均生成速度',
        'dash.kpiCache': '上下文缓存命中率',
        'dash.kpiRequests': '请求数 & 成功率',
        'dash.input': '输入',
        'dash.output': '输出',
        'dash.reasoning': '思考',
        'dash.ttft': '首字',
        'dash.cacheTokens': '缓存命中',
        'dash.successRate': '成功率',
        'dash.failed': '失败',
        'dash.recentTitle': '总览 · 最近请求',
        'dash.recentHint': '最近的核心调用记录，最新在前。',
        'dash.empty': '暂无数据——通过渠道模型发起一次对话后，这里就会开始记录。',
        'log.time': '时间',
        'log.model': '模型',
        'log.via': '通道',
        'log.result': '结果',
        'log.ok': '成功',
        'log.failed': '失败',
        'log.duration': '耗时',
        'log.ttft': '首字',
        'log.speed': '速度',
        'log.input': '输入',
        'log.output': '输出',
        'log.reasoning': '思考',
        'log.cache': '缓存',
        'log.total': '总 token',
        'logs.title': '运行日志',
        'logs.sub': 'OFM 核心调用的时间、来源、结果和速度；支持刷新、自动更新与分页。',
        'logs.auto': '每 10 秒自动刷新',
        'logs.count': '共 {total} 条 · 本页 {shown} 条',
        'logs.empty': '还没有请求记录。',
        'logs.page': '第 {page} 页 / 共 {pages} 页',
        'logs.windowNote': '展示核心保留的最近 200 条调用样本，最新在前；未测得的数据保留为空。',
        'gw.title': '网关设置',
        'gw.sub': '管理 OFM 本地 OpenAI 兼容转发端口、局域网入口、网络出口和客户端接入配方。',
        'nav.tab.aggregate': '聚合渠道',
        'nav.tab.saver': '省 Token',
        'nav.tab.routing': '路由',
        'agg.title': '聚合渠道',
        'agg.sub': '把第三方 OpenAI 兼容端点接进同一条模型清单：写入本机的 Key 只以指纹回显，保存后清单与模型选择器一起更新。',
        'agg.registryCount': '注册表 {n} 家',
        'agg.configuredCount': '已配置 {n} 家',
        'agg.addProvider': '添加提供商',
        'agg.addTitle': '选择提供商',
        'agg.addHint': '可按分类、协议与认证方式筛选。标了「不可驱动」的提供商需要交互式登录或云侧凭据，本车道不会调用它们。',
        'agg.search': '搜索名称或 ID',
        'agg.filterCategory': '分类',
        'agg.filterFormat': '协议',
        'agg.filterAuth': '认证',
        'agg.filterAll': '全部',
        'agg.showing': '显示 {shown} / {total} 家',
        'agg.noMatch': '没有匹配的提供商。',
        'agg.notUsable': '不可驱动',
        'agg.notUsableWhy': '本车道不会调用它：认证方式是「{kind}」，需要交互式登录或云侧凭据，只能由宿主自己接管。',
        'agg.credential': '获取 Key',
        'agg.modelCount': '{n} 个模型',
        'agg.select': '配置',
        'agg.configuredTitle': '已配置的提供商',
        'agg.configuredHint': '保存后立即生效：清单与模型选择器一起更新。',
        'agg.empty': '还没有接入任何聚合提供商',
        'agg.emptyHint': '这一页把第三方端点接进模型清单：聚合站、免费额度池、本机推理服务都行。填入 Key 与可选的 Base URL，它们的模型就会出现在模型选择器里，也能成为降级链的一环。',
        'agg.filterEmpty': '没有符合筛选条件的已配置提供商。',
        'agg.contributes': '当前贡献 {n} 个模型',
        'agg.contributesNone': '当前未贡献任何模型',
        'agg.hasKey': '已存 Key {hint}',
        'agg.noKey': '未存 Key',
        'agg.enabled': '启用',
        'agg.disabled': '已停用',
        'agg.key': 'API Key',
        'agg.keyPlaceholder': '粘贴新的 API Key（留空则保持不变）',
        'agg.keyKeep': '留空保持当前 Key 不变；要删除请用下面的清除按钮。',
        'agg.keyClear': '清除已保存的 Key',
        'agg.keyClearWarn': '清除后该提供商立即停止贡献模型，直到重新填入 Key。',
        'agg.baseUrl': 'Base URL',
        'agg.baseUrlHint': '留空则使用注册表默认值。',
        'agg.baseUrlDefault': '注册表默认：{url}',
        'agg.baseUrlEnv': '也可用环境变量 {env} 覆盖',
        'agg.models': '模型覆盖',
        'agg.modelsHint': '逗号或换行分隔的模型 ID；留空则用它自己声明的清单。',
        'agg.modelsPlaceholder': 'model-a, model-b',
        'agg.test': '测试',
        'agg.testing': '测试中…',
        'agg.testOk': '验证通过',
        'agg.testFailed': '验证失败',
        'agg.testUnverified': '无法验证',
        'agg.testUnverifiedWhy': '该提供商不提供模型列表接口，验证它要花掉一次真实生成——这里不做。',
        'agg.testAt': '最近测试 {when}',
        'agg.neverTested': '尚未测试',
        'agg.discover': '发现模型',
        'agg.discovering': '发现中…',
        'agg.discovered': '发现 {n} 个模型',
        'agg.discoveredNone': '该提供商不提供模型列表。',
        'agg.discoveredUse': '填入模型覆盖',
        'agg.save': '保存',
        'agg.saving': '保存中…',
        'agg.add': '添加',
        'agg.remove': '移除',
        'agg.removeConfirm': '确认移除',
        'agg.removeWarn': '移除后它贡献的模型立即从清单消失，已保存的 Key 一并删除。',
        'agg.cancel': '取消',
        'agg.saved': '已保存',
        'agg.savedBody': '{name} 的配置已保存。',
        'agg.removedBody': '{name} 已移除。',
        'agg.failed': '操作失败',
        'agg.loadFailed': '无法读取提供商注册表',
        'agg.category.apikey': 'API Key',
        'agg.category.free': '完全免费',
        'agg.category.freeTier': '免费额度',
        'agg.category.local': '本机',
        'agg.category.oauth': 'OAuth',
        'agg.auth.apiKey': 'API Key',
        'agg.auth.none': '免认证',
        'agg.auth.oauth': 'OAuth 登录',
        'agg.auth.adc': '云侧凭据',
        'saver.title': '省 Token',
        'saver.sub': '在请求离开本机之前压缩它：工具输出重编码、提示词瘦身，以及五个不占用上游请求的本地应答。',
        'saver.master': '启用 Token 压缩',
        'saver.masterHint': '关掉后所有压缩立即停止，请求按原样发出；下面的设置保留。',
        'saver.rtk': 'RTK 工具输出压缩',
        'saver.rtkWhat': '压缩的是工具结果：git diff / status / log、grep、find、ls、tree、构建日志、带行号的文件转储，以及重复的日志行。',
        'saver.rtkSafety': '安全边界：报错的工具结果原样保留，小体积内容不碰，替换只在新文本更小且非空时发生——压缩结果永远不会比原文更大。',
        'saver.promptTitle': '提示词压缩',
        'saver.promptHint': '在系统提示里追加一条写作指令。这是唯一能减少输出 Token 的压缩，因为它改变的是模型怎么写。',
        'saver.caveman': 'Caveman',
        'saver.cavemanWhat': '电报体回复：去掉客套与重复解释，只留结论与代码。',
        'saver.ponytail': 'Ponytail',
        'saver.ponytailWhat': 'YAGNI 最小实现：只写被要求的那一件事，不主动加抽象、配置与兜底。',
        'saver.voiceWarn': '注意：这两族会改变助手的说话方式，并且会留在你的对话记录里。默认关闭。',
        'saver.localTitle': '本地应答',
        'saver.localHint': '这五类请求的答案就在请求体里，转发出去只是白花一次上游额度与一个来回。',
        'saver.local.enabled': '启用本地应答',
        'saver.local.quota': '额度探测',
        'saver.local.quotaHint': '回答「额度检查」这类探针，返回一句固定答复。',
        'saver.local.prefix': '命令前缀',
        'saver.local.prefixHint': '回答权限提示要的命令前缀，从 shell 命令里解析。',
        'saver.local.title': '会话标题',
        'saver.local.titleHint': '回答标题生成请求，返回固定标题。',
        'saver.local.suggestion': '建议模式',
        'saver.local.suggestionHint': '回答建议模式的空转回合，不产生上游请求。',
        'saver.local.filepath': '文件路径提取',
        'saver.local.filepathHint': '从命令与输出里解析出文件路径，返回结构化结果。',
        'saver.dashTitle': '节省统计',
        'saver.dashHint': '按字节统计本机实际发生的压缩，只写入本机。',
        'saver.bytesBefore': '压缩前',
        'saver.bytesAfter': '压缩后',
        'saver.bytesSaved': '节省字节',
        'saver.percent': '节省比例',
        'saver.blocks': '压缩块数',
        'saver.calls': '统计调用',
        'saver.promptCalls': '提示词注入',
        'saver.noData': '还没有可统计的请求。发起一次对话后，这里显示的是真实压缩字节数，不是估算。',
        'saver.report': '统计口径',
        'saver.saved': '已保存',
        'saver.savedBody': 'Token 压缩设置已保存。',
        'saver.failed': '保存失败',
        'saver.loadFailed': '无法读取 Token 压缩设置',
        'saver.level.off': '关闭',
        'saver.level.lite': '轻',
        'saver.level.full': '全',
        'saver.level.ultra': '极',
        'saver.level.wenyanLite': '文言·轻',
        'saver.level.wenyan': '文言',
        'saver.level.wenyanUltra': '文言·极',
        'routing.title': '路由',
        'routing.sub': '把若干模型串成一条降级链：链上第一个失败就换下一个，对调用方始终只有一个模型 ID。',
        'routing.chains': '已存链路',
        'routing.chainsHint': '链路按输入顺序保存；引用当前不可用模型的链路会原样保留，车道恢复后自己回来。',
        'routing.empty': '还没有降级链',
        'routing.emptyHint': '一条链就是一个虚拟模型：在模型选择器里选它，请求按顺序尝试链上的每个真实模型。用来兜住某个车道临时不可用的时段。',
        'routing.newChain': '新建链路',
        'routing.name': '名称',
        'routing.namePlaceholder': '例如：先免费后协付',
        'routing.strategy': '策略',
        'routing.strategy.fallback': '顺序降级',
        'routing.strategy.roundRobin': '轮询',
        'routing.stickyLimit': '轮询粘滞次数',
        'routing.stickyHint': '轮询时同一个模型连续用多少次再换下一个。',
        'routing.members': '成员（按顺序）',
        'routing.addMember': '添加成员',
        'routing.memberEmpty': '还没有成员——点「添加成员」从清单里挑一个。',
        'routing.moveUp': '上移',
        'routing.moveDown': '下移',
        'routing.removeMember': '移除',
        'routing.pickModel': '选择模型',
        'routing.searchModel': '搜索模型 ID 或名称',
        'routing.noModel': '没有匹配的模型。',
        'routing.usable': '可用',
        'routing.notUsable': '当前不可用',
        'routing.missing': '不在清单中的成员：{ids}',
        'routing.notUsableWhy': '链路原样保存，不会因为某条车道今天关闭而被改写；这些 ID 回到清单里它就自己恢复。如果是拼写错误，编辑链路改正即可。',
        'routing.resolved': '解析为',
        'routing.memberCount': '{n} 个成员',
        'routing.save': '保存链路',
        'routing.saved': '已保存',
        'routing.savedBody': '链路已保存。',
        'routing.failed': '保存失败',
        'routing.loadFailed': '无法读取链路设置',
        'routing.cancel': '取消',
        'routing.edit': '编辑',
        'routing.delete': '删除',
        'routing.deleteConfirm': '确认删除',
        'routing.deleteWarn': '删除后这个模型 ID 立即从清单消失，正在引用它的客户端会拿到 404。',
        'routing.enabled': '启用',
        'routing.channel.free': '免费车道',
        'routing.channel.eac': 'EAC 协付',
        'routing.channel.kilo': 'Kilo',
        'routing.channel.aggregate': '聚合',
        'routing.channel.combo': '链路',
        'gw.clientsTitle': '接入客户端',
        'gw.clientsHint': '使用 OFM 当前实际运行的地址和端口生成，扩展已连接时其公开模型也可通过此入口调用。',
        'gw.clientsOff': '转发端口未启用',
        'gw.clientsOffHint': '先到「免费模型」页的「本地转发」打开端口，这里才会给出可用的地址与配方。',
        'gw.clientsModels': '可转发模型 {n} 个',
        'nav.tab.extensions': '账号连接扩展',
        'ext.title': '账号连接扩展',
        'ext.sub': '单独安装、自主启用，通过独立插件管理产品账号；OFM 的免费模型、EAC 和官方 API 功能照常使用。',
        'ext.cardTitle': 'OFM 账号连接扩展',
        'ext.optional': '可选扩展',
        'ext.state.notinstalled': '未安装',
        'ext.state.installed': '已安装 · 待启用',
        'ext.state.disabled': '已停用',
        'ext.state.ready': '已连接',
        'ext.state.failed': '连接故障',
        'ext.state.incompatible': '版本不兼容',
        'ext.state.conflict': '实例或模型冲突',
        'ext.hint.notinstalled': '尚未检测到独立扩展。需要账号连接时再安装，OFM 基础功能无需等待。',
        'ext.hint.installed': '扩展已安装，尚未启用。请在独立插件管理页确认启用，再自行选择渠道。',
        'ext.hint.disabled': '扩展已停用，账号模型不可调用。可在独立插件管理页重新启用。',
        'ext.hint.ready': '协作协议已通过检测，公开模型目录可供 OFM 的本地 API 使用；账号设置由独立插件管理。',
        'ext.hint.failed': '无法连接扩展。请检查独立插件的运行状态与日志，然后刷新检测；OFM 核心仍可使用。',
        'ext.hint.incompatible': '扩展的版本或协作协议不符合要求。请核对双方版本后再连接，不会强行加载。',
        'ext.hint.conflict': '检测到旧账号模块、重复实例或同名模型冲突。请先在宿主管理器处理冲突，再刷新检测。',
        'ext.package': '包名',
        'ext.version': '检测到的版本',
        'ext.versionUnknown': '尚未检测到',
        'ext.protocol': '协作协议',
        'ext.models': '扩展渠道 {providers} · 可用模型 {models}',
        'ext.noModels': '暂无账号模型，请到独立插件选择渠道并登录',
        'ext.installMethod': '查看安装方法',
        'ext.refresh': '刷新检测',
        'ext.checking': '正在检测…',
        'ext.detected': '已刷新扩展状态与公开模型目录。',
        'ext.refreshFailed': '检测未完成，请稍后重试或检查独立插件；核心功能不受影响。',
        'ext.manage': '打开独立插件管理',
        'ext.managementUnavailable': '检测到已安装扩展并确认管理入口后可用',
        'ext.manageHint': '独立插件也可从宿主设置中的“账号连接扩展”入口打开。',
        'ext.installTitle': '安装与启用',
        'ext.unpublished': '当前为本地开发阶段，扩展尚未正式发行，没有可用的市场下载地址。请使用来源明确的本地开发包，核对发布者、版本和协作协议。',
        'ext.installStep1': '在 DeepSeek Harness 的插件管理器中按宿主支持的方式导入可信的本地扩展包，包名为 dsh-ofm-account-connectors。',
        'ext.installStep2': '确认安装与兼容信息后，在独立插件内明确启用。账号渠道由你逐个选择，不自动导入原账号或登录。',
        'ext.installStep3': '返回这里刷新检测。显示已连接后，打开独立插件管理账号；OFM 只接收公开模型资料与推理结果。',
        'ext.installRestart': '若宿主提示需要重启，请按提示重启后再次检测。此页面提供指引，不执行下载命令或安装脚本。',
        'ext.privacy': '登录、凭据、备份、启停和卸载均由独立插件与宿主管理器处理。核心页面不转交账号凭据。',
        'ext.providersTitle': '了解支持的渠道',
        'ext.providers': '扩展设计覆盖 CodeArts、CodeBuddy、WorkBuddy、LobsterAI、Qoder、Qoder 中国版、TRAE、Cline、Loomy、Raccoon、MiniMax Code、ZCode、Gemini。实际可用渠道与模型以已安装扩展的检测结果为准。',
        'coreLog.aborted': '已取消',
        'coreLog.truncated': '流被截断',
        'coreLog.noUsage': '上游未报告用量',
        'dash.modelHint': '按实际调用模型汇总，保留失败调用与测得的速度。',
        'dash.note': '本页读取 OFM 核心统计。物理请求包含路由重试；扩展账号的独立用量与备份请到扩展管理页查看。',
      },
      en: {
        'dash.modelTitle': 'Model usage',
        'dash.requests': 'Requests',
        'meta.title': 'Our Free Model',
        'meta.description': 'Free no-key models inside DeepSeek Harness: a roster that follows upstream, live regional availability, genuinely enforced thinking levels, a token dashboard and an OpenAI-compatible local forward port.',
        'ann.pitch': 'All you do is install this plugin in dsh — no login, no sign-up, no API key, no other step of any kind. The frontier models are simply there, Muse Spark 1.3 and MiMo V2.6 among them. Completely free, with no usage cap.',
        nav: 'Our Free Model',
        title: 'Our Free Model',
        refresh: 'Refresh roster',
        reprobe: 'Re-probe availability',
        probing: 'Probing…',
        loading: 'Loading…',
        loadFailed: 'Cannot reach the plugin backend',
        retry: 'Retry',
        'state.available': 'Available',
        'state.region-blocked': 'Region-limited',
        'state.unavailable': 'Unavailable',
        'state.throttled': 'Temporarily unavailable',
        'state.unknown': 'Not probed',
        'state.access-restricted': 'Client access restricted',
        'state.listed': 'Listed',
        'hint.listed': 'This configured model is listed, but generation has not been verified. You can test it once; the request may use upstream quota.',
        'hint.access': 'The upstream restricts this free lane to eligible clients. A free price does not grant client access; retrying or signing in again may not change this restriction.',
        'hint.region': 'This model is gated by egress country. Once a proxy changes your egress, the next probe moves it into the available group by itself.',
        'hint.unknown': 'Not probed yet, so it stays reachable.',
        'hint.hidden': 'The gateway names it but refuses to route it, so it is out of the model picker. It returns by itself as soon as a probe gets through.',
        'hint.sharedBudget': 'Thinking cannot be switched off on this model, so thinking and the visible answer share one ceiling — a lower rung leaves the answer less room.',
        'tag.vision': 'Vision',
        'tag.text': 'Text only',
        'tag.thinking': 'Tunable thinking',
        'tag.thinkingShared': 'Thinking always on',
        'tag.rung': 'Default ceiling',
        'tag.rungTitle': 'What each rung actually sends: {ladder}. A rung is one ceiling shared by thinking and the answer, and it never exceeds the max output above or the per-call ceiling in settings.',
        'tag.context': 'Context',
        'tag.output': 'Max output',
        'tag.latency': 'First token',
        'tag.eacChannel': 'EAC lane · co-paid',
        'tag.kiloChannel': 'Kilo channel · free pool (prompts may be logged by the upstream provider — never send sensitive content)',
        'roster.noLane': 'The co-paid EAC models are unavailable in this composition: the host did not present a recognized desktop or web profile, so the lane is not loaded.',
        'section.models': 'Model roster',
        'section.modelsHint': 'Names and capacities come from the upstream roster and published capability tables; availability is measured from this machine.',
        'section.dash': 'Usage dashboard',
        'section.dashHint': 'Written to this machine only; nothing is uploaded.',
        'section.forward': 'Local forward (OpenAI compatible)',
        'section.forwardHint': 'Let other local tools reach these models through one base URL.',
        'section.egress': 'Egress outlet (subscription routing)',
        'section.egressHint': 'Send inference and probe traffic through a proxy outlet to ease per-IP rate limits.',
        'egress.enabled': 'Enable outlet',
        'egress.modeSubscription': 'Subscription mode (local mihomo picks the fastest node)',
        'egress.url': 'Subscription / proxy URL',
        'egress.urlNew': 'Replace the address',
        'egress.urlPlaceholder': 'Paste a new subscription / proxy URL (leave empty to keep the current one)',
        'egress.urlNone': 'not set',
        'egress.urlClear': 'Clear',
        'egress.urlClearWarn': 'Clear the stored subscription / proxy address and turn the outlet off',
        'egress.mihomoPath': 'mihomo path',
        'egress.mihomoHint': 'Leave empty in subscription mode to auto-locate a local mihomo (e.g. Clash Verge).',
        'egress.apply': 'Apply',
        'egress.active': 'Outlet active',
        'egress.inactive': 'Not enabled',
        'egress.outlet': 'Current outlet',
        'egress.node': 'Best node',
        'egress.latency': 'opencode access',
        'egress.measuring': 'measuring…',
        'egress.direct': 'While off, requests go direct; the address is treated as a credential — kept in this machine\'s settings only, never sent down with the regular API payloads, readable only through the reveal button, masked here by default.',
        'egress.error': 'The outlet failed to start: {message}',
        'section.prefs': 'Plugin settings',
        'section.prefsHint': 'Changes take full effect on the next load.',
        'pool.levelOk': 'Healthy',
        'pool.levelBusy': 'Busy',
        'pool.capacity': 'Pool capacity',
        'pool.levelOver': 'Overloaded',
        'pool.reach': 'Capacity in use',
        'pool.formula': '{stars} stars × 1.5',
        'pool.configured': 'configured count',
        'pool.active': '24h active',
        'pool.live': 'in flight',
        'pool.unavailable': 'Pool data unavailable · {reason}',
        'pool.reasonNoLane': 'no co-paid lane in this composition',
        'pool.reasonGateway': 'gateway answered an error',
        'pool.reasonMalformed': 'gateway data malformed',
        'pool.reasonUnreachable': 'gateway unreachable',
        'pool.reasonUnknown': 'unknown cause',
        'pool.capacityUnknown': 'star data unavailable',
        'section.eac': 'EAC lane authorization',
        'section.eacHint': 'EAC (co-paid) models need a GitHub login and a star; the free lane is unaffected.',
        'eac.pillOk': 'authorized',
        'eac.pillLocked': 'not authorized',
        'eac.pillRequired': 'enforced',
        'eac.pillCompat': 'grace period',
        'eac.pillUnknown': 'authorization policy unverified',
        'eac.pollFailed': 'Could not collect authorization ({reason}); retrying automatically. No new sign-in is needed.',
        'eac.saveFailed': 'Authorization completed, but this machine could not save it. Check DSH_HOME permissions; collection will retry automatically.',
        'eac.cancel': 'Cancel this sign-in',
        'eac.cancelFailed': 'Could not confirm cancellation. Please try again.',
        'eac.pillUnverified': 'gateway unreachable',
        'eac.intro': 'EAC turns are checked server-side: sign in with GitHub and star {repo} to unlock them. The browser does the work — nothing to paste — and removing the star revokes access automatically.',
        'eac.login': 'Sign in with GitHub',
        'eac.starting': 'Opening the browser…',
        'eac.waiting': 'The authorization page is open; if the browser did not come up, visit the address below to finish. This page confirms automatically.',
        'eac.copy': 'Copy link',
        'eac.copied': 'Copied',
        'eac.done': 'Authorized as @{login} — EAC models are unlocked.',
        'eac.needStar': 'Signed in as @{login}, but the repository is not starred yet. Star it, then press "I starred it — check again" on the authorization page.',
        'eac.expired': 'This login attempt timed out; please start again.',
        'eac.sessionExpired': 'The login link is no longer valid (the server does not know it) — please start the GitHub login again.',
        'eac.openManually': 'The browser did not open automatically — visit the address below to finish.',
        'eac.startFailed': 'Could not start the login ({reason}).',
        'eac.loggedIn': 'Authorized: @{login} · last checked {when}',
        'eac.recheck': 'Check again',
        'eac.logout': 'Sign out',
        'eac.noLane': 'The EAC co-paid lane is not unlocked in this composition, so GitHub authorization is unavailable.',
        'eac.lockedTitle': 'Needs GitHub authorization and a star',
        'eac.lockedNote': 'Not authorized: sign in with GitHub and star the repository with the button below, or from the EAC authorization section.',
        'heat.title': 'Token heatmap',
        'heat.legend': 'Less',
        'heat.legendMore': 'More',
        'heat.empty': 'No usage yet. Have one conversation and come back.',
        'curve.title': 'Cumulative tokens',
        'curve.tokens': 'Tokens',
        'curve.requests': 'Requests',
        'curve.total': 'Total',
        'stat.output': 'Output tokens',
        'stat.reasoning': 'Reasoning tokens',
        'col.reason': 'reason',
        'col.output': 'output',
        'last.title': 'Last turn',
        'last.justNow': 'just now',
        'last.minAgo': '{n} min ago',
        'last.hourAgo': '{n} h ago',
        'last.dayAgo': '{n} d ago',
        'last.input': 'input',
        'last.originChat': 'chat',
        'last.originHarness': 'desktop',
        'last.originForward': 'forward',
        'last.originBench': 'bench',
        'speed.title': 'Speed',
        'speed.tps': 'Output speed',
        'speed.ttft': 'First frame',
        'speed.model': 'Model',
        'speed.calls': 'Upstream requests',
        'speed.failed': 'Request failures',
        'speed.turns': 'Conversation turns',
        'speed.turnFailed': 'Turn failures',
        'speed.recovered': 'Recovered',
        'speed.estimated': 'Pre-upgrade history is estimated from upstream requests; turns are exact after upgrade.',
        'speed.scope': 'Requests, turns and tokens are lifetime totals; speed and first frame use the last 40 calls, the heatmap is daily.',
        'speed.none': 'No samples yet',
        'speed.note': 'Output speed covers the {n}/{total} calls it could measure: tokens never streamed out are left out of the numerator, and windows too short to time are dropped.',
        'unit.tokPerSec': 'tok/s',
        'unit.ms': 'ms',
        'forward.enabled': 'Enable the forward port',
        'forward.host': 'Bind address',
        'forward.port': 'Port',
        'forward.apply': 'Apply',
        'settings.failed': 'Settings not saved',
        'forward.running': 'Listening',
        'forward.stopped': 'Off',
        'forward.baseUrl': 'Base URL',
        'forward.key': 'API key',
        'forward.show': 'Show',
        'forward.hide': 'Hide',
        'forward.rotate': 'Regenerate',
        'forward.rotateWarn': 'Regenerating invalidates the old key for every tool using it.',
        'forward.copy': 'Copy',
        'forward.copied': 'Copied',
        'forward.example': 'Example',
        'forward.error': 'Could not start: {message}',
        'forward.notice': 'Port notice: {message}',
        'forward.lanTitle': 'Network access',
        'forward.lanHint': 'Let other devices on the same network use this forward port too. Off by default; the relay demands a key of its own.',
        'forward.lanEnabled': 'Allow network access',
        'forward.lanPort': 'Network port',
        'forward.lanAuto': '0 = pick one automatically',
        'forward.lanApply': 'Apply network settings',
        'forward.lanRunning': 'Network relay listening',
        'forward.lanStopped': 'Network relay off',
        'forward.lanError': 'Could not start the network relay: {message}',
        'forward.lanKey': 'Network key',
        'forward.lanRotateWarn': 'Regenerating makes every device on the network switch keys; tools on this machine are unaffected.',
        'forward.lanWarn': 'While this is on, anyone who can reach this machine can spend its free quota with that key. Enable it only on a network you trust, and narrow the sources with a firewall if you can.',
        'forward.lanUrl': 'Network URL',
        'forward.lanNoAddress': 'No network IPv4 address was detected',
        'forward.lanAlso': 'Also reachable at {list}',
        'pref.enabled': 'Enable free models',
        'pref.exposeRegion': 'Show region-limited models',
        'pref.interval': 'Auto-probe interval (minutes)',
        'pref.maxTokens': 'Output ceiling per call (tokens)',
        'pref.egress': 'Current egress',
        'pref.probedAt': 'Last probe',
        'bench.run': 'Run once',
        'bench.running': 'Measuring…',
        'bench.result': 'first frame {ttft}ms · {tps} tok/s · {reasoning} reasoning tokens',
        'ann.preamble': 'Preamble',
        'ann.models': 'Model roster',
        'ann.steps': 'How to use',
        'ann.features': 'What it does',
        'ann.later': 'Later',
        'ann.page': 'Page {n} of {total}',
        'ann.openSettings': 'Open settings',
        'ann.p1': 'No credentials: install and use it — no sign-up, no API key to paste.',
        'ann.p2': 'The roster follows upstream: models, context lengths and capabilities are re-fetched on every refresh.',
        'ann.p3': 'Honest capability claims: anything a probe cannot confirm stays hidden, and each effort level is a real output budget.',
        'ann.s1': 'Pick any model under the “Our Free Model” group in the composer’s model selector.',
        'ann.s2': 'For harder reasoning, open the Effort menu — it sends a real budget, not a prompt hint.',
        'ann.s3': 'To serve other local tools: Settings → Local forward → enable, then copy the base URL and key.',
        'ann.s4': 'Region-limited models reclassify themselves once your network egress changes.',
        'ann.f1': 'Model roster: availability, context length, vision, tunable thinking.',
        'ann.f2': 'Token heatmap and cumulative curve, per total or per model.',
        'ann.f3': 'Per-call samples of output speed (tok/s) and time to first token.',
        'ann.f4': 'OpenAI-compatible forward port with a generated API key.',
        'ann.f5': 'Everything stays on this machine — no telemetry.',
        'ann.updates': 'News & upgrades',
        'ann.u1': 'Announcement center: pushes from the repository owner arrive live, with rich (HTML) layout.',
        'ann.u2': 'OS notifications: once enabled, new announcements and plugin updates raise system-level toasts.',
        'ann.u3': 'In-app upgrades: install new releases straight from the settings page, no reinstall needed.',
        'ann.u4': 'Hot reload: upgrades and code changes take effect immediately, without restarting the app.',
        'section.news': 'Announcement center',
        'section.newsHint': 'Published by the repository owner; this page receives them live.',
        'section.upgrade': 'Plugin upgrade',
        'section.upgradeHint': 'Upgrade in-app — no reinstall, no restart.',
        'news.unread': '{n} unread',
        'news.allRead': 'Mark all read',
        'news.markRead': 'Mark read',
        'news.expand': 'Show announcements',
        'news.collapse': 'Hide announcements',
        'news.refresh': 'Check for new announcements',
        'news.refreshing': 'Checking…',
        'news.empty': 'No announcements yet. Anything the owner pushes will appear here.',
        'news.emptyHint': 'Announcements support rich layout and are published by editing the plugin repository.',
        'news.osEnable': 'Enable OS notifications',
        'news.osOn': 'OS notifications on',
        'news.osOff': 'OS notifications off',
        'news.osDenied': 'Notification permission was denied; restore it in your system or browser settings.',
        'news.link': 'Read more',
        'news.urgentTitle': 'Important announcement',
        'news.gotIt': 'Got it',
        'news.lastFetch': 'Last fetch',
        'news.fetchFailed': 'Feed unreachable right now (showing the cached copy)',
        'level.info': 'Notice',
        'level.update': 'Update',
        'level.warn': 'Heads-up',
        'level.urgent': 'Urgent',
        'upgrade.current': 'Running',
        'upgrade.installed': 'On disk',
        'upgrade.mismatch': 'The running and on-disk versions differ. Check the installation before reloading or restarting.',
        'upgrade.recovery': 'The last upgrade was not fully restored. Close the app, restore the installation from the retained backup, restart, then check for updates.',
        'upgrade.backup': 'Recovery backup',
        'upgrade.latest': 'Latest',
        'upgrade.checkedAt': 'Last check',
        'upgrade.never': 'never',
        'upgrade.open': 'Open plugin upgrade',
        'upgrade.check': 'Check for updates',
        'upgrade.star': 'Star on GitHub',
        'upgrade.checking': 'Checking…',
        'upgrade.upToDate': 'Up to date',
        'upgrade.available': 'Upgrade to {version} available',
        'upgrade.apply': 'Upgrade now',
        'upgrade.applying': 'Upgrading…',
        'upgrade.phase.download': 'Downloading the new version…',
        'upgrade.phase.install': 'Installing files…',
        'upgrade.phase.reload': 'Hot-reloading…',
        'upgrade.done': 'Upgraded to {version}; the plugin hot-reloaded into place.',
        'upgrade.doneRefresh': 'Upgraded to {version}. Reload the page to load the new UI.',
        'upgrade.failed': 'Upgrade failed: {message}',
        'upgrade.history': 'Last upgrade',
        'upgrade.from': 'from {from}',
        'upgrade.notes': 'Release notes',
        'upgrade.auto': 'Auto-check: every {n} h',
        'upgrade.autoOff': 'Auto-check off',
        'reload.now': 'Hot-reload plugin',
        'reload.reloading': 'Reloading…',
        'reload.done': 'Plugin hot-reloaded (#{n}).',
        'reload.refresh': 'Reload page',
        'reload.auto': 'Hot-reload on file change',
        'toast.annTitle': 'New announcement',
        'toast.updateTitle': 'Plugin update available',
        'toast.updateBody': 'Version {latest} is out (installed {current}). Upgrade from the settings page.',
        'nav.tab.free': 'Free models',
        'nav.tab.eac': 'EAC models',
        'star.cta': 'Star',
        'star.title': 'Star this repository on GitHub',
        'free.title': 'Free models',
        'free.sub': 'The roster follows upstream. Free pricing, client eligibility, and successful calls are checked separately from this machine.',
        'free.tankLabel': 'Free-lane availability',
        'free.tankNote': 'Water level = share of reachable models ({ok}/{total})',
        'free.tankEmpty': 'Not probed yet; the level stands at the declared roster.',
        'eac.title': 'EAC models',
        'eac.sub': 'The desktop co-paid lane: unlocked by a GitHub login plus a star, independent of the free lane.',
        'eac.tankLabel': 'Co-paid pool pressure',
        'nav.tab.ledger': 'Dashboard',
        'nav.tab.logs': 'Request log',
        'nav.tab.gateway': 'Gateway',
        'nav.tab.upgrade': 'Plugin upgrade',
        'dash.title': 'Usage dashboard',
        'dash.sub': 'OFM core requests and token usage across free models, EAC, Kilo, official API aggregation and routing.',
        'dash.today': 'Today',
        'dash.all': 'All time',
        'dash.refresh': 'Refresh',
        'dash.kpiToday': 'Tokens today',
        'dash.kpiScopeAll': 'Tokens in scope',
        'dash.kpiCumulative': 'Tokens all time',
        'dash.kpiSpeed': 'Average speed',
        'dash.kpiCache': 'Context cache hit rate',
        'dash.kpiRequests': 'Requests & success rate',
        'dash.input': 'Input',
        'dash.output': 'Output',
        'dash.reasoning': 'Reasoning',
        'dash.ttft': 'TTFT',
        'dash.cacheTokens': 'Cache hits',
        'dash.successRate': 'Success',
        'dash.failed': 'Failed',
        'dash.recentTitle': 'Overview · Recent requests',
        'dash.recentHint': 'Recent core calls, newest first.',
        'dash.empty': 'Nothing yet — one conversation through a channel model starts the record.',
        'log.time': 'Time',
        'log.model': 'Model',
        'log.via': 'Via',
        'log.result': 'Result',
        'log.ok': 'OK',
        'log.failed': 'Failed',
        'log.duration': 'Duration',
        'log.ttft': 'TTFT',
        'log.speed': 'Speed',
        'log.input': 'Input',
        'log.output': 'Output',
        'log.reasoning': 'Reasoning',
        'log.cache': 'Cache',
        'log.total': 'Total tok',
        'logs.title': 'Request log',
        'logs.sub': 'Time, origin, outcome and speed of OFM core calls, with refresh, automatic updates and pagination.',
        'logs.auto': 'Refresh every 10 s',
        'logs.count': '{total} entries · {shown} on this page',
        'logs.empty': 'No requests recorded yet.',
        'logs.page': 'Page {page} of {pages}',
        'logs.windowNote': 'Shows the latest 200 retained core call samples, newest first. Unmeasured fields remain empty.',
        'gw.title': 'Gateway settings',
        'gw.sub': 'Manage OFM local OpenAI-compatible forward port, LAN access, network egress and client connection recipes.',
        'nav.tab.aggregate': 'Aggregate',
        'nav.tab.saver': 'Token savers',
        'nav.tab.routing': 'Routing',
        'agg.title': 'Aggregate providers',
        'agg.sub': 'Bring third-party OpenAI-compatible endpoints into the same model roster: a key written here is echoed back as a fingerprint only, and saving updates the roster and the model picker together.',
        'agg.registryCount': '{n} in the registry',
        'agg.configuredCount': '{n} configured',
        'agg.addProvider': 'Add provider',
        'agg.addTitle': 'Choose a provider',
        'agg.addHint': 'Filter by category, wire format and auth kind. A provider marked "not drivable" needs an interactive login or cloud credentials, and this lane never calls it.',
        'agg.search': 'Search name or id',
        'agg.filterCategory': 'Category',
        'agg.filterFormat': 'Format',
        'agg.filterAuth': 'Auth',
        'agg.filterAll': 'All',
        'agg.showing': 'Showing {shown} of {total}',
        'agg.noMatch': 'No provider matches.',
        'agg.notUsable': 'Not drivable',
        'agg.notUsableWhy': 'This lane never calls it: its auth kind is "{kind}", which needs an interactive login or cloud-side credentials, so only the host can take it over.',
        'agg.credential': 'Get a key',
        'agg.modelCount': '{n} models',
        'agg.select': 'Configure',
        'agg.configuredTitle': 'Configured providers',
        'agg.configuredHint': 'Changes take effect immediately: saving updates the roster and the model picker together.',
        'agg.empty': 'No aggregate provider is connected yet',
        'agg.emptyHint': 'This page brings third-party endpoints into the model roster: an aggregator, a free-tier pool, a local inference server. Fill in a key and an optional base URL and their models appear in the model picker — and can become a link in a fallback chain.',
        'agg.filterEmpty': 'No configured provider matches the filter.',
        'agg.contributes': 'Contributes {n} models',
        'agg.contributesNone': 'Contributes no model right now',
        'agg.hasKey': 'Key {hint}',
        'agg.noKey': 'No key stored',
        'agg.enabled': 'Enabled',
        'agg.disabled': 'Disabled',
        'agg.key': 'API key',
        'agg.keyPlaceholder': 'Paste a new API key (leave empty to keep the current one)',
        'agg.keyKeep': 'Empty keeps the stored key; use the clear button below to delete it.',
        'agg.keyClear': 'Clear the stored key',
        'agg.keyClearWarn': 'Clearing it stops this provider from contributing models until a key is entered again.',
        'agg.baseUrl': 'Base URL',
        'agg.baseUrlHint': 'Empty uses the registry default.',
        'agg.baseUrlDefault': 'Registry default: {url}',
        'agg.baseUrlEnv': 'Can also be overridden by the {env} environment variable',
        'agg.models': 'Model override',
        'agg.modelsHint': 'Model ids separated by commas or newlines; empty uses the list the provider declares.',
        'agg.modelsPlaceholder': 'model-a, model-b',
        'agg.test': 'Test',
        'agg.testing': 'Testing…',
        'agg.testOk': 'Verified',
        'agg.testFailed': 'Failed',
        'agg.testUnverified': 'Not verifiable',
        'agg.testUnverifiedWhy': 'This provider declares no model listing, so verifying it would cost one real generation — not done here.',
        'agg.testAt': 'Last test {when}',
        'agg.neverTested': 'Not tested yet',
        'agg.discover': 'Discover models',
        'agg.discovering': 'Discovering…',
        'agg.discovered': 'Found {n} models',
        'agg.discoveredNone': 'This provider declares no model listing.',
        'agg.discoveredUse': 'Use these as the override',
        'agg.save': 'Save',
        'agg.saving': 'Saving…',
        'agg.add': 'Add',
        'agg.remove': 'Remove',
        'agg.removeConfirm': 'Confirm removal',
        'agg.removeWarn': 'Removing it drops its models from the roster immediately and deletes the stored key.',
        'agg.cancel': 'Cancel',
        'agg.saved': 'Saved',
        'agg.savedBody': 'The configuration for {name} is saved.',
        'agg.removedBody': '{name} was removed.',
        'agg.failed': 'Action failed',
        'agg.loadFailed': 'Cannot read the provider registry',
        'agg.category.apikey': 'API key',
        'agg.category.free': 'Fully free',
        'agg.category.freeTier': 'Free tier',
        'agg.category.local': 'Local',
        'agg.category.oauth': 'OAuth',
        'agg.auth.apiKey': 'API key',
        'agg.auth.none': 'No auth',
        'agg.auth.oauth': 'OAuth login',
        'agg.auth.adc': 'Cloud credentials',
        'saver.title': 'Token savers',
        'saver.sub': 'Compact a request before it leaves this machine: tool output re-encoded, the prompt slimmed, and five answers produced locally without an upstream call.',
        'saver.master': 'Enable token compaction',
        'saver.masterHint': 'Turning this off stops every saver at once and sends requests as written; the settings below are kept.',
        'saver.rtk': 'RTK tool-output compaction',
        'saver.rtkWhat': 'What it compacts: tool results — git diff / status / log, grep, find, ls, tree, build logs, numbered file dumps and duplicate log lines.',
        'saver.rtkSafety': 'Safety rules: an error result is left untouched, small bodies are not touched, and a blob is replaced only when the new text is non-empty and strictly smaller — a compacted result is never larger than the original.',
        'saver.promptTitle': 'Prompt shaping',
        'saver.promptHint': 'Appends a writing instruction to the system prompt. It is the only saver that can cut output tokens, because it changes what the model writes.',
        'saver.caveman': 'Caveman',
        'saver.cavemanWhat': 'Terse replies: pleasantries and repeated explanation dropped, conclusions and code kept.',
        'saver.ponytail': 'Ponytail',
        'saver.ponytailWhat': 'YAGNI-minimal replies: only the one thing that was asked for, no unrequested abstraction, config or fallback.',
        'saver.voiceWarn': 'Heads-up: both families change how the assistant talks, and that lands in your transcript. Off by default.',
        'saver.localTitle': 'Local answers',
        'saver.localHint': 'The answer to these five requests is already in the request body; forwarding one spends a round trip and upstream quota on a question with one right answer.',
        'saver.local.enabled': 'Enable local answers',
        'saver.local.quota': 'Quota probe',
        'saver.local.quotaHint': 'Answers a "quota check" probe with a fixed line.',
        'saver.local.prefix': 'Command prefix',
        'saver.local.prefixHint': 'Answers the command prefix behind a permission prompt, parsed from the shell command.',
        'saver.local.title': 'Session title',
        'saver.local.titleHint': 'Answers a title-generation request with a fixed title.',
        'saver.local.suggestion': 'Suggestion mode',
        'saver.local.suggestionHint': 'Answers a suggestion-mode turn without producing an upstream request.',
        'saver.local.filepath': 'Filepath extraction',
        'saver.local.filepathHint': 'Parses the file paths out of a command and its output, and returns them structured.',
        'saver.dashTitle': 'Savings',
        'saver.dashHint': 'Bytes actually compacted on this machine, written locally only.',
        'saver.bytesBefore': 'Before',
        'saver.bytesAfter': 'After',
        'saver.bytesSaved': 'Bytes saved',
        'saver.percent': 'Saved',
        'saver.blocks': 'Blocks compacted',
        'saver.calls': 'Calls measured',
        'saver.promptCalls': 'Prompts shaped',
        'saver.noData': 'No request measured yet. One conversation later, this shows real compacted bytes rather than an estimate.',
        'saver.report': 'Reported as',
        'saver.saved': 'Saved',
        'saver.savedBody': 'The token-saver settings are saved.',
        'saver.failed': 'Not saved',
        'saver.loadFailed': 'Cannot read the token-saver settings',
        'saver.level.off': 'Off',
        'saver.level.lite': 'Lite',
        'saver.level.full': 'Full',
        'saver.level.ultra': 'Ultra',
        'saver.level.wenyanLite': 'Classical · lite',
        'saver.level.wenyan': 'Classical',
        'saver.level.wenyanUltra': 'Classical · ultra',
        'routing.title': 'Routing',
        'routing.sub': 'Chain several models into one fallback chain: when a link refuses, the next one answers, and the caller still sees a single model id.',
        'routing.chains': 'Stored chains',
        'routing.chainsHint': 'Chains are stored in the order you entered them; a chain that references a model which is unavailable right now is kept as written and comes back by itself when the lane does.',
        'routing.empty': 'No fallback chain yet',
        'routing.emptyHint': 'A chain is a virtual model: pick it in the model picker and the request tries each real model on the chain in order. Use one to cover the hours when a lane is down.',
        'routing.newChain': 'New chain',
        'routing.name': 'Name',
        'routing.namePlaceholder': 'e.g. free first, co-paid second',
        'routing.strategy': 'Strategy',
        'routing.strategy.fallback': 'Fallback',
        'routing.strategy.roundRobin': 'Round-robin',
        'routing.stickyLimit': 'Round-robin sticky limit',
        'routing.stickyHint': 'How many calls in a row one model serves before the rotation moves on.',
        'routing.members': 'Members (in order)',
        'routing.addMember': 'Add member',
        'routing.memberEmpty': 'No member yet — press "Add member" to pick one from the roster.',
        'routing.moveUp': 'Move up',
        'routing.moveDown': 'Move down',
        'routing.removeMember': 'Remove',
        'routing.pickModel': 'Pick a model',
        'routing.searchModel': 'Search model id or name',
        'routing.noModel': 'No model matches.',
        'routing.usable': 'Usable',
        'routing.notUsable': 'Not usable now',
        'routing.missing': 'Members not in the roster: {ids}',
        'routing.notUsableWhy': 'The chain is stored as written and is never rewritten because a lane is closed today; it comes back by itself once those ids are in the roster again. If an id is a typo, edit the chain and fix it.',
        'routing.resolved': 'Resolves to',
        'routing.memberCount': '{n} members',
        'routing.save': 'Save chain',
        'routing.saved': 'Saved',
        'routing.savedBody': 'The chain is saved.',
        'routing.failed': 'Not saved',
        'routing.loadFailed': 'Cannot read the chain settings',
        'routing.cancel': 'Cancel',
        'routing.edit': 'Edit',
        'routing.delete': 'Delete',
        'routing.deleteConfirm': 'Confirm delete',
        'routing.deleteWarn': 'Deleting it drops this model id from the roster immediately; a client still pointing at it gets a 404.',
        'routing.enabled': 'Enabled',
        'routing.channel.free': 'Free lane',
        'routing.channel.eac': 'EAC co-paid',
        'routing.channel.kilo': 'Kilo',
        'routing.channel.aggregate': 'Aggregate',
        'routing.channel.combo': 'Chain',
        'gw.clientsTitle': 'Connect a client',
        'gw.clientsHint': 'Generated from the actual running OFM address and port. Public models from a connected extension can also be called here.',
        'gw.clientsOff': 'The forward port is off',
        'gw.clientsOffHint': 'Enable it under "Local forward" on the Free models page first; only then does this section have a usable address and recipes.',
        'gw.clientsModels': '{n} servable models',
        'nav.tab.extensions': 'Account extension',
        'ext.title': 'Account connectors',
        'ext.sub': 'Install and enable it separately to manage product accounts in its own plugin. OFM free models, EAC and official APIs remain available.',
        'ext.cardTitle': 'OFM account connectors',
        'ext.optional': 'Optional extension',
        'ext.state.notinstalled': 'Not installed',
        'ext.state.installed': 'Installed · awaiting enable',
        'ext.state.disabled': 'Disabled',
        'ext.state.ready': 'Connected',
        'ext.state.failed': 'Connection failed',
        'ext.state.incompatible': 'Incompatible version',
        'ext.state.conflict': 'Instance or model conflict',
        'ext.hint.notinstalled': 'No independent extension was detected. Install it when you need account connections; OFM core features are ready to use.',
        'ext.hint.installed': 'The extension is installed and awaits enable. Open its management page to enable it and choose providers.',
        'ext.hint.disabled': 'The extension is disabled and its account models cannot be called. Re-enable it in its own management page.',
        'ext.hint.ready': 'The collaboration handshake passed. Its public model catalog can serve OFM local API requests; account settings stay in the independent plugin.',
        'ext.hint.failed': 'The extension could not be reached. Check its status and logs, then refresh detection. OFM core remains usable.',
        'ext.hint.incompatible': 'The extension version or collaboration protocol is incompatible. Check both versions before connecting; it will not be forced to load.',
        'ext.hint.conflict': 'A legacy account module, duplicate instance or model name conflicts with this extension. Resolve it in the host manager, then refresh detection.',
        'ext.package': 'Package',
        'ext.version': 'Detected version',
        'ext.versionUnknown': 'Not detected',
        'ext.protocol': 'Protocol',
        'ext.models': 'Extension providers {providers} · Available models {models}',
        'ext.noModels': 'No account models yet; choose a provider and sign in inside the independent plugin',
        'ext.installMethod': 'View installation steps',
        'ext.refresh': 'Refresh detection',
        'ext.checking': 'Checking…',
        'ext.detected': 'Extension status and its public model catalog have been refreshed.',
        'ext.refreshFailed': 'Detection could not finish. Retry or check the independent plugin; core features remain available.',
        'ext.manage': 'Open extension management',
        'ext.managementUnavailable': 'Available after an installed extension and its management entry are verified',
        'ext.manageHint': 'The independent plugin is also available from Account connectors in the host settings.',
        'ext.installTitle': 'Installation and enable',
        'ext.unpublished': 'The extension is in local development and has not been published. There is no marketplace download address. Use a local development package with a known source and verify its publisher, version and protocol.',
        'ext.installStep1': 'Use the DeepSeek Harness plugin manager and its supported import method to load a trusted local package named dsh-ofm-account-connectors.',
        'ext.installStep2': 'Review installation and compatibility details, then explicitly enable the independent plugin. Choose providers individually; existing accounts are not imported or signed in automatically.',
        'ext.installStep3': 'Return here and refresh detection. Once connected, open the independent plugin to manage accounts. OFM receives only public model information and inference results.',
        'ext.installRestart': 'If the host requires a restart, follow its instructions and detect again. This page provides guidance and does not run download commands or install scripts.',
        'ext.privacy': 'Sign-in, credentials, backups, enable, disable and uninstall are managed by the independent plugin and host manager. This core page does not relay account credentials.',
        'ext.providersTitle': 'Supported providers',
        'ext.providers': 'The extension design covers CodeArts, CodeBuddy, WorkBuddy, LobsterAI, Qoder, Qoder China, TRAE, Cline, Loomy, Raccoon, MiniMax Code, ZCode and Gemini. Actual providers and models depend on the installed extension.',
        'coreLog.aborted': 'Cancelled',
        'coreLog.truncated': 'Stream truncated',
        'coreLog.noUsage': 'Upstream usage not reported',
        'dash.modelHint': 'Grouped by the actual called model, including failures and measured speed.',
        'dash.note': 'This page reads OFM core statistics. Physical requests include routing retries. View account-specific extension usage and backups in extension management.',
      },
    }

    // ── styles ────────────────────────────────────────────────────────────────
    // Two theme variables are not defined by every shell — measured in the web
    // shell this plugin ships against, `--dsw-alias-state-warning-primary` and
    // `--dsw-alias-label-on-accent` resolve to nothing. A declaration whose
    // var() is invalid at computed-value time is dropped *whole*, so without a
    // fallback every warning-coloured surface disappears: the pool tank's water
    // (level "busy") rendered as an empty box, the region-limited badge lost its
    // colour, callouts lost their border. Every use of those two names carries a
    // fallback for exactly that reason.
    const CSS = `
/* ═══════════════════════════════════════════════════════════════════════
   Our Free Model — visual system
   统一令牌：所有色值取自宿主 --dsw-alias-* 变量，昼夜由宿主切换。
   层级约定：layer-3 凹槽/页面底 · layer-2 面板 · layer-1 浮起元素。
   动效约定：transform/opacity 优先；常规 150–300ms、覆盖层 300–400ms。
   ═══════════════════════════════════════════════════════════════════════ */
.ofm_root{--ease-instrument:cubic-bezier(.16,1,.3,1);--ease-settle:cubic-bezier(.34,1.4,.4,1);--gap:14px;display:flex;flex-direction:column;gap:calc(var(--gap)*1.4);max-width:1080px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}
.ofm_root::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.022;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E")}
.ofm_root>*{position:relative;z-index:1}
.ofm_root *{box-sizing:border-box}
.ofm_root ::-webkit-scrollbar{width:10px;height:10px}
.ofm_root ::-webkit-scrollbar-track{background:transparent}
.ofm_root ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 32%,transparent);border-radius:99px;border:2.5px solid transparent;background-clip:padding-box}
.ofm_root ::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 52%,transparent);background-clip:padding-box;border:2.5px solid transparent}
.ofm_root{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 32%,transparent) transparent}

.ofm_root ::selection{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent)}
/* ── 键盘可达性：只给键盘聚焦画聚焦环，鼠标点击不出现 ─────────────────── */
.ofm_root :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,transparent);outline-offset:2px;box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent)}
/* ══ 页头 hero ═════════════════════════════════════════════════════════ */
.ofm_hero{position:relative;display:flex;flex-direction:column;gap:14px;padding:22px 24px;border-radius:20px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 88%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent));overflow:hidden}
.ofm_hero::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 150% at 12% -20%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent),transparent 58%),radial-gradient(90% 120% at 88% 130%,color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent),transparent 60%)}
.ofm_hero>*{position:relative}
.ofm_pagehead{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.ofm_pagetitle{display:flex;flex-direction:column;gap:6px;min-width:0}
.ofm_pagetitle h2{margin:0;font-size:23px;font-weight:760;letter-spacing:-.6px;line-height:1.2;background:linear-gradient(120deg,var(--dsw-alias-label-primary) 20%,color-mix(in srgb,var(--dsw-alias-label-primary) 55%,var(--dsw-alias-state-business-primary)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ofm_pagesub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:70ch}
.ofm_pagehead .ofm_pills{margin-left:auto}
.ofm_pills{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.ofm_pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;transition:border-color .16s ease,color .16s ease}
.ofm_pill.strong{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ofm_dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
@keyframes ofm-dot-breathe{0%,100%{opacity:1}50%{opacity:.55}}
.ofm_dot.ok{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);animation:ofm-dot-breathe 2.6s ease-in-out infinite}
.ofm_dot.warn{background:var(--dsw-alias-state-warning-primary,#f0a441);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 18%,transparent)}
.ofm_dot.err{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}
/* ══ 区块与分节 ════════════════════════════════════════════════════════ */
.ofm_sec{display:flex;flex-direction:column;gap:10px}
.ofm_sechead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ofm_sec_title{font-size:14px;font-weight:680;letter-spacing:-.2px}
.ofm_sec_hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.ofm_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(252px,1fr));gap:10px}
/* ══ 卡片（双层 bezel：hairline 边框 + 顶部内高光 + 柔和外阴影） ═══════ */
.ofm_card{position:relative;display:flex;flex-direction:column;gap:8px;padding:12px 13px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 80%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 1px 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent),0 3px 10px color-mix(in srgb,var(--dsw-alias-state-business-primary) 4%,transparent);transition:transform .2s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,border-color .18s ease}
.ofm_card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 66%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 9%),0 16px 34px color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.ofm_card.dim{opacity:.68}
.ofm_cardhead{display:flex;align-items:center;gap:8px}
.ofm_cardname{font-size:13.5px;font-weight:650;letter-spacing:-.1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_badge{margin-left:auto;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);white-space:nowrap}
.ofm_badge.available{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.ofm_badge.access-restricted,.ofm_badge.region-blocked{color:var(--dsw-alias-state-warning-primary,#f0a441);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 10%,transparent)}
.ofm_badge.throttled,.ofm_badge.unavailable{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.ofm_badge.unknown{color:var(--dsw-alias-label-tertiary)}
.ofm_id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_tags{display:flex;gap:5px;flex-wrap:wrap}
.ofm_tag{font-size:10.5px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.ofm_chantag{font-size:10px;font-weight:650;padding:2px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent);color:var(--dsw-alias-state-business-primary);white-space:nowrap}
.ofm_metrics{display:flex;gap:12px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.ofm_metrics b{color:var(--dsw-alias-label-secondary);font-weight:600;font-variant-numeric:tabular-nums}
.ofm_note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
/* ══ 面板 ══════════════════════════════════════════════════════════════ */
.ofm_panel{padding:16px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 2px 6px rgb(0 0 0 / 4%);display:flex;flex-direction:column;gap:12px}
.ofm_paneltitle{font-size:12px;font-weight:680;letter-spacing:.2px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}
.ofm_paneltitle .ofm_sec_hint{font-weight:400;letter-spacing:0}
.ofm_row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
/* ══ 请求热度图 ════════════════════════════════════════════════════════ */
.ofm_heat{display:grid;grid-auto-flow:column;grid-auto-columns:12px;grid-template-rows:repeat(7,12px);justify-content:start;gap:2px;overflow-x:auto;padding:2px 0 6px}
.ofm_cell{width:12px;height:12px;border-radius:3.5px;background:var(--dsw-alias-bg-layer-1);outline:1px solid var(--dsw-alias-border-l1);outline-offset:-1px;transition:transform .14s ease,background .3s ease}
.ofm_cell:hover{transform:scale(1.25)}
.ofm_cell.l1{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent);outline-color:transparent}
.ofm_cell.l2{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);outline-color:transparent}
.ofm_cell.l3{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 68%,transparent);outline-color:transparent}
.ofm_cell.l4{background:var(--dsw-alias-state-business-primary);outline-color:transparent}
.ofm_scale{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.ofm_scale .ofm_cell{width:10px;height:10px}
/* ══ 分段选择器 ════════════════════════════════════════════════════════ */
.ofm_seg{display:inline-flex;padding:3px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);gap:2px;box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%)}
.ofm_seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;font-weight:550;padding:3px 11px;border-radius:8px;cursor:pointer;transition:color .16s ease,background .16s ease,box-shadow .16s ease}
.ofm_seg button:hover{color:var(--dsw-alias-label-primary)}
.ofm_seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px rgb(0 0 0 / 12%),inset 0 1px 0 rgb(255 255 255 / 6%)}
.ofm_svg{display:block;width:100%;height:auto;overflow:visible}
/* ══ 筛选 chips ════════════════════════════════════════════════════════ */
.ofm_chips{display:flex;gap:6px;flex-wrap:wrap}
.ofm_chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);cursor:pointer;color:var(--dsw-alias-label-secondary);transition:border-color .16s ease,color .16s ease,background .16s ease}
.ofm_chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ofm_chip[aria-pressed="true"]{border-color:color-mix(in srgb,currentColor 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent)}
.ofm_swatch{width:8px;height:8px;border-radius:3px;flex:none}
/* ══ 数据表格 ══════════════════════════════════════════════════════════ */
.ofm_table{width:100%;min-width:760px;border-collapse:collapse;font-size:11.5px}
.ofm_tablewrap{overflow-x:auto;max-width:100%}
.ofm_table th{text-align:left;font-weight:560;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);padding:0 10px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.ofm_table td{padding:7px 10px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 62%,transparent);font-variant-numeric:tabular-nums}
.ofm_table td:first-child{font-weight:600}
.ofm_table tbody tr{transition:background .15s ease}
.ofm_table tbody tr:hover td{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 5%,transparent)}
.ofm_table tr:last-child td{border-bottom:0}
.ofm_num{text-align:right}
/* ══ 按钮（分层状态） ══════════════════════════════════════════════════ */
a.ofm_btn{display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
.ofm_btn{font:inherit;font-size:12px;font-weight:580;padding:6px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 84%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 6%);color:var(--dsw-alias-label-primary);cursor:pointer;transition:transform .18s var(--ease-instrument),border-color .2s var(--ease-instrument),background .2s var(--ease-instrument),box-shadow .22s var(--ease-instrument),opacity .16s ease}
.ofm_btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,var(--dsw-alias-bg-layer-3));transform:translateY(-1px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 3px 8px rgb(0 0 0 / 9%)}
.ofm_btn:active:not(:disabled){transform:scale(.985);transition-duration:.1s;box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%)}
.ofm_btn:disabled{opacity:.45;cursor:default;box-shadow:none;transform:none}
.ofm_btn.primary{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,#fff),var(--dsw-alias-state-business-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 82%,#000);color:var(--dsw-alias-label-on-accent,#fff);box-shadow:inset 0 1px 0 rgb(255 255 255 / 18%),0 2px 8px color-mix(in srgb,var(--dsw-alias-state-business-primary) 32%,transparent)}
.ofm_btn.primary:hover:not(:disabled){background:linear-gradient(180deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,#000));border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 1px 0 rgb(255 255 255 / 20%),0 4px 14px color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,transparent)}
.ofm_btn.ghost{background:transparent;box-shadow:none;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.ofm_btn.ghost:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,transparent);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.ofm_minibtn{font:inherit;font-size:11px;font-weight:540;padding:3px 9px;border-radius:8px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 85%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 70%,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:transform .12s ease,border-color .16s ease,color .16s ease,background .16s ease,opacity .16s ease}
.ofm_minibtn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 60%,transparent);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent);transform:translateY(-1px)}
.ofm_minibtn:active:not(:disabled){transform:scale(.96)}
.ofm_minibtn:disabled{opacity:.45;cursor:default;transform:none}
.ofm_minibtn.danger:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent);color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
/* ══ 表单 ══════════════════════════════════════════════════════════════ */
.ofm_field{display:flex;flex-direction:column;gap:4px;min-width:120px}
.ofm_field>span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ofm_input{font:inherit;font-size:12px;padding:6px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%);color:var(--dsw-alias-label-primary);min-width:0;width:100%;transition:border-color .16s ease,box-shadow .16s ease}
.ofm_input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ofm_input:hover{border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 60%,var(--dsw-alias-label-tertiary))}
.ofm_input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}
/* ══ 开关（spring 滑块） ═══════════════════════════════════════════════ */
.ofm_switch{display:inline-flex;align-items:center;gap:9px;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent}
.ofm_switch i{width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);box-shadow:inset 0 1px 3px rgb(0 0 0 / 8%);position:relative;transition:background .2s ease,border-color .2s ease,box-shadow .2s ease;flex:none}
.ofm_switch:hover i{filter:brightness(1.05)}
.ofm_switch[aria-checked="true"]:hover i{filter:brightness(1.08)}
.ofm_switch i::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);box-shadow:0 1px 3px rgb(0 0 0 / 22%);transition:transform .26s cubic-bezier(.34,1.3,.64,1),background .2s ease,width .16s ease}
.ofm_switch:active i::after{width:17px}
.ofm_switch[aria-checked="true"] i{background:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,#000);box-shadow:inset 0 1px 3px rgb(0 0 0 / 12%)}
.ofm_switch[aria-checked="true"] i::after{transform:translateX(16px);background:#fff}
.ofm_switch[aria-checked="true"]:active i::after{transform:translateX(13px)}
.ofm_switch:focus-visible i{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
.ofm_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;padding:7px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow-x:auto;white-space:pre;color:var(--dsw-alias-label-secondary)}
/* ══ 提示条 ════════════════════════════════════════════════════════════ */
.ofm_callout{display:flex;gap:9px;padding:10px 12px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 9%,transparent);font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.ofm_error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
/* ══ 小组件统计 ════════════════════════════════════════════════════════ */
.ofm_stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px}
.ofm_stat{padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 78%,transparent);border:1px solid var(--dsw-alias-border-l1);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%)}
.ofm_stat b{display:block;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.3px}
.ofm_stat span{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
/* ══ 公告（首次引导） ══════════════════════════════════════════════════ */
    /* The onboarding slot is mounted inside the shell, but Announcement portals its
       scrim into document.body so third-party sidebar stacking contexts cannot trap
       the fixed overlay. Mask colour, blur and z-index mirror the Modal layer of the
       shell so this reads as first-party. */
.ofm_scrim{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 32%));backdrop-filter:var(--dsw-mask-blur, blur(8px)) saturate(140%);-webkit-backdrop-filter:var(--dsw-mask-blur, blur(8px)) saturate(140%);animation:ofm-fadein .24s ease}
@keyframes ofm-fadein{from{opacity:0}to{opacity:1}}
.ofm_ann{width:min(620px,92vw);max-height:min(86vh,640px);border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 94%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 28px 80px rgb(0 0 0 / 40%);overflow:hidden;display:flex;flex-direction:column;animation:ofm-popin .36s cubic-bezier(.16,1,.3,1)}
@keyframes ofm-popin{from{opacity:0;transform:translateY(16px) scale(.965)}to{opacity:1;transform:none}}
.ofm_annhead{padding:18px 22px 12px;display:flex;flex-direction:column;gap:8px;background:linear-gradient(150deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent),transparent 75%)}
.ofm_anntitle{margin:0;font-size:18px;font-weight:730;letter-spacing:-.4px}
.ofm_annsub{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ofm_steps{display:flex;gap:6px;padding:0 22px 14px}
.ofm_step{height:3px;flex:1;border-radius:99px;background:var(--dsw-alias-border-l2);transition:background .3s ease}
.ofm_step[data-on="true"]{background:var(--dsw-alias-state-business-primary);box-shadow:0 0 6px color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent)}
.ofm_annbody{padding:2px 22px 18px;max-height:min(48vh,420px);overflow:auto;display:flex;flex-direction:column;gap:12px}
.ofm_annbody h3{margin:0;font-size:13.5px;font-weight:660}
.ofm_annbody p,.ofm_annbody li{font-size:12.5px;line-height:1.72;color:var(--dsw-alias-label-secondary);margin:0}
.ofm_annbody ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px}
.ofm_annfoot{display:flex;align-items:center;gap:10px;padding:13px 22px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent)}
.ofm_annfoot .spacer{margin-left:auto}
.ofm_kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.ofm_kvc{padding:9px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 74%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);display:flex;flex-direction:column;gap:3px}
.ofm_kvc b{font-size:12.5px;font-variant-numeric:tabular-nums}
.ofm_kvc span{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ofm_two{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:12px}
/* ══ 公告中心 ══════════════════════════════════════════════════════════ */
.ofm_news{display:flex;flex-direction:column;gap:10px}
.ofm_newsitem{display:flex;flex-direction:column;gap:7px;padding:13px 15px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 80%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);position:relative;transition:border-color .18s ease,transform .2s cubic-bezier(.32,.72,0,1),box-shadow .22s ease}
.ofm_newsitem:hover{transform:translateY(-1px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 8px 22px rgb(0 0 0 / 10%)}
.ofm_newsitem.unread{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent)}
.ofm_newsdot{position:absolute;top:14px;right:14px;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.ofm_newshead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-right:16px}
.ofm_newstitle{font-size:13px;font-weight:650;letter-spacing:-.1px}
.ofm_level{font-size:10.5px;font-weight:600;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ofm_level.info{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent)}
.ofm_level.update{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}
.ofm_level.warn{color:var(--dsw-alias-state-warning-primary,#f0a441);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 9%,transparent)}
.ofm_level.urgent{color:#fff;background:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,#000)}
.ofm_newsmeta{display:flex;gap:10px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.ofm_newsbody{font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ofm_newsbody p{margin:0 0 6px}
.ofm_newsbody p:last-child{margin-bottom:0}
.ofm_newsbody h1,.ofm_newsbody h2,.ofm_newsbody h3,.ofm_newsbody h4{margin:6px 0 4px;font-size:13px;line-height:1.4}
.ofm_newsbody ul,.ofm_newsbody ol{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px}
.ofm_newsbody code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 5px}
.ofm_newsbody pre{margin:4px 0;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow-x:auto}
.ofm_newsbody pre code{background:transparent;border:0;padding:0}
.ofm_newsbody blockquote{margin:4px 0;padding:2px 10px;border-left:3px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);color:var(--dsw-alias-label-tertiary)}
.ofm_newsbody img{max-width:100%;border-radius:8px}
.ofm_newsbody a{color:var(--dsw-alias-state-business-primary);text-decoration:none}
.ofm_newsbody a:hover{text-decoration:underline}
.ofm_newsbody table{border-collapse:collapse;font-size:12px}
.ofm_newsbody th,.ofm_newsbody td{border:1px solid var(--dsw-alias-border-l1);padding:3px 8px}
.ofm_newsbody hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:8px 0}
.ofm_newsbody mark{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 30%,transparent);border-radius:2px;padding:0 2px}
.ofm_upgradecards{display:flex;gap:8px;flex-wrap:wrap}
.ofm_upnotes{max-height:220px;overflow:auto;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
/* ══ 进度条 ════════════════════════════════════════════════════════════ */
.ofm_prog{height:4px;border-radius:99px;background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 1px 2px rgb(0 0 0 / 6%);overflow:hidden}
.ofm_prog i{display:block;height:100%;width:40%;border-radius:99px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent),var(--dsw-alias-state-business-primary));animation:ofm-prog-slide 1.1s ease-in-out infinite}
.ofm_prog i{position:relative;overflow:hidden}
.ofm_prog i::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent) 50%,transparent 70%);transform:translateX(-100%);animation:ofm-prog-shine 1.6s ease-in-out infinite}
@keyframes ofm-prog-shine{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}
@keyframes ofm-prog-slide{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
/* ══ Toast（fixed 到视口，浮在所有层之上） ════════════════════════════ */
.ofm_toasts{position:fixed;right:18px;bottom:18px;z-index:1200;display:flex;flex-direction:column;gap:10px;max-width:min(380px,calc(100vw - 36px));font-family:inherit}
.ofm_toast{position:relative;display:flex;flex-direction:column;gap:6px;padding:12px 14px 12px 16px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 94%,transparent);backdrop-filter:blur(14px) saturate(150%);-webkit-backdrop-filter:blur(14px) saturate(150%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 14px 40px rgb(0 0 0 / 26%);font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);animation:ofm-toast-rise .32s cubic-bezier(.16,1,.3,1);overflow:hidden}
.ofm_toast{transform-origin:bottom right;will-change:transform}
.ofm_toast::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--dsw-alias-state-business-primary)}
.ofm_toast.warn::before{background:var(--dsw-alias-state-warning-primary,#f0a441)}
.ofm_toast.urgent::before{background:var(--dsw-alias-state-error-primary)}
.ofm_toast.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 42%,var(--dsw-alias-border-l2))}
.ofm_toast.urgent{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,var(--dsw-alias-border-l2))}
.ofm_toast .ofm_toasttitle{font-weight:660;font-size:12.5px;display:flex;align-items:center;gap:7px}
.ofm_toast .ofm_toastbody{color:var(--dsw-alias-label-secondary);max-height:180px;overflow:auto;overflow-wrap:anywhere}
.ofm_toast .ofm_toastbody p{margin:0 0 5px}
.ofm_toast .ofm_toastbody p:last-child{margin-bottom:0}
.ofm_toast .ofm_toastbody img{max-width:100%}
.ofm_toastactions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.ofm_toastclose{margin-left:auto;background:transparent;border:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:13px;padding:0 2px;transition:color .14s ease}
.ofm_toastclose:hover{color:var(--dsw-alias-label-primary)}
@keyframes ofm-toast-rise{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
/* ══ 模态 ══════════════════════════════════════════════════════════════ */
.ofm_modal{width:min(520px,92vw);max-height:min(80vh,600px);border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 95%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 28px 80px rgb(0 0 0 / 42%);display:flex;flex-direction:column;overflow:hidden;animation:ofm-popin .34s cubic-bezier(.16,1,.3,1)}
.ofm_modalhead{padding:17px 20px 11px;display:flex;align-items:center;gap:10px;font-size:15px;font-weight:720;letter-spacing:-.2px}
.ofm_modalbody{padding:4px 20px 16px;overflow:auto;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.ofm_modalbody p{margin:0 0 6px}
.ofm_modalfoot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent)}
@media (max-width:720px){.ofm_sec_hint{margin-left:0;width:100%}.ofm_pills{margin-left:0;width:100%}}
/* ══ GitHub star 按钮 ══════════════════════════════════════════════════ */
.ofm_starbtn{position:relative;display:inline-flex;gap:7px;align-items:center;padding:7px 15px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);background:linear-gradient(140deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent),transparent 70%);color:var(--dsw-alias-state-business-primary);text-decoration:none;font-weight:650;font-size:12.5px;transition:transform .18s ease,box-shadow .22s ease,color .22s ease,background .22s ease;white-space:nowrap;overflow:hidden}
.ofm_starbtn svg{transition:transform .5s cubic-bezier(.34,1.56,.64,1)}
.ofm_starbtn:hover svg{transform:rotate(72deg) scale(1.12)}
.ofm_starbtn:hover{box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent),0 6px 16px color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
.ofm_starbtn:active svg{transform:rotate(72deg) scale(.94)}
.ofm_starbtn svg{width:14px;height:14px;fill:currentColor;transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
.ofm_starbtn:hover{transform:translateY(-1px);box-shadow:0 8px 22px color-mix(in srgb,var(--dsw-alias-state-business-primary) 34%,transparent);background:linear-gradient(140deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 72%,#3ECFA0));color:#fff}
.ofm_starbtn:active{transform:scale(.97)}
.ofm_starbtn:hover svg{transform:rotate(-72deg) scale(1.12)}
.ofm_starbtn::after{content:"";position:absolute;top:0;bottom:0;width:38%;left:-45%;background:linear-gradient(100deg,transparent,rgb(255 255 255 / 34%),transparent);transform:skewX(-18deg);transition:left .55s ease}
.ofm_starbtn:hover::after{left:112%}
.ofm_starlink{display:inline-flex;align-items:center;gap:6px;text-decoration:none}
/* ══ 鱼缸（品牌装饰：玻璃缸 + 水位 + 波光 + 鱼群） ════════════════════ */
.ofm_tank{position:relative;width:206px;height:128px;border-radius:16px;overflow:hidden;flex:none;background:linear-gradient(180deg,rgba(127,166,255,.10),rgba(127,166,255,.03));box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.ofm_tankwater{position:absolute;left:0;right:0;bottom:0;height:var(--lvl,0%);transition:height 1.4s cubic-bezier(.22,.61,.36,1)}
.ofm_tank.ok .ofm_tankwater{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 72%,transparent),var(--dsw-alias-state-business-primary))}
.ofm_tank.busy .ofm_tankwater{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 72%,transparent),var(--dsw-alias-state-warning-primary,#f0a441))}
.ofm_tank.over .ofm_tankwater{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-error-primary) 72%,transparent),var(--dsw-alias-state-error-primary))}
.ofm_tankdeep{position:absolute;inset:0;overflow:hidden}
.ofm_wave{position:absolute;left:0;top:-6px;width:200%;height:7px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 8' preserveAspectRatio='none'%3E%3Cpath d='M0 4 Q15 0 30 4 T60 4 T90 4 T120 4 V8 H0Z' fill='rgba(255,255,255,.45)'/%3E%3C/svg%3E") repeat-x;background-size:60px 7px;animation:ofmwave 5.5s linear infinite}
.ofm_wave.w2{top:-4px;opacity:.45;animation-duration:8.5s;animation-direction:reverse}
@keyframes ofmwave{to{transform:translateX(60px)}}
.ofm_bubble{position:absolute;bottom:-8px;width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.5);opacity:0;animation:ofmbub 7s ease-in infinite}
.ofm_bubble.b1{left:14%;animation-delay:0s}
.ofm_bubble.b2{left:32%;width:3px;height:3px;animation-delay:2.2s;animation-duration:9s}
.ofm_bubble.b3{left:55%;animation-delay:4.1s}
.ofm_bubble.b4{left:71%;width:7px;height:7px;animation-delay:1.3s;animation-duration:8s}
.ofm_bubble.b5{left:86%;width:4px;height:4px;animation-delay:5.4s;animation-duration:10s}
@keyframes ofmbub{0%{transform:translateY(0);opacity:0}12%{opacity:.75}100%{transform:translateY(-136px);opacity:0}}
.ofm_fish{position:absolute;left:-34px;width:26px;height:13px;animation:ofmswim 12s linear infinite;will-change:transform;filter:drop-shadow(0 1px 2px rgb(0 0 0 / 18%))}
.ofm_fish.f1{bottom:14px}
.ofm_fish.f1 svg,.ofm_fish.f3 svg{transform:scaleX(-1)}
.ofm_fish.f2{bottom:44px;animation-duration:16s;animation-delay:-7s;animation-name:ofmswimrev}
.ofm_fish.f3{bottom:68px;width:19px;height:10px;animation-duration:9.5s;animation-delay:-3.5s}
.ofm_fish svg{display:block;width:100%;height:100%;fill:rgba(255,255,255,.82)}
@keyframes ofmswim{0%{transform:translateX(0)}100%{transform:translateX(270px)}}
@keyframes ofmswimrev{0%{transform:translateX(270px)}100%{transform:translateX(0)}}
.ofm_tankglass{position:absolute;inset:0;pointer-events:none;border-radius:16px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.16),inset 0 18px 32px rgba(255,255,255,.06),inset 0 -12px 24px rgba(0,0,0,.10)}
.ofm_tankrays{position:absolute;inset:-30% -12%;pointer-events:none;opacity:.5;background:repeating-linear-gradient(104deg,rgb(255 255 255 / 7%) 0 9px,transparent 9px 30px);mix-blend-mode:soft-light;animation:ofmrays 11s ease-in-out infinite alternate}
@keyframes ofmrays{from{transform:translateX(-14px) rotate(-.4deg)}to{transform:translateX(14px) rotate(.4deg)}}
.ofm_tankshine{position:absolute;inset:0;pointer-events:none;background:linear-gradient(196deg,rgb(255 255 255 / 13%) 0%,transparent 32%)}
@media (prefers-reduced-motion:reduce){.ofm_wave,.ofm_bubble,.ofm_fish,.ofm_tankrays{animation:none}}
/* ══ 三页外壳：极光底 · 毛玻璃导航 · 页过渡 ═════════════════════════════
   The aurora is a fixed layer *inside* our root: a flat shell background gives
   backdrop-filter nothing to sample, so every glass surface would read as a
   plain translucent box. It sits at z-index:-1 with isolation:isolate on the
   shell, which keeps it behind our content and above the app background without
   ever escaping into the shell's own stacking order. */
.ofm_shell{position:relative;display:flex;flex-direction:column;gap:18px;max-width:1120px;isolation:isolate}
.ofm_aurora{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
.ofm_aurora i{position:absolute;display:block;border-radius:50%;filter:blur(70px);opacity:.42;animation:ofmdrift 44s ease-in-out infinite alternate}
.ofm_aurora i:nth-child(1){width:46vw;height:46vw;left:-12vw;top:-14vw;background:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,transparent),transparent 68%)}
.ofm_aurora i:nth-child(2){width:38vw;height:38vw;right:-10vw;top:4vh;background:radial-gradient(circle,rgba(62,207,160,.42),transparent 70%);animation-duration:56s;animation-delay:-12s}
.ofm_aurora i:nth-child(3){width:42vw;height:42vw;left:22vw;bottom:-18vw;background:radial-gradient(circle,rgba(227,106,166,.34),transparent 70%);animation-duration:64s;animation-delay:-26s}
@keyframes ofmdrift{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(3vw,2vh,0) scale(1.09)}100%{transform:translate3d(-3vw,-2vh,0) scale(.96)}}
.ofm_nav{position:sticky;top:0;z-index:30;display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px 12px;padding:10px 12px;border-radius:16px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 82%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 62%,transparent);backdrop-filter:blur(20px) saturate(160%);-webkit-backdrop-filter:blur(20px) saturate(160%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 8px 26px rgb(0 0 0 / 10%)}
.ofm_navbrand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:14px;letter-spacing:-.2px;white-space:nowrap}
.ofm_navmark{width:26px;height:26px;border-radius:9px;display:grid;place-items:center;flex:none;background:linear-gradient(145deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,#3ECFA0));box-shadow:0 4px 12px color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent),inset 0 1px 0 rgb(255 255 255 / 22%)}
.ofm_navmark svg{width:16px;height:16px;fill:#fff}
.ofm_tabs{position:relative;grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:13px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 80%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);box-shadow:inset 0 1px 2px rgb(0 0 0 / 4%)}
.ofm_tabglider{position:absolute;top:0;left:0;border-radius:10px;background:linear-gradient(150deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 92%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,transparent));box-shadow:0 3px 10px rgb(0 0 0 / 14%),inset 0 1px 0 rgb(255 255 255 / 9%);transition:transform .34s cubic-bezier(.22,.61,.36,1),width .34s cubic-bezier(.22,.61,.36,1),height .34s cubic-bezier(.22,.61,.36,1);pointer-events:none}
.ofm_tab{position:relative;z-index:1;font:inherit;font-size:12px;font-weight:600;padding:6px 13px;border-radius:10px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;transition:color .2s ease}
.ofm_tab[data-on="true"]{color:var(--dsw-alias-label-primary)}
.ofm_tab:hover{color:var(--dsw-alias-label-primary)}
.ofm_tab .ofm_tabnum{font-variant-numeric:tabular-nums;font-weight:600;color:var(--dsw-alias-label-tertiary);margin-left:6px;font-size:11px}
.ofm_navspacer{display:none}
/* The star belongs beside the brand: grid auto-placement would push it below
   the tabs row (they come first in the DOM) and stretch it across the row. */
.ofm_nav .ofm_starbtn{grid-column:2;grid-row:1;justify-self:end}
.ofm_page{display:flex;flex-direction:column;gap:20px;animation:ofmpagein .4s cubic-bezier(.16,1,.3,1)}
@keyframes ofmpagein{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
/* ── 毛玻璃表面：只给大块面用 backdrop-filter，小卡片用半透明叠层，滚动更顺 */
.ofm_glass{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 68%,transparent);backdrop-filter:blur(16px) saturate(150%);-webkit-backdrop-filter:blur(16px) saturate(150%);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 12px 34px rgb(0 0 0 / 9%)}
.ofm_root .ofm_hero,.ofm_root .ofm_panel,.ofm_root .ofm_ann,.ofm_root .ofm_modal{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent);backdrop-filter:blur(18px) saturate(155%);-webkit-backdrop-filter:blur(18px) saturate(155%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 14px 40px rgb(0 0 0 / 10%)}
/* ══ 鱼缸加大版（页头） ════════════════════════════════════════════════ */
.ofm_tankrow{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.ofm_tankside{flex:1;min-width:236px;display:flex;flex-direction:column;gap:11px;justify-content:center}
.ofm_tank.xl{width:264px;height:148px;border-radius:20px;box-shadow:inset 0 0 0 1px rgb(255 255 255 / 12%),0 16px 40px rgb(0 0 0 / 14%)}
.ofm_tank.xl .ofm_tankglass{border-radius:20px}
.ofm_tagpill{font-size:10px;font-weight:560;padding:1px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 90%,transparent);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ofm_tagpill.free{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.ofm_tagpill.dead{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
/* ══ 骨架屏 ════════════════════════════════════════════════════════════ */
.ofm_skel{position:relative;overflow:hidden;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent);min-height:96px;animation:ofmpulse 1.8s ease-in-out infinite}
.ofm_skel::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent) 50%,transparent 70%);transform:translateX(-100%);animation:ofm-skel-shine 1.8s ease-in-out infinite}
@keyframes ofm-skel-shine{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}
.ofm_skel::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent,rgb(255 255 255 / 8%) 42%,transparent 74%);animation:ofmshine 1.5s ease-in-out infinite}
@keyframes ofmshine{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@keyframes ofmpulse{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes ofmscan{0%,100%{opacity:.35}50%{opacity:.85}}
/* ══ 数据看板 KPI ══════════════════════════════════════════════════════ */
.ofm_kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.ofm_kpi{display:flex;flex-direction:column;gap:6px;padding:15px 17px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 5%);transition:transform .22s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,border-color .2s ease}
.ofm_kpi:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 16px 36px rgb(0 0 0 / 13%)}
.ofm_kpilabel{font-size:11px;font-weight:560;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.ofm_kpivalue{font-size:25px;font-weight:760;letter-spacing:-.7px;line-height:1.15;font-variant-numeric:tabular-nums;background:linear-gradient(120deg,var(--dsw-alias-label-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-label-primary)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ofm_kpi:hover .ofm_kpivalue{transform:translateY(-1px);transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
.ofm_kpivalue{transition:transform .3s cubic-bezier(.34,1.56,.64,1);display:inline-block}
.ofm_kpisub{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ofm_kpi.warn .ofm_kpivalue{-webkit-text-fill-color:var(--dsw-alias-state-warning-primary,#f0a441);background:none}
.ofm_logfailed td{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 5%,transparent)}
/* ══ 真实图标与积分展示 ════════════════════════════════════════════════ */
.ofm_navmark img{width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block}
/* ══ 账号池状态 ════════════════════════════════════════════════════════ */
.ofm_pooltop{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ofm_poolbadge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);font-size:12.5px;font-weight:650;white-space:nowrap}
.ofm_pooldot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.ofm_poolbadge.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}
.ofm_poolbadge.ok .ofm_pooldot{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent)}
.ofm_poolbadge.busy{color:var(--dsw-alias-state-warning-primary,#f0a441);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 40%,transparent)}
.ofm_poolbadge.busy .ofm_pooldot{background:var(--dsw-alias-state-warning-primary,#f0a441);animation:ofmpulse 1.4s ease-in-out infinite}
.ofm_poolbadge.over{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.ofm_poolbadge.over .ofm_pooldot{background:var(--dsw-alias-state-error-primary);animation:ofmpulse .8s ease-in-out infinite}
.ofm_poolstats{display:flex;gap:22px;flex-wrap:wrap}
.ofm_poolstats .ofm_stat b{font-size:19px}
.ofm_poolstats .ofm_stat.hot b{color:var(--dsw-alias-state-error-primary)}
.ofm_poolmeta{display:flex;gap:8px 18px;align-items:baseline;flex-wrap:wrap;justify-content:space-between}
@media (max-width:760px){.ofm_tank.xl{width:100%;max-width:340px}.ofm_tab{flex:1 1 auto;text-align:center}}
/* ══ 动效降级：用户系统开启"减少动态效果"时全部收敛 ═══════════════════ */
/* —— 交互锚点增强：激活态 / 状态色 / 加载态（additive，不改既有规则） —— */
/* tab：激活项在滑块底衬之上再补一道品牌下划线，选中更明确 */
.ofm_tab[aria-selected="true"]{color:var(--dsw-alias-label-primary)}
.ofm_tab[aria-selected="true"]::after{content:"";position:absolute;left:12px;right:12px;bottom:3px;height:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary);opacity:.85;transition:opacity .18s cubic-bezier(.32,.72,0,1)}
/* 按钮：异步进行中显示内联 spinner（aria-busy 锚点，文字仍保留占位避免布局跳动） */
.ofm_btn[aria-busy="true"]{position:relative;color:transparent !important;pointer-events:none}
.ofm_btn[aria-busy="true"]::after{content:"";position:absolute;left:50%;top:50%;width:13px;height:13px;margin:-6.5px 0 0 -6.5px;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 30%,var(--dsw-alias-label-secondary));border-top-color:var(--dsw-alias-label-primary);animation:ofm-btn-spin .7s linear infinite}
@keyframes ofm-btn-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ofm_root *,.ofm_root *::before,.ofm_root *::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}}
/* ═══ 精密仪器精修层（世界观：原厂仪器手感）：颜色听宿主，质感在阻尼。曲线 --ease-instrument 冲得快落得稳，--ease-settle 极轻过冲。退场比进场快。 ═══ */
.ofm_glass{transition:border-color .22s var(--ease-instrument),box-shadow .26s var(--ease-instrument),transform .22s var(--ease-instrument),background .22s var(--ease-instrument)}
.ofm_glass:hover{border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 92%,var(--dsw-alias-state-business-primary));box-shadow:0 1px 2px rgb(0 0 0 / 5%),0 10px 28px -14px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.ofm_kpi{transition:border-color .22s var(--ease-instrument),transform .22s var(--ease-instrument),box-shadow .26s var(--ease-instrument)}
.ofm_kpi:hover{transform:translateY(-1px)}
.ofm_kpivalue{transition:transform .3s var(--ease-settle),color .2s var(--ease-instrument);display:inline-block}
.ofm_kpi:hover .ofm_kpivalue{transform:translateY(-1px) scale(1.015);color:var(--dsw-alias-label-primary)}
.ofm_table tbody tr{transition:background .14s var(--ease-instrument)}
.ofm_seg button,.ofm_chip{transition:background .2s var(--ease-instrument),color .2s var(--ease-instrument),border-color .2s var(--ease-instrument),box-shadow .22s var(--ease-settle)}
.ofm_prog i{transition:width .5s var(--ease-instrument)}
.ofm_minibtn{transition:transform .14s var(--ease-instrument),border-color .18s var(--ease-instrument),color .18s var(--ease-instrument),background .18s var(--ease-instrument)}
.ofm_minibtn:active:not(:disabled){transform:scale(.98);transition-duration:.09s}
.ofm_root input,.ofm_root select,.ofm_root textarea{transition:border-color .18s var(--ease-instrument),box-shadow .2s var(--ease-instrument),background .18s var(--ease-instrument)}
@media (prefers-reduced-motion:reduce){.ofm_glass,.ofm_kpi,.ofm_kpivalue,.ofm_minibtn,.ofm_prog i{transition:none!important}.ofm_kpi:hover,.ofm_kpi:hover .ofm_kpivalue{transform:none}}

/* ==== V5 INSTRUMENT START ==== */
/* 精密仪器·样板间覆盖层：1px细边+内高光，无外投影；颜色全部听宿主 var(--dsw-alias-*)。
   夜(暗)高光更刃、纹理更显；昼(亮)高光收敛、纹理近乎哑。reduced-motion 去位移留状态。 */

/* ── ① 面板卡片 .ofm_panel / .ofm_card ─────────────────────────── */
/* 双基底：拉丝细纹(repeating-linear-gradient)垫底，实体色覆盖在上，从边缘隐约透出拉丝感 */
.ofm_root .ofm_panel{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%), inset 0 -14px 28px -18px rgb(0 0 0 / 16%) !important;
  transition: border-color .22s var(--ease-instrument), box-shadow .26s var(--ease-instrument), transform .22s var(--ease-instrument) !important;
}
.ofm_root .ofm_card{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-3) 84%, transparent) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%), inset 0 -12px 24px -16px rgb(0 0 0 / 14%) !important;
  transition: transform .22s var(--ease-instrument), box-shadow .26s var(--ease-instrument), border-color .2s var(--ease-instrument) !important;
}
/* hover：kinetic tension —— 位移压浅(-1px)，去掉外投影，靠边色提亮+高光增强传递"浮起" */
.ofm_root .ofm_card:hover{
  transform: translateY(-1px) !important;
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 58%, var(--dsw-alias-border-l2)) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 11%), inset 0 -12px 24px -16px rgb(0 0 0 / 10%) !important;
}

/* ── ② 按钮 .ofm_btn ─────────────────────────── */
/* kinetic tension：外壳 active 陷落(scale .985)，内部 ::after 扫光条反向滑过形成"外陷内顶" */
.ofm_root .ofm_btn{
  position: relative !important;
  overflow: hidden !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%) !important;
  transition: transform .16s var(--ease-settle), border-color .2s var(--ease-instrument), background .2s var(--ease-instrument), box-shadow .2s var(--ease-instrument), opacity .16s var(--ease-instrument) !important;
}
.ofm_root .ofm_btn::after{
  content: "" !important;
  position: absolute !important;
  top: 0 !important; bottom: 0 !important;
  left: -60% !important; width: 42% !important;
  background: linear-gradient(100deg, transparent, rgb(255 255 255 / 14%), transparent) !important;
  transform: skewX(-18deg) !important;
  transition: left .5s var(--ease-instrument) !important;
  pointer-events: none !important;
}
/* hover：扫光滑过（exit slower than press）；去掉原外投影，仅留顶部高光 */
.ofm_root .ofm_btn:hover:not(:disabled){
  transform: translateY(-1px) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 10%) !important;
}
.ofm_root .ofm_btn:hover:not(:disabled)::after{
  left: 118% !important;
}
/* active：快速陷落(.09s) + 内阴影加深=物理按压；松开靠 --ease-settle 回弹 */
.ofm_root .ofm_btn:active:not(:disabled){
  transform: scale(.985) !important;
  transition-duration: .09s !important;
  box-shadow: inset 0 2px 5px rgb(0 0 0 / 14%), inset 0 1px 0 rgb(255 255 255 / 3%) !important;
}
/* primary 按钮保留主色渐变，仅把外投影换成更克制的内高光+轻凹槽 */
.ofm_root .ofm_btn.primary{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 22%), inset 0 -10px 18px -12px rgb(0 0 0 / 24%) !important;
}
.ofm_root .ofm_btn.primary:hover:not(:disabled){
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 26%), inset 0 -10px 18px -12px rgb(0 0 0 / 18%) !important;
}

/* ── ③ 表格行 hover .ofm_table tbody tr ─────────────────────────── */
/* 行首 2px 主色竖条用 transform:scaleY 展开(不触发布局)；exit(.12s) 比 entrance(.16s) 快 */
.ofm_root .ofm_table tbody tr{
  transition: background .16s var(--ease-instrument) !important;
}
.ofm_root .ofm_table tbody tr td:first-child{
  position: relative !important;
}
.ofm_root .ofm_table tbody tr td:first-child::before{
  content: "" !important;
  position: absolute !important;
  left: 0 !important; top: 6px !important; bottom: 6px !important;
  width: 2px !important; border-radius: 2px !important;
  background: var(--dsw-alias-state-business-primary) !important;
  transform: scaleY(0) !important;
  transform-origin: center !important;
  opacity: 0 !important;
  transition: transform .16s var(--ease-instrument), opacity .12s var(--ease-instrument) !important;
  pointer-events: none !important;
}
.ofm_root .ofm_table tbody tr:hover td:first-child::before{
  transform: scaleY(1) !important;
  opacity: 1 !important;
}
/* 数字列表针走格感：tabular-nums + pl5-tick 机械顿挫(steps) */
.ofm_root .ofm_table td{
  font-variant-numeric: tabular-nums !important;
}
/* 表针走格：离散百分比快照模拟 steps 顿挫——同值连帧=停格，瞬间跳格=机械感；@keyframes 里用不了 steps() 函数，用帧堆出来 */
@keyframes pl5-tick{
  0%,24%{ transform: translateY(0); }
  25%,54%{ transform: translateY(-1.5px); }
  55%,79%{ transform: translateY(-.75px); }
  80%,100%{ transform: translateY(0); }
}

/* ── 昼(not-dark)收敛：高光更哑、拉丝更隐、回弹更小 ─────────────── */
@media not (prefers-color-scheme: dark){
  .ofm_root .ofm_panel,
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-2) 90%, transparent) !important;
  }
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-3) 88%, transparent) !important;
  }
  .ofm_root .ofm_panel{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 45%), inset 0 -14px 28px -18px rgb(0 0 0 / 7%) !important;
  }
  .ofm_root .ofm_card{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 50%), inset 0 -12px 24px -16px rgb(0 0 0 / 6%) !important;
  }
  .ofm_root .ofm_card:hover{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 60%), inset 0 -12px 24px -16px rgb(0 0 0 / 5%) !important;
  }
  .ofm_root .ofm_btn{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 50%) !important;
  }
  .ofm_root .ofm_btn:hover:not(:disabled){
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 62%) !important;
  }
}

/* ── reduced-motion 降级：去位移/回弹/扫光/顿挫，保留颜色与不透明度反馈 ── */
@media (prefers-reduced-motion: reduce){
  /* 统一过渡降级：所有交互件只留颜色/不透明度反馈，去位移 */
  .ofm_root .ofm_card,
  .ofm_root .ofm_panel,
  .ofm_root .ofm_btn,
  .ofm_root .ofm_table tbody tr,
  .ofm_root .ofm_table tbody tr td:first-child::before,
  .ofm_root .ofm_switch i,
  .ofm_root .ofm_switch i::after,
  .ofm_root .ofm_seg button,
  .ofm_root .ofm_stat,
  .ofm_root .ofm_kvc,
  .ofm_root .ofm_input,
  .ofm_root .ofm_starbtn{
    transition: border-color .12s ease, background .12s ease, box-shadow .12s ease, opacity .12s ease, color .12s ease !important;
  }
  /* 去位移/回弹/陷落 */
  .ofm_root .ofm_card:hover,
  .ofm_root .ofm_btn:hover:not(:disabled),
  .ofm_root .ofm_btn:active:not(:disabled),
  .ofm_root .ofm_stat:hover,
  .ofm_root .ofm_kvc:hover,
  .ofm_root .ofm_seg button:active:not([aria-pressed="true"]),
  .ofm_root .ofm_starbtn:active{
    transform: none !important;
  }
  /* 开关捏扁还原 */
  .ofm_root .ofm_switch:active i::after{
    width: 14px !important;
  }
  /* 扫光条砍掉 */
  .ofm_root .ofm_btn::after,
  .ofm_root .ofm_starbtn::after{
    content: none !important;
  }
  /* 呼吸灯停跳，但保留颜色状态 */
  .ofm_root .ofm_dot.ok{
    animation: none !important;
    opacity: 1 !important;
  }
  /* 表针走格动画停走，但保留数字本身 */
  .ofm_root .ofm_kpi:hover .ofm_kpivalue,
  .ofm_root .ofm_stat:hover b{
    animation: none !important;
  }
}

/* ── ④ 输入框 .ofm_input：仪器凹槽手感 ─────────────────────────── */
/* 常态凹槽(inset 顶高光+底内阴影)；focus 时凹槽不动，只换边色+外发光，像仪器被点亮 */
.ofm_root .ofm_input{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%), inset 0 2px 6px -2px rgb(0 0 0 / 10%) !important;
  transition: border-color .18s var(--ease-instrument), box-shadow .2s var(--ease-instrument), background .18s var(--ease-instrument) !important;
}
.ofm_root .ofm_input:hover{
  border-color: color-mix(in srgb, var(--dsw-alias-border-l2) 55%, var(--dsw-alias-state-business-primary)) !important;
}
.ofm_root .ofm_input:focus{
  border-color: var(--dsw-alias-state-business-primary) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%), inset 0 2px 6px -2px rgb(0 0 0 / 8%), 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent) !important;
}

/* ── ⑤ 开关 .ofm_switch：spring 滑块阻尼 ─────────────────────────── */
/* 滑块用 --ease-settle 带回弹；按下时滑块变宽=被"捏扁"，松开回弹归位 */
.ofm_root .ofm_switch i{
  box-shadow: inset 0 1px 3px rgb(0 0 0 / 10%), inset 0 -1px 0 rgb(255 255 255 / 4%) !important;
  transition: background .22s var(--ease-instrument), border-color .22s var(--ease-instrument), box-shadow .22s var(--ease-instrument) !important;
}
.ofm_root .ofm_switch i::after{
  background: var(--dsw-alias-label-primary) !important;
  box-shadow: 0 1px 3px rgb(0 0 0 / 28%), inset 0 1px 0 rgb(255 255 255 / 20%) !important;
  transition: transform .28s var(--ease-settle), background .2s var(--ease-instrument), width .14s var(--ease-instrument) !important;
}
.ofm_root .ofm_switch[aria-checked="true"] i{
  box-shadow: inset 0 1px 3px rgb(0 0 0 / 14%), inset 0 -1px 0 rgb(255 255 255 / 8%) !important;
}
.ofm_root .ofm_switch[aria-checked="true"] i::after{
  background: var(--dsw-alias-label-on-accent, #fff) !important;
}
.ofm_root .ofm_switch:active i::after{
  width: 17px !important;
}

/* ── ⑥ 徽章/药丸/标签 .ofm_badge/.ofm_pill/.ofm_tag/.ofm_chantag/.ofm_chip ── */
/* 统一加顶部发丝高光；状态色只用 color-mix 调透明度，不换色相 */
.ofm_root .ofm_pill,
.ofm_root .ofm_tag,
.ofm_root .ofm_chip,
.ofm_root .ofm_chantag{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 5%) !important;
  transition: border-color .2s var(--ease-instrument), color .2s var(--ease-instrument), background .2s var(--ease-instrument), transform .18s var(--ease-settle) !important;
}
.ofm_root .ofm_badge{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%) !important;
  transition: border-color .2s var(--ease-instrument), color .2s var(--ease-instrument), background .2s var(--ease-instrument) !important;
}
/* 状态点呼吸灯保留，但改成 pl5- 前缀、机械顿挫更明显的两拍节奏 */
@keyframes pl5-dot-breathe{
  0%,100%{ opacity:1; }
  50%{ opacity:.45; }
}
.ofm_root .ofm_dot.ok{
  animation: pl5-dot-breathe 2.4s cubic-bezier(.4,0,.6,1) infinite !important;
}
/* 分段控件选中块：加顶部高光，按下时微微陷落 */
.ofm_root .ofm_seg button[aria-pressed="true"]{
  box-shadow: 0 1px 3px rgb(0 0 0 / 10%), inset 0 1px 0 rgb(255 255 255 / 8%) !important;
  transition: color .18s var(--ease-instrument), background .18s var(--ease-instrument), box-shadow .2s var(--ease-settle) !important;
}
.ofm_root .ofm_seg button:active:not([aria-pressed="true"]){
  transform: scale(.97) !important;
}

/* ── ⑦ 原生件接管：滚动条 / selection / caret / 聚焦环 ─────────────── */
/* 滚动条：仪器滑轨——thumb 加顶部高光与底部凹槽，hover 时轻微增亮 */
.ofm_root ::-webkit-scrollbar-thumb{
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 30%, transparent) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%), inset 0 -1px 0 rgb(0 0 0 / 10%) !important;
  transition: background .2s var(--ease-instrument) !important;
}
.ofm_root ::-webkit-scrollbar-thumb:hover{
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 48%, transparent) !important;
}
/* 文本选择：主色薄涂，昼模式再淡一点避免刺眼 */
.ofm_root ::selection{
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 20%, transparent) !important;
}
/* 光标：跟随主色 */
.ofm_root input, .ofm_root textarea{
  caret-color: var(--dsw-alias-state-business-primary) !important;
}
/* 聚焦环：仪器刻度环——细环+外晕，用 --ease-instrument 淡入 */
.ofm_root :focus-visible{
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 72%, transparent) !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent) !important;
  transition: box-shadow .18s var(--ease-instrument), outline-color .18s var(--ease-instrument) !important;
}

/* ── ⑧【师傅批改①】拉丝纹理增强：金属感要真的能摸到 ─────────────── */
/* 夜模式 3% → 4.5%，昼模式 1.5% → 2.8%，纹理间隔收紧让拉丝更密 */
.ofm_root .ofm_panel{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent) !important;
}
.ofm_root .ofm_card{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-3) 84%, transparent) !important;
}
@media not (prefers-color-scheme: dark){
  .ofm_root .ofm_panel,
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-2) 90%, transparent) !important;
  }
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-3) 88%, transparent) !important;
  }
}

/* ── ⑧【师傅批改②】昼模式高光压暗：45-62% → 30-38%，更克制 ─────────── */
@media not (prefers-color-scheme: dark){
  .ofm_root .ofm_panel{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 34%), inset 0 -14px 28px -18px rgb(0 0 0 / 6%) !important;
  }
  .ofm_root .ofm_card{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 38%), inset 0 -12px 24px -16px rgb(0 0 0 / 5%) !important;
  }
  .ofm_root .ofm_card:hover{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 42%), inset 0 -12px 24px -16px rgb(0 0 0 / 4%) !important;
  }
  .ofm_root .ofm_btn{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 36%) !important;
  }
  .ofm_root .ofm_btn:hover:not(:disabled){
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 44%) !important;
  }
  .ofm_root .ofm_pill,
  .ofm_root .ofm_tag,
  .ofm_root .ofm_chip,
  .ofm_root .ofm_chantag,
  .ofm_root .ofm_badge{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 30%) !important;
  }
  .ofm_root .ofm_input{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 34%), inset 0 2px 6px -2px rgb(0 0 0 / 6%) !important;
  }
}

/* ── ⑧【师傅批改③】表格竖条语言统一：所有表格行 hover 都带主色竖条 ── */
/* .ofm_newsbody table 是内容型表格，保持朴素；仅给数据表 .ofm_table 统一竖条。
   同时把 .ofm_kvc / .ofm_stat 等"类表格"卡片也纳入 hover 微提亮，保持语言一致 */
.ofm_root .ofm_stat,
.ofm_root .ofm_kvc{
  transition: border-color .2s var(--ease-instrument), box-shadow .22s var(--ease-instrument), transform .2s var(--ease-settle) !important;
}
.ofm_root .ofm_stat:hover,
.ofm_root .ofm_kvc:hover{
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 38%, var(--dsw-alias-border-l1)) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%) !important;
  transform: translateY(-1px) !important;
}

/* ── ⑩【返工·收编租界】星按钮/导航标/渠道标 全部听宿主变量 ─────────────── */
/* L1130 .ofm_starbtn:hover 混 #3ECFA0、L1181 .ofm_navmark 混 #3ECFA0 —— 统一改混 label-primary，零品牌色 */
.ofm_root .ofm_starbtn{
  transition: transform .16s var(--ease-settle), box-shadow .2s var(--ease-instrument), color .2s var(--ease-instrument), background .2s var(--ease-instrument) !important;
}
.ofm_root .ofm_starbtn:hover{
  background: linear-gradient(140deg, var(--dsw-alias-state-business-primary), color-mix(in srgb, var(--dsw-alias-state-business-primary) 76%, var(--dsw-alias-label-primary))) !important;
  color: var(--dsw-alias-label-on-accent, #fff) !important;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent), 0 6px 16px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent) !important;
}
.ofm_root .ofm_starbtn:active{
  transform: scale(.97) !important;
}
/* 扫光条改走 --ease-instrument，与 .ofm_btn 同语言 */
.ofm_root .ofm_starbtn::after{
  transition: left .5s var(--ease-instrument) !important;
}
/* 导航标：去掉 #3ECFA0 混色，改混 label-primary；外投影换成内高光+轻凹槽 */
.ofm_root .ofm_navmark{
  background: linear-gradient(145deg, var(--dsw-alias-state-business-primary), color-mix(in srgb, var(--dsw-alias-state-business-primary) 58%, var(--dsw-alias-label-primary))) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 26%), inset 0 -6px 12px -8px rgb(0 0 0 / 20%) !important;
}
.ofm_root .ofm_navmark svg{
  fill: var(--dsw-alias-label-on-accent, #fff) !important;
}

/* ── ⑩【返工·收编 SEASON 落地件】色板/选中 chip/渠道卡顶条 ─────────────── */
/* SEASON 数组在 JS(L1663) 里、靠内联 style 注入，CSS 改不了值；
   收编它落地的元素，让质感听宿主：色板加高光、chip 选中不再花、渠道卡顶条收敛 */
.ofm_root .ofm_swatch{
  border-radius: 3px !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 30%), inset 0 -1px 0 rgb(0 0 0 / 16%) !important;
}
/* chip 选中态：JS 注入彩色背景，这里压回宿主语言——主色薄涂+主色边，去掉杂色 */
.ofm_root .ofm_chip[aria-pressed="true"]{
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent) !important;
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent) !important;
  color: var(--dsw-alias-state-business-primary) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%) !important;
}

/* ── ⑩【返工·接上 pl5-tick】KPI/统计数字获得表针走格感 ─────────────── */
/* 挂到 KPI 大数字与统计卡数字：hover 时数字以机械顿挫走一格，模拟仪表指针跳动 */
.ofm_root .ofm_kpivalue,
.ofm_root .ofm_stat b{
  display: inline-block !important;
}
.ofm_root .ofm_kpi:hover .ofm_kpivalue,
.ofm_root .ofm_stat:hover b{
  animation: pl5-tick .34s var(--ease-instrument) 1 !important;
}
/* ==== V5 INSTRUMENT END ==== */
/* ── 聚合渠道 / 省 Token / 路由：新页面的表面 ─────────────────────────────
   动效一律走 150–250ms 的短过渡，不弹跳；reduced-motion 下由文件末尾的
   媒体查询整体关掉。ofm_rise 用 backwards 而不是 both：动画结束后元素回到
   样式表里的 transform，卡片的 hover 抬升才不会被动画的终态钉死。 */
.ofm_rise{animation:ofmrisein .22s cubic-bezier(.22,.61,.36,1) backwards}
@keyframes ofmrisein{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ofm_duo{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(272px,100%),1fr));gap:12px;align-items:start}
.ofm_duo>*{min-width:0}
.ofm_picklist{display:grid;grid-template-columns:repeat(auto-fill,minmax(228px,1fr));gap:8px;max-height:330px;overflow:auto;padding:2px}
.ofm_pickrow{display:flex;flex-direction:column;gap:5px;align-items:stretch;text-align:left;font:inherit;padding:9px 11px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);color:var(--dsw-alias-label-primary);cursor:pointer;transition:border-color .16s ease,background .16s ease,transform .16s ease}
.ofm_pickrow:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);transform:translateY(-1px)}
.ofm_pickrow[aria-pressed="true"]{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.ofm_pickrow:disabled{opacity:.55;cursor:default}
.ofm_pickhead{display:flex;align-items:center;gap:7px;min-width:0}
.ofm_pickhead b{font-size:12.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_pickmeta{display:flex;gap:7px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary);min-width:0}
.ofm_picknote{font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.ofm_meter{height:9px;border-radius:99px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow:hidden}
.ofm_meter i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,transparent),var(--dsw-alias-state-business-primary));transition:width .55s cubic-bezier(.22,.61,.36,1)}
.ofm_member{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 82%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 58%,transparent);font-size:11.5px;transition:border-color .16s ease,background .16s ease}
.ofm_member .ofm_id{flex:1;min-width:0}
.ofm_snippet{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.6;padding:9px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:pre;overflow:auto;max-height:230px}
@media (max-width:600px){.ofm_duo{grid-template-columns:1fr}.ofm_picklist{grid-template-columns:1fr}.ofm_member{flex-wrap:wrap}}
@media (prefers-reduced-motion:reduce){.ofm_rise,.ofm_page{animation:none}.ofm_pickrow,.ofm_member,.ofm_meter i,.ofm_card,.ofm_kpi{transition:none}.ofm_root .ofm_card:hover,.ofm_pickrow:hover:not(:disabled){transform:none}}
`

    // ── helpers ───────────────────────────────────────────────────────────────
    // 用页面 base 解析，而不是 origin-absolute 的「/api/...」：DSH 挂在反向代理
    // 子路径下（https://<host>/<prefix>/）时，前导斜杠会把 <prefix> 丢掉，请求
    // 直接打到站点根被前置网关 404，设置面板报「无法连接插件后端」（#54）。
    // 相对路径随页面 base 走，根路径部署下与原值完全一致。解析不了（无 document
    // 的宿主、非常规 base）就退回根路径原值——行为不比修复前差。
    const API = (() => {
      try { return new URL('api/our-free-model', document.baseURI).pathname } catch { return '/api/our-free-model' }
    })()
    const SEASON = ['#4C8DFF', '#3ECFA0', '#F2A65A', '#E36AA6', '#8B7BF0', '#39B8C4', '#D9743E', '#7BB24A']

    async function api(path, options) {
      // 8 秒超时兜底：后端路由未注册/挂起时 fetch 不再永久挂起——此前全部 api 调用
      // （onboarding /announcement、设置页 /announcements /update/status、面板 /summary /stats
      // /forward/key 等）无任何超时，一个不响应端点即可阻塞 settings.onboarding 协调流程
      // 并长期占用同源连接池。超时按 AbortError 抛给调用方，走各自 .catch 降级路径。
      // 慢路由按需放宽（options.timeout，毫秒）：/bench 要等一整段真实生成（本车道
      // 首帧动辄数十秒），/update/apply 要下载+校验+安装整包，/refresh /reprobe 要
      // 跑完一整轮探测——8 秒兜底套在它们身上只会“前端报失败、后端继续烧”，
      // 测速按钮因此几乎必失败而配额照付。
      const { timeout = 8000, ...fetchOptions } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...fetchOptions, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (path, body, timeout) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      ...timeout === undefined ? {} : { timeout },
    })

    function useAsync(loader, deps) {
      const [state, setState] = useState({ status: 'loading', data: undefined, error: '' })
      const run = useCallback(() => {
        let alive = true
        setState(current => ({ ...current, status: 'loading' }))
        loader().then(data => { if (alive) setState({ status: 'ready', data, error: '' }) })
          .catch(error => { if (alive) setState({ status: 'error', data: undefined, error: String(error?.message ?? error) }) })
        return () => { alive = false }
      }, deps)
      useEffect(() => run(), [run])
      return { ...state, reload: run }
    }

    function kilo(value) {
      const n = Math.round(Number(value) || 0)
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
      if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`
      return String(n)
    }

    function ago(ts, locale) {
      if (!ts) return '—'
      const seconds = Math.max(1, Math.round((Date.now() - ts) / 1000))
      const zh = String(locale ?? '').toLowerCase().startsWith('zh')
      if (seconds < 60) return zh ? `${seconds} 秒前` : `${seconds}s ago`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`
      return zh ? `${Math.round(hours / 24)} 天前` : `${Math.round(hours / 24)}d ago`
    }

    function copy(text, done) {
      const finish = ok => done(ok)
      if (navigator?.clipboard?.writeText !== undefined) {
        navigator.clipboard.writeText(text).then(() => finish(true), () => finish(legacy(text)))
        return
      }
      finish(legacy(text))
    }
    function legacy(text) {
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch { return false }
    }

    // ── announcement HTML: strict allowlist, no innerHTML sink ───────────────
    // The feed is authored by the repository owner, but rendering is a trust
    // boundary of its own: the feed URL can be pointed anywhere, and a
    // compromised repository must never become script execution. Nothing here
    // hands a string to the HTML engine — the tokenizer walks the text, drops
    // everything off the allowlist, and builds a virtual tree that both React
    // and plain DOM can materialize. The same parser is exercised headlessly
    // by scripts/sanitize-test.mjs.
    const ALLOWED_TAGS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'])
    /** Everything these elements contain is dropped, closing tag included. */
    const DROP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'textarea', 'title', 'svg', 'math', 'form', 'input', 'button', 'select', 'option', 'video', 'audio', 'canvas', 'link', 'meta', 'base'])
    const VOID_TAGS = new Set(['br', 'hr', 'img'])
    const MAX_HTML_NODES = 4000
    const ALLOWED_STYLE_PROPS = new Set(['color', 'background-color', 'text-align', 'font-weight', 'font-style', 'text-decoration'])
    const STYLE_CAMEL = { 'background-color': 'backgroundColor', 'text-align': 'textAlign', 'font-weight': 'fontWeight', 'font-style': 'fontStyle', 'text-decoration': 'textDecoration', color: 'color' }

    /** http(s), mailto and in-page fragments only; images additionally accept inline PNG/JPEG/GIF/WebP. */
    function safeUrl(raw, isImage) {
      const value = String(raw ?? '').trim()
      if (value === '' || value.length > 2000) return undefined
      const lower = value.toLowerCase()
      if (/^https?:\/\//.test(lower)) return value
      if (lower.startsWith('mailto:') && /^[^@\s]+@[^@\s]+$/.test(value.slice(7))) return value
      if (lower.startsWith('#')) return value
      if (isImage && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value
      return undefined
    }

    function sanitizeStyle(raw) {
      const out = {}
      for (const decl of String(raw ?? '').split(';')) {
        const idx = decl.indexOf(':')
        if (idx === -1) continue
        const prop = decl.slice(0, idx).trim().toLowerCase()
        const value = decl.slice(idx + 1).trim()
        if (!ALLOWED_STYLE_PROPS.has(prop) || value === '' || value.length > 120) continue
        if (/url\(|expression|javascript:|@|<|>/.test(value.toLowerCase())) continue
        out[STYLE_CAMEL[prop]] = value
      }
      return out
    }

    function sanitizeAttrs(tag, attrText) {
      const props = {}
      const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
      let match
      while ((match = attrRe.exec(attrText ?? '')) !== null) {
        const key = match[1].toLowerCase()
        const value = match[3] ?? match[4] ?? match[5] ?? ''
        if (key === 'style') {
          const style = sanitizeStyle(value)
          if (Object.keys(style).length > 0) props.style = style
          continue
        }
        if (tag === 'a' && key === 'href') {
          const url = safeUrl(value)
          if (url !== undefined) {
            props.href = url
            props.target = '_blank'
            props.rel = 'noopener noreferrer'
          }
          continue
        }
        if (tag === 'img' && key === 'src') {
          const url = safeUrl(value, true)
          if (url !== undefined) props.src = url
          continue
        }
        if ((tag === 'img' || tag === 'a') && key === 'title') { props.title = value.slice(0, 300); continue }
        if (tag === 'img' && key === 'alt') { props.alt = value.slice(0, 300); continue }
        if ((key === 'width' || key === 'height') && /^\d{1,4}$/.test(value)) { props[key] = Number(value); continue }
      }
      return props
    }

    /**
     * Tokenize announcement HTML into a virtual tree of
     * `{type:'el', tag, props, children}` and `{type:'text', text}` nodes.
     * Disallowed elements are unwrapped (their children survive); the content
     * of raw-text elements such as `<script>` is dropped entirely.
     */
    function parseSafeHtml(html) {
      if (typeof html !== 'string' || html.trim() === '') return []
      const root = { type: 'root', children: [] }
      const stack = [root]
      const top = () => stack[stack.length - 1]
      let nodes = 0
      let skipUntil = null
      const tokenRe = /<!--[\s\S]*?-->|<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>|<\s*([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g
      let match
      while ((match = tokenRe.exec(html)) !== null) {
        if (nodes >= MAX_HTML_NODES) break
        if (match[0].startsWith('<!--')) continue
        if (match[4] !== undefined) {
          if (skipUntil === null) {
            const text = match[4]
            if (text.trim() !== '' || (top().children.length > 0 && typeof top().children[top().children.length - 1] !== 'string')) {
              top().children.push(text)
            }
          }
          continue
        }
        const name = (match[1] ?? match[2] ?? '').toLowerCase()
        if (name === '') continue
        if (match[1] !== undefined) {
          // closing tag
          if (skipUntil !== null) {
            if (name === skipUntil) skipUntil = null
            continue
          }
          if (!ALLOWED_TAGS.has(name)) continue
          let depth = stack.length - 1
          while (depth > 0 && stack[depth].tag !== name) depth -= 1
          if (depth === 0) continue
          while (stack.length - 1 > depth) {
            const dropped = stack.pop()
            top().children.push(...dropped.children)
          }
          const frame = stack.pop()
          top().children.push({ type: 'el', tag: frame.tag, props: frame.props, children: frame.children })
          nodes += 1
          continue
        }
        // opening tag
        if (skipUntil !== null) continue
        if (DROP_CONTENT_TAGS.has(name)) { skipUntil = name; continue }
        if (!ALLOWED_TAGS.has(name)) continue
        const props = sanitizeAttrs(name, match[3])
        if (name === 'img' && props.src === undefined) continue
        if (VOID_TAGS.has(name)) {
          top().children.push({ type: 'el', tag: name, props, children: [] })
          nodes += 1
          continue
        }
        stack.push({ tag: name, props, children: [] })
      }
      while (stack.length > 1) {
        const frame = stack.pop()
        top().children.push(...frame.children)
      }
      return root.children
    }

    /** Materialize the virtual tree as React elements (keys are positional). */
    function htmlToReact(nodes) {
      return nodes.map((node, index) => typeof node === 'string'
        ? node
        : h(node.tag, { key: index, ...node.props }, ...htmlToReact(node.children ?? [])))
    }

    /** Materialize the virtual tree as DOM nodes (for toasts and modals). */
    function htmlToDom(nodes) {
      return nodes.map(node => {
        if (typeof node === 'string') return document.createTextNode(node)
        const el = document.createElement(node.tag)
        for (const [key, value] of Object.entries(node.props ?? {})) {
          if (key === 'style') { Object.assign(el.style, value); continue }
          el.setAttribute(key, String(value))
        }
        for (const child of htmlToDom(node.children ?? [])) el.appendChild(child)
        return el
      })
    }

    // ── toasts: a vanilla-DOM host so pushes surface on every page ───────────
    // Slot content only exists where the shell mounts it; a toast that lived
    // inside the settings section would be invisible everywhere else. This
    // host attaches to document.body, outside the app root, and needs no
    // react-dom — the body renders through the same allowlist parser.
    function toastHost() {
      let host = document.querySelector('.ofm_toasts')
      if (host === null) {
        host = document.createElement('div')
        host.className = 'ofm_toasts'
        document.body.appendChild(host)
      }
      return host
    }

    function showToast({ title, body, html, tone, actions = [], holdMs = 10000 }) {
      try {
        const host = toastHost()
        const card = document.createElement('div')
        card.className = 'ofm_toast' + (tone === undefined ? '' : ` ${tone}`)
        const head = document.createElement('div')
        head.className = 'ofm_toasttitle'
        head.appendChild(document.createTextNode(title ?? ''))
        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'ofm_toastclose'
        // No locale lookup in here on purpose: showToast also runs from the
        // push subscription before any `t` binding is in scope, and a throw
        // inside this try/catch would silently swallow the whole toast.
        close.setAttribute('aria-label', 'close')
        close.title = '✕'
        close.textContent = '✕'
        close.addEventListener('click', () => card.remove())
        head.appendChild(close)
        card.appendChild(head)
        if (body !== undefined && body !== '') {
          const area = document.createElement('div')
          area.className = 'ofm_toastbody'
          area.textContent = String(body)
          card.appendChild(area)
        } else if (html !== undefined) {
          const area = document.createElement('div')
          area.className = 'ofm_toastbody'
          for (const node of htmlToDom(parseSafeHtml(html))) area.appendChild(node)
          card.appendChild(area)
        }
        if (actions.length > 0) {
          const row = document.createElement('div')
          row.className = 'ofm_toastactions'
          for (const action of actions) {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'ofm_btn'
            btn.textContent = action.label
            btn.addEventListener('click', () => { card.remove(); action.onClick?.() })
            row.appendChild(btn)
          }
          card.appendChild(row)
        }
        host.appendChild(card)
        while (host.children.length > 4) host.firstElementChild?.remove()
        if (holdMs > 0) {
          const timer = setTimeout(() => card.remove(), holdMs)
          timer.unref?.()
        }
        return card
      } catch { /* a toast must never break its caller */ }
      return undefined
    }

    /** Modal surface for `urgent` announcements; dismiss runs the ack callback. */
    function showUrgentModal({ title, html, confirmLabel, onClose }) {
      try {
        document.querySelector('.ofm_scrim[data-ofm-urgent]')?.remove()
        const scrim = document.createElement('div')
        scrim.className = 'ofm_scrim'
        scrim.setAttribute('data-ofm-urgent', 'true')
        const modal = document.createElement('div')
        modal.className = 'ofm_modal'
        modal.setAttribute('role', 'alertdialog')
        modal.setAttribute('aria-modal', 'true')
        const head = document.createElement('div')
        head.className = 'ofm_modalhead'
        head.textContent = title ?? ''
        const body = document.createElement('div')
        body.className = 'ofm_modalbody'
        for (const node of htmlToDom(parseSafeHtml(html ?? ''))) body.appendChild(node)
        const foot = document.createElement('div')
        foot.className = 'ofm_modalfoot'
        const ok = document.createElement('button')
        ok.type = 'button'
        ok.className = 'ofm_btn primary'
        ok.textContent = confirmLabel ?? 'OK'
        ok.addEventListener('click', () => { scrim.remove(); onClose?.() })
        foot.appendChild(ok)
        modal.appendChild(head)
        modal.appendChild(body)
        modal.appendChild(foot)
        scrim.appendChild(modal)
        document.body.appendChild(scrim)
      } catch { /* a modal must never break its caller */ }
    }

    /** OS-level notification, only when the user both opted in and granted. */
    function osNotify(title, body) {
      try {
        if (typeof Notification !== 'function' || Notification.permission !== 'granted') return
        new Notification(title, { body: String(body ?? '').slice(0, 200) })
      } catch { /* the in-app toast still fires */ }
    }

    const Switch = (props) => h('button', {
      type: 'button',
      className: 'ofm_switch',
      role: 'switch',
      'aria-checked': props.checked ? 'true' : 'false',
      // Several call sites already pass `disabled` (the gateway switch does, while
      // its RPC is in flight) and it was silently dropped, so a switch stayed
      // clickable through a write it could not survive. Passing it through is what
      // those call sites meant.
      disabled: props.disabled === true,
      onClick: props.onChange,
    }, h('i'), props.label === undefined ? null : h('span', null, props.label))

    const Pill = (props) => h('span', { className: `ofm_pill${props.strong ? ' strong' : ''}` },
      props.tone === undefined ? null : h('span', { className: `ofm_dot ${props.tone}` }),
      props.children)

    const Button = props => h('button', {
      type: 'button',
      className: 'ofm_btn' + (props.kind === undefined ? '' : ' ' + props.kind),
      disabled: props.disabled,
      onClick: props.onClick,
      title: props.title,
    }, props.children)

    function Section(props) {
      return h('section', { className: 'ofm_sec' },
        h('div', { className: 'ofm_sechead' },
          h('span', { className: 'ofm_sec_title' }, props.title),
          props.hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, props.hint)),
        props.children)
    }

    function Panel(props) {
      return h('div', { className: 'ofm_panel' },
        props.title === undefined ? null : h('div', { className: 'ofm_paneltitle' }, props.title, props.hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, props.hint)),
        props.children)
    }

    // ── charts (hand-drawn SVG; the shell ships no plotting primitive) ────────
    function Heatmap(props) {
      const { days, t } = props
      const cells = useMemo(() => buildHeatCells(days), [days])
      const peak = cells.reduce((max, cell) => Math.max(max, cell.total), 0)
      if (cells.length === 0) return h('p', { className: 'ofm_note' }, t('heat.empty'))
      const level = value => value === 0 ? '' : peak === 0 ? '' : value / peak > 0.66 ? 'l4' : value / peak > 0.4 ? 'l3' : value / peak > 0.16 ? 'l2' : 'l1'
      return h(Fragment, null,
        h('div', { className: 'ofm_heat', role: 'img', 'aria-label': t('heat.title') },
          cells.map((cell, index) => h('div', {
            key: `${cell.day}-${index}`,
            className: 'ofm_cell ' + level(cell.total),
            title: `${cell.day} · ${cell.total.toLocaleString()} tokens${cell.models.length ? ` · ${cell.models.join(', ')}` : ''}`,
          }))),
        h('div', { className: 'ofm_scale' }, t('heat.legend'),
          ['l1', 'l2', 'l3', 'l4'].map(cls => h('span', { key: cls, className: `ofm_cell ${cls}` })),
          t('heat.legendMore')))
    }

    /** Column-major local-calendar weeks, from Sunday through today (17 weeks by default). */
    function buildHeatCells(days, span = 119) {
      if (days.length === 0) return []
      const byDay = new Map(days.map(row => [row.day, row]))
      const end = new Date()
      // Noon avoids midnight DST transitions shifting subsequent dates to 01:00.
      end.setHours(12, 0, 0, 0)
      const cells = []
      const start = new Date(end)
      start.setDate(start.getDate() - end.getDay() - (Math.ceil(span / 7) - 1) * 7)
      for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
        const row = byDay.get(key)
        cells.push({ day: key, total: row?.total ?? 0, models: (row?.models ?? []).filter(m => m.output > 0).map(m => m.model) })
      }
      return cells
    }

    function TrendChart(props) {
      const { series, metric, mode } = props
      const width = 900
      const height = 168
      const pad = { top: 12, right: 8, bottom: 18, left: 40 }
      const rows = series.length === 0 ? [{ day: '', total: 0 }] : series
      const valueOf = row => mode === 'requests'
        ? row.models.reduce((sum, m) => sum + m.calls, 0)
        : metric === 'total' ? row.total : (row.models.find(m => m.model === metric)?.output ?? 0)
      const points = rows.map((row, index) => ({ x: rows.length === 1 ? width / 2 : pad.left + (index / (rows.length - 1)) * (width - pad.left - pad.right), y: 0, value: valueOf(row), day: row.day }))
      const peak = Math.max(1, ...points.map(p => p.value))
      for (const point of points) point.y = pad.top + (1 - point.value / peak) * (height - pad.top - pad.bottom)
      const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
      const area = `${line} L${points[points.length - 1].x.toFixed(1)},${height - pad.bottom} L${points[0].x.toFixed(1)},${height - pad.bottom} Z`
      const color = metric === 'total' ? 'var(--dsw-alias-state-business-primary)' : (props.color ?? 'var(--dsw-alias-state-business-primary)')
      const ticks = [0, 0.5, 1].map(frac => ({ y: pad.top + frac * (height - pad.top - pad.bottom), label: kilo(peak * (1 - frac)) }))
      return h('svg', { className: 'ofm_svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img' },
        h('defs', null, h('linearGradient', { id: 'ofmFill', x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { offset: '0%', 'stop-color': color, 'stopOpacity': '0.32' }),
          h('stop', { offset: '100%', 'stop-color': color, 'stopOpacity': '0.02' }))),
        ticks.map(tick => h('g', { key: tick.y },
          h('line', { x1: pad.left, x2: width - pad.right, y1: tick.y, y2: tick.y, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1, strokeDasharray: tick.label === '0' ? undefined : '3 4' }),
          h('text', { x: pad.left - 6, y: tick.y + 3.5, textAnchor: 'end', fontSize: 9.5, fill: 'var(--dsw-alias-label-tertiary)' }, tick.label))),
        h('path', { d: area, fill: 'url(#ofmFill)' }),
        h('path', { d: line, fill: 'none', stroke: color, strokeWidth: 1.9, strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' }),
        rows.length > 1 ? [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]].map((row, i) => h('text', {
          key: `x${i}`,
          x: points[Math.min(points.length - 1, Math.round((i === 0 ? 0 : i === 1 ? (rows.length - 1) / 2 : rows.length - 1)))].x,
          y: height - 4, textAnchor: i === 0 ? 'start' : i === 2 ? 'end' : 'middle', fontSize: 9.5, fill: 'var(--dsw-alias-label-tertiary)',
        }, row.day.slice(5))) : null)
    }

    function Sparkline(props) {
      const values = props.values
      if (values.length < 2) return h('span', { className: 'ofm_note' }, props.t('speed.none'))
      const width = 150
      const height = 30
      const peak = Math.max(...values, 1)
      const floor = Math.min(...values, 0)
      const span = Math.max(1e-6, peak - floor)
      const line = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${(index / (values.length - 1) * width).toFixed(1)},${(height - ((value - floor) / span) * (height - 4) - 2).toFixed(1)}`).join(' ')
      return h('svg', { className: 'ofm_svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', style: { height } },
        h('path', { d: line, fill: 'none', stroke: props.color ?? 'var(--dsw-alias-state-business-primary)', strokeWidth: 1.6, strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' }))
    }

    // ── model roster ──────────────────────────────────────────────────────────
    function ModelCard(props) {
      const { model: m, t, onBench, bench, locked, eacLogin } = props
      const stateKey = `state.${m.availability}`
      const dim = m.availability !== 'available'
      const rung = (m.budgets ?? []).find(row => row.isDefault === true)
      return h('article', { className: 'ofm_card' + (dim ? ' dim' : '') },
        h('div', { className: 'ofm_cardhead' },
          m.channel === 'eac' ? h('span', { className: 'ofm_chantag', title: t('tag.eacChannel') }, 'EAC') : null,
          m.channel === 'eac' && locked === true ? h('span', { className: 'ofm_chantag', title: t('eac.lockedTitle') }, '🔒') : null,
          m.channel === 'kilo' ? h('span', { className: 'ofm_chantag', title: t('tag.kiloChannel') }, 'Kilo') : null,
          h('span', { className: 'ofm_cardname', title: m.name }, m.name),
          h('span', { className: 'ofm_badge ' + m.availability }, t(stateKey))),
        h('div', { className: 'ofm_id', title: m.id }, m.id),
        h('div', { className: 'ofm_tags' },
          h('span', { className: 'ofm_tag' }, m.vision ? t('tag.vision') : t('tag.text')),
          m.reasoning ? h('span', { className: 'ofm_tag' }, m.canDisableThinking === false ? t('tag.thinkingShared') : t('tag.thinking')) : null,
          h('span', { className: 'ofm_tag' }, `${t('tag.context')} ${kilo(m.contextWindow)}`),
          h('span', { className: 'ofm_tag' }, `${t('tag.output')} ${kilo(m.maxOutput)}`),
          rung === undefined ? null : h('span', { className: 'ofm_tag', title: t('tag.rungTitle').replace('{ladder}', m.budgets.map(row => `${row.name} ${kilo(row.tokens)}`).join(' · ')) },
            `${t('tag.rung')} ${kilo(rung.tokens)}`)),
        m.channel === 'eac' && locked === true
          ? h(Fragment, null,
            h('p', { className: 'ofm_note' }, t('eac.lockedNote')),
            eacLogin === undefined ? null : h('div', { className: 'ofm_row' },
              h(Button, { kind: 'primary', disabled: eacLogin.busy || eacLogin.pending !== null, onClick: eacLogin.login },
                eacLogin.busy ? t('eac.starting') : t('eac.login'))))
          : null,
        m.availability === 'listed' ? h('p', { className: 'ofm_note' }, t('hint.listed'))
          : m.availability === 'access-restricted' ? h('p', { className: 'ofm_note', title: m.detail ?? '' }, t('hint.access'))
          : m.availability === 'region-blocked' ? h('p', { className: 'ofm_note' }, t('hint.region'))
          : m.availability === 'unknown' ? h('p', { className: 'ofm_note' }, t('hint.unknown'))
            : m.availability === 'unavailable' ? h('p', { className: 'ofm_note', title: m.detail ?? '' }, t('hint.hidden'))
              : h('div', { className: 'ofm_metrics' },
                m.ttftMs === undefined || m.ttftMs === 0 ? null : h('span', null, t('tag.latency'), ' ', h('b', null, Math.round(m.ttftMs)), ' ms'),
                h('span', null, t('pref.probedAt'), ' ', h('b', null, ago(m.probedAt, t.locale)))),
        m.canDisableThinking === false ? h('p', { className: 'ofm_note' }, t('hint.sharedBudget')) : null,
        onBench === undefined ? null : h('div', { className: 'ofm_row' },
          h(Button, { disabled: bench?.running === true, onClick: () => onBench(m) }, bench?.running === true ? t('bench.running') : t('bench.run')),
          bench?.result === undefined ? null : h('span', { className: 'ofm_note' }, bench.result)))
    }

    function Roster(props) {
      const { summary, t, onBench, benches, auth, eacLogin, only } = props
      // `only` splits the same roster across the two model pages: the EAC page
      // shows the co-paid entries, the free page everything else. Filtering
      // here (rather than in each page) keeps one definition of what a route
      // group means.
      const roster = only === undefined ? summary.catalog
        : only === 'eac' ? summary.catalog.filter(m => m.channel === 'eac')
          : summary.catalog.filter(m => m.channel !== 'eac')
      const routable = roster.filter(m => m.route === 'our-free-model' || (only === 'eac' && m.channel === 'eac'))
      const available = routable.filter(m => m.availability === 'available')
      const listed = routable.filter(m => m.availability !== 'available' && m.availability !== 'access-restricted')
      const limited = roster.filter(m => m.route === 'our-free-model-region')
      const restricted = roster.filter(m => m.availability === 'access-restricted')
      // 只有拿到过明确判定（网关答过 /eac/status）且未授权时才上锁：状态未知
      // 不该显示一把凭空的锁，网关不可达时本地记录仍算已授权。
      const locked = auth !== undefined && auth.available === true && auth.authorized !== true
      const group = (title, list, hint) => list.length === 0 ? null
        : h('div', { className: 'ofm_sec', style: { gap: 8 } },
          h('div', { className: 'ofm_row' }, h('span', { className: 'ofm_sec_title', style: { fontSize: 12.5 } }, title),
            hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, hint)),
          h('div', { className: 'ofm_grid' }, list.map(m => h(ModelCard, {
            key: m.id, model: m, t, onBench: m.availability === 'access-restricted' ? undefined : onBench, locked: m.channel === 'eac' && locked, eacLogin,
            bench: { running: benches[m.id]?.running === true, ...benches[m.id]?.result === undefined ? {} : { result: benches[m.id].result } },
          }))))
      // The lane closed at the gate is the one "no EAC models" case the page can
      // explain without a log (issue #60): on a host the kernel gave no profile,
      // the group never renders and nothing else on the page names the reason.
      const laneNote = summary.laneAvailable === false && !summary.catalog.some(m => m.channel === 'eac')
        ? h('p', { className: 'ofm_note' }, t('roster.noLane')) : null
      // 暂不可用的模型不再单独成组展示（用户要求移除「不在选择器中」区块）：
      // 它们的状态仍在上方统计芯片与每张卡的徽章里如实可见。
      return h(Fragment, null,
        laneNote,
        group(t('state.available'), available),
        group(t('state.listed'), listed, t('hint.listed')),
        group(t('state.region-blocked'), limited, t('hint.region')),
        group(t('state.access-restricted'), restricted, t('hint.access')))
    }

    // ── dashboard ─────────────────────────────────────────────────────────────
    // ── pool panel (co-paid lane capacity & live pressure) ────────────────────
    // Numbers come from the gateway through the plugin backend (/pool), which
    // is the only place the sealed gateway URL exists. All of them are real:
    // capacity is the operator's actual provisioning rule (stars × 1.5, or a
    // configured count), and the load verdict — 畅通 / 繁忙 / 过载 — is computed
    // by the gateway process itself from its in-flight streams and event-loop
    // saturation, so the panel and the server can never disagree about the
    // color. The panel renders nothing at all when the host has no lane or the
    // gateway is dark — a gauge that lies would be worse than no gauge.
    const POOL_REPO_URL = 'https://github.com/Ebony-Vinyl/dsh-our-free-model'
    const FISH_PATH = 'M1 7c2.5-3.5 7-5 11-3.2L18.5 1v12L12 10.2C8 12 3.5 10.5 1 7zm16.4 0l5.1-3.4v6.8L17.4 7zM8.4 5.6a1 1 0 11-2 0 1 1 0 012 0z'

    /**
     * The aquarium itself: water level, waves, bubbles, three fish and a glass
     * frame. It is deliberately a *pure* visual — every page that shows one
     * decides what the level means (free lane: share of models reachable;
     * EAC lane: the co-paid pool's 24h pressure), because a tank whose meaning
     * changes with the caller is the only way to put the same object at the top
     * of two pages without either one lying about its numbers.
     */
    function Tank(props) {
      const { pct, level = 'ok', size, label } = props
      const fish = ['f1', 'f2', 'f3'].map(name => h('i', { className: `ofm_fish ${name}`, key: name },
        h('svg', { viewBox: '0 0 24 14' }, h('path', { d: FISH_PATH }))))
      const bubbles = ['b1', 'b2', 'b3', 'b4', 'b5'].map(name => h('i', { className: `ofm_bubble ${name}`, key: name }))
      if (pct === null || pct === undefined) return null
      return h('div', {
        className: `ofm_tank ${level}${size === 'xl' ? ' xl' : ''}`,
        role: 'img',
        'aria-label': label ?? `${pct}%`,
        style: { '--lvl': `${Math.max(0, Math.min(100, pct))}%` },
      },
        h('div', { className: 'ofm_tankwater' },
          h('div', { className: 'ofm_tankdeep' }, ...bubbles, ...fish),
          h('i', { className: 'ofm_wave w1' }),
          h('i', { className: 'ofm_wave w2' })),
        h('i', { className: 'ofm_tankrays' }),
        h('i', { className: 'ofm_tankshine' }),
        h('div', { className: 'ofm_tankglass' }))
    }

    /**
     * The co-paid pool snapshot, shared by the EAC page's tank and its detail
     * panel. One hook so the page and the panel never disagree: both read the
     * same 30-second poll. `pool === undefined` means "still loading", `null`
     * means "the host has no lane or the gateway is dark" — the caller decides
     * whether that is a muted line or nothing at all.
     */
    function usePool() {
      const [pool, setPool] = useState(undefined)
      const [poolError, setPoolError] = useState('')
      useEffect(() => {
        let alive = true
        // The gateway can be slow under exactly the load this panel reports;
        // the 8s api() default would abort while the backend is still waiting.
        const load = () => api('/pool', { timeout: 25_000 })
          .then(data => {
            if (!alive) return
            setPool(data?.pool != null ? data : null)
            setPoolError('')
          })
          .catch(error => {
            if (!alive) return
            setPool(null)
            // The backend tags the failure with a fixed reason code; map it to
            // readable text instead of hiding the panel in silence.
            const code = /\(([^)]+)\)\s*$/.exec(String(error?.message ?? ''))?.[1] ?? ''
            setPoolError(code)
          })
        load()
        const timer = setInterval(load, 30_000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      return { pool, poolError }
    }

    /** The pool's load verdict and the numbers behind it, from one snapshot. */
    function poolReading(pool) {
      const active = Number.isFinite(pool.active24h) ? pool.active24h : null
      const capacityKnown = Number.isFinite(pool.pool) && pool.pool > 0
      // Two readings, on purpose: the tank cannot hold more than full, but the
      // page must not round a pool running at 147% of its provisioned capacity
      // down to "100%" — that reads as "exactly at capacity", which is a
      // different, calmer sentence than what the gateway is saying.
      const rawPct = capacityKnown && active !== null ? Math.round(100 * active / pool.pool) : null
      const pct = rawPct === null ? null : Math.max(0, Math.min(100, rawPct))
      // A gateway build that predates the level verdict answers without one.
      // The plugin then applies the same default thresholds locally, so an
      // upgraded panel never reads a calm color off an unupgraded server —
      // and once the gateway does send its verdict, that one wins.
      const level = pool.level === 'over' || (pool.level === undefined && pool.inflight >= 80) ? 'over'
        : pool.level === 'busy' || (pool.level === undefined && pool.inflight >= 30) ? 'busy' : 'ok'
      return { active, capacityKnown, pct, rawPct, level }
    }

    /** The repository every page's star button points at, opened in a new tab. */
    function StarButton(props) {
      const { t, repo = POOL_REPO_URL } = props
      const label = t('star.cta')
      return h('a', {
        className: 'ofm_starbtn',
        href: `https://github.com/${repo.replace(/^https?:\/\/github\.com\//, '')}`,
        target: '_blank',
        rel: 'noreferrer noopener',
        title: `${t('star.title')} · ${repo}`,
      }, h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', { d: 'M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z' })),
        label)
    }
    /** Where the pool's capacity number comes from, in one sentence. */
    function capacityText(pool, t) {
      if (pool.poolSource === 'formula') return t('pool.formula').replace('{stars}', String(pool.stars ?? '—'))
      if (pool.poolSource === 'configured') return t('pool.configured')
      return t('pool.capacityUnknown')
    }

    // ── EAC 渠道授权（GitHub 登录 + Star） ────────────────────────────────────
    // 闸门在服务器：网关拒绝没有用户令牌的对话，而这个面板是取得令牌的唯一入口。
    // 三种状态如实呈现——未登录 / 已登录但未 star / 已授权——并且登录全程无需
    // 复制粘贴：后端把授权页交给系统浏览器，前端轮询网关领取令牌。令牌本身从不
    // 到达浏览器，这里只显示登录名与判定结果。
    //
    // 登录流（发起、轮询、busy/notice）住在 SettingsPage 级的 hook 里：页头的
    // 未授权按钮、上锁模型卡的「去授权」和这个面板必须共享同一个进行中的会话，
    // 各挂一份轮询会互相抢令牌的领取权。
    const EAC_LOGIN_TTL = 10 * 60_000
    const EAC_LOGIN_KEY = `ofm.eac.pending:${API}`
    function rememberEacLogin(pending) {
      try {
        if (pending === null) sessionStorage.removeItem(EAC_LOGIN_KEY)
        else sessionStorage.setItem(EAC_LOGIN_KEY, JSON.stringify(pending))
      } catch { /* restricted browser storage: this mounted page can still log in */ }
    }
    function restoreEacLogin() {
      try {
        const value = JSON.parse(sessionStorage.getItem(EAC_LOGIN_KEY))
        if (value !== null && /^[A-Za-z0-9_-]{16,64}$/.test(value.link)
          && typeof value.url === 'string' && /^https?:\/\//.test(value.url)
          && Number.isFinite(value.startedAt) && value.startedAt <= Date.now()
          && Date.now() - value.startedAt < EAC_LOGIN_TTL) return value
      } catch { /* absent or malformed */ }
      rememberEacLogin(null)
      return null
    }
    function useEacLogin({ t, summary, onAuth }) {
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [pending, setPending] = useState(restoreEacLogin)
      const [copied, setCopied] = useState(false)
      const starting = useRef(false)
      const cancelling = useRef(false)
      const attempt = useRef(0)
      const pendingRef = useRef(pending)
      pendingRef.current = pending
      const updatePending = value => {
        pendingRef.current = value
        rememberEacLogin(value)
        setPending(value)
      }
      const refresh = useCallback(() => {
        api('/eac/status', { timeout: 20_000 }).then(onAuth).catch(() => onAuth({ available: true, authorized: false, login: '', unverified: true }))
      }, [onAuth])
      const latest = useRef(summary)
      latest.current = summary
      const latestT = useRef(t)
      latestT.current = t

      // Schedule only after completion: slow gateway responses must not create
      // overlapping collectors. The link survives settings-page remounts.
      useEffect(() => {
        if (pending === null) return undefined
        let alive = true
        let timer
        const poll = async () => {
          const t = latestT.current
          if (!alive || cancelling.current) return
          if (Date.now() - pending.startedAt >= EAC_LOGIN_TTL) {
            updatePending(null); setNotice(t('eac.expired')); return
          }
          try {
            const result = await api(`/eac/login/poll?link=${encodeURIComponent(pending.link)}`, { timeout: 22_000 })
            if (!alive || cancelling.current || pendingRef.current?.link !== pending.link) return
            if (result.status === 'ok') {
              updatePending(null)
              setNotice(t('eac.done').replace('{login}', result.login ?? ''))
              refresh(); latest.current?.reload?.()
              return
            }
            if (result.status === 'expired') {
              updatePending(null); setNotice(t('eac.sessionExpired')); return
            }
            if (result.status === 'unstarred') setNotice(t('eac.needStar').replace('{login}', result.login ?? ''))
            else setNotice('')
          } catch (error) {
            if (!alive || cancelling.current || pendingRef.current?.link !== pending.link) return
            const reason = String(error?.message ?? '')
            if (reason === 'cancelled') { updatePending(null); setNotice(''); return }
            // Never render response HTML, URL or credentials as diagnostics.
            const safe = /^gateway-http-\d{3}$/.test(reason) ? `HTTP ${reason.slice(-3)}`
              : ['unreachable', 'malformed', 'not-writable', 'cancelled', 'no-lane', 'bad-link', 'timeout'].includes(reason) ? reason : 'unreachable'
            setNotice(reason === 'not-writable' ? t('eac.saveFailed') : t('eac.pollFailed').replace('{reason}', safe))
          }
          if (alive && pendingRef.current?.link === pending.link) timer = setTimeout(poll, 2500)
        }
        timer = setTimeout(poll, 2500)
        return () => { alive = false; clearTimeout(timer) }
      }, [pending, refresh])

      const cancel = async () => {
        const currentPending = pendingRef.current
        if (currentPending === null || cancelling.current) return
        cancelling.current = true
        attempt.current++; setBusy(true)
        try {
          const result = await post(`/eac/login/cancel?link=${encodeURIComponent(currentPending.link)}`)
          if (result.ok !== true && result.status !== 'ok') throw new Error('cancellation unconfirmed')
          updatePending(null)
          if (result.status === 'ok') {
            setNotice(latestT.current('eac.done').replace('{login}', result.login ?? ''))
            refresh(); latest.current?.reload?.()
          } else setNotice('')
        } catch {
          const t = latestT.current
          setNotice(t('eac.cancelFailed'))
          // A failed cancellation must retain the link and restart the serial
          // loop. The Host may already have saved it or accepted cancellation.
          updatePending({ ...currentPending })
        } finally { cancelling.current = false; setBusy(false) }
      }
      const login = async () => {
        if (starting.current || cancelling.current || pendingRef.current !== null) return
        starting.current = true
        const current = ++attempt.current
        setBusy(true); setNotice('')
        try {
          const started = await post('/eac/login/start', undefined, 20_000)
          if (current !== attempt.current) return
          if (started?.error !== undefined) { setNotice(t('eac.startFailed').replace('{reason}', started.error)); return }
          updatePending({ link: started.link, url: started.url, startedAt: Date.now() })
          if (started.opened !== true) setNotice(t('eac.openManually'))
        } catch (error) {
          if (current === attempt.current) setNotice(t('eac.startFailed').replace('{reason}', 'unreachable'))
        } finally { starting.current = false; setBusy(false) }
      }
      const logout = async () => {
        attempt.current++; updatePending(null); setBusy(true)
        try {
          await post('/eac/logout')
          refresh(); latest.current?.reload?.()
        } catch { setNotice(t('eac.startFailed').replace('{reason}', 'unreachable')) } finally { setBusy(false) }
      }
      return { busy, notice, pending, copied, setCopied, refresh, login, logout, cancel }
    }

    function EacAuth(props) {
      const { t, auth, eacLogin } = props
      const { busy, notice, pending, copied, setCopied, refresh, login, logout, cancel } = eacLogin

      if (auth === undefined) return h('p', { className: 'ofm_note' }, t('loading'))
      if (auth.available !== true) return h('p', { className: 'ofm_note' }, t('eac.noLane'))
      const repo = auth.repo !== undefined && auth.repo !== '' ? auth.repo : 'Ebony-Vinyl/dsh-our-free-model'
      return h(Fragment, null,
        h('div', { className: 'ofm_row' },
          auth.authorized === true
            ? h(Pill, { strong: true, tone: 'ok' }, t('eac.pillOk'))
            : h(Pill, { strong: true, tone: 'warn' }, t('eac.pillLocked')),
          auth.required === true ? h(Pill, { tone: 'err' }, t('eac.pillRequired')) : h(Pill, null, auth.required === false ? t('eac.pillCompat') : t('eac.pillUnknown')),
          auth.unverified === true ? h(Pill, { tone: 'warn' }, t('eac.pillUnverified')) : null),
        h('p', { className: 'ofm_note' }, t('eac.intro').replace('{repo}', repo)),
        auth.authorized === true
          ? h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, t('eac.loggedIn').replace('{login}', auth.login !== '' && auth.login !== undefined ? auth.login : '—').replace('{when}', ago(auth.lastCheck, t.locale))),
            h(Button, { disabled: busy, onClick: refresh }, t('eac.recheck')),
            h(Button, { disabled: busy, onClick: logout }, t('eac.logout')))
          : h('div', { className: 'ofm_row' },
            h(Button, { kind: 'primary', disabled: busy || pending !== null, onClick: login }, busy ? t('eac.starting') : t('eac.login')),
            h(StarButton, { t, repo })),
        pending !== null
          ? h('div', { className: 'ofm_callout' },
            h('div', null,
              h('div', null, t('eac.waiting')),
              h(Button, { kind: 'ghost', disabled: busy, onClick: cancel }, t('eac.cancel')),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
                h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200, wordBreak: 'break-all' } }, pending.url),
                h(Button, { kind: 'ghost', onClick: () => copy(pending.url, ok => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1600) } }) }, copied ? t('eac.copied') : t('eac.copy')))))
          : null,
        notice !== '' ? h('p', { className: 'ofm_note' }, notice) : null)
    }

    function Dashboard(props) {
      const { stats, t } = props
      const days = useMemo(() => [...stats.days].sort((a, b) => a.day.localeCompare(b.day)), [stats.days])
      const recent = [...(stats.samples ?? [])].slice(-40)
      // 「最近一回合」跟着一个轻量轮询走（#26）：看板其余部分仍是页面加载时的
      // 快照，这一行单独刷新，让「刚发完一条消息」的用户不用整页重载就能看到
      // 这一回合的 token 去向。聊天窗属于宿主内核，插件无法在对话流里注入，
      // 这是插件表面能做到的最接近实时的位置。
      const [fresh, setFresh] = useState(null)
      useEffect(() => {
        let alive = true
        const timer = setInterval(() => api('/stats').then(data => { if (alive) setFresh(data) }).catch(() => {}), 60_000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      // The host already dropped the windows it could not measure and took out of
      // the numerator the tokens it never streamed. Averaging per-call rates
      // instead let one 1 ms window publish 63 000 tok/s and carry the whole card
      // to 2 493.
      const streamed = recent.filter(sample => sample.decodeMs > 0 && sample.tps !== null)
      const streamMs = streamed.reduce((sum, sample) => sum + sample.decodeMs, 0)
      const weightedTps = streamMs > 0
        ? streamed.reduce((sum, sample) => sum + (sample.decodeTokens ?? 0), 0) / (streamMs / 1000)
        : null
      const latencies = recent.filter(sample => sample.ttftMs !== null && sample.ttftMs !== undefined)
      const models = stats.models ?? []
      const [mode, setMode] = useState('tokens')
      const [metric, setMetric] = useState('total')

      const cumulative = useMemo(() => {
        let tokenRun = 0
        let requestRun = 0
        return days.map(row => {
          tokenRun += row.total
          requestRun += row.models.reduce((sum, m) => sum + m.calls, 0)
          return { ...row, total: mode === 'requests' ? requestRun : tokenRun }
        })
      }, [days, mode])

      const active = metric === 'total' ? undefined : models.find(m => m.model === metric)
      const color = metric === 'total'
        ? 'var(--dsw-alias-state-business-primary)'
        : SEASON[Math.max(0, models.findIndex(m => m.model === metric)) % SEASON.length]

      const headline = h('div', { className: 'ofm_stats' },
        stat(kilo(stats.grand.input + stats.grand.output), t('curve.tokens')),
        stat(kilo(stats.grand.output), t('stat.output')),
        stat(kilo(stats.grand.reasoning), t('stat.reasoning')),
        stat(String(stats.requests ?? 0), t('speed.calls')),
        stat(String(stats.requestFailures ?? stats.grand.failed ?? 0), t('speed.failed')),
        stat(String(stats.turns ?? stats.grand.turns ?? 0), t('speed.turns')),
        stat(String(stats.failedTurns ?? stats.grand.failedTurns ?? 0), t('speed.turnFailed')),
        stat(String(stats.recoveredTurns ?? stats.grand.recoveredTurns ?? 0), t('speed.recovered')))

      const heatmap = h(Panel, { title: t('heat.title') }, h(Heatmap, { days, t }))

      const legend = h('div', { className: 'ofm_chips' },
        chip(t('curve.total'), metric === 'total', SEASON[0], () => setMetric('total')),
        models.map((m, index) => chip(m.name, metric === m.model, SEASON[index % SEASON.length], () => setMetric(m.model))))

      const curve = h(Panel, { title: t('curve.title') },
        h('div', { className: 'ofm_row' },
          h('div', { className: 'ofm_seg' },
            segButton(t('curve.tokens'), mode === 'tokens', () => setMode('tokens')),
            segButton(t('curve.requests'), mode === 'requests', () => setMode('requests'))),
          legend),
        h(TrendChart, { series: cumulative, mode, metric, color }),
        active === undefined ? null : h('p', { className: 'ofm_note' },
          active.name, ' · ', String(active.calls), ' ', t('speed.calls'),
          active.tps === null || active.tps === undefined ? null : ' · ',
          active.tps === null || active.tps === undefined ? null : `${active.tps} ${t('unit.tokPerSec')}`))

      // 最近一回合（#26）：取最新一条调用样本，输入/输出 token、首帧、速度，
      // 失败的调用也如实标出。数据源优先用轮询到的新快照，退回页面加载时的。
      const lastSample = (fresh?.samples ?? stats.samples ?? []).slice(-1)[0] ?? null
      const nameOfModel = id => models.find(m => m.model === id)?.name ?? id
      const agoOf = at => {
        const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
        if (seconds < 60) return t('last.justNow')
        if (seconds < 3600) return t('last.minAgo').replace('{n}', String(Math.floor(seconds / 60)))
        if (seconds < 86400) return t('last.hourAgo').replace('{n}', String(Math.floor(seconds / 3600)))
        return t('last.dayAgo').replace('{n}', String(Math.floor(seconds / 86400)))
      }
      const originOf = value => ({ chat: t('last.originChat'), harness: t('last.originHarness'), forward: t('last.originForward'), bench: t('last.originBench') })[value] ?? String(value ?? '')
      const lastTurnStrip = lastSample === null ? null : h('div',
        { className: 'ofm_row', style: { flexWrap: 'wrap', gap: 14, alignItems: 'baseline', paddingBottom: 10, marginBottom: 12, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        h('b', { style: { fontSize: 13 } }, t('last.title')),
        h('b', { style: { fontSize: 13 } }, nameOfModel(lastSample.model)),
        h('span', { className: 'ofm_note' },
          `${originOf(lastSample.origin)} · ${t('last.input')} ${kilo(lastSample.input)} · ${t('col.output')} ${kilo(lastSample.output)} tok`
          + (lastSample.ttftMs != null ? ` · ${t('speed.ttft')} ${Math.round(lastSample.ttftMs)} ${t('unit.ms')}` : '')
          + (lastSample.tps != null ? ` · ${t('speed.tps')} ${Math.round(lastSample.tps)} ${t('unit.tokPerSec')}` : '')
          + (lastSample.ok === false ? ` · ${t('speed.failed')}` : '')),
        h('span', { className: 'ofm_note', style: { marginLeft: 'auto' } }, agoOf(lastSample.at)))

      const speed = h(Panel, { title: t('speed.title'), hint: recent.length + ' ' + t('speed.calls') },
        recent.length === 0
          ? h('p', { className: 'ofm_note' }, t('speed.none'))
          : h(Fragment, null,
            lastTurnStrip,
            h('div', { className: 'ofm_row', style: { gap: 24 } },
              sparkCell(t('speed.tps'), streamed.map(s => s.tps), SEASON[0], value => Math.round(value) + ' ' + t('unit.tokPerSec'), t, weightedTps),
              sparkCell(t('speed.ttft'), latencies.map(s => s.ttftMs), SEASON[2], value => Math.round(value) + ' ' + t('unit.ms'), t),
              sparkCell(t('stat.output'), recent.map(s => s.output), SEASON[1], value => kilo(value) + ' tok', t)),
            h('p', { className: 'ofm_note' }, t('speed.note')
              .replace('{n}', String(streamed.length))
              .replace('{total}', String(recent.length)))))

      const table = models.length === 0 ? null : h(Panel, { title: t('speed.model') },
        h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
          h('thead', null, h('tr', null,
            h('th', null, t('speed.model')),
            num(t('speed.calls')), num(t('speed.turns')), num(t('speed.recovered')),
            num(t('speed.tps')), num(t('speed.ttft')), num(t('col.reason')),
            num(t('col.output')), num(t('speed.failed')), num(t('speed.turnFailed')))),
          h('tbody', null, [...models].sort((a, b) => b.output - a.output).map(m => h('tr', { key: m.model },
            h('td', { title: m.model }, m.name),
            numTd(m.calls),
            numTd(m.turns),
            numTd(m.recoveredTurns === 0 ? '—' : m.recoveredTurns),
            numTd(m.tps),
            numTd(m.avgTtftMs === null || m.avgTtftMs === undefined ? null : Math.round(m.avgTtftMs)),
            numTd(kilo(m.reasoning)),
            numTd(kilo(m.output)),
            numTd(m.failed === 0 ? '—' : m.failed),
            numTd(m.failedTurns === 0 ? '—' : m.failedTurns)))))))

      const historyNote = stats.logicalEstimated || stats.requestFailuresEstimated
        ? h('p', { className: 'ofm_note' }, t('speed.estimated'))
        : null
      return h(Fragment, null, headline, h('p', { className: 'ofm_note' }, t('speed.scope')), historyNote,
        h('div', { className: 'ofm_two' }, heatmap, curve), speed, table)
    }

    const sparkCell = (label, values, color, format, t, summary) => {
      const shown = summary !== undefined ? summary : values.length < 2 ? null : avg(values)
      return h('div', { className: 'ofm_sec', style: { gap: 2 } },
        h('span', { className: 'ofm_note' }, label),
        h(Sparkline, { values, color, t }),
        h('b', { style: { fontSize: 15 } }, shown === null ? '—' : format(shown)))
    }

    const stat = (value, label) => h('div', { className: 'ofm_stat' }, h('b', null, value), h('span', null, label))
    const num = label => h('th', { className: 'ofm_num' }, label)
    const numTd = value => h('td', { className: 'ofm_num' }, value === null || value === undefined ? '—' : value)
    const avg = list => list.length === 0 ? 0 : list.reduce((a, b) => a + b, 0) / list.length
    const segButton = (label, on, onClick) => h('button', { type: 'button', 'aria-pressed': on ? 'true' : 'false', onClick }, label)
    const chip = (label, on, color, onClick) => h('button', { type: 'button', className: 'ofm_chip', 'aria-pressed': on ? 'true' : 'false', onClick, style: on ? { color } : undefined },
      h('span', { className: 'ofm_swatch', style: { background: color } }), label)

    // ── forward listener ──────────────────────────────────────────────────────
    function Forward(props) {
      const { settings, t, onApply, busy } = props
      const [draft, setDraft] = useState(settings.forward)
      useEffect(() => setDraft(settings.forward), [settings.forward?.enabled, settings.forward?.host, settings.forward?.port, settings.forward?.lan?.enabled, settings.forward?.lan?.port, settings.forward?.lan?.running])
      const [key, setKey] = useState('')
      const [shown, setShown] = useState(false)
      const [copied, setCopied] = useState('')
      useEffect(() => {
        if (draft?.running !== true) return
        let alive = true
        api('/forward/key').then(payload => { if (alive) setKey(payload.key ?? '') }).catch(() => {})
        return () => { alive = false }
      }, [draft?.running])
      const port = draft?.actualPort ?? draft?.port ?? 0
      const base = `http://${draft?.host || '127.0.0.1'}:${port}/v1`
      const doCopy = (label, value) => copy(value, ok => {
        if (!ok) return
        setCopied(label)
        setTimeout(() => setCopied(''), 1600)
      })
      const curl = `curl ${base}/chat/completions \\\n  -H "authorization: Bearer ${shown && key !== '' ? key : '<API KEY>'}" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"<model id>","messages":[{"role":"user","content":"hi"}]}'`

      // The relay is a door of its own: its own key, its own liveness, and an
      // address that only exists while it is listening.
      const lan = draft?.lan
      const [lanKey, setLanKey] = useState('')
      const [lanShown, setLanShown] = useState(false)
      useEffect(() => {
        if (lan?.running !== true) return
        let alive = true
        api('/forward/lan/key').then(payload => { if (alive) setLanKey(payload.key ?? '') }).catch(() => {})
        return () => { alive = false }
      }, [lan?.running])
      const lanPort = lan?.actualPort ?? lan?.port ?? 0
      // Which address a peer should dial is a property of this machine's
      // interfaces, and they move under the panel: a laptop that changed networks,
      // woke from sleep, or brought a VPN up holds a different set than it did a
      // minute ago — and the stale one is exactly the one the user copies to the
      // other machine. So while the relay is on this polls the addresses
      // themselves, at the same 15 s cadence the outlet's node reading uses,
      // instead of trusting the snapshot that shipped with the settings.
      const lanLive = useAsync(() => api('/forward/lan/addresses'), [lan?.running])
      const reloadLanAddresses = lanLive.reload
      useEffect(() => {
        if (lan?.running !== true) return undefined
        const timer = setInterval(() => reloadLanAddresses(), 15_000)
        return () => clearInterval(timer)
      }, [lan?.running, reloadLanAddresses])
      const lanHosts = lanLive.data?.addresses ?? lan?.addresses ?? []
      const lanHost = lanHosts[0] ?? ''
      const lanUrl = lanHost === '' ? t('forward.lanNoAddress') : `http://${lanHost}:${lanPort}/v1`
      const lanToggle = current => ({ ...current, lan: { ...(current?.lan ?? {}), enabled: !(current?.lan?.enabled === true) } })

      return h(Panel, null,
        h('div', { className: 'ofm_row' },
          h(Switch, { checked: draft?.enabled === true, label: t('forward.enabled'), onChange: () => setDraft(current => ({ ...current, enabled: !(current?.enabled === true) })) }),
          h('span', { className: 'ofm_pill' }, h('span', { className: `ofm_dot ${draft?.running === true ? 'ok' : draft?.error ? 'err' : ''}` }), draft?.running === true ? t('forward.running') : t('forward.stopped'))),
        h('div', { className: 'ofm_row' },
          field(t('forward.host'), h('input', { className: 'ofm_input', style: { maxWidth: 150 }, value: draft?.host ?? '127.0.0.1', onChange: e => setDraft(c => ({ ...c, host: e.target.value })) })),
          field(t('forward.port'), h('input', { className: 'ofm_input', style: { maxWidth: 110 }, inputMode: 'numeric', value: draft?.port ?? '', onChange: e => setDraft(c => ({ ...c, port: Number(e.target.value.replace(/\D/g, '')) || 0 })) })),
          h(Button, { kind: 'primary', disabled: busy || draft?.enabled === undefined, onClick: () => onApply({ forward: { enabled: draft.enabled === true, host: draft.host, port: draft.port } }) }, t('forward.apply'))),
        draft?.error ? h('div', { className: 'ofm_callout ofm_error' }, t('forward.error').replace('{message}', draft.error)) : null,
        draft?.notice ? h('div', { className: 'ofm_callout' }, t('forward.notice').replace('{message}', draft.notice)) : null,
        draft?.running === true ? h(Fragment, null,
          h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, t('forward.baseUrl')),
            h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200 } }, base),
            h(Button, { kind: 'ghost', onClick: () => doCopy('base', base) }, copied === 'base' ? t('forward.copied') : t('forward.copy'))),
          h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, t('forward.key')),
            h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200, letterSpacing: shown ? 0 : 1 } }, key === '' ? '…' : shown ? key : '•'.repeat(24)),
            h(Button, { kind: 'ghost', onClick: () => setShown(value => !value) }, shown ? t('forward.hide') : t('forward.show')),
            h(Button, { kind: 'ghost', onClick: () => doCopy('key', key) }, copied === 'key' ? t('forward.copied') : t('forward.copy')),
            h(Button, { kind: 'ghost', title: t('forward.rotateWarn'), onClick: async () => { const payload = await post('/forward/rotate'); setKey(payload.key ?? ''); setShown(true) } }, t('forward.rotate'))),
          h('div', { className: 'ofm_sec', style: { gap: 4 } }, h('span', { className: 'ofm_note' }, t('forward.example')),
            h('pre', { className: 'ofm_mono' }, curl),
            h('div', null, h(Button, { kind: 'ghost', onClick: () => doCopy('curl', curl) }, copied === 'curl' ? t('forward.copied') : t('forward.copy'))))) : null,
        h('div', { className: 'ofm_sec', style: { gap: 6, marginTop: 12 } },
          h('div', { className: 'ofm_note' }, t('forward.lanTitle')),
          h('div', { className: 'ofm_row' },
            h(Switch, { checked: lan?.enabled === true, label: t('forward.lanEnabled'), onChange: () => setDraft(lanToggle) }),
            h('span', { className: 'ofm_pill' }, h('span', { className: `ofm_dot ${lan?.running === true ? 'ok' : lan?.error ? 'err' : ''}` }), lan?.running === true ? t('forward.lanRunning') : t('forward.lanStopped'))),
          h('div', { className: 'ofm_row' },
            field(t('forward.lanPort'), h('input', { className: 'ofm_input', style: { maxWidth: 110 }, inputMode: 'numeric', value: lan?.port ?? 0, onChange: e => setDraft(c => ({ ...c, lan: { ...(c?.lan ?? {}), port: Number(e.target.value.replace(/\D/g, '')) || 0 } })) })),
            h('span', { className: 'ofm_note' }, t('forward.lanAuto')),
            h(Button, { kind: 'primary', disabled: busy, onClick: () => onApply({ forward: { enabled: draft?.enabled === true, host: draft?.host, port: draft?.port, lan: { enabled: lan?.enabled === true, port: lan?.port ?? 0 } } }) }, t('forward.lanApply'))),
          h('div', { className: 'ofm_callout' }, t('forward.lanWarn')),
          h('div', { className: 'ofm_note' }, t('forward.lanHint')),
          lan?.error ? h('div', { className: 'ofm_callout ofm_error' }, t('forward.lanError').replace('{message}', lan.error)) : null,
          lan?.running === true ? h(Fragment, null,
            h('div', { className: 'ofm_row' },
              h('span', { className: 'ofm_note' }, t('forward.lanUrl')),
              h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200 } }, lanUrl),
              h(Button, { kind: 'ghost', onClick: () => doCopy('lanUrl', lanUrl) }, copied === 'lanUrl' ? t('forward.copied') : t('forward.copy'))),
            lanHosts.length > 1 ? h('div', { className: 'ofm_note' }, t('forward.lanAlso').replace('{list}', lanHosts.slice(1).join('    '))) : null,
            h('div', { className: 'ofm_row' },
              h('span', { className: 'ofm_note' }, t('forward.lanKey')),
              h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200, letterSpacing: lanShown ? 0 : 1 } }, lanKey === '' ? '…' : lanShown ? lanKey : '•'.repeat(24)),
              h(Button, { kind: 'ghost', onClick: () => setLanShown(value => !value) }, lanShown ? t('forward.hide') : t('forward.show')),
              h(Button, { kind: 'ghost', onClick: () => doCopy('lanKey', lanKey) }, copied === 'lanKey' ? t('forward.copied') : t('forward.copy')),
              h(Button, { kind: 'ghost', title: t('forward.lanRotateWarn'), onClick: async () => { const payload = await post('/forward/lan/rotate'); setLanKey(payload.key ?? ''); setLanShown(true) } }, t('forward.rotate')))) : null))
    }

    // ── egress outlet ─────────────────────────────────────────────────────────
    // Two ways out: a Clash subscription load-balanced by a spawned mihomo, or
    // one hand-written http/https/socks5 URL. Until this is on AND started,
    // egressFetch sends every request direct — nothing here is load-bearing for
    // plain use. The address is a credential, so it never rides along in the
    // settings payload: this panel shows the masked host and pulls the value
    // itself (`/egress/url`) only when the owner asks to see or copy it.
    function Egress(props) {
      const { settings, t, onApply, busy } = props
      const [draft, setDraft] = useState(settings.egress ?? {})
      useEffect(() => setDraft(settings.egress ?? {}), [settings.egress?.enabled, settings.egress?.mode, settings.egress?.urlLabel, settings.egress?.hasUrl, settings.egress?.active, settings.egress?.error])
      const [urlShown, setUrlShown] = useState(false)
      const [urlValue, setUrlValue] = useState('')
      const [copied, setCopied] = useState('')
      const readUrl = () => api('/egress/url').then(payload => String(payload?.url ?? '')).catch(() => '')
      // Which node url-test is carrying traffic on, and what the last gateway
      // round trip cost. mihomo re-ranks on its own schedule, so while the outlet
      // is on this polls instead of trusting the snapshot that shipped with the
      // settings. `/outlet` reads the controller, so it is only worth calling
      // when an outlet is actually running.
      const live = useAsync(() => api('/outlet'), [settings.egress?.enabled, settings.egress?.active])
      const reloadOutlet = live.reload
      const running = settings.egress?.active === true
      useEffect(() => {
        if (!running) return undefined
        const timer = setInterval(() => reloadOutlet(), 15_000)
        return () => clearInterval(timer)
      }, [running, reloadOutlet])
      const status = running && live.data ? live.data : draft
      const node = typeof status?.node === 'string' ? status.node : ''
      const nodeDelayMs = Number(status?.nodeDelayMs ?? 0)
      const latencyMs = Number(status?.latencyMs ?? 0)
      const subscription = draft?.mode !== 'client'
      const statusLine = text => h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200 } }, text)
      // The stored address is never in the payload this panel was rendered
      // from, so "see it" and "copy it" both cost one on-demand fetch, and the
      // masked form is all this page holds the rest of the time.
      const revealUrl = async () => {
        if (urlShown) { setUrlShown(false); return }
        setUrlValue(await readUrl())
        setUrlShown(true)
      }
      const copyUrl = async () => {
        const value = await readUrl()
        if (value === '') return
        copy(value, ok => {
          if (!ok) return
          setCopied('egressUrl')
          setTimeout(() => setCopied(''), 1600)
        })
      }
      const urlMask = draft?.hasUrl === true ? `${draft?.urlLabel ?? ''}/…` : t('egress.urlNone')
      const apply = () => {
        const patch = { enabled: draft?.enabled === true, mode: subscription ? 'subscription' : 'client', mihomoPath: String(draft?.mihomoPath ?? '') }
        // Empty means "keep the stored address": this panel never received it,
        // so it has nothing to send back, and an empty string would read as
        // "clear it" on the receiving end.
        if (String(draft?.url ?? '') !== '') patch.url = String(draft.url)
        onApply({ egress: patch })
      }
      return h(Panel, null,
        h('div', { className: 'ofm_row' },
          h(Switch, { checked: draft?.enabled === true, label: t('egress.enabled'), onChange: () => setDraft(c => ({ ...c, enabled: !(c?.enabled === true) })) }),
          h('span', { className: 'ofm_pill' }, h('span', { className: `ofm_dot ${draft?.active === true ? 'ok' : draft?.error ? 'err' : ''}` }), draft?.active === true ? t('egress.active') : t('egress.inactive'))),
        h('div', { className: 'ofm_row' },
          h(Switch, { checked: subscription, label: t('egress.modeSubscription'), onChange: () => setDraft(c => ({ ...c, mode: subscription ? 'client' : 'subscription' })) })),
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('egress.url')),
          h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200, letterSpacing: urlShown ? 0 : 1 } },
            urlShown ? (urlValue === '' ? t('egress.urlNone') : urlValue) : urlMask),
          h(Button, { kind: 'ghost', onClick: revealUrl }, urlShown ? t('forward.hide') : t('forward.show')),
          h(Button, { kind: 'ghost', onClick: copyUrl }, copied === 'egressUrl' ? t('forward.copied') : t('forward.copy')),
          // Deleting the address is still a thing the owner may want, and the
          // panel cannot express it by sending back a field it never held — so
          // it says so outright, and the outlet goes down with the credential.
          h(Button, { kind: 'ghost', title: t('egress.urlClearWarn'), disabled: draft?.hasUrl !== true || busy, onClick: () => {
            setUrlShown(false)
            setUrlValue('')
            onApply({ egress: { enabled: false, mode: subscription ? 'subscription' : 'client', mihomoPath: String(draft?.mihomoPath ?? ''), url: '' } })
          } }, t('egress.urlClear'))),
        h('div', { className: 'ofm_row' },
          field(t('egress.urlNew'), h('input', { className: 'ofm_input', style: { flex: 1, minWidth: 260 }, value: draft?.url ?? '', placeholder: t('egress.urlPlaceholder'), onChange: e => setDraft(c => ({ ...c, url: e.target.value })) })),
          h(Button, { kind: 'primary', disabled: busy, onClick: apply }, t('egress.apply'))),
        subscription ? h('div', { className: 'ofm_row' },
          field(t('egress.mihomoPath'), h('input', { className: 'ofm_input', style: { flex: 1, minWidth: 260 }, value: draft?.mihomoPath ?? '', placeholder: 'auto', onChange: e => setDraft(c => ({ ...c, mihomoPath: e.target.value })) })),
          h('span', { className: 'ofm_note' }, t('egress.mihomoHint'))) : null,
        draft?.error ? h('div', { className: 'ofm_callout ofm_error' }, t('egress.error').replace('{message}', draft.error)) : null,
        h('div', { className: 'ofm_note' }, t('egress.direct')),
        running ? h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('egress.outlet')),
          statusLine(`${draft.outlet ?? ''} · ${draft.mode ?? ''}`)) : null,
        running ? h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('egress.node')),
          statusLine(node === '' ? t('egress.measuring') : nodeDelayMs > 0 ? `${node} · ${nodeDelayMs}ms` : node)) : null,
        running ? h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('egress.latency')),
          statusLine(latencyMs > 0 ? `${(latencyMs / 1000).toFixed(2)}s` : t('egress.measuring'))) : null)
    }

    const field = (label, control) => h('label', { className: 'ofm_field' }, h('span', null, label), control)

    // ── preferences ───────────────────────────────────────────────────────────
    function Preferences(props) {
      const { summary, t, onApply, busy } = props
      const settings = summary.settings
      const [draft, setDraft] = useState(settings)
      useEffect(() => setDraft(settings), [summary])
      return h(Panel, null,
        h('div', { className: 'ofm_row', style: { gap: 20 } },
          h(Switch, { checked: settings.enabled !== false, label: t('pref.enabled'), onChange: () => onApply({ enabled: !(settings.enabled !== false) }) }),
          h(Switch, { checked: settings.exposeRegionModels !== false, label: t('pref.exposeRegion'), onChange: () => onApply({ exposeRegionModels: !(settings.exposeRegionModels !== false) }) })),
        h('div', { className: 'ofm_row' },
          field(t('pref.interval'), h('input', { className: 'ofm_input', style: { maxWidth: 100 }, value: draft?.probeIntervalMinutes ?? 15, onChange: e => setDraft(c => ({ ...c, probeIntervalMinutes: Number(e.target.value.replace(/\D/g, '')) || 0 })) })),
          field(t('pref.maxTokens'), h('input', { className: 'ofm_input', style: { maxWidth: 120 }, value: draft?.defaultMaxTokens ?? 32768, onChange: e => setDraft(c => ({ ...c, defaultMaxTokens: Number(e.target.value.replace(/\D/g, '')) || 0 })) })),
          h(Button, { kind: 'primary', disabled: busy, onClick: () => onApply({ probeIntervalMinutes: draft.probeIntervalMinutes, defaultMaxTokens: draft.defaultMaxTokens }) }, t('forward.apply'))),
        h('div', { className: 'ofm_row', style: { gap: 8 } },
          h('span', { className: 'ofm_pill' }, `${t('pref.egress')}: ${summary.egress?.ip ?? '—'}${summary.egress?.country ? ` (${summary.egress.country})` : ''}`),
          h('span', { className: 'ofm_pill' }, `${t('pref.probedAt')}: ${ago(summary.probedAt, t.locale)}`)))
    }

    // ── announcement center ──────────────────────────────────────────────────
    const LEVEL_KEY = { info: 'level.info', update: 'level.update', warn: 'level.warn', urgent: 'level.urgent' }

    function NewsPanel(props) {
      const { t } = props
      const news = useAsync(() => api('/announcements'), [])
      const [busy, setBusy] = useState(false)
      const [osError, setOsError] = useState('')
      // Collapsed by default: the header row carries the status, and the body
      // opens only while there is something unread to read.
      const [open, setOpen] = useState(false)
      const items = news.data?.items ?? []
      const unread = news.data?.unread ?? 0
      useEffect(() => {
        if (unread > 0) setOpen(true)
      }, [unread])
      // Live refresh: the push subscription broadcasts to window on arrival.
      useEffect(() => {
        const handler = () => news.reload()
        window.addEventListener('ofm:announcements', handler)
        return () => window.removeEventListener('ofm:announcements', handler)
      }, [news.reload])
      const notifyOs = news.data?.notifyOs === true
      const ack = async payload => {
        setBusy(true)
        try { await post('/announcements/ack', payload); news.reload() } finally { setBusy(false) }
      }
      const refresh = async () => {
        setBusy(true)
        try { await post('/announcements/refresh', undefined, 60_000); news.reload() } finally { setBusy(false) }
      }
      const enableOs = async () => {
        setOsError('')
        if (typeof Notification === 'undefined') { setOsError(t('news.osDenied')); return }
        let permission = 'default'
        try { permission = await Notification.requestPermission() } catch { permission = Notification.permission }
        if (permission !== 'granted') { setOsError(t('news.osDenied')); return }
        try { await post('/settings', { notifyOs: true }) } catch { /* server state lags; permission is the gate */ }
        news.reload()
      }
      return h(Panel, null,
        h('div', { className: 'ofm_row' },
          unread > 0 ? h('span', { className: 'ofm_pill strong' }, t('news.unread').replace('{n}', String(unread))) : null,
          news.data?.error ? h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot warn' }), t('news.fetchFailed')) : null,
          h('span', { className: 'ofm_pill' }, `${t('news.lastFetch')}: ${ago(news.data?.fetchedAt, t.locale)}`),
          h('span', { className: 'spacer', style: { marginLeft: 'auto' } }),
          h(Button, { kind: 'ghost', onClick: () => setOpen(value => !value) }, open ? t('news.collapse') : t('news.expand')),
          h(Button, { disabled: busy || news.status !== 'ready', onClick: refresh }, busy ? t('news.refreshing') : t('news.refresh'))),
        open ? h(Fragment, null,
          h('div', { className: 'ofm_row' },
            notifyOs
              ? h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot ok' }), t('news.osOn'))
              : h(Button, { onClick: enableOs }, t('news.osEnable')),
            osError !== '' ? h('span', { className: 'ofm_note' }, osError)
              : notifyOs ? null : h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot' }), t('news.osOff')),
            unread > 0 ? h('span', { style: { marginLeft: 'auto' } }, h(Button, { kind: 'ghost', disabled: busy, onClick: () => ack({ all: true }) }, t('news.allRead'))) : null),
          news.status === 'loading' && news.data === undefined ? h('p', { className: 'ofm_note' }, t('loading')) : null,
          news.status === 'error' ? h('p', { className: 'ofm_note' }, news.error) : null,
          news.status === 'ready' && items.length === 0 ? h('p', { className: 'ofm_note' }, t('news.empty'), ' ', h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('news.emptyHint'))) : null,
          h('div', { className: 'ofm_news' }, items.map(item => h(NewsItem, {
            key: item.id, item, t, locale: t.locale, busy,
            onAck: () => ack({ id: item.id }),
          })))) : null)
    }

    function NewsItem(props) {
      const { item, t, locale, busy, onAck } = props
      const body = useMemo(() => parseSafeHtml(item.html ?? ''), [item.html])
      const acknowledged = item.acked === true
      return h('article', { className: 'ofm_newsitem' + (acknowledged ? '' : ' unread') },
        acknowledged ? null : h('span', { className: 'ofm_newsdot', 'aria-hidden': 'true' }),
        h('div', { className: 'ofm_newshead' },
          h('span', { className: 'ofm_level ' + item.level }, t(LEVEL_KEY[item.level] ?? 'level.info')),
          h('span', { className: 'ofm_newstitle' }, item.title),
          acknowledged ? null : h(Button, { kind: 'ghost', disabled: busy, onClick: onAck }, t('news.markRead'))),
        h('div', { className: 'ofm_newsmeta' },
          h('span', null, item.createdAt > 0 ? new Date(item.createdAt).toLocaleDateString() : ''),
          h('span', null, ago(item.createdAt, locale)),
          item.pinned === true ? h('span', null, '📌') : null),
        h('div', { className: 'ofm_newsbody' }, ...htmlToReact(body)),
        item.link?.url ? h('div', null, h('a', { href: item.link.url, target: '_blank', rel: 'noopener noreferrer' }, item.link.label || t('news.link'))) : null)
    }

    // ── in-app upgrade ───────────────────────────────────────────────────────
    function UpgradePanel(props) {
      const { t, settings, onApply, busy } = props
      const status = useAsync(() => api('/update/status'), [])
      const [phase, setPhase] = useState('')
      const [message, setMessage] = useState('')
      const [error, setError] = useState('')
      useEffect(() => {
        const handler = event => {
          const version = event.detail?.version ?? ''
          setPhase('')
          setError('')
          setMessage(version === '' ? '' : t('upgrade.done').replace('{version}', version))
          status.reload()
        }
        window.addEventListener('ofm:upgraded', handler)
        return () => window.removeEventListener('ofm:upgraded', handler)
      }, [status.reload])
      const data = status.data
      const check = async () => {
        setPhase('checking'); setError('')
        try { await post('/update/check', undefined, 60_000); status.reload() } catch (err) { setError(String(err?.message ?? err)) } finally { setPhase('') }
      }
      const applyUpgrade = async () => {
        setPhase('applying'); setError(''); setMessage(t('upgrade.phase.download'))
        try {
          const result = await post('/update/apply', {}, 600_000)
          // Hot reload closes the old SSE connection. The response must finish
          // our local phase even if `upgraded` arrives before reconnection.
          setPhase('')
          setMessage(t('upgrade.phase.install'))
          if (result?.version !== undefined) setMessage(t('upgrade.doneRefresh').replace('{version}', result.version))
          status.reload()
        } catch (err) {
          setPhase(''); setMessage('')
          setError(String(err?.message ?? err))
          status.reload()
        }
      }
      const notes = useMemo(() => parseSafeHtml(data?.notes ?? ''), [data?.notes])
      const upToDate = data !== undefined && data.latest !== '' && data.available === false
        && data.applying !== true && data.recoveryRequired !== true && data.versionMismatch !== true
      return h(Panel, null,
        h('div', { className: 'ofm_upgradecards' },
          h('span', { className: 'ofm_pill strong' }, `${t('upgrade.current')}: ${data?.current || '…'}`),
          data?.installedVersion !== undefined ? h('span', { className: 'ofm_pill' }, `${t('upgrade.installed')}: ${data.installedVersion || '…'}`) : null,
          data?.latest !== undefined && data.latest !== '' ? h('span', { className: 'ofm_pill' }, `${t('upgrade.latest')}: ${data.latest}`) : null,
          data?.available === true ? h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot warn' }), t('upgrade.available').replace('{version}', data.latest)) : null,
          upToDate ? h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot ok' }), t('upgrade.upToDate')) : null,
          h('span', { className: 'ofm_pill' }, `${t('upgrade.checkedAt')}: ${data?.checkedAt ? ago(data.checkedAt, t.locale) : t('upgrade.never')}`)),
        h('div', { className: 'ofm_row' },
          h(Button, { disabled: phase !== '' || status.status !== 'ready', onClick: check }, phase === 'checking' ? t('upgrade.checking') : t('upgrade.check')),
          data?.available === true ? h(Button, { kind: 'primary', disabled: phase !== '' || data.applying === true || data.recoveryRequired === true, onClick: applyUpgrade }, phase === 'applying' ? t('upgrade.applying') : t('upgrade.apply')) : null,
          h('a', {
            className: 'ofm_btn ofm_starlink',
            href: 'https://github.com/Ebony-Vinyl/dsh-our-free-model',
            target: '_blank',
            rel: 'noopener noreferrer',
          }, h('span', { 'aria-hidden': 'true' }, '\u2606'), t('upgrade.star'))),
        phase === 'applying' ? h('div', { className: 'ofm_prog' }, h('i')) : null,
        data?.recoveryRequired === true ? h('div', { className: 'ofm_callout ofm_error' },
          h('div', null, t('upgrade.recovery'),
            data.recoveryBackup ? h('p', { className: 'ofm_note' }, `${t('upgrade.backup')}: ${data.recoveryBackup}`) : null)) : null,
        data?.versionMismatch === true ? h('div', { className: 'ofm_callout' }, t('upgrade.mismatch')) : null,
        message !== '' ? h('p', { className: 'ofm_note' }, message) : null,
        (error || data?.error) ? h('div', { className: 'ofm_callout ofm_error' }, t('upgrade.failed').replace('{message}', error || data.error)) : null,
        notes.length > 0 ? h('div', { className: 'ofm_sec', style: { gap: 4 } },
          h('span', { className: 'ofm_note' }, t('upgrade.notes')),
          h('div', { className: 'ofm_upnotes ofm_newsbody' }, ...htmlToReact(notes))) : null,
        data?.lastApplied !== undefined ? h('p', { className: 'ofm_note' },
          `${t('upgrade.history')}: ${data.lastApplied.ok === true ? '✓' : '✗'} `,
          t('upgrade.from').replace('{from}', data.lastApplied.from ?? '?'),
          ` → ${data.lastApplied.to ?? '?'} · ${ago(data.lastApplied.at, t.locale)}`,
          data.lastApplied.ok === false && data.lastApplied.error ? ` — ${data.lastApplied.error}` : '') : null,
        h('p', { className: 'ofm_note' }, (settings.updateCheckHours ?? 0) > 0 ? t('upgrade.auto').replace('{n}', String(settings.updateCheckHours)) : t('upgrade.autoOff')),
        h('div', { className: 'ofm_row' },
          h(Button, { disabled: phase !== '' || data?.applying === true || data?.recoveryRequired === true, onClick: () => {
            setPhase('reloading'); setError(''); setMessage(t('upgrade.phase.reload'))
            post('/reload').catch(err => { setMessage(''); setError(String(err?.message ?? err)) }).finally(() => { setPhase('') })
          } }, phase === 'reloading' ? t('reload.reloading') : t('reload.now')),
          h(Switch, { checked: settings.autoReloadWatch === true, label: t('reload.auto'), onChange: () => onApply({ autoReloadWatch: !(settings.autoReloadWatch === true) }) }),
          h('span', { className: 'ofm_note' }, t('reload.done').replace('{n}', String(settings.reloadCount ?? 0)))))
    }

    function UpgradePage(props) {
      const { t, settings, onApply, busy } = props
      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('section.upgrade'), sub: t('section.upgradeHint') }),
        h(UpgradePanel, { t, settings, onApply, busy }))
    }

    const BRAND_ICON = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAYEBQUFBAYFBQUHBgYHCQ8KCQgICRMNDgsPFhMXFxYTFRUYGyMeGBohGhUVHikfISQlJygnGB0rLismLiMmJyb/2wBDAQYHBwkICRIKChImGRUZJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJib/wAARCACAAIADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD0W01Wz0XwZpV9elyn2S2jjiiXdJNIyKFjQd2Y8AVteDrKbRNBe61lBDq2ozveXybgzbycLGMddiBF444Ncdo15p6eJPBUWsXEdvaQaOJrETKds14URBg9Nyx7yM/3s1qfFfxXa2+lw6PplxHLq9+D5ckRybSEcNNnsf4V9z7VSTeiLv1ZyXxY8Y2+o311pmkOyWEQEOo3kT7Tcv8A88IyOmOjt/wEdCa8ou5mknVAVWNAFjRRhUH90DsKs35UJDDarst4hiMeo7n8fWs6+QiEvET5rnav+z6n8BXtUKKpLzPOq1HN+RFeM1zJtRv3CHDEfxMO30FIo6KPoKnt7J1gRFwqYBXP86mgtXDtxnaCeO1dBiBjdSoJyo6t6mpACqg9cntWjZ6c0sjpOxVY8ZA65Pan3OmSJIFg/eK3GTxtPvTs9yOZXsZqnjjjPFV3lljY7iDg4wB1q4beQR7ipxv2fjVKaMByZB1+UY7Gpa7lJlmWNJYGVwCjD5gaoQTS/wDHtkPgfIx6lff6Vdjj6Oz5HAJ9KivYcOAqhHQ70cDGcdjSRTH2/J/eAYzg56V6R4H8Srdi18N6zqDWlxDJu0bVWPz2c2MCMk9Ubpg8EHae2PNvMV0jYH5XHC+lVZ4xJHsmXcjcMPaoqU1UjZlQm4O59WaRe32r28sGpym01C3fyLqzg4EcgGcg9SrDDKfQ+ua59vhy2l2eq3vhvXbqwv5k8yK2IU2ZZQTtkTGWByRnIIGMdK5/wN4xmm0uLUbyUSatpCpZ6kX4+1WLNiK4Pq0bEBj6FvWvX/332BxcKqy+U24L0Bwa8ScXF8rPUi1JXR4t4PttO1rwjD8QvEOoXsOn6ZEU0yFHxHDFHGImfy8fNI7hsd+QK881S8C391eshjvNQA/c/wDPvEMhV+vJJ9STUVjPfaZolp4dvsmz0VVlZs/LcvIPMhwM8ABtxHrj0rJaY3Vw08oZpJDn8K7cLSv77OavUt7qLPnE3GXOT7dMVHcxl/NkDcL2/nUiokUZcjOevqKl2gR7du71B716RxFdLpzIPNwqkADAwAK0rCeO3YswJZsDIHbPNZOrSLFbmWXKxopZj2FWLNxIm4L8uAB+VO+omtDoNPlWUSkN8xkLY747UXt8lsyptLseSM4xWRyDwcfQ0jZPX61XMR7PW5Ya6LwyoVwXk3D2FZ98wz5hH3n6Dtmpyw28/pVe6gmuolt7dxHPNIkcbN0DFgBmob7mij0RIgHlgk4XuKZOrO2WlJVeQD2qGNZXhbzEaNvuvGesbDhlP0IpJJRFGqKMkryc0k1JXQNNaMUIN0aqpUMN3I6dj/Q1HKGYYXoeDUk1wpiBT7yYOe3uKRArIQxw2SMVRJpaTqcuiXUWpGNLhY43iuLdz8s8DrtdD+Bz9VFe3+A73xDqXhmWNL+W7lsd1rLIzLhgq5Rsn+9GUNeAPcL5exgSw4xitvwTf6zY2V7JYa7e2DriELb7NpRUATcGU7jjjPsK4sRQdRpx3OqjWUE1I5KO4MGm2FjJO91PKRJLMxJ3MwyWJ9gAo+lbNv5ZiDRqVXsD2rDsXS4tLOQW7wyhWZvM67dqCPj6Fj/wKtq2JWLy3AyOK1oNOOmxFVWlqQTmbzlBwA5UE9verjKWbIbAx0qpduwaM7h9/j8qmjZ2Ay4C9fcjHOK6DE0tH0g6vc3AdC8FnA8rAjIeUqQgP05b8qybWEtbR7Ts3Kp4+lfQXww8MQ6d4SiN3GDc38bPMSOQH/8ArYH4V4vdaW+nX9zpkzAPZTPAeOu0kA/lg151Ct7TES7dPkd1anGnRj36/MzgNrgHPNOVCOpOCeKsTwfKWTgjjPrUsMCEo4bcv869KxwcxXSDJySencVd0nT3uNW0yEcmS6jxx3Bz/Slu1EFpNPsHyocD1Pau2+GWl/avE9rOcMlnG05yO+MD+dY1pqNN+hpSjJzXqZvxM8IXejXR1aLEltO2J2QYAOMBsevY/QH1rhGtUI3OhOODX1LrV7plramLVGjeO4BQW5Xe82eyoOW/CvCvGXhS80TbcfZp7fR7iTFuJGDPDn7scpHQ+n5E5rzcDVsvZy+R3YuPM/aL5nEfZVVDhtwYHII7VBbocxP2znce4q7LvSWSFlAZFzgf3T0qOzVZLOMHkAn+desecSPBE4Y7AGb+Kn+H7kx3clq8ihJ4W2qTgl19Pwz+VRzZdCqHFZeuQg6d5sbbHt5AwYD8P60pNpXQ9G7FHwvJNeNPdXM8lxcyiNXllbcxCrgc+wwB7AV0qjftY8FSfxrn/COF03IXY+8D5h1BC810RPbpzxWVBJU1Y0qu8tTNvtolg46y/MPWum8G2Ca3q1npqsjCS9ET45wFwW/8dBrntRQPAJMco4JPfFdz4Jk0fwh4i0vVNb1G3soG0uTUJFkcCRnII4TOSWDcDGTtOOlTXq+yj6lUqbqO/Y9qlsdX08Z0S7juIF/5cb8nAHoko5X6MGH0rx34oxXcWvzahc6Pcaeb6DcA7B0aZBghXXIOQFPbvXrNn498EXcaNB4t0ht6hgGu0U4PqCRg+1UfGJ03xJorWNvqGlzTK4mtpU1CMlJB0OO4IJBHcE14dGq6clI9SpTVSPKeLWPk3lnHNGx2yjlTwV9R9QavWsAXdG4G4cggY/GtqHw3enS57iG1mTUbA+Vf2y/vBIoH7uaIj73y4BA67c9eKy4XEtj9oAKSIW29wwHB2+v0r2KVf2kfM82dHkfkJDarczOpCvFBFJNMCM4Cqdv/AI9g/hXe+AdL1VrWSazvPsVvct5HnRwh5NidSC3AyTjoeRXJQJqtppzu9k9naa3bxI9y0RkAiLBt6Fc/MBkFCf5V6T4i1TT/AA14Vs2gtrq5tY0HlJbOFZ0VclmPUDuTivPxFV6vo9vkdtCmtI9UdBp2kWOnTNcRq0l3INr3Vw++Vx/vHoPYYFXLm2gvLeW0uYEuIJlKSRSLuVwexFfP3if4n+P9Osxc6b4NttGs5cCC5vFMjyZ6Fd5G78ARXmuueOfiTq0b/b/Et3HDjLR20ghX8kArlhTqVNUbTlGGjPVfiZ4CudFtpvEOiXC3elxRkvGTuliTvhujqPzHvXAWRzp0e0j7zdPrTpPAvizwrqPhx7bWHkm1GcW1usayCKMNg4IbgoQxJGMYBqxZ6ebe2EQdHUFirRqQpG44wOwx09sV6mDqzlJwlqcOJpwjFSWhXK9ap6wFGk3gZsAx59+K0SVEIULznk1g+IGP2W85JAiAAHX8Pzr0pbM4Y7jbJJNKtFguJkkVII5/NA2/KRnp7YxXURRxSRLIp3B1DA5rnPFU87X1pbPps2nCLToI2M4Cv80asrbQSAvQjPPzdKs+EL9prRbOaQtLEuUZusif4jofwrChO6UTStF7mtNaedaT28bYkkQqp64J6frWd4X8IXfjTxbpMfiK4meLUYXtxMH2GOaBMeTnBxhQCB3DA+tbbbuHiIDDke/tXUfDnVdIttavba/nKw3Jiu1iK821whwJQRyARhcj0561hmEfcUuxtgZXm49zjfFnw28OeEfGH9k6jp+o6pa3NpHNaeReiJi5LBgSUORkegxWBB4LRNbS3jtnihky6srF0iHoWIGccDPevqTxtoVh4qsrO4Eq2up2LM9tKwJQhhhkOP4TwfYgGsXQfDeoLaiCe2htmDEOS4cSe4x2+uK5aMsPKN5vU3rRxEZe7Eq/BPT5YvDOr2MzyxSpdmMTwyY+Qxghl7Bhk849K7Cy8JaBaW/kfYBc5+9JdMZXb6k1a8N6TFounGzRg7PK0skgGMsfb0AAFbDKNuRzXHUced+z2OmHNyr2m5S06xtNMtFs9Ot0tbdSWWKPhQScn8ySar+ILGTVNB1PTUfZJeWksCt6FlIH64rSCkkAd6V1x0HGOtYa3uaJq1j5xtvCFtqumCyJa0eDCvKVzIrjgqQffPFGseC1v4ofD9pGHvZAkdvKB820nBZj/dAyTnpivddSsNO8yWY2MH2i5wJJdg3Nj1NZbrp2kRXN/wCQsRZQZpI4yzMOw4yfwr03mMIqyjqckcvqTd+bQj8dHSdL0RNQJM0thbtZWCseBJIoTcPfaDz2ANeKTRP9mCW8LKpAQH0H/wCqvQFml8aakjrbumn2zEQpIMFj0Ln37Adh9a6uHwpZLBswu4LxxxXJQxfsru2rOutg/aWTeiPBLxFijd2wgRCzEnoBXEyO0lnKZ8+ZdT7sE/dUKGI/9BFetfEvQTabkSLakhG8e3p9DXmGo6fKiKA3mSYdmKjgDtgfjXrQxHt43j8zzJ4d0ZWl8i1eX39uyHUZEaHzIIkVXOcBI1QA+2F/WqWl2RNxDHApiEas6MvG08d61tLt/M0mCMhUZo1+YjoMDkVK+LdWmjQfJGwC5xwOcV0QguRWMJS95lWe81K3vBLGwYFQJI2HyEj+LHb3xXQ+EPE0kGvWjWVpFbanODbJLNKojkBwfLLEfxEDA9RUUEVrqNrEPMV94+RsYaNupQ1ga/pUlvb5aPzoVkBfj7gzjJ9uetOrDng0KlNRmmfU2nyXUlnC19HHFclR5qRElQ3cAnnFaNg377GO1fM3hb4j+JfDsYgluE1ixjGfKvmPmIo7LKOf++ga9u07xxDFZx3Op+HdVsFeMSM8UYukVSM5JQ7hx6qK+YqYapSlqj6SOKp1I6M73tXO+L9W1nSpLFNNW3ZLtjFulQkxv1z1xjGePaqA+JvgIWJvD4ltliCFwHR1ZwB/CCo3H2FZ0fxH+HXiZDpv/CQx20j/ADxtdI1vtZeQys4C5HpnnpRaVtDGLipe9sV9YbxBPbSzvrssjopcRBfLQEc5G3HPHfNejWMz3WnWtzIcNNCkhGO5UE15XqniLw7a28ovvFGkm1U7ZZLaYySOO6qgGdx6daZpnxw8O3upxaXZaFqrB/3du2I13sB8q7S3GcdSeKmmpu+h0Yl0lZQPULyIycryV6VyfjK8fTrFIs7JJjhDnGfpWP4n8S+N73TZW8PwaXo0oGR9qkM8pHfnGxT9d1cz4f0e4uNfgl1HV7vWr58GS5uWyqnuEXstKVJpczFSrK/Kj0rwdp4tNNWQqA7810K560+3gWKFIgOFGKeUAIAyBWfKypVE2eY/F4BrbCjLMoH41y/hXwhJdxyzXMf/ACzyMjqME16Br2nyapraRMuUjOfrXSxWqWlhJEgHETZwPY1cas4pxi9xypwdpSWqPlDRVuRoVv5zs05iUk5x9B+WKvTIGg/eEFlUsffA5FV7F1eytCAREkSfMf4m2j9BSXMCeZbiXzpd0u0LCcOdwx8vbP14619bB+6j5aW7M2wnuLee2nhlUv5qiSNuN654ye5weort5Gjmt/OB+UnBz0xnBFR2XhbTra4WR3nu2QbhHMRtU+pCjBI/Ks7x5qg0azt7a3MXnXbmUsQD5aDHb3OKpe4m2ZNqo0onN3RtLDXTZsA1pbXCmdsbtsWQxXHc4JGPavruW303WrHT7vSJXtVvESa2kii2iSJhkbgR/dOcda+KkkM/mPu3yMxdi/O4nkk/Wvq268e3S/C0eMLfSW04SW2II5HX5ZD+7RlA/hLHI9hXlYmTk01senQSirHnHxE1Ky1S58W+HY03w6TpxEd1EhZWaORWdPRFzgZ7lSPSvE51tlOTiQA8x9Q3t7Zr6L+DXhe7k8Ca1qqpHPea0GggjuG+SRVBA8zKn5TIST1BA6V5ja/DvXpPFlvoOraNPY3M5aW5lWBfL8sfeePb8hXoAARjI6VMbRbTKldpM5vxLfWV7PYhNPksCLZCFEZUKMYCj+90zuroPhvoy3PiLTrxI3aOBzJhPvMQpx9OcV2XxQ0GfVdHs/EP9gz6Qun4sntJrcJL5W8orsAx43KNuB0Y5PQnt/hRosMWjh5oDG4+8rKAQfT2rmlX5Kei1Z0woqc9Xoistrqha8meNlEhDRQ9VQAYxnv6/iat/DnTbsavfahfo3nzyliOwHtXoK28RBQRrjGOlSWdpFagiNAM964HOctGd1oQWiLVHFRTMRgA4qLcc5zQ5GKp3Vxy26pK0vVjwKS5X/RZv+ubfyNL5pp9wQbaY/8ATNv/AEE0tGaXktz5O0iCSa1s4o8ZaFOvQDaMk1Mkko1q1mtbR7thJ5FtAvDSSP8AKpGfc4z75q5o9mbfR4J7rbg26MI1ORjaMZPf6VJoOoW+m+KNG1i/OLS0vUlmcjhV5Ut9Buz+FfW6wpXXY+ZTU6lnseuWfww0ySxH/CQ3tzd3RG5/s87QwxH0UD7wHq2c+gryn4q+ArLw1dJe2aLLp8xDSAddrHAYHnBB4OOOVOByK+lpDE1qZDIpgdMiUHKlSOoPcV4D8XfE1ldWFvpVtNbzOpWNA33ZNrBnP5qq/ViOxr5729SU05Ns9uNGCg0lY8TvojY374bIQ4BHRlPIP4git6Xxrcv4JTwrc72t4LhHtGzwq7izIw9MnII+lYmtXMUl5LhlZEVYw46NtUAn6ZBro4Phzq9x4cj1Zj5d5LIgtdPaMl5VYgAkj7h6nngDk13yacU2caT5mkew/CX4maLaeEtO0W9ktoLi0zEyyTiIspYkEZ4PXqDXf3fjjw5J58f9pwLuhVgVlRiAG+bkNxjIxXy1qXgLxfp1w9vcaDdSMmMmBfNBBGQeOcEdOKfq2l3MFlp2+x2uI3V0SykR0IbjeSMEntis5Qi2mnuXGTtqtj3PwzrPhyy8Nm0/tC9ht4wMRa1OrXK/vXO5jnoTjb2q/wCDdathNJEkyMjMdu2QNu/KvmqG3zMrG2yNwzuiJHXvxXS2N3faZrU72Me+33bg1pA4iP0yOK5sRStZJ3OnD1Frc+r7dkf5gRg9Knyc15X4I8YG7byZSQygBlbg5r0uzuUnj3A8964L20O2UOvQnlXK571X5zipmIC465qDI3be9JhFaDqJCPs0y/8ATNv5GkzTZzi3m/65t/I0hn//2Q=='

    // ── optional account extension: public status and installation guide ───────
    function accountExtensionView(value) {
      const states = ['notinstalled', 'installed', 'disabled', 'ready', 'failed', 'incompatible', 'conflict']
      const state = value?.state === undefined || value?.state === 'not-installed' ? 'notinstalled' : states.includes(value.state) ? value.state : 'failed'
      const count = number => Number.isSafeInteger(number) && number >= 0 ? number : 0
      return {
        state, installed: value?.installed === true, enabled: value?.enabled === true,
        version: typeof value?.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(value.version) ? value.version : '',
        protocolVersion: count(value?.protocolVersion), providerCount: count(value?.providerCount), modelCount: count(value?.modelCount),
        managementTarget: value?.installed === true && value?.managementTarget === '/ofm-account-connectors' ? '/ofm-account-connectors' : '',
      }
    }

    function extensionStateLabel(state, t) {
      switch (state) {
        case 'installed': return t('ext.state.installed')
        case 'disabled': return t('ext.state.disabled')
        case 'ready': return t('ext.state.ready')
        case 'failed': return t('ext.state.failed')
        case 'incompatible': return t('ext.state.incompatible')
        case 'conflict': return t('ext.state.conflict')
        default: return t('ext.state.notinstalled')
      }
    }

    function extensionStateHint(state, t) {
      switch (state) {
        case 'installed': return t('ext.hint.installed')
        case 'disabled': return t('ext.hint.disabled')
        case 'ready': return t('ext.hint.ready')
        case 'failed': return t('ext.hint.failed')
        case 'incompatible': return t('ext.hint.incompatible')
        case 'conflict': return t('ext.hint.conflict')
        default: return t('ext.hint.notinstalled')
      }
    }

    function ExtensionsPage(props) {
      const { t, summary, openSection } = props
      const panel = usePanel(() => api('/extensions/account-connectors'), [])
      const [busy, setBusy] = useState(false)
      const [guide, setGuide] = useState(false)
      const [notice, setNotice] = useState('')
      const [detected, setDetected] = useState(undefined)
      const alive = useRef(true)
      useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
      const extension = accountExtensionView(detected ?? panel.data?.accountConnectors ?? summary?.data?.extensions?.accountConnectors)
      useEffect(() => {
        if (panel.data?.accountConnectors !== undefined) setDetected(panel.data.accountConnectors)
      }, [panel.data])
      useEffect(() => {
        if (summary?.data?.extensions?.accountConnectors !== undefined) setDetected(summary.data.extensions.accountConnectors)
      }, [summary?.data?.extensions?.accountConnectors])
      useEffect(() => {
        const changed = () => panel.reload()
        window.addEventListener?.('ofm:extensions', changed)
        return () => window.removeEventListener?.('ofm:extensions', changed)
      }, [panel.reload])
      const refresh = async () => {
        setBusy(true); setNotice('')
        try {
          const payload = await post('/extensions/account-connectors/refresh', undefined, 30_000)
          if (alive.current) { setDetected(payload.accountConnectors); summary?.reload?.(); setNotice(t('ext.detected')) }
        } catch { if (alive.current) setNotice(t('ext.refreshFailed')) }
        finally { if (alive.current) setBusy(false) }
      }
      const problem = ['failed', 'incompatible', 'conflict'].includes(extension.state)
      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('ext.title'), sub: t('ext.sub') },
          h(Pill, { strong: true, tone: extension.state === 'ready' ? 'ok' : problem ? 'err' : 'warn' }, extensionStateLabel(extension.state, t))),
        h(Section, { title: t('ext.cardTitle'), hint: t('ext.optional') },
          h('div', { className: 'ofm_panel ofm_rise', 'aria-busy': busy ? 'true' : 'false' },
            h('p', { className: 'ofm_note', role: problem ? 'alert' : 'status' }, extensionStateHint(extension.state, t)),
            h('div', { className: 'ofm_row', style: { flexWrap: 'wrap' } },
              h('span', { className: 'ofm_note' }, t('ext.package')), h('code', { className: 'ofm_mono' }, 'dsh-ofm-account-connectors'),
              h('span', { className: 'ofm_note' }, t('ext.version')), h('b', null, extension.version || t('ext.versionUnknown')),
              h('span', { className: 'ofm_note' }, t('ext.protocol')), h('b', null, extension.protocolVersion || '—')),
            extension.state === 'ready' ? h('p', { className: 'ofm_note' },
              t('ext.models').replace('{providers}', String(extension.providerCount)).replace('{models}', String(extension.modelCount)),
              extension.modelCount === 0 ? ' · ' + t('ext.noModels') : '') : null,
            h('div', { className: 'ofm_row', style: { flexWrap: 'wrap' } },
              h('button', { type: 'button', className: 'ofm_btn primary', 'aria-expanded': guide ? 'true' : 'false', 'aria-controls': 'ofm-account-install-guide', onClick: () => setGuide(value => !value) }, t('ext.installMethod')),
              h(Button, { disabled: busy, onClick: () => void refresh() }, busy ? t('ext.checking') : t('ext.refresh')),
              h('span', { className: 'ofm_note' }, t('ext.manageHint')),
              extension.managementTarget === ''
                ? h(Button, { disabled: true, title: t('ext.managementUnavailable') }, t('ext.manage'))
                : typeof openSection === 'function'
                  ? h(Button, { onClick: () => openSection('ofm-account-connectors') }, t('ext.manage'))
                  : h('a', { className: 'ofm_btn', href: extension.managementTarget }, t('ext.manage'))),
            h('p', { className: 'ofm_note', role: 'status', 'aria-live': 'polite' }, notice || (panel.status === 'error' ? t('ext.refreshFailed') : '')))),
        guide ? h(Section, { title: t('ext.installTitle') },
          h('div', { id: 'ofm-account-install-guide', className: 'ofm_panel ofm_rise' },
            h('p', null, t('ext.unpublished')),
            h('ol', null,
              h('li', null, t('ext.installStep1')),
              h('li', null, t('ext.installStep2')),
              h('li', null, t('ext.installStep3'))),
            h('p', { className: 'ofm_note' }, t('ext.installRestart')),
            h('p', { className: 'ofm_note' }, t('ext.privacy')),
            h('details', null, h('summary', null, t('ext.providersTitle')), h('p', { className: 'ofm_note' }, t('ext.providers'))))) : null)
    }

    // ── core statistics and logs: the same tables, backed by /stats ───────────
    const fmtInt = value => Number.isFinite(value) ? value.toLocaleString() : '—'
    const fmtPct = (part, whole) => whole > 0 ? Math.round(100 * part / whole) + '%' : '—'
    const fmtMs = value => Number.isFinite(value) && value >= 0 ? (value >= 1000 ? (value / 1000).toFixed(2) + ' s' : Math.round(value) + ' ms') : '—'
    const fmtTps = value => Number.isFinite(value) && value > 0 ? value.toFixed(1) + ' tok/s' : '—'

    function todayKey(at = Date.now()) {
      const now = new Date(at)
      return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
    }

    function coreLedgerView(stats = {}, scope = 'today', day = todayKey()) {
      const models = scope === 'today'
        ? (stats.days ?? []).find(row => row.day === day)?.models ?? []
        : stats.models ?? []
      const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, failed: 0, ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0 }
      for (const model of models) for (const key of Object.keys(totals)) totals[key] += Number.isFinite(model[key]) ? model[key] : 0
      if (scope === 'all') { totals.calls = stats.requests ?? totals.calls; totals.failed = stats.requestFailures ?? totals.failed }
      totals.avgTtftMs = totals.ttftSamples > 0 ? totals.ttftMs / totals.ttftSamples : null
      totals.tps = totals.decodeMs > 0 ? totals.decodeTokens / (totals.decodeMs / 1000) : null
      return {
        totals,
        models: [...models].map(row => ({ ...row, name: (stats.models ?? []).find(model => model.model === row.model)?.name ?? row.model,
          avgTtftMs: row.ttftSamples > 0 ? row.ttftMs / row.ttftSamples : row.avgTtftMs ?? null,
          tps: row.decodeMs > 0 ? row.decodeTokens / (row.decodeMs / 1000) : row.tps ?? null,
        })).sort((a, b) => (b.input + b.output) - (a.input + a.output)),
        entries: [...(stats.samples ?? [])].reverse().filter(row => scope !== 'today' || todayKey(row.at) === day),
      }
    }

    function logOrigin(origin, t) {
      return ({ chat: t('last.originChat'), harness: t('last.originHarness'), forward: t('last.originForward'), bench: t('last.originBench'), extension: t('ext.title') })[origin] ?? origin ?? '—'
    }

    function CoreLogTable(props) {
      const { entries, t } = props
      return h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
        h('thead', null, h('tr', null,
          h('th', null, t('log.time')), h('th', null, t('log.model')), h('th', null, t('log.via')), h('th', null, t('log.result')),
          num(t('log.duration')), num(t('log.ttft')), num(t('log.speed')), num(t('log.input')), num(t('log.output')), num(t('log.total')))),
        h('tbody', null, entries.map((entry, index) => h('tr', { key: String(entry.at) + ':' + index, className: entry.ok === false ? 'ofm_logfailed' : '' },
          h('td', null, new Date(entry.at).toLocaleString()), h('td', null, entry.model), h('td', null, logOrigin(entry.origin, t)),
          h('td', null, h('span', { className: 'ofm_badge ' + (entry.ok === false ? 'unavailable' : 'available') }, entry.ok === false ? t('log.failed') : t('log.ok')),
            entry.aborted === true ? ' · ' + t('coreLog.aborted') : entry.truncated === true ? ' · ' + t('coreLog.truncated') : entry.noUsage === true ? ' · ' + t('coreLog.noUsage') : ''),
          numTd(fmtMs(entry.elapsedMs)), numTd(fmtMs(entry.ttftMs)), numTd(fmtTps(entry.tps)), numTd(fmtInt(entry.input)), numTd(fmtInt(entry.output)), numTd(fmtInt((entry.input ?? 0) + (entry.output ?? 0))))))))
    }

    function KpiCard(props) {
      const { label, value, sub, tone } = props
      return h('div', { className: `ofm_kpi ofm_glass${tone ? ` ${tone}` : ''}` },
        h('span', { className: 'ofm_kpilabel' }, label),
        h('b', { className: 'ofm_kpivalue' }, value),
        sub === undefined ? null : h('span', { className: 'ofm_kpisub' }, sub))
    }

    function LedgerPage(props) {
      const { t } = props
      const panel = usePanel(() => api('/stats'), [])
      const [scope, setScope] = useState('today')
      const stats = panel.data ?? props.stats?.data ?? {}
      const view = coreLedgerView(stats, scope)
      const totals = view.totals
      const cumulative = stats.grand ?? {}
      const loaded = panel.data !== undefined || props.stats?.data !== undefined
      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('dash.title'), sub: t('dash.sub') },
          h('div', { className: 'ofm_seg' },
            h('button', { type: 'button', 'aria-pressed': scope === 'today' ? 'true' : 'false', onClick: () => setScope('today') }, t('dash.today')),
            h('button', { type: 'button', 'aria-pressed': scope === 'all' ? 'true' : 'false', onClick: () => setScope('all') }, t('dash.all'))),
          h(Button, { onClick: panel.reload }, t('dash.refresh'))),
        panel.status === 'error' ? h(PanelError, { t, title: t('dash.title'), message: panel.error, onRetry: panel.reload }) : null,
        !loaded ? h(PanelSkeleton) : h(Fragment, null,
          h('div', { className: 'ofm_kpis' },
            h(KpiCard, { label: scope === 'today' ? t('dash.kpiToday') : t('dash.kpiScopeAll'), value: fmtInt(totals.input + totals.output), sub: t('dash.input') + ' ' + fmtInt(totals.input) + ' · ' + t('dash.output') + ' ' + fmtInt(totals.output) + ' · ' + t('dash.reasoning') + ' ' + fmtInt(totals.reasoning) }),
            h(KpiCard, { label: t('dash.kpiCumulative'), value: fmtInt((cumulative.input ?? 0) + (cumulative.output ?? 0)), sub: t('dash.input') + ' ' + fmtInt(cumulative.input) + ' · ' + t('dash.output') + ' ' + fmtInt(cumulative.output) }),
            h(KpiCard, { label: t('dash.kpiSpeed'), value: fmtTps(totals.tps), sub: t('dash.ttft') + ' ' + fmtMs(totals.avgTtftMs) }),
            h(KpiCard, { label: t('dash.kpiCache'), value: fmtPct(totals.cacheRead, totals.input), sub: t('dash.cacheTokens') + ' ' + fmtInt(totals.cacheRead) }),
            h(KpiCard, { label: t('dash.kpiRequests'), value: fmtInt(totals.calls), sub: t('dash.successRate') + ' ' + fmtPct(totals.calls - totals.failed, totals.calls) + ' · ' + t('dash.failed') + ' ' + fmtInt(totals.failed), tone: totals.failed > 0 ? 'warn' : '' })),
          h(Section, { title: t('dash.recentTitle'), hint: t('dash.recentHint') }, view.entries.length === 0 ? h('p', { className: 'ofm_note' }, t('dash.empty')) : h(CoreLogTable, { t, entries: view.entries.slice(0, 10) })),
          h(Section, { title: t('dash.modelTitle'), hint: t('dash.modelHint') },
            view.models.length === 0 ? h('p', { className: 'ofm_note' }, t('dash.empty'))
              : h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
                h('thead', null, h('tr', null, h('th', null, t('log.model')), num(t('dash.requests')), num(t('log.input')), num(t('log.output')), num(t('log.reasoning')), num(t('log.cache')), num(t('log.total')), num(t('log.ttft')), num(t('log.speed')), num(t('dash.failed')))),
                h('tbody', null, view.models.map(model => h('tr', { key: model.model }, h('td', { title: model.model }, model.name),
                  numTd(fmtInt(model.calls)), numTd(fmtInt(model.input)), numTd(fmtInt(model.output)), numTd(fmtInt(model.reasoning)), numTd(fmtInt(model.cacheRead)),
                  numTd(fmtInt(model.input + model.output)), numTd(fmtMs(model.avgTtftMs)), numTd(fmtTps(model.tps)), numTd(fmtInt(model.failed)))))))),
          h('p', { className: 'ofm_note' }, t('dash.note'))))
    }

    function LogsPage(props) {
      const { t } = props
      const panel = usePanel(() => api('/stats'), [])
      const [pageSize, setPageSize] = useState(20)
      const [auto, setAuto] = useState(false)
      const [page, setPage] = useState(1)
      const reload = panel.reload
      useEffect(() => {
        if (!auto) return undefined
        const timer = setInterval(reload, 10_000)
        return () => clearInterval(timer)
      }, [auto, reload])
      const entries = coreLedgerView(panel.data ?? props.stats?.data ?? {}, 'all').entries
      const pages = Math.max(1, Math.ceil(entries.length / pageSize))
      const safePage = Math.min(page, pages)
      const rows = entries.slice((safePage - 1) * pageSize, safePage * pageSize)
      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('logs.title'), sub: t('logs.sub') },
          h('div', { className: 'ofm_seg' }, [10, 20, 50, 100].map(size => h('button', { key: size, type: 'button', 'aria-pressed': pageSize === size ? 'true' : 'false', onClick: () => { setPageSize(size); setPage(1) } }, String(size)))),
          h(Switch, { checked: auto, label: t('logs.auto'), onChange: () => setAuto(value => !value) }),
          h(Button, { onClick: reload }, t('dash.refresh'))),
        panel.status === 'error' ? h(PanelError, { t, title: t('logs.title'), message: panel.error, onRetry: reload }) : null,
        panel.data === undefined && props.stats?.data === undefined ? h(PanelSkeleton)
          : h(Section, { title: t('logs.title'), hint: t('logs.count').replace('{shown}', String(rows.length)).replace('{total}', String(entries.length)) },
            entries.length === 0 ? h('p', { className: 'ofm_note' }, t('logs.empty')) : h(CoreLogTable, { t, entries: rows }),
            pages > 1 ? h('div', { className: 'ofm_row' },
              h(Button, { kind: 'ghost', disabled: safePage <= 1, onClick: () => setPage(value => Math.max(1, value - 1)) }, '‹'),
              h('span', { className: 'ofm_note' }, t('logs.page').replace('{page}', String(safePage)).replace('{pages}', String(pages))),
              h(Button, { kind: 'ghost', disabled: safePage >= pages, onClick: () => setPage(value => Math.min(pages, value + 1)) }, '›')) : null,
            h('p', { className: 'ofm_note' }, t('logs.windowNote'))))
    }

    /** The core local forward listener and egress keep their existing controls. */
    function GatewayPage(props) {
      const { t, data, busy, apply } = props
      const clients = usePanel(() => api('/clients'), [])
      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('gw.title'), sub: t('gw.sub') }, h(Button, { onClick: clients.reload }, t('dash.refresh'))),
        h(Section, { title: t('section.forward'), hint: t('section.forwardHint') }, h(Forward, { settings: data.settings, t, onApply: apply, busy })),
        h(Section, { title: t('section.egress'), hint: t('section.egressHint') }, h(Egress, { settings: data.settings, t, onApply: apply, busy })),
        h(Section, { title: t('gw.clientsTitle'), hint: t('gw.clientsHint') },
          clients.status === 'loading' ? h('div', { className: 'ofm_skel', style: { minHeight: 96 } })
            : clients.status === 'error'
              ? h(PanelError, { t, title: t('gw.clientsTitle'), message: clients.error, onRetry: clients.reload })
              // The recipes are generated from the port that actually bound, so a
              // listener that is off has nothing honest to print: the route answers
              // with a placeholder port and a placeholder key, and a pasted
              // placeholder is a client that silently fails to connect.
              : clients.data?.running !== true
                ? h('div', { className: 'ofm_callout ofm_rise' },
                  h('div', null, h('b', null, t('gw.clientsOff')), h('div', null, t('gw.clientsOffHint'))))
                : h('div', { className: 'ofm_panel ofm_rise' },
                  h('div', { className: 'ofm_row' },
                    h('span', { className: 'ofm_note' }, t('forward.baseUrl')),
                    h('code', { className: 'ofm_mono' }, clients.data.baseUrl),
                    h(CopyButton, { t, text: clients.data.baseUrl }),
                    h('span', { className: 'ofm_note' }, t('gw.clientsModels').replace('{n}', String((clients.data.models ?? []).length)))),
                  clients.data.lanUrl === '' ? null
                    : h('div', { className: 'ofm_row' },
                      h('span', { className: 'ofm_note' }, t('forward.lanUrl')),
                      h('code', { className: 'ofm_mono' }, clients.data.lanUrl),
                      h(CopyButton, { t, text: clients.data.lanUrl })),
                  h('div', { className: 'ofm_duo' }, (clients.data.snippets ?? []).map((snippet, index) => h('div', {
                    key: snippet.id, className: 'ofm_card ofm_rise',
                    style: { animationDelay: `${Math.min(index, 8) * 22}ms` },
                  },
                  h('div', { className: 'ofm_cardhead' },
                    h('span', { className: 'ofm_cardname' }, snippet.name),
                    h('span', { className: 'ofm_tag' }, snippet.language)),
                  h('pre', { className: 'ofm_snippet' }, snippet.body),
                  h('div', { className: 'ofm_row' }, h(CopyButton, { t, text: snippet.body }))))))))
    }

    /** Shared page hero for the three gateway-console pages. The caller
     *  renders the copy: literal t() calls stay visible to the copy lint. */
    function PageHero(props) {
      const { title, sub, children } = props
      return h('header', { className: 'ofm_hero ofm_glass' },
        h('div', { className: 'ofm_pagehead' },
          h('div', { className: 'ofm_pagetitle' },
            h('h2', null, title),
            h('p', { className: 'ofm_pagesub' }, sub)),
          children))
    }

    // ── 聚合渠道 / 省 Token / 路由 ─────────────────────────────────────────────
    /**
     * One panel fetch per page, plus the merge for what a write answers with.
     *
     * `useAsync` above re-reads the whole payload after a write. These three
     * pages must not do that: every control's POST already answers with the state
     * the host stored, and a re-read would either double the round trips or open a
     * window where a switch shows what was *clicked* rather than what was saved.
     * So the payload lives here and the caller merges the POST answer in through
     * `patch`. The shimmer is for the first answer only — a reload after a write
     * keeps the current panel on screen instead of collapsing it back.
     */
    function usePanel(loader, deps) {
      const [state, setState] = useState({ status: 'loading', data: undefined, error: '' })
      const run = useCallback(() => {
        let alive = true
        setState(current => ({ status: current.data === undefined ? 'loading' : 'ready', data: current.data, error: '' }))
        loader()
          .then(data => { if (alive) setState({ status: 'ready', data, error: '' }) })
          .catch(error => {
            if (!alive) return
            setState(current => current.data === undefined
              ? { status: 'error', data: undefined, error: String(error?.message ?? error) }
              : { status: 'ready', data: current.data, error: String(error?.message ?? error) })
          })
        return () => { alive = false }
      }, deps)
      useEffect(() => run(), [run])
      const patch = useCallback(update => setState(current => current.data === undefined
        ? current
        : { ...current, data: typeof update === 'function' ? update(current.data) : { ...current.data, ...update } }), [])
      return { ...state, reload: run, patch }
    }

    /** First-fetch placeholder: three shimmering cards, not one grey line. */
    function PanelSkeleton() {
      return h('div', { className: 'ofm_grid', 'aria-hidden': 'true' },
        h('div', { className: 'ofm_skel' }), h('div', { className: 'ofm_skel' }), h('div', { className: 'ofm_skel' }))
    }

    /**
     * A load failure that names what failed and offers the retry.
     *
     * The older pages render nothing at all when a route refuses, which reads as
     * "this plugin has no such feature". Each of the three new pages passes its
     * own title, because "cannot read the provider registry" and "cannot read the
     * chain settings" are different sentences to act on.
     */
    function PanelError(props) {
      const { t, title, message, onRetry } = props
      return h('div', { className: 'ofm_callout ofm_error ofm_rise' },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('b', null, title),
          h('div', null, message)),
        h(Button, { kind: 'ghost', onClick: onRetry }, t('retry')))
    }

    /** Copy-to-clipboard that answers the click, so a copy is never silent. */
    function CopyButton(props) {
      const { t, text } = props
      const [done, setDone] = useState(false)
      useEffect(() => {
        if (!done) return
        const timer = setTimeout(() => setDone(false), 1400)
        return () => clearTimeout(timer)
      }, [done])
      return h(Button, {
        kind: 'ghost',
        onClick: () => copy(text, ok => { if (ok) setDone(true) }),
      }, done ? t('eac.copied') : t('eac.copy'))
    }

    /** A switch with its one-line explanation underneath. */
    function ToggleRow(props) {
      const { label, hint, checked, disabled, onChange } = props
      return h('div', { className: 'ofm_field' },
        h(Switch, { checked, label, disabled, onChange }),
        hint === undefined ? null : h('span', null, hint))
    }

    // Labels for the ids the host serves. Literal t() calls inside an object
    // literal rather than a key table, because a key the copy lint cannot see is
    // a key it reports as unused (the same shape the pool-reason table uses).
    const AGG_CATEGORY = t => ({
      apikey: t('agg.category.apikey'),
      free: t('agg.category.free'),
      'free-tier': t('agg.category.freeTier'),
      local: t('agg.category.local'),
      oauth: t('agg.category.oauth'),
    })
    const AGG_AUTH = t => ({
      apiKey: t('agg.auth.apiKey'),
      none: t('agg.auth.none'),
      oauth: t('agg.auth.oauth'),
      adc: t('agg.auth.adc'),
    })
    const SAVER_LEVEL = t => ({
      off: t('saver.level.off'),
      lite: t('saver.level.lite'),
      full: t('saver.level.full'),
      ultra: t('saver.level.ultra'),
      'wenyan-lite': t('saver.level.wenyanLite'),
      wenyan: t('saver.level.wenyan'),
      'wenyan-ultra': t('saver.level.wenyanUltra'),
    })
    const LANE_LABEL = t => ({
      free: t('routing.channel.free'),
      eac: t('routing.channel.eac'),
      kilo: t('routing.channel.kilo'),
      aggregate: t('routing.channel.aggregate'),
      combo: t('routing.channel.combo'),
    })

    /**
     * Auth kinds this lane cannot drive.
     *
     * `oauth` needs an interactive login and `adc` a cloud-side credential, so
     * the aggregate lane skips them when it builds the catalog. Offering one in
     * the picker would be offering a provider whose key field can never work, so
     * they are shown and marked instead of hidden — "this exists and this lane
     * will not call it" is the honest sentence.
     */
    const AGG_UNUSABLE = new Set(['oauth', 'adc'])

    /** `a, b` / `a\nb` -> `['a','b']`, the shape POST /providers stores. */
    const parseModelIds = value => String(value ?? '').split(/[\n,]+/).map(part => part.trim()).filter(part => part !== '')

    /** How many catalog rows one provider contributes right now, read from
     *  /summary: "configured" must never imply "in the model picker". */
    const contributedBy = (catalog, providerId) => (catalog ?? [])
      .filter(row => row.channel === 'aggregate' && row.providerId === providerId).length

    const miniBtn = (label, onClick, options = {}) => h('button', {
      type: 'button',
      className: 'ofm_minibtn' + (options.danger === true ? ' danger' : ''),
      disabled: options.disabled === true,
      title: options.title,
      onClick,
    }, label)

    /**
     * The add-provider picker: the whole registry, filtered.
     *
     * Every row carries what the decision needs — category, wire format, auth
     * kind, how many models ship with it, where to get a key and the free-tier
     * note — because "which of these 76 is worth a key" is the actual question.
     * Rows are capped; the counts say how many matched.
     */
    function ProviderPicker(props) {
      const { t, registry, onPick } = props
      const [query, setQuery] = useState('')
      const [category, setCategory] = useState('')
      const [format, setFormat] = useState('')
      const [auth, setAuth] = useState('')
      const categories = AGG_CATEGORY(t)
      const auths = AGG_AUTH(t)
      const needle = query.trim().toLowerCase()
      const matched = registry.filter(row => {
        if (category !== '' && row.category !== category) return false
        if (format !== '' && row.format !== format) return false
        if (auth !== '' && row.authKind !== auth) return false
        if (needle === '') return true
        return `${row.id} ${row.name}`.toLowerCase().includes(needle)
      })
      const shown = matched.slice(0, 48)
      const formats = [...new Set(registry.map(row => row.format))].sort()
      return h('div', { className: 'ofm_panel ofm_rise' },
        h('div', { className: 'ofm_paneltitle' }, t('agg.addTitle'),
          h('span', { className: 'ofm_sec_hint' }, t('agg.showing').replace('{shown}', String(shown.length)).replace('{total}', String(matched.length)))),
        h('div', { className: 'ofm_row' },
          h('div', { className: 'ofm_field', style: { flex: '1 1 180px' } },
            h('span', null, t('agg.search')),
            h('input', { className: 'ofm_input', value: query, placeholder: t('agg.search'), onChange: event => setQuery(event.target.value) })),
          h('div', { className: 'ofm_field' }, h('span', null, t('agg.filterCategory')),
            h('select', { className: 'ofm_input', value: category, onChange: event => setCategory(event.target.value) },
              h('option', { value: '' }, t('agg.filterAll')),
              Object.keys(categories).map(id => h('option', { key: id, value: id }, categories[id])))),
          h('div', { className: 'ofm_field' }, h('span', null, t('agg.filterFormat')),
            h('select', { className: 'ofm_input', value: format, onChange: event => setFormat(event.target.value) },
              h('option', { value: '' }, t('agg.filterAll')),
              formats.map(id => h('option', { key: id, value: id }, id)))),
          h('div', { className: 'ofm_field' }, h('span', null, t('agg.filterAuth')),
            h('select', { className: 'ofm_input', value: auth, onChange: event => setAuth(event.target.value) },
              h('option', { value: '' }, t('agg.filterAll')),
              Object.keys(auths).map(id => h('option', { key: id, value: id }, auths[id]))))),
        h('p', { className: 'ofm_note' }, t('agg.addHint')),
        shown.length === 0
          ? h('p', { className: 'ofm_note' }, t('agg.noMatch'))
          : h('div', { className: 'ofm_picklist' }, shown.map((row, index) => {
            const blocked = AGG_UNUSABLE.has(row.authKind)
            return h('div', {
              key: row.id, className: 'ofm_pickrow ofm_rise',
              style: { animationDelay: `${Math.min(index, 12) * 18}ms` },
            },
            h('span', { className: 'ofm_pickhead' },
              h('b', { title: row.name }, row.name),
              blocked ? h('span', { className: 'ofm_tagpill dead' }, t('agg.notUsable')) : null),
            h('span', { className: 'ofm_pickmeta' },
              h('span', { className: 'ofm_tag' }, categories[row.category] ?? row.category),
              h('span', { className: 'ofm_tag' }, row.format),
              h('span', { className: 'ofm_tag' }, auths[row.authKind] ?? row.authKind),
              h('span', null, t('agg.modelCount').replace('{n}', String(row.modelCount)))),
            blocked
              ? h('span', { className: 'ofm_picknote' }, t('agg.notUsableWhy').replace('{kind}', auths[row.authKind] ?? row.authKind))
              : h('span', { className: 'ofm_row' },
                row.credentialUrl === '' ? null
                  : h('a', { className: 'ofm_starlink', href: row.credentialUrl, target: '_blank', rel: 'noreferrer' }, t('agg.credential')),
                miniBtn(t('agg.select'), () => onPick(row))),
            row.notes === '' ? null : h('span', { className: 'ofm_picknote' }, row.notes))
          })))
    }

    /**
     * One provider's editor, shared by "configure" and "add".
     *
     * The key box starts empty on purpose and an empty box means *keep*: the host
     * distinguishes an absent field from an empty string, and conflating them is
     * what silently kept a key the user believed they had deleted. Deleting one
     * is therefore its own button, and it says what it does.
     */
    function ProviderEditor(props) {
      const { t, provider, state, contributions, onSaved, onRemoved, onChanged, showContributions = true } = props
      const fresh = state === undefined
      const [enabled, setEnabled] = useState(state?.enabled !== false)
      const [baseUrl, setBaseUrl] = useState(state?.baseUrl ?? '')
      const [key, setKey] = useState('')
      const [models, setModels] = useState((state?.models ?? []).join(', '))
      const [verdict, setVerdict] = useState(state?.lastTest ?? null)
      const [found, setFound] = useState(null)
      const [confirm, setConfirm] = useState(false)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')

      const run = async (kind, action) => {
        setBusy(kind)
        setError('')
        try { await action() } catch (failure) { setError(String(failure?.message ?? failure)) } finally { setBusy('') }
      }
      const save = () => run('save', async () => {
        const body = { providerId: provider.id, enabled, baseUrl, models: parseModelIds(models) }
        if (key !== '') body.apiKey = key
        const answer = await post('/providers', body)
        setKey('')
        onSaved(answer.aggregate, provider, fresh)
      })
      const clearKey = () => run('clear', async () => {
        const answer = await post('/providers', { providerId: provider.id, apiKey: '' })
        setKey('')
        onSaved(answer.aggregate, provider, false)
      })
      const test = () => run('test', async () => {
        // A listing probe, not a generation: the host verifies the key by asking
        // for the model list, so this costs no tokens. `status: 0` with ok:false
        // is its own verdict — "cannot be verified without spending a
        // generation" — and reads as a warning, not as a rejected key.
        const answer = await post('/providers/test', { providerId: provider.id }, 60_000)
        setVerdict({ at: Date.now(), ok: answer.ok === true, status: Number(answer.status) || 0, message: String(answer.message ?? '') })
      })
      const discover = () => run('discover', async () => {
        const answer = await post('/providers/discover', { providerId: provider.id }, 60_000)
        setFound(Array.isArray(answer.models) ? answer.models : null)
        // The host persisted the ids and rebuilt the catalog; re-read both views
        // so the contribution counts and the key fingerprint stay true.
        onChanged?.()
      })

      return h('div', { className: 'ofm_rise', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { className: 'ofm_pickmeta' },
          h('span', { className: 'ofm_tag' }, AGG_CATEGORY(t)[provider.category] ?? provider.category),
          h('span', { className: 'ofm_tag' }, provider.format),
          h('span', { className: 'ofm_tag' }, AGG_AUTH(t)[provider.authKind] ?? provider.authKind),
          // The card prints this one line above the editor, so it is suppressed
          // there; the add-provider flow renders the editor alone and keeps it.
          showContributions === false ? null : h('span', null, t('agg.contributes').replace('{n}', String(contributions)))),
        h('div', { className: 'ofm_duo' },
          ToggleRow({
            label: t('agg.enabled'), checked: enabled, disabled: busy !== '',
            onChange: () => { if (busy === '') setEnabled(value => !value) },
          }),
          field(t('agg.key'),
            h('input', {
              className: 'ofm_input', type: 'password', value: key, placeholder: t('agg.keyPlaceholder'),
              autoComplete: 'off', disabled: busy !== '',
              onChange: event => setKey(event.target.value),
            })),
          field(t('agg.baseUrl'),
            h('input', {
              className: 'ofm_input', value: baseUrl, placeholder: provider.baseUrl, disabled: busy !== '',
              onChange: event => setBaseUrl(event.target.value),
            })),
          field(t('agg.models'),
            h('textarea', {
              className: 'ofm_input', rows: 2, value: models, placeholder: t('agg.modelsPlaceholder'),
              disabled: busy !== '',
              onChange: event => setModels(event.target.value),
            }))),
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('agg.keyKeep')),
          state?.hasKey === true ? h('span', { className: 'ofm_note' }, t('agg.hasKey').replace('{hint}', state.keyHint)) : h('span', { className: 'ofm_note' }, t('agg.noKey')),
          state?.hasKey === true ? miniBtn(t('agg.keyClear'), clearKey, { danger: true, disabled: busy !== '', title: t('agg.keyClearWarn') }) : null),
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('agg.baseUrlHint')),
          provider.baseUrl === '' ? null : h('span', { className: 'ofm_note' }, t('agg.baseUrlDefault').replace('{url}', provider.baseUrl)),
          provider.baseUrlOverrideEnv === '' ? null : h('span', { className: 'ofm_note' }, t('agg.baseUrlEnv').replace('{env}', provider.baseUrlOverrideEnv))),
        h('p', { className: 'ofm_note' }, t('agg.modelsHint')),
        h('div', { className: 'ofm_row' },
          h(Button, { kind: 'primary', disabled: busy !== '', onClick: save }, busy === 'save' ? t('agg.saving') : fresh ? t('agg.add') : t('agg.save')),
          miniBtn(t('agg.test'), test, { disabled: busy !== '' }),
          miniBtn(t('agg.discover'), discover, { disabled: busy !== '' }),
          h('span', { className: 'spacer', style: { marginLeft: 'auto' } }),
          fresh ? null : (confirm
            ? h(Fragment, null,
              miniBtn(t('agg.removeConfirm'), () => run('remove', async () => {
                const answer = await post('/providers/remove', { providerId: provider.id })
                onRemoved(answer.aggregate, provider)
              }), { danger: true, disabled: busy !== '' }),
              miniBtn(t('agg.cancel'), () => setConfirm(false), { disabled: busy !== '' }))
            : miniBtn(t('agg.remove'), () => setConfirm(true), { danger: true, disabled: busy !== '' }))),
        confirm ? h('p', { className: 'ofm_note' }, t('agg.removeWarn')) : null,
        h('div', { className: 'ofm_row' },
          verdict === null ? h('span', { className: 'ofm_note' }, t('agg.neverTested'))
            : h(Fragment, null,
              h(Pill, { tone: verdict.ok === true ? 'ok' : verdict.status === 0 ? 'warn' : 'err' },
                verdict.ok === true ? t('agg.testOk') : verdict.status === 0 ? t('agg.testUnverified') : t('agg.testFailed')),
              h('span', { className: 'ofm_note' }, t('agg.testAt').replace('{when}', ago(verdict.at, t.locale)))),
          busy === 'test' ? h('span', { className: 'ofm_note' }, t('agg.testing')) : null,
          busy === 'discover' ? h('span', { className: 'ofm_note' }, t('agg.discovering')) : null),
        verdict !== null && verdict.ok !== true && verdict.status === 0
          ? h('p', { className: 'ofm_note' }, t('agg.testUnverifiedWhy')) : null,
        verdict !== null && verdict.message !== '' ? h('p', { className: 'ofm_note' }, verdict.message) : null,
        found === null
          ? null
          : h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, found.length === 0 ? t('agg.discoveredNone') : t('agg.discovered').replace('{n}', String(found.length))),
            found.length === 0 ? null : miniBtn(t('agg.discoveredUse'), () => setModels(found.join(', ')))),
        error === '' ? null : h('div', { className: 'ofm_callout ofm_error' },
          h('div', null, h('b', null, t('agg.failed')), h('div', null, error))))
    }

    /** A configured provider as one card: identity, what it contributes, and its
     *  editor. The editor is inline rather than behind a fold because every field
     *  on it is something the card's own state can disagree with. */
    function ProviderCard(props) {
      const { t, provider, state, contributions, onSaved, onRemoved, onChanged, index } = props
      return h('div', { className: 'ofm_card ofm_rise', style: { animationDelay: `${Math.min(index, 8) * 22}ms` } },
        h('div', { className: 'ofm_cardhead' },
          h('span', { className: 'ofm_cardname', title: provider.name }, provider.name),
          state.enabled === false ? h('span', { className: 'ofm_tagpill dead' }, t('agg.disabled')) : null),
        h('div', { className: 'ofm_id' }, provider.id),
        h('div', { className: 'ofm_metrics' },
          h('span', null, contributions > 0 ? t('agg.contributes').replace('{n}', String(contributions)) : t('agg.contributesNone')),
          h('span', null, state.hasKey === true ? t('agg.hasKey').replace('{hint}', state.keyHint) : t('agg.noKey'))),
        h(ProviderEditor, { t, provider, state, contributions, onSaved, onRemoved, onChanged, showContributions: false }))
    }

    /**
     * 聚合渠道: the registry, the configured providers and their editors.
     *
     * The catalog is read from the summary the shell already holds, so the
     * "contributes N models" line is the picker's own view rather than a second
     * derivation — and every write asks the shell to re-read it, because saving a
     * provider changes what the model picker offers.
     */
    function AggregatePage(props) {
      const { t, summary } = props
      const panel = usePanel(() => api('/providers'), [])
      const [adding, setAdding] = useState(false)
      const [draft, setDraft] = useState(null)
      const [query, setQuery] = useState('')
      const [category, setCategory] = useState('')
      const catalog = summary?.data?.catalog ?? []
      const registry = panel.data?.registry ?? []
      const configured = panel.data?.configured?.providers ?? {}
      const categories = AGG_CATEGORY(t)

      const afterWrite = (aggregate, provider, isNew) => {
        if (aggregate !== undefined && aggregate !== null) panel.patch({ configured: aggregate })
        if (isNew) { setAdding(false); setDraft(null) }
        summary?.reload?.()
        showToast({ title: t('agg.saved'), body: t('agg.savedBody').replace('{name}', provider.name), holdMs: 3600 })
      }
      const afterRemove = (aggregate, provider) => {
        if (aggregate !== undefined && aggregate !== null) panel.patch({ configured: aggregate })
        summary?.reload?.()
        showToast({ title: t('agg.saved'), body: t('agg.removedBody').replace('{name}', provider.name), holdMs: 3600 })
      }
      const afterDiscover = () => { panel.reload(); summary?.reload?.() }

      const needle = query.trim().toLowerCase()
      const rows = Object.keys(configured)
        .map(id => ({ id, provider: registry.find(entry => entry.id === id) ?? null, state: configured[id] }))
        .filter(row => row.provider !== null)
        .filter(row => category === '' || row.provider.category === category)
        .filter(row => needle === '' || `${row.id} ${row.provider.name}`.toLowerCase().includes(needle))

      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('agg.title'), sub: t('agg.sub') },
          h('div', { className: 'ofm_pills' },
            h(Pill, null, t('agg.registryCount').replace('{n}', String(registry.length))),
            h(Pill, { strong: true }, t('agg.configuredCount').replace('{n}', String(Object.keys(configured).length)))),
          h(Button, {
            kind: adding ? 'ghost' : 'primary',
            onClick: () => { setAdding(value => !value); setDraft(null) },
          }, adding ? t('agg.cancel') : t('agg.addProvider'))),
        panel.status === 'loading' ? h(PanelSkeleton) : null,
        panel.status === 'error'
          ? h(PanelError, { t, title: t('agg.loadFailed'), message: panel.error, onRetry: panel.reload })
          : null,
        panel.status === 'ready'
          ? h(Fragment, null,
            draft !== null
              ? h('div', { className: 'ofm_panel ofm_rise' },
                h('div', { className: 'ofm_paneltitle' }, draft.name, h('span', { className: 'ofm_sec_hint' }, draft.id)),
                h(ProviderEditor, {
                  t, provider: draft, state: undefined, contributions: 0,
                  onSaved: afterWrite, onRemoved: afterRemove, onChanged: afterDiscover,
                }))
              : adding
                ? h(ProviderPicker, { t, registry, onPick: setDraft })
                : null,
            h(Section, { title: t('agg.configuredTitle'), hint: t('agg.configuredHint') },
              h('div', { className: 'ofm_row' },
                h('div', { className: 'ofm_field', style: { flex: '1 1 180px' } },
                  h('span', null, t('agg.search')),
                  h('input', { className: 'ofm_input', value: query, placeholder: t('agg.search'), onChange: event => setQuery(event.target.value) })),
                h('div', { className: 'ofm_field' }, h('span', null, t('agg.filterCategory')),
                  h('select', { className: 'ofm_input', value: category, onChange: event => setCategory(event.target.value) },
                    h('option', { value: '' }, t('agg.filterAll')),
                    Object.keys(categories).map(id => h('option', { key: id, value: id }, categories[id]))))),
              Object.keys(configured).length === 0
                ? h('div', { className: 'ofm_panel' },
                  h('div', { className: 'ofm_paneltitle' }, t('agg.empty')),
                  h('p', { className: 'ofm_note' }, t('agg.emptyHint')))
                : rows.length === 0
                  ? h('p', { className: 'ofm_note' }, t('agg.filterEmpty'))
                  : h('div', { className: 'ofm_grid' }, rows.map((row, index) => h(ProviderCard, {
                    key: row.id, t, index, provider: row.provider, state: row.state,
                    contributions: contributedBy(catalog, row.id),
                    onSaved: afterWrite, onRemoved: afterRemove, onChanged: afterDiscover,
                  })))))
          : null)
    }

    /** The segmented level picker the two prompt savers share. */
    function LevelPicker(props) {
      const { t, levels, value, disabled, onChange } = props
      const labels = SAVER_LEVEL(t)
      return h('div', { className: 'ofm_seg', role: 'group' },
        levels.map(level => h('button', {
          key: level, type: 'button', disabled, 'aria-pressed': level === value ? 'true' : 'false',
          onClick: () => { if (!disabled && level !== value) onChange(level) },
        }, labels[level] ?? level)))
    }

    /** The savings bar: it grows into place once the first measurement lands, so
     *  the number reads as a measurement rather than as decoration. */
    function SavingsMeter(props) {
      const { t, percent } = props
      const [live, setLive] = useState(0)
      useEffect(() => {
        const timer = setTimeout(() => setLive(Math.max(0, Math.min(100, percent))), 60)
        return () => clearTimeout(timer)
      }, [percent])
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('saver.percent')),
          h('b', { className: 'ofm_kpivalue', style: { fontSize: 20 } }, `${percent}%`)),
        h('div', {
          className: 'ofm_meter', role: 'progressbar',
          'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': t('saver.percent'),
        }, h('i', { style: { width: `${live}%` } })))
    }

    /**
     * 省 Token: the three savers and what they have actually saved.
     *
     * Every control posts and then renders the host's own answer; nothing here
     * shows a switch state the settings file does not have. The dashboard reads
     * the measurement the host keeps, and says so explicitly when there is none —
     * an empty meter is not a claim that nothing was saved, it is the absence of a
     * measurement.
     */
    function SaverPage(props) {
      const { t } = props
      const panel = usePanel(() => Promise.all([api('/token-saver'), api('/local-optimize')])
        .then(([saver, local]) => ({ saver, local })), [])
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const saver = panel.data?.saver
      const local = panel.data?.local
      const savings = saver?.savings ?? null

      const write = async (kind, action) => {
        setBusy(kind)
        setError('')
        try { await action() } catch (failure) {
          // The route refuses an unknown level with a 400 and a sentence naming
          // the legal ones; showing it is more useful than swallowing it.
          setError(String(failure?.message ?? failure))
          showToast({ title: t('saver.failed'), body: String(failure?.message ?? failure), tone: 'warn', holdMs: 6000 })
        } finally { setBusy('') }
      }
      const saveSaver = patch => write('saver', async () => {
        const answer = await post('/token-saver', patch)
        // The POST answer carries the stored switches; the measurement is the
        // host's own tally and is only served by the GET, so it is kept as-is.
        panel.patch(current => ({ ...current, saver: { ...answer.tokenSaver, savings: current.saver?.savings } }))
        showToast({ title: t('saver.saved'), body: t('saver.savedBody'), holdMs: 3200 })
      })
      const saveLocal = patch => write('local', async () => {
        const answer = await post('/local-optimize', patch)
        panel.patch(current => ({ ...current, local: answer.localOptimize }))
        showToast({ title: t('saver.saved'), body: t('saver.savedBody'), holdMs: 3200 })
      })

      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('saver.title'), sub: t('saver.sub') },
          h('div', { className: 'ofm_pills' },
            h(Pill, { strong: true, tone: saver?.enabled === false ? 'warn' : 'ok' },
              saver?.enabled === false ? t('agg.disabled') : t('agg.enabled')))),
        panel.status === 'loading' ? h(PanelSkeleton) : null,
        panel.status === 'error'
          ? h(PanelError, { t, title: t('saver.loadFailed'), message: panel.error, onRetry: panel.reload })
          : null,
        error === '' ? null : h('div', { className: 'ofm_callout ofm_error ofm_rise' }, h('div', null, error)),
        panel.status === 'ready'
          ? h(Fragment, null,
            // The master switch governs all three savers, so it stands on its own
            // above them: inside the prompt-shaping section it read as that
            // section's switch, which is the one thing it is not.
            h('div', { className: 'ofm_panel ofm_rise' },
              h('div', { className: 'ofm_row' },
                h(Switch, {
                  checked: saver.enabled !== false, label: t('saver.master'), disabled: busy !== '',
                  onChange: () => { if (busy === '') saveSaver({ enabled: saver.enabled === false }) },
                }),
                h('span', { className: 'ofm_note' }, t('saver.masterHint')))),
            h(Section, { title: t('saver.dashTitle'), hint: t('saver.dashHint') },
              savings === null
                ? h('p', { className: 'ofm_note' }, t('saver.noData'))
                : h('div', { className: 'ofm_panel ofm_rise' },
                  h('div', { className: 'ofm_stats' },
                    stat(`${fmtInt(savings.bytesBefore)} B`, t('saver.bytesBefore')),
                    stat(`${fmtInt(savings.bytesAfter)} B`, t('saver.bytesAfter')),
                    stat(`${fmtInt(savings.saved)} B`, t('saver.bytesSaved')),
                    stat(String(savings.blocks), t('saver.blocks')),
                    stat(String(savings.calls), t('saver.calls')),
                    stat(String(savings.promptCalls), t('saver.promptCalls'))),
                  savings.bytesBefore > 0
                    ? h(SavingsMeter, { t, percent: savings.percent })
                    : h('p', { className: 'ofm_note' }, t('saver.noData')),
                  savings.summary === undefined || savings.summary === ''
                    ? null
                    : h('p', { className: 'ofm_note' }, `${t('saver.report')} · ${savings.summary}`))),
            h(Section, { title: t('saver.promptTitle'), hint: t('saver.promptHint') },
              h('div', { className: 'ofm_panel ofm_rise' },
                h('div', { className: 'ofm_duo' },
                  h('div', { className: 'ofm_field' },
                    h('span', null, t('saver.caveman')),
                    h(LevelPicker, {
                      t, levels: saver.cavemanLevels ?? [], value: saver.prompts?.caveman, disabled: busy !== '',
                      onChange: level => saveSaver({ prompts: { caveman: level } }),
                    }),
                    h('span', null, t('saver.cavemanWhat'))),
                  h('div', { className: 'ofm_field' },
                    h('span', null, t('saver.ponytail')),
                    h(LevelPicker, {
                      t, levels: saver.ponytailLevels ?? [], value: saver.prompts?.ponytail, disabled: busy !== '',
                      onChange: level => saveSaver({ prompts: { ponytail: level } }),
                    }),
                    h('span', null, t('saver.ponytailWhat')))),
                h('p', { className: 'ofm_note' }, t('saver.voiceWarn')))),
            h(Section, { title: t('saver.rtk'), hint: t('saver.rtkWhat') },
              h('div', { className: 'ofm_panel ofm_rise' },
                h('div', { className: 'ofm_row' },
                  h(Switch, {
                    checked: saver.rtk === true, label: t('saver.rtk'), disabled: busy !== '',
                    onChange: () => { if (busy === '') saveSaver({ rtk: saver.rtk !== true }) },
                  })),
                h('p', { className: 'ofm_note' }, t('saver.rtkSafety')))),
            h(Section, { title: t('saver.localTitle'), hint: t('saver.localHint') },
              h('div', { className: 'ofm_panel ofm_rise' },
                h('div', { className: 'ofm_row' },
                  h(Switch, {
                    checked: local.enabled !== false, label: t('saver.local.enabled'), disabled: busy !== '',
                    onChange: () => { if (busy === '') saveLocal({ enabled: local.enabled === false }) },
                  })),
                h('div', { className: 'ofm_duo' },
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.quota !== false, label: t('saver.local.quota'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ quota: local.quota === false }) },
                    }),
                    h('span', null, t('saver.local.quotaHint'))),
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.prefix !== false, label: t('saver.local.prefix'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ prefix: local.prefix === false }) },
                    }),
                    h('span', null, t('saver.local.prefixHint'))),
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.title !== false, label: t('saver.local.title'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ title: local.title === false }) },
                    }),
                    h('span', null, t('saver.local.titleHint'))),
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.suggestion !== false, label: t('saver.local.suggestion'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ suggestion: local.suggestion === false }) },
                    }),
                    h('span', null, t('saver.local.suggestionHint'))),
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.filepath !== false, label: t('saver.local.filepath'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ filepath: local.filepath === false }) },
                    }),
                    h('span', null, t('saver.local.filepathHint')))))))
          : null)
    }

    /** The chain editor's member picker: searchable, and it shows the lane and
     *  the vision flag, because those are what decide a chain's order. */
    function ModelPicker(props) {
      const { t, models, chosen, onPick } = props
      const [query, setQuery] = useState('')
      const lanes = LANE_LABEL(t)
      const needle = query.trim().toLowerCase()
      const rows = models
        .filter(row => needle === '' || `${row.id} ${row.name}`.toLowerCase().includes(needle))
        .slice(0, 60)
      return h('div', { className: 'ofm_panel' },
        h('div', { className: 'ofm_paneltitle' }, t('routing.pickModel')),
        h('div', { className: 'ofm_row' },
          h('div', { className: 'ofm_field', style: { flex: '1 1 200px' } },
            h('span', null, t('routing.pickModel')),
            h('input', { className: 'ofm_input', value: query, placeholder: t('routing.searchModel'), onChange: event => setQuery(event.target.value) }))),
        rows.length === 0
          ? h('p', { className: 'ofm_note' }, t('routing.noModel'))
          : h('div', { className: 'ofm_picklist' }, rows.map(row => h('button', {
            key: row.id, type: 'button', className: 'ofm_pickrow',
            'aria-pressed': chosen.includes(row.id) ? 'true' : 'false',
            onClick: () => onPick(row.id),
          },
          h('span', { className: 'ofm_pickhead' }, h('b', { title: row.name }, row.name ?? row.id)),
          h('span', { className: 'ofm_pickmeta' },
            h('span', { className: 'ofm_id' }, row.id),
            h('span', { className: 'ofm_tag' }, lanes[row.channel] ?? row.channel),
            row.vision === true ? h('span', { className: 'ofm_tag' }, t('tag.vision')) : null)))))
    }

    /**
     * The chain editor.
     *
     * The member list is ordered and the order is the chain, so it is edited in
     * place (add / remove / move) rather than through a free-text field: a typo in
     * a text field is a link that silently never resolves, and the host has no way
     * to tell "you meant this model" from "this model is gone".
     */
    function ChainEditor(props) {
      const { t, chain, models, onSave, onCancel } = props
      const [name, setName] = useState(chain.name ?? '')
      const [strategy, setStrategy] = useState(chain.strategy === 'round-robin' ? 'round-robin' : 'fallback')
      const [stickyLimit, setStickyLimit] = useState(String(chain.stickyLimit ?? 1))
      const [enabled, setEnabled] = useState(chain.enabled !== false)
      const [members, setMembers] = useState(Array.isArray(chain.models) ? chain.models : [])
      const [picking, setPicking] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const byId = new Map(models.map(row => [row.id, row]))
      const lanes = LANE_LABEL(t)

      const move = (index, delta) => setMembers(current => {
        const next = [...current]
        const target = index + delta
        if (target < 0 || target >= next.length) return current
        const [row] = next.splice(index, 1)
        next.splice(target, 0, row)
        return next
      })
      const submit = async () => {
        setBusy(true)
        setError('')
        try {
          const limit = Number(stickyLimit)
          await onSave({
            ...chain.id === undefined ? {} : { id: chain.id },
            name,
            models: members,
            strategy,
            stickyLimit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1,
            enabled,
          })
        } catch (failure) { setError(String(failure?.message ?? failure)) } finally { setBusy(false) }
      }

      return h('div', { className: 'ofm_panel ofm_rise' },
        h('div', { className: 'ofm_row' },
          h('div', { className: 'ofm_field', style: { flex: '1 1 180px' } },
            h('span', null, t('routing.name')),
            h('input', {
              className: 'ofm_input', value: name, placeholder: t('routing.namePlaceholder'), disabled: busy,
              onChange: event => setName(event.target.value),
            })),
          h('div', { className: 'ofm_field' },
            h('span', null, t('routing.strategy')),
            h('div', { className: 'ofm_seg', role: 'group' },
              h('button', {
                type: 'button', disabled: busy, 'aria-pressed': strategy === 'fallback' ? 'true' : 'false',
                onClick: () => { if (!busy) setStrategy('fallback') },
              }, t('routing.strategy.fallback')),
              h('button', {
                type: 'button', disabled: busy, 'aria-pressed': strategy === 'round-robin' ? 'true' : 'false',
                onClick: () => { if (!busy) setStrategy('round-robin') },
              }, t('routing.strategy.roundRobin')))),
          strategy === 'round-robin'
            ? h('div', { className: 'ofm_field' },
              h('span', null, t('routing.stickyLimit')),
              h('input', {
                className: 'ofm_input', type: 'number', min: 1, max: 100, style: { width: 96 },
                value: stickyLimit, disabled: busy,
                onChange: event => setStickyLimit(event.target.value),
              }))
            : null,
          h(Switch, {
            checked: enabled, label: t('routing.enabled'), disabled: busy,
            onChange: () => { if (!busy) setEnabled(value => !value) },
          })),
        strategy === 'round-robin' ? h('p', { className: 'ofm_note' }, t('routing.stickyHint')) : null,
        h('div', { className: 'ofm_paneltitle' }, t('routing.members'),
          h('span', { className: 'ofm_sec_hint' }, t('routing.memberCount').replace('{n}', String(members.length)))),
        members.length === 0
          ? h('p', { className: 'ofm_note' }, t('routing.memberEmpty'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, members.map((id, index) => {
            const row = byId.get(id)
            return h('div', { key: `${id}#${index}`, className: 'ofm_member' },
              h('span', { className: 'ofm_id', title: id }, row?.name ?? id),
              h('span', { className: 'ofm_tag' }, lanes[row?.channel] ?? ''),
              miniBtn('↑', () => move(index, -1), { disabled: busy || index === 0, title: t('routing.moveUp') }),
              miniBtn('↓', () => move(index, 1), { disabled: busy || index === members.length - 1, title: t('routing.moveDown') }),
              miniBtn(t('routing.removeMember'), () => setMembers(current => current.filter((_, at) => at !== index)), { danger: true, disabled: busy }))
          })),
        h('div', { className: 'ofm_row' },
          h(Button, { kind: 'ghost', disabled: busy, onClick: () => setPicking(value => !value) }, picking ? t('routing.cancel') : t('routing.addMember'))),
        picking ? h(ModelPicker, { t, models, chosen: members, onPick: id => setMembers(current => [...current, id]) }) : null,
        h('div', { className: 'ofm_row' },
          h(Button, { kind: 'primary', disabled: busy || name.trim() === '' || members.length === 0, onClick: submit }, t('routing.save')),
          h(Button, { kind: 'ghost', disabled: busy, onClick: onCancel }, t('routing.cancel'))),
        error === '' ? null : h('div', { className: 'ofm_callout ofm_error' },
          h('div', null, h('b', null, t('routing.failed')), h('div', null, error))))
    }

    /**
     * One stored chain.
     *
     * A chain that resolves to nothing right now is *not* an error state: the host
     * keeps such a chain on purpose, because a link that reaches an EAC model is
     * still correct on a day that lane is closed, and rewriting the user's chain
     * for them is worse than showing it as unavailable. So the card names the
     * members that are not in the roster and says the chain is kept as written —
     * which is the difference between "your chain is fine" and "your chain is
     * broken", and the user is the only one who can tell which one it is.
     */
    function ChainCard(props) {
      const { t, chain, resolved, missing, lookup, onEdit, onDelete, confirming, index } = props
      const lanes = LANE_LABEL(t)
      const usable = chain.enabled !== false && resolved.length > 0
      return h('div', { className: 'ofm_card ofm_rise', style: { animationDelay: `${Math.min(index, 8) * 22}ms` } },
        h('div', { className: 'ofm_cardhead' },
          h('span', { className: 'ofm_cardname', title: chain.name }, chain.name),
          h(Pill, { tone: usable ? 'ok' : 'warn' }, usable ? t('routing.usable') : t('routing.notUsable'))),
        h('div', { className: 'ofm_metrics' },
          h('span', null, chain.id),
          h('span', null, chain.strategy === 'round-robin' ? t('routing.strategy.roundRobin') : t('routing.strategy.fallback')),
          h('span', null, t('routing.memberCount').replace('{n}', String((chain.models ?? []).length)))),
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('routing.resolved')),
          resolved.length === 0
            ? h('span', { className: 'ofm_note' }, '—')
            : resolved.map(id => h('span', { key: id, className: 'ofm_tag' }, `${lookup.get(id)?.name ?? id} · ${lanes[lookup.get(id)?.channel] ?? ''}`))),
        missing.length === 0
          ? null
          : h(Fragment, null,
            h('p', { className: 'ofm_note' }, t('routing.missing').replace('{ids}', missing.join(', '))),
            h('p', { className: 'ofm_note' }, t('routing.notUsableWhy'))),
        h('div', { className: 'ofm_row' },
          miniBtn(t('routing.edit'), onEdit),
          onDelete === undefined ? null : miniBtn(confirming === true ? t('routing.deleteConfirm') : t('routing.delete'), onDelete, { danger: true })))
    }

    /**
     * 路由: the stored fallback chains and their editor.
     *
     * The resolution shown per chain is derived from the model list this page
     * already holds — the same intersection the host uses to build the virtual
     * catalog row — so it survives a reload, and the `usable` array a save answers
     * with is preferred when it is there.
     */
    function RoutingPage(props) {
      const { t } = props
      const panel = usePanel(() => api('/combos'), [])
      const [editing, setEditing] = useState(null)
      const [confirm, setConfirm] = useState('')
      const chains = panel.data?.combos ?? []
      const models = panel.data?.models ?? []
      const lookup = useMemo(() => new Map(models.map(row => [row.id, row])), [models])

      const resolvedOf = chain => {
        const answered = (panel.data?.usable ?? []).find(row => row.id === chain.id)
        if (answered !== undefined) return answered.models
        return (chain.models ?? []).filter(id => lookup.has(id))
      }
      const missingOf = chain => (chain.models ?? []).filter(id => !lookup.has(id))
      const save = async row => {
        // The whole list is written back, because that is the route's shape: it
        // normalizes and replaces. An edit keeps its id, so a rename never changes
        // the model id a client may already be pinned to.
        const known = chains.some(chain => chain.id === row.id)
        const rows = known ? chains.map(chain => chain.id === row.id ? row : chain) : [...chains, row]
        const answer = await post('/combos', { combos: rows })
        panel.patch({ combos: answer.combos, usable: answer.usable })
        panel.reload()
        setEditing(null)
        showToast({ title: t('routing.saved'), body: t('routing.savedBody'), holdMs: 3200 })
      }
      const remove = async id => {
        const answer = await post('/combos', { combos: chains.filter(chain => chain.id !== id) })
        panel.patch({ combos: answer.combos, usable: answer.usable })
        panel.reload()
        setConfirm('')
        showToast({ title: t('routing.saved'), body: t('routing.savedBody'), holdMs: 3200 })
      }
      // A fresh chain is the same editor with an empty draft: the fields, the
      // member list and the validation are identical, only the id is absent.
      const blank = { name: '', models: [], strategy: 'fallback', stickyLimit: 1, enabled: true }

      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('routing.title'), sub: t('routing.sub') },
          h('div', { className: 'ofm_pills' },
            h(Pill, null, t('routing.chains') + ' ' + String(chains.length)))),
        panel.status === 'loading' ? h(PanelSkeleton) : null,
        panel.status === 'error'
          ? h(PanelError, { t, title: t('routing.loadFailed'), message: panel.error, onRetry: panel.reload })
          : null,
        panel.status === 'ready'
          ? h(Section, { title: t('routing.chains'), hint: t('routing.chainsHint') },
            // The editor renders full width above the list rather than inside a
            // grid cell: a chain's member list and its picker need the room, and a
            // form squeezed into a 252 px column is a form nobody can order.
            editing !== null
              ? h(ChainEditor, {
                t, models, chain: editing.chain,
                onSave: save, onCancel: () => setEditing(null),
              })
              : chains.length === 0
                ? h('div', { className: 'ofm_panel' },
                  h('div', { className: 'ofm_paneltitle' }, t('routing.empty')),
                  h('p', { className: 'ofm_note' }, t('routing.emptyHint')),
                  h('div', { className: 'ofm_row' },
                    h(Button, { kind: 'primary', onClick: () => setEditing({ chain: blank }) }, t('routing.newChain'))))
                : h('div', { className: 'ofm_row' },
                  h(Button, { kind: 'primary', onClick: () => setEditing({ chain: blank }) }, t('routing.newChain'))),
            chains.length === 0 ? null : h('div', { className: 'ofm_grid' }, chains.map((chain, index) => h(ChainCard, {
              key: chain.id, t, index, chain, lookup,
              resolved: resolvedOf(chain), missing: missingOf(chain),
              confirming: confirm === chain.id,
              onEdit: () => setEditing({ chain }),
              onDelete: () => { if (confirm === chain.id) void remove(chain.id); else setConfirm(chain.id) },
            }))),
            confirm === '' ? null : h('p', { className: 'ofm_note' }, t('routing.deleteWarn')))
          : null)
    }

    // ── settings page ─────────────────────────────────────────────────────────
    function SettingsPage(props) {
      const tagged = props.locale === undefined ? props.t : Object.assign(x => props.t(x), { locale: props.locale })
      const t = tagged
      const [busy, setBusy] = useState(false)
      const [benches, setBenches] = useState({})
      const summary = useAsync(() => api('/summary'), [])
      const stats = useAsync(() => api('/stats'), [])
      // GitHub 授权状态由这一层持有：模型卡的锁标记与 EAC 面板必须看到同一个
      // 判定，登录 / 退出后两边同时更新；60 秒轮询兜住别处（另一台机器）的变动。
      const [eacAuth, setEacAuth] = useState(undefined)
      useEffect(() => {
        let alive = true
        const load = () => api('/eac/status', { timeout: 20_000 })
          .then(data => { if (alive) setEacAuth(data) })
          .catch(() => { if (alive) setEacAuth({ available: false, authorized: false, login: '' }) })
        load()
        const timer = setInterval(load, 60_000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      // 登录流只有这一份：EAC 面板、页头的未授权按钮、上锁模型卡的「去授权」
      // 共享同一个进行中的会话（同一轮询、同一条提示），见 useEacLogin。
      const eacLogin = useEacLogin({ t, summary, onAuth: setEacAuth })

      const apply = async patch => {
        setBusy(true)
        try {
          await post('/settings', patch)
          summary.reload(); stats.reload()
        } catch (error) {
          // The route can refuse a patch — a routable forward bind, for one — and a
          // rejection nobody shows is a button that appears to do nothing.
          showToast({ title: t('settings.failed'), body: String(error?.message ?? error), tone: 'warn' })
        } finally { setBusy(false) }
      }
      const bench = async model => {
        setBenches(current => ({ ...current, [model.id]: { running: true } }))
        try {
          // 默认档（balanced）而不是 deep：测速要回答的是“这个模型日常多快”，
          // 默认档就是日常档；deep 每次最多烧 32K 输出 token，且经常把固定
          // bench 会话自己打到 429。
          const result = await post('/bench', { model: model.id }, 240_000)
          setBenches(current => ({ ...current, [model.id]: { running: false, result: t('bench.result').replace('{ttft}', result.ttftMs).replace('{tps}', result.tokensPerSecond ?? '—').replace('{reasoning}', result.reasoningTokens) } }))
        } catch (error) {
          setBenches(current => ({ ...current, [model.id]: { running: false, result: String(error?.message ?? error) } }))
        }
      }

      if (summary.status === 'loading' && summary.data === undefined) return h('div', { className: 'ofm_root' }, h('p', { className: 'ofm_note' }, t('loading')))
      if (summary.status === 'error') {
        return h('div', { className: 'ofm_root' },
          h('div', { className: 'ofm_callout ofm_error' }, h('div', null, h('b', null, t('loadFailed')), h('div', null, summary.error))),
          h('div', null, h(Button, { onClick: () => summary.reload() }, t('retry'))))
      }
      const data = summary.data
      // The tank and the stat chips describe the free lane's health, so the
      // optional extension models stay out of the tally — their card carries its
      // availability badge, and a lane that is never probed would otherwise
      // read as a permanently green slice of this gauge.
      const counts = data.catalog.filter(m => !m.channel && m.source !== 'extension:ofm.account-connectors').reduce((acc, m) => ({ ...acc, [m.availability]: (acc[m.availability] ?? 0) + 1 }), {})
      return h(Shell, {
        t: tagged, data, counts, summary, stats, eacAuth, setEacAuth, eacLogin,
        busy, setBusy, apply, bench, benches, ctx: props.ctx, openSection: props.openSection,
      })
    }

    // ── the three-page shell ──────────────────────────────────────────────────
    // The settings section used to be one long scroll. It is now three pages
    // behind one glass navigation bar, because the three lanes answer three
    // different questions and mixing them pushed the model roster — the thing
    // people actually open this page for — below the fold:
    //   免费模型       the no-account lane (this plugin's own gateway),
    //   EAC 模型       the desktop co-paid lane behind GitHub auth,
    //   账号连接扩展   optional addon status and installation instructions.
    // The active page lives in localStorage so a reload — or the hot reload the
    // upgrader triggers — comes back to the page the user was reading.
    const TAB_KEY = 'ofm.tab'
    const TABS = ['free', 'eac', 'extensions', 'aggregate', 'saver', 'routing', 'ledger', 'logs', 'gateway', 'upgrade']
    const normalizeCoreTab = saved => saved === 'channels' ? 'extensions' : TABS.includes(saved) ? saved : 'free'

    function Shell(props) {
      const { t, data, counts, summary, stats, eacAuth, setEacAuth, eacLogin, busy, setBusy, apply, bench, benches, ctx } = props
      const [tab, setTab] = useState(() => {
        try {
          const saved = window.localStorage?.getItem(TAB_KEY)
          return normalizeCoreTab(saved)
        } catch { return 'free' }
      })
      const tabRefs = useRef({})
      const [glider, setGlider] = useState({ left: 0, top: 0, width: 0, height: 0 })
      useEffect(() => {
        try { window.localStorage?.setItem(TAB_KEY, tab) } catch { /* storage unavailable */ }
        const node = tabRefs.current[tab]
        // Tabs may wrap onto a second row inside the group, so the glider is
        // placed on both axes: translate alone would put it at the right
        // height and the wrong row.
        if (node !== undefined && node !== null) setGlider({ left: node.offsetLeft, top: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight })
      }, [tab, t.locale])

      const refresh = async () => {
        setBusy(true)
        try { await post('/refresh', undefined, 600_000); summary.reload(); stats.reload() } finally { setBusy(false) }
      }
      const reprobe = async () => {
        setBusy(true)
        try { await post('/reprobe', undefined, 600_000); summary.reload() } finally { setBusy(false) }
      }

      const tabs = [
        ['free', t('nav.tab.free'), counts.available ?? 0],
        ['eac', t('nav.tab.eac'), data.catalog.filter(m => m.channel === 'eac').length],
        ['extensions', t('nav.tab.extensions'), null],
        ['aggregate', t('nav.tab.aggregate'), data.catalog.filter(m => m.channel === 'aggregate').length],
        ['saver', t('nav.tab.saver'), null],
        ['routing', t('nav.tab.routing'), data.catalog.filter(m => m.channel === 'combo').length],
        ['ledger', t('nav.tab.ledger'), null],
        ['logs', t('nav.tab.logs'), null],
        ['gateway', t('nav.tab.gateway'), null],
        ['upgrade', t('nav.tab.upgrade'), null],
      ]
      const nav = h('nav', { className: 'ofm_nav' },
        h('span', { className: 'ofm_navbrand' },
          h('span', { className: 'ofm_navmark', 'aria-hidden': 'true' },
            h('img', { src: BRAND_ICON, alt: '' })),
          t('title')),
        h('div', { className: 'ofm_tabs', role: 'tablist' },
          h('span', { className: 'ofm_tabglider', style: { transform: `translate(${glider.left}px, ${glider.top}px)`, width: `${glider.width}px`, height: `${glider.height}px` } }),
          tabs.map(([id, label, num]) => h('button', {
            key: id, type: 'button', role: 'tab', 'aria-selected': tab === id ? 'true' : 'false', className: 'ofm_tab', 'data-on': tab === id ? 'true' : 'false',
            ref: node => { tabRefs.current[id] = node },
            onClick: () => setTab(id),
          }, label, num === null ? null : h('span', { className: 'ofm_tabnum' }, String(num))))),
        h('span', { className: 'ofm_navspacer' }),
        h(StarButton, { t }))

      const page = tab === 'extensions'
        ? h(ExtensionsPage, { t, summary, openSection: props.openSection })
        : tab === 'aggregate'
          ? h(AggregatePage, { t, summary })
          : tab === 'saver'
            ? h(SaverPage, { t })
            : tab === 'routing'
              ? h(RoutingPage, { t })
              : tab === 'ledger'
                ? h(LedgerPage, { t, stats })
                : tab === 'logs'
                  ? h(LogsPage, { t, stats })
                  : tab === 'gateway'
                    ? h(GatewayPage, { t, data, busy, apply })
                    : tab === 'upgrade'
                      ? h(UpgradePage, { t, settings: data.settings, onApply: apply, busy })
                    : tab === 'eac'
                      ? h(EacPage, { t, data, counts, summary, stats, eacAuth, setEacAuth, eacLogin, busy, apply, bench, benches, refresh, reprobe })
                      : h(FreePage, { t, data, counts, summary, stats, eacAuth, eacLogin, busy, apply, bench, benches, refresh, reprobe, openUpgrade: () => setTab('upgrade') })

      return h('div', { className: 'ofm_root ofm_shell' },
        h('div', { className: 'ofm_aurora', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        nav,
        page)
    }

    function FreePage(props) {
      const { t, data, counts, summary, stats, eacAuth, eacLogin, busy, apply, bench, benches, refresh, reprobe, openUpgrade } = props
      // The denominator is the free lane's own roster — the only slice the
      // verdicts describe. Dividing by the whole catalog (which also carries
      // the never-probed EAC and Kilo entries) read a 6-of-10 lane as ~17%.
      const total = data.catalog.filter(m => !m.channel).length
      const ok = counts.available ?? 0
      // The tank reads the free lane's own health: the share of the declared
      // roster this machine can actually reach. Same thresholds as the pool
      // gauge, so the two pages' tanks never disagree about what "busy" looks
      // like — only about what the water is measuring.
      const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(100 * ok / total))) : null
      const ratio = total > 0 ? ok / total : 0
      // Thresholds for *availability* (not load): most of a frontier roster being
      // reachable is the healthy case, so "busy" starts below 60% rather than
      // below two thirds — the pool gauge's own cut-offs measure queue pressure
      // and would paint a perfectly usable lane amber.
      const level = ratio >= 0.6 ? 'ok' : ratio >= 0.3 ? 'busy' : 'over'
      return h('div', { className: 'ofm_page' },
        h('header', { className: 'ofm_hero ofm_glass' },
          h('div', { className: 'ofm_pagehead' },
            h('div', { className: 'ofm_pagetitle' },
              h('h2', null, t('free.title')),
              h('p', { className: 'ofm_pagesub' }, t('free.sub'))),
            h('div', { className: 'ofm_pills' },
              h(Pill, { strong: true, tone: data.settings.enabled !== false ? 'ok' : 'err' }, data.settings.enabled !== false ? t('pref.enabled') : 'off'),
              h(Pill, null, `${t('pref.egress')} ${data.egress?.country ?? data.egress?.ip ?? '—'}`),
              h(Pill, null, `${t('pref.probedAt')} ${ago(data.probedAt, t.locale)}`))),
          h('div', { className: 'ofm_tankrow' },
            h(Tank, { pct, level, size: 'xl', label: `${t('free.tankLabel')} ${pct ?? '—'}%` }),
            h('div', { className: 'ofm_tankside' },
              h('div', { className: 'ofm_pooltop' },
                h('span', { className: `ofm_poolbadge ${level}` },
                  h('span', { className: 'ofm_pooldot' }),
                  `${t('free.tankLabel')} ${pct ?? '—'}%`),
                h(StarButton, { t })),
              h('div', { className: 'ofm_poolstats' },
                h('div', { className: 'ofm_stat' }, h('b', null, String(ok)), h('span', null, t('state.available'))),
                h('div', { className: `ofm_stat${(counts['region-blocked'] ?? 0) > 0 ? ' hot' : ''}` },
                  h('b', null, String(counts['region-blocked'] ?? 0)), h('span', null, t('state.region-blocked'))),
                h('div', { className: 'ofm_stat' }, h('b', null, String((counts.unavailable ?? 0) + (counts['access-restricted'] ?? 0))), h('span', null, t('state.unavailable')))),
              h('div', { className: 'ofm_poolmeta' },
                h('span', { className: 'ofm_note' }, total > 0
                  ? t('free.tankNote').replace('{ok}', String(ok)).replace('{total}', String(total))
                  : t('free.tankEmpty')),
                h('span', { className: 'ofm_note' }, t('meta.description'))),
              h('div', { className: 'ofm_row' },
                h(Button, { disabled: busy, onClick: refresh }, summary.status === 'loading' ? t('probing') : t('refresh')),
                h(Button, { disabled: busy, onClick: reprobe }, t('reprobe')))))),
        h(Section, { title: t('section.models'), hint: t('section.modelsHint') }, h(Roster, { summary: data, t, onBench: bench, benches, auth: eacAuth, eacLogin, only: 'free' })),
        h(Section, { title: t('section.dash'), hint: t('section.dashHint') },
          stats.status === 'ready' && stats.data !== undefined ? h(Dashboard, { stats: stats.data, summary: data, t })
            : h('p', { className: 'ofm_note' }, t('loading'))),
        h(Section, { title: t('section.forward'), hint: t('section.forwardHint') }, h(Forward, { settings: data.settings, t, onApply: apply, busy })),
        h(Section, { title: t('section.egress'), hint: t('section.egressHint') }, h(Egress, { settings: data.settings, t, onApply: apply, busy })),
        h(Section, { title: t('section.prefs'), hint: t('section.prefsHint') }, h(Preferences, { summary: data, t, onApply: apply, busy })),
        h(Section, { title: t('section.news'), hint: t('section.newsHint') }, h(NewsPanel, { t })),
        // Keep the former update location as a shortcut to the single upgrade panel.
        h(Section, { title: t('section.upgrade'), hint: t('section.upgradeHint') },
          h(Button, { onClick: openUpgrade }, t('upgrade.open'))))
    }

    function EacPage(props) {
      const { t, data, summary, eacAuth, setEacAuth, eacLogin, busy, bench, benches, refresh, reprobe } = props
      const { pool, poolError } = usePool()
      const reading = pool === undefined || pool === null ? null : poolReading(pool)
      const levelText = reading === null ? '' : reading.level === 'over' ? t('pool.levelOver') : reading.level === 'busy' ? t('pool.levelBusy') : t('pool.levelOk')
      const eacCount = data.catalog.filter(m => m.channel === 'eac').length
      const reasonText = pool === null
        ? (({ 'no-lane': t('pool.reasonNoLane'), 'gateway-status': t('pool.reasonGateway'), malformed: t('pool.reasonMalformed'), unreachable: t('pool.reasonUnreachable') })[poolError]
          ?? (poolError !== '' ? poolError : t('pool.reasonUnknown')))
        : ''
      return h('div', { className: 'ofm_page' },
        h('header', { className: 'ofm_hero ofm_glass' },
          h('div', { className: 'ofm_pagehead' },
            h('div', { className: 'ofm_pagetitle' },
              h('h2', null, t('eac.title')),
              h('p', { className: 'ofm_pagesub' }, t('eac.sub'))),
            h('div', { className: 'ofm_pills' },
              h(Pill, { strong: true, tone: eacAuth?.authorized === true ? 'ok' : 'warn' },
                eacAuth?.authorized === true ? t('eac.pillOk') : t('eac.pillLocked')),
              h(Pill, null, `${t('section.models')} ${eacCount}`),
              h(Pill, null, `${t('pref.egress')} ${data.egress?.country ?? data.egress?.ip ?? '—'}`))),
          h('div', { className: 'ofm_tankrow' },
            h(Tank, { pct: reading?.pct ?? null, level: reading?.level ?? 'ok', size: 'xl', label: `${t('eac.tankLabel')} ${reading?.rawPct ?? '—'}%` }),
            h('div', { className: 'ofm_tankside' },
              h('div', { className: 'ofm_pooltop' },
                reading === null
                  ? h('span', { className: 'ofm_poolbadge' }, h('span', { className: 'ofm_pooldot' }),
                    pool === undefined ? t('loading') : t('pool.unavailable').replace('{reason}', reasonText))
                  : h('span', { className: `ofm_poolbadge ${reading.level}` },
                    h('span', { className: 'ofm_pooldot' }),
                    `${levelText} · ${t('pool.live')} ${pool.inflight}`),
                // 未授权时把登录入口放到页头：撞到「没授权」的用户第一眼看到的
                // 位置就该有钥匙，而不是要先找到下方的授权区。
                eacAuth?.available === true && eacAuth?.authorized !== true
                  ? h(Button, { kind: 'primary', disabled: eacLogin.busy || eacLogin.pending !== null, onClick: eacLogin.login },
                    eacLogin.busy ? t('eac.starting') : t('eac.login'))
                  : null,
                h(StarButton, { t })),
              reading === null ? null : h(Fragment, null,
                h('div', { className: 'ofm_poolstats' },
                  h('div', { className: `ofm_stat${reading.level === 'over' ? ' hot' : ''}` },
                    h('b', null, String(pool.inflight)), h('span', null, t('pool.live'))),
                  h('div', { className: 'ofm_stat' },
                    h('b', null, reading.active === null ? '—' : String(reading.active)), h('span', null, t('pool.active'))),
                  h('div', { className: 'ofm_stat' },
                    h('b', null, reading.capacityKnown ? String(pool.pool) : '—'), h('span', null, t('pool.capacity')))),
                h('div', { className: 'ofm_poolmeta' },
                  h('span', { className: 'ofm_note' }, `${t('pool.reach')} ${reading.rawPct ?? '—'}%`),
                  h('span', { className: 'ofm_note' }, capacityText(pool, t)))),
              h('div', { className: 'ofm_row' },
                h(Button, { disabled: busy, onClick: refresh }, summary.status === 'loading' ? t('probing') : t('refresh')),
                h(Button, { disabled: busy, onClick: reprobe }, t('reprobe')))))),
        h(Section, { title: t('section.eac'), hint: t('section.eacHint') }, h(EacAuth, { t, auth: eacAuth, eacLogin })),
        h(Section, { title: t('section.models'), hint: t('section.modelsHint') }, h(Roster, { summary: data, t, onBench: bench, benches, auth: eacAuth, eacLogin, only: 'eac' })),
        h(Section, { title: t('section.news'), hint: t('section.newsHint') }, h(NewsPanel, { t })))
    }

    // ── announcement ──────────────────────────────────────────────────────────
    const PAGES = ['ann.preamble', 'ann.models', 'ann.steps', 'ann.features', 'ann.updates']

    function announcementPortalHost() {
      let host = document.querySelector('[data-ofm-announcement-root]')
      if (host === null) {
        host = document.createElement('div')
        host.setAttribute('data-ofm-announcement-root', 'true')
        document.body.appendChild(host)
      }
      return host
    }

    function Announcement(props) {
      const { t, complete, openSection, page, setPage, summary, acknowledged } = props
      useEffect(() => { if (acknowledged) complete() }, [acknowledged, complete])
      /* Not `#root.inert`, even though the shell does that for its own onboarding
         modals: those portal out of `#root`, while a slot-mounted step stays
         inside it, and inert has no opt-out for descendants. Measured with it on,
         `document.elementFromPoint` over the next-page button returned BODY — the
         dialog could not be clicked at all. The full-viewport scrim already
         swallows every pointer event aimed at the app behind it. */
      if (acknowledged) return null
      const last = page === PAGES.length - 1
      const finish = async () => {
        try { await post(`/announcement/ack?version=${encodeURIComponent(summary?.announcementVersion ?? '')}`) } catch { /* ack is best effort */ }
        complete()
      }
      const host = announcementPortalHost()
      useEffect(() => () => {
        if (host.parentNode !== null) host.parentNode.removeChild(host)
      }, [host])
      return ReactDOM.createPortal(h('div', { className: 'ofm_scrim' },
        h('div', { className: 'ofm_ann', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('title') },
          h('div', { className: 'ofm_annhead' },
            h('h2', { className: 'ofm_anntitle' }, t('title')),
            h('p', { className: 'ofm_annsub' }, t(PAGES[page]))),
          h('div', { className: 'ofm_steps', 'aria-hidden': 'true' },
            PAGES.map((key, index) => h('span', { key, className: 'ofm_step', 'data-on': index <= page ? 'true' : 'false' }))),
          h('div', { className: 'ofm_annbody' }, h(PageBody, { page, t, summary })),
          h('div', { className: 'ofm_annfoot' },
            h('span', { className: 'ofm_note' }, t('ann.page').replace('{n}', page + 1).replace('{total}', PAGES.length)),
            h('span', { className: 'spacer' }),
            page === 0 ? h(Button, { kind: 'ghost', onClick: finish }, t('ann.later')) : h(Button, { kind: 'ghost', onClick: () => setPage(p => Math.max(0, p - 1)) }, '‹'),
            last
              ? h(Button, { kind: 'primary', onClick: async () => { await finish(); openSection?.('our-free-model') } }, t('ann.openSettings'))
              : h(Button, { kind: 'primary', onClick: () => setPage(p => Math.min(PAGES.length - 1, p + 1)) }, '›')))), host)
    }

    const list = (t, keys) => keys.map(key => h('li', { key }, t(key)))

    function PageBody(props) {
      const { page, t, summary } = props
      if (page === 0) return h(Fragment, null,
        h('h3', null, t('ann.preamble')),
        h('p', null, t('ann.pitch')),
        h('ul', null, list(t, ['ann.p1', 'ann.p2', 'ann.p3'])))
      if (page === 1) {
        // Advertised models first: this page is the tour a new user reads before
        // they pick anything, and a refused id at the top of it is a bad first
        // impression of a lane that is actually working.
        const rows = (summary?.catalog ?? []).slice().sort((a, b) => (a.route === null ? 1 : 0) - (b.route === null ? 1 : 0))
        if (rows.length === 0) return h('p', null, t('loading'))
        return h(Fragment, null,
          h('h3', null, t('ann.models')),
          h('div', { className: 'ofm_kv' }, rows.slice(0, 8).map(m => h('div', { key: m.id, className: 'ofm_kvc' },
            h('b', null, m.name),
            h('span', null, `${t(`state.${m.availability}`)} · ${m.vision ? t('tag.vision') : t('tag.text')} · ${kilo(m.contextWindow)}`)))),
          rows.some(m => m.availability === 'region-blocked') ? h('p', { className: 'ofm_note' }, t('hint.region')) : null)
      }
      if (page === 2) return h(Fragment, null,
        h('h3', null, t('ann.steps')),
        h('ul', null, list(t, ['ann.s1', 'ann.s2', 'ann.s3', 'ann.s4'])))
      if (page === 3) return h(Fragment, null,
        h('h3', null, t('ann.features')),
        h('ul', null, list(t, ['ann.f1', 'ann.f2', 'ann.f3', 'ann.f4', 'ann.f5'])))
      return h(Fragment, null,
        h('h3', null, t('ann.updates')),
        h('ul', null, list(t, ['ann.u1', 'ann.u2', 'ann.u3', 'ann.u4'])))
    }

    // ── registration ──────────────────────────────────────────────────────────
    // The shell mirrors the active language onto <html lang>, so a render-time
    // read survives a language switch without owning a subscription.
    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active ?? ctx.locale?.locale
        return typeof value === 'string' ? value : document.documentElement.lang || 'en'
      } catch { return 'en' }
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'our-free-model: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-our-free-model')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'our-free-model: styles')

      // ── push subscription ───────────────────────────────────────────────────
      // One EventSource for the whole app surface: new announcements become
      // toasts (and OS notifications when opted in), urgent ones open a modal,
      // update availability and completed upgrades broadcast onto window so
      // whichever panel is mounted can refresh itself. EventSource reconnects
      // by itself; the hot reload closes every stream server-side, so a swap
      // simply shows up as a fresh `hello` a second later.
      ctx.effect(() => {
        if (typeof EventSource !== 'function') return
        let osEnabled = false
        let disposed = false
        let source
        let retryTimer
        // 重连轮次必须活在 open() 之外：open() 每次重连都会重入，计数器若在里面
        // 会被清零，退避就永远是第一档而不是 30s 翻倍到 5 分钟。
        let retries = 0
        api('/announcements').then(payload => { osEnabled = payload?.notifyOs === true }).catch(() => {})
        const open = () => {
          if (disposed) return
          source = new EventSource(`${API}/events`)
          // 断连保护：服务端不可达时 EventSource 默认无限自动重连（持续占连接池）。
          // 连续失败达到上限先关闭让出连接，但按退避（30s 翻倍、封顶 5 分钟）定时
          // 重新打开——永久关闭让公告/更新/升级推送在宿主重启或休眠后整体静默失效，
          // 只有刷新页面才能恢复；退避重连在恢复连接性的同时保住连接池。
          let errCount = 0
          source.onopen = () => { errCount = 0; retries = 0 }
          source.onerror = () => {
            errCount += 1
            if (errCount < 5) return
            try { source.close() } catch { /* 已关闭 */ }
            if (disposed || retryTimer !== undefined) return
            retryTimer = setTimeout(() => {
              retryTimer = undefined
              open()
            }, Math.min(30_000 * 2 ** retries, 300_000))
            retries += 1
          }
          source.addEventListener('announcements', event => {
            errCount = 0
            let data
            try { data = JSON.parse(event.data) } catch { return }
            for (const item of data.items ?? []) {
              osNotify(t('toast.annTitle'), item.title)
              if (item.level === 'urgent') {
                showUrgentModal({
                  title: `${t('news.urgentTitle')} · ${item.title}`,
                  html: item.html ?? '',
                  confirmLabel: t('news.gotIt'),
                  onClose: () => { void post('/announcements/ack', { id: item.id }).catch(() => {}) },
                })
              } else {
                showToast({ title: t('toast.annTitle'), body: item.title, tone: item.level === 'warn' ? 'warn' : undefined })
              }
            }
            window.dispatchEvent(new CustomEvent('ofm:announcements', { detail: data }))
          })
          source.addEventListener('extensions', event => {
            let data
            try { data = JSON.parse(event.data) } catch { return }
            window.dispatchEvent(new CustomEvent('ofm:extensions', { detail: data }))
          })
          source.addEventListener('update', event => {
            let data
            try { data = JSON.parse(event.data) } catch { return }
            osNotify(t('toast.updateTitle'), t('toast.updateBody').replace('{latest}', data.latest ?? '').replace('{current}', data.current ?? ''))
            showToast({
              title: t('toast.updateTitle'),
              body: t('toast.updateBody').replace('{latest}', data.latest ?? '').replace('{current}', data.current ?? ''),
              tone: 'warn', holdMs: 14000,
            })
            window.dispatchEvent(new CustomEvent('ofm:update', { detail: data }))
          })
          source.addEventListener('upgraded', event => {
            let data
            try { data = JSON.parse(event.data) } catch { data = {} }
            window.dispatchEvent(new CustomEvent('ofm:upgraded', { detail: data }))
          })
          source.addEventListener('hello', event => {
            let data
            try { data = JSON.parse(event.data) } catch { data = {} }
            window.dispatchEvent(new CustomEvent('ofm:hello', { detail: data }))
          })
        }
        open()
        return () => {
          disposed = true
          if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined }
          try { source?.close() } catch { /* already closed */ }
        }
      }, 'our-free-model: push subscription')

      // A hot reload or in-app upgrade swaps this bundle while the page stays
      // open. The only durable marker across that swap is localStorage, so the
      // successor announces what happened exactly once.
      ctx.effect(() => {
        void (async () => {
          try {
            const meta = await api('/meta')
            const at = Number(meta?.reloadedAt ?? 0)
            if (at <= 0) return
            let seen = ''
            try { seen = window.localStorage?.getItem('ofm.reloadedAt') ?? '' } catch { /* storage unavailable */ }
            if (String(at) === seen) return
            try { window.localStorage?.setItem('ofm.reloadedAt', String(at)) } catch { /* ignore */ }
            showToast({
              title: meta.version !== '' ? `Our Free Model ${meta.version}` : 'Our Free Model',
              body: t('reload.done').replace('{n}', String(meta.reloadCount ?? 0)),
              actions: [{ label: t('reload.refresh'), onClick: () => { try { window.location.reload() } catch { /* top-level navigation refused */ } } }],
              holdMs: 12000,
            })
          } catch { /* backend absent */ }
        })()
        return () => {}
      }, 'our-free-model: reload notice')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'our-free-model',
        order: 35,
        label: () => t('nav'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, locale: localeTag(ctx), ctx })))

      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
        name: 'settings.onboarding',
        id: 'our-free-model-announcement',
        order: -50,
        locale: NS,
      }, props => h(AnnouncementGate, { ...props, t: Object.assign(x => t(x), { locale: localeTag(ctx) }) })))
    }
    /**
     * Owns the announcement's readiness.
     *
     * The onboarding coordinator mounts one ordered step at a time and waits for
     * the registrant to either show something or call `complete`. This renders
     * null until the ack state is known — a step that paints a skeleton then
     * removes it is worse than one that waits — and completes immediately when
     * the user already acknowledged the current copy version.
     */
    function AnnouncementGate(props) {
      const { t, complete, openSection, explicit } = props
      const [ack, setAck] = useState(undefined)
      const [summary, setSummary] = useState(undefined)
      const [page, setPage] = useState(0)
      useEffect(() => {
        let alive = true
        api('/announcement')
          .then(payload => { if (alive) setAck(payload) })
          .catch(() => { if (alive) setAck({ acknowledged: true, version: '' }) })
        api('/summary').then(payload => { if (alive) setSummary(payload) }).catch(() => {})
        // 超时兜底：3 秒拿不到 ack（后端挂起/超时/异常）→ 当作已 ack 主动放行——
        // 本组件是 settings.onboarding 协调器最先执行的 step（order:-50），complete 依赖 ack；
        // ack 永远 undefined 会永久卡住 onboarding 流程（连带阻塞后续 step 与主题启动画面）。
        const timer = setTimeout(() => {
          if (alive) setAck(current => current ?? { acknowledged: true, version: '' })
        }, 3000)
        return () => { alive = false; clearTimeout(timer) }
      }, [])
      const acknowledged = ack?.acknowledged === true && explicit !== true
      useEffect(() => {
        if (ack === undefined) return
        if (acknowledged) complete?.()
      }, [ack, acknowledged, complete])
      if (ack === undefined || acknowledged) return null
      return h(Announcement, { t, complete, openSection, page, setPage, summary, acknowledged: false })
    }
    exports.apply = apply
    exports.inject = inject
    exports.name = 'our-free-model'
    // Headless test seams use the same stub React as scripts/client-lint.mjs.
    exports.standalone = { EacAuth, useEacLogin, DICT, CSS, Tank, usePool, poolReading, capacityText, ExtensionsPage, LedgerPage, LogsPage }
    exports.__test = { parseSafeHtml, safeUrl, sanitizeStyle, htmlToDom, buildHeatCells, Heatmap, UpgradePanel, useEacLogin, EacAuth, DICT, CSS, Tank, usePool, poolReading, capacityText, accountExtensionView, extensionStateLabel, extensionStateHint, normalizeCoreTab, coreLedgerView, ExtensionsPage, LedgerPage, LogsPage, GatewayPage, FreePage, EacPage, Shell, TABS }
    return module.exports
  },
})
