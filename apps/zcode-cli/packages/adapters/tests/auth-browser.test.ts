import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { openUrlInBrowser } from "../src/auth/browser.js";

const AUTHORIZE_URL =
  "https://bigmodel.cn/login?appId=zcode&redirect=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fbigmodel&state=local-test-only";

function fakeSpawn(event: "success" | "failure" | "error" | "timeout" = "success") {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const launch = vi.fn<typeof spawn>(() => {
    queueMicrotask(() => {
      if (event === "error") child.emit("error", new Error("launcher unavailable"));
      else {
        child.emit("spawn");
        if (event !== "timeout") child.emit("close", event === "success" ? 0 : 1);
      }
    });
    return child as unknown as ChildProcess;
  });
  return { child, launch };
}

describe("browser URL handoff", () => {
  it.each([
    AUTHORIZE_URL,
    "https://example.test/中文?q=%PATH%&name=O'Brien&literal=`$value\"#frag",
  ])("preserves every Windows URL field as a PowerShell literal: %s", async (url) => {
    const { launch } = fakeSpawn();
    expect((await openUrlInBrowser(url, { platform: "win32", spawnProcess: launch })).opened).toBe(
      true,
    );
    const [executable, args] = launch.mock.calls[0]!;
    expect(String(executable)).toMatch(/WindowsPowerShell.*powershell\.exe$/);
    expect(args?.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(Buffer.from(String(args?.[4]), "base64").toString("utf16le")).toBe(
      `$ErrorActionPreference = 'Stop'; Start-Process -FilePath '${url.replace(/'/g, "''")}'`,
    );
  });

  it.each(["failure", "error", "timeout"] as const)(
    "reports a Windows launcher %s",
    async (event) => {
      const { launch, child } = fakeSpawn(event);
      const result = await openUrlInBrowser(AUTHORIZE_URL, {
        platform: "win32",
        spawnProcess: launch,
        timeoutMs: 10,
      });
      expect(result.opened).toBe(false);
      expect(result.reason).toBeTruthy();
      expect(child.unref).toHaveBeenCalledOnce();
    },
  );

  it("does not call a Windows spawn event a successful handoff", async () => {
    const { launch, child } = fakeSpawn("timeout");
    let resolved = false;
    const result = openUrlInBrowser(AUTHORIZE_URL, {
      platform: "win32",
      spawnProcess: launch,
    }).then((value) => {
      resolved = true;
      return value;
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(resolved).toBe(false);
    child.emit("close", 0);
    expect((await result).opened).toBe(true);
  });

  it.each([
    ["darwin", "open"],
    ["linux", "xdg-open"],
  ] as const)("keeps the %s URL argument intact", async (platform, executable) => {
    const { launch } = fakeSpawn();
    expect((await openUrlInBrowser(AUTHORIZE_URL, { platform, spawnProcess: launch })).opened).toBe(
      true,
    );
    expect(launch.mock.calls[0]?.slice(0, 2)).toEqual([executable, [AUTHORIZE_URL]]);
  });

  it.runIf(process.platform === "win32")(
    "passes the full URL through the real Windows PowerShell parser without browser/account side effects",
    async () => {
      const url =
        "https://example.test/中文?appId=zcode&redirect=https%3A%2F%2Fexample.test%2Fcb&state=test-only&name=O'Brien&var=%PATH%";
      let received = "";
      const launch: typeof spawn = ((file: string, args: string[]) => {
        const script = Buffer.from(args[4]!, "base64").toString("utf16le");
        // 仅替换 OS 浏览器启动的副作用，真实执行相同 PowerShell 参数解析与 URL 字面量。
        const capture =
          "function Start-Process { param([string]$FilePath); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write($FilePath) }; ";
        const actual = spawn(
          file,
          [...args.slice(0, 4), Buffer.from(capture + script, "utf16le").toString("base64")],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        actual.stdout!.setEncoding("utf8");
        actual.stdout!.on("data", (data) => {
          received += data;
        });
        return actual;
      }) as typeof spawn;
      expect(
        (await openUrlInBrowser(url, { platform: "win32", spawnProcess: launch })).opened,
      ).toBe(true);
      expect(received).toBe(url);
      const parsed = new URL(received);
      expect(parsed.searchParams.get("redirect")).toBe("https://example.test/cb");
      expect(parsed.searchParams.get("state")).toBe("test-only");
    },
  );
});
