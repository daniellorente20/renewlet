import assert from "node:assert/strict";
import test from "node:test";
import { decideGuard, evaluateMigrations, runGuard } from "./check-cloudflare-migrations-applied";

const FILES = ["0001_initial.sql", "0041_subscription_previous_price.sql", "0042_subscription_reminder_sends.sql"];
const ALL_APPLIED = () => ({ applied: [...FILES] });
const ONE_PENDING = () => ({ applied: FILES.slice(0, 2) });
const CANNOT_LOOK = () => ({ error: "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required" });
const files = () => [...FILES];

test("everything applied passes and says so", () => {
  const decision = runGuard(ALL_APPLIED, files, "main");
  assert.equal(decision.exitCode, 0);
  assert.match(decision.lines.join("\n"), /All 3 D1 migrations are recorded as applied/);
});

test("a pending migration fails on the production branch and names the file", () => {
  const decision = runGuard(ONE_PENDING, files, "main");
  assert.equal(decision.exitCode, 1);
  const output = decision.lines.join("\n");
  assert.match(output, /0042_subscription_reminder_sends\.sql/);
  assert.doesNotMatch(output, /0041_subscription_previous_price\.sql/);
  // The message has to say what to do about it, not only what is wrong.
  assert.match(output, /pnpm cloudflare:migrations:apply/);
});

test("a pending migration only warns on another branch", () => {
  const decision = runGuard(ONE_PENDING, files, "feat/something");
  assert.equal(decision.exitCode, 0);
  const output = decision.lines.join("\n");
  assert.match(output, /0042_subscription_reminder_sends\.sql/);
  assert.match(output, /does not fail the build/);
});

test("missing credentials fail on the production branch rather than passing", () => {
  // The whole point of the guard: not knowing must never be reported as everything being applied.
  const decision = runGuard(CANNOT_LOOK, files, "main");
  assert.equal(decision.exitCode, 1);
  const output = decision.lines.join("\n");
  assert.match(output, /Could not determine/);
  assert.match(output, /CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(output, /All \d+ D1 migrations are recorded/);
});

test("a D1 error fails on the production branch", () => {
  const decision = runGuard(() => ({ error: "The given account is not valid or is not authorized [code: 7403]" }), files, "main");
  assert.equal(decision.exitCode, 1);
  assert.match(decision.lines.join("\n"), /7403/);
});

test("an unknown answer only warns on another branch", () => {
  const decision = runGuard(CANNOT_LOOK, files, "feat/something");
  assert.equal(decision.exitCode, 0);
  assert.match(decision.lines.join("\n"), /Could not determine/);
});

test("an absent branch is treated as strict, because a human wants the real answer", () => {
  assert.equal(runGuard(ONE_PENDING, files, undefined).exitCode, 1);
  assert.equal(runGuard(CANNOT_LOOK, files, "").exitCode, 1);
  assert.equal(runGuard(CANNOT_LOOK, files, "   ").exitCode, 1);
});

test("a directory it cannot read is unknown, not empty", () => {
  const decision = runGuard(ALL_APPLIED, () => { throw new Error("ENOENT: no such directory"); }, "main");
  assert.equal(decision.exitCode, 1);
  assert.match(decision.lines.join("\n"), /Could not determine/);
  assert.match(decision.lines.join("\n"), /ENOENT/);
});

test("a reader returning neither applied nor error is unknown, not a pass", () => {
  // Guards against a future refactor quietly returning an empty object.
  const decision = runGuard(() => ({}), files, "main");
  assert.equal(decision.exitCode, 1);
  assert.match(decision.lines.join("\n"), /Could not determine/);
});

test("a database with no migrations at all reports every file as pending", () => {
  const decision = runGuard(() => ({ applied: [] }), files, "main");
  assert.equal(decision.exitCode, 1);
  for (const name of FILES) assert.match(decision.lines.join("\n"), new RegExp(name.replace(/\./g, "\\.")));
});

test("extra migrations in the database do not fail the guard", () => {
  // The question is whether the files on disk are applied, not whether the database has more.
  const decision = evaluateMigrations(FILES, [...FILES, "0043_from_a_newer_checkout.sql"]);
  assert.equal(decision.kind, "applied");
});

test("the production branch name is configurable", () => {
  assert.equal(decideGuard({ kind: "pending", pending: ["x.sql"], appliedCount: 0 }, "release", "release").exitCode, 1);
  assert.equal(decideGuard({ kind: "pending", pending: ["x.sql"], appliedCount: 0 }, "release", "main").exitCode, 0);
});
