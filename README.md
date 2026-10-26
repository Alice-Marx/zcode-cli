# ZCode 命令行版

从 [zai-org/ZCode](https://github.com/zai-org/ZCode) 抽取的独立 Node.js 发行项目，包含 **TUI、Web 和 Agent**，无需 Electron。来源提交、抽取范围和许可证见 [UPSTREAM.md](UPSTREAM.md)。这是社区维护的抽取版本。

统一使用 `zcode`：

```sh
zcode                 # 无参数：TUI
zcode --web           # 首参数 --web：本机 Web
zcode --help          # 现有 Agent CLI 帮助及 Web 入口提示
zcode app-server --stdio
```

只有第一个参数为 `--web` 时才选择 Web。其他调用进入现有 Agent CLI；`--version` 显示发行版版本。TUI 和 Web 后端均在本机运行，模型服务按用户自己的 provider 配置访问。

## 安装与运行

运行需要 Node.js 24.14.0 或更新的 Node 24，开发版本固定在 [mise.toml](mise.toml)。推荐安装公开的 [npm 包 `@ljwei-stak/zcode-cli`](https://www.npmjs.com/package/@ljwei-stak/zcode-cli)：

```sh
npm install --global @ljwei-stak/zcode-cli
zcode
zcode --web
```

npm 包包含完整 TUI、Web 和 Agent 运行资源，安装时不另行从 GitHub 下载。若安装脚本被禁用，首次启动会在用户可写缓存中准备资源；冷解包可能需要一段时间，后续启动复用已有资源。安装约需 500 MB，另预留 npm 缓存及临时解包空间。Linux x64、Windows x64 和 macOS arm64 的实际 npm 安装及原生 TUI/Web 验证已通过。

### 手动下载

仓库和 Release 均已公开，可直接下载[运行包](https://github.com/Alice-Marx/zcode-cli/releases/download/v3.16.2/zcode-3.16.2.tar.gz)及 [SHA256 校验文件](https://github.com/Alice-Marx/zcode-cli/releases/download/v3.16.2/sha256.txt)，也可以使用 GitHub CLI：

```sh
gh release download v3.16.2 --repo Alice-Marx/zcode-cli \
  --pattern 'zcode-3.16.2.tar.gz' --pattern sha256.txt
```

Linux/macOS 可用 `sha256sum -c sha256.txt`，macOS 也可用 `shasum -a 256 -c sha256.txt`；PowerShell 用 `Get-FileHash ./zcode-3.16.2.tar.gz -Algorithm SHA256` 对照 `sha256.txt`。

解压后直接运行：

```sh
tar -xzf zcode-3.16.2.tar.gz
node zcode/bin/zcode.mjs
node zcode/bin/zcode.mjs --web --workspace . --port 3030 --no-open
```

浏览器访问 <http://127.0.0.1:3030>。该端口需要空闲；`--port 0` 自动选端口并在终端显示地址。Web 默认只监听本机；配置非回环地址时保留上游 token 保护规则。

若要把命令加入 PATH，在解压目录的父目录运行 `npm install --global ./zcode`，之后即可使用 `zcode` 和 `zcode --web`。Windows 同样适用；保留安装源目录，或使用你自己的固定安装位置。

## 源码开发

安装 Node 和 pnpm（版本见 `mise.toml`），然后：

```sh
pnpm install --frozen-lockfile

# 首次检出先构建 workspace 依赖；Agent 的源码入口会使用这些 dist 入口
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help

# 直接开发 Agent / TUI
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# 开发 Web：本机后端 + Vite
pnpm dev:web
```

源码入口直接运行 Agent CLI，不经过发行包的 `--web` 分流。验证统一的 `zcode` 命令，请运行解压后的 `bin/zcode.mjs`。

模型配置、非交互调用、工具与扩展见 [CLI 使用指南](apps/zcode-cli/docs/usage/README.md)；批量评测和轨迹记录见 [自动化指南](apps/zcode-cli/docs/usage/13-automation.md) 与 [prompt-trajectory](apps/zcode-cli/tools/prompt-trajectory/README.md)。

## 构建发行包

`pnpm build:zcode` 依次构建 CLI/TUI、后端和 Web，收集 TUI 原生库、worker 和运行时依赖，再组装发行包。全新源码会先生成共享包产物；构建默认使用生产环境配置。

下载根地址必须通过 `ZCODE_DIST_BASE_URL`（`.env`、`.env.local` 或环境变量）或 `--base-url` 设置。以下使用本仓库公开的 GitHub Release 资源地址，下载方式见上文：

```sh
pnpm build:zcode --base-url https://github.com/Alice-Marx/zcode-cli/releases/latest/download

# 已设置 ZCODE_DIST_BASE_URL
pnpm build:zcode

# 复用已有 Agent、后端和 Web 产物，仅重新组包
pnpm build:zcode --skip-build

pnpm build:zcode --help
```

默认版本取根 `package.json`，输出为 `dist/zcode/`：

```text
releases/<version>/zcode-<version>.tar.gz
releases/<version>/sha256.txt
latest.json
install.sh
```

普通静态托管保留完整目录，并把 `--base-url` 设置为它的真实根地址。GitHub Release 托管则将 tarball、`sha256.txt`、`latest.json`、`install.sh` 放在同一个 Release。安装脚本识别这两种布局，并校验版本索引中的 SHA256。

对于可直接访问的下载根地址，`sh install.sh` 默认安装到 `~/.zcode/runtime`，在 `~/.local/bin` 创建 `zcode`。目录分别可用 `ZCODE_DIST_HOME`、`ZCODE_DIST_BIN_DIR` 修改。旧 Lite 用户改用新命令、环境变量和安装脚本；不会自动删除旧 Lite 目录或迁移、删除既有会话。

本地调试发行包：

```sh
mkdir -p dist/zcode/debug
tar -xzf dist/zcode/releases/3.16.2/zcode-3.16.2.tar.gz -C dist/zcode/debug
node dist/zcode/debug/zcode/bin/zcode.mjs
node dist/zcode/debug/zcode/bin/zcode.mjs --web --workspace . --port 3030 --no-open
```

## 上游更新通知

[上游通知 Issue](https://github.com/Alice-Marx/zcode-cli/issues)由 [GitHub Actions](https://github.com/Alice-Marx/zcode-cli/actions/workflows/upstream-watch.yml) 每小时维护一次，也可在 Actions 页面手动运行。官方 `zai-org/ZCode` 的默认分支、新 Release（含预发布）、发行说明或安装资源有变化时，机器人会在固定 Issue 下追加评论，附上游链接和源码差异，提醒核对并更新本项目。Issue 分配给维护者，也可以点击 Subscribe 订阅后续评论。

没有变化时不重复通知；监控运行在 GitHub，不需要本机或 Codex 开机。它只记录通知，不自动合并、安装或发布。真实抽取来源仍以 [upstream.json](upstream.json) 为准；机制与状态恢复见 [UPSTREAM.md](UPSTREAM.md#update-notifications)。

## 验证与边界

```sh
pnpm typecheck
pnpm lint
pnpm test:distribution
pnpm smoke:distribution dist/zcode/releases/3.16.2/zcode-3.16.2.tar.gz
```

发行包 smoke 在仓库外、隔离的数据目录中验证原生 TUI 导入、实际渲染、键盘退出，以及 Web HTML、server-info、workspace、WebSocket 和退出，不发送模型请求。实际结果见 [VALIDATION.md](VALIDATION.md)。

保留上游的能力边界：Computer Use 包在此开源提交中为不可用占位；本机 Web 的全局任务列表和多 source 聚合仍受 Desktop Window Host Controller 缺失限制。Linux、macOS、Windows 的原生功能应分别实测，不能仅凭打包包含原生库推断兼容性。

许可证：[Apache-2.0](LICENSE)，保留 [NOTICE.md](NOTICE.md) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
