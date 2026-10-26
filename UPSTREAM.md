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

## Update notifications

The [upstream-watch workflow](.github/workflows/upstream-watch.yml) checks the
upstream default branch and all published releases hourly, at minute 17 UTC,
and supports manual dispatch. GitHub may delay scheduled runs. The workflow
also runs when its implementation, initial snapshot or upstream.json changes.
It runs on GitHub independently of local development tools and uses only the
repository's automatic GITHUB_TOKEN, with contents:read and issues:write.

One bot-owned tracking issue, assigned to Alice-Marx, shows upstream changes and
the current extraction status. New commits, releases including prereleases,
release-note edits and changed installation assets produce a deduplicated
comment. No-change runs do not write comments or issue updates. To receive
GitHub inbox/email notifications, subscribe to the issue using GitHub's normal
notification settings. The issue and run logs remain visible in the repository.

The committed `.github/upstream-watch-baseline.json` initializes the first run.
Later checkpoints live in the tracking issue's machine-readable footer, not an
expiring Actions cache. Keep that footer intact. If it is damaged, the workflow
fails rather than silently resetting notification history. A failed comment
does not advance state; if updating the footer fails after a successful comment,
the next run detects the delivered event and avoids posting it again. Closing
the issue pauses neither checking nor notification: a new event reopens it.

Monitoring does not advance upstream.json, apply upstream code, or publish
packages. Review CLI/TUI/Web changes and rerun the extraction validations before
advancing the real source pin. Check the Actions page for failures. Public
repositories' inactive schedules can be disabled by GitHub; re-enable the
workflow there if that occurs.

## Maintained fixes after extraction

Version 3.16.3 fixes the Windows browser handoff in the CLI OAuth adapter.
The original unquoted `cmd start` call split authorization URLs at `&`, dropping
redirect/state query fields. A profile-free PowerShell launcher now preserves
the complete URL and reports launch failure/timeout. The existing provider,
callback, polling, credential and account ownership contracts are retained.
