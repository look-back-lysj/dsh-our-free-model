# OpenCode官方直接依据与OFM桥接兼容规格

核对日期：2026-11-22。依据用户要求，直接研究官方仓库，为独立重写oc2api来源实现代码提供规格。**本次只研究、补文档，不修改运行源码或保留资产，不执行下载的官方程序，不发推理／账号请求。**

## 固定来源

- GitHub API确认旧入口 `sst/opencode` 当前指向 [`anomalyco/opencode`](https://github.com/anomalyco/opencode)。
- 固定本项目当前客户端版本tag **v2.2.3**，提交 [`082ac6281fd395c2d0c17fd3c38214db2f89621f`](https://github.com/anomalyco/opencode/tree/082ac6281fd395c2d0c17fd3c38214db2f89621f)。没有升级客户端版本或采用开发分支默认行为。
- 官方Git tree未截断；111个相关源码／元数据文件已逐一核对Git blob SHA，并记录SHA256。研究副本只在仓库外 `.verify/opencode-official-20261122/`，不进入发布内容。
- 三个子智能体分别研究身份、工具／历史、传输；主会话独立复读关键源码。元数据见[固定版本来源清单](../工程控制/ORIGIN-REWRITE-01/contracts/opencode-official-20261122.json)。
- 当前保护边界见[SCOPE.md](../工程控制/ORIGIN-REWRITE-01/SCOPE.md)：Magpie排除，Qoder WASM保留，OpenCode系统提示／13工具定义／四条引导原文及调用保持。

## 1. 会话ID：官方生成与本地稳定映射分开

官方创建会话优先接受调用者提供的ID，否则调用SessionID生成器；默认生成 `ses_` 加descending identifier。生成器使用当前毫秒、同毫秒递增计数器、低6字节时间编码和14个随机字符。不是UUID，也没有当前OFM的进程盐SHA256、UTC午夜回溯或阶段年龄重铸。依据：[SessionID](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/schema/src/session-id.ts#L5-L10)、[identifier](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/schema/src/identifier.ts#L16-L31)、[会话创建](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/session.ts#L288-L289)。

官方客户端SessionID Schema仅检查字符串以`ses`开始；它没有OFM的完整格式／日期窗口判断。客户端Schema宽松**不证明远端服务接受任意相同前缀字符串**。官方计数器也没有1—63上限，而当前`src/o2a/identity.js:5`的时间正则只识别其中一个子集，不能把它当作官方生成器全部输出域。

OFM当前另有跨客户端职责：把conversation seed和purpose映射到上游会话，读取并原样复用`session-map.json`，处理空seed、旧版本、损坏文件、保存失败和重启。`src/upstream.js:135-200`的存储、60天条件和`identity.js:15-39`的哈希／UTC派生属于**现有桥接兼容政策**，不能因官方生成器不同就直接删掉。

**独立实现规则：**把“官方格式规则”和“OFM旧映射兼容”分成两个层。旧映射保持原ID，不因升级、重试或错误响应更换身份；新生成策略的改变需要单独迁移规格。第一阶段若要求逐行为兼容，现有派生政策也应先明确保留，不能边改变策略边声称行为完全相同。

## 2. 当前会话ID与缓存亲和性是两项数据

官方affinity优先取parent，其次fork来源，最后当前session自身。`x-opencode-session-id`使用当前会话ID；三个affinity相关头使用affinity；有parent时还单独传两个parent头。project来自会话既有projectID，UA由channel／version／应用名组成。依据：[affinity](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/session/affinity.ts#L6-L8)、[请求头与cache key](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/session/model-request.ts#L289-L306)、[UA](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/app.ts#L16-L25)。

当前`src/o2a/headers.js`将普通session直接用作affinity、稳定派生project并显式生成trace头，是本项目的桥接选择；它没有完整表示官方parent／fork关系。官方上述装配段未显式生成trace头，但不能据此断言底层transport从不注入追踪。

**独立实现规则：**内部数据结构分别容纳session、parent、fork、affinity和project；不能用一个变量混代全部意义。现有无parent的调用保持当前行为，有新语义的支持必须明确测试，不擅改线上请求头。

## 3. 工具命名：官方命名空间不等于摘要别名

官方MCP注册清洗服务／工具名并采用服务命名空间；最终对外名在tool runtime层形成。另一个带`mcp_`摘要的官方值用于OAuth集成标识，不是相同的工具命名机制。依据：[MCP注册](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/tool/mcp.ts#L19-L55)、[有效工具名](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/tool/runtime.ts#L287-L292)、[OAuth标识用途](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/mcp/index.ts#L203-L215)。

当前`src/o2a/tool-renames.js`的摘要工具名、冲突尾缀、旧`clint_`恢复及大小写／折叠匹配，是**跨客户端桥接策略**，不能标为官方协议。摘要名脱离原映射不能反推出原工具名；精确映射恢复与缺映射兜底的保证必须区分。

**独立实现规则：**明确维护原名→wire名、wire名→原名的双向表，声明、tool choice、历史call及result统一使用该表；严格检测歧义和碰撞。不能只剥前缀就声称任意旧摘要名都可逆，也不能把真实MCP工具误认成本项目已分配的摘要名。

## 4. 13个保留定义是当前桥接profile，不是官方固定全集

官方工具快照根据权限过滤；Code Mode可用时有些工具通过`execute`暴露，否则进入直接工具集；直接工具排序后还可能附加`execute`定义。todo也有启用条件。因此“官方v2.2.3永远只有这13个工具，且没有execute”与所核对源码不符。依据：[动态工具快照](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/tool.ts#L265-L315)、[todo启用条件](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/tool/plugin/todo.ts#L52-L60)。

**本项目处置不变：**用户指定的13个工具定义、系统提示和四条引导继续原样使用，记作“现有免费车道桥接兼容profile”。不因官方动态默认集合不同就增删工具、启用Code Mode或改写资产。需要修正的是事实说明与实现分层，不是这些保留输入。

## 5. 历史工具调用应有状态和明确配对

官方历史状态模型区分streaming、running、completed、error；call和result保留调用ID及工具名。完成结果区分单文本和多内容块，错误保留错误信息；provider执行的工具与客户端执行的工具采用不同配对位置，原生元数据的重放还受provider／model及中断状态约束。依据：[状态模型](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/schema/src/session-message.ts#L135-L183)、[输入与结果](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/session/runner/to-llm-message.ts#L113-L151)、[配对及元数据](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/session/runner/to-llm-message.ts#L155-L219)。

官方这段历史投影入口没有“当前工具目录”参数；当前`src/o2a/toolshape.js:85-168`按当前工具集合清理历史call/result和悬空choice，是单独的桥接兼容政策，不应称为官方历史投影规则。依据：[官方入口](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/session/runner/to-llm-message.ts#L317-L322)。

**独立实现规则：**先建立包含调用ID／工具原名／执行方／状态／结果块的内部结构，再分别投影Chat、Responses、Messages。名称恢复、历史清理、元数据重放是不同阶段；不得因为当前工具不可用而误删无关文本、其他调用结果或改变顺序。原有清理政策是否改变需另立行为变更，不能混入等价替换。

## 6. 请求装配：官方核心与协议编码分层

官方先从模型／provider目录合并package、compatibility、settings、headers和body，再加载模型对应package构造route；核心不是按三个固定模型集合硬编码所有协议。SystemOne入口中的`decision`接口也不能推导为所有聊天模型的默认端点。依据：[模型目录合并及非chat隔离](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/model.ts#L207-L241)、[route解析](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/model-resolver.ts#L243-L257)、[package与settings](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/model-resolver.ts#L272-L286)、[decision范围](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/ai/src/providers/opencode.ts#L27-L38)。

当前`src/upstream.js`的三协议模型表／具体路径是现有桥接路由政策。本次不取实时目录、不改端点，也不宣称该表覆盖此刻全部官方模型。

补充可直接引用的官方行为：

- 匿名`public`来自无key／connection、免费模型未禁用的条件分支，不是所有provider认证方式的通则：[provider分支](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/plugin/provider/opencode.ts#L299-L325)。
- 官方output limit结合目录与上下文预算；32,000是无目录上限时的fallback。当前“Chat未给limit就补固定值”是桥接简化：[预算计算](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/session/model-request.ts#L48-L98)。
- Chat协议编码在默认streamUsage开启时请求usage，token字段受compatibility／provider／baseURL选择：[Chat lowering](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/ai/src/protocols/openai-chat.ts#L884-L914)。
- 官方最终步骤可保留工具定义并指定`none`；当前桥接删除`none`不是官方通则：[最终步骤](https://github.com/anomalyco/opencode/blob/082ac6281fd395c2d0c17fd3c38214db2f89621f/packages/core/src/session/runner/llm.ts#L249-L269)。

现有版本值、端点、beta、trace、限额默认及choice政策不在此次研究中更改。静态客户端源码也不能证明服务端逐字校验、配额窗口或拒绝规则；不以这次研究替代真实可用性验收。

## 7. 后续独立重写的实施规格

分为三个边界清楚的部分：

1. **官方行为规格**：会话格式、affinity、工具状态和配对、模型route及协议投影，以固定提交直接证据为依据，自行设计实现，不把官方源码搬进来冒称自研。
2. **OFM兼容层**：旧session-map、purpose/global、摘要工具别名、旧前缀、历史清理、三协议路由与默认值，逐项冻结当前行为；不能因官方没有就删掉。
3. **保护输入**：Qoder WASM、OpenCode指定文本和调用保持；外围重写不以改写它们为前提。

对应回归至少包含：旧映射／重启／重试／日界线与年龄边界；root/child/fork身份；名称碰撞和歧义；缺映射兜底；三协议多工具call/result闭环；错误／中断／provider切换；显式limit与choice；保留资产精确内容；运行bundle与源代码一致。现有测试是起点，不能用两份本地代码互相比对替代独立预期。

本次交付是官方依据与规格澄清，**没有开始进一步源码重写、改变线上调用或宣称全部功能验收完成**。
