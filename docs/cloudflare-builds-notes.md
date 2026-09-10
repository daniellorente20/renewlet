# Cloudflare Builds notes

State as of 10 September 2026.

## Branch builds do not use the same configuration

Cloudflare Builds does not apply the same build configuration on every branch. Everything below was read in the Cloudflare dashboard for the Worker on 10 September 2026.

Live values in `Settings` -> `Builds` that day:

| Setting | Value |
|---|---|
| Build command | `pnpm run build && pnpm cloudflare:migrations:guard` |
| Deploy command | `npx wrangler deploy` |
| Version command | `npx wrangler whoami && npx wrangler versions upload` |
| API token | the token created on 10 September 2026 |

### Build on the production branch

`#b97160f2`, branch `main`, commit `7ed6471`, the previous day at 16:31.

- Build command: `pnpm run build && pnpm cloudflare:migrations:guard`, the same one saved in the settings.
- Deploy command: `npx wrangler deploy`.
- API token: the token created on 10 September 2026, which did not yet exist when that build ran.

### Build on a branch that is not the production one

`#48233c90`, branch `chore/migration-guard`, commit `25a264d`, on 10 September at 07:34.

- Build command: `pnpm run build`, and nothing else. The log line reads `Executing user build command: pnpm run build`, so the migration guard never ran.
- Deploy command: `npx wrangler whoami && npx wrangler versions upload`.
- API token: the previously configured token. The newer token already existed when this build started.

### Last-used dates

In the user token list, the previously configured token shows a last-used date of 10 September 2026. The token created that same day has no last-used date at all.

The Worker has no preview environment either: the path `/workers/services/view/renewlet/preview/settings` answers `This environment does not exist on this Worker.`

## Three consequences

1. The migration guard runs on the production-branch build path only. A build on any other branch does not run it, so a green branch build is not evidence that the guard passes.
2. The token shown in `Settings` -> `Builds` applies to the production-branch path. Branch builds were seen still using the previously configured token, so changing that setting does not retire the older one.
3. Checking a change to the build configuration, or to the token, needs a build on the production branch. In this repository that means merging a pull request.

## The cause is not established

It is unknown whether the two paths hold separate configuration records, or whether the dashboard's per-build panel shows live values rather than the ones recorded for that build. It is also unknown whether the difference is permanent or whether the branch configuration is simply lagging behind the saved one. What is observed above is the whole of what was verified.
