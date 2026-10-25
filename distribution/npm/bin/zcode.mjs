#!/usr/bin/env node
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureRuntime } from "../lib/runtime.mjs";

try {
  const runtimeRoot = await ensureRuntime();
  // 保留真实 TTY、所有原始参数；既有 runner 负责 --web 分流和 Agent 自启动入口。
  await import(pathToFileURL(join(runtimeRoot, "bin", "zcode.mjs")).href);
} catch (error) {
  console.error(`ZCode: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
