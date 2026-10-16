# 本次拆分怎么接手

这次只上传开发分支，没有合并上游main。两个仓库各有一个新的源码提交，提交账号为look-back-lysj，邮箱3597536534@qq.com。

## 仓库和分支

核心：look-back-lysj/dsh-our-free-model，refactor/separate-account-relays。保留共享模型、EAC、官方API、网关/路由/节省Token与原界面；src/extensions只实现通用可选桥接和外置宿主。

扩展：look-back-lysj/dsh-ofm-account-connectors，refactor/independent-account-connectors。持有十三产品账号渠道、认证、独立界面、Worker、专用WASM和许可来源，可单独安装。

## 安装、热更新和停止

新版核心包携带配套的独立账号扩展载荷。旧整合版通过签名热更新进入分离版时，核心启动会调用宿主插件管理器安装账号扩展，并把旧账号索引、凭据、模型开关、签到/用量/网关状态迁移到独立 dataDir。迁移采用 staging、回读校验和失败回滚；旧目录和旧凭据引用保留，不会因为迁移失败丢失登录状态。重复启动只会复用已完成迁移，不覆盖新凭据。

更新包仍受原有清单签名、路径和单文件大小限制；配套账号载荷也逐文件校验。没有宿主 pluginManager 的极简/TUI composition 不等待热安装，核心模型车道照常启动。

安装成功后，账号扩展默认沿用原来的启用状态；新增账号渠道仍按自愿启用规则运行。两个插件同时存在时，核心可以调用账号插件模型，账号插件也保留自己的独立管理页面和本地网关。停用一方只撤回它拥有的模型/监听，不删除另一方。

停止撤回模型、取消任务；卸载保留数据。新旧模块注册冲突明确拒绝，不会保留旧供应商路由却假报新模块成功。不存在的账号模型不可误转匿名核心。

DSH插件tgz和外置扩展zip位于各仓库dev-install，大小/SHA256见checksums.json。Windows核心安装程序作为草稿制品附件，未发布正式版本。复制安装链接应使用HTTPS文件直链，而不是网页仓库地址或本机路径。

## 构建与复验

核心入口：PACKAGING.md。根目录没有锁文件，不要使用npm ci；根目录npm install --ignore-scripts --legacy-peer-deps，standalone/desktop按各自锁文件安装。前端先构建，再桌面prepare/build。

扩展入口：README.md。npm ci --ignore-scripts，npm run build，npm test，npm run check。源码直接从vendor构建，不需要client-seed/runtime-seed或历史diagnostic目录。

联合验证使用真实核心仓库绝对路径：node scripts/joint-smoke.mjs <核心仓库>，node scripts/joint-ui.mjs <核心仓库>；浏览器工具可用OFM_PLAYWRIGHT_DIR与OFM_BROWSER_EXECUTABLE指定。无真实账号的数据和截图已保存在验证说明中。

## 热更新验收补充

热更新专项位于 `D:/ofm-audits/20261015-paired-hot-update/`：旧签名更新器配套载荷安装 1 组、迁移/回滚/幂等 9 项、账号插件完整回归 452 项、实际外置页面与独立网关启停均已记录。

## 验证边界

核心47/47套件、扩展26/26、实包联合5/5、管理16/16、桌面资源生命周期7/7已通过。UI实际编译网页和独立扩展联装有截图；真实用户DSH安装和厂商登录/推理尚未完整验收。

实际原生桌面窗口启动被自动审批拒绝，未把安装向导/窗口验收写成通过。发布签名与正式市场上架仍需要维护者流程。GitHub分支与草稿上传不代表厂商授权或免责。

## 与服务器维护的边界

服务器接替、OAuth续期、旧用户和统计迁移由原服务器对话继续。核心保持PR306新网关密封配置，15:32本轮源码的签名清单、授权与池接口检查成功；本分支不改服务器配置，也不携带管理员Token、OAuth Secret、root密码或用户库。

私密服务器交接不能放入这些仓库。原账号文件保留原位；迁移必须用户预览并确认。当前源码与制品资料不含真实账号/登录凭据。

## Google OAuth 上传修正

独立扩展没有携带上游内置Google客户端凭据。Gemini登录需要本机提供有权使用的兼容Client ID/Secret，缺配置时明确拒绝；真实登录仍未验证。具体配置说明在扩展docs/GEMINI_OAUTH_CONFIG.md。核心/EAC和其他渠道不使用这些Google变量。
