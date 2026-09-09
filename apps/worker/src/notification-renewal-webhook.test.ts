import { describe, expect, it, vi } from "vitest";
import { assertSendableRenewalEvent, type RenewalUpcomingEvent } from "./notification-renewal-webhook";
import { notificationSenders } from "./notification-channel-send";

// notification-channel-send pulls in the SMTP sender, which only resolves inside the Worker runtime.
vi.mock("./smtp", () => ({
  notificationSmtpConfig: vi.fn(),
  sendSmtpEmail: vi.fn(),
}));

function event(overrides: Partial<RenewalUpcomingEvent> = {}): RenewalUpcomingEvent {
  return {
    event: "renewal_upcoming",
    billing_cycle: "annual",
    reminder_window: 30,
    days_remaining: 30,
    service: "Adobe Creative Cloud",
    next_billing_date: "2026-10-15",
    amount: "239,88 EUR",
    price_note: "sube desde 199,00 EUR",
    ...overrides,
  };
}

describe("renewal upcoming event", () => {
  it("accepts a fully populated event", () => {
    expect(assertSendableRenewalEvent(event())).toEqual(event());
  });

  it("rejects an empty field instead of letting the delivery fail downstream", () => {
    expect(() => assertSendableRenewalEvent(event({ price_note: "   " }))).toThrow("RENEWAL_EVENT_EMPTY_FIELD:price_note");
  });

  it("rejects whitespace that message template parameters do not allow", () => {
    expect(() => assertSendableRenewalEvent(event({ service: "Adobe\nCreative Cloud" }))).toThrow("RENEWAL_EVENT_INVALID_WHITESPACE:service");
    expect(() => assertSendableRenewalEvent(event({ price_note: "sube\tdesde 199,00 EUR" }))).toThrow("RENEWAL_EVENT_INVALID_WHITESPACE:price_note");
    expect(() => assertSendableRenewalEvent(event({ amount: "239,88    EUR" }))).toThrow("RENEWAL_EVENT_INVALID_WHITESPACE:amount");
  });

  it("keeps reminder_window and days_remaining independent so a late send stays truthful", () => {
    const late = assertSendableRenewalEvent(event({ reminder_window: 30, days_remaining: 12 }));
    expect(late.reminder_window).toBe(30);
    expect(late.days_remaining).toBe(12);
  });

  it("stays out of the shared channel fan-out that the summary webhook rides on", () => {
    // Three n8n workflows read body.title and body.content from the summary payload. This event is
    // one POST per subscription, so it must never be reachable through enabledChannels.
    expect(Object.keys(notificationSenders)).not.toContain("renewalWebhook");
    expect(Object.keys(notificationSenders)).not.toContain("renewal");
  });
});
