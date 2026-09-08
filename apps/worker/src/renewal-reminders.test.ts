import { describe, expect, it } from "vitest";
import { collectRenewalReminders, cycleRuleFor, priceNoteFor, priceRoseThisCycle, renewalReminderFor } from "./renewal-reminders";
import type { SubscriptionRow } from "./types";

const TODAY = "2026-09-08";

function row(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub_adobe",
    user_id: "usr_owner",
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

const nothingSent = () => false;

describe("cycle routing", () => {
  it("sends nothing for weekly or one-time", () => {
    expect(cycleRuleFor(row({ billing_cycle: "weekly" }))).toBeNull();
    expect(cycleRuleFor(row({ billing_cycle: "one-time" }))).toBeNull();
  });

  it("treats a long custom cycle as annual and a short one as monthly", () => {
    expect(cycleRuleFor(row({ billing_cycle: "custom", custom_days: 1, custom_cycle_unit: "year" }))?.windows).toEqual([30, 7]);
    expect(cycleRuleFor(row({ billing_cycle: "custom", custom_days: 2, custom_cycle_unit: "month" }))?.windows).toEqual([7]);
  });

  it("refuses to guess when a custom cycle is incomplete", () => {
    expect(cycleRuleFor(row({ billing_cycle: "custom", custom_days: null, custom_cycle_unit: null }))).toBeNull();
  });

  it("routes semi-annual to the neutral template, always, on a wider window", () => {
    const rule = cycleRuleFor(row({ billing_cycle: "semi-annual" }));
    // The annual template ends with "si no quieres pagar otro año", which is wrong for six months.
    expect(rule).toEqual({ template: "monthly", windows: [14], requiresPriceRise: false });
  });
});

describe("reminder_days overrides the cycle rules", () => {
  // An annual contract billed monthly: the cycle describes the receipt, the date describes the
  // commitment. Only what the owner declares can tell it apart from an ordinary monthly.
  const instalments = (overrides: Partial<SubscriptionRow> = {}) => row({
    id: "sub_mybox",
    name: "mybox",
    billing_cycle: "monthly",
    price: "26",
    previous_price: null,
    previous_price_currency: null,
    previous_price_changed_at: null,
    next_billing_date: "2026-12-01",
    start_date: "2025-12-01",
    ...overrides,
  });

  it("warns on a monthly with no price rise at all, which today would stay silent", () => {
    const declared = instalments({ reminder_days: 30 });
    expect(renewalReminderFor("2026-11-01", declared, nothingSent)?.firedWindow).toBe(30);
    // Same row on the cycle rules says nothing, because a flat monthly has nothing to decide.
    expect(renewalReminderFor("2026-11-01", instalments({ reminder_days: -1 }), nothingSent)).toBeNull();
  });

  it("adds a 7 day last call to any window wider than 7", () => {
    const asisa = instalments({ id: "sub_asisa", name: "Asisa", next_billing_date: "2026-12-31", reminder_days: 60 });
    expect(cycleRuleFor(asisa)?.windows).toEqual([60, 7]);
    expect(renewalReminderFor("2026-11-01", asisa, nothingSent)?.firedWindow).toBe(60);
    const sent = (_id: string, _target: string, window: number) => window === 60;
    expect(renewalReminderFor("2026-12-26", asisa, sent)?.firedWindow).toBe(7);
  });

  it("leaves a narrow declared window on its own", () => {
    expect(cycleRuleFor(instalments({ reminder_days: 7 }))?.windows).toEqual([7]);
    expect(cycleRuleFor(instalments({ reminder_days: 3 }))?.windows).toEqual([3]);
  });

  it("keeps the neutral template unless the cycle really is a yearly one", () => {
    expect(cycleRuleFor(instalments({ reminder_days: 30 }))?.template).toBe("monthly");
    expect(cycleRuleFor(instalments({ reminder_days: 30, billing_cycle: "annual" }))?.template).toBe("annual");
  });

  it("never gates a declared window on a price rise, and adds no parenthesis", () => {
    const decision = renewalReminderFor("2026-11-01", instalments({ reminder_days: 30 }), nothingSent);
    expect(cycleRuleFor(instalments({ reminder_days: 30 }))?.requiresPriceRise).toBe(false);
    expect(decision?.event.amount).toBe("26,00 EUR");
    expect(decision?.event.price_note).toBe("sin datos del ciclo anterior");
  });

  it("stays silent on -2 even when the price went up", () => {
    const raised = instalments({
      reminder_days: -2,
      price: "30",
      previous_price: "26",
      previous_price_currency: "EUR",
      previous_price_changed_at: "2026-11-20T00:00:00.000Z",
    });
    expect(cycleRuleFor(raised)).toBeNull();
    expect(renewalReminderFor("2026-11-25", raised, nothingSent)).toBeNull();
  });

  it("reads the raw value, so a window inherited from the global setting is not an override", () => {
    // effectiveReminderDays would resolve -1 to the account default and make this look declared.
    expect(cycleRuleFor(instalments({ reminder_days: -1 }))).toEqual({ template: "monthly", windows: [7], requiresPriceRise: true });
  });

  it("stays silent on a declared 0, which would be a same-day charge notice", () => {
    expect(cycleRuleFor(instalments({ reminder_days: 0 }))).toBeNull();
  });

  it("still refuses a one-time purchase, which never renews", () => {
    expect(cycleRuleFor(instalments({ billing_cycle: "one-time", reminder_days: 30 }))).toBeNull();
  });

  it("lets a declared window speak for a weekly, which the cycle rules mute", () => {
    expect(cycleRuleFor(instalments({ billing_cycle: "weekly", reminder_days: -1 }))).toBeNull();
    expect(cycleRuleFor(instalments({ billing_cycle: "weekly", reminder_days: 14 }))?.windows).toEqual([14, 7]);
  });
});

describe("semi-annual", () => {
  const semi = (overrides: Partial<SubscriptionRow> = {}) => row({
    billing_cycle: "semi-annual",
    price: "60",
    previous_price: "60",
    next_billing_date: "2026-09-20",
    start_date: "2025-03-20",
    ...overrides,
  });

  it("warns 14 days out whether or not the price moved", () => {
    const decision = renewalReminderFor("2026-09-06", semi(), nothingSent);
    expect(decision?.firedWindow).toBe(14);
    expect(decision?.event.billing_cycle).toBe("monthly");
    expect(decision?.event.days_remaining).toBe(14);
  });

  it("leaves the amount clean, with no parenthesis that says nothing", () => {
    // A monthly earns the parenthesis because the rise is why the message exists. A semi-annual
    // would just trail "(igual que el ciclo anterior)".
    expect(renewalReminderFor("2026-09-06", semi(), nothingSent)?.event.amount).toBe("60,00 EUR");
    expect(renewalReminderFor("2026-09-06", semi({ price: "75", previous_price: "60" }), nothingSent)?.event.amount).toBe("75,00 EUR");
  });

  it("still carries the change in its own price_note field", () => {
    expect(renewalReminderFor("2026-09-06", semi({ price: "75", previous_price: "60" }), nothingSent)?.event.price_note)
      .toBe("sube desde 60,00 EUR");
  });

  it("does not use the annual windows", () => {
    expect(renewalReminderFor("2026-08-21", semi(), nothingSent)).toBeNull();
  });
});

describe("window selection", () => {
  it("fires the 30 day window for an annual subscription", () => {
    const decision = renewalReminderFor("2026-09-15", row(), nothingSent);
    expect(decision?.firedWindow).toBe(30);
    expect(decision?.event.days_remaining).toBe(30);
    expect(decision?.consumedWindows).toEqual([30]);
  });

  it("still fires when the run is a day late, and says the real number", () => {
    const decision = renewalReminderFor("2026-09-16", row(), nothingSent);
    expect(decision?.firedWindow).toBe(30);
    // The window that triggered and the days actually left disagree here. The message prints the
    // truthful one, which is the whole reason they are two separate fields.
    expect(decision?.event.days_remaining).toBe(29);
  });

  it("sends one message and consumes both windows when both match at once", () => {
    const decision = renewalReminderFor("2026-10-12", row(), nothingSent);
    expect(decision?.firedWindow).toBe(7);
    expect(decision?.event.days_remaining).toBe(3);
    expect(decision?.consumedWindows).toEqual([7, 30]);
  });

  it("does not repeat a window that was already recorded", () => {
    const sent = (_id: string, _target: string, window: number) => window === 30;
    expect(renewalReminderFor("2026-09-15", row(), sent)).toBeNull();
    expect(renewalReminderFor("2026-10-10", row(), sent)?.firedWindow).toBe(7);
  });

  it("stays silent on the billing date itself and after it", () => {
    expect(renewalReminderFor("2026-10-15", row(), nothingSent)).toBeNull();
    expect(renewalReminderFor("2026-10-16", row(), nothingSent)).toBeNull();
  });

  it("stays silent before the widest window opens", () => {
    expect(renewalReminderFor("2026-09-14", row(), nothingSent)).toBeNull();
  });

  it("ignores subscriptions that are not active or on trial", () => {
    expect(renewalReminderFor("2026-09-15", row({ status: "paused" }), nothingSent)).toBeNull();
    expect(renewalReminderFor("2026-09-15", row({ status: "cancelled" }), nothingSent)).toBeNull();
  });
});

describe("monthly and quarterly only speak on a price rise", () => {
  const monthly = (overrides: Partial<SubscriptionRow> = {}) => row({
    billing_cycle: "monthly",
    price: "10.99",
    previous_price: "8.99",
    next_billing_date: "2026-09-13",
    start_date: "2025-01-13",
    previous_price_changed_at: "2026-08-20T00:00:00.000Z",
    ...overrides,
  });

  it("warns when the price went up inside the cycle about to renew", () => {
    const decision = renewalReminderFor(TODAY, monthly(), nothingSent);
    expect(decision?.event.billing_cycle).toBe("monthly");
    expect(decision?.firedWindow).toBe(7);
    expect(decision?.event.amount).toBe("10,99 EUR (sube desde 8,99 EUR)");
  });

  it("says nothing when the price has not moved", () => {
    expect(renewalReminderFor(TODAY, monthly({ price: "8.99", previous_price: "8.99" }), nothingSent)).toBeNull();
  });

  it("says nothing when the price went down, because there is nothing to do about it", () => {
    expect(renewalReminderFor(TODAY, monthly({ price: "6.99" }), nothingSent)).toBeNull();
  });

  it("stops after one cycle instead of warning every month forever", () => {
    // Same recorded rise, but the cycle has rolled: the change now sits before this cycle started.
    const rolled = monthly({ next_billing_date: "2026-11-13", previous_price_changed_at: "2026-08-20T00:00:00.000Z" });
    expect(priceRoseThisCycle(rolled, 30)).toBe(false);
    expect(renewalReminderFor("2026-11-10", rolled, nothingSent)).toBeNull();
  });

  it("leaves the window unconsumed so a rise later in the cycle is still announced", () => {
    const flat = monthly({ price: "8.99", previous_price: "8.99" });
    expect(renewalReminderFor("2026-09-07", flat, nothingSent)).toBeNull();
    const raisedLater = monthly({ price: "10.99", previous_price_changed_at: "2026-09-09T00:00:00.000Z" });
    expect(renewalReminderFor("2026-09-10", raisedLater, nothingSent)?.firedWindow).toBe(7);
  });

  it("does not read a currency switch as a rise", () => {
    expect(renewalReminderFor(TODAY, monthly({ currency: "USD", previous_price_currency: "EUR" }), nothingSent)).toBeNull();
  });

  it("never warns on a monthly with no recorded price history", () => {
    expect(renewalReminderFor(TODAY, monthly({ previous_price: null, previous_price_currency: null, previous_price_changed_at: null }), nothingSent)).toBeNull();
  });
});

describe("price_note", () => {
  it("covers all five cases in cycle-neutral wording", () => {
    expect(priceNoteFor(row(), 365)).toBe("sube desde 199,00 EUR");
    expect(priceNoteFor(row({ price: "150" }), 365)).toBe("baja desde 199,00 EUR");
    expect(priceNoteFor(row({ price: "199" }), 365)).toBe("igual que el ciclo anterior");
    expect(priceNoteFor(row({ previous_price: null, previous_price_currency: null }), 365)).toBe("sin datos del ciclo anterior");
    expect(priceNoteFor(row({ previous_price: null, previous_price_currency: null, start_date: "2025-10-15" }), 365)).toBe("primer cobro");
  });

  it("never returns an empty string, whatever the row looks like", () => {
    const shapes = [
      row({ previous_price: null, previous_price_currency: null, start_date: null }),
      row({ previous_price: "abc" }),
      row({ previous_price_currency: "USD" }),
    ];
    for (const shape of shapes) expect(priceNoteFor(shape, 365).trim().length).toBeGreaterThan(0);
  });
});

describe("collectRenewalReminders", () => {
  it("keeps only the subscriptions that have something to say today", () => {
    const decisions = collectRenewalReminders("2026-09-15", [
      row(),
      row({ id: "sub_weekly", billing_cycle: "weekly", next_billing_date: "2026-09-16" }),
      row({ id: "sub_quiet_monthly", billing_cycle: "monthly", price: "8.99", previous_price: "8.99", next_billing_date: "2026-09-18" }),
    ], nothingSent);
    expect(decisions.map((decision) => decision.subscriptionId)).toEqual(["sub_adobe"]);
  });
});
