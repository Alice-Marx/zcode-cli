# Standalone extraction contract

The standalone repository retains the upstream unified Node distribution contract at specs/zcode-unified-distribution.md. Root command `pnpm build:zcode` builds CLI/TUI, local server and Web, collects native/worker/runtime assets, and emits releases/<version>/zcode-<version>.tar.gz, sha256.txt, latest.json and install.sh under dist/zcode. A download root is mandatory via --base-url or ZCODE_DIST_BASE_URL in .env/.env.local/environment. Node.js remains required; mise.toml pins the development version.

`zcode` without arguments starts upstream TUI. A leading --web starts the local HTTP/WebSocket server; other arguments retain upstream Agent CLI dispatch. Source development uses `pnpm --filter @zcode/cli dev`; Web development uses `pnpm dev:web` without the distribution launcher.

Only command-line, TUI, Web, shared services and their source dependencies are included. Electron desktop, Android app, separate web-share application and desktop E2E applications are excluded. Retained optional CLI plugins and trajectory/evaluation tools remain available as upstream sources.

Extraction adds repository provenance, standalone root configuration, a platform-independent package-manager invocation for distribution builds and an npm-compatible bin entry inside the assembled runtime. It does not alter Agent/session semantics or migrate previous Lite installations.

The generated shell installer requires latest.json.sha256 and verifies the downloaded archive before installation. Generic static-host layouts remain releases/<version>/<tarball>. GitHub Release download roots use sibling latest.json and tarball assets, matching real Release hosting. Private GitHub downloads use authenticated gh release download followed by extraction; the shell installer does not add credential storage.

Validation: workspace closure, required files and no Electron dependency checks; launcher dispatch tests; source CLI build/help; standalone release build; extracted native TUI render and keyboard exit; local Web HTML/API/WebSocket/shutdown. Model requests are not sent during verification.
