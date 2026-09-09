import { z } from "zod";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { assertSafeOutboundUrl } from "./outbound-url-policy";
import { requireNotificationHttpOk, sendNotificationJson } from "./notification-http";
import { requiredSetting } from "./notification-channel-utils";
import { serverText } from "./server-i18n";
import type { AppLocale } from "./http";

const SERVICE = "RenewalWebhook";

/**
 * One POST per subscription, sent to its own endpoint.
 *
 * This deliberately stays out of the notificationSenders registry and out of the enabledChannels
 * fan-out. That path builds a single {title, content, timestamp} message per user and hands the
 * same object to every channel, so adding this event there would force the shared message type to
 * grow and would change what the existing summary webhook emits. Three n8n workflows read
 * body.title and body.content from that summary; they must keep seeing exactly what they see today.
 */

/**
 * `billing_cycle` is the template selector, not the stored billing cycle. Anything that reads as a
 * yearly commitment maps to "annual", everything else to "monthly", because the receiving message
 * templates are picked from this single field.
 */
export const renewalUpcomingEventSchema = z.object({
  event: z.literal("renewal_upcoming"),
  billing_cycle: z.enum(["annual", "monthly"]),
  // Nominal window that triggered the send (30 / 14 / 7). Also the deduplication key.
  reminder_window: z.number().int().positive(),
  // Real days left. These two disagree whenever a send is late, and the message prints this one.
  days_remaining: z.number().int().positive(),
  service: z.string().min(1),
  next_billing_date: z.string().min(1),
  amount: z.string().min(1),
  price_note: z.string().min(1),
}).strict();

export type RenewalUpcomingEvent = z.infer<typeof renewalUpcomingEventSchema>;

const FORBIDDEN_WHITESPACE = /[\n\r\t]|\s{4,}/;

/**
 * Message template parameters reject newlines, tabs and runs of four or more spaces, and an empty
 * parameter fails the whole delivery rather than leaving a blank in the text. Both rules are
 * checked here so a malformed field is caught as our bug, not as an opaque rejection downstream.
 */
export function assertSendableRenewalEvent(event: RenewalUpcomingEvent): RenewalUpcomingEvent {
  const parsed = renewalUpcomingEventSchema.parse(event);
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") continue;
    if (value.trim().length === 0) throw new Error(`RENEWAL_EVENT_EMPTY_FIELD:${key}`);
    if (FORBIDDEN_WHITESPACE.test(value)) throw new Error(`RENEWAL_EVENT_INVALID_WHITESPACE:${key}`);
  }
  return parsed;
}

export async function sendRenewalWebhook(
  settings: Pick<ApiAppSettings, "renewalWebhookUrl">,
  event: RenewalUpcomingEvent,
  locale: AppLocale,
): Promise<void> {
  const rawEndpoint = requiredSetting(settings.renewalWebhookUrl, serverText(locale, "service.webhookURL"), locale);
  // Worker has no dial hook; the endpoint is user supplied, so it is resolved and rejected for
  // private or loopback addresses before anything is sent, same as every other outbound callback.
  const endpoint = await assertSafeOutboundUrl(rawEndpoint, locale);
  const secrets = [rawEndpoint];
  const response = await sendNotificationJson(endpoint, assertSendableRenewalEvent(event), SERVICE, locale, { secrets });
  await requireNotificationHttpOk(response, SERVICE, locale, { secrets });
}
