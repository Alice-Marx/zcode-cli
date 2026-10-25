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
| Source CLI dev help | Passed; directly starts upstream Agent CLI entry |
| Built Agent CLI help | Passed |
| pnpm build:zcode | Passed: CLI/TUI, HTTP/remote server, Web, native/worker assets and tarball |
| Runtime archive metadata/assets/SHA256 | Passed |
| Isolated native TUI and Web smoke | Passed on Windows x64: actual TUI/Web exit codes both 0; native render, keyboard exit, HTML/API/WebSocket, processes and port closure; worker/temp cleanup passed |
| Architecture changed scope | Passed, 0 violations |
| Full architecture | One inherited issue: gen-ui-service lacks contract.test.ts in the pinned upstream tree; no baseline exemption added |

The initial GitHub Actions run hit the Node 24.14 default 2 GB heap limit in typecheck on both runners. The workflow now provides a 6 GB heap; its next run will verify the final extraction. These failures are not recorded as passed checks.

The shell installer supports static-host and GitHub Release asset layouts, and checks SHA256 before modifying an installation. Its POSIX behavior tests are explicitly skipped locally on Windows; the workflow exercises them on Linux. Local shell syntax/ordering checks passed using Git Bash.

No model prompts were sent. Native runtime compatibility must be assessed by actual platform execution, not by the presence of cross-platform native assets. Source Computer Use and local Web task-aggregation limitations remain upstream behavior, as documented in README.md.
