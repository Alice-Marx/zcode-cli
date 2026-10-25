# Standalone ZCode instructions

This repository extracts the TUI, Agent and local Web distribution from
https://github.com/zai-org/ZCode. Read UPSTREAM.md and specs/standalone-extraction.md.
Preserve upstream runtime behavior and the original source layout. The desktop
Electron application is excluded. Read nested AGENTS.md before editing packages.

Update the relevant spec before behavior changes. Use
.agents/skills/architecture-governance/SKILL.md for runtime code changes.
Before delivery run pnpm typecheck, pnpm lint and the affected tests. Launcher
tests: pnpm test:distribution. Build: pnpm build:zcode --base-url <actual root>.
Use source CLI development via pnpm --filter @zcode/cli dev; only the assembled
bin/zcode.mjs dispatches a leading --web. Keep model credentials out of source.
Never send model requests during smoke verification.
