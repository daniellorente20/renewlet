import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { sendRenewalWebhook } from "./notification-renewal-webhook";
import { planRenewalReminders, recordRenewalReminderFailure, recordRenewalReminderSent } from "./renewal-reminder-store";
import type { Env, SubscriptionRow } from "./types";
import type { AppLocale } from "./http";

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
  settings: Pick<ApiAppSettings, "renewalWebhookUrl">,
  localDate: string,
  rows: SubscriptionRow[],
  locale: AppLocale,
): Promise<{ sent: number; failed: number }> {
  if (!settings.renewalWebhookUrl.trim()) return { sent: 0, failed: 0 };
  const decisions = await planRenewalReminders(env, userId, localDate, rows);
  let sent = 0;
  let failed = 0;
  for (const decision of decisions) {
    try {
      await sendRenewalWebhook(settings, decision.event, locale);
      // Recorded only after the endpoint accepted it, so a failed send is retried on the next run
      // instead of being silently consumed.
      await recordRenewalReminderSent(env, userId, decision);
      sent += 1;
    } catch (error) {
      failed += 1;
      // Persist the outcome before logging: wrangler tail is not somewhere failures get noticed.
      await recordRenewalReminderFailure(env, userId, decision, error);
      console.error("renewal_reminder_failed", {
        event: "renewal_reminder_failed",
        userId,
        subscriptionId: decision.subscriptionId,
        reminderWindow: decision.firedWindow,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
    }
  }
  return { sent, failed };
}
