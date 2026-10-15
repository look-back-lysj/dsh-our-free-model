# OFM 与账号连接扩展：协作合同 v1

本分支把原十三项产品账号接入迁出核心，扩展有独立源码、安装包、版本、账号管理与停用生命周期。核心缺少扩展时，EAC、匿名免费、Kilo、官方API聚合、核心网关、路由和节省Token继续使用原有路径。

## 身份与状态

- 扩展ID：ofm.account-connectors。
- 独立DSH包：dsh-ofm-account-connectors。
- DSH可选服务：ofmAccountConnectors。
- protocolVersion：1。
- 每次运行有独立instanceId；停止后的旧结果不能覆盖新实例。
- 安装和启用分开；每个渠道首次关闭，不自动接管旧账号。

## 最小合作方法

| 方法 | 作用 |
| --- | --- |
| describe() | 返回公开身份、版本、实例、能力和健康状态 |
| subscribe(listener) | 订阅状态与目录变化，返回取消订阅函数 |
| listModels() | 返回已启用且有登录账号的可调用模型 |
| stream(request, {signal}) | 返回宿主既有typedchunk流，并支持取消 |

hostModels与ofmApi分别声明。DSH供应商由扩展自己注册，核心不重复注册；OFM自己的API通过可选桥接调用。通道返回的是宿主text-delta、tool-call-delta、usage、finish等类型，不是未解析的OpenAI SSE字节。

模型合作接口不返回账号令牌、刷新令牌、Cookie、密码或备份。供应商账号管理使用扩展专属管理接口，不能混入公开模型API权限。

## 外置清单与运行

extension.json声明ID、版本、协议、Node范围、runtime.entry、ui.entry、ui.assets、providers及每个文件SHA256。所有路径相对安装根，拒绝路径逃逸与符号链接/联接。清单元信息校验不执行账号业务。哈希用于完整性检查，不代表发布者身份。

独立服务/桌面使用外置Worker，消息包括ready、models、complete、rpc、cancel、close及相应结果、typedchunk和错误。业务代码及专用WASM只在扩展中；核心仅有通用加载、桥接和生命周期实现。Worker不是操作系统安全沙箱。

## 数据、管理与退出

独立管理界面在/api/management/extensions/account-connectors/ui/，沿用管理Cookie与同源准入。通用backup.export拒绝；扩展的明确本机导出只返回路径和数量。迁移先预览再确认，旧账号资料原位保留，导入后账号与渠道关闭。

停用开始即拒绝新请求、取消在途调用、撤回模型、停止登录轮询与后台续期/签到，清理仅针对自己的instanceId。卸载默认保留账号数据。扩展缺席或停用时，旧账号模型返回EXTENSION_UNAVAILABLE，不自动转给匿名核心；实际同名模型冲突返回409。

DSH核心退出只解除合作订阅，不擅自卸载独立插件。新旧账号实现同时占用供应商时明确提示冲突，不把跳过注册视为成功。

## 构建与验收

核心的npm文件清单、独立源码包和桌面资源暂存均不得夹带旧pack、账号业务目录、WASM或账号前端分包。EAC独立前端仍归核心。共享消息转换保留普通工具调用、流式、取消和用量行为。

验收需覆盖：未安装、已安装未启用、已连接无账号、正常桥接、冲突、版本不兼容、故障、停用、卸载、重启与迟到结果；同时回归原核心功能。实际命令、截图和未验证项见docs/verification/2026-10-14-account-extensions.md。
