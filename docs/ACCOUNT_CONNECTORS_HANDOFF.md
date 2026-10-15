# 本次拆分怎么接手

这次只上传开发分支，没有合并上游main。两个仓库各有一个新的源码提交，提交账号为look-back-lysj，邮箱3597536534@qq.com。

## 仓库和分支

核心：look-back-lysj/dsh-our-free-model，refactor/separate-account-relays。保留共享模型、EAC、官方API、网关/路由/节省Token与原界面；src/extensions只实现通用可选桥接和外置宿主。

扩展：look-back-lysj/dsh-ofm-account-connectors，refactor/independent-account-connectors。持有十三产品账号渠道、认证、独立界面、Worker、专用WASM和许可来源，可单独安装。

## 安装和停止

先替换旧整合版OFM，再装独立扩展，按宿主要求重启。安装不启用，启用后各渠道仍首次关闭。账号管理由扩展处理，OFM指引页检测连接状态。

停止撤回模型、取消任务；卸载保留数据。新旧模块注册冲突要先处理，不能保留旧供应商路由却显示新模块成功。不存在的账号模型不可误转匿名核心。

DSH插件tgz和外置扩展zip位于各仓库dev-install，大小/SHA256见checksums.json。Windows核心安装程序作为草稿制品附件，未发布正式版本。复制安装链接应使用HTTPS文件直链，而不是网页仓库地址或本机路径。

## 构建与复验

核心入口：PACKAGING.md。根目录没有锁文件，不要使用npm ci；根目录npm install --ignore-scripts --legacy-peer-deps，standalone/desktop按各自锁文件安装。前端先构建，再桌面prepare/build。

扩展入口：README.md。npm ci --ignore-scripts，npm run build，npm test，npm run check。源码直接从vendor构建，不需要client-seed/runtime-seed或历史diagnostic目录。

联合验证使用真实核心仓库绝对路径：node scripts/joint-smoke.mjs <核心仓库>，node scripts/joint-ui.mjs <核心仓库>；浏览器工具可用OFM_PLAYWRIGHT_DIR与OFM_BROWSER_EXECUTABLE指定。无真实账号的数据和截图已保存在验证说明中。

## 验证边界

核心47/47套件、扩展26/26、实包联合5/5、管理16/16、桌面资源生命周期7/7已通过。UI实际编译网页和独立扩展联装有截图；真实用户DSH安装和厂商登录/推理尚未完整验收。

实际原生桌面窗口启动被自动审批拒绝，未把安装向导/窗口验收写成通过。发布签名与正式市场上架仍需要维护者流程。GitHub分支与草稿上传不代表厂商授权或免责。

## 与服务器维护的边界

服务器接替、OAuth续期、旧用户和统计迁移由原服务器对话继续。核心保持PR306新网关密封配置，15:32本轮源码的签名清单、授权与池接口检查成功；本分支不改服务器配置，也不携带管理员Token、OAuth Secret、root密码或用户库。

私密服务器交接不能放入这些仓库。原账号文件保留原位；迁移必须用户预览并确认。当前源码与制品资料不含真实账号/登录凭据。

## Google OAuth 上传修正

独立扩展没有携带上游内置Google客户端凭据。Gemini登录需要本机提供有权使用的兼容Client ID/Secret，缺配置时明确拒绝；真实登录仍未验证。具体配置说明在扩展docs/GEMINI_OAUTH_CONFIG.md。核心/EAC和其他渠道不使用这些Google变量。
