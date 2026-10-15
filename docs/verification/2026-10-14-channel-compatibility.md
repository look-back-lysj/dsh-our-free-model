# 账号连接与免费渠道兼容升级：第二批验证

日期：2026-10-14（Asia/Shanghai）。仅本地开发分支，不更新正式签名、版本、线上服务或用户真实profile。

## 目的 Purpose

分离后的核心与账号扩展继续独立运行，并修复调查确认的真实代码缺口。免费页区分“模型已收录”“回答已验证”和“使用资格受限”，避免把目录HTTP200当生成成功、把服务策略当坏密钥。保留已有插件及独立/桌面昼夜视觉。

## 架构与范围 Architecture & Scope

本项目没有正式L1/L2/L3命名，按实际边界记录：核心HTTP错误、流解析、探测、缓存、模型目录和路由成员；DSH/独立HTTP管理及前端；独立账号扩展vendor适配器和生成business包。

- 前批合作合同：异步目录通知、停用/换实例立即撤目录和取消、注册完成后通知、typedchunk标量与类型白名单。
- WorkBuddy仅在共同请求体出口省略reasoning_effort，CodeBuddy显式/默认档位保留。
- MiniMax补工具名称/参数分片、晚到名称、空名过滤与真实终止；首工具之后暂存至完成检查再按原顺序回放。
- Qoder及中国版共用WASM上下文/RequestResult/返回字符串正确释放；异常不遮主错、dispose幂等，二进制不改。
- Loomy动态和fallback统一qwen-3.8-max图片判据、spark-x窗口262144；原ID和未知/零值语义保留。
- 免费错误FreeTierError保留ACCESS_RESTRICTED，不当坏凭据、限流或账户轮换；Responses嵌套错误在共用生成parser保留。
- 探测总时限覆盖响应头/流/解析/结果发布；非空正文+明确结束且无错误才标可用。旧缓存version1/缺version绿色证据降为待验，负面证据保留。
- Big Pickle进入免费候选；Jev SystemOne不进聊天，catalog实际Messages/Responses协议一致。模型容量旧fallback属于默认估算，不声称本轮厂商实测。
- 插件未探测的Kilo/EAC/官方API/扩展/组合模型从available改为listed；路由入口保留，与独立端的listed语义一致。
- 受限提示不引导反复登录/无限重试。独立页按容器实际宽度适配窄屏/200%缩放。

## 风险与兼容 Risks & Compatibility

账号凭据、数据目录、默认停用、各渠道显式启用、OAuth本机配置及取消边界保留。没有恢复硬编码OAuth secret或扩大真实账户权限。普通合作接口不发送账号秘密。

MiniMax为避免提前输出空名/残缺工具，在首个工具之后缓冲事件；该段延迟与内存开销增加，真实长会话体量尚未验证。WASM80轮实验仅证明当前二进制和合成载荷，不证明所有真实长期会话问题已解决。

旧真实DSH目前仍为整合核心，无新独立扩展，安装前须替换旧核心，避免同名供应商冲突。真实用户安装/账号由用户正常操作验收，当前未改。

## 验证 Verification

- [x] 按team-mode进行真实源码实现、独立复核、实际编译页面检查。
- [x] 新增失败反例先运行，并保留修复前失败证据；不以删除/跳过测试解决。
- [x] 指定源码git diff --check通过。
- [x] 实际UI截图已取得；本地fixture标识保留，不冒充真实厂商数据。
- [x] 账号/秘密仅为隔离测试的合成值，真实账号资料未读取或上传。
- [x] 未验证项明确列出。

已实际执行的验证：

- 核心node --test scripts/free-channel-contract-test.mjs：15/15，覆盖真实错误类型、非空/终止、总时限、缓存迁移、政策不轮换和路由边界。
- 原恢复node scripts/recovery-test.mjs：113/113；管理node scripts/standalone-management-test.mjs：17/17。
- 账号扩展node --test --test-concurrency=1 tests/*.test.mjs：126/126、0跳过；设置OFM_CORE_DIR与公开SDK0.2.0-rc.2，包含真实生成business/真实账号池/OFM桥9项联合场景。
- 独立Reviewer：免费13、缓存3、厂商实际TS/WASM10，共26项通过。最初响应头/EOF超时、嵌套错误和无version迁移四失败反例保留。
- Qoder真实WASM同载荷80次：旧源码32,833,536字节，修复版2,359,296字节；16至80次旧增长24,576,000，修复增长0；不涉及网络。
- node scripts/build-standalone-ui.mjs与--check、standalone TypeScript检查通过；最终生成网页node scripts/standalone-react-ui-test.mjs：13组、38截图，昼夜/320/390/200%无横向溢出。
- 插件真实React/Edge预览已42截图，无空白页/脚本错误/文档横向滚动；宿主主题包缺失时标为fixture。listed语义最终插件42截图和核心完整48/48套件已再确认通过；证据分开保存。

视觉样例见同目录channel-compatibility-2026-10-14/。完整本地命令、错误与独立证据位于D盘audit，不包含在安装包。

真实外网事实：2026-10-14 20:55一次正常Big Pickle匿名调用HTTP403/FreeTierError，未成功、未重试/切路径。官方标价免费不等于当前第三方调用资格。没有将通过本地测试写成恢复OpenCode免费渠道。

未验证：真实官方DSH双插件冷/热安装卸载、13家真实账号登录/续期/配额和生成、真实图片识别/长窗口、原生桌面窗口与真实安装。渠道来源不足或缺配置者仍待验。Kilo官方正常匿名使用核对和一次真实调用结果另写阶段报告，不把15项目录当15项生成通过。

## 配置与迁移 Configuration & Migration

不改变真实账号或自动迁移旧凭据。数据沿用各自目录；安装扩展不自动启用，原账号迁移先预览确认。探测缓存迁移只将旧绿色证据改为unknown，不删除负面状态、用户设置、密钥或会话。

开发验收包应使用本轮同时生成的核心tgz和账号扩展tgz；standalone/desktop用完整外置目录。校验清单由本轮源码重新构建，不沿用前批包或上游签名。新认证/独立9router路线尚未替用户选择。

## 回退方式 Rollback

先停用独立扩展，再恢复用户备份的上一组核心/扩展代码及保留的数据。不要同时启用旧整合核心与新账号扩展。卸载默认保留数据。缓存v2在旧程序仍可按相同results结构读取，unknown只需重新探测；没有不可逆数据迁移。

最终候选及联合验收：核心tgz72文件、扩展tgz35声明文件均与源码一致；真实Worker安装/启停/重启/卸载通过。桌面新资源字节和隔离真实后端health通过，未验原生窗口。最终Kilo正常1024预算返回OK/stop/cost0，另有实际OFM HTTP链路附验记录。上述本地阶段权威报告见implementation-p0/P0-DELIVERY.md，不把单一模型实测扩大为15个或13家全通过。
