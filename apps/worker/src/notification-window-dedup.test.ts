// Widening the notification window means a target stays due across more than one cron tick, so the
// question this file has to answer before the window moves is whether a second tick can send the
// same thing twice. It runs the real 0001 and 0042 migrations against sqlite, because the answer
// rests on two unique keys and a string-only test cannot prove a unique key works.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationJob, getNotificationJob, NOTIFICATION_CRON_WINDOW_MINUTES } from "./notification-jobs";
import { getLocalScheduleDecision, scheduleOccurrence, type ScheduleOccurrence } from "./notification-schedule";
import { runRenewalRemindersForUser } from "./renewal-reminder-run";
import type { Env, SubscriptionRow } from "./types";

// The pair this PR moves to. Kept as literals rather than read from the source, so that these tests
// describe the schedule they were reasoned about instead of following the constant wherever it goes.
const WINDOW_MINUTES = 20;
const CRON_INTERVAL_MINUTES = 10;
const CURRENT_WINDOW_MINUTES = 2;
const CURRENT_CRON_INTERVAL_MINUTES = 1;

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;
const USER_ID = "usr_owner";

describe("how many cron ticks see one target as due", () => {
  it("reasons about the window the Worker actually ships", () => {
    // If the constant moves again, the duplicate-send analysis above stops describing the schedule
    // that runs, so it has to be redone rather than silently inherited.
    expect(NOTIFICATION_CRON_WINDOW_MINUTES).toBe(WINDOW_MINUTES);
  });

  it("reasons about the cron interval the deployment actually runs", () => {
    // Deliberately pinned to the literal expression, which notification-cron-coverage.test.ts
    // cannot do: that guard checks only the ratio, so a revert of wrangler.jsonc to "* * * * *"
    // would leave 1 * 2 <= 20 true and pass green while silently undoing the interval. An upstream
    // merge can revert that file, and this test lives only in the fork, so it cannot be merged away.
    const config = JSON.parse(readFileSync(fileURLToPath(new URL("../../../wrangler.jsonc", import.meta.url)), "utf8")) as {
      triggers?: { crons?: unknown };
    };

    expect(config.triggers?.crons).toEqual([`*/${CRON_INTERVAL_MINUTES} * * * *`]);
  });

  it("does not grow when the window and the interval are widened together", () => {
    // This is the whole safety argument for the change. Exposure to a repeated send is not set by
    // the width of the window, it is set by how many ticks fit inside it, which is the ratio of the
    // two numbers. The guard added in #10 holds that ratio at two, so widening the window while
    // scaling the interval with it leaves the number of duplicate chances exactly where it was.
    const before = dueTicks(CURRENT_WINDOW_MINUTES, CURRENT_CRON_INTERVAL_MINUTES, "09:00");
    const after = dueTicks(WINDOW_MINUTES, CRON_INTERVAL_MINUTES, "09:00");

    expect(before).toBe(3);
    expect(after).toBe(before);
  });
});

describe("the deduplication key across a widened window", () => {
  it("is identical for every tick that finds the target due", () => {
    // scheduled_local_date, scheduled_local_time and time_zone are the D1 unique key on
    // notification_jobs. They come from the target occurrence, never from the tick, which is why a
    // later tick lands on the row the first one wrote instead of writing a second.
    const keys = new Set(dueOccurrences(WINDOW_MINUTES, CRON_INTERVAL_MINUTES, "Europe/Madrid", "09:00").map(jobKey));

    expect(keys.size).toBe(1);
  });

  it("stays identical when the window runs past local midnight", () => {
    // The late ticks report a local date that has already rolled over. getLocalScheduleDecision
    // falls back to yesterday's occurrence for exactly this case, so the key must not move either.
    const occurrences = dueOccurrences(WINDOW_MINUTES, CRON_INTERVAL_MINUTES, "Europe/Madrid", "23:55");

    expect(occurrences.length).toBeGreaterThan(1);
    expect(new Set(occurrences.map(jobKey)).size).toBe(1);
    expect(occurrences[0]?.scheduledLocalTime).toBe("23:55");
  });
});

describe("the scheduler state already written to D1", () => {
  it("holds an instant that does not depend on the window it was written under", () => {
    // subscription_scheduler_state stores next_daily_notification_due_at_utc, and the gate that
    // reads it asks only whether it has passed. The value itself comes from the target occurrence,
    // which takes no window, so rows written under the old window stay correct under the new one
    // and nothing has to be recalculated or migrated.
    const tick = new Date(Date.UTC(2026, 2, 10, 8, 10, 0));

    const narrow = getLocalScheduleDecision(tick, "Europe/Madrid", "09:00", CURRENT_WINDOW_MINUTES, false);
    const wide = getLocalScheduleDecision(tick, "Europe/Madrid", "09:00", WINDOW_MINUTES, false);

    expect(wide.scheduledInstantUtc).toBe(narrow.scheduledInstantUtc);
    // The window changes only whether that instant counts as due right now, never the instant.
    expect(wide.due).toBe(true);
    expect(narrow.due).toBe(false);
  });
});

describe("notification_jobs against the real schema", () => {
  it("gives every tick in the window the same row instead of a second one", async () => {
    const { db, env } = openDatabase("0001_initial.sql");
    const occurrences = dueOccurrences(WINDOW_MINUTES, CRON_INTERVAL_MINUTES, "Europe/Madrid", "09:00");
    expect(occurrences.length).toBeGreaterThan(1);

    const first = await createNotificationJob(env, USER_ID, occurrences[0]!, "sent", 1);
    expect(first.created).toBe(true);

    for (const occurrence of occurrences.slice(1)) {
      // What the later ticks actually do: look the job up, find it terminal, and stop.
      const found = await getNotificationJob(env, USER_ID, occurrence);
      expect(found?.id).toBe(first.row?.id);
      // And if one ever tried to insert anyway, the unique key refuses it.
      expect((await createNotificationJob(env, USER_ID, occurrence, "sent", 1)).created).toBe(false);
    }

    expect(db.prepare("SELECT COUNT(*) AS n FROM notification_jobs").get()).toEqual({ n: 1 });
  });
});

describe("renewal reminders against the real schema", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends once across every tick of the window", async () => {
    // This path matters most. It runs before the notification job state machine in
    // runScheduledForUser, so nothing upstream stops a second tick reaching it; only its own key on
    // subscription_reminder_sends does.
    const { db, env } = openDatabase("0042_subscription_reminder_sends.sql", true);
    const occurrences = dueOccurrences(WINDOW_MINUTES, CRON_INTERVAL_MINUTES, "Europe/Madrid", "09:00");
    expect(occurrences.length).toBeGreaterThan(1);

    // Delivered over WhatsApp rather than the webhook: the webhook resolves its host through the
    // outbound URL policy, and a test that stubs fetch cannot answer that lookup honestly.
    const sender = { ...env, WHATSAPP_TOKEN: "EAAG-token", WHATSAPP_PHONE_NUMBER_ID: "123456789", WHATSAPP_API_BASE_URL: "https://graph.example.test/v23.0" } as Env;
    const settings = { renewalWebhookUrl: "", testPhone: "34600000000" };
    const results = [];
    for (const occurrence of occurrences) {
      results.push(await runRenewalRemindersForUser(sender, USER_ID, settings, occurrence.scheduledLocalDate, [subscriptionRow()], "en-US"));
    }

    expect(results[0]).toEqual({ sent: 1, failed: 0 });
    expect(results.slice(1).every((result) => result.sent === 0 && result.failed === 0)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Two rows for one message is correct: a subscription seven days out matches both the 30 and
    // the 7 window, and both are consumed so the wider one cannot fire again tomorrow. attempts
    // staying at 1 is the real proof here, because a second tick that got through would raise it.
    expect(db.prepare("SELECT reminder_window, status, attempts FROM subscription_reminder_sends ORDER BY reminder_window").all()).toEqual([
      { reminder_window: 7, status: "sent", attempts: 1 },
      { reminder_window: 30, status: "sent", attempts: 1 },
    ]);
  });
});

/** Every tick of a UTC day that a cron on this interval would spend inside the window. */
function dueOccurrences(windowMinutes: number, intervalMinutes: number, timezone: string, localTime: string): ScheduleOccurrence[] {
  const start = Date.UTC(2026, 2, 10, 0, 0, 0);
  const found: ScheduleOccurrence[] = [];
  for (let offset = 0; offset < DAY_MINUTES; offset += intervalMinutes) {
    const decision = getLocalScheduleDecision(new Date(start + offset * MINUTE_MS), timezone, localTime, windowMinutes, false);
    if (decision.due) found.push(decision);
  }
  return found;
}

function dueTicks(windowMinutes: number, intervalMinutes: number, localTime: string): number {
  return dueOccurrences(windowMinutes, intervalMinutes, "Europe/Madrid", localTime).length;
}

function jobKey(occurrence: ScheduleOccurrence): string {
  return [occurrence.scheduledLocalDate, occurrence.scheduledLocalTime, occurrence.timeZone].join("|");
}

function subscriptionRow(): SubscriptionRow {
  const target = scheduleOccurrence("2026-03-17", "09:00", "Europe/Madrid").scheduledLocalDate;
  return {
    id: "sub_adobe",
    user_id: USER_ID,
    name: "Adobe Creative Cloud",
    logo: null,
    price: "239.88",
    currency: "EUR",
    billing_cycle: "annual",
    custom_days: null,
    custom_cycle_unit: null,
    one_time_term_count: null,
    one_time_term_unit: null,
    category: "software",
    status: "active",
    pinned: 0,
    public_hidden: 0,
    payment_method: null,
    start_date: "2024-10-15",
    next_billing_date: target,
    auto_renew: 1,
    auto_calculate_next_billing_date: 1,
    trial_end_date: null,
    website: null,
    notes: null,
    tags_json: "[]",
    reminder_days: -1,
    repeat_reminder_enabled: 0,
    repeat_reminder_interval: "1h",
    repeat_reminder_window: "72h",
    cost_sharing_json: "{}",
    cost_sharing_collection_reminder_enabled: 0,
    cost_sharing_next_collection_reminder_date: null,
    extra_json: "{}",
    previous_price: null,
    previous_price_currency: null,
    previous_price_changed_at: null,
    created_at: "2024-10-15T00:00:00.000Z",
    updated_at: "2026-03-01T00:00:00.000Z",
  };
}

/**
 * Opens one migration against sqlite.
 *
 * 0042 references users and subscriptions, which 0001 owns; standing in a minimal parent table keeps
 * this to the one schema under test rather than the whole database.
 */
function openDatabase(migration: string, needsParents = false): { db: DatabaseSync; env: Env } {
  const db = new DatabaseSync(":memory:");
  if (needsParents) {
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY);");
    db.exec("CREATE TABLE subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);");
    db.exec(`INSERT INTO users (id) VALUES ('${USER_ID}');`);
    db.exec(`INSERT INTO subscriptions (id, user_id) VALUES ('sub_adobe', '${USER_ID}');`);
  }
  db.exec(readFileSync(resolve("migrations", migration), "utf8"));
  if (!needsParents) {
    db.prepare(`
      INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at)
      VALUES (?, 'owner@example.test', 'Owner', 'user', 'hash', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z')
    `).run(USER_ID);
  }
  return { db, env: { DB: new SqliteD1Database(db) as unknown as D1Database } as unknown as Env };
}

class SqliteD1Database {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): SqliteD1PreparedStatement {
    return new SqliteD1PreparedStatement(this.db, sql);
  }

  async batch(statements: SqliteD1PreparedStatement[]): Promise<unknown[]> {
    return statements.map((statement) => statement.runSync());
  }
}

class SqliteD1PreparedStatement {
  private values: SQLInputValue[] = [];

  constructor(private readonly db: DatabaseSync, private readonly sql: string) {}

  bind(...values: SQLInputValue[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return this.runSync();
  }

  runSync(): { meta: { changes: number } } {
    const result = this.db.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}
