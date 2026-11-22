# Jet 渠道包升级评估

`vendor/channel-pack/` 吸收自 [Jet（iJetLi）](https://github.com/iJetLi/dsh-providers-hub) 的
MIT 渠道实现。本文记录 2026-11-22 那次升级尝试的实测结论，以及下次继续时的正确路线。

**结论先说：那次没有升级，`vendor/channel-pack/` 保持原样。** 目标提交与当前树不是同一
产品谱系的新旧版本，而是两个已经分叉的插件；整包替换会造成安全方向的行为回归，并且会
删掉 OFM 自己的功能。下文每一条都来自实测，不是推断。

## 坐标

| 项 | 值 |
| --- | --- |
| 上游 | `github.com/iJetLi/dsh-providers-hub`（MIT） |
| 上游最新（评估时） | `098de90415479c543bbcaa3fcd96ad07a0f80124`（2026-11-21，`dsh-providers-hub` v0.2.1-rc.4） |
| 本仓库当前吸收 | `345f0a07b22713c0ae189ca7d8b97ec4f64626c6`（2026-10-06） |
| 记录位置 | `vendor/channel-pack/NOTICE.md` 与 `catalog/provenance.json` 的 `vendoredChannelPack.upstreamRevision` |

两处必须同时更新，否则来源记录自相矛盾。

## 规模差异

| | 本仓库 | 基线 `345f0a0` | 上游 `098de90` |
| --- | --- | --- | --- |
| `src/*.ts`（含子目录） | 148 | 157 | 328 |
| `src/*.ts`（仅顶层） | 134 | — | 313 |
| `src/index.ts` 行数 | 1,682 | 1,957 | **7,257** |
| 渠道 adapter 文件 | **10** | — | **26** |
| `apply` 签名 | `apply(ctx, config)` | `apply(ctx)` | `apply(ctx)` |

`src/index.ts` 从 1,957 行涨到 7,257 行，因为上游把 30+ 个 provider 的注册全塞进了这一个
文件。这不是"修复累积"，是产品扩张。

## 为什么不能整包替换

### 1. 上游删掉了 OFM 依赖的功能

| OFM 文件 / 符号 | 上游状态 | 影响 |
| --- | --- | --- |
| `opencode-messages.ts` 的 `FREE_LANE_GATE_TOOLS` / `GATE_TOOL_DEFINITIONS` | **不存在**（上游该文件 191 行，本仓库 374 行） | 免费车道的工具闸门定义，删了免费车道就废 |
| `queue-rotation.ts` | **不存在**（对应位置是 `rate-limit-resume.ts`，语义不同） | 排队轮换行为 |
| `rate-limit.ts`、`open-browser.ts`、`credential-expiry.ts`、`credit-expiry-window.ts` | 不存在 | 各自的 OFM 适配 |

`disableOpencode` 与 `outlet` 也是 OFM 自加的，**上游从来没有**（基线 `345f0a0` 的
`apply` 就没有第二参数，`grep disableOpencode` 在基线里也是 0 命中）。整包替换后这两个
钩子要重新植入，不是"恢复上游原有"。

### 2. 实测出的行为回归（候选包已能挂载的前提下）

候选包（1,580,457 字节 = 1.51 MiB，`minify:true`）通过了 `channel-pack-test` 10/10，
但随后：

| 测试 | 期望 | 候选包实际 | 性质 |
| --- | --- | --- | --- |
| `channel-network-test`「网络证书问题不能废弃账号 refresh_token」 | `ChannelNetworkError` | `RefreshTokenExpiredError` | **安全方向错误**：TLS/网络失败被当成 refresh_token 终态，会废弃健康账号 |
| `lobsterai http: rotates before output` | `['a','a','a','b']` | `['a','b']` | OFM 的"3 次排队宽限再换号"被移除 |
| qoder 并发 | 并发请求绑定实际账号 | `LlmError: qoder: code=105 expired` | 状态机语义不同 |
| `serializeMessages` | 丢弃纯空白回合 | 保留空 assistant/user 消息 | 消息清洗语义不同 |

第一条最严重：它不是"少了个功能"，而是**把可以恢复的错误当成了不可恢复的**。

### 3. 存储命名空间会让老用户账号"消失"

| | 本仓库 | 上游 |
| --- | --- | --- |
| 命名空间 | `channel-pack` | `jet-hub` |
| 状态文件 | `<home>/channel-pack/state.json` | `<home>/jet-hub/state.json` |
| 环境变量 | `DSH_CHANNEL_PACK_STATE_DIR` | `DSH_JET_HUB_STATE_DIR` |

直接采用上游命名，已登录的账号在界面上会全部消失。必须保留本仓库命名空间，或写一次性迁移。

### 4. 体积上限要靠改构建脚本解决

| 构建方式 | 产物大小 | 是否合规（≤4 MiB） |
| --- | --- | --- |
| 上游源码，不 minify | 4,707,185 字节 = **4.49 MiB** | **超限** |
| 上游源码，`minify:true, keepNames:true` | 2,005,874 字节 = **1.91 MiB** | 合规 |
| 候选包（含 OFM 适配，`minify`） | 1,580,457 字节 = **1.51 MiB** | 合规 |
| 当前 `pack.js` | 2.51 MiB | 合规 |

体积**不是**阻塞点——minify 后比现在的包还小。但 `scripts/build-channel-pack.mjs` 目前
不启用 `minify`，要产出合规包必须改它（它在 `vendor/channel-pack/` 之外），或者用另外的
构建脚本（那就破坏了"用仓库脚本可复现"的前提）。这是个需要先决定的事。

## 正确的继续路线

**不要整包替换。** 以上游为基线、按 provider 逐文件 cherry-pick 修复，每 pick 一项就补
上对应的 OFM 回归。理由：

- 上游对 10 个渠道的改动是 30 文件 / 5,416 行，其中大量是重命名（`jet-hub-store` →
  `channel-pack-store` 这类反向操作），不是 bug 修复；逐项判断比整包吞下便宜。
- OFM 的 10 渠道契约（恰好 10 个 adapter、未知 provider 必须 `provider-unsupported`、
  UI 10 张卡）与上游 30+ provider 的注册模型正面冲突，整包替换后要改的是上游
  `index.ts` 的注册块本身，不是 replay 几个函数参数。这条契约是 `channel-pack-test`
  的断言，不是描述：`assert.equal(adapters.has(entry.provider), false, 'unsupported
  provider is never registered')` 以及其后对每个 RPC 方法断言
  `result.error.code === 'provider-unsupported'`。
- 每 pick 一项都能跑 `channel-pack-test` / `channel-network-test` 验证，整包替换只有
  全绿或全红两种结果。

### 落地前必须定的三件事

1. **构建脚本是否启用 minify**（决定能否用仓库脚本复现合规包）
2. **存储命名空间保留还是迁移**（决定老用户账号是否安全）
3. **`wreq-js` 与 `jose` 怎么处理**——`jose` 只被 `src/oauth.ts` 用（DPoP，4 个新渠道
   需要）；`wreq-js` 只被 `src/opencode-bun-tls.ts` 用，是平台相关的可选依赖，加载走
   变量说明符且失败只记一次。内联、外置、还是让该特性降级，三种都可行，但要明确选一个。

### 验证清单（每次 pick 后都要跑）

```bash
node scripts/channel-pack-test.mjs              # 10 渠道契约
node scripts/channel-pack-test.mjs --source --channels-only
node scripts/channel-network-test.mjs           # 含上面那条安全方向断言
node scripts/channel-login-test.mjs
node scripts/channel-pack-gate-test.mjs         # 打包 marker 门
node scripts/legacy-upgrade-test.mjs            # 80 文件 / 4 MiB 上限
```

## 现场残留

那次尝试的产物都留在 `D:/tmp/jet-update/work/`（临时目录，可随时删）：

| 路径 | 内容 |
| --- | --- |
| `backup-live-20261122-131456.tar.gz` | 当时的 live 树备份（2.0 MB，解压验证过：134 个 `.ts` + `pack.js` 2,627,512 字节） |
| `src/` | 候选树（336 个 `.ts`，上游 313 + OFM overlay） |
| `pack.js` | 候选包（1,580,457 字节，通过 10/10 pack 测试） |
| `*.log` | 各轮构建与测试日志 |

另有一份更早的备份 `/d/tmp/rollback/channel-pack-src-before-update.tar.gz`。

## 取上游的方法

本机到 `github.com:443` 不稳定，`git clone` 会失败；`gh api` 通：

```bash
gh api repos/iJetLi/dsh-providers-hub/tarball/<sha> > /d/tmp/up.tar.gz
mkdir -p /d/tmp/up && tar -xzf /d/tmp/up.tar.gz -C /d/tmp/up --strip-components=1
```

## 不该说的话

- 不要说"上游删了 `disableOpencode`"——**那是 OFM 自己加的**，上游从来没有。
- 不要说"更新一下就行"：这是跨 6 周、约 4.9 万行的分叉合并，不是 vendor bump。
- 不要在没备份的情况下覆盖 `vendor/channel-pack/`：`src/opencode-messages.ts` 有一处
  staged 的注释改动（关于 `Commands run on ${OS} using ${shell}.` 模板，sst/opencode
  v2.2.3 的措辞）会直接丢。
- 不要声称"上游修复已吸收"，除非逐渠道跑过上面那份验证清单。
