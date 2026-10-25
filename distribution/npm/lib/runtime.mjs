import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { list, extract } from "tar";

export const runtimeReadyFile = ".zcode-npm-runtime.json";

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maximumArchiveBytes = 128 * 1024 * 1024;
const maximumExpandedBytes = 512 * 1024 * 1024;
const maximumEntryBytes = 128 * 1024 * 1024;
const maximumEntryCount = 25000;
const maximumPathDepth = 64;
const directoryMode = 0o755;
const fileMode = 0o644;
const privateDirectoryMode = 0o700;
const permissionErrorCodes = new Set(["EACCES", "EPERM", "EROFS"]);
const missingErrorCodes = new Set(["ENOENT", "ENOTDIR"]);
const requiredFiles = [
  "package.json",
  "bin/zcode.mjs",
  "agent/zcode.cjs",
  "server/entry-http.js",
  "web/index.html",
];
const executableFiles = [
  "bin/zcode.mjs",
  "agent/zcode.cjs",
  "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
  "node_modules/node-pty/prebuilds/darwin-x64/spawn-helper",
];

function runtimeError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function safeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\\:]/.test(value) &&
    !value.includes("\0") &&
    !isAbsolute(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

async function readPayload(packageRoot) {
  const payload = JSON.parse(await readFile(join(packageRoot, "payload.json"), "utf8"));
  if (
    payload.schemaVersion !== 1 ||
    !safeRelativePath(payload.file) ||
    !/^[a-f0-9]{64}$/i.test(payload.sha256 ?? "") ||
    typeof payload.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(payload.version)
  ) {
    throw runtimeError("Invalid ZCode runtime payload manifest", "ZCODE_PAYLOAD_MANIFEST");
  }
  return { ...payload, sha256: payload.sha256.toLowerCase() };
}

export function runtimeCacheDirectory(
  payload,
  { env = process.env, platform = process.platform, homeDirectory = homedir() } = {},
) {
  const standardCache =
    platform === "win32"
      ? env.LOCALAPPDATA || join(homeDirectory, "AppData", "Local")
      : env.XDG_CACHE_HOME ||
        (platform === "darwin"
          ? join(homeDirectory, "Library", "Caches")
          : join(homeDirectory, ".cache"));
  const cacheRoot = isAbsolute(standardCache)
    ? standardCache
    : platform === "win32"
      ? join(homeDirectory, "AppData", "Local")
      : platform === "darwin"
        ? join(homeDirectory, "Library", "Caches")
        : join(homeDirectory, ".cache");
  return join(cacheRoot, "zcode-cli", "npm", `${payload.version}-${payload.sha256.slice(0, 16)}`);
}

async function isRegularFile(file) {
  try {
    return (await lstat(file)).isFile();
  } catch (error) {
    if (missingErrorCodes.has(error.code)) return false;
    throw error;
  }
}

async function checkRuntimeFiles(runtimeRoot, payload) {
  for (const file of requiredFiles) {
    if (!(await isRegularFile(join(runtimeRoot, file)))) {
      throw runtimeError(`Missing ZCode runtime file: ${file}`, "ZCODE_RUNTIME_INCOMPLETE");
    }
  }
  const metadata = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
  if (metadata.version !== payload.version) {
    throw runtimeError(
      "ZCode runtime version does not match its payload manifest",
      "ZCODE_RUNTIME_VERSION",
    );
  }
}

async function isReady(runtimeRoot, payload) {
  try {
    if (!(await lstat(runtimeRoot)).isDirectory()) return false;
    if (!(await isRegularFile(join(runtimeRoot, runtimeReadyFile)))) return false;
    const marker = JSON.parse(await readFile(join(runtimeRoot, runtimeReadyFile), "utf8"));
    if (
      marker.schemaVersion !== 1 ||
      marker.version !== payload.version ||
      marker.sha256 !== payload.sha256
    )
      return false;
    await checkRuntimeFiles(runtimeRoot, payload);
    return true;
  } catch (error) {
    if (
      missingErrorCodes.has(error.code) ||
      permissionErrorCodes.has(error.code) ||
      error instanceof SyntaxError ||
      error.code === "ZCODE_RUNTIME_INCOMPLETE" ||
      error.code === "ZCODE_RUNTIME_VERSION"
    )
      return false;
    throw error;
  }
}

async function verifiedArchive(packageRoot, payload) {
  const file = join(packageRoot, payload.file);
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.size > maximumArchiveBytes || metadata.size === 0) {
    throw runtimeError(
      "ZCode runtime archive must be a regular file of at most 128 MiB",
      "ZCODE_PAYLOAD_SIZE",
    );
  }
  // 同一份已校验字节贯穿校验和解包，避免文件在两次读取间被替换。
  const archive = await readFile(file);
  if (
    archive.length > maximumArchiveBytes ||
    createHash("sha256").update(archive).digest("hex") !== payload.sha256
  ) {
    throw runtimeError("ZCode runtime archive SHA256 mismatch", "ZCODE_PAYLOAD_DIGEST");
  }
  return archive;
}

async function inspectArchive(archive) {
  let entryCount = 0;
  let expandedBytes = 0;
  let declaredBytes = 0;
  let invalidEntry;
  const parser = list({
    strict: true,
    filter(path, entry) {
      const cleanPath = path.endsWith("/") ? path.slice(0, -1) : path;
      const parts = cleanPath.split("/");
      if (
        !safeRelativePath(cleanPath) ||
        parts[0] !== "zcode" ||
        parts.length > maximumPathDepth ||
        (parts.length === 1 && entry.type !== "Directory")
      ) {
        invalidEntry = runtimeError(`Unsafe ZCode archive path: ${path}`, "ZCODE_ARCHIVE_PATH");
      } else if (entry.type !== "File" && entry.type !== "Directory") {
        invalidEntry = runtimeError(
          `Unsupported ZCode archive entry: ${entry.type}`,
          "ZCODE_ARCHIVE_TYPE",
        );
      } else if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > maximumEntryBytes ||
        ++entryCount > maximumEntryCount ||
        (declaredBytes += entry.size) > maximumExpandedBytes
      ) {
        invalidEntry = runtimeError(
          "ZCode archive exceeds extraction limits",
          "ZCODE_ARCHIVE_SIZE",
        );
      }
      if (invalidEntry) parser.abort(invalidEntry);
      // Listing only: no archive entry can touch the filesystem during validation.
      return false;
    },
  });
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      expandedBytes += chunk.length;
      callback(
        expandedBytes > maximumExpandedBytes
          ? runtimeError("ZCode archive exceeds expanded size limit", "ZCODE_ARCHIVE_SIZE")
          : null,
        chunk,
      );
    },
  });
  await pipeline(Readable.from([archive]), createGunzip(), limit, parser);
  if (invalidEntry) throw invalidEntry;
}

async function extractArchive(archive, runtimeRoot, payload) {
  await mkdir(runtimeRoot, { mode: directoryMode });
  const unpack = extract({
    cwd: runtimeRoot,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    strip: 1,
    chmod: true,
    processUmask: 0o022,
    dmode: directoryMode,
    fmode: fileMode,
    filter(_path, entry) {
      // Windows tar 的 0666/0777 不能照搬到系统目录，也不保留特权位。
      entry.mode = entry.type === "Directory" ? directoryMode : fileMode;
      return true;
    },
  });
  await pipeline(Readable.from([archive]), unpack);
  await checkRuntimeFiles(runtimeRoot, payload);
  // tar 的新文件仍受进程 umask 影响；系统安装者使用 0077 时也要让普通用户可读。
  if (process.platform !== "win32") await normalizeModes(runtimeRoot);
  for (const file of executableFiles) {
    if (await isRegularFile(join(runtimeRoot, file)))
      await chmod(join(runtimeRoot, file), directoryMode);
  }
  await chmod(runtimeRoot, directoryMode);
  await writeFile(
    join(runtimeRoot, runtimeReadyFile),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        version: payload.version,
        sha256: payload.sha256,
      },
      null,
      2,
    )}\n`,
    { mode: fileMode, flag: "wx" },
  );
  await chmod(join(runtimeRoot, runtimeReadyFile), fileMode);
}

async function normalizeModes(directory) {
  await chmod(directory, directoryMode);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await normalizeModes(file);
    else if (entry.isFile()) await chmod(file, fileMode);
    else throw runtimeError("Unexpected extracted ZCode file type", "ZCODE_ARCHIVE_TYPE");
  }
}

async function prepareRuntime(packageRoot, runtimeRoot, payload) {
  if (await isReady(runtimeRoot, payload)) return runtimeRoot;
  const archive = await verifiedArchive(packageRoot, payload);
  await inspectArchive(archive);
  await mkdir(dirname(runtimeRoot), { recursive: true, mode: directoryMode });
  const staging = await mkdtemp(join(dirname(runtimeRoot), ".zcode-npm-stage-"));
  try {
    await chmod(staging, privateDirectoryMode);
    const prepared = join(staging, "runtime");
    await extractArchive(archive, prepared, payload);
    try {
      await rename(prepared, runtimeRoot);
    } catch (error) {
      // 并发首启只接受同摘要且完整的赢家；绝不删除正在使用的原生运行时。
      if (!(await isReady(runtimeRoot, payload))) {
        throw runtimeError(
          `Unable to prepare ZCode runtime at ${runtimeRoot}: ${error.message}`,
          error.code,
          error,
        );
      }
    }
    return runtimeRoot;
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Prepare immutable runtime assets; only the CLI entry imports executable code. */
export async function ensureRuntime({
  packageRoot = defaultPackageRoot,
  targetRoot,
  preferPackageRuntime = false,
  env = process.env,
  platform = process.platform,
  homeDirectory = homedir(),
} = {}) {
  packageRoot = resolve(packageRoot);
  const payload = await readPayload(packageRoot);
  if (targetRoot) return prepareRuntime(packageRoot, resolve(targetRoot), payload);
  const packageRuntime = join(packageRoot, "runtime");
  if (await isReady(packageRuntime, payload)) return packageRuntime;
  if (preferPackageRuntime) {
    try {
      return await prepareRuntime(packageRoot, packageRuntime, payload);
    } catch (error) {
      if (!permissionErrorCodes.has(error.code)) throw error;
    }
  }
  return prepareRuntime(
    packageRoot,
    runtimeCacheDirectory(payload, { env, platform, homeDirectory }),
    payload,
  );
}
