import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const BROWSER_OPEN_SETTLE_TIMEOUT_MS = 1_000;
const WINDOWS_BROWSER_OPEN_TIMEOUT_MS = 5_000;

export interface BrowserOpenResult {
  command: string;
  opened: boolean;
  reason?: string;
}

export interface BrowserOpenOptions {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
}

export async function openUrlInBrowser(
  url: string,
  options: BrowserOpenOptions = {},
): Promise<BrowserOpenResult> {
  const platform = options.platform ?? process.platform;
  const command = browserOpenCommand(platform, url);
  const spawnProcess = options.spawnProcess ?? spawn;

  try {
    const child = spawnProcess(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    return await waitForBrowserSpawn(
      child,
      command.executable,
      options.timeoutMs ??
        (platform === "win32" ? WINDOWS_BROWSER_OPEN_TIMEOUT_MS : BROWSER_OPEN_SETTLE_TIMEOUT_MS),
      platform === "win32",
    );
  } catch (error) {
    return {
      command: command.executable,
      opened: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { args: string[]; executable: string } {
  if (platform === "darwin") {
    return { executable: "open", args: [url] };
  }

  if (platform === "win32") {
    // cmd start 会把 OAuth URL 的 & 当成命令分隔符，导致 redirect/state 丢失。
    // 用字面量和 UTF-16 编码命令保留整条 URL；不让 %、引号或 Unicode 经 cmd 展开。
    const literalUrl = `'${url.replace(/'/g, "''")}'`;
    const script = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${literalUrl}`;
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    return {
      executable: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
    };
  }

  return { executable: "xdg-open", args: [url] };
}

function waitForBrowserSpawn(
  child: ChildProcess,
  command: string,
  timeoutMs = BROWSER_OPEN_SETTLE_TIMEOUT_MS,
  waitForExit = false,
): Promise<BrowserOpenResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const settle = (result: BrowserOpenResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners("error");
      child.removeAllListeners("spawn");
      child.removeAllListeners("close");
      // 启动器已独立运行；超时也不能让它继续阻止 CLI 取消或退出。
      child.unref();
      resolve(result);
    };
    timeout = setTimeout(() => {
      settle(
        waitForExit
          ? {
              command,
              opened: false,
              reason: "Timed out while opening the browser. Open the displayed URL manually.",
            }
          : { command, opened: true },
      );
    }, timeoutMs);

    child.once("spawn", () => {
      if (!waitForExit) settle({ command, opened: true });
    });
    child.once("close", (code) => {
      if (waitForExit)
        settle(
          code === 0
            ? { command, opened: true }
            : {
                command,
                opened: false,
                reason: `Browser launcher exited with code ${code ?? "unknown"}. Open the displayed URL manually.`,
              },
        );
    });
    child.once("error", (error) => {
      settle({
        command,
        opened: false,
        reason: error.message,
      });
    });
  });
}
