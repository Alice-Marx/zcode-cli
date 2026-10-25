#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { npmChildEnvironment, npmInvocation } from "./npm-command.mjs";

const root = resolve(import.meta.dirname, "..");
const template = join(root, "distribution/npm");
const metadata = JSON.parse(await readFile(join(template, "package.json"), "utf8"));
const pinned = metadata.zcodeRuntime;
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: npm run build:npm -- [--archive <runtime.tar.gz>] [--download] [--out-dir <directory>]");
  process.exit(0);
}
let archive = join(root, `dist/zcode/releases/${pinned.version}/zcode-${pinned.version}.tar.gz`);
let output = join(root, "dist/npm", metadata.version);
let download = false;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--") continue;
  if (arg === "--download") download = true;
  else if (arg === "--archive" || arg === "--out-dir") {
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--archive") archive = resolve(value);
    else output = resolve(value);
  } else throw new Error(`Unknown argument: ${arg}`);
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function npm(args, cwd, capture = false) {
  const invocation = npmInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env: npmChildEnvironment(),
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: capture ? "utf8" : undefined,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed (${result.status})`);
  return result.stdout;
}

if (!(await stat(archive).catch(() => undefined))?.isFile()) {
  if (!download) throw new Error("Runtime archive missing. Build the distribution or pass --download.");
  await mkdir(dirname(archive), { recursive: true });
  const response = await fetch(pinned.url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error(`Runtime download failed (${response.status})`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: "wx" }));
}
assert.match(pinned.sha256, /^[a-f0-9]{64}$/);
assert.equal(await digest(archive), pinned.sha256, "Pinned runtime SHA256 mismatch");
await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(output, ".stage-"));
for (const name of ["bin", "lib", "scripts", "package.json", "package-lock.json", "README.md"]) {
  await cp(join(template, name), join(staging, name), { recursive: true });
}
for (const name of ["LICENSE", "NOTICE.md", "THIRD-PARTY-NOTICES.md", "UPSTREAM.md"]) {
  await cp(join(root, name), join(staging, name));
}
await mkdir(join(staging, "payload"));
await cp(archive, join(staging, "payload/zcode-runtime.tar.gz"));
await writeFile(join(staging, "payload.json"), JSON.stringify({
  schemaVersion: 1,
  version: pinned.version,
  file: "payload/zcode-runtime.tar.gz",
  sha256: pinned.sha256,
  upstream: "https://github.com/zai-org/ZCode",
  source: metadata.repository.url,
}, null, 2) + "\n");
await chmod(join(staging, "bin/zcode.mjs"), 0o755);
npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], staging);
const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", output], staging, true))[0];
assert.equal(packed.name, metadata.name);
assert.equal(packed.version, metadata.version);
const files = new Set(packed.files.map((entry) => entry.path));
for (const file of ["bin/zcode.mjs", "lib/runtime.mjs", "scripts/postinstall.mjs", "payload.json", "payload/zcode-runtime.tar.gz", "LICENSE", "NOTICE.md", "THIRD-PARTY-NOTICES.md", "UPSTREAM.md", "node_modules/tar/package.json"]) {
  assert.ok(files.has(file), `Missing npm artifact file: ${file}`);
}
assert.ok(![...files].some((file) => /^(?:runtime|test|\.env|\.npmrc)(?:\/|$)/.test(file)), "Unexpected file in npm artifact");
const info = { ...packed, tarball: join(output, packed.filename), runtimeSHA256: pinned.sha256, staging };
await writeFile(join(output, "package-info.json"), JSON.stringify(info, null, 2) + "\n");
console.log(JSON.stringify({ name: packed.name, version: packed.version, tarball: info.tarball, size: packed.size, unpackedSize: packed.unpackedSize, files: packed.entryCount, integrity: packed.integrity, runtimeSHA256: pinned.sha256 }));
