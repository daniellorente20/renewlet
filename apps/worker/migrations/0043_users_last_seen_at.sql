-- users.last_seen_at answers "is this deployment still being used, and by whom" after the
-- three days Cloudflare keeps Worker logs. Only an internal user id and a timestamp; no
-- request, no address, no subscription fact.
--
-- The column stays out of USER_COLUMNS on purpose, so it never reaches the session payload,
-- the admin user list or a cloud backup export.
ALTER TABLE users ADD COLUMN last_seen_at TEXT;
