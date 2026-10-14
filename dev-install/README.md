# 开发验收安装文件

本目录的插件包可以直接粘贴HTTPS地址到官方DSH插件安装框。先替换旧整合版OFM核心，再安装独立账号扩展，按宿主提示重启。安装扩展后仍待启用，每个渠道初始关闭。

## OFM核心

https://raw.githubusercontent.com/look-back-lysj/dsh-our-free-model/refs/heads/refactor/separate-account-relays/dev-install/dsh-our-free-model-2.1.0.tgz

## 独立账号连接扩展

https://raw.githubusercontent.com/look-back-lysj/dsh-ofm-account-connectors/refs/heads/refactor/independent-account-connectors/dev-install/dsh-ofm-account-connectors-0.1.0.tgz

这两个包是开发验收制品，尚未进入主线或正式市场发行。核心仍标2.1.0，不能只凭版本号判断已替换；界面出现“账号连接扩展”指引才是本轮入口。

独立网页和桌面使用外置zip，解压后导入包含extension.json的完整目录。UI当前不直接上传解压zip/tgz。文件大小、SHA256与源码基线在checksums.json。

Windows核心安装程序单独放在GitHub草稿制品附件，需要拥有者登录查看。只构建和上传草稿，不等同于Windows安装/原生窗口已验收，也不代表正式发布。

完整交接与验证见../docs/ACCOUNT_CONNECTORS_HANDOFF.md及../docs/verification/2026-10-14-account-extensions.md。不要把账号数据、服务器秘密或本机配置提交到这些目录。
