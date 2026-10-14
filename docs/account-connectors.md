# OFM 账号连接扩展：本地安装与迁移

开发分支 refactor/separate-account-relays，基线226a9ec。核心与扩展源码分别维护，核心不附带产品账号实现。独立扩展仓库为look-back-lysj/dsh-ofm-account-connectors；本次未合并主线或发布正式市场版本。

## 现在的行为

未安装扩展：免费/Kilo、EAC、官方API聚合、核心网关/路由/节省Token和现有界面保持可用。原账号页改为指引页；旧账号RPC和账号专用网关退出核心。原用户账号文件留在原处，核心不再读取它们。

已安装：只读取清单并校验文件，等待用户启用。启用后各渠道仍默认关闭，用户打开扩展管理自行选择渠道并登录。相应模型由扩展提供，DSH宿主与OFM自己的API桥接分别处理，不重复注册供应商。

停用：撤回模型、拒绝旧账号模型请求、取消在途调用与后台任务。不会因为模型不存在而改发到免费渠道。卸载默认只移除扩展代码，保留扩展账号数据。

## 独立网页与桌面版

1. 在核心“账号连接扩展”页填写独立扩展发行目录的绝对路径，例如 <扩展仓库目录>/dist/account-connectors-0.1.0。
2. 确认信任本机开发包来源，然后点击“导入本机扩展”。安装保持停用；哈希验证仅代表完整性，不代表发布者授权。
3. 点击“启用扩展”，等待真实连接状态，再打开扩展管理。选择渠道后登录自己的账号。
4. 新模型通过原本地API地址提供，不需要另开第二个账号网关端口。

管理界面在 /api/management/extensions/account-connectors/ui/，沿用核心管理会话与同源鉴权；普通推理API Key与管理Cookie权限没有混用。只提供已安装清单中的资源。

本地开发包以完整目录交付，可从外置zip解压获得。本版尚未在网页实现直接上传并解压zip/tgz，也不会自动下载或安装扩展。

## 官方 DSH 插件版

核心开发包与独立扩展bundle分别安装。扩展名称 dsh-ofm-account-connectors，提供独立设置页“账号连接扩展”，无需OFM包即可使用DSH所需服务。OFM提供检测与打开管理的协作入口。

官方桌面DSH的desktop profile由Electron程序专门管理；CLI实测拒绝管理该profile，应通过官方桌面插件管理器选择本地bundle。不能把其他profile的CLI安装当成桌面安装成功。官方0.2.0-rc.2安装地址解析器已只读核对支持HTTP tgz；可将dev-install/README.md里的HTTPS地址粘进安装框。本轮不替换现有已安装profile。

新旧账号模块互斥。先使用本分支核心替换旧整合版，再安装独立扩展；若有原独立账号插件仍运行，先停止冲突实例。没有验证过的市场地址或一键安装深链接不会在界面中伪造。

## 数据与旧账号

核心不删除旧channel-pack目录或凭据文件。迁移在扩展里通过明确选取备份、预览和确认完成；不会自动扫描旧profile接管账号。原始数据保留，新导入账号/渠道保持停用。备份与账号操作归扩展管理，不通过核心公开模型合作接口暴露凭据。

DSH扩展使用宿主凭据库独立前缀；独立/桌面扩展使用自身数据目录。重新登录也是可用选择。含凭据备份必须私下保存，不能放到Git或公开发行包。

## 开发与验证

核心命令：node scripts/test-all.mjs --mode contributor；npm --prefix packages/standalone run typecheck；node scripts/core-extension-boundary-test.mjs。

扩展命令：在独立仓库运行npm run build、npm test、npm run check、npm run pack:external、npm run pack:dsh。

联合命令：设置OFM_ACCOUNT_CONNECTORS_PACKAGE为真实本地扩展发行目录，运行node scripts/account-connectors-package-integration-test.mjs。此检查使用隔离数据和禁止供应商网络的真实Worker，不能代替十三家真实认证/推理验收。

桌面命令：npm --prefix packages/desktop run build。资源暂存从核心网页清单取文件，拒绝夹带旧账号分包；安装程序只包含核心，外置扩展另外选择。

生产更新仍使用项目原签名发布流程。当前本地分支没有维护者发布私钥，不生成虚假签名；提交/发行要在获得相应指令后按仓库模板完成。
