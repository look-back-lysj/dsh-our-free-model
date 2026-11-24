# OpenCode official assets — provenance

The free lane must reproduce the official OpenCode client's request body byte for
byte: the system prompt and the 13 tool definitions (description **and** parameter
schema). The free tier fingerprints both, and a body that differs is answered with
`429 FreeUsageLimitError` rather than a shape error — which is why a rewritten
description surfaces as "the quota is exhausted" and sends people looking in the
wrong place.

## Source

| | |
| --- | --- |
| Repository | `sst/opencode` (MIT) |
| Tag | `v2.2.3` |
| Client version this lane reports | `2.2.3` (`V2_CLIENT_VERSION` in `src/o2a/version.js`) |
| Generated | `node scripts/fetch-opencode-assets.mjs && node scripts/build-o2a-assets.mjs` |

The tag is pinned rather than following `dev` on purpose: the fingerprint is a
property of one released client, and tracking a moving branch would make the
asset change without a corresponding decision.

## Files read

| Path | Blob SHA |
| --- | --- |
| `packages/core/src/session/runner/prompt/system.txt` | `0e02ced78d7aa90f23b5dbb2c7146dfa0d0bb409` |
| `packages/core/src/tool/plugin/edit.ts` | `5165e7a5547b94c638d847da9d16f5066bb481b1` |
| `packages/core/src/tool/plugin/glob.ts` | `40bcc7f91c51e9e2e52abdbfa9a3495531af01e1` |
| `packages/core/src/tool/plugin/grep.ts` | `0062e33b82899e849cdffeb275358c21f79bb0ad` |
| `packages/core/src/tool/plugin/patch.ts` | `554e7a9d3eb161011d11641a201677a4e93952e4` |
| `packages/core/src/tool/plugin/question.ts` | `1cc20da4b0f272a2afd2c85e68ce8acbed69786d` |
| `packages/core/src/tool/plugin/read.ts` | `4c541ccda3f8cc0549d1c457a2d3899added4c50` |
| `packages/core/src/tool/plugin/shell.ts` | `c876ed2af334e5c9d314681fe0446dc768efae35` |
| `packages/core/src/tool/plugin/skill.ts` | `25000de02d2571ca19b7891df1b04ec6f768e047` |
| `packages/core/src/tool/plugin/subagent.ts` | `b3cc81f651506c24df89285dcd534fd773c57afc` |
| `packages/core/src/tool/plugin/todo.ts` | `b28509f7205e6bf679252c853e35bc9140fdddce` |
| `packages/core/src/tool/plugin/webfetch.ts` | `3c9cf10926c490fdae7ff162f661dea461a786d9` |
| `packages/core/src/tool/plugin/websearch.ts` | `feb6393edf43075ee72c65e1bf79f8517bf33bd1` |
| `packages/core/src/tool/plugin/write.ts` | `147941ab9ffbb818665612683d397a7a22399916` |

## What the builder does

`scripts/build-o2a-assets.mjs` evaluates the Effect `Schema` expressions those
files declare and writes two assets:

- `src/o2a/assets/ofm-tool-contracts.json` — name → `{ description, parameters }`
  for all 13 tools, in declaration order.
- `src/o2a/assets/ofm-agent-context.txt` — the system prompt verbatim, keeping the
  `${OPENCODE_TOOL_GUIDANCE}` placeholder the client fills with its per-tool
  instructions.

The evaluator understands only the expression shapes these schemas use and throws
on anything else. A schema change upstream therefore fails the build instead of
silently producing a body the upstream rejects.

## Runtime rendering

Two values in the assets are templates, rendered per request:

- `${OPENCODE_TOOL_GUIDANCE}` in the system prompt — replaced by the guidance
  lines for `shell`, `write` and `edit` when the body declares those tools
  (`packages/core/src/session/system-prompt.ts`).
- `${OS}` and `${shell}` in the `shell` tool description — `OS` maps
  `win32`→`Windows`, `darwin`→`macOS`, `linux`→`Linux`; `shell` is the
  name of the compat-priority shell (`packages/core/src/shell/select.ts`), which
  is `powershell`-family on Windows and `bash`/`zsh` elsewhere.
