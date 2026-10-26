// 通过真实 npm CLI 和全局命令 shim，在仓库外验收发布 tarball；不发送模型请求。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const exec = promisify(execFile);
const isWindows = process.platform === "win32";
const npmInstallTimeout = 180000;
const repository = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const expectedPackageVersion = JSON.parse(
  await readFile(join(repository, "distribution/npm/package.json"), "utf8"),
).version;
const tarballArgument = process.argv[2];
assert.ok(tarballArgument, "Usage: npm run smoke:npm -- <package.tgz>");
const tarball = await realpath(resolve(tarballArgument));
assert.ok(
  process.env.npm_execpath,
  "Run this smoke through npm run so npm_execpath is the real npm CLI",
);
const npmCli = await realpath(process.env.npm_execpath);
assert.equal(
  basename(npmCli),
  "npm-cli.js",
  "npm_execpath must identify npm, not pnpm or a shell shim",
);

const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode npm smoke-")));
const workspace = join(directory, "empty workspace");
const homeDirectory = join(directory, "isolated home");
const cacheDirectory = join(directory, "runtime cache");
const env = { ...process.env };
const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") || "PATH";
env[pathKey] = [
  dirname(process.execPath),
  ...(env[pathKey] || "")
    .split(isWindows ? ";" : ":")
    .filter((entry) => entry && !within(repository, resolve(entry))),
].join(isWindows ? ";" : ":");
Object.assign(env, {
  HOME: homeDirectory,
  USERPROFILE: homeDirectory,
  LOCALAPPDATA: cacheDirectory,
  XDG_CACHE_HOME: cacheDirectory,
  ZCODE_DATA_BASE_DIR: join(directory, "zcode data"),
  NODE_PATH: "",
  NODE_OPTIONS: "",
  npm_config_cache: join(directory, "npm cache"),
  npm_config_update_notifier: "false",
});
const ownedPids = new Set();
const ownedGroups = new Set();
const childrenClosed = [];
let smokeError;

try {
  assert.ok(!within(repository, directory), "npm smoke must run outside the source repository");
  await Promise.all([mkdir(workspace), mkdir(homeDirectory), mkdir(cacheDirectory)]);
  assert.equal(env.NODE_PATH, "");
  console.log("Installing npm tarball into an isolated prefix containing spaces");
  const normal = await install("normal install", false);
  await validateRuntime(join(normal.packageRoot, "runtime"), normal.payload);
  await assertCommand(normal, ["--version"], (output) =>
    assert.equal(output.trim(), normal.metadata.version),
  );
  await assertCommand(normal, ["--web", "--help"], assertWebHelp);

  console.log("Verifying installed npm command in the native TUI and local Web smoke");
  const native = await run(
    process.execPath,
    [
      fileURLToPath(new URL("./zcode-distribution-smoke.mjs", import.meta.url)),
      "--installed-npm",
      normal.packageRoot,
    ],
    { timeout: 0 },
  );
  process.stdout.write(native.stdout);
  process.stderr.write(native.stderr);
  // Native smoke owns its own worker and check file, but must retain the caller's installation.
  await validateRuntime(join(normal.packageRoot, "runtime"), normal.payload);

  console.log("Verifying --ignore-scripts installation and first-launch user cache extraction");
  const fallback = await install("ignore scripts install", true);
  const packageRuntime = join(fallback.packageRoot, "runtime");
  assert.equal(
    await exists(packageRuntime),
    false,
    "--ignore-scripts must leave the package runtime absent",
  );
  const { runtimeCacheDirectory } = await import(
    pathToFileURL(join(fallback.packageRoot, "lib/runtime.mjs")).href
  );
  const userRuntime = runtimeCacheDirectory(fallback.payload, {
    env,
    platform: process.platform,
    homeDirectory,
  });
  assert.ok(
    within(directory, userRuntime),
    `Fallback runtime escaped isolated cache: ${userRuntime}`,
  );
  // 冷首启执行与 postinstall 相同的校验和解包；Windows CI 正常安装已观测到约 116 秒。
  const coldStarted = performance.now();
  let coldCompleted = false;
  let coldElapsedMs;
  try {
    await assertCommand(
      fallback,
      ["--version"],
      (output) => assert.equal(output.trim(), fallback.metadata.version),
      npmInstallTimeout,
    );
    coldCompleted = true;
  } catch (error) {
    coldElapsedMs = Math.round(performance.now() - coldStarted);
    const diagnostics = await coldCacheDiagnostics(userRuntime).catch((diagnosticError) => ({
      error: diagnosticError.message,
    }));
    console.error(JSON.stringify({ coldCacheDiagnostics: diagnostics }));
    throw error;
  } finally {
    console.log(
      JSON.stringify({
        phase: "first-launch-user-cache",
        elapsedMs: coldElapsedMs ?? Math.round(performance.now() - coldStarted),
        timeoutMs: npmInstallTimeout,
        result: coldCompleted ? "passed" : "failed",
      }),
    );
  }
  await validateRuntime(userRuntime, fallback.payload);
  const firstReady = await stat(join(userRuntime, ".zcode-npm-runtime.json"));
  await assertCommand(fallback, ["--web", "--help"], assertWebHelp);
  const reusedReady = await stat(join(userRuntime, ".zcode-npm-runtime.json"));
  assert.equal(
    reusedReady.mtimeMs,
    firstReady.mtimeMs,
    "Second launch must reuse the ready user runtime",
  );
  assert.equal(
    await exists(packageRuntime),
    false,
    "Fallback must keep using user cache, not package runtime",
  );
  console.log(
    JSON.stringify({
      package: normal.metadata.name,
      version: normal.metadata.version,
      npm: "real npm CLI, isolated global prefixes, generated zcode shims passed",
      normal: "postinstall runtime, version, Web help, native TUI and Web passed",
      ignoreScripts: "first-launch user cache, version and second-launch Web help passed",
      isolated: true,
      nodePath: env.NODE_PATH,
    }),
  );
} catch (error) {
  smokeError = error;
} finally {
  const cleanupErrors = [];
  try {
    for (const pid of await snapshotProcessForest([...ownedPids])) ownedPids.add(pid);
  } catch (error) {
    cleanupErrors.push(error);
  }
  for (const pid of ownedGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") cleanupErrors.push(error);
    }
  }
  for (const pid of ownedPids) {
    if (!isRunning(pid)) continue;
    try {
      if (isWindows)
        await exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 10000 });
      else process.kill(pid, "SIGKILL");
    } catch (error) {
      if (isRunning(pid)) cleanupErrors.push(error);
    }
  }
  await Promise.all(childrenClosed);
  const deadline = Date.now() + 5000;
  const survivors = () => [...ownedPids].filter(isRunning);
  const survivingGroups = () => [...ownedGroups].filter((pid) => isRunning(-pid));
  while ((survivors().length || survivingGroups().length) && Date.now() < deadline)
    await delay(100);
  if (survivors().length)
    cleanupErrors.push(new Error(`npm smoke left running PIDs: ${survivors()}`));
  if (survivingGroups().length)
    cleanupErrors.push(new Error(`npm smoke left process groups: ${survivingGroups()}`));
  // 仅删除本次 mkdtemp 目录；native worker 已退出，Windows 不再持有发行包 DLL。
  if (!survivors().length && !survivingGroups().length) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    smokeError = new AggregateError(
      smokeError ? [smokeError, ...cleanupErrors] : cleanupErrors,
      "npm smoke cleanup failed",
    );
  }
}
if (smokeError) throw smokeError;
console.log(
  JSON.stringify({
    cleanup: "all owned command processes exited; isolated npm prefixes and cache removed",
  }),
);

async function install(name, ignoreScripts) {
  const prefix = join(directory, name);
  // npm run 会把用户 allow-scripts 策略导出；仅为已授权的正常安装精确放行本测试包。
  const allowOwnPostinstall =
    !ignoreScripts &&
    Object.keys(env).some((key) => key.toLowerCase() === "npm_config_allow_scripts");
  await runNpm([
    "install",
    "--global",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    `--ignore-scripts=${ignoreScripts}`,
    ...(allowOwnPostinstall ? [`--allow-scripts=@ljwei-stak/zcode-cli@${expectedPackageVersion}`] : []),
    tarball,
  ]);
  const { stdout } = await runNpm(["root", "--global", "--prefix", prefix]);
  const npmRoot = await realpath(stdout.trim());
  assert.ok(within(prefix, npmRoot), "npm root -g escaped the requested prefix");
  const packageRoot = await realpath(join(npmRoot, "@ljwei-stak", "zcode-cli"));
  assert.ok(within(prefix, packageRoot), "Installed package escaped the requested prefix");
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(metadata.name, "@ljwei-stak/zcode-cli");
  assert.notEqual(metadata.private, true);
  assert.equal(
    resolve(packageRoot, metadata.bin?.zcode || ""),
    join(packageRoot, "bin/zcode.mjs"),
    "npm bin must target the package's bin/zcode.mjs",
  );
  for (const dependency of Object.values(metadata.dependencies || {}))
    assert.doesNotMatch(dependency, /^workspace:/);
  const payload = JSON.parse(await readFile(join(packageRoot, "payload.json"), "utf8"));
  assert.equal(payload.version, metadata.version);
  assert.match(payload.sha256, /^[0-9a-f]{64}$/);
  const runner = await realpath(join(packageRoot, metadata.bin.zcode));
  const shim = isWindows ? join(prefix, "zcode.ps1") : join(prefix, "bin/zcode");
  if (isWindows) {
    for (const name of ["zcode", "zcode.cmd", "zcode.ps1"]) {
      const source = (await readFile(join(prefix, name), "utf8")).replaceAll("\\", "/");
      assert.ok(
        source.includes("node_modules/@ljwei-stak/zcode-cli/bin/zcode.mjs"),
        `Invalid npm shim: ${name}`,
      );
    }
  } else {
    assert.equal(
      await realpath(shim),
      runner,
      "npm zcode symlink must resolve to the installed bin",
    );
  }
  return { packageRoot, metadata, payload, runner, shim };
}

async function assertCommand(installation, args, check, timeout = 30000) {
  // -File passes paths and argv without cmd.exe quoting or shell interpolation.
  const result = isWindows
    ? await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          installation.shim,
          ...args,
        ],
        { timeout },
      )
    : await run(installation.shim, args, { timeout });
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/,
  );
  check(result.stdout);
}

function assertWebHelp(output) {
  assert.match(output, /Usage:/);
  assert.match(output, /zcode --web/);
  assert.match(output, /--workspace/);
}

async function validateRuntime(root, payload) {
  for (const name of [
    "bin/zcode.mjs",
    "agent/zcode.cjs",
    "server/entry-http.js",
    "web/index.html",
  ]) {
    assert.ok((await stat(join(root, name))).isFile(), `Missing npm runtime file: ${name}`);
  }
  const ready = JSON.parse(await readFile(join(root, ".zcode-npm-runtime.json"), "utf8"));
  assert.equal(ready.version, payload.version);
  assert.equal(ready.sha256, payload.sha256);
}

function runNpm(args) {
  return run(process.execPath, [npmCli, ...args], { timeout: npmInstallTimeout });
}

async function coldCacheDiagnostics(root) {
  const parent = dirname(root);
  const siblings = await readdir(parent).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const staging = await Promise.all(
    siblings
      .filter((name) => name.startsWith(".zcode-npm-stage-"))
      .map(async (name) => {
        try {
          const entries = await readdir(join(parent, name), {
            recursive: true,
            withFileTypes: true,
          });
          return { name, files: entries.filter((entry) => entry.isFile()).length };
        } catch (error) {
          return { name, error: error.code || error.message };
        }
      }),
  );
  return {
    runtimeExists: await exists(root),
    readyMarkerExists: await exists(join(root, ".zcode-npm-runtime.json")),
    staging,
  };
}

function run(command, args, options = {}) {
  const result = exec(command, args, {
    cwd: workspace,
    env,
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    detached: !isWindows,
    killSignal: "SIGKILL",
    ...options,
  });
  const child = result.child;
  // npm 的 PowerShell shim 会枚举 $input；非交互验收必须发送 EOF，避免它等待管道输入。
  child.stdin?.end();
  childrenClosed.push(new Promise((done) => child.once("close", done)));
  if (child.pid) {
    ownedPids.add(child.pid);
    if (!isWindows) ownedGroups.add(child.pid);
  }
  return result;
}

function within(parent, target) {
  const path = relative(resolve(parent), resolve(target));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function snapshotProcessForest(pids) {
  if (!pids.length) return [];
  const { stdout } = isWindows
    ? await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
        ],
        { timeout: 10000 },
      )
    : await exec("ps", ["-eo", "pid=,ppid="], { timeout: 10000 });
  const rows = isWindows
    ? JSON.parse(stdout).map((row) => [row.ProcessId, row.ParentProcessId])
    : stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).map(Number));
  const descendants = new Set(pids);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [candidate, parent] of rows) {
      if (descendants.has(parent) && !descendants.has(candidate)) {
        descendants.add(candidate);
        changed = true;
      }
    }
  }
  return [...descendants];
}
