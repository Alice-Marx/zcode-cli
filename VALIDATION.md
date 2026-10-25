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
