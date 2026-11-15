#!/usr/bin/env node
/**
 * Local Cloudflare Worker for the Playwright suite. Fork only.
 *
 * The suite upstream ships starts the Go server, and this fork's features (renewal reminders, the
 * renewal webhook setting, price change tracking) exist only in the Worker, so against Go the
 * suite tests a product this fork does not deploy. `RENEWLET_E2E_RUNTIME=cloudflare` makes
 * playwright.config.ts start this instead.
 *
 * Everything lives under .wrangler/e2e, which is already ignored. Wrangler keeps local D1 and R2
 * state next to the config file it is given, so a config written there gives every run an empty
 * database without touching the .wrangler/state that `pnpm dev:cloudflare` uses.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const e2eRoot = join(repoRoot, ".wrangler", "e2e");
const configPath = join(e2eRoot, "wrangler.jsonc");
const distIndex = join(repoRoot, "apps/web/dist/index.html");

function readOption(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value?.trim() || fallback;
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: repoRoot, env, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
}

function absolute(value, field) {
  if (typeof value !== "string" || !value) throw new Error(`wrangler.jsonc must set ${field}`);
  return resolve(repoRoot, value);
}

function writeE2EConfig() {
  const config = parse(readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8"));
  // Paths in a Wrangler config resolve from the config's own directory, which is no longer the
  // repository root.
  config.main = absolute(config.main, "main");
  config.assets.directory = absolute(config.assets?.directory, "assets.directory");
  for (const database of config.d1_databases ?? []) {
    database.migrations_dir = absolute(database.migrations_dir, "d1_databases[].migrations_dir");
  }
  delete config.$schema;
  // No test waits for a cron tick, and with crons configured wrangler dev prints a WARNING line,
  // which the server diagnostics reporter rightly counts as a failed run.
  delete config.triggers;
  rmSync(e2eRoot, { recursive: true, force: true });
  mkdirSync(e2eRoot, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

const port = readOption("port", "19090");
const ip = readOption("ip", "127.0.0.1");

// The Worker reads the built-in icon seed through its ASSETS binding and Wrangler refuses to start
// without the directory. Pages still come from Vite, so an existing build is good enough.
if (!existsSync(distIndex)) {
  run("pnpm", ["--filter", "@renewlet/client", "build"], { ...process.env, VITE_RENEWLET_RUNTIME: "cloudflare" });
}
writeE2EConfig();
run("node", ["scripts/apply-cloudflare-d1-migrations.mjs", "--local", "--config", configPath]);

const child = spawn("pnpm", ["exec", "wrangler", "dev", "--config", configPath, "--port", port, "--ip", ip], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 0;
});
