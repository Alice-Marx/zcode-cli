import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function npmChildEnvironment(env = process.env) {
  // npm run exports user config into env. npm 11.19 treats inherited allow-scripts
  // as a CLI-only policy and rejects project installs, even with --ignore-scripts.
  // Let the child read the original .npmrc policy instead; no user config changes.
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts"));
}

export function npmInvocation(args, env = process.env) {
  const candidates = [
    env.npm_execpath,
    resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  const entry = candidates.find((candidate) => candidate && /npm-cli\.(?:c?js)$/.test(candidate) && existsSync(candidate));
  if (entry) return { command: process.execPath, args: [entry, ...args] };
  if (process.platform !== "win32") return { command: "npm", args };
  throw new Error("Cannot locate npm-cli.js. Run this command through npm run.");
}
