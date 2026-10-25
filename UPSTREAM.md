# Upstream provenance

This repository is an independent extraction of the command-line distribution
from [zai-org/ZCode](https://github.com/zai-org/ZCode), maintained by Alice-Marx.
It is not an official Z.AI release.

- Source commit: [`3c5b227649371507ddc4eb46ac5133afe6db1cab`](https://github.com/zai-org/ZCode/commit/3c5b227649371507ddc4eb46ac5133afe6db1cab).
- Extraction date: 2026-10-25.
- Upstream license: Apache-2.0. Original copyright, `LICENSE`, `NOTICE.md` and
  third-party notices are retained. Dependency licenses remain applicable.
- Machine-readable package scope: [`upstream.json`](upstream.json).

Retained sources include the existing Agent, TUI, local HTTP/WebSocket server,
Web client, shared services, CLI plugins, evaluation and trajectory tools. Their
relative source paths are preserved so workspace imports and build helpers keep
working. Electron desktop, Android, the separate Web sharing application and
desktop-specific applications are excluded.

Extraction changes are limited to standalone root configuration and documentation,
build portability, clean-checkout shared outputs, runtime package metadata and
license sidecars, distribution installation and verification. Agent behavior,
provider configuration format and session ownership remain upstream code.

The `upstream` Git remote is local clone configuration and is not carried by a
GitHub clone. Recreate it with:

```sh
git remote add upstream https://github.com/zai-org/ZCode.git
git fetch upstream
```

The repository homepage links to upstream. This public standalone repository
is not part of GitHub's native fork network. To update it, compare the
pinned source commit to upstream, re-evaluate the workspace and asset closure,
apply the relevant changes, and repeat the isolated distribution smoke tests.
