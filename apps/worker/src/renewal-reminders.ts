import { formatMoneyWithCurrency } from "@renewlet/shared/money";
import { isDisabledReminderDays, isInheritReminderDays } from "@renewlet/shared/runtime";
import { addDays } from "./time";
import { daysBetween } from "./notification-schedule";
import type { RenewalUpcomingEvent } from "./notification-renewal-webhook";
import type { SubscriptionRow } from "./types";

/**
 * Per-subscription renewal reminders: which subscription is warned, when, and with what wording.
 *
 * Deliberately pure. Reading the already-sent records and writing the new ones stays in the caller,
 * so the window arithmetic can be tested without a database and without a clock.
 */

/** Amounts are rendered for the message templates, which are Spanish only. */
const AMOUNT_LOCALE = "es-ES";

/** A yearly cycle for the purpose of picking windows and a template. */
const ANNUAL_LIKE_DAYS = 300;

interface CycleRule {
  /**
   * Which message template the event selects. Not the stored billing cycle: this is the only field
   * the receiving side branches on, so semi-annual riding the annual template is a routing choice.
   */
  template: RenewalUpcomingEvent["billing_cycle"];
  windows: number[];
  /**
   * Monthly-shaped subscriptions only warn when the price went up during the cycle about to renew.
   * A monthly that costs what it cost last month has nothing to decide, and warning every month
   * trains the reader to dismiss the template before the annual one arrives.
   */
  requiresPriceRise: boolean;
}

const ANNUAL_RULE: CycleRule = { template: "annual", windows: [30, 7], requiresPriceRise: false };
/**
 * Six months is a big enough commitment to always warn about, but the annual template closes with
 * "si no quieres pagar otro año", which is simply false for it. The monthly template's closing line
 * is cycle-neutral, so semi-annual rides that one with a wider window and no price-rise gate.
 */
const SEMI_ANNUAL_RULE: CycleRule = { template: "monthly", windows: [14], requiresPriceRise: false };
const MONTHLY_RULE: CycleRule = { template: "monthly", windows: [7], requiresPriceRise: true };

const CYCLE_RULES: Record<string, CycleRule | null> = {
  annual: ANNUAL_RULE,
  "semi-annual": SEMI_ANNUAL_RULE,
  quarterly: MONTHLY_RULE,
  monthly: MONTHLY_RULE,
  weekly: null,
  "one-time": null,
};

const CYCLE_DAYS: Record<string, number> = {
  weekly: 7,
  monthly: 30,
  quarterly: 91,
  "semi-annual": 182,
  annual: 365,
};

const CUSTOM_UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

export interface RenewalReminderDecision {
  subscriptionId: string;
  targetDate: string;
  /** The window that produced the message: the smallest one that matches today. */
  firedWindow: number;
  /** Every window that matches today, all consumed together so no backlog is left behind. */
  consumedWindows: number[];
  event: RenewalUpcomingEvent;
}

export type SentWindowLookup = (subscriptionId: string, targetDate: string, window: number) => boolean;

/**
 * Approximate length of one billing cycle in days.
 *
 * Only ever used to place a date inside or outside the current cycle and to compare a custom cycle
 * against the annual threshold, so month as 30 and year as 365 cannot change an outcome.
 */
export function cycleLengthDays(row: Pick<SubscriptionRow, "billing_cycle" | "custom_days" | "custom_cycle_unit">): number | null {
  if (row.billing_cycle === "custom") {
    const unit = row.custom_cycle_unit ? CUSTOM_UNIT_DAYS[row.custom_cycle_unit] : undefined;
    if (!unit || !row.custom_days || row.custom_days <= 0) return null;
    return row.custom_days * unit;
  }
  return CYCLE_DAYS[row.billing_cycle] ?? null;
}

type CycleShape = Pick<SubscriptionRow, "billing_cycle" | "custom_days" | "custom_cycle_unit">;

/** A yearly commitment, whether it says so in billing_cycle or in a long custom cycle. */
function isAnnualLike(row: CycleShape): boolean {
  if (row.billing_cycle === "annual") return true;
  if (row.billing_cycle !== "custom") return false;
  const days = cycleLengthDays(row);
  return days !== null && days >= ANNUAL_LIKE_DAYS;
}

/**
 * A reminder_days the owner set by hand on this subscription.
 *
 * It exists because billing_cycle describes the receipt, not the commitment. An annual contract
 * billed in monthly instalments is indistinguishable from an ordinary monthly by its cycle alone,
 * so the only thing that can tell them apart is what the owner declares. A declared window is
 * therefore never gated on a price rise: the owner already said this one is worth interrupting for.
 */
function explicitReminderRule(row: CycleShape & Pick<SubscriptionRow, "reminder_days">): CycleRule {
  // Anything wider than the last-call window also gets a 7 day warning, the way annuals do.
  const windows = row.reminder_days > 7 ? [row.reminder_days, 7] : [row.reminder_days];
  return { template: isAnnualLike(row) ? "annual" : "monthly", windows, requiresPriceRise: false };
}

export function cycleRuleFor(row: CycleShape & Pick<SubscriptionRow, "reminder_days">): CycleRule | null {
  // -2 silences a subscription across the whole notification path. This event is no exception.
  if (isDisabledReminderDays(row.reminder_days)) return null;
  // A buyout never renews, so a renewal_upcoming about it would be a false statement no matter what
  // reminder_days says.
  if (row.billing_cycle === "one-time") return null;
  if (!isInheritReminderDays(row.reminder_days)) {
    // 0 means "warn me on the day", and this channel never carries a same-day charge notice.
    if (row.reminder_days < 1) return null;
    return explicitReminderRule(row);
  }
  // -1 inherits, and inheriting means the cycle rules decide. Deliberately not resolved through
  // effectiveReminderDays: a 30 inherited from the global setting does not carry the same intent as
  // a 30 the owner typed onto this subscription, and only the second one should override a cycle.
  if (row.billing_cycle !== "custom") return CYCLE_RULES[row.billing_cycle] ?? null;
  const days = cycleLengthDays(row);
  if (days === null) return null;
  return days >= ANNUAL_LIKE_DAYS ? ANNUAL_RULE : MONTHLY_RULE;
}

type PriceComparison = "rise" | "drop" | "same" | "unknown" | "first";

function comparePriceToPreviousCycle(row: SubscriptionRow, cycleDays: number | null): PriceComparison {
  // A currency switch makes the two amounts incomparable; claiming a rise would be a guess.
  if (row.previous_price === null || row.previous_price_currency !== row.currency) {
    if (cycleDays !== null && row.start_date && daysBetween(row.start_date, row.next_billing_date) <= cycleDays) return "first";
    return "unknown";
  }
  const current = Number.parseFloat(row.price);
  const previous = Number.parseFloat(row.previous_price);
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return "unknown";
  if (current > previous) return "rise";
  if (current < previous) return "drop";
  return "same";
}

/** Cycle-neutral wording: the monthly template would read absurdly with "el año pasado". */
export function priceNoteFor(row: SubscriptionRow, cycleDays: number | null): string {
  switch (comparePriceToPreviousCycle(row, cycleDays)) {
    case "rise":
      return `sube desde ${formatMoneyWithCurrency(row.previous_price, row.previous_price_currency ?? row.currency, AMOUNT_LOCALE)}`;
    case "drop":
      return `baja desde ${formatMoneyWithCurrency(row.previous_price, row.previous_price_currency ?? row.currency, AMOUNT_LOCALE)}`;
    case "same":
      return "igual que el ciclo anterior";
    case "first":
      return "primer cobro";
    default:
      return "sin datos del ciclo anterior";
  }
}

/**
 * Whether the price went up inside the cycle that is about to renew.
 *
 * The timestamp is what keeps this from latching: once the cycle rolls over, the same recorded rise
 * falls before the new cycle start and stops qualifying, so one rise produces one warning.
 */
export function priceRoseThisCycle(row: SubscriptionRow, cycleDays: number | null): boolean {
  if (cycleDays === null || row.previous_price_changed_at === null) return false;
  if (comparePriceToPreviousCycle(row, cycleDays) !== "rise") return false;
  const cycleStart = addDays(row.next_billing_date, -cycleDays);
  const changedOn = row.previous_price_changed_at.slice(0, 10);
  return changedOn >= cycleStart;
}

export function collectRenewalReminders(
  localDate: string,
  rows: SubscriptionRow[],
  alreadySent: SentWindowLookup,
): RenewalReminderDecision[] {
  const decisions: RenewalReminderDecision[] = [];
  for (const row of rows) {
    const decision = renewalReminderFor(localDate, row, alreadySent);
    if (decision) decisions.push(decision);
  }
  return decisions;
}

export function renewalReminderFor(
  localDate: string,
  row: SubscriptionRow,
  alreadySent: SentWindowLookup,
): RenewalReminderDecision | null {
  if (row.status !== "active" && row.status !== "trial") return null;
  const rule = cycleRuleFor(row);
  if (!rule) return null;

  const daysRemaining = daysBetween(localDate, row.next_billing_date);
  // Floor of 1, not 0. A warning that lands on the billing date is a charge notice, not a decision,
  // and the ceiling keeps a window from firing before it is due.
  if (daysRemaining < 1) return null;

  const matching = rule.windows.filter((window) => daysRemaining <= window && !alreadySent(row.id, row.next_billing_date, window));
  if (matching.length === 0) return null;

  const cycleDays = cycleLengthDays(row);
  // No rows are written when the rise is missing: the price can still go up later in this cycle,
  // and consuming the window here would swallow the warning that rise deserves.
  if (rule.requiresPriceRise && !priceRoseThisCycle(row, cycleDays)) return null;

  const firedWindow = Math.min(...matching);
  const priceNote = priceNoteFor(row, cycleDays);
  return {
    subscriptionId: row.id,
    targetDate: row.next_billing_date,
    firedWindow,
    consumedWindows: [...matching].sort((left, right) => left - right),
    event: {
      event: "renewal_upcoming",
      billing_cycle: rule.template,
      reminder_window: firedWindow,
      // Deliberately not firedWindow. They disagree whenever a send is late or a subscription was
      // added mid-window, and the message prints this one, so it has to be the truth.
      days_remaining: daysRemaining,
      service: row.name,
      next_billing_date: row.next_billing_date,
      amount: amountFor(row, rule, priceNote),
      price_note: priceNote,
    },
  };
}

/**
 * The monthly template has no "cambio de precio" variable, so where the rise is the reason the
 * message arrived at all, it is folded into the amount: "10,99 EUR (sube desde 8,99 EUR)". One
 * field, one line, no Meta review. The annual template keeps its dedicated variable.
 *
 * Gated on requiresPriceRise rather than on the template: a semi-annual also uses the monthly
 * template, but it is warned about regardless of price, so a trailing "(igual que el ciclo
 * anterior)" would add nothing to read.
 */
function amountFor(row: SubscriptionRow, rule: CycleRule, priceNote: string): string {
  const amount = formatMoneyWithCurrency(row.price, row.currency, AMOUNT_LOCALE);
  return rule.requiresPriceRise ? `${amount} (${priceNote})` : amount;
}
