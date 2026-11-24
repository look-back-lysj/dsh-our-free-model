# Magpie engine update and decoupled sync

Status: engine updated to upstream `6a900e0d048e592cbc9120dd2c3f515aab9ef04a`
(2026-10-31, the newest upstream HEAD observed at delivery; upstream commits
several times a day, so "latest" is a moving target — the point of this change
is that catching up is now one command). All contract suites pass against the
new binary, including the native Electron acceptance and the real legacy
upgraders.

## What changed

The engine stays what it was — an unmodified build of a pinned upstream
revision, wrapped by this repository's own code — but the distance from "a new
upstream commit exists" to "this build runs it, verified" is now one command:

```text
node scripts/update-magpie-engine.mjs          # npm run update:magpie
```

The updater resolves the target revision (`git ls-remote`, no token), moves the
single pin in `scripts/build-magpie-engine.mjs`, rebuilds the binary with the
existing builder, refreshes the packaged parts and bundles, then runs the six
suites that guard the wrapper/engine contract and the channel policy. A failed
build or suite moves the pin back, so the tree keeps its working engine
(exercised for real during this update: a wrong revision fails the fetch and
the pin comes back). The updater is the only new coupling between upstream and
this repository, and it is the fast path the pin was always meant to promise.

- Updated pin: `c551a229975653b7ae5b6a35e2278c983a272e06` (2026-10-23) →
  `6a900e0d048e592cbc9120dd2c3f515aab9ef04a` (2026-10-31). Upstream moved over
  1400 commits in those eight days; the API surface the wrapper and the policy
  speak to did not change in any way that touches this build (checked per
  route, below). New binary sha256
  `1f4b2f350fe09f42c0ac8a859c2ccb5f03dcd0c13d4e066cd689a1acda23e604`.
- `scripts/magpie-plugin-test.mjs` no longer hardcodes the pinned revision or
  stale preset counts: the revision comes from `vendor/magpie/engine.json`,
  the only place the runtime reads it anyway.
- `scripts/update-magpie-engine.mjs` (new) and the `update:magpie` npm script.

## Build flags now match upstream releases

The builder released binaries with DWARF and the symbol table still in
(`-ldflags "-X main.version=…"`). Upstream's own Makefile releases with
`LDFLAGS = -s -w -X main.version=…`, so the builder now does the same. The
stripped build is 64.8 MB instead of 85.8 MB and its gzip payload 27.2 MB
instead of 45.3 MB — which matters beyond tidiness: the legacy updater's
80-file manifest cap had room for nine 4 MiB parts of the old engine, and the
new engine's eleven parts put the package at 81 files, one over the cap real
1.3.1/2.5.9 installations in the field refuse. Stripped, the payload is seven
parts and the package is 77 files. Go's panic traces come from the runtime's
own metadata and survive `-s -w`; only debugger DWARF is given up, which no
surface here uses.

## Contract checks against the new revision

Checked in the upstream tree before building:

- Every management route the wrapper proxies and the policy filters still
  exists: `/api/providers`, `/api/upstream`, `/api/importapps`, `/api/plugins*`
  (listings, market, check, updates, search, npm, github, page, panels),
  `/api/login/usage`, `/api/usage/quotas`, `/api/plugin-signin*`,
  `/api/signin(/import)`, `/api/provider/(move|moveback|save)`,
  `/api/caller-keys*`. The plugin operations moved under a wildcard
  `POST /api/plugins/{op}` whose op names (`add`, `remove`, `update`,
  `upgrade`, `off`, `options`, `prefer`) are the same paths the policy's
  mutation refusals already match.
- The engine-side contract the wrapper owns still holds: `settings.json`
  honors `port`, `lan`, `noAccountDiscovery`, `noStats`, `noUsageStats`,
  `noAutoUpdate`, `noAutoDownload`, `autoRestart`; `caller-keys.json` keeps its
  id/name/secret shape; the gateway key prefix is still `sk-magpie-key-`.
- The Huawei Cloud preset (`huaweicloud`) and the WorkBuddy/CodeBuddy
  providers still exist upstream, so `src/magpie-policy.js` is not filtering
  an empty set. Upstream added two new vendor presets (`qwencloud`,
  `qwencloud-token-plan`, Alibaba's international Qwen platform); neither is a
  denied channel and both pass the policy filter — the plugin suite now
  expects 59 offered built-ins, 14 with regions, 64 regions in total.

## Recorded checks

The first six suites ran inside the updater's own verification pass
(`update-magpie-engine: done (6a900e0d048e -> 6a900e0d048e)` is printed only
after all of them exit zero; a failure moves the pin back):

```text
node scripts/update-magpie-engine.mjs 6a900e0d048e592cbc9120dd2c3f515aab9ef04a
  scripts/magpie-engine-test.mjs     # real compiled executable
  scripts/engine-transport-test.mjs  # real engine with host fetch replaced
  scripts/magpie-models-test.mjs
  scripts/magpie-policy-test.mjs     # 16 checks
  scripts/magpie-plugin-test.mjs     # 8/8 real-engine integration groups
  scripts/engine-payload-test.mjs    # 7/7
node scripts/legacy-upgrade-test.mjs      # 8/8, 77 files, real 1.3.1/2.5.9 upgraders
node scripts/updater-test.mjs             # pass
node scripts/engine-appearance-test.mjs   # real bundled UI, Playwright: pass
node scripts/magpie-sandbox-test.mjs      # real browser, opaque-origin isolation: pass
node scripts/magpie-native-ui-test.mjs    # real installed DSH, isolated profile
```

Binary and metadata: `vendor/magpie/engine.json` records the new revision,
`ofm-6a900e0d048e` build version, Go 1.27.1 toolchain, per-platform sha256 and
the gzip-split parts under `src/engine-parts/` (rebuilt by
`build-legacy-payload.mjs`). `NOTICE.md` was regenerated from the 47 Go
modules linked into this build.

`magpie-live-test.mjs --run` remains opt-in and untouched: it drives real
vendor accounts, and its live-upstream blocker predates this update.

## One narrow-width presentation fix in the wrapper

The new engine's "Long conversations · Compact at" settings row (#876) keeps
its 76px number input `flex:none`. Upstream gives that row shrink-and-wrap
treatment inside the agent prefs but not inside the settings lists, so at the
desktop narrow-panel width (320px) the input sticks past the clipped list and
loses half its width — the native suite's "no clipped controls" check caught
it. The fix is one rule in the wrapper's owned presentation layer
(`engineAppearanceCSS`, `src/magpie-engine.js`), the same shrink-and-wrap
answer upstream itself wrote for the agent-prefs context; the engine build
stays unmodified.

## Native- and legacy-test fixes found on the way

Four defects predate this update (the native suite last passed on 2026-10-24,
the legacy one likewise) and are fixed here, because these suites are the
gates `install-local-magpie.mjs` and the release flow refuse to run without:

- Both suites unpack a tarball with `tar` from the PATH; an MSYS GNU tar (the
  resolution inside Git Bash) reads `D:` as a remote host. They now use
  `%SystemRoot%\System32\tar.exe`, the bsdtar that reads a drive letter.
- The native suite asserted that the package ships
  `vendor/magpie/bin/magpie-win32-x64.exe`, which broke when the plugin
  switched to shipping the engine as checksummed compressed parts. It now
  asserts the payload parts are complete and that they restore to the exact
  sha256 the manifest records.
- The first-run disclaimer dialog (v2.6.0) covers the plugin surface until its
  accept button is pressed; the suite now waits for it and acknowledges it
  before clicking the workspace tab.
- The plugin suite's preset assertions (57 offered, 13 regional, 58 regions)
  were frozen to the 2026-10-23 upstream; they are now current (59/14/64) and
  the revision assertion reads `engine.json` so the next update needs no edit.

## Evidence

- Native report and screenshots: `.verify/magpie-native-ui/latest.json`
  (`passed: true`, 29 checks, no layout or asset failures).
- Updater transcripts: pin move, build sha256 line and the six suite results
  ending in `update-magpie-engine: done (… -> 6a900e0d048e)`; one failed run
  with a wrong revision demonstrates the pin rollback.
- Preset diff between revisions: `internal/provider/presets.go`, upstream
  `git diff c551a22 6a900e0d`.
