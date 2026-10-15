# OFM 兼容升级补充验收（2026-10-15）

这是上一批候选之后的继续工作。最新源码在两个原开发分支，未提交、推送、发布或合并。完整目标保持active；此处通过不能替代用户实际桌面profile和真实账号。

## 本批新增修复

- Buddy：工具结果连续回填，工具图片与相邻用户追问按原顺序组合；缺引用或空图片数据保留占位，普通无图对话保持。
- TRAE：认证续期后把限流和用量归属重新绑定到实际发送凭据；未知归属不误标旧账号，也不沿用旧账本ID。没有新增账号或换号路径。
- Raccoon：仅HTTP499且明确client has aborted request视为上游取消；无关499和5xx保持原失败。Raccoon/Loomy原续期使用新凭据的路径已有合成回归，未为改而改。
- Qoder：依据社区112报文的精确pricingUrl错误结构分类；只在Qoder上下文启用，不把裸112当通用额度码；有效HTTP(S) URL须通过标准URL解析。原110、认证、排队、重复请求和预算保持。
- CodeArts DSML：围栏、反引号、JSON/代码字面量保留正文而不转换为工具；有限空白/单双竖线标签正确解析；invoke只读自身属性，不能借子参数name；未知工具、缺名、坏参数保留原文。
- DSML缓冲：每提取器待定工具块超过1Mi字符时，整个回合后续两个通道的DSML都保留原文，不执行；未完成尾部与推理通道保留。已发原生/合法工具不回溯删除。
- 本地构造的思考开关档展示从关闭到开启；默认档和厂商原生effortOptions顺序保持。

## 验证证据

| 检查 | 实际结果 | 边界 |
| --- | --- | --- |
| 扩展完整源码/实际business/OFM桥回归 | 449/449，0失败、0跳过 | 正确提供核心路径与公开SDK0.2.0-rc.2，真实账号为合成 |
| 官方DSH 0.2.0-rc.2隔离CLI+真实LlmRuntime/credentials/commands | 当前这组新包17项通过 | 独立D盘profile，不是用户正在运行的桌面UI |
| 官方安装输入与源码 | 已安装manifest35文件与当前源一致 | 官方pnpm --offline --ignore-scripts；禁止自动装peer |
| 官方退出清理 | 真实服务、定时器、句柄、请求全撤回 | 网络保护阻止10次核心启动fetch，未送出原生请求；未抓包 |
| 当前实际tgz核对 | core72文件/ext35声明文件均与源码一致，Worker联装通过 | 安装默认off、enable、disable、reenable、卸载保留数据 |
| 核心HTTP+实际外置包UI/RPC | 通过，含昼夜/移动截图 | 当前包13渠道关闭、0账号/0模型 |
| 独立审查 | Buddy/TRAE5组通过；DSML/Qoder原失败两组定向关闭 | 初次FAIL和哈希留证，最后未重复所有旧组 |
| CodeArts完整运行包 | 3项通过 | 真实业务/账号池/凭据/作用域；仅HTTP与账户为合成，不执行工具 |
| 核心既有回归 | 48/48套件 | 本批未改核心生产文件；当前core包SHA与上一组相同 |

执行：node scripts/build.mjs；node scripts/check.mjs；node --test --test-concurrency=1 tests/*.test.mjs（OFM_CORE_DIR、OFM_CONNECTORS_SDK_ROOT）；node packaged-joint-check.mjs；node scripts/joint-ui.mjs <core-dir>；官方隔离upgrade-followup-inputs.cjs。实际日志与JSON见同目录。

官方第一次升级安装被审计自设的child_process禁止规则挡住，未执行插件。这是本地保护配置错误，已只对官方pnpm命令+--offline+--ignore-scripts+确切隔离cwd放行；正式boot仍使用原严守卫。旧冻结包17项报告保留HISTORICAL，最新输入/哈希/17项见official-dsh/latest-verified-proof.json。

DSML测试曾在已发终止帧后再送推理帧，导致断言失败；修正为单一正常结束的混合通道fixture，保留无工具调用/双通道原文断言。另修证据写入晚于临时目录清理的测试钩子；所有行为测试未删除。首次失败日志保留。

## 免费路径与服务器

上一阶段Kilo已通过正规匿名raw和实际OFM HTTP→Kilo SSE→解析→JSON的一次短回合，OK/stop；原raw费用0，OFM回包未提供费用不填0。本批没有继续真实模型请求，不把一次单模型证据扩大成15项或13家全部可用。OpenCode BigPickle正常客户端403/FreeTierError保持拒绝，未引入指纹增强或改变认证。

## 当前验收材料

最新包在candidate-packages；旧20261015-connectors-refresh-final候选没有本批补修，应改用本目录。core包2.1.0、扩展0.1.0仍为开发候选，以SHA256识别，不冒充维护者新正式发行。外置ZIP给独立/桌面核心导入完整extension.json目录。

真实DSH当前仍是旧整合核心；按用户此前选择自行安装，未替换该profile。先更新核心再装独立扩展，避免同名13提供商冲突，保留账号数据。旧公网dev-install链接没有更新，未公开上传。可用本机下载链接交给官方安装器，服务运行期间有效。

## 仍未完成

1. 用户实际桌面界面、插件安装包装/热装卸、模型选择器和真实会话取消/重启验收。官方CLI真实服务合同已经过，但不替代原生UI。
2. 13家对应获准账号及服务资格，逐家真实登录、续期、额度、工具/图片/模型生成。资料不足渠道保持待验，不能只凭模型卡或合成凭据宣称可用。
3. 高并发账本侧信道仍为原设计的近似，未完成全13提供商逐请求归属改造；本批仅修可证明的续期旧ID错误。
4. DSML做有限语法及工具必填检查，不等于完整JSON Schema或所有未来非规范格式；厂商真实大流量和CodeArts工具执行未验。
5. Qoder112的依据是社区现场结构，缺官方全码表；裸112仍原错误类别，不推断所有现网112等同额度。
6. A/B/C新认证或独立网关路线待用户选择。当前没有部署9router、收费账户或修改服务端权限。

以上是完整目标边界，不能把通过集缩成已全部完成。
