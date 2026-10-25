// 在仓库外验证发行包，避免开发机 node_modules 掩盖缺失的 TUI/native/worker 依赖。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify, stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const isWindows = process.platform === "win32";
const archive = process.argv[2];
assert.ok(archive, "Usage: node scripts/zcode-distribution-smoke.mjs <archive.tar.gz>");
const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-release-smoke-")));
const root = join(directory, "zcode");
const runner = join(root, "bin/zcode.mjs");
const workspace = join(directory, "workspace");
const env = {
  ...process.env,
  ZCODE_DATA_BASE_DIR: join(directory, "data"),
  NODE_PATH: "",
  NODE_OPTIONS: "",
  TERM: "xterm-256color",
};
const trackedPids = new Set();
const processGroups = new Set();
let socket;
let terminal;
let web;
let smokeError;
try {
  await exec("tar", ["-xzf", resolve(archive), "-C", directory]);
  await mkdir(workspace);
  await exec(process.execPath, [runner, "--help"], { cwd: workspace, env, timeout: 20000 });
  const version = (
    await exec(process.execPath, [runner, "--version"], { cwd: workspace, env, timeout: 20000 })
  ).stdout.trim();
  const require = createRequire(join(root, "package.json"));
  // 加载并实际 spawn，不能仅凭 require 成功宣称 Windows ConPTY 可运行。
  const pty = require("node-pty");
  const runtimeCheck = join(root, "agent/check-tui.mjs");
  await writeFile(
    runtimeCheck,
    'import { runTui } from "@zcode/tui"; if (typeof runTui !== "function") throw new Error("Missing TUI export"); console.log("tui-runtime-ok");',
  );
  const imported = await exec(process.execPath, [runtimeCheck], {
    cwd: workspace,
    env,
    timeout: 20000,
  });
  assert.match(imported.stdout, /tui-runtime-ok/);

  terminal = startPty(pty, []);
  await until(
    () => {
      const visible = stripVTControlCharacters(terminal.output());
      if (terminal.finished()) throw new Error(`TUI exited before rendering:\n${visible}`);
      // 渲染器可在相邻字符之间插入控制序列；匹配可见文本，而非原始 PTY 字节。
      return /ZCode/.test(visible) && /(?:登录|\/login|输入提示词|Type a prompt)/i.test(visible);
    },
    "TUI initialized render",
    () => stripVTControlCharacters(terminal.output()),
  );
  assert.doesNotMatch(terminal.output(), /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/);
  const tuiPids = await rememberTree(terminal.pid);
  // 真实键盘退出链路：不发送 prompt，不调用模型。
  terminal.write("\u0003");
  await delay(200);
  if (!terminal.finished()) terminal.write("\u0003");
  const tuiExit = await deadline(terminal.exited, 8000, "TUI keyboard exit");
  assertKeyboardExit(tuiExit, terminal.output());
  await assertProcessesExited(tuiPids, "TUI process tree");

  web = isWindows
    ? startPty(pty, ["--web", "--workspace", workspace, "--no-open"])
    : startChild(["--web", "--workspace", workspace, "--no-open"]);
  let base;
  await until(
    () => {
      if (web.finished()) throw new Error(`Web runner exited during startup:\n${web.output()}`);
      base = stripVTControlCharacters(web.output()).match(
        /Local:\s+(http:\/\/127\.0\.0\.1:\d+\/)/,
      )?.[1];
      return Boolean(base);
    },
    "Web URL",
    () => web.output(),
  );
  let info;
  await until(
    async () => {
      try {
        const response = await fetch(new URL("api/server-info", base), {
          signal: AbortSignal.timeout(1000),
        });
        if (!response.ok) return false;
        info = await response.json();
        return true;
      } catch {
        return false;
      }
    },
    "Web readiness",
    () => web.output(),
  );
  assert.equal(info.workspaces[0].path, workspace);
  const html = await fetch(base, { signal: AbortSignal.timeout(5000) });
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<html/i);
  const { default: WebSocket } = await import(pathToFileURL(require.resolve("ws")).href);
  socket = new WebSocket(new URL("ws", base.replace("http:", "ws:")));
  await deadline(once(socket, "open"), 5000, "WebSocket open");
  const socketClosed = once(socket, "close");
  socket.close();
  await deadline(socketClosed, 5000, "WebSocket close");
  socket = undefined;

  const webPids = await rememberTree(web.pid);
  if (isWindows) {
    // Windows kill(SIGTERM) 是强杀，不能触发 runner 的 signal handler；用真实 ConPTY Ctrl+C。
    web.write("\u0003");
    assertKeyboardExit(await deadline(web.exited, 8000, "Web keyboard exit"), web.output());
  } else {
    web.stop();
    assert.deepEqual(await deadline(web.exited, 8000, "Web SIGTERM exit"), [0, null]);
  }
  await assertProcessesExited(webPids, "Web process tree");
  await until(
    async () => {
      try {
        await fetch(base, { signal: AbortSignal.timeout(500) });
        return false;
      } catch {
        return true;
      }
    },
    "Web listening socket closed",
    () => web.output(),
  );
  console.log(JSON.stringify({
    version,
    platform: process.platform,
    arch: process.arch,
    tui: "native PTY spawn, initialized render, keyboard exit, process cleanup passed",
    web: `HTML, server-info, workspace, WebSocket, ${isWindows ? "ConPTY Ctrl+C" : "SIGTERM"} shutdown, process cleanup passed`,
    isolated: true,
  }));
} catch (error) {
  smokeError = error;
  throw error;
} finally {
  socket?.terminate();
  const cleanupErrors = [];
  // 先记录仍活着的后代；只杀父进程会在 Windows 留下后端并锁住临时发行目录。
  for (const handle of [terminal, web]) {
    if (!handle) continue;
    try {
      await rememberTree(handle.pid);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const pid of processGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") cleanupErrors.push(error);
    }
  }
  for (const pid of trackedPids) {
    if (!isRunning(pid)) continue;
    try {
      if (isWindows) {
        await exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 10000 });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch (error) {
      if (isRunning(pid)) cleanupErrors.push(error);
    }
  }
  try {
    await assertProcessesExited([...trackedPids], "Smoke cleanup");
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length) {
    if (smokeError) console.error("Additional smoke cleanup errors:", cleanupErrors);
    else throw new AggregateError(cleanupErrors, "Smoke cleanup failed");
  }
}

function startPty(pty, args) {
  const child = pty.spawn(process.execPath, [runner, ...args], {
    cwd: workspace, env, cols: 110, rows: 32,
  });
  trackedPids.add(child.pid);
  if (!isWindows) processGroups.add(child.pid);
  let output = "";
  let finished = false;
  child.onData((data) => { output += data; });
  const exited = new Promise((done) => child.onExit((event) => {
    finished = true;
    done(event);
  }));
  return {
    pid: child.pid,
    output: () => output,
    finished: () => finished,
    write: (data) => child.write(data),
    exited,
  };
}

function startChild(args) {
  const child = spawn(process.execPath, [runner, ...args], {
    cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  trackedPids.add(child.pid);
  processGroups.add(child.pid);
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  return {
    pid: child.pid,
    output: () => output,
    finished: () => child.exitCode !== null || child.signalCode !== null,
    stop: () => child.kill("SIGTERM"),
    exited: once(child, "exit"),
  };
}

function assertKeyboardExit(event, output) {
  // ConPTY 可将成功的 Ctrl+C 退出报告为 128；后续仍独立检查所有已观测进程和 Web 端口已关闭。
  assert.ok(event.exitCode === 0 || (isWindows && event.exitCode === 128),
    `Unexpected keyboard exit ${JSON.stringify(event)}:\n${stripVTControlCharacters(output)}`);
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

async function rememberTree(pid) {
  if (!isRunning(pid)) return [];
  const { stdout } = isWindows
    ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"],
      { timeout: 10000 })
    : await exec("ps", ["-eo", "pid=,ppid="], { timeout: 10000 });
  const rows = isWindows
    ? JSON.parse(stdout).map((row) => [row.ProcessId, row.ParentProcessId])
    : stdout.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number));
  const descendants = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [candidate, parent] of rows) {
      if (descendants.has(parent) && !descendants.has(candidate)) {
        descendants.add(candidate);
        changed = true;
      }
    }
  }
  for (const candidate of descendants) trackedPids.add(candidate);
  return [...descendants];
}

async function assertProcessesExited(pids, label) {
  await until(() => pids.every((pid) => !isRunning(pid)), label,
    () => `Still running PIDs: ${pids.filter(isRunning).join(", ")}`, 5000);
}

function deadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function until(check, label, diagnostic, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`${label} timed out:\n${diagnostic()}`);
}
