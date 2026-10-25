import { ensureRuntime } from "../lib/runtime.mjs";

try {
  await ensureRuntime({ preferPackageRuntime: true });
} catch (error) {
  console.error(
    `ZCode installation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
