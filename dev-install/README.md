# 2026-10-16 双插件分离开发候选

请先读 [协作者交接说明](../docs/COLLABORATOR_HANDOFF_2026-10-16.md)，其中包含完成程度、三种用法、迁移规则、复验命令和发布待办。

当前使用下列文件，均为开发候选，未正式签名或线上发布。指纹和大小见 [checksums.json](checksums.json)。

- [dsh-our-free-model-2.3.1-split.1.tgz](dsh-our-free-model-2.3.1-split.1.tgz)

  DSH 插件管理可用的 HTTPS 文件直链：

  https://raw.githubusercontent.com/look-back-lysj/dsh-our-free-model/refs/heads/sync/separated-upstream-20261015/dev-install/dsh-our-free-model-2.3.1-split.1.tgz

DSH 使用 tgz；外置 ZIP 需要解压后通过兼容宿主导入包含 extension.json 的目录。核心包已携带配套账号载荷，配套安装成功无需重复手动安装账号 tgz。

本次记录：核心 53/53 套件；账号 453/453、0 跳过；热更新专项 14/14、0 跳过；官方宿主隔离验收 14 项。真实厂商账号调用尚未验收。

目录中保留的 dsh-our-free-model-2.3.0.tgz、account-connectors-0.1.0-dev.zip 是历史候选，不用于本次验收。账号插件仍为 0.1.0，必须按本次哈希区分同版本历史内容。
