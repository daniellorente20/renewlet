import { describe, expect, it } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription } from "@/types/subscription";
import { subscriptionCycleFixture, type SubscriptionFixtureOverrides } from "@/test/subscription-fixtures";
import { buildUpcomingSubscriptionEvents, resolveUpcomingSubscriptionEvent } from "./upcoming-reminders";

type SubscriptionBaseFixture = Omit<Subscription, "billingCycle" | "customDays" | "customCycleUnit" | "oneTimeTermCount" | "oneTimeTermUnit">;
type SubscriptionOverrides = SubscriptionFixtureOverrides<Subscription>;

const baseSubscription: SubscriptionBaseFixture = {
  id: "base",
  name: "Base",
  logo: undefined,
  price: "10",
  currency: "USD",
  category: "productivity",
  status: "active",
  paymentMethod: undefined,
  startDate: assertDateOnly("2026-01-01"),
  nextBillingDate: assertDateOnly("2026-07-15"),
  autoRenew: false,
  autoCalculateNextBillingDate: true,
  trialEndDate: undefined,
  website: undefined,
  notes: undefined,
  tags: [],
  reminderDays: 30,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  extra: {},
  costSharing: undefined,
  pinned: false,
  publicHidden: false,
};

function subscription(overrides: SubscriptionOverrides = {}): Subscription {
  return {
    ...baseSubscription,
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}

describe("upcoming subscription events", () => {
  it("keeps reminder-disabled and reminder-window-outside events visible", () => {
    const events = buildUpcomingSubscriptionEvents({
      today: "2026-06-15",
      subscriptions: [
        subscription({ id: "disabled", name: "Disabled", reminderDays: -2, nextBillingDate: assertDateOnly("2026-12-01") }),
        subscription({ id: "auto", name: "Auto", autoRenew: true, nextBillingDate: assertDateOnly("2026-06-20") }),
      ],
    });

    expect(events.map((event) => event.subscriptionId)).toEqual(["auto", "disabled"]);
    expect(events[0]?.reminderEnabled).toBe(true);
    expect(events[1]?.reminderEnabled).toBe(false);
  });

  it("uses the earlier trial end date and keeps equal dates as a trial event", () => {
    const earlier = resolveUpcomingSubscriptionEvent(
      subscription({
        status: "trial",
        trialEndDate: assertDateOnly("2026-06-20"),
        nextBillingDate: assertDateOnly("2026-07-15"),
      }),
      "2026-06-15",
    );
    const equal = resolveUpcomingSubscriptionEvent(
      subscription({
        status: "trial",
        trialEndDate: assertDateOnly("2026-07-15"),
      }),
      "2026-06-15",
    );

    expect(earlier).toMatchObject({ kind: "trial", dueDate: "2026-06-20", daysUntil: 5 });
    expect(equal).toMatchObject({ kind: "trial", dueDate: "2026-07-15" });
  });

  it("preserves fixed-term expiry events and excludes buyouts and inactive subscriptions", () => {
    const events = buildUpcomingSubscriptionEvents({
      today: "2026-06-15",
      subscriptions: [
        subscription({ id: "fixed", name: "Fixed", billingCycle: "one-time", oneTimeTermCount: 6, oneTimeTermUnit: "month" }),
        subscription({ id: "buyout", name: "Buyout", billingCycle: "one-time", nextBillingDate: assertDateOnly("2099-01-01") }),
        subscription({ id: "paused", name: "Paused", status: "paused" }),
        subscription({ id: "cancelled", name: "Cancelled", status: "cancelled" }),
        subscription({ id: "past", name: "Past", nextBillingDate: assertDateOnly("2026-06-14") }),
      ],
    });

    expect(events.map((event) => [event.subscriptionId, event.kind])).toEqual([["fixed", "expiry"]]);
  });

  it("sorts equal dates by name and then stable id", () => {
    const events = buildUpcomingSubscriptionEvents({
      today: "2026-06-15",
      subscriptions: [
        subscription({ id: "b", name: "Same", nextBillingDate: assertDateOnly("2026-06-20") }),
        subscription({ id: "a", name: "Same", nextBillingDate: assertDateOnly("2026-06-20") }),
        subscription({ id: "c", name: "Earlier", nextBillingDate: assertDateOnly("2026-06-20") }),
      ],
    });

    expect(events.map((event) => event.subscriptionId)).toEqual(["c", "a", "b"]);
  });
});
