# Who is using this deployment

Renewlet records two things about people, and nothing else: that a login was resolved, and when an
account was last active. Both are keyed by the internal user id (`usr_...`). Neither carries a name,
an email address, an IP address, a user agent, a country, a subscription name or an amount.

## The durable answer: `users.last_seen_at`

Cloudflare keeps Worker logs for three days on the free plan, so the log cannot answer "has anyone
used this in the last month". The `users.last_seen_at` column can.

`requireAuth` stamps it on authenticated requests only, and at most once every fifteen minutes per
account. That throttle is the point: without it every read-only API call would become a D1 write and
buy no new information, because "did they use it this quarter of an hour" is all the question needs.
The very first authenticated request after a login always writes, because the column starts empty.

Run this against the live database to see who is still around:

```bash
pnpm exec wrangler d1 execute DB --remote --config wrangler.jsonc \
  --command "SELECT id, last_seen_at FROM users ORDER BY last_seen_at DESC"
```

An account that has never signed in since the column was added shows `last_seen_at` as null and
sorts last.

A failed write here never reaches the person making the request. It is logged as
`last_seen_touch_failed` and swallowed: this is telemetry, and telemetry does not get to take the
application down. If that line shows up, the usual cause is a Worker version running ahead of its
migration, and the error message names the missing column.

## The live answer: the login log

Every resolved login writes one structured line. Cloudflare indexes the fields of a logged object,
so both of these are filterable in Workers Logs:

```json
{ "event": "login", "ok": true, "user_id": "usr_abc123" }
{ "event": "login", "ok": false }
```

Filter on `event = login` in the dashboard, or on `ok = false` alone to see failed attempts.

A login counts as resolved when a session is issued. A password login that returns `mfa_required`
has not resolved yet; the completion is logged when the second factor or the passkey succeeds.

The failure line carries no identity at all, and that is deliberate rather than an oversight. People
type their password into the email box often enough that recording the identifier someone tried
would eventually put a password in a log. Knowing that a failed attempt happened at a given moment
is worth having; knowing who it claimed to be is not worth that risk.

## Reading the log around the cron

The cron trigger runs every minute and writes several lines per pass, so a human request is easy to
lose in the volume. Filter by `event` rather than scrolling.
