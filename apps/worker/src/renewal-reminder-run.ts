import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import {
  isPermanentRenewalSendFailure,
  metaWhatsAppConfig,
  normalizeRecipientPhone,
  sendMetaWhatsApp,
} from "./notification-meta-whatsapp";
import { sendRenewalWebhook, type RenewalUpcomingEvent } from "./notification-renewal-webhook";
import { planRenewalReminders, recordRenewalReminderFailure, recordRenewalReminderSent } from "./renewal-reminder-store";
import type { Env, SubscriptionRow } from "./types";
import type { AppLocale } from "./http";

type RenewalSettings = Pick<ApiAppSettings, "renewalWebhookUrl" | "testPhone">;
type RenewalDelivery = (event: RenewalUpcomingEvent) => Promise<void>;

/**
 * Runs the per-subscription renewal event for one user.
 *
 * Kept apart from the summary notification job on purpose. That job is one message per user written
 * into notification_jobs; this is N messages per user recorded in subscription_reminder_sends. A
 * failure here must not mark the summary job failed, and a failure there must not replay these.
 */
export async function runRenewalRemindersForUser(
  env: Env,
  userId: string,
  settings: RenewalSettings,
  localDate: string,
  rows: SubscriptionRow[],
  locale: AppLocale,
): Promise<{ sent: number; failed: number }> {
  const deliver = selectRenewalDelivery(env, settings, locale);
  if (!deliver) return { sent: 0, failed: 0 };
  const decisions = await planRenewalReminders(env, userId, localDate, rows);
  let sent = 0;
  let failed = 0;
  for (const decision of decisions) {
    try {
      await deliver(decision.event);
      // Recorded only after the endpoint accepted it, so a failed send is retried on the next run
      // instead of being silently consumed.
      await recordRenewalReminderSent(env, userId, decision);
      sent += 1;
    } catch (error) {
      failed += 1;
      // Persist the outcome before logging: wrangler tail is not somewhere failures get noticed.
      await recordRenewalReminderFailure(env, userId, decision, error, isPermanentRenewalSendFailure(error));
      console.error("renewal_reminder_failed", {
        event: "renewal_reminder_failed",
        userId,
        subscriptionId: decision.subscriptionId,
        reminderWindow: decision.firedWindow,
        permanent: isPermanentRenewalSendFailure(error),
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
    }
  }
  return { sent, failed };
}

/**
 * One output at a time, whichever is configured, WhatsApp first.
 *
 * Two live outputs would mean one dedup record standing for two deliveries that can disagree, so
 * that stays out until it is actually wanted.
 */
export function selectRenewalDelivery(
  env: Env,
  settings: RenewalSettings,
  locale: AppLocale,
): RenewalDelivery | null {
  const whatsapp = metaWhatsAppConfig(env);
  // Both halves, because they answer different questions. The credentials are Worker level secrets
  // shared by everyone with an account on this instance, while the recipient is this user's own
  // setting, so a configured sender says nothing about whether this particular user can be reached.
  // Selecting on the credentials alone handed WhatsApp to every account the moment the instance had
  // it at all: users with no number failed every send, and their own webhook was never consulted
  // because WhatsApp had already won here. Normalised rather than trimmed, so this asks the same
  // question the sender asks and cannot answer it differently.
  if (whatsapp && normalizeRecipientPhone(settings.testPhone)) {
    return (event) => sendMetaWhatsApp(whatsapp, settings, event, locale);
  }
  if (settings.renewalWebhookUrl.trim()) return (event) => sendRenewalWebhook(settings, event, locale);
  return null;
}
