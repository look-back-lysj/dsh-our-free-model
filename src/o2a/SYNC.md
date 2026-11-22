# 请求适配模块维护说明

当前分支正将历史 opencode2api 移植实现替换为 OFM 实现，尚未完成发布验收。

- `assets/ofm-agent-context.txt` 与 `assets/ofm-tool-contracts.json` **不是手写的**：
  两者由 `scripts/build-o2a-assets.mjs` 从上游 `sst/opencode` 的钉住 tag 生成
  （MIT；tag 与 `version.js` 的 `V2_CLIENT_VERSION` 一致）。出处、逐文件 sha 与
  再生成步骤见 `docs/opencode-assets.md`。
- 免费层逐字比对系统提示与 13 个工具定义（description **与** 参数 schema）。
  改写任何一处都是 429 `FreeUsageLimitError`，看起来像配额墙 —— 2026-10-31 到
  11-21 之间正是这样断掉的（见 `docs/free-lane-wire.md` 末节）。**不要手改这两个
  资产**，改 `scripts/build-o2a-assets.mjs` 或重新取上游。
- `scripts/o2a-assets-test.mjs` 守住资产形状；`legacy-payload --check` 守住
  `src/o2a.js` 产物是否陈旧。
- 对外会话格式、工具别名与现有配置继续兼容。
- `src/upstream.js` 使用生成的 `src/o2a.js`；修改源文件后必须重建并检查产物，源模块测试不能代替运行包测试。
- 维护不再按上游源码逐文件同步。新增行为依据协议文档、功能规格与真实响应验证。

已接触历史源码，不能宣称未接触源码的 clean-room 重写；来源历史不抹除，许可证结论须单独审查。
