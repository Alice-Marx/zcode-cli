# 3.16.3 Windows login URL handoff

The original Windows opener was reproduced against a real local browser/HTTP
probe: only `appId` arrived, with `redirect` and `state` absent. The published
BigModel frontend emits the reported redirect-failure message when it cannot
build the callback URL. The maintained fix changes only Windows URL handoff;
the CLI polling callback and account persistence contracts stay in place.

Regression tests cover literal URL encoding, ampersands, percent escapes,
Unicode and apostrophes; failed/timeout launchers; unchanged Linux/macOS
argument vectors; and the actual Windows PowerShell parser with a side-effect
stub in place of browser launch. This does not claim a real account consent or
completed BigModel login. No user token or model request is used.

Root typecheck and lint pass (lint: 0 errors). Full CLI lint was run and reports
13 inherited max-lines failures in byte-identical HEAD files outside this fix;
no lint exemption or architecture baseline was added. The relevant adapter,
bootstrap and CLI login tests, current runtime/npm payload digests and platform
CI references are recorded in the 3.16.3 release notes and dated export.

The reports below describe the historical 3.16.2 extraction and npm release;
their digests and platform evidence must not be attributed to 3.16.3.

# Validation status (2026-10-25)

Upstream: zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab.
Local platform: Windows x64; Node.js 24.20.0; pnpm 10.33.2. Development/CI pin: Node.js 24.14.0.

| Check | Result |
| --- | --- |
| Workspace manifest closure | 44 retained packages, no missing workspace dependency, no Electron dependency |
| Frozen lockfile (offline) | Passed |
| Root typecheck | Passed, including after extraction metadata adjustment |
| Root lint | Passed: 0 errors, 62 inherited warnings |
| Distribution tests after actual build | 10 passed, 6 explicitly skipped Windows-inapplicable POSIX checks |
| Source CLI dev help | Passed; directly starts upstream Agent CLI entry; build dependencies first on a fresh clone |
| Windows npm command installation | Passed in isolated prefix: installed zcode.cmd reports 3.16.2 and Web help |
| Built Agent CLI help | Passed |
| pnpm build:zcode | Passed: CLI/TUI, HTTP/remote server, Web, native/worker assets and tarball |
| Runtime archive metadata/assets/SHA256 | Passed; final runtime SHA256 70e2ca3ab681605aa4b9503d1f8455f28ae3a6dc79488a1e988837b8992d78a6 |
| Isolated native TUI and Web smoke | Passed on Windows x64: actual TUI/Web exit codes both 0; native render, keyboard exit, HTML/API/WebSocket, processes and port closure; worker/temp cleanup passed |
| Architecture changed scope | Passed, 0 violations |
| Full architecture | One inherited issue: gen-ui-service lacks contract.test.ts in the pinned upstream tree; no baseline exemption added |

The final [CI run 40176508658](https://github.com/Alice-Marx/zcode-cli/actions/runs/40176508658) passed on Linux x64 and Windows x64 for application/test commit `873a5f402e8cf186b548fde1722db30634d4c9e7`, using Node 24.14.0. Both platforms passed typecheck, lint, the complete CLI/TUI/server/Web build, real archive verification and isolated native TUI/Web smoke. Linux ran 15 regression tests successfully with one Windows-only skip; Windows ran 10 successfully with six POSIX-specific skips. Both TUI and Web exited with code 0. The workflow provides a 6 GB Node heap for the full typecheck.

The shell installer supports static-host and GitHub Release asset layouts, and checks SHA256 before modifying an installation. Its POSIX behavior tests are explicitly skipped locally on Windows; the workflow exercises them on Linux. Local shell syntax/ordering checks passed using Git Bash.

No model prompts were sent. Native runtime compatibility must be assessed by actual platform execution, not by the presence of cross-platform native assets. Source Computer Use and local Web task-aggregation limitations remain upstream behavior, as documented in README.md.

Failure-path smoke validation also passed on Windows: terminating only the dedicated verification worker produced overall exit 1, while its recorded child process and temporary directory were removed by the outer coordinator. The final success run returned exit 0 and verified all recorded process trees before deleting its directory. The old pre-fix one-file test directory remains outside the repository because its separate deletion was denied by automatic approval.

## npm package verification (2026-10-26)

Published package: https://www.npmjs.com/package/@ljwei-stak/zcode-cli , version 3.16.2. The npm runtime archive is the pinned GitHub runtime above; its installer restores permissions and prepares immutable assets atomically, with a user-cache fallback if scripts are disabled. npm includes the pinned extraction library and its dependencies, so installation does not fetch an additional runtime from GitHub.

Final npm CI: https://github.com/Alice-Marx/zcode-cli/actions/runs/40219513989 , source/test commit `3c90e7d79c059936c0aef6780716204e473f1232`. All three jobs succeeded:

| Platform | Installer tests | Cold fallback extraction |
| --- | --- | --- |
| Linux x64 | 19 passed, 0 failed | 10.094 seconds |
| macOS arm64 | 19 passed, 0 failed | 10.618 seconds |
| Windows x64 | 18 passed, 1 POSIX-only skip, 0 failed | 99.562 seconds |

Each platform installed the actual npm tgz into an isolated prefix containing spaces, verified generated zcode commands, rendered native TUI and local Web with exit codes 0, checked HTML/API/workspace/WebSocket and process cleanup, and verified --ignore-scripts first-launch user cache and reuse. Windows initially exceeded a 60-second test timeout; the bounded cold-preparation budget now matches the 180-second npm install budget, with actual elapsed-time evidence. The candidate package bytes did not change for this test correction.

npm candidate/published integrity: sha512-HBnQcDNdBIyyDxNvHTqnu9OyTrft5ayYs9u63tTz70+dg8NAsh1xRiVXU9XbHNBPtjLG49L/Kdig/75yGClOcg== . Anonymous Registry metadata returned HTTP 200 and the exact integrity. The downloaded registry tarball matches the reviewed candidate's SHA256 `29e263c584e82580742b1ca3b19fb923254a764f814e8ff987b63fb4c55753f2` byte hash. Publication was accepted asynchronously; the package was only considered available once actual version 3.16.2 and the latest tag were observable, rather than the temporary 0.0.0-stage placeholder.

# Validation status (2026-10-30) — upstream sync to a60ba6a7

Upstream: zai-org/ZCode@a60ba6a7e5a06742270ca605f5d2cc2766afa7e1 (previous pin `3c5b227649371507ddc4eb46ac5133afe6db1cab`).
Local platform: Windows x64; Node.js 24.20.0; pnpm 10.33.2. Development/CI pin: Node.js 24.14.0.

In scope: 1 071 changed files updated from upstream, 472 new in-scope files added,
1 720 upstream-deleted in-scope files removed, and two new workspace packages
(`@zcode/zcode-site-plugin`, `@zcode/provider-regression`). The desktop, Android,
web-share, dev-docs, e2e-report and docs trees stay excluded; no extraction-pruned
file was resurrected and no fork adaptation was overwritten.

| Check | Result |
| --- | --- |
| Root typecheck | Passed (exit 0, 6 GB heap) |
| Root lint | Passed: 0 errors, 51 warnings |
| Architecture check | Passed: 0 violations, after re-applying the extraction module exclusions |
| Distribution tests | 17 tests: 10 passed, 1 failed, 6 skipped |
| Maintained Windows OAuth fix | Passed: 9/9 in `apps/zcode-cli/packages/adapters/tests/auth-browser.test.ts` |

The single distribution failure is `scripts/standalone.test.mjs:96`, which shells out
to `tar -xOf <Windows drive path>`. This machine's MSYS GNU tar 1.35 rejects `F:`/`C:`
as a remote host spec (`Cannot connect to F: resolve failed`). The failure reproduces
in a bare temporary directory outside the repository and the test file is unchanged by
this sync, so it is environmental, not a regression. The two Windows guards that the
fork adds upstream of this file are intact and skip as documented: the SIGTERM runner
shutdown test and the POSIX shell installer test.

`architecture-policy.yaml`, `vitest.config.ts` and `scripts/zcode-distribution.test.mjs`
carry fork-specific extraction adaptations (excluded-module removals, dropped desktop
aliases, Windows process guards). These were re-applied on top of upstream's new content
rather than overwritten, which is what restored the architecture check to 0 violations.

`package.json` keeps the fork identity and minimal script set; upstream's dependency
changes were merged in (`jsdom`, `yaml` added; `@vitest/coverage-v8` moved to
`apps/zcode-cli`; the two new `patches/` entries for `@aiden0z/pptx-renderer` and
`@extend-ai/react-xlsx`, both already depended on by retained packages). The lockfile
was regenerated with `pnpm install`, recording the new workspace packages and patches.

No model prompts were sent during validation.

