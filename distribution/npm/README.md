# ZCode CLI

TUI, local Web and Agent in one Node.js command, without Electron. This is a
community-maintained extraction of [zai-org/ZCode](https://github.com/zai-org/ZCode).
Source and provenance: [Alice-Marx/zcode-cli](https://github.com/Alice-Marx/zcode-cli).

Requires Node.js **24.14.0 or later**. Development and CI use Node 24.14.0.

```sh
npm install --global @ljwei-stak/zcode-cli
zcode
zcode --web
zcode --help
```

With no arguments, `zcode` opens the terminal UI. A leading `--web` starts the
local Web server and Agent. Other arguments retain the upstream Agent CLI
behavior; `--version` reports the unified distribution version.

```sh
zcode --web --workspace . --port 3030 --no-open
```

Open http://127.0.0.1:3030. The port must be available; use `--port 0` to select one
automatically. Model providers use your own configuration and credentials.

The npm tarball includes the complete verified runtime archive and its extraction
library. Installation does not fetch another runtime from GitHub. Postinstall
prepares the assets; if install scripts are disabled, the first command prepares
them in your writable OS cache. Allow around 500 MB of installed space, plus npm
cache and temporary extraction space. Startup reuses the prepared runtime.

[Source CLI development and usage guides](https://github.com/Alice-Marx/zcode-cli#源码开发)
cover model setup, noninteractive calls, tools, extensions, evaluations and traces.
[Validation coverage](https://github.com/Alice-Marx/zcode-cli/blob/main/VALIDATION.md)
records the actual tested platforms. Bundled native assets alone are not proof of
platform execution. The upstream Computer Use placeholder and local Web task
aggregation limitations remain applicable.

Apache-2.0 applies to the extracted ZCode sources. Original copyright, NOTICE and
third-party license notices are preserved. This is not an official Z.AI release.
