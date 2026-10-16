# 双插件分离开发分支交接（2026-10-16）

交接编号：split-20261016-paired-1。当前交付为可继续审核和验收的开发候选，尚未正式签名发布。本文件与 dev-install/README.md 是本次交接的入口；旧 README、BRANCH_STATUS、ACCOUNT_CONNECTORS_HANDOFF 中的历史分支名、测试数字和安装包链接不代表本次状态。

## 1. 获取哪两个分支

| 部分 | 仓库 | 分支 | 当前候选版本 |
|---|---|---|---|
| OFM 核心 | look-back-lysj/dsh-our-free-model | sync/separated-upstream-20261015 | 2.3.1-split.1 |
| 独立账号插件 | look-back-lysj/dsh-ofm-account-connectors | sync/account-connectors-20261015 | 0.1.0，以 SHA-256 区分内容 |

功能对齐基准是 **2026-10-15 核验的上游 OFM 2.3.0**，提交 ac4c55ef5e0833bf0138846a7c5255ecbc14a07c。本次上传未重新判定 10 月 16 日的上游最新版本。核心源码起点为 2718f4b7714636a0d2fbc17bbd1cb0b15fc4a4b8；账号插件起点为 f1507270722f826fceddd5680dcfd794a72da5dd；这些是本轮修改前的提交。最终修改已在本文件所在开发分支提交，用 git rev-parse HEAD 查看取得的确切提交号。

当前目标：保留上述基准的功能，拆为可各自独立启停、也可联动的两个插件。没有开展十三家渠道的全新反向代理重写，也没有合并主线、上线服务器或发布正式版本。

## 2. 做到了什么程度

- 核心保留免费/Kilo/EAC/公开 API 聚合、模型路由、省 Token、统一网关、公告和更新等能力。账号认证与账号池由独立插件持有，核心通过可选接口使用账号模型。
- 账号插件持有十三渠道登录、账号池、模型开关、签到/额度、用量/日志和备份迁移。补回了拆分遗漏的独立 Chat Completions / Responses 网关，以及 DSH 思考循环中止后的有界自动续跑。
- 两个插件各自拥有管理入口、运行状态和清理流程。停用一方会撤回它自己的模型或监听，另一方可继续运行；账号插件不依赖核心源码路径即可作为 DSH 插件运行。外置 ZIP 是给兼容宿主导入的扩展，不是双击运行的独立桌面软件。
- 核心携带 companions/account-connectors.json.gz，启动后可通过官方插件管理器安装配套账号插件。安装使用本机 tgz 文件，解决 Windows 对目录链接的限制，并固定当前核心依赖，防止 pnpm 把核心恢复为旧整合版。
- 配套迁移复制旧账号状态和已持久化渠道文件；保留账号 ID、昵称、启用状态、模型开关、限流/到期、签到/锁定/用量和账号网关密钥。旧目录及旧凭据引用保留，独立凭据使用 OFM_ACCOUNT_CONNECTORS_ 前缀。
- 迁移先准备副本、回读校验，再切换目录；独立插件 ready 后才标记完成。缺凭据、引用冲突或安装失败会报错并回退；支持进程中断恢复和失败重试。迁移完成后不再拿旧 token 覆盖刷新后的新 token；用户主动停用/卸载后不反复强行安装。
- 核心界面区分“核心文件更新”和“账号插件配套迁移完成”两阶段，提供状态与重试。缺少插件管理服务的极简/TUI 宿主仍可启动核心。
- 账号管理所有页面及未启用状态显示第三方技术集成说明，已检查手机宽度排版。

“保留旧登录数据”指迁移不会主动清除数据，不保证厂商永不过期或永不要求重新登录。Gemini 不附带 Google OAuth 客户端凭据，需要在运行宿主的本机配置有权使用的兼容客户端；变量为 OFM_CONNECTORS_GOOGLE_CLIENT_ID、OFM_CONNECTORS_GOOGLE_CLIENT_SECRET，说明见账号仓库 docs/GEMINI_OAUTH_CONFIG.md。不要把真实值写入仓库。

## 3. 怎么使用

### 方案 A：两个插件联动（验收完整拆分结果）

优点：同时保留核心聚合和账号模型，并能检查旧数据迁移。需要兼容 DSH 宿主，或者核心提供的独立网页/桌面扩展宿主。

1. 从核心分支 dev-install 取得 dsh-our-free-model-2.3.1-split.1.tgz，通过 DSH 插件管理的安装入口安装/更新这个 tgz。可以使用该分支的 HTTPS 文件直链；不要把 GitHub 仓库网页地址当作安装包地址。
2. 先更新旧整合核心，再处理账号插件，避免旧整合代码和独立插件同时注册同名供应商。
3. 启用新核心，检查核心页的配套安装/迁移状态。正常配套流程会安装账号插件，完成后无需再手动重复安装账号 tgz。已有独立插件会被识别；若已有的是旧 0.1.0 候选，需用本次 SHA-256 对照，必要时手动更新。
4. 在账号插件自己的管理页查看迁移结果或登录所需渠道。全新账号渠道需要自行选择启用和登录；旧整合版正常迁移保留原状态。核心通过联动接口使用这些账号模型。
5. 分别停用核心和账号插件，检查另一方仍可使用；再重新启用，检查状态与模型恢复。

核心 tgz 自带配套载荷，因此只想使用核心功能时，可能仍会看到已安装的账号插件；可以独立停用它，核心功能继续可用。

### 方案 B：只用独立账号插件

优点：无需安装 OFM 核心即可在兼容 DSH 宿主使用账号连接与独立本地网关。范围只包括账号侧功能。

1. 从账号分支 dev-install 取得 dsh-ofm-account-connectors-0.1.0.tgz，在 DSH 中安装并明确启用。宿主需提供 credentials、llm、commands 以及独立数据目录或 profileContext.home。
2. 打开账号插件管理页，选择渠道并正常登录。独立网关默认不额外常驻，需要时在“扩展设置 → 独立本地网关”主动开启，按页面显示的地址、端口和密钥接入客户端。
3. 停用账号插件会关闭其网关和后台任务；不会因此卸载核心。不要让旧整合插件与独立插件同时持有同名账号供应商。

### 方案 C：独立网页宿主或桌面扩展导入

优点：可验收网页管理和外置 Worker。需要先启动兼容的扩展宿主；本轮没有重建最终 Windows 安装器。

使用源码中的网页宿主示例（先完成下文依赖准备）：

```powershell
Set-Location '<核心仓库绝对路径>'
node packages/standalone/cli.mjs --data-dir 'D:\ofm-review-data' --port 18900 --no-refresh
```

使用终端实际输出的一次性登录地址进入管理页。--no-refresh 只关闭自动刷新，不是离线模式。核心自带的配套安装成功时无需重复导入；手动导入时，将账号仓库 dev-install/ofm-account-connectors-0.1.0-external.zip 解压，打开“账号连接扩展”，填写包含 extension.json 的完整目录，确认来源可信后点“导入本机扩展”，再点“启用扩展”。ZIP 不可当作 DSH 的 tgz 安装。

建议协作者先使用新建的验收数据目录。旧整合用户的常规迁移由配套流程执行；手动备份导入则走预览确认，导入后的账号保持停用，两条路径的行为不同。

## 4. 本次验收证据与边界

| 验证 | 已记录的最终结果 |
|---|---|
| 核心 contributor 完整回归 | 53/53 套件通过 |
| 账号插件完整回归 | 453/453 项通过，0 跳过 |
| 热更新/迁移专项 | 14/14 项通过，0 跳过 |
| 官方真实宿主隔离安装与冷启动 | 14 项通过；实际 Cordis、PluginManager、pnpm、HMR |
| 实际外置包页面与网关 | 全部管理页声明、昼夜/手机布局、网关开关、密钥拒绝通过，无页面错误 |
| TypeScript、扩展文件清单和 git diff --check | 通过 |

2026-10-16 上传前逐文件复核：核心 40 个、账号插件 16 个变更文件均与以上验收时的 SHA-256 快照一致。可移交的快照和结果索引在 docs/verification/2026-10-16-handoff/。原始日志及完整本机验收材料留在 D:/ofm-audits/20261015-paired-hot-update，不是协作者机器上已经存在的文件。

上述结果不能代表十三家厂商的现网登录、额度、签到和推理全部可用。迁移与宿主验收使用虚构账号；未完成真实厂商账号验收、当前所有 DSH 版本和原生安装向导验收。本轮没有替换用户日常使用的 DSH（仍是旧整合 2.1.0）。

## 5. 如何复验和继续修改

运行环境：Node ^22.19.0 或 >=24，本机最终验收使用 Node 24.19.0。只使用现成开发包时不需要重新构建；修改源码时才进行依赖安装与构建。

依赖准备：核心根目录没有锁文件，使用 npm install --ignore-scripts --legacy-peer-deps；packages/standalone 和 packages/desktop 按各自 package-lock.json 使用 npm ci --ignore-scripts。账号仓库使用 npm ci --ignore-scripts。已安装依赖无需反复下载。

将下面变量改为协作者电脑上的真实绝对路径。SDK 是官方 dsh-llm 包目录，目录内应有 package.json 和 lib，并可加载其配套依赖；不要只复制一个 JS 文件。没有 SDK 或核心路径时，部分测试会跳过，不可把有 skip 的运行写成“453 项零跳过”。

```powershell
# 在账号仓库执行
$env:OFM_CORE_DIR='<核心仓库绝对路径>'
$env:OFM_CONNECTORS_SDK_ROOT='<官方SDK目录>\node_modules\@deepseek-ai\dsh-llm'
node --test --test-concurrency=1 tests/*.test.mjs
node scripts/check.mjs

# 在核心仓库执行
$env:OFM_CONNECTORS_DIR='<账号仓库绝对路径>'
$env:OFM_ORIGINAL_DIR='<上游ac4c55e源码绝对路径>'
node scripts/test-all.mjs --mode contributor
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node --test scripts/paired-hot-update-test.mjs
```

若修改账号插件的源码或打包文件，必须按顺序更新，保证独立插件与核心携带的副本一致：

```powershell
# 先在账号仓库
node scripts/build.mjs
node scripts/check.mjs
npm pack --ignore-scripts
node scripts/pack.mjs

# 再在核心仓库
node scripts/build-paired-companion.mjs '<账号仓库绝对路径>'
npm pack --ignore-scripts
```

然后重跑受影响的测试，核对新包文件、manifest 和 SHA-256，更新 dev-install 中的候选及校验值。账号 README.md、docs/INTEGRATION.md 本身属于 extension.json 的清单文件，修改它们也必须重新构建并更新配套载荷。核心独立/桌面打包接线已完成，重建方法见核心 PACKAGING.md；本轮上传的候选不包含新的 Windows 安装器。

## 6. 正式发布还需要什么

1. 审核这两个开发分支，进行需要的真实账号/宿主验收，固定要发布的提交和文件。
2. 核心候选号 2.3.1-split.1 是为了高于旧 2.3.0、让版本比较识别升级；正式版本号由维护者流程决定。账号候选仍是 0.1.0，必须同时核对哈希，避免误用旧同版本包。
3. 使用已审核可信主线中的 scripts/prepare-release.mjs，以 --base、--candidate、--output 指定完整提交号和新的输出目录，通过可信环境提供原发布者的 OFM_RELEASE_SIGNING_KEY（PEM 内容）。脚本从 Git 读取候选文件，产出绑定候选的补丁与回执；具体操作由持有原私钥的维护者完成。
4. 同步生成并审核 feed/manifest.json、catalog/integrity.json、catalog/dsh-plugin.json、catalog/provenance.json，发布同一批清单及声明文件，包括 companions/account-connectors.json.gz，再执行正式 release 模式检查。

本分支保留原 Ed25519 公钥。没有原私钥，不得换公钥或用测试密钥冒充正式签名。当前 feed/manifest.json 与 catalog/integrity.json 仍保留旧上游签名记录，定制文件的字节已变化；因此正式 manifest:check / release 模式尚未满足，不能把 contributor 回归通过写成正式发布校验通过。旧更新器专项中的签名属于隔离测试，不是线上签名发行。

本次只上传开发分支和开发包。已有用户尚未通过线上热更新收到本次内容，服务器与主线未在本次交接中变更。

## 7. 应使用的包

每个仓库 dev-install/checksums.json 列出该仓本次包的大小和 SHA-256。SHA-256 是文件指纹，用来确认拿到的是同一份内容，不等于正式发布者签名。

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| dsh-our-free-model-2.3.1-split.1.tgz | 2295576 | 4ba7bd686dbb0587528bbb95a356025eb75938bcd1aae057827fd5090992a4e6 |
| dsh-ofm-account-connectors-0.1.0.tgz | 1225102 | 96edd0728bfececed159dcd60504d393ecd6e1637bb7c86827c44e450baa37bd |
| ofm-account-connectors-0.1.0-external.zip | 1237122 | 7bd52736b8dd7ce21c988062de83a00c9acd8ee15ad2cb0b324a30566c2dfaec |

核心配套载荷指纹：d6bb57d2d0580d8d7968a9e31e16625f16d299b85755521f0e9bb2ab902fbd84（1868324 字节，37 文件），与独立插件源码和官方宿主验收的载荷一致。旧 dev-install/dsh-our-free-model-2.3.0.tgz 和 account-connectors-0.1.0-dev.zip 是历史包，不用于本次验收。

上传时另加了一条窄范围 Git 属性：账号仓库 /README.md -text。该文件的已验收字节使用 CRLF 换行，extension.json 按这些字节计算指纹；保留原字节可避免 Git 默认转成 LF 后导致新克隆的清单校验失败。未修改该文件内容或重做候选包。其余代码仍沿用仓库既有换行规则。
