# 分离版同步上游 2.3.0：完成说明与验收

日期：2026-10-15（Asia/Shanghai）。本轮完成源码同步、离线与隔离宿主联装、开发候选打包。用户日常 DSH、账号及服务器均未修改；未提交、推送或合并主线。

## 目的 Purpose

用户要求把上游新更新接入已分离的 OFM 核心和独立账号插件，使组合后的对应功能跟上上游，保留昼夜界面及此前修复。当前同步基准为上游 main ac4c55ef5e0833bf0138846a7c5255ecbc14a07c，版本 2.3.0；相对拆分基准 226a9ec 有 28 个提交、57 个变更文件。收尾使用 git ls-remote 再次确认 main 仍为该 SHA。

## 架构与范围 Architecture & Scope

项目未使用正式 L1/L2/L3 名称，按实际入口分层：DSH 核心插件、共享模型运行时、独立账号插件/Worker、standalone 网页和 Tauri 桌面。

| 本轮上游更新 | 分离版处理 |
| --- | --- |
| 免费车道 /inference/v1、会话头、会话映射及工具格式 | 已同步；保留前次非空正文/正常结束探测、超时和错误解析修复 |
| FreeTierError 的 LANE_LOCKED 合同 | 采用上游错误/探测语义，保留旧 access 分类兼容；明确拒绝优先于额度与凭据文案，不触发换号或同轮重试 |
| 插件升级独立导航 | 插件端保留检查、升级、热重载、历史和旧入口；standalone 增加实际版本与包升级指引，不伪造不存在的自更新接口 |
| 首次公告 React portal | 与分离扩展指引共存，补全 ReactDOM 依赖和原联装测试环境 |
| 版本和桌面 | 根插件、standalone、desktop、npm/Cargo 锁与 Tauri 配置均为上游 2.3.0 |
| 账号渠道 | 上游本轮未改 vendor/channel-pack；原扩展源码及前轮修复保留，重建并与新核心复测 |
| 文档/公告/交流群/发布来源 | 同步上游记录；其签名仅代表上游原始整合包，不代表当前定制制品 |

额外修复一：上游全局会话映射默认写到 DSH_HOME，分离后的 standalone/desktop 有独立 dataDir。本轮引入按目录绑定的 session mapper，并贯通目录请求、生成和探测，避免进程/产品串目录；保留原 canonical session 透传与跨进程持久化。

额外修复二：Messages 探测按对应顶层 name/input_schema 构造工具，不使用 Chat 的 function.parameters；真实桩请求断言覆盖该格式。

额外修复三：分离版一键升级拒绝重新内置账号模块的整合版清单，避免双插件冲突。正式验签照旧执行；仅在验签后对布局路径做规范化/大小写比较，不改动签名字节。正确的已签名分离版仍可正常暂存、安装和激活。

新源码工作树：

- 核心：D:/ofm-worktrees/ofm-core-upstream-20261015，分支 sync/separated-upstream-20261015，HEAD 是上游固定 SHA，分离及后续修复在工作区。
- 扩展：D:/ofm-worktrees/ofm-connectors-upstream-20261015，分支 sync/account-connectors-20261015，保留原扩展 HEAD 和所有 WIP。
- 旧工作树逐文件对照：核心 398、扩展 262 文件均未改动，见 original-worktrees-preserved.json。

团队分工：主控负责上游固定、保护快照、后台/会话适配、升级边界、打包与真实宿主；扩展成员负责构建与 449 项；UI 成员负责冲突、升级页/portal/昼夜截图；独立审查成员复核会话隔离、Messages 格式及升级路径别名，发现项均已修正并复核关闭。

## 风险与兼容 Risks & Compatibility

组合后的对应功能已通过本轮源码/隔离验证。安装方式和默认自愿启用保持分离设计，因此不是与上游整合包逐字节相同。13 项真实账号登录、配额、续期、真实生成/图片/工具尚未全部验证，不能声称厂商永久可用；本轮没有消耗用户真实账号。

新版升级页面会拒绝上游整合包覆盖分离版；后续更新应使用配套分离包，或由发布者发布满足同一布局和信任根的分离签名清单。不会修改公钥、伪签或放宽签名验证。

继承的 feed/manifest.json 是上游原始整合包的签名记录。当前定制树 manifest:check 按预期失败：字节/文件组成已不同，缺少发布者私钥无法正式重签。开发包实际 SHA256、构成与 upstream SHA 单独记在 artifacts.json；这不等同于正式发行签名。Windows 安装包亦未签名。

扩展构建路径中的 esbuild 模块注释受依赖真实目录影响，跨目录构建不保证逐字节同哈希；规范化路径注释后业务/网页与原构建一致，见扩展记录。

## 验证 Verification

- [x] 相关构建、类型检查、代码回归与独立复核已完成。
- [x] 两仓 git diff --check 与 git diff --cached --check 通过，无未解决合并标记。
- [x] 候选包按白名单核对，无用户账号、私密配置或凭据；旧工作树未覆盖。
- [x] UI 有真实浏览器截图；已由主控查看桌面/窄屏/portal 代表图。
- [x] 未验证项与发行签名限制明确列出。
- [ ] 正式发行签名及定制树 manifest:check：未通过；这是开发候选，原因见上。
- [ ] 用户正式 DSH profile、全部真实渠道账号、原生 Tauri 窗口与安装向导：本轮未执行。

| 实际命令/动作 | 结果和证据 |
| --- | --- |
| git fetch --no-tags upstream main；git ls-remote upstream refs/heads/main | 固定并复核 ac4c55e；28 提交/57 文件。机器旧 github 专用代理未运行，仅本次命令禁用该代理，不修改全局配置 |
| node scripts/test-all.mjs --mode contributor | 53/53 通过，core-contributor-layout-final.log；最后路径规范化补修后 updater/separated-updater/account-connectors-plugin/upgrade-ui 四相关套件再过，alias-final-results.json |
| node scripts/separated-updater-test.mjs | 7/7，涵盖真实临时签名、允许分离更新、整合拒绝、检查后换包及四个路径别名；final-alias-separated-updater.log |
| node scripts/upstream-session-isolation-test.mjs | 3/3，实际双 HTTP 服务及新 Node 进程重启；明确 method/path 与外部 DSH 哨兵 |
| node scripts/free-channel-contract-test.mjs | 15/15，含 Messages 真实请求格式、流失败不冒充成功；已纳入最终全套 |
| 扩展 npm run build；npm run check；node scripts/smoke-worker.mjs | 全部通过，35 声明文件及 6 个 UI 资源；默认 13 项关闭/0 模型 |
| node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs，明确 OFM_CORE_DIR 与真实 SDK 0.2.0-rc.2 | 最终 449/449，0 fail/skip/cancel；extension/full-suite-final-result.json |
| 核心 tsc --noEmit；standalone typecheck；build-standalone-ui --check | 通过，extra-final-checks.json、ui 对应日志 |
| node scripts/upstream-ui-parity-test.mjs | 20 项、34 截图；与现有 standalone 13 组/38 图、插件预览 48 页面图+1交互共同验证，无空白/脚本报错/整页横向溢出 |
| npm pack --ignore-scripts；node packaged-joint-check.mjs | 最终实际 tgz 核心 72/扩展35文件与源码相同，安装默认off、enable/disable/reenable、卸载保留数据通过 |
| node scripts/account-connectors-package-integration-test.mjs，指定实际外置目录 | 5/5，经真实 HTTP 认证管理入口，非用户正式 profile |
| 官方 dsh plugin add --offline --ignore-scripts ...；官方 --profile ofm-compat | 最终候选在新 D 盘隔离 profile 17 项通过；真实 LlmRuntime/credentials/commands，退出服务/定时器/句柄均释放；official-dsh/latest-verified-proof.json |
| tauri build --ci --no-sign --bundles nsis -- --locked --offline | Windows x64 2.3.0 成功；不安装，只构建与解包 |
| 7-Zip 解包；node desktop-build/verify-installer.mjs | 包内82服务资源与最终源码一致；内置Node空PATH启动、认证、扩展联装/停用/卸载、退出0、锁清理、外网请求0；installer-verification.json |
| node scripts/build-manifest.mjs --check | exit1，如实记录：继承签名不覆盖定制字节；未以伪签清单绕过，custom-manifest-check-result.json |

测试过程保留初次失败：原三方应用含旧生成资源/已删脚本，整体未应用后改为源码三方合并并重建；旧 React 替身缺 react-dom，补真实依赖后过；新增签名样本最初漏解析默认字段/激活版本确认，修正测试合同后过；PowerShell 一次长引号解析失败后立刻改用 Node 文件操作，没有原样重复。原失败日志均未删除。

## 配置与迁移 Configuration & Migration

DSH：先替换旧整合核心，再安装独立账号插件，按官方宿主提示重启。两个文件分别为 dsh-our-free-model-2.3.0.tgz、dsh-ofm-account-connectors-0.1.0.tgz。各渠道首次保持关闭，需用户正常登录与主动启用。不要让旧整合核心和新账号插件同时挂载同名渠道。

独立网页/桌面：使用新 2.3.0 安装器或源码构建；账号扩展 ZIP 解压后导入包含 extension.json 的完整目录。导入不自动启用，旧账号迁移先预览再确认，不删除原数据。

本轮未修改用户正在用的 DSH 或服务器，不需要对现网做配置迁移。旧公网 dev-install 链接仍是历史包，不能代表本次更新，禁止沿用旧地址声称已经实装。

## 回退方式 Rollback

原工作树和完整快照均保留。本轮没有部署，无用户程序回滚操作。以后验收安装需回退时，先停用独立账号插件，恢复原核心包及原配置，保留账号/EAC授权/用户会话，按宿主提示重启。卸载扩展默认保留账号数据。

最新候选：candidate-packages/；两份完整源码快照：source-snapshots/。实际文件校验值见 SHA256SUMS.txt。
