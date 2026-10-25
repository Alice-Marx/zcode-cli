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
import { fileURLToPath, pathToFileURL } from "node:url";

const exec = promisify(execFile);
const isWindows = process.platform === "win32";
if (process.argv[2] === "--worker") {
  await smoke(process.argv[3], await realpath(process.argv[4]));
  // finally 已验证运行进程全部结束；专用 worker 正常退出以释放 ConPTY 原生线程和 DLL。
  await new Promise((done) => process.stdout.write("", done));
  process.exit(0);
} else {
  await runWorker(process.argv[2]);
}

async function runWorker(archive) {
  assert.ok(archive, "Usage: node scripts/zcode-distribution-smoke.mjs <archive.tar.gz>");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-release-smoke-")));
  // Windows 不能删除当前进程加载过的 .node DLL。只有 worker 加载发行包 node-pty；
  // 外层等待 worker 完全退出，再删除整个临时发行目录。
  const worker = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--worker", resolve(archive), directory],
    {
      stdio: "inherit",
      detached: !isWindows,
    },
  );
  const closed = once(worker, "close");
  let timer;
  try {
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Distribution smoke worker timed out")), 120000);
      }),
    ]);
    assert.deepEqual(result, [0, null], "Distribution smoke worker failed");
  } finally {
    clearTimeout(timer);
    if (Number.isInteger(worker.pid) && isRunning(worker.pid)) {
      const pids = await snapshotProcessTree(worker.pid);
      if (isWindows) {
        await exec("taskkill.exe", ["/PID", String(worker.pid), "/T", "/F"], { timeout: 10000 });
      } else {
        for (const pid of pids.reverse()) {
          if (isRunning(pid)) process.kill(pid, "SIGKILL");
        }
      }
      await closed;
    }
    // 删除失败必须让整体退出失败，不把 DLL 锁或残留目录视作通过。
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(JSON.stringify({ cleanup: "worker exited and temporary release directory removed" }));
}

async function smoke(archive, directory) {
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
  let smokeFailed = false;
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
    const tuiObserver = await observeWindowsExit(terminal.pid);
    // 真实键盘退出链路：不发送 prompt，不调用模型。
    terminal.write("\u0003");
    await delay(200);
    if (!terminal.finished()) terminal.write("\u0003");
    const tuiExit = await deadline(terminal.exited, 8000, "TUI keyboard exit");
    const tuiExitCode = await assertKeyboardExit(tuiExit, terminal, tuiObserver);
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
    let webExitCode;
    if (isWindows) {
      const webObserver = await observeWindowsExit(web.pid);
      // Windows kill(SIGTERM) 是强杀，不能触发 runner 的 signal handler；用真实 ConPTY Ctrl+C。
      web.write("\u0003");
      webExitCode = await assertKeyboardExit(
        await deadline(web.exited, 8000, "Web keyboard exit"),
        web,
        webObserver,
      );
    } else {
      web.stop();
      assert.deepEqual(await deadline(web.exited, 8000, "Web SIGTERM exit"), [0, null]);
      webExitCode = 0;
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
    console.log(
      JSON.stringify({
        version,
        platform: process.platform,
        arch: process.arch,
        exitCodes: { tui: tuiExitCode, web: webExitCode },
        tuiNativeExitEvent: tuiExit,
        tui: "native PTY spawn, initialized render, keyboard exit, process cleanup passed",
        web: `HTML, server-info, workspace, WebSocket, ${isWindows ? "ConPTY Ctrl+C" : "SIGTERM"} shutdown, process cleanup passed`,
        isolated: true,
      }),
    );
  } catch (error) {
    smokeError = error;
    smokeFailed = true;
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
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      if (smokeFailed) console.error("Additional smoke cleanup errors:", cleanupErrors);
      else {
        smokeError = new AggregateError(cleanupErrors, "Smoke cleanup failed");
        smokeFailed = true;
      }
    }
  }
  if (smokeFailed) throw smokeError;

  function startPty(pty, args) {
    const child = pty.spawn(process.execPath, [runner, ...args], {
      cwd: workspace,
      env,
      cols: 110,
      rows: 32,
    });
    trackedPids.add(child.pid);
    if (!isWindows) processGroups.add(child.pid);
    let output = "";
    let finished = false;
    child.onData((data) => {
      output += data;
    });
    const exited = new Promise((done) =>
      child.onExit((event) => {
        finished = true;
        done(event);
      }),
    );
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
      cwd: workspace,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackedPids.add(child.pid);
    processGroups.add(child.pid);
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    return {
      pid: child.pid,
      output: () => output,
      finished: () => child.exitCode !== null || child.signalCode !== null,
      stop: () => child.kill("SIGTERM"),
      exited: once(child, "exit"),
    };
  }

  async function assertKeyboardExit(event, handle, observer) {
    const code = observer
      ? await deadline(observer.result, 5000, "Windows exit-code observer")
      : event.exitCode;
    if (event.exitCode !== undefined) assert.equal(event.exitCode, code);
    // ConPTY 可将成功的 Ctrl+C 退出报告为 128；后续仍独立检查所有已观测进程和 Web 端口已关闭。
    assert.ok(
      code === 0 || (isWindows && code === 128),
      `Unexpected keyboard exit ${JSON.stringify({ native: event, osExitCode: code })}:\n${stripVTControlCharacters(handle.output())}`,
    );
    return code;
  }

  async function observeWindowsExit(pid) {
    if (!isWindows) return undefined;
    // ConPTY socket close 可早于 node-pty 的 exitCode 回调。先打开真实进程句柄，
    // 再发送 Ctrl+C；由 Windows WaitForExit 获取退出码，不把 undefined 当成功。
    const watcher = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$watched = [Diagnostics.Process]::GetProcessById(${pid}); $null = $watched.Handle; [Console]::Out.WriteLine('watching'); if (-not $watched.WaitForExit(15000)) { throw 'Process exit observer timed out' }; [Console]::Out.WriteLine($watched.ExitCode)`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    trackedPids.add(watcher.pid);
    let output = "";
    let errors = "";
    watcher.stdout.on("data", (chunk) => {
      output += chunk;
    });
    watcher.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const result = once(watcher, "close").then(([code, signal]) => {
      assert.deepEqual([code, signal], [0, null], `Windows exit observer failed: ${errors}`);
      const exitCode = Number(output.trim().split(/\r?\n/).at(-1));
      assert.ok(Number.isInteger(exitCode), `Invalid Windows exit code: ${output}`);
      return exitCode;
    });
    // 在等待 ready 或 TUI 关闭失败时，finally 仍负责结束此观察进程。
    result.catch(() => {});
    await until(
      () => output.includes("watching"),
      "Windows process handle acquired",
      () => errors,
      5000,
    );
    return { result };
  }

  async function rememberTree(pid) {
    const pids = await snapshotProcessTree(pid);
    for (const candidate of pids) trackedPids.add(candidate);
    return pids;
  }

  async function assertProcessesExited(pids, label) {
    await until(
      () => pids.every((pid) => !isRunning(pid)),
      label,
      () => `Still running PIDs: ${pids.filter(isRunning).join(", ")}`,
      5000,
    );
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

async function snapshotProcessTree(pid) {
  if (!isRunning(pid)) return [];
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
  const descendants = new Set([pid]);
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
