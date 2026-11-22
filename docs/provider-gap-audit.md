# Provider and account-channel comparison

Last reviewed: 2026-11-21

This comparison uses public feature descriptions, not source-code reuse. Provider account integrations can involve private app endpoints, OAuth applications, client identity fields, and service-specific usage rules; a provider plugin's implementation is not evidence that its endpoint is a supported public API.

## Current coverage

This project has ten account channels: LobsterAI (Youdao), Qoder, Qoder CN, TRAE, Cline, Loomy, Raccoon, MiniMax Code, ZCode, and Gemini Code Assist. The separate aggregate provider lane covers user-supplied API credentials for a broader set of documented and compatible endpoints. An API-key provider and an account-plan channel are distinct integrations even when they serve the same model vendor.

## Additional account-channel candidates in the comparison matrix

The public Agent2Providers matrix also names WorkBuddy (domestic and international), CatPaw, AutoClaw (domestic and international), Qianwen Work (domestic), Accio (domestic and international), CodeArts, KukuAI, MonkeyCode (domestic and international), Command Code, Antigravity, OfficeAce, OrcaTerm, ModelScope account plans, AtomCode, Doubao Work, Kiro, AStudio, and a ZCode international variant. Its notes describe Qianwen Work international as hidden/blocked. Edition-level parity for Cline and Qoder also needs direct verification.

These are account-product candidates only. The comparison repository's support matrix does not establish a third-party API, OAuth grant, or redistribution permission for their account endpoints. We therefore do not implement those sign-in flows from the comparison code. They can be added when the relevant vendor documents an integration contract or supplies an approved partner interface.

## Newly covered public API

The aggregate registry now includes ModelScope API Inference, a developer API distinct from ModelScope account-plan sign-in. It uses the Access Token issued by the user's own ModelScope account and the documented OpenAI-compatible API-Inference base URL. The official guide requires an Alibaba Cloud account binding and real-name verification, cautions that model availability changes, and limits its native Responses API to Qwen3.5 models. Registry model IDs are examples from the guide; users should confirm current IDs on each model's API-Inference page.

## Youdao / LobsterAI handling

The current LobsterAI channel already recognizes upstream risk-control responses and stops account rotation for that request. Account-level handling is kept distinct from model quota: a blocked account should not be presented as a temporary model reset. HTTP 429 handling honors a valid `Retry-After` value when present and uses bounded cooldown behavior otherwise. A provider rejection is reported to the user; account/IP rotation, client fingerprint changes, or retry storms are not used to evade provider controls.

The public Agent2Providers documentation describes model requests, token refresh, catalog, balance, and check-in support, but does not publish a LobsterAI OAuth grant or a numerical rate-limit policy. No third-party anti-ban guarantee can be inferred from that feature list.

## Clean-room and license boundary

The Agent2API gateway and its provider-plugin repository publish AGPL-3.0 licenses. This project keeps its existing license and its separately attributed vendored components. New functionality here is implemented from public capability descriptions and vendor API documentation; do not copy source, distinctive implementation structure, documentation prose, or assets from those repositories. A future change that intentionally incorporates AGPL-covered material would need a separate licensing review before distribution.

References:

- [Agent2API](https://github.com/aimod-cc/Agent2API)
- [Agent2Providers support matrix](https://github.com/ProvidersPlugin/Agent2Providers/blob/main/README.zh-CN.md)
- [Agent2Providers capability notes](https://github.com/ProvidersPlugin/Agent2Providers/blob/main/ui/provider-docs.json)
- [ModelScope API Inference guide](https://www.modelscope.cn/docs/model-service/API-Inference/intro)
- [ModelScope API Inference limits](https://www.modelscope.cn/docs/model-service/API-Inference/limits)
