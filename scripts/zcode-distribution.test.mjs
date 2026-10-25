import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { installScriptSource } from "./zcode-distribution/installer.mjs";

const exec = promisify(execFile);
const runnerSource = new URL("./zcode-distribution/runner.mjs", import.meta.url);
const isWindows = process.platform === "win32";

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function stopProcessTree(pid) {
  if (isWindows) {
    if (!isRunning(pid)) return;
    await exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"]).catch((error) => {
      // 进程可能在 taskkill 查询前自行退出；仍存活时不吞掉清理失败。
      if (isRunning(pid)) throw error;
    });
    return;
  }
  try {
    // 测试启动器拥有独立进程组；父进程已退出时也清理该组中的后端。
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-distribution-")));
  const children = new Set();
  t.after(async () => {
    for (const pid of children) await stopProcessTree(pid);
    await rm(directory, { recursive: true, force: true });
  });
  const root = join(directory, "zcode");
  for (const name of ["bin", "agent", "web", "server"]) {
    await mkdir(join(root, name), { recursive: true });
  }
  await cp(runnerSource, join(root, "bin/zcode.mjs"));
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", version: "1.2.3" }));
  await writeFile(
    join(root, "agent/zcode.cjs"),
    `
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), entry: process.argv[1], cwd: process.cwd() }));
process.exitCode = Number(process.env.FIXTURE_EXIT_CODE || 0);
`,
  );
  await writeFile(
    join(root, "server/entry-http.js"),
    `
import { writeFile } from 'node:fs/promises';
await writeFile(process.env.FIXTURE_WEB_RESULT, JSON.stringify({
  pid: process.pid,
  cwd: process.cwd(), port: process.env.PORT, host: process.env.ZCODE_SERVER_HOST,
  workspace: process.env.ZCODE_SERVER_WORKSPACE, staticRoot: process.env.ZCODE_WEB_STATIC_ROOT,
  command: process.env.ZCODE_AGENT_SERVER_COMMAND, args: JSON.parse(process.env.ZCODE_AGENT_SERVER_ARGS_JSON),
  token: process.env.ZCODE_SERVER_AUTH_TOKEN,
}));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );
  return { directory, root, runner: join(root, "bin/zcode.mjs"), children };
}

test("default launch and CLI arguments reuse the Agent entry without starting Web", async (t) => {
  const { runner, root, directory } = await fixture(t);
  for (const args of [[], ["tui"], ["--prompt", "--web"], ["app-server", "--stdio"]]) {
    const result = await exec(process.execPath, [runner, ...args], { cwd: directory });
    assert.deepEqual(JSON.parse(result.stdout), {
      argv: args,
      entry: join(root, "agent/zcode.cjs"),
      cwd: directory,
    });
  }
  await assert.rejects(
    exec(process.execPath, [runner], { env: { ...process.env, FIXTURE_EXIT_CODE: "17" } }),
    (error) => error.code === 17,
  );
});

test("help exposes Web mode and preserves CLI help; version uses the distribution", async (t) => {
  const { runner } = await fixture(t);
  assert.equal((await exec(process.execPath, [runner, "--version"])).stdout.trim(), "1.2.3");
  const help = (await exec(process.execPath, [runner, "--help"])).stdout;
  assert.match(help, /zcode --web/);
  assert.match(help, /"argv":\["--help"\]/);
  const webHelp = (await exec(process.execPath, [runner, "--web", "--help"])).stdout;
  assert.match(webHelp, /--workspace/);
  assert.doesNotMatch(webHelp, /"argv"/);
  await assert.rejects(exec(process.execPath, [runner, "--web", "--unknown"]), /Unknown option/);
  await assert.rejects(
    exec(process.execPath, [runner, "--web", "--port", "NaN"]),
    /--port must be an integer/,
  );
});

test("Web startup errors preserve a failing exit code", async (t) => {
  const { runner, directory, root } = await fixture(t);
  await assert.rejects(
    exec(process.execPath, [
      runner,
      "--web",
      "--workspace",
      join(directory, "missing"),
      "--no-open",
    ]),
    /Unable to start Web server/,
  );
  await rm(join(root, "server/entry-http.js"));
  await assert.rejects(
    exec(process.execPath, [runner, "--web", "--no-open"]),
    /Missing runtime file/,
  );
});

test("Web mode passes its runtime configuration", async (t) => {
  const { directory, runner, root, children } = await fixture(t);
  const resultPath = join(directory, "web-result.json");
  const child = spawn(
    process.execPath,
    [
      runner,
      "--web",
      "--workspace",
      directory,
      "--host",
      "127.0.0.1",
      "--port",
      "3041",
      "--no-open",
      "--no-token",
    ],
    {
      env: {
        ...process.env,
        FIXTURE_WEB_RESULT: resultPath,
        ZCODE_SERVER_AUTH_TOKEN: "stale-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWindows,
    },
  );
  children.add(child.pid);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = once(child, "exit");
  let result;
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await readFile(resultPath, "utf8")
      .then(JSON.parse)
      .catch(() => undefined);
    if (result) break;
    await setTimeout(20);
  }
  assert.ok(result, `Web fixture failed to start:\n${output}`);
  if (isWindows) children.add(result.pid);
  const { pid: serverPid, ...configuration } = result;
  assert.deepEqual(configuration, {
    cwd: directory,
    port: "3041",
    host: "127.0.0.1",
    workspace: directory,
    staticRoot: join(root, "web"),
    command: process.execPath,
    args: [join(root, "agent/zcode.cjs"), "app-server", "--stdio"],
    token: "",
  });
  await t.test("SIGTERM shuts down the runner and backend", {
    skip: isWindows
      ? "Windows ChildProcess.kill(SIGTERM) forcibly terminates the parent without delivering a signal; real Ctrl+C shutdown is checked by smoke:distribution in a native PTY."
      : false,
  }, async () => {
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
    assert.equal(isRunning(serverPid), false, "Web backend survived runner shutdown");
  });
});

test("installer creates zcode and the installed command defaults to CLI", {
  // Git Bash/WSL 会重写路径和 shebang，不能代表 Windows 原生安装链路。
  skip: isWindows ? "POSIX shell installer is tested on Linux/macOS; Windows uses the native distribution launcher." : false,
}, async (t) => {
  const { directory, root } = await fixture(t);
  const downloads = join(directory, "downloads");
  const releaseDir = join(downloads, "releases/1.2.3");
  await mkdir(releaseDir, { recursive: true });
  const tarball = join(releaseDir, "zcode-1.2.3.tar.gz");
  await exec("tar", ["-czf", tarball, "-C", directory, "zcode"]);
  const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
  await writeFile(
    join(downloads, "latest.json"),
    JSON.stringify({ version: "1.2.3", tarball: "zcode-1.2.3.tar.gz", sha256 }),
  );
  const installer = join(directory, "install.sh");
  await writeFile(installer, installScriptSource(`file://${downloads}/`));
  const installRoot = join(directory, "installed");
  const bin = join(directory, "bin");
  await exec("sh", [installer], {
    env: {
      ...process.env,
      ZCODE_DIST_BASE_URL: `file://${downloads}/`,
      ZCODE_DIST_HOME: installRoot,
      ZCODE_DIST_BIN_DIR: bin,
    },
  });
  await rm(root, { recursive: true });
  const result = await exec(join(bin, "zcode"), [], { cwd: directory });
  assert.deepEqual(JSON.parse(result.stdout).argv, []);
  const webHelp = await exec(join(bin, "zcode"), ["--web", "--help"]);
  assert.match(webHelp.stdout, /zcode --web/);
});
