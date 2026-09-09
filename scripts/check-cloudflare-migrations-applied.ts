#!/usr/bin/env node
/**
 * Migration guard: are all migration files on disk recorded as applied in the remote D1?
 *
 * Exists because a push to the production branch deploys the Worker without applying migrations.
 * An upstream sync lands new files under apps/worker/migrations as an ordinary commit, so new code
 * can reach production against an old schema and only the application's own errors would say so.
 *
 * Deliberately answers one question and fails closed. "I could not check" is reported as a failure,
 * never as a pass: a guard that exits zero when it could not look is worse than no guard, because
 * it reports that the call was made rather than that the thing is true.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(repoRoot, "apps/worker/migrations");
const configPath = resolve(repoRoot, process.env["CI_WRANGLER_CONFIG"] || "wrangler.jsonc");
const applyCommand = "pnpm cloudflare:migrations:apply";

/** Workers Builds shares one Build command between production and branch builds. */
const DEFAULT_PRODUCTION_BRANCH = "main";

export type GuardOutcome =
  | { kind: "applied"; count: number }
  | { kind: "pending"; pending: readonly string[]; appliedCount: number }
  | { kind: "unknown"; reason: string };

export interface GuardDecision {
  exitCode: number;
  lines: readonly string[];
}

export function readMigrationFileNames(directory = migrationsDir): string[] {
  return readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
}

export function evaluateMigrations(files: readonly string[], applied: readonly string[]): GuardOutcome {
  const appliedSet = new Set(applied);
  const pending = files.filter((name) => !appliedSet.has(name));
  if (pending.length > 0) return { kind: "pending", pending, appliedCount: appliedSet.size };
  return { kind: "applied", count: files.length };
}

/**
 * Strict on the production branch and anywhere the branch is unknown.
 *
 * A human running this by hand wants the real answer, so an absent WORKERS_CI_BRANCH means strict
 * rather than advisory. Other branches still print, because a warning that nobody sees is no
 * cheaper to ignore than one that fails the build.
 */
export function decideGuard(
  outcome: GuardOutcome,
  branch: string | undefined,
  productionBranch: string = DEFAULT_PRODUCTION_BRANCH,
): GuardDecision {
  const strict = branch === undefined || branch.trim() === "" || branch.trim() === productionBranch;
  const scope = strict ? "" : ` (branch ${branch}, not ${productionBranch}, so this does not fail the build)`;

  if (outcome.kind === "applied") {
    return { exitCode: 0, lines: [`All ${outcome.count} D1 migrations are recorded as applied.`] };
  }
  if (outcome.kind === "pending") {
    const lines = [
      `${outcome.pending.length} D1 migration(s) on disk are NOT applied to the remote database${scope}:`,
      ...outcome.pending.map((name) => `  - ${name}`),
      "",
      `Deploying this commit would run the new code against the old schema.`,
      `Apply them first with:  ${applyCommand}`,
    ];
    return { exitCode: strict ? 1 : 0, lines };
  }
  return {
    exitCode: strict ? 1 : 0,
    lines: [
      `Could not determine whether the D1 migrations are applied${scope}.`,
      `Reason: ${outcome.reason}`,
      "",
      "This is reported as a failure rather than a pass, because not knowing is not the same as",
      "everything being applied. Restore access to the remote database and run this again, or",
      `apply the migrations directly with:  ${applyCommand}`,
    ],
  };
}

/** Missing table means the database has never had a migration applied, which is a real answer. */
function isMissingMigrationsTable(output: string): boolean {
  return /no such table:\s*d1_migrations/i.test(output);
}

/**
 * Reads the applied set through `wrangler d1 execute`.
 *
 * Chosen over the repo's D1 REST client because that client requires CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_ACCOUNT_ID as explicit environment variables, while wrangler also accepts whatever
 * session the surrounding environment already provides. Chosen over `d1 migrations list` because
 * that subcommand has been observed returning an account authorization error on this account while
 * `d1 execute` against the same database succeeded.
 */
export function readAppliedMigrations(): { applied?: string[]; error?: string } {
  const result = spawnSync("pnpm", [
    "exec", "wrangler", "d1", "execute", "DB", "--remote", "--json",
    "--command", "SELECT name FROM d1_migrations ORDER BY id",
    "--config", configPath,
  ], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, CI: "1" } });

  const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
  if (isMissingMigrationsTable(output)) return { applied: [] };
  if (result.status !== 0) return { error: firstMeaningfulLine(output) || `wrangler exited with status ${result.status}` };

  try {
    const parsed = JSON.parse(extractJson(result.stdout)) as Array<{ results?: Array<{ name?: unknown }> }>;
    const rows = parsed[0]?.results;
    if (!Array.isArray(rows)) return { error: "wrangler returned no result set for d1_migrations" };
    const applied = rows.map((row) => row.name).filter((name): name is string => typeof name === "string");
    if (applied.length !== rows.length) return { error: "d1_migrations returned a row without a usable name" };
    return { applied };
  } catch (error) {
    return { error: `could not parse the wrangler response: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Wrangler prefixes its JSON with a banner on some versions; take from the first bracket. */
function extractJson(stdout: string): string {
  const start = stdout.indexOf("[");
  return start >= 0 ? stdout.slice(start) : stdout;
}

function firstMeaningfulLine(output: string): string {
  // Wrangler colours its errors; the escape codes make the reason unreadable in a build log.
  const plain = output.replace(/\u001B\[[0-9;]*m/g, "");
  const lines = plain.split("\n").map((line) => line.trim()).filter(Boolean);
  const meaningful = lines.find((line) => /error|failed|unauthorized|not authorized|denied|required/i.test(line));
  return (meaningful ?? lines[0] ?? "").replace(/\s+/g, " ").slice(0, 300);
}

export function runGuard(
  read: () => { applied?: string[]; error?: string } = readAppliedMigrations,
  files: () => string[] = readMigrationFileNames,
  branch: string | undefined = process.env["WORKERS_CI_BRANCH"],
): GuardDecision {
  let onDisk: string[];
  try {
    onDisk = files();
  } catch (error) {
    return decideGuard(
      { kind: "unknown", reason: `could not read ${migrationsDir}: ${error instanceof Error ? error.message : String(error)}` },
      branch,
    );
  }
  const result = read();
  if (result.error !== undefined || result.applied === undefined) {
    return decideGuard({ kind: "unknown", reason: result.error ?? "the remote migration list was unavailable" }, branch);
  }
  return decideGuard(evaluateMigrations(onDisk, result.applied), branch);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  const decision = runGuard();
  const write = decision.exitCode === 0 ? console.log : console.error;
  for (const line of decision.lines) write(line);
  process.exit(decision.exitCode);
}
