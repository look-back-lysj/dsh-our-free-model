# 上游 2.3.0 分离版：开发验收安装文件

请使用下面两个配套分支中的文件。先替换旧整合核心，再装独立账号扩展，按官方宿主提示重启；各渠道首次仍关闭，需要主动启用和正常登录。

## OFM 核心

https://raw.githubusercontent.com/look-back-lysj/dsh-our-free-model/refs/heads/sync/separated-upstream-20261015/dev-install/dsh-our-free-model-2.3.0.tgz

## 独立账号插件

https://raw.githubusercontent.com/look-back-lysj/dsh-ofm-account-connectors/refs/heads/sync/account-connectors-20261015/dev-install/dsh-ofm-account-connectors-0.1.0.tgz

## 独立网页/桌面使用的账号扩展 ZIP

https://raw.githubusercontent.com/look-back-lysj/dsh-ofm-account-connectors/refs/heads/sync/account-connectors-20261015/dev-install/account-connectors-0.1.0-dev.zip

解压 ZIP 后导入包含 extension.json 的完整目录；ZIP 不作为 DSH tgz 安装。

扩展仍为0.1.0，内容已更新，必须按 [checksums.json](checksums.json) 区分旧同版本候选。文件在这两个开发分支上可用，不代表 npm 或正式市场发行。

核心代码回归52/52、独立扩展449/449零跳过、官方DSH0.2.0-rc.2隔离17项、实际双包与桌面包后端验证通过。详情和截图见 [分支说明](../docs/BRANCH_STATUS.md)。

未完成：全部真实厂商账号、用户正式profile、原生Tauri窗口和安装向导、正式发行签名。上游整合包会被升级保护拒绝覆盖分离结构。

Windows 2.3.0 x64安装器已本地构建并解包验收，没有随本次Git源码分支发布；完整可构建源码位于 packages/desktop 和 PACKAGING.md。
