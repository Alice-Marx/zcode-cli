import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { installScriptSource } from "./zcode-distribution/installer.mjs";

const exec = promisify(execFile);
const isWindows = process.platform === "win32";
const gitBash = "C:/Program Files/Git/bin/bash.exe";
const posixOnly = isWindows ? "Installation behavior requires a native POSIX shell and symlink semantics; Windows only runs script syntax/structure checks." : false;

async function temporaryDirectory(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-installer-layout-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("generated installer is valid shell and checks the checksum before changing an installation", {
  skip: isWindows && !existsSync(gitBash) ? "Git Bash is unavailable for shell syntax checking" : false,
}, async (t) => {
  const directory = await temporaryDirectory(t);
  const installer = join(directory, "install.sh");
  const source = installScriptSource("https://downloads.example.test/zcode/");
  await writeFile(installer, source);
  await exec(isWindows ? gitBash : "sh", ["-n", installer.replaceAll("\\", "/")]);
  assert.match(source, /https:\/\/github\.com\/\*\/releases\/latest\/download/);
  assert.match(source, /https:\/\/github\.com\/\*\/releases\/download\/\*/);
  assert.ok(source.indexOf("ZCode archive SHA256 mismatch") < source.indexOf('mkdir -p "$INSTALL_DIR/releases"'));
  assert.match(source, /ARCHIVE_URL="\$\{BASE_URL%\/\}\/releases\/\$VERSION\/\$TARBALL"/);
});

async function installFixture(t, baseUrl, { corruptChecksum = false } = {}) {
  const directory = await temporaryDirectory(t);
  const staging = join(directory, "staging");
  const packageRoot = join(staging, "zcode");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(join(packageRoot, "bin/zcode.mjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const archive = join(directory, "zcode-1.2.3.tar.gz");
  await exec("tar", ["-czf", archive, "-C", staging, "zcode"]);
  const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  const latest = JSON.stringify({ version: "1.2.3", tarball: "zcode-1.2.3.tar.gz", sha256: corruptChecksum ? "0".repeat(64) : sha256 });
  const shimRoot = join(directory, "shim");
  await mkdir(shimRoot);
  const curlProgram = join(shimRoot, "curl.cjs");
  await writeFile(curlProgram, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const url = args.find((value) => value.startsWith("https://"));
fs.appendFileSync(process.env.TEST_CURL_LOG, url + "\\n");
if (url === process.env.TEST_LATEST_URL) {
  process.stdout.write(process.env.TEST_LATEST_JSON);
} else if (url === process.env.TEST_ARCHIVE_URL && args.includes("-o")) {
  fs.copyFileSync(process.env.TEST_ARCHIVE, args[args.indexOf("-o") + 1]);
} else {
  process.stderr.write("Unexpected curl URL: " + url);
  process.exit(22);
}
`);
  const shellQuotedProgram = `'${curlProgram.replaceAll("'", "'\\''")}'`;
  const curl = join(shimRoot, "curl");
  await writeFile(curl, `#!/usr/bin/env sh\nexec node ${shellQuotedProgram} "$@"\n`);
  await chmod(curl, 0o755);
  const log = join(directory, "curl.log");
  const installer = join(directory, "install.sh");
  await writeFile(installer, installScriptSource(baseUrl));
  const installed = join(directory, "installed");
  const bin = join(directory, "bin");
  const run = async (archiveUrl) => {
    const env = {
      ...process.env,
      PATH: `${shimRoot}${delimiter}${process.env.PATH ?? ""}`,
      ZCODE_DIST_HOME: installed,
      ZCODE_DIST_BIN_DIR: bin,
      TEST_CURL_LOG: log,
      TEST_LATEST_URL: `${baseUrl.replace(/\/$/, "")}/latest.json`,
      TEST_ARCHIVE_URL: archiveUrl,
      TEST_LATEST_JSON: latest,
      TEST_ARCHIVE: archive,
    };
    delete env.ZCODE_DIST_BASE_URL;
    return exec("sh", [installer], { env });
  };
  return { directory, installed, bin, log, run };
}

for (const [name, baseUrl, archiveUrl] of [
  ["static hosting", "https://downloads.example.test/zcode/", "https://downloads.example.test/zcode/releases/1.2.3/zcode-1.2.3.tar.gz"],
  ["GitHub latest assets", "https://github.com/example/zcode-cli/releases/latest/download", "https://github.com/example/zcode-cli/releases/latest/download/zcode-1.2.3.tar.gz"],
  ["GitHub tagged assets", "https://github.com/example/zcode-cli/releases/download/v1.2.3/", "https://github.com/example/zcode-cli/releases/download/v1.2.3/zcode-1.2.3.tar.gz"],
]) {
  test(`installer downloads ${name} archive from its published layout without using the network`, { skip: posixOnly }, async (t) => {
    const fixture = await installFixture(t, baseUrl);
    await fixture.run(archiveUrl);
    assert.deepEqual((await readFile(fixture.log, "utf8")).trim().split("\n"), [
      `${baseUrl.replace(/\/$/, "")}/latest.json`, archiveUrl,
    ]);
    assert.equal(await realpath(join(fixture.installed, "current")), join(fixture.installed, "releases/1.2.3"));
    assert.deepEqual(JSON.parse((await exec(join(fixture.bin, "zcode"), ["--web", "--help"])).stdout), ["--web", "--help"]);
  });
}

test("a SHA256 mismatch rejects installation before touching the previous release or command", { skip: posixOnly }, async (t) => {
  const fixture = await installFixture(t, "https://downloads.example.test/zcode", { corruptChecksum: true });
  const previous = join(fixture.installed, "releases/0.0.1");
  await mkdir(previous, { recursive: true });
  await mkdir(fixture.bin);
  await writeFile(join(previous, "marker"), "previous release bytes\n");
  await writeFile(join(fixture.bin, "zcode"), "previous command bytes\n");
  await symlink(previous, join(fixture.installed, "current"));
  await assert.rejects(
    fixture.run("https://downloads.example.test/zcode/releases/1.2.3/zcode-1.2.3.tar.gz"),
    (error) => error.code === 1 && error.stderr.includes("ZCode archive SHA256 mismatch"),
  );
  assert.equal(await realpath(join(fixture.installed, "current")), previous);
  assert.equal(await readFile(join(previous, "marker"), "utf8"), "previous release bytes\n");
  assert.equal(await readFile(join(fixture.bin, "zcode"), "utf8"), "previous command bytes\n");
  assert.deepEqual(await readdir(join(fixture.installed, "releases")), ["0.0.1"]);
  assert.deepEqual((await readdir(fixture.installed)).sort(), ["current", "releases"]);
});
