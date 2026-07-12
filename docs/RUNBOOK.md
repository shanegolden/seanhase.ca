# RUNBOOK — seanhase.ca ops

## Moving parts

| Thing | Lives | Managed by |
|---|---|---|
| seanhase.ca (public) | GitHub Pages, repo `shanegolden/seanhase.ca` | Pages deploy workflow on push to main |
| api.seanhase.ca + admin.seanhase.ca | Cloudflare Worker `seanhase-api` | `wrangler deploy` from `worker/` |
| Database | Cloudflare D1 `seanhase` | `wrangler d1 migrations apply seanhase --remote` |
| DNS | Cloudflare zone seanhase.ca | apex + www → GitHub Pages; admin/api → Worker custom domains |
| Email out | Cloudflare Email Routing (verified destinations, free) | notify address managed in CMS |

## Secrets (Worker, set via `wrangler secret put`)

- `PEPPER` — password-hash pepper. Losing it invalidates the stored password hash;
  recover via the reset-by-email flow after setting a new pepper, or re-bootstrap.
- `GITHUB_PAT` — CURRENTLY Shane's gh CLI OAuth token (deployed 2026-07-11; works,
  no fixed expiry, but broader scope than needed and dies if `gh auth login` is
  re-run on Shane's PC). RECOMMENDED SWAP when convenient: fine-grained PAT,
  contents:read+write + actions:read on ONLY this repo (max lifetime 366 days),
  `wrangler secret put GITHUB_PAT`, then set the expiry date in CMS Settings so
  the daily health check emails Sean at <30 days. Publish failures are loud
  either way (CMS banner + daily alert email).
- `CF_API_TOKEN` + `CF_ACCOUNT_ID` (optional) — lets the CMS auto-register a new
  notification address as an Email Routing verified destination when Sean changes it.
  Without it, add destinations manually in the Cloudflare dashboard.
- `RESEND_API_KEY` (optional) — unlocks client-facing email (confirmations with the
  manage link). Alternative: Workers Paid ($5/mo) + Email Service domain onboarding.

## Daily health check (Worker cron, 15:00 UTC)

Emails Sean when: the iCal feed is failing or degraded, the publish PAT is <30 days
from expiry, or any email failed in the last 24h. Also purges: expired sessions, old
rate-limit rows, draft images >7 days, and bookings/contact messages/mail logs older
than the CMS retention setting (default 12 months, PIPEDA posture).

## Fail-closed rules (by design, do not "fix" into fail-open)

- iCal feed unreachable: last-known-good cache serves for up to 24h (admin banner +
  alert email); older than that, the widget stops offering slots entirely. A dead
  calendar must never mean "Sean looks free".
- Every booking POST re-fetches the feed fresh (cache bypass) before the atomic
  insert. The insert itself is a conditional INSERT with an overlap guard;
  `meta.changes === 0` → 409. Partial UNIQUE index on confirmed slot_start backstops.
- Changing the feed URL invalidates the cache immediately (keyed by URL).

## Deploy auth (how this was shipped)

Cloudflare actions run through the wrangler OAuth login on Shane's PC
(`wrangler whoami` shows shane@shanegolden.ca; token auto-refreshes). Its scopes
cover Workers, D1, custom domains, and Email Routing, but NOT plain DNS record
edits, which is why the apex/www records for GitHub Pages were added by hand.

## Common tasks

- Deploy worker: `cd worker && npx wrangler deploy`
- Remote DB migrate: `npx wrangler d1 migrations apply seanhase --remote --config worker/wrangler.toml`
- Sean locked out: he clicks "Forgot password?" (reset link goes to the notification
  email). Nuclear option: `wrangler d1 execute seanhase --remote --command "DELETE FROM admin_user"`
  then admin.seanhase.ca shows first-time setup again (bookings/content untouched).
- Roll back site content: revert the CMS-publish commit in the repo; Pages redeploys.
- Site build broken: Actions tab → deploy-pages logs. CMS shows build_failed status.

## Security posture

- Admin auth: PBKDF2-SHA256 100k + per-user salt + PEPPER secret; account lockout
  (5 fails/15 min) + per-IP login throttle (20/15 min); sessions are 256-bit tokens
  stored hashed, HttpOnly SameSite=Lax cookies; CSRF custom-header required on all
  mutating admin routes; admin routes only served on the admin hostname.
- Public endpoints are rate-limited per IP (bookings 15/h, contact 3/15min,
  manage-token lookups 30/15min). Contact form has a honeypot. Manage tokens are
  128-bit, stored hashed, single-booking scope.
- Optional hardening if ever needed: put Cloudflare Access in front of
  admin.seanhase.ca (free) as a second factor.

## Known limitations

- Client-facing email (booking confirmation to the client) requires Resend key or
  Workers Paid; until then clients get the on-screen confirmation + calendar file +
  manage link.
- CMS publish → live has ~60-90s Pages build latency (status shown in CMS).
- Calendar race: a busy block added to Sean's calendar seconds before a booking can
  slip through (same fundamental race as Calendly). Bumpers + fresh-fetch minimize it.
- Repo grows with each published image (git history). Fine at this scale.
