-- Deduplication and outcome record for the per-subscription renewal event.
--
-- target_date is part of the key on purpose. Without it a window would be consumed once and never
-- again: after the 30 day warning for a subscription is written, next cycle's 30 day warning would
-- be suppressed forever, silently. With target_date the record resets by itself every cycle.
--
-- status is what keeps a failure from being invisible. Only 'sent' rows suppress a resend, so a
-- 'failed' row records what went wrong without swallowing the warning it failed to deliver.
CREATE TABLE IF NOT EXISTS subscription_reminder_sends (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  target_date TEXT NOT NULL,
  reminder_window INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  -- NULL until a delivery actually succeeds, so it never reads as a send that did not happen.
  sent_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, target_date, reminder_window)
);

CREATE INDEX IF NOT EXISTS idx_subscription_reminder_sends_user
  ON subscription_reminder_sends (user_id, subscription_id, target_date);

-- Answers "what failed and when" without scanning the table as it grows across cycles.
CREATE INDEX IF NOT EXISTS idx_subscription_reminder_sends_status
  ON subscription_reminder_sends (user_id, status, updated_at DESC);
