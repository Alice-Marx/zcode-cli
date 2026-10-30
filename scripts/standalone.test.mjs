import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { resolvePnpmInvocation } from "./build-zcode.mjs";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "zcode standalone-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("distribution build reuses the active pnpm through Node without changing arguments", async (t) => {
  const directory = await temporaryDirectory(t);
  const manager = join(directory, "pnpm.cjs");
  await writeFile(manager, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  const args = ["--filter", "@zcode/cli...", "build", "path with spaces", 'literal"quote', "a&b"];
  const invocation = resolvePnpmInvocation(args, {
    env: { npm_execpath: manager },
    platform: "win32",
  });
  const result = await exec(invocation.command, invocation.args, invocation.options);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("direct Windows builds resolve a pnpm command shim with space-containing arguments", {
  skip: process.platform !== "win32",
}, async (t) => {
  const directory = await temporaryDirectory(t);
  const probe = join(directory, "arguments.cjs");
  await writeFile(probe, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  await writeFile(join(directory, "pnpm.cmd"), `@"${process.execPath}" "${probe}" %*\r\n`);
  const args = ["--filter", "@zcode/cli...", "build", "path with spaces"];
  const invocation = resolvePnpmInvocation(args, { env: {}, platform: "win32" });
  const result = await exec(invocation.command, invocation.args, {
    ...invocation.options,
    env: { ...process.env, PATH: `${directory};${process.env.PATH ?? ""}` },
  });
  assert.deepEqual(JSON.parse(result.stdout), args);
});

async function buildFixture(t) {
  const directory = await temporaryDirectory(t);
  const files = [
    "scripts/build-zcode.mjs",
    "scripts/load-endpoint-env.mjs",
    "scripts/spawn-command.mjs",
    "scripts/zcode-distribution/assets.mjs",
    "scripts/zcode-distribution/installer.mjs",
    ...["sea-tui-assets", "sea-targets", "sea-runtime-package-resolution", "sea-workspace-package-assets"]
      .map((name) => `apps/zcode-cli/packages/cli/scripts/${name}.mjs`),
  ];
  for (const file of files) {
    const destination = join(directory, file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(repositoryRoot, file), destination);
  }
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module", version: "1.2.3" }));
  return directory;
}

test("skip-build rejects incomplete build outputs without publishing a release manifest", async (t) => {
  const directory = await buildFixture(t);
  const args = [join(directory, "scripts/build-zcode.mjs"), "--skip-build", "--base-url", "https://example.com/zcode/"];
  const output = join(directory, "dist/zcode/latest.json");
  await assert.rejects(exec(process.execPath, args), /Missing web dist/);
  await mkdir(join(directory, "packages/web/dist"), { recursive: true });
  await mkdir(join(directory, "packages/server/dist"), { recursive: true });
  await assert.rejects(exec(process.execPath, args), /Missing server HTTP entry/);
  await writeFile(join(directory, "packages/server/dist/entry-http.js"), "");
  await assert.rejects(exec(process.execPath, args), /Missing agent app-server bundle/);
  await mkdir(join(directory, "apps/zcode-cli/packages/cli/dist"), { recursive: true });
  await writeFile(join(directory, "apps/zcode-cli/packages/cli/dist/zcode.cjs"), "");
  await assert.rejects(exec(process.execPath, args), /Missing Agent provider config/);
  await assert.rejects(stat(output), { code: "ENOENT" });
});

test("distribution help works without a download root; packaging requires one", async (t) => {
  const directory = await buildFixture(t);
  const script = join(directory, "scripts/build-zcode.mjs");
  const env = { ...process.env };
  delete env.ZCODE_DIST_BASE_URL;
  assert.match((await exec(process.execPath, [script, "--help"], { env })).stdout, /--skip-build/);
  await assert.rejects(exec(process.execPath, [script, "--skip-build"], { env }), /Configure ZCODE_DIST_BASE_URL/);
});

test("built release includes installable bin metadata, provenance, and independent runtime assets", async (t) => {
  const distribution = join(repositoryRoot, "dist/zcode");
  const latest = await readFile(join(distribution, "latest.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  if (!latest) {
    t.skip("Run pnpm build:zcode --base-url <download-root> to validate the real release archive");
    return;
  }
  const archive = resolve(distribution, "releases", latest.version, latest.tarball);
  // Windows 下 MSYS/Git-Bash 的 tar 会把 `F:\...` 这类绝对路径当作远端主机名
  // （"Cannot connect to F: resolve failed"）。改为 cwd + 纯文件名后，
  // Linux/macOS/Windows 都能读取同一份归档，无需依赖 PATH 里的 tar 实现。
  const archiveDirectory = dirname(archive);
  const archiveName = basename(archive);
  const manifest = JSON.parse((await exec("tar", ["-xOf", archiveName, "zcode/package.json"], { cwd: archiveDirectory })).stdout);
  assert.equal(manifest.version, latest.version);
  assert.deepEqual(manifest.bin, { zcode: "./bin/zcode.mjs" });
  assert.deepEqual(manifest.engines, { node: ">=24.14.0" });
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.homepage, "https://github.com/zai-org/ZCode");
  const entries = new Set((await exec("tar", ["-tf", archiveName], { cwd: archiveDirectory, maxBuffer: 16 * 1024 * 1024 })).stdout.trim().split(/\r?\n/));
  for (const file of [
    "bin/zcode.mjs", "agent/zcode.cjs", "agent/provider/zcode-builtin.json",
    "agent/node_modules/@zcode/tui/dist/index.js", "agent/node_modules/koffi/package.json",
    "agent/node_modules/playwright-core/package.json", "server/entry-http.js", "web/index.html",
    "node_modules/hono/package.json", "node_modules/node-pty/package.json",
    "LICENSE", "NOTICE.md", "THIRD-PARTY-NOTICES.md", "UPSTREAM.md", "README.md",
  ]) assert.ok(entries.has(`zcode/${file}`), `Missing release asset: ${file}`);
  assert.equal([...entries].some((entry) => /\/node_modules\/electron\//.test(entry)), false);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  assert.equal(hash.digest("hex"), latest.sha256);
  assert.equal(
    (await readFile(join(dirname(archive), "sha256.txt"), "utf8")).trim(),
    `${latest.sha256}  ${latest.tarball}`,
  );
});
