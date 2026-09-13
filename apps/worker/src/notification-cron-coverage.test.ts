// The cron interval lives in wrangler.jsonc and the notification window lives in the Worker source.
// They have to satisfy one condition, and if they stop satisfying it reminders simply stop arriving:
// no error, no log line, nobody notices until a renewal is missed. That is the one failure this
// project cannot afford in the part whose only job is to warn people in advance, so the condition is
// pinned here rather than left to whoever next edits either file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_CRON_WINDOW_MINUTES } from "./notification-jobs";
import { getLocalScheduleDecision, getNextLocalScheduleOccurrence } from "./notification-schedule";

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

const timezones = ["Europe/Madrid", "Pacific/Auckland"];

const cronIntervalMinutes = parseCronIntervalMinutes(readDeployedCronExpression());

describe("Cloudflare notification cron coverage", () => {
  it("keeps the cron interval to half the notification window at most", () => {
    // Cloudflare does not guarantee a cron trigger to the minute and delays it under load, so an
    // interval equal to the window would drop a reminder the first time a tick ran late. Half the
    // window is the margin that absorbs that.
    expect(cronIntervalMinutes * 2).toBeLessThanOrEqual(NOTIFICATION_CRON_WINDOW_MINUTES);
  });

  it.each(timezones)("lands a tick inside the window for every local target minute in %s", (timezone) => {
    // An interval wider than the window does not fail everywhere: a target minute that happens to
    // sit on the tick grid still fires. Sweeping every minute of the hour is what exposes the ones
    // that would be missed instead of the ones that got lucky.
    const missed = [];
    for (let minute = 0; minute < 60; minute += 1) {
      const localTime = `09:${String(minute).padStart(2, "0")}`;
      if (!firesWithinBand(timezone, localTime)) missed.push(localTime);
    }
    expect(missed).toEqual([]);
  });

  it("lands a tick inside the window across a whole day of ticks", () => {
    expect(dueTicksAcrossDay("Europe/Madrid", "09:17")).toBeGreaterThan(0);
  });

  it("lands a tick inside the window when the window crosses local midnight", () => {
    // A target late enough that its window runs into the next local day: the tick that catches it
    // reports a local date that has already rolled over, which is the case getLocalScheduleDecision
    // goes out of its way to check by also testing yesterday's occurrence.
    expect(dueTicksAcrossDay("Europe/Madrid", "23:59")).toBeGreaterThan(0);
  });
});

/** Counts the ticks a full UTC day of cron runs would spend inside the window for one local time. */
function dueTicksAcrossDay(timezone: string, localTime: string): number {
  const start = Date.UTC(2026, 2, 10, 0, 0, 0);
  let due = 0;
  for (let offset = 0; offset < DAY_MINUTES; offset += cronIntervalMinutes) {
    if (isDue(new Date(start + offset * MINUTE_MS), timezone, localTime)) due += 1;
  }
  return due;
}

/**
 * Walks the same tick grid, but only evaluates the ticks near the target instant.
 *
 * A reminder can only fire from a tick that lands between the target and the end of the window, and
 * any grid has a tick within one interval of the target, so a band of window plus interval either
 * side provably contains every tick that could ever fire. The band grows with the interval, so an
 * interval too wide to catch the target still reports a miss instead of running out of ticks to
 * look at. Skipping the rest is what keeps a sixty-minute sweep cheap enough to run on every commit.
 */
function firesWithinBand(timezone: string, localTime: string): boolean {
  const dayStart = Date.UTC(2026, 2, 10, 0, 0, 0);
  const target = Date.parse(getNextLocalScheduleOccurrence(new Date(dayStart), timezone, localTime).scheduledInstantUtc);
  const band = (NOTIFICATION_CRON_WINDOW_MINUTES + cronIntervalMinutes + 1) * MINUTE_MS;
  for (let offset = 0; offset < DAY_MINUTES * 2; offset += cronIntervalMinutes) {
    const tick = dayStart + offset * MINUTE_MS;
    if (tick < target - band || tick > target + band) continue;
    if (isDue(new Date(tick), timezone, localTime)) return true;
  }
  return false;
}

function isDue(now: Date, timezone: string, localTime: string): boolean {
  return getLocalScheduleDecision(now, timezone, localTime, NOTIFICATION_CRON_WINDOW_MINUTES, false).due;
}

function readDeployedCronExpression(): string {
  const path = fileURLToPath(new URL("../../../wrangler.jsonc", import.meta.url));
  const config = JSON.parse(readFileSync(path, "utf8")) as { triggers?: { crons?: unknown } };
  const crons = config.triggers?.crons;
  if (!Array.isArray(crons) || crons.length !== 1 || typeof crons[0] !== "string") {
    throw new Error("wrangler.jsonc must declare exactly one cron trigger for this guard to reason about it");
  }
  return crons[0];
}

/**
 * Reads the tick interval out of the deployed cron expression.
 *
 * Only the two shapes Renewlet has used are understood, every minute and every N minutes. Anything
 * else throws instead of guessing: a guard that quietly assumed the wrong interval would pass while
 * the real schedule missed its window, which is the exact failure it exists to prevent.
 */
function parseCronIntervalMinutes(expression: string): number {
  const [minute, ...rest] = expression.trim().split(/\s+/);
  if (rest.join(" ") !== "* * * *") {
    throw new Error(`Cron "${expression}" is not a plain minute schedule; teach this guard the new shape before changing it`);
  }
  if (minute === "*") return 1;
  const everyNMinutes = /^\*\/(\d+)$/.exec(minute ?? "");
  if (!everyNMinutes?.[1]) {
    throw new Error(`Cron "${expression}" is not a plain minute schedule; teach this guard the new shape before changing it`);
  }
  return Number.parseInt(everyNMinutes[1], 10);
}
