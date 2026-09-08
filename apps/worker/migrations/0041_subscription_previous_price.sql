-- price_note compares the current amount against the one charged in the previous cycle.
-- All three columns stay NULL until price or currency actually change, which is what lets the
-- renewal event tell "primer cobro" apart from "sin datos del ciclo anterior".
--
-- previous_price_changed_at is what stops a monthly reminder from firing every month forever after
-- a single price rise: the rise only counts while the change still falls inside the cycle that is
-- about to renew.
ALTER TABLE subscriptions ADD COLUMN previous_price TEXT;
ALTER TABLE subscriptions ADD COLUMN previous_price_currency TEXT;
ALTER TABLE subscriptions ADD COLUMN previous_price_changed_at TEXT;
