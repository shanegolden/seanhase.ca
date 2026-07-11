# seanhase.ca — Build Plan v2 (post dual-review, 2026-07-10)

## Review resolution (Sonnet 5 + Opus 4.8, both verdicts: ship-with-tweaks)

Convergent blocker, ADOPTED with Opus's stronger fix:
- **D1 booking atomicity**: D1 has NO interactive transactions (verified). UNIQUE on
  slot start alone cannot stop OVERLAPPING bookings. Fix: one atomic conditional
  insert: `INSERT INTO bookings (...) SELECT :vals WHERE NOT EXISTS (SELECT 1 FROM
  bookings WHERE status='confirmed' AND slot_start < :end AND slot_end > :start)`,
  then require `meta.changes === 1` else 409. UNIQUE(slot_start) kept as backstop.

Adopted (both reviewers): iCal failure must fail toward safety — booking-time
revalidation does a cache-BYPASS fresh fetch; on fetch failure serve last-known-good
(≤24h stale, admin banner + alert); older than that, STOP offering slots with a
friendly message. Never treat a dead feed as "no busy blocks". Public widget labels
times with the clinic timezone.

Adopted (Opus): PAT lifecycle + fail-loud ops — store PAT expiry (fine-grained PATs
cap at 366 days), CMS countdown; daily Worker Cron Trigger health check emails alerts
(PAT <30d, iCal feed failing, mail send failures, publish failures). Publish surfaces
the COMMIT step's failure distinctly from the Pages BUILD step; publish retries on
stale-ref 409 (re-fetch SHA), idempotent. Draft images NOT permanent D1 blobs: temp
rows capped (≤2 MB each after client resize, ≤10 pending, purged on publish and after
7 days); repo-growth documented, CI uses shallow clone.

Adopted (Sonnet): PIPEDA privacy line + consent on both forms; retention setting with
auto-purge (default 12 months) for bookings/contact/mail_log; manage-token hardening
(≥128-bit random, rate-limited lookup, dead after appointment passes); forced password
change on first login + strength floor + self-service reset via Sean's verified email;
tests added for cancel-reopens-slot and overlap rejection.

Email (Opus #5, verified against current Cloudflare docs): sends to VERIFIED
destinations are free on all plans (covers "email Sean" for contact + bookings).
Arbitrary-recipient sending (client confirmations) exists but requires the Workers
PAID plan ($5/mo, 3k emails/mo) + sending-domain onboarding. Decision: MVP ships free
(Sean-only email + on-screen client confirmation with manage link + add-to-calendar);
the adapter supports `cf` and `resend` drivers so EITHER Workers Paid OR a Resend key
pasted in the CMS later unlocks client emails with zero code change. Presented as an
option in the P7 Shane batch.

Rejected with reasons:
- Collapse admin./api. hostnames (Sonnet): kept separate — same single Worker, zero
  marginal cost on Cloudflare, and it keeps the session cookie host isolated from the
  public API host.
- Replace self-auth with Cloudflare Access (Sonnet): rejected for self-containment —
  Sean owns his own login via the CMS instead of depending on Shane's Cloudflare org.
  PBKDF2 iterations will be MEASURED at implementation to fit the CPU budget (target
  100k, floor 25k) + pepper. Access stays documented in RUNBOOK as optional hardening.
- Cut the per-email .ics attachment (Opus): kept — cheap, complementary to the
  subscribe feed.

---

## 0. What we're building

A modern, sleek, fully responsive landing page for Sean Hase (massage therapy student
working toward RMT registration), at **seanhase.ca**, with:

1. **Public landing page** (GitHub Pages): hero, about (photo + bio), what-to-expect /
   services, booking widget, contact form, footer. Looks native on mobile.
2. **CMS backend** at **admin.seanhase.ca**: Sean logs in and edits every piece of text
   and every image on the site, uploads a new about photo, changes the notification
   email, manages booking settings and bookings.
3. **Contact form**: name + email + short message, emailed to Sean. Destination address
   editable in the CMS.
4. **Calendly-style booking**: public page shows real available slots. Sean syncs his
   external calendar (secret iCal URL), sets weekly availability windows, and sets
   "bumper" buffer minutes applied around pre-existing calendar events (example: event
   1pm-2pm + 15-min bumpers means next slot starts 2:15pm). Booking emails Sean, with a
   calendar (.ics) attachment. Clients get an on-screen confirmation with add-to-calendar
   and a tokenized manage link (cancel / rebook).

## 1. Hard constraints discovered (verified today)

- **Hosting mandate**: public site on **GitHub Pages** (static only, no server code).
- **gh CLI**: authed as `shanegolden`, scopes `repo, workflow` — can create the repo,
  push, enable Pages, run Actions. VERIFIED WORKING.
- **Cloudflare**: seanhase.ca zone is registered, on the same account as shanegolden.ca
  (matching NS pair jewel/remy). The old shanegolden.ca DNS token is **REVOKED** (API
  says Invalid API Token); the only valid token on hand is zone-scoped to blinkos.ai.
  → **All Cloudflare actions (DNS, Workers deploy, D1, Email Routing) are blocked until
  Shane mints one token.** Plan defers every Cloudflare-dependent step to a single
  batched ask, with everything pre-built and pre-verified locally first.
- **Email sending without any new third-party account**: Cloudflare Email Routing +
  Email Workers `send_email` binding can send ONLY to **verified destination
  addresses** (fine for notifying Sean; NOT for arbitrary client addresses).
  Client-facing email is therefore out of MVP scope; the design includes a provider
  adapter so a Resend API key pasted into the CMS later unlocks client emails with no
  code change.
- **Workers free tier**: ~10ms CPU per request → password hashing tuned to PBKDF2
  (10k iterations) + server-side pepper (Worker secret) + strict rate limiting +
  lockout, instead of heavy KDF settings that would blow the CPU budget.
- **Title protection**: Sean is NOT yet an RMT. "RMT" / "Registered Massage Therapist"
  are protected titles in Canada. All default copy says student / in-training. Copy is
  CMS-editable so Sean flips it the day he registers. Guide will flag this.

## 2. Architecture

```
seanhase.ca          → GitHub Pages (static, baked HTML)  [DNS: A/CNAME → GitHub]
www.seanhase.ca      → GitHub Pages redirect
admin.seanhase.ca    → Cloudflare Worker (serves admin SPA + same-origin API)
api.seanhase.ca      → same Worker (public API for booking/contact, CORS-locked)
```

**One Worker** (`seanhase-api`) with static assets (admin SPA) + API routes.
**D1 (SQLite)** for all data: settings, content drafts, sessions, bookings,
availability windows, blackout dates, ical cache, email outbox log, login attempts.
**No KV/R2 needed** (R2 requires a payment card; images live in the git repo).

### Content publishing model (SEO-first)

- Source of truth for PUBLISHED content: `site/content/content.json` + `site/assets/img/*`
  in the GitHub repo.
- CMS "Save" writes a draft to D1; "Publish" commits content.json + changed images to
  the repo in ONE commit (GitHub Git Trees API), which triggers the Pages build.
- Pages build = tiny node script that bakes content.json into the HTML template
  (static text in the served HTML — real SEO, zero runtime content dependency).
- CMS shows publish progress by polling the Pages build status, and shows "Live" when done.
- If the Worker is ever down, the public page still fully loads; only the booking
  widget and contact form degrade with a friendly message.

### Booking engine (the hard core — built as a pure, unit-tested module)

Inputs:
- Weekly availability windows (per weekday, multiple windows/day) + date-specific
  overrides/blackouts.
- Appointment duration (e.g. 60m), slot granularity (e.g. 30m), bumper minutes,
  minimum lead time (hours), booking horizon (days), timezone (IANA, CMS-set,
  default America/Vancouver).
- Busy blocks: (a) external iCal feed (secret URL from Google/Apple/Outlook, fetched
  server-side, cached ~5 min in D1, recurring events expanded with ical.js),
  (b) existing confirmed bookings in D1.

Algorithm: for each day in horizon → windows minus (busy blocks each padded by bumper
on both sides) → enumerate slot starts on the granularity grid where [start,
start+duration] fits fully inside remaining free intervals and start ≥ now + lead time.
All math in the clinic timezone via luxon (DST-correct).

Booking write path (v2, D1-real): single atomic conditional INSERT with an overlap
guard in the statement itself (`WHERE NOT EXISTS` on confirmed bookings overlapping
[start, end)) + `meta.changes === 1` check, UNIQUE(slot_start) backstop; immediately
before the insert, a cache-BYPASS fresh iCal fetch revalidates against Sean's real
calendar. On iCal fetch failure: last-known-good ≤24h with admin banner, else block
new bookings (fail-closed) + alert.
On success: email Sean (with .ics attach), return confirmation + manage token.
Sean's calendar gets bookings two ways: the .ics attachment in each notification, and
a private iCal subscribe feed (tokenized URL) he adds to Google/Apple Calendar once —
then every new booking appears in his calendar automatically.

### Email

Adapter interface `sendMail({to, subject, html, icsAttachment?})` with two drivers:
1. `cf-send-email` (default): Email Workers binding; sends to Sean's verified address.
   Changing the address in CMS calls the Cloudflare API to add the new destination
   (Cloudflare emails the verification link automatically); CMS shows
   pending/verified status.
2. `resend`: activated the moment an API key is pasted into CMS settings; unlocks
   client-facing confirmation emails (manage link). Zero code change later.
Every send is also logged to a D1 `mail_log` table (subject, to, status) so sends are
verifiable end-to-end in tests and in the CMS.

### Admin auth

Single user (Sean). PBKDF2-SHA256 (10k iters) + per-user salt + pepper from Worker
secret; HttpOnly Secure SameSite=Lax session cookie (random 256-bit, SHA-256-hashed in
D1, 30-day rolling). Rate limits: 5 failed logins / 15 min per IP + account lockout
(15 min). Password change + email change in CMS. Initial strong password generated at
provision time, delivered to Shane.

### Repo layout (monorepo `shanegolden/seanhase.ca`)

```
site/            static public site (template.html, css, js, content/, assets/img/)
site/build.mjs   bakes content.json into index.html (runs in CI + locally)
worker/          Cloudflare Worker (API + serves admin SPA static assets)
worker/src/lib/slots.mjs   pure booking engine (unit-tested, no I/O)
admin/           admin SPA source (Preact+htm, esbuild-bundled into worker assets)
tests/           vitest unit+integration; playwright e2e
.github/workflows/  pages-deploy.yml (build site → Pages), ci.yml (tests on push)
docs/            PLAN.md, RUNBOOK.md, SEAN-GUIDE.md (plain-English CMS manual)
```

## 3. Phases (each run through the 9-step loop; Sonnet QC pre-impl on nontrivial ones)

- **P0 Scaffold**: repo, tooling, CI skeleton, D1 schema + migrations. Local wrangler
  dev environment proven (D1 local, assets serving).
- **P1 Booking engine**: `slots.mjs` pure module + exhaustive unit tests: bumpers
  (the 1pm/1h/15m → 2:15pm example verbatim as a test), overlapping events, recurring
  events, all-day events, DST spring/fall boundaries, lead time, horizon, granularity
  vs duration mismatches, windows crossing midnight (rejected by validation), blackout
  dates, double-book rejection.
- **P2 Worker API**: D1 schema; auth (login/logout/session/rate-limit/lockout);
  settings CRUD; content draft CRUD; image upload (client-resized → repo commit on
  publish); publish pipeline (Git Trees commit + Pages status poll); public endpoints:
  GET slots, POST booking, POST contact (+ honeypot & rate limit), GET/POST manage
  (cancel) by token; Sean's bookings list/cancel; iCal ingest + cache; bookings
  subscribe feed; email adapter + mail_log. CORS locked to site origins.
- **P3 Public site**: design system (palette from Sean's photo: charcoal, warm
  off-white, soft aqua accent echoing the COAST logo; Manrope/Inter type; generous
  whitespace; subtle scroll animations); hero, about, services/what-to-expect, booking
  widget (month/day picker → slot grid → form → confirmation + add-to-calendar +
  manage link), contact form, footer; fully responsive (360px → 4k), reduced-motion
  respected, semantic HTML + meta/OG tags. NO em dashes anywhere in copy.
- **P4 Admin CMS**: login; dashboard (upcoming bookings, quick stats); Content editor
  (every text block + image upload with client-side resize/crop preview); Booking
  settings (windows editor, duration/granularity/bumpers/lead/horizon/timezone,
  calendar feed URL with "test fetch" button, blackouts); Bookings (list, cancel);
  Settings (notification email w/ verification status, password change, email provider
  key, publish button + status). Same responsive bar as public site.
- **P5 Local E2E verification**: wrangler dev (local D1) + built site served locally;
  Playwright suite (book happy path incl. slot disappearing after booking, double-book
  race returns 409, bumper math visible in UI, contact form → mail_log row, CMS edit →
  local publish → page shows new text, login rate-limit); PLUS live browser-pane
  walkthrough desktop AND mobile (375px) of every page and flow, screenshots.
- **P6 Deploy A (no Cloudflare needed)**: create GitHub repo, push, enable Pages +
  Actions; site live at shanegolden.github.io/seanhase.ca; CI green.
- **P7 The single Shane batch**: exact click-by-click to mint (a) one Cloudflare API
  token (Zone DNS edit + Workers scripts + D1 + Email Routing addresses, scoped) and
  (b) one GitHub fine-grained PAT (contents:write on the one repo, for the Worker's
  publish pipeline; the gh CLI token stays local-only).
- **P8 Deploy B (after token)**: wrangler deploy + D1 migrate + secrets; custom domains
  admin./api.seanhase.ca; Email Routing enable + Sean's destination address; DNS for
  apex + www → GitHub Pages; Pages custom domain + HTTPS enforce; then FULL live
  re-verification in browser desktop+mobile on the real domain (real booking, real
  email to a test-then-real destination, CMS publish round-trip on prod).
- **P9 Docs + handoff**: RUNBOOK.md (ops), SEAN-GUIDE.md (plain English, screenshots),
  memory files for future sessions, final report to Shane.

## 4. Testing / regression-needle posture (project-native)

- vitest unit suite on the slots engine (the needle set for all booking logic).
- vitest integration on Worker routes via wrangler's workers pool (auth, booking
  atomicity, contact, publish dry-run against a mock GitHub).
- Playwright e2e as CI job (desktop + mobile viewport projects).
- CI runs on every push (repo Actions); Pages deploy gated on CI green for site changes.
- Every future change to this project ships with a test in the same suites.

## 5. Risks / open questions (carried into review)

1. Timezone default (America/Vancouver guessed from COAST shirt; CMS-editable; confirm
   with Shane at handoff, not a blocker).
2. Workers free CPU limit vs PBKDF2 — mitigated (10k iters + pepper + rate limit); can
   bump to Workers paid later for stronger KDF.
3. Client emails limited to on-screen confirmation until a Resend key exists (documented).
4. iCal feeds (Google secret URL) update with lag (Google publishes changes within
   minutes usually; cache 5 min) — bumper logic runs on booking-time revalidation too,
   so a race window exists if Sean's calendar changes seconds before a booking;
   accepted + documented (Calendly has the same fundamental race).
5. GitHub Pages build latency (~60-90s) between CMS publish and live text; CMS shows
   status so it's not confusing.
6. The gh CLI's token is used ONLY from this PC for repo creation/push; the Worker gets
   a least-privilege fine-grained PAT from Shane (P7).
7. Cloudflare account plan assumptions: Workers free, D1 free, Email Routing free all
   default-available. Custom domains for Workers require the zone on the same account —
   confirmed same account as shanegolden.ca by NS pair (will hard-verify with the new
   token before deploy).
