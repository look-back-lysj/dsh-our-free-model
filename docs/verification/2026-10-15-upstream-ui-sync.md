# 2026-10-15 上游 UI 同步验收

## 范围

本次 UI 同步在 `D:/ofm-worktrees/ofm-core-upstream-20261015` 完成，目标版本以当前工作树实际版本 `2.3.0` 为准。只处理浏览器端、独立端前端、UI 预览和 UI 验收脚本；没有修改 `src/**`、版本字段或 `scripts/test-all.mjs`。

上游插件升级页设计依据：`docs/superpowers/specs/2026-10-15-plugin-upgrade-nav-design.md`。

## 合并结果

- 插件端导航保留上游新增的 `插件升级` / `Plugin upgrade`，并紧跟 `网关设置` / `Gateway`。
- `UpgradePanel` 的版本状态、检查更新、立即升级、热重载、自动热重载、升级历史、恢复备份和失败提示继续使用原有接口。
- 原免费模型页底部保留“打开插件升级”按钮，旧入口会切换到同一个升级页；免费模型页不再重复渲染升级面板。
- `channels` 旧本地页状态会兼容归一化到 `extensions`，导航和页面使用独立账号连接扩展指引；没有重新引入内置账号渠道页面或旧账号 RPC。
- onboarding 公告继续使用 body 级 portal host。主界面可被 inert、变换或建立 stacking context 时，公告弹层仍在 `document.body` 下可点击；关闭后 portal host 会清理。
- standalone 新增 `插件升级` 导航页，显示本机服务实际返回的当前版本、发行页入口和独立服务升级步骤。standalone 管理服务没有应用内热升级接口，因此页面没有伪造检查更新、立即升级或热重载请求。
- standalone 的账号连接扩展入口和安装指引继续保留；生成的 `packages/standalone/web/assets.json` 共 8 个资源，没有 `channels`、`channel-pack` 或旧 provider-list 构建资源。
- 现有昼夜主题、小按钮样式、按钮状态和窄屏溢出处理均沿用；新增 standalone 升级页只复用已有按钮、卡片、徽章和主题变量。

## 实际验证

所有命令均在 `D:/ofm-worktrees/ofm-core-upstream-20261015` 执行，审计输出在 `D:/ofm-audits/20261015-upstream-sync/ui/`，没有记录真实账号、令牌或 API Key。

| 检查 | 结果 |
| --- | --- |
| `node scripts/build-standalone-ui.mjs` | 退出码 0，生成 8 个本地资源 |
| `node scripts/build-standalone-ui.mjs --check` | 退出码 0 |
| `npm --prefix packages/standalone run typecheck` | 退出码 0 |
| `node scripts/client-lint.mjs` | 退出码 0，553 个文案键、128 条样式规则通过 |
| `node scripts/heatmap-test.mjs` | 40 项通过 |
| `node scripts/sanitize-test.mjs` | 通过 |
| `node scripts/upgrade-ui-test.mjs` | 8 项通过 |
| `_render-probe.mjs`（upgrade、extensions、channels 兼容别名、gateway） | 全部退出码 0 |
| `node scripts/standalone-frontend-test.mjs` | 通过 |
| `node scripts/standalone-react-ui-test.mjs` | 13/13 组通过，38 张截图 |
| `node scripts/ui-preview.mjs --themes light,dark --browser msedge` | 48 张页面截图 + 1 张交互截图；无空白页、浏览器错误或整页横向滚动 |
| `node scripts/upstream-ui-parity-test.mjs --out-dir .../parity` | 20 项通过，34 张截图 |
| `impeccable detect --json ...` | 退出码 0；报告中的风格提示属于已有视觉系统，未改动用户要求保留的风格 |
| `git diff --check` 与 UI 冲突文件缓存检查 | 通过 |

`upstream-ui-parity-test.mjs` 的浏览器检查覆盖：

- 插件端中文和英文导航顺序，以及刷新后升级页选中状态保留。
- 旧更新入口切换到独立升级页，升级面板只出现一份。
- 检查更新、失败后重试、热重载、自动热重载、立即升级、恢复状态和版本不一致状态。
- 插件端浅色/深色主题以及 1280、390、320 像素宽度。
- body 级 onboarding portal 的可点击性、inert 隔离、重复打开和 host 清理。
- standalone 端浅色/深色主题以及 1280、390、320 像素宽度。
- standalone 当前版本显示、发行页入口、升级指引、扩展指引、实际点击升级导航、刷新后选中页和主题保留。
- 两端均没有访问旧内置账号 API；standalone 没有发出不存在的 `/update/*` 或 `/reload` 请求。

## 资源冻结

最终一次网页重建发生在 UI 小修之后，命令为 `node scripts/build-standalone-ui.mjs`，退出码 0；随后 `node scripts/build-standalone-ui.mjs --check` 退出码 0。网页资源已冻结，可以开始新的 `2.3.0` Tauri 构建。

资源 SHA-256 和生成清单见：

- `D:/ofm-audits/20261015-upstream-sync/ui/web-freeze.json`
- `D:/ofm-audits/20261015-upstream-sync/ui/preservation-check.json`

浏览器报告和截图见：

- `D:/ofm-audits/20261015-upstream-sync/ui/parity/report.json`
- `D:/ofm-audits/20261015-upstream-sync/ui/preview/report.json`
- `D:/ofm-audits/20261015-upstream-sync/ui/standalone-regression/`

## 边界与主控后续项

浏览器测试使用真实 React 与本地 Edge。插件预览未命中本地 DSH theme 包，因此使用预览脚本原有 fallback 主题变量；standalone 直接验证最终构建资源及其原有浅色/深色主题。所有升级操作都针对本机隔离 API 替身，未下载或安装线上升级包；Tauri 安装包构建与安装验收由主控继续。预览报告保留原有装饰裁剪及局部子元素的 escapes 记录，硬性检查为整页没有横向滚动。

后端 `src/probe.js` 的 `applyFingerprint` Messages wire P2 由主控在后端写域修复，并补充请求体顶层 `name` / `input_schema` 的桩断言。UI 工作树没有跨域修改该问题。

当前 `git ls-files -u` 无输出，UI 冲突文件 `client.js` 和 `scripts/ui-preview.mjs` 已解决并加入 index；本轮没有提交或推送。
