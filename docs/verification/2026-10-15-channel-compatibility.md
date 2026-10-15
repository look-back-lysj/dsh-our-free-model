# 双插件渠道兼容升级：2026-10-15 验证记录

更新时间：2026-10-15（Asia/Shanghai）。持续目标仍 active。此处汇总最终实测，不把旧阶段的通过数、旧同名包或目录成功当作本轮完整完成。

## 目的 Purpose

保证拆分后的 OFM 核心和独立账号扩展通过稳定的模型/请求/取消/启停合同协作，修复已证实的过时解析和资源问题，保留插件、独立网页与桌面共用页面的原有昼夜风格。免费页面区分“已收录”“已验证可用”“使用资格受限”。

## 架构与范围 Architecture & Scope

项目未正式使用 L1/L2/L3 命名；按实际边界为 DSH 入口与可选服务、核心模型/API 运行时、独立 HTTP 管理/网页、桌面共用资源、独立账号 Worker 与厂商适配器。

- 双插件：刷新期间的通知不会丢失；停用、故障、换实例立即撤目录/取消；注册或撤回完成后通知；公开 typedchunk 保留必要类型并拒绝非法对象；无限通知有读取预算。
- WorkBuddy：共同请求出口不再发送引发兼容问题的 reasoning_effort；CodeBuddy 保留显式和默认档位。
- MiniMax：工具名字可晚到/分片，交错参数和多轮工具保持；空名、不完整参数、错误与取消不会冒充成功。
- Qoder/中国版：真实 WASM 上下文、请求结果及返回字符串释放；幂等 dispose，异常不遮主错，二进制未改。
- Loomy：动态/兜底共用 qwen-3.8-max 图片规则，spark-x 有效窗口修正；未知与零值不编造。
- Cline：成功目录缓存 6 小时，部分失败 30 秒重试；保留已知元数据；true/false/unknown 分开；消费者独立取消、总时限、同轮重试和迟到隔离；不再改动其他提供商共享闸门。
- LobsterAI：未知与显式 0 分开；有效完整包可恢复总额；HTTP/信封失败不冒充余额；十进制 BigInt 求和后按分舍入、检查安全范围；面值和已用量不再由剩余量猜测。
- TRAE：缓存 read/write 与未缓存输入互斥，矛盾拆分舍弃而保留权威输入；缓冲块中取消也不会报成功，释放 reader；非法/不安全计数不发布虚假 total。
- 登录反馈：后台失败、用户取消、渠道停用、等待超时形成明确轮询终态；64 条/5 分钟有界保留；10 分钟待授权超时关闭资源；迟到授权不能写凭据；诊断回调 URL 查询串脱敏。
- 免费渠道：Jev/SystemOne 不进聊天；Big Pickle 收录但实际权限被拒绝时不路由；Responses 嵌套错误保留；探测需非空正文、正常结束、无错误且未超时。旧绿色缓存降为待验。

## 风险与兼容 Risks & Compatibility

所有真实厂商账号生成仍未验收。CodeArts、Raccoon、ZCode、Gemini 等渠道有部分当前主源/配置资格不足，未据此宣布可用。Gemini 本机 OAuth 配置及资格边界保持，不恢复内置 Secret。账号数据默认隔离，扩展初装不启用，安装不扫描/接管旧账号。

MiniMax 首个工具之后缓冲到完整性检查后输出，有额外延迟/内存成本；真实长会话尚未验证。Qoder 80 轮真实 WASM 实验的稳定结果只适用于该二进制、合成载荷与规模。JSON number 在到达客户端前已丢失的十进制精度无法恢复；精细余额优先使用服务端十进制字符串。

当前真实官方 DSH 仍是旧整合核心，未安装本轮包。新旧账号实现同时运行会争用供应商；应先替换核心，再安装独立扩展。没有修改用户 profile、服务器、OAuth 应用、账号权限或域名。

## 验证 Verification

- [x] 用户要求的团队调查、实际源码实现、独立审查与返工落实；429 退出的 worker 不算完成，后续已接手。
- [x] 两仓 git diff --check 通过。
- [x] 最终包排除日志、凭据、用户数据和本机测试缓存。
- [x] UI 有实际截图，区别本地 fixture 与真实厂商调用。
- [x] 所有未验证项明确列出。

| 实际命令 | 结果 | 范围 |
| --- | --- | --- |
| 核心 node scripts/test-all.mjs --mode contributor | 48/48 套件通过 | 所有离线核心回归；不等于现网全部模型 |
| 扩展 node --test --test-concurrency=1 tests/*.test.mjs | 342/342，0 跳过 | 明确设置 OFM_CORE_DIR 和 SDK 0.2.0-rc.2；包括真实 business/账号池/OFM 桥 |
| Cline 完整真实 TS 回归 | 24/24 | 目录来源、三态、TTL、取消、旧结果、图片 bytes、服务权限拒绝 |
| LobsterAI/TRAE 真实 TS/SDK 回归 | 185/185 | 余额数值与边界、缓存用量、同块取消/错误 |
| 登录真实 business/池/持久化/轮询测试 | 7/7 | 仅授权结果为合成；不是替换 poll/parser/pool |
| npm run build / npm run check | 通过；35 文件、6 UI 资源 | 真实 vendor → business，生成包哈希和语法边界 |
| 独立初批/第二批审查 | 22 项、26 项 | 原失败反例保留，逐项补修；见旧 audit 报告 |
| P1 独立数值/取消反例 | 原 6 组最终通过 | 首轮 5 FAIL 保留 INITIAL，非空/正常与拒绝对照 |
| Cline/登录独立审查 | C1/C2/C3/L1/L2 通过 | C2 最终定向重编译；其他项沿用实测，非宣称最后全部再跑 |
| node scripts/build-standalone-ui.mjs / --check | 最终通过，8 资源一致 | 本轮发现旧 app.js 漂移后已重建，旧产物留证 |
| node scripts/standalone-react-ui-test.mjs | 13 组、38 张图 | 真实新构建网页，昼夜/320/390/200% 无横向溢出 |
| node scripts/ui-preview.mjs | 42 张图与交互通过 | 插件真实 React/Edge，本机宿主替身；主题包缺失处标 fixture |
| node scripts/joint-ui.mjs <core-dir> | 通过 | 真实 HTTP/管理 Cookie/外置 Worker/UI/RPC；0 账号、13 渠道关闭 |
| node packaged-joint-check.mjs | PASS；核心 72/扩展 35 文件与源码一致 | 最终实际 tgz 安装、启用、停用、重启、卸载保留数据 |
| node desktop-resource-check.mjs | PASS | 当前网页/后端新资源；未启动原生 Tauri 窗口 |

免费实测：2026-10-14 20:55 正常 OpenCode Big Pickle 返回 403/FreeTierError，未绕过限制。Kilo 官方允许匿名第三方免费路径；同一免费模型 32 token 实验仅思考截断，1024 token raw 实验得到 OK/stop/原始 cost=0；随后实际 OFM 本机 HTTP → 核心 → Kilo SSE → 解析 → JSON 一次调用得到 OK/stop。总计 3 次 Kilo 生成，最终链路仅 1 次、无重试/切模型/切路；核心响应无费用字段，未编造 cost=0。单模型单次成功不扩为 15 免费候选全部成功。

权威本地结果：core-contributor-result.json、extension-all-result.json、standalone-ui-result.json、real-joint-ui-result.json、packaging-results.json、desktop-resource-result.json。旧详细来源与反例位于 D:/ofm-audits/20261014-connectors-refresh。

## 配置与迁移 Configuration & Migration

候选包位于 candidate-packages。核心 tgz 与扩展 tgz 必须成组使用；外置 ZIP 解压后选含 extension.json 的完整目录，给独立/桌面核心导入。旧同名包/旧公网 dev-install 链接没有被更新，不代表这次内容。

旧账号仍原位保留；导入必须走预览确认。探测缓存迁移只重置旧绿色证据，不删除账号、密钥、设置或负面判断。新增本机服务/认证的 A/B/C 方案没有由用户选择，因此本轮没有部署 9router 或收费认证。

## 回退方式 Rollback

先停用账号扩展，再恢复上一组核心/扩展代码和保留配置。不要同时启用旧整合核心与新独立账号供应商。卸载默认保留数据；没有不可逆数据库迁移。

## 完整目标仍待完成

1. 在用户官方 DSH 中替换旧整合核心并联装候选；用户前文选择自行安装，本轮未替用户改安装。需要真实管理页、热装卸、模型选择器、取消和重启验收。
2. 13 家需要对应的正式授权账号与服务资格，逐家验登录/续期、额度、短文本、工具往返、图片和取消；不在聊天里收取明文秘密。
3. 原渠道调查还有尚未独立复现/关闭的 P1/P2 候选：续期后账号归属、部分图文拼接、共享 DSML 等；不能把“有上游补丁”写成“已修复”。
4. 用户仍可选 A/B/C 技术路线；当前已修现有问题并验证内置 Kilo 正常路径，不以新增重服务擅自替代用户选择。

持续目标不标完成。本轮阶段结果为可审核的源码、候选包、验证证据和待验清单。
