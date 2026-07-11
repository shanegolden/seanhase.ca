# seanhase.ca

Landing page + booking system + CMS for Sean Hase (massage therapy student, RMT in training).

## Architecture

| Piece | Where | What |
|---|---|---|
| Public site | GitHub Pages (this repo, `site/`) | Static, content baked at deploy by `site/build.mjs` |
| API + admin CMS | Cloudflare Worker (`worker/`) | Booking engine, contact form, publish pipeline, auth |
| Data | Cloudflare D1 | Bookings, settings, drafts, sessions, logs |
| Admin UI | `admin/` (Preact, bundled into Worker assets) | admin.seanhase.ca |

Content publishing: the CMS saves drafts to D1; "Publish" commits `site/content/content.json`
plus any uploaded images to this repo (Git Trees API, one commit), which triggers the
Pages deploy. The public page has zero runtime dependency on the Worker except the
booking widget and contact form.

Booking engine (`worker/src/lib/slots.mjs`): weekly windows, blackout dates, external
iCal busy sync (fail-closed), bumper padding around calendar events, buffer between
appointments, lead time, horizon, DST-correct in the clinic timezone. Double-booking is
prevented by a single conditional INSERT with an overlap guard (D1 has no interactive
transactions) plus a partial UNIQUE index backstop.

## Development

```
npm install
npm test                 # unit suites (slot engine, iCal parsing)
npx playwright test      # e2e: spins up wrangler dev + static site on its own ports
npm run dev:worker       # local API + admin at http://127.0.0.1:8787
API_BASE=http://127.0.0.1:8787 node site/build.mjs   # build site against local API
```

See `docs/PLAN.md` (build plan + review log), `docs/RUNBOOK.md` (ops), and
`docs/SEAN-GUIDE.md` (plain-English CMS manual).
