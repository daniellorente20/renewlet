import { nowIso } from "./db";
import { collectRenewalReminders, type RenewalReminderDecision } from "./renewal-reminders";
import type { Env, SubscriptionRow } from "./types";

interface SentRow {
  subscription_id: string;
  target_date: string;
  reminder_window: number;
}

export interface RenewalReminderFailureRow {
  subscription_id: string;
  target_date: string;
  reminder_window: number;
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

const MAX_RECORDED_ERROR_LENGTH = 300;

function sentKey(subscriptionId: string, targetDate: string, window: number): string {
  return `${subscriptionId}|${targetDate}|${window}`;
}

/**
 * Reads the windows already delivered for the subscriptions in hand, in one query.
 *
 * Only 'sent' counts. A 'failed' row is a record of what went wrong, not a reason to stay quiet,
 * so a broken endpoint delays the warning instead of cancelling it.
 */
export async function loadSentWindows(env: Env, userId: string, rows: SubscriptionRow[]): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const placeholders = rows.map(() => "?").join(", ");
  const result = await env.DB.prepare(`
    SELECT subscription_id, target_date, reminder_window
    FROM subscription_reminder_sends
    WHERE user_id = ? AND status = 'sent' AND subscription_id IN (${placeholders})
  `).bind(userId, ...rows.map((row) => row.id)).all<SentRow>();
  return new Set(result.results.map((row) => sentKey(row.subscription_id, row.target_date, row.reminder_window)));
}

export async function planRenewalReminders(
  env: Env,
  userId: string,
  localDate: string,
  rows: SubscriptionRow[],
): Promise<RenewalReminderDecision[]> {
  const sent = await loadSentWindows(env, userId, rows);
  return collectRenewalReminders(localDate, rows, (subscriptionId, targetDate, window) => sent.has(sentKey(subscriptionId, targetDate, window)));
}

/**
 * Marks every window the decision consumed, not only the one that produced the message.
 *
 * A subscription added three days before its billing date matches both the 30 and the 7 window at
 * once; it gets one message and both rows, so the wider window cannot fire again tomorrow.
 * A previous failed attempt on the same window is upgraded in place and its error cleared.
 */
export async function recordRenewalReminderSent(
  env: Env,
  userId: string,
  decision: RenewalReminderDecision,
): Promise<void> {
  const timestamp = nowIso();
  await env.DB.batch(decision.consumedWindows.map((window) => env.DB.prepare(`
    INSERT INTO subscription_reminder_sends (user_id, subscription_id, target_date, reminder_window, status, attempts, last_error, sent_at, updated_at)
    VALUES (?, ?, ?, ?, 'sent', 1, NULL, ?, ?)
    ON CONFLICT(subscription_id, target_date, reminder_window) DO UPDATE SET
      status = 'sent',
      attempts = subscription_reminder_sends.attempts + 1,
      last_error = NULL,
      sent_at = excluded.sent_at,
      updated_at = excluded.updated_at
  `).bind(userId, decision.subscriptionId, decision.targetDate, window, timestamp, timestamp)));
}

/**
 * Records a delivery that did not happen, against the window that produced the message only.
 *
 * The other matching windows stay untouched because nothing reached anyone, and the row itself does
 * not suppress a resend. Its whole job is to make the failure visible without wrangler tail.
 */
export async function recordRenewalReminderFailure(
  env: Env,
  userId: string,
  decision: RenewalReminderDecision,
  error: unknown,
): Promise<void> {
  const timestamp = nowIso();
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_RECORDED_ERROR_LENGTH);
  await env.DB.prepare(`
    INSERT INTO subscription_reminder_sends (user_id, subscription_id, target_date, reminder_window, status, attempts, last_error, sent_at, updated_at)
    VALUES (?, ?, ?, ?, 'failed', 1, ?, NULL, ?)
    ON CONFLICT(subscription_id, target_date, reminder_window) DO UPDATE SET
      status = 'failed',
      attempts = subscription_reminder_sends.attempts + 1,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).bind(userId, decision.subscriptionId, decision.targetDate, decision.firedWindow, message, timestamp).run();
}

/** Recent renewal deliveries that did not go out, newest first. */
export async function listRenewalReminderFailures(env: Env, userId: string, limit = 20): Promise<RenewalReminderFailureRow[]> {
  const result = await env.DB.prepare(`
    SELECT subscription_id, target_date, reminder_window, attempts, last_error, updated_at
    FROM subscription_reminder_sends
    WHERE user_id = ? AND status = 'failed'
    ORDER BY updated_at DESC
    LIMIT ?
  `).bind(userId, limit).all<RenewalReminderFailureRow>();
  return result.results;
}
