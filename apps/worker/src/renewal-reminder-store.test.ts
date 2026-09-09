// Runs the real 0042 migration against sqlite; a string-only test cannot prove the dedup key works.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSendableRenewalEvent } from "./notification-renewal-webhook";
import { renewalReminderFor } from "./renewal-reminders";
import { runRenewalRemindersForUser } from "./renewal-reminder-run";
import { listRenewalReminderFailures, loadConsumedWindows, planRenewalReminders, recordRenewalReminderFailure, recordRenewalReminderSent } from "./renewal-reminder-store";
import type { Env, SubscriptionRow } from "./types";

const USER_ID = "usr_owner";

function annual(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
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
    next_billing_date: "2026-10-15",
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
    previous_price: "199",
    previous_price_currency: "EUR",
    previous_price_changed_at: "2026-08-01T00:00:00.000Z",
    created_at: "2024-10-15T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function openDatabase(): { db: DatabaseSync; env: Env } {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY);");
  db.exec("CREATE TABLE subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);");
  db.exec(`INSERT INTO users (id) VALUES ('${USER_ID}');`);
  db.exec(`INSERT INTO subscriptions (id, user_id) VALUES ('sub_adobe', '${USER_ID}');`);
  db.exec(readFileSync(resolve("migrations", "0042_subscription_reminder_sends.sql"), "utf8"));
  return { db, env: { DB: new SqliteD1Database(db) as unknown as D1Database } as unknown as Env };
}

describe("renewal reminder send records", () => {
  it("consumes every matching window so the wider one cannot fire tomorrow", async () => {
    const { db, env } = openDatabase();
    const row = annual();
    // Three days out: both the 30 and the 7 window match and neither has a record yet.
    const decision = renewalReminderFor("2026-10-12", row, () => false);
    expect(decision?.consumedWindows).toEqual([7, 30]);

    await recordRenewalReminderSent(env, USER_ID, decision!);
    expect(db.prepare("SELECT reminder_window, status FROM subscription_reminder_sends ORDER BY reminder_window").all())
      .toEqual([{ reminder_window: 7, status: "sent" }, { reminder_window: 30, status: "sent" }]);

    expect(await planRenewalReminders(env, USER_ID, "2026-10-13", [row])).toEqual([]);
  });

  it("resets by itself once the cycle rolls to a new billing date", async () => {
    const { env } = openDatabase();
    const thisCycle = annual();
    await recordRenewalReminderSent(env, USER_ID, renewalReminderFor("2026-09-15", thisCycle, () => false)!);
    expect(await planRenewalReminders(env, USER_ID, "2026-09-16", [thisCycle])).toEqual([]);

    // Same subscription, next year. The old rows are keyed to the old target_date and must not
    // suppress this one, which is the whole reason target_date is in the primary key.
    const nextCycle = annual({ next_billing_date: "2027-10-15" });
    const planned = await planRenewalReminders(env, USER_ID, "2027-09-15", [nextCycle]);
    expect(planned.map((decision) => decision.firedWindow)).toEqual([30]);
  });

  it("survives a retry that re-records a window it already wrote", async () => {
    const { db, env } = openDatabase();
    const decision = renewalReminderFor("2026-09-15", annual(), () => false)!;
    await recordRenewalReminderSent(env, USER_ID, decision);
    await recordRenewalReminderSent(env, USER_ID, decision);
    expect(db.prepare("SELECT COUNT(*) AS total FROM subscription_reminder_sends").get()).toEqual({ total: 1 });
    expect(db.prepare("SELECT attempts FROM subscription_reminder_sends").get()).toEqual({ attempts: 2 });
  });

  it("reads nothing and touches no query when there are no subscriptions", async () => {
    const { env } = openDatabase();
    expect(await loadConsumedWindows(env, USER_ID, [])).toEqual(new Set());
  });

  it("records a failure without swallowing the warning it failed to deliver", async () => {
    const { db, env } = openDatabase();
    const row = annual();
    const decision = renewalReminderFor("2026-09-15", row, () => false)!;

    await recordRenewalReminderFailure(env, USER_ID, decision, new Error("Webhook returned 503"));
    expect(db.prepare("SELECT status, attempts, last_error, sent_at FROM subscription_reminder_sends").get()).toEqual({
      status: "failed",
      attempts: 1,
      last_error: "Webhook returned 503",
      sent_at: null,
    });

    // A failed row must not dedup, or a broken endpoint would cancel the warning instead of
    // delaying it. Tomorrow's run plans the same window again.
    const retry = await planRenewalReminders(env, USER_ID, "2026-09-16", [row]);
    expect(retry.map((planned) => planned.firedWindow)).toEqual([30]);

    await recordRenewalReminderSent(env, USER_ID, retry[0]!);
    expect(db.prepare("SELECT status, attempts, last_error FROM subscription_reminder_sends").get()).toEqual({
      status: "sent",
      attempts: 2,
      last_error: null,
    });
    expect(await planRenewalReminders(env, USER_ID, "2026-09-17", [row])).toEqual([]);
  });

  it("surfaces failures without needing wrangler tail", async () => {
    const { env } = openDatabase();
    const decision = renewalReminderFor("2026-09-15", annual(), () => false)!;
    await recordRenewalReminderFailure(env, USER_ID, decision, new Error("x".repeat(500)));
    const [failure] = await listRenewalReminderFailures(env, USER_ID);
    expect(failure?.subscription_id).toBe("sub_adobe");
    expect(failure?.reminder_window).toBe(30);
    // Errors are capped so an upstream HTML error page cannot fill the row.
    expect(failure?.last_error).toHaveLength(300);
  });

  it("records only the window that produced the message when the send fails", async () => {
    const { db, env } = openDatabase();
    // Three days out, both windows match, but nothing reached anyone.
    const decision = renewalReminderFor("2026-10-12", annual(), () => false)!;
    expect(decision.consumedWindows).toEqual([7, 30]);
    await recordRenewalReminderFailure(env, USER_ID, decision, new Error("timeout"));
    expect(db.prepare("SELECT reminder_window FROM subscription_reminder_sends").all()).toEqual([{ reminder_window: 7 }]);
  });

  it("produces a payload the outbound validation accepts, parentheses included", async () => {
    const { env } = openDatabase();
    const monthly = annual({
      billing_cycle: "monthly",
      price: "10.99",
      previous_price: "8.99",
      next_billing_date: "2026-09-13",
      start_date: "2025-01-13",
      previous_price_changed_at: "2026-08-20T00:00:00.000Z",
    });
    const [planned] = await planRenewalReminders(env, USER_ID, "2026-09-08", [monthly]);
    expect(planned?.event.amount).toBe("10,99 EUR (sube desde 8,99 EUR)");
    // The parenthesised amount must clear the empty-field and whitespace checks unchanged.
    expect(assertSendableRenewalEvent(planned!.event)).toEqual(planned!.event);
  });
});

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

const TOKEN = "EAAG-super-secret-token-value";

function whatsappEnv(env: Env): Env {
  return {
    ...env,
    WHATSAPP_TOKEN: TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: "123456789",
    WHATSAPP_API_BASE_URL: "https://graph.example.test/v23.0",
  } as Env;
}

const SETTINGS = { renewalWebhookUrl: "", testPhone: "34600000000" };

describe("renewal reminders end to end through the WhatsApp sender", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records a delivery as sent, and a second pass sends nothing", async () => {
    const { db, env } = openDatabase();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }));

    const first = await runRenewalRemindersForUser(whatsappEnv(env), USER_ID, SETTINGS, "2026-09-15", [annual()], "en-US");
    expect(first).toEqual({ sent: 1, failed: 0 });
    expect(db.prepare("SELECT status, attempts FROM subscription_reminder_sends").get()).toEqual({ status: "sent", attempts: 1 });

    const second = await runRenewalRemindersForUser(whatsappEnv(env), USER_ID, SETTINGS, "2026-09-16", [annual()], "en-US");
    expect(second).toEqual({ sent: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records a 4xx as failed, keeps the token out of last_error, and stops retrying", async () => {
    const { db, env } = openDatabase();
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: `Bad request - please check your parameters (token ${TOKEN})` } }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));

    const result = await runRenewalRemindersForUser(whatsappEnv(env), USER_ID, SETTINGS, "2026-09-15", [annual()], "en-US");
    expect(result).toEqual({ sent: 0, failed: 1 });

    const row = db.prepare("SELECT status, attempts, last_error, sent_at FROM subscription_reminder_sends").get() as {
      status: string; attempts: number; last_error: string; sent_at: string | null;
    };
    expect(row.status).toBe("failed");
    expect(row.sent_at).toBeNull();
    expect(row.last_error).toContain("400");
    expect(row.last_error).not.toContain(TOKEN);
    // A refused request repeated unchanged cannot succeed, so the window stops being retried.
    expect(row.attempts).toBe(3);
    const retry = await runRenewalRemindersForUser(whatsappEnv(env), USER_ID, SETTINGS, "2026-09-16", [annual()], "en-US");
    expect(retry).toEqual({ sent: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a 5xx retryable on the next pass", async () => {
    const { db, env } = openDatabase();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status: 503 }));

    await runRenewalRemindersForUser(whatsappEnv(env), USER_ID, SETTINGS, "2026-09-15", [annual()], "en-US");
    expect(db.prepare("SELECT status, attempts FROM subscription_reminder_sends").get()).toEqual({ status: "failed", attempts: 1 });

    // An outage delays the warning; it does not cancel it.
    await runRenewalRemindersForUser(whatsappEnv(env), USER_ID, SETTINGS, "2026-09-16", [annual()], "en-US");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT attempts FROM subscription_reminder_sends").get()).toEqual({ attempts: 2 });
  });

  it("keeps the window alive when the token is revoked, so a new token still sends it", async () => {
    const { db, env } = openDatabase();
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "Session has expired" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));

    await runRenewalRemindersForUser(whatsappEnv(env), USER_ID, SETTINGS, "2026-09-15", [annual()], "en-US");
    expect(db.prepare("SELECT status, attempts FROM subscription_reminder_sends").get()).toEqual({ status: "failed", attempts: 1 });

    // The warning this protects is a three-figure annual renewal. A token replaced ten minutes
    // later must still deliver it, so 401 must never consume the window.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }));
    const retry = await runRenewalRemindersForUser(whatsappEnv(env), USER_ID, SETTINGS, "2026-09-16", [annual()], "en-US");
    expect(retry).toEqual({ sent: 1, failed: 0 });
    expect(db.prepare("SELECT status FROM subscription_reminder_sends").get()).toEqual({ status: "sent" });
  });

  it("sends nothing at all when neither output is configured", async () => {
    const { db, env } = openDatabase();
    const result = await runRenewalRemindersForUser(env, USER_ID, { renewalWebhookUrl: "", testPhone: "" }, "2026-09-15", [annual()], "en-US");

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    // No window may be consumed by a message nobody received.
    expect(db.prepare("SELECT COUNT(*) AS total FROM subscription_reminder_sends").get()).toEqual({ total: 0 });
  });

  it("routes the annual subscription to the annual template", async () => {
    const { env } = openDatabase();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }));

    await runRenewalRemindersForUser(whatsappEnv(env), USER_ID, SETTINGS, "2026-09-15", [annual()], "en-US");

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      template: { name: string; language: { code: string } };
    };
    expect(body.template.name).toBe("renewlet_renovacion_anual");
    expect(body.template.language.code).toBe("es");
  });
});

