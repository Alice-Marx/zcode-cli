import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { create } from "tar";
import { ensureRuntime, runtimeCacheDirectory, runtimeReadyFile } from "../lib/runtime.mjs";

const version = "1.2.3";
const isWindows = process.platform === "win32";

async function fixture(t, modifyArchive) {
  const directory = await mkdtemp(join(tmpdir(), "zcode npm fixture "));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const packageRoot = join(directory, "package");
  const sourceRoot = join(directory, "source");
  const files = {
    "package.json": JSON.stringify({ name: "zcode-runtime", version, type: "module" }),
    "bin/zcode.mjs": "export const runner = true;\n",
    "agent/zcode.cjs": "module.exports = {};\n",
    "server/entry-http.js": "export const server = true;\n",
    "web/index.html": "<!doctype html><html></html>\n",
    "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper": "fixture helper\n",
    "node_modules/node-pty/prebuilds/darwin-x64/spawn-helper": "fixture helper\n",
  };
  for (const [file, content] of Object.entries(files)) {
    const target = join(sourceRoot, "zcode", file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const archiveFile = join(packageRoot, "payload", "zcode-runtime.tar.gz");
  await mkdir(dirname(archiveFile), { recursive: true });
  await create({ cwd: sourceRoot, file: archiveFile, gzip: true, portable: true }, ["zcode"]);
  if (modifyArchive) await writeFile(archiveFile, modifyArchive(await readFile(archiveFile)));
  const payload = {
    schemaVersion: 1,
    file: "payload/zcode-runtime.tar.gz",
    version,
    sha256: createHash("sha256")
      .update(await readFile(archiveFile))
      .digest("hex"),
  };
  await writeFile(join(packageRoot, "payload.json"), JSON.stringify(payload));
  const targetRoot = join(directory, "runtime");
  const cache = join(directory, "cache");
  const cacheOptions = {
    env: { LOCALAPPDATA: cache, XDG_CACHE_HOME: cache },
    homeDirectory: join(directory, "home"),
  };
  return { directory, packageRoot, targetRoot, archiveFile, payload, cacheOptions };
}

function rewriteHeaders(archive, change) {
  const contents = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= contents.length; ) {
    const header = contents.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const path = header.subarray(0, 100).toString().split("\0", 1)[0];
    const size =
      Number.parseInt(header.subarray(124, 136).toString().split("\0", 1)[0].trim(), 8) || 0;
    change(header, path);
    header.fill(32, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return gzipSync(contents);
}

function headerString(header, offset, length, text) {
  header.fill(0, offset, offset + length);
  header.write(text, offset, length, "utf8");
}

test("digest mismatch fails before creating a runtime or staging directory", async (t) => {
  const f = await fixture(t);
  await writeFile(f.archiveFile, "tampered");
  await assert.rejects(ensureRuntime(f), { code: "ZCODE_PAYLOAD_DIGEST" });
  assert.equal(await lstat(f.targetRoot).catch(() => null), null);
  assert.equal(
    (await readdir(f.directory)).some((name) => name.startsWith(".zcode-npm-stage-")),
    false,
  );
});

for (const unsafePath of [
  "../escape.js",
  "/outside.js",
  "zcode/../escape.js",
  "zcode/C:/escape.js",
  "another-root/file.js",
]) {
  test(`rejects archive path ${unsafePath}`, async (t) => {
    const f = await fixture(t, (archive) =>
      rewriteHeaders(archive, (header, path) => {
        if (path === "zcode/bin/zcode.mjs") headerString(header, 0, 100, unsafePath);
      }),
    );
    await assert.rejects(ensureRuntime(f), { code: "ZCODE_ARCHIVE_PATH" });
    assert.equal(await lstat(f.targetRoot).catch(() => null), null);
    assert.equal(
      (await readdir(f.directory)).some((name) => name.startsWith(".zcode-npm-stage-")),
      false,
    );
  });
}

for (const [type, name] of [
  ["1", "hard link"],
  ["2", "symbolic link"],
  ["6", "FIFO"],
]) {
  test(`rejects ${name} entries`, async (t) => {
    const f = await fixture(t, (archive) =>
      rewriteHeaders(archive, (header, path) => {
        if (path === "zcode/bin/zcode.mjs") {
          header[156] = type.charCodeAt(0);
          if (type !== "6") headerString(header, 157, 100, "zcode/agent/zcode.cjs");
        }
      }),
    );
    await assert.rejects(ensureRuntime(f), { code: "ZCODE_ARCHIVE_TYPE" });
    assert.equal(await lstat(f.targetRoot).catch(() => null), null);
  });
}

test("normalizes all modes and restores CLI and macOS helper executables", async (t) => {
  const f = await fixture(t, (archive) =>
    rewriteHeaders(archive, (header) => {
      headerString(header, 100, 8, "0007777");
    }),
  );
  const previousUmask = !isWindows ? process.umask(0o077) : undefined;
  try {
    assert.equal(await ensureRuntime(f), f.targetRoot);
  } finally {
    if (previousUmask !== undefined) process.umask(previousUmask);
  }
  const marker = JSON.parse(await readFile(join(f.targetRoot, runtimeReadyFile), "utf8"));
  assert.deepEqual(marker, { schemaVersion: 1, version, sha256: f.payload.sha256 });
  if (!isWindows) {
    for (const file of [
      "bin/zcode.mjs",
      "agent/zcode.cjs",
      "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      "node_modules/node-pty/prebuilds/darwin-x64/spawn-helper",
    ]) {
      assert.equal((await stat(join(f.targetRoot, file))).mode & 0o7777, 0o755, file);
    }
    for (const file of [
      "package.json",
      "server/entry-http.js",
      "web/index.html",
      runtimeReadyFile,
    ]) {
      assert.equal((await stat(join(f.targetRoot, file))).mode & 0o7777, 0o644, file);
    }
    for (const file of ["", "bin", "agent", "server", "web", "node_modules/node-pty"]) {
      assert.equal((await stat(join(f.targetRoot, file))).mode & 0o7777, 0o755, file);
    }
  }
});

test("concurrent preparation accepts only a complete winner with the same digest", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await Promise.all([ensureRuntime(f), ensureRuntime(f), ensureRuntime(f)]),
    Array(3).fill(f.targetRoot),
  );
  assert.equal(
    (await readdir(f.directory)).some((name) => name.startsWith(".zcode-npm-stage-")),
    false,
  );
  assert.equal(await ensureRuntime(f), f.targetRoot);
});

test("never removes an existing incomplete target", async (t) => {
  const f = await fixture(t);
  await mkdir(f.targetRoot);
  await writeFile(join(f.targetRoot, "keep.txt"), "preserve me");
  await assert.rejects(ensureRuntime(f));
  assert.equal(await readFile(join(f.targetRoot, "keep.txt"), "utf8"), "preserve me");
  assert.equal(await lstat(join(f.targetRoot, runtimeReadyFile)).catch(() => null), null);
});

test("a completed runtime for another digest is preserved and rejected", async (t) => {
  const f = await fixture(t);
  await ensureRuntime(f);
  const oldMarker = await readFile(join(f.targetRoot, runtimeReadyFile), "utf8");
  const archive = gzipSync(gunzipSync(await readFile(f.archiveFile)), { level: 9 });
  const sha256 = createHash("sha256").update(archive).digest("hex");
  assert.notEqual(sha256, f.payload.sha256);
  await writeFile(f.archiveFile, archive);
  await writeFile(join(f.packageRoot, "payload.json"), JSON.stringify({ ...f.payload, sha256 }));
  await assert.rejects(ensureRuntime(f));
  assert.equal(await readFile(join(f.targetRoot, runtimeReadyFile), "utf8"), oldMarker);
});

test("oversized entry headers fail before any extraction", async (t) => {
  const f = await fixture(t, (archive) =>
    rewriteHeaders(archive, (header, path) => {
      if (path === "zcode/bin/zcode.mjs")
        headerString(header, 124, 12, (128 * 1024 * 1024 + 1).toString(8));
    }),
  );
  await assert.rejects(ensureRuntime(f), { code: "ZCODE_ARCHIVE_SIZE" });
  assert.equal(await lstat(f.targetRoot).catch(() => null), null);
});

test("runtime version mismatch never publishes a completion marker", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.packageRoot, "payload.json"),
    JSON.stringify({ ...f.payload, version: "9.9.9" }),
  );
  await assert.rejects(ensureRuntime(f), { code: "ZCODE_RUNTIME_VERSION" });
  assert.equal(await lstat(f.targetRoot).catch(() => null), null);
  assert.equal(
    (await readdir(f.directory)).some((name) => name.startsWith(".zcode-npm-stage-")),
    false,
  );
});

test("ignore-scripts startup uses user cache and leaves the package directory untouched", async (t) => {
  const f = await fixture(t);
  const expected = runtimeCacheDirectory(f.payload, f.cacheOptions);
  assert.equal(await ensureRuntime({ packageRoot: f.packageRoot, ...f.cacheOptions }), expected);
  assert.equal(await lstat(join(f.packageRoot, "runtime")).catch(() => null), null);
  assert.equal(
    JSON.parse(await readFile(join(expected, runtimeReadyFile), "utf8")).sha256,
    f.payload.sha256,
  );
  assert.equal(await ensureRuntime({ packageRoot: f.packageRoot, ...f.cacheOptions }), expected);
});

test("postinstall prepares package runtime, then ordinary startup reuses it", async (t) => {
  const f = await fixture(t);
  const packageRuntime = join(f.packageRoot, "runtime");
  assert.equal(
    await ensureRuntime({
      packageRoot: f.packageRoot,
      preferPackageRuntime: true,
      ...f.cacheOptions,
    }),
    packageRuntime,
  );
  assert.equal(
    await ensureRuntime({ packageRoot: f.packageRoot, ...f.cacheOptions }),
    packageRuntime,
  );
  assert.equal(
    await lstat(runtimeCacheDirectory(f.payload, f.cacheOptions)).catch(() => null),
    null,
  );
});

test(
  "postinstall permission failure falls back to user cache",
  {
    skip:
      isWindows || process.getuid?.() === 0
        ? "POSIX permission enforcement requires a non-root process"
        : false,
  },
  async (t) => {
    const f = await fixture(t);
    await chmod(f.packageRoot, 0o555);
    try {
      assert.equal(
        await ensureRuntime({
          packageRoot: f.packageRoot,
          preferPackageRuntime: true,
          ...f.cacheOptions,
        }),
        runtimeCacheDirectory(f.payload, f.cacheOptions),
      );
    } finally {
      await chmod(f.packageRoot, 0o755);
    }
  },
);

test("cache paths use OS defaults and ignore relative standard cache variables", () => {
  const homeDirectory = join(tmpdir(), "zcode-home");
  const payload = { version, sha256: "a".repeat(64) };
  const suffix = join("zcode-cli", "npm", `${version}-${"a".repeat(16)}`);
  assert.equal(
    runtimeCacheDirectory(payload, { env: {}, platform: "darwin", homeDirectory }),
    join(homeDirectory, "Library", "Caches", suffix),
  );
  assert.equal(
    runtimeCacheDirectory(payload, { env: {}, platform: "linux", homeDirectory }),
    join(homeDirectory, ".cache", suffix),
  );
  assert.equal(
    runtimeCacheDirectory(payload, { env: {}, platform: "win32", homeDirectory }),
    join(homeDirectory, "AppData", "Local", suffix),
  );
  assert.equal(
    runtimeCacheDirectory(payload, {
      env: { XDG_CACHE_HOME: "relative" },
      platform: "linux",
      homeDirectory,
    }),
    join(homeDirectory, ".cache", suffix),
  );
});
