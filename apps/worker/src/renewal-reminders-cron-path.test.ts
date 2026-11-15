import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { CronBudget } from "./cron-budget";
import { runScheduledForUser } from "./notifications";
import type { Env } from "./types";

// Fork only. Upstream's phased cron (v0.3.36) calls runScheduledForUser with `continued` on every
// notification tick, and uses that flag to skip work the earlier phase already did. Renewal
// reminders have no earlier phase, so anything that gates them on `!continued` turns them off in
// production while the suites that call the function without the flag stay green.

const reminderMocks = vi.hoisted(() => ({
  selectRenewalDelivery: vi.fn(),
  runRenewalRemindersForUser: vi.fn(),
}));
const cronMocks = vi.hoisted(() => ({ runCronForUser: vi.fn() }));

vi.mock("./renewal-reminder-run", () => reminderMocks);
vi.mock("./notification-cron", () => cronMocks);
// smtp.ts imports cloudflare:sockets, which only exists inside the Workers runtime.
vi.mock("./smtp", () => ({ sendSmtp: vi.fn() }));

const SCHEDULED_AT = new Date("2026-01-09T08:00:00.000Z");

function emptyDatabase(): D1Database {
  const meta = { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 };
  const statement = {
    bind: () => statement,
    all: async () => ({ results: [], success: true, meta }),
    first: async () => null,
    run: async () => ({ results: [], success: true, meta }),
  };
  return {
    prepare: () => statement,
    batch: async (statements: unknown[]) => statements.map(() => ({ results: [], success: true, meta })),
  } as unknown as D1Database;
}

function env(): Env {
  return { DB: emptyDatabase(), ASSETS: {} as Fetcher, ASSETS_BUCKET: {} as R2Bucket };
}

function settings(): ApiAppSettings {
  return { ...createDefaultAppSettings(), timezone: "UTC", notificationTimeLocal: "08:00" } as ApiAppSettings;
}

function cronTick(): { settings: ApiAppSettings; leaseNow: Date; budget: CronBudget } {
  return { settings: settings(), leaseNow: SCHEDULED_AT, budget: new CronBudget() };
}

describe("renewal reminders on the phased cron path", () => {
  beforeEach(() => {
    cronMocks.runCronForUser.mockResolvedValue("settled");
    reminderMocks.runRenewalRemindersForUser.mockResolvedValue({ sent: 0, failed: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs them when the cron resumes a notification phase", async () => {
    reminderMocks.selectRenewalDelivery.mockReturnValue(async () => undefined);

    await runScheduledForUser(env(), "usr_owner", SCHEDULED_AT, cronTick());

    expect(reminderMocks.runRenewalRemindersForUser).toHaveBeenCalledTimes(1);
    expect(reminderMocks.runRenewalRemindersForUser.mock.calls[0]?.[3]).toBe("2026-01-09");
    expect(cronMocks.runCronForUser).toHaveBeenCalledTimes(1);
  });

  it("reads nothing extra for an account with no renewal output", async () => {
    reminderMocks.selectRenewalDelivery.mockReturnValue(null);

    await runScheduledForUser(env(), "usr_owner", SCHEDULED_AT, cronTick());

    expect(reminderMocks.runRenewalRemindersForUser).not.toHaveBeenCalled();
    expect(cronMocks.runCronForUser).toHaveBeenCalledTimes(1);
  });

  it("still runs the summary job when the reminders throw", async () => {
    reminderMocks.selectRenewalDelivery.mockReturnValue(async () => undefined);
    reminderMocks.runRenewalRemindersForUser.mockRejectedValue(new Error("CRON_SQL_BUDGET_EXCEEDED"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runScheduledForUser(env(), "usr_owner", SCHEDULED_AT, cronTick());

    expect(result.outcome).toBe("settled");
    expect(cronMocks.runCronForUser).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith("renewal_reminders_aborted", expect.objectContaining({ userId: "usr_owner" }));
    logged.mockRestore();
  });
});
