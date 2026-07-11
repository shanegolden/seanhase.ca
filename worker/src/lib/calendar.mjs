// Sean's external calendar: fetch + cache + fail-CLOSED policy.
//
// Slot browsing:  cache fresh (<5 min) -> use it; else fetch; on failure use
//                 last-known-good if <24h old (degraded), else report unavailable
//                 (no slots offered - never fail-open into double-booking Sean).
// Booking commit: force a FRESH fetch (bypass cache); on failure fall back to
//                 last-known-good <24h; else reject the booking (503).

import { extractBusy } from './ical-busy.mjs';

const FRESH_MS = 5 * 60_000;
const MAX_STALE_MS = 24 * 3_600_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_ICS_BYTES = 5_000_000;

/**
 * @returns {{ok:true, busy:Array, degraded:boolean} | {ok:false, reason:string}}
 */
export async function getBusy(db, settings, rangeStartIso, rangeEndIso, { forceFresh = false } = {}) {
  const url = settings.calendarFeedUrl;
  if (!url) return { ok: true, busy: [], degraded: false }; // no feed configured: only internal bookings block

  // The cache belongs to ONE feed URL. If Sean changes the URL, everything the
  // old feed produced is invalid immediately, including the last-known-good
  // fallback (serving another calendar's busy data would double-book him).
  let cache = await db.prepare('SELECT * FROM ical_cache WHERE id = 1').first();
  if (cache && cache.url !== url) cache = null;
  const now = Date.now();
  const cacheAge = cache && cache.fetched_at ? now - new Date(cache.fetched_at).getTime() : Infinity;

  let icsText = null;
  let degraded = false;

  if (!forceFresh && cache && cache.ok && cacheAge < FRESH_MS) {
    icsText = cache.payload;
  } else {
    try {
      icsText = await fetchIcs(url);
      await db.prepare(
        'INSERT INTO ical_cache (id, url, fetched_at, ok, payload, last_error, last_error_at) VALUES (1, ?, ?, 1, ?, NULL, NULL) '
        + 'ON CONFLICT(id) DO UPDATE SET url = excluded.url, fetched_at = excluded.fetched_at, ok = 1, payload = excluded.payload',
      ).bind(url, new Date(now).toISOString(), icsText).run();
    } catch (e) {
      const error = String(e && e.message || e).slice(0, 300);
      await db.prepare(
        'INSERT INTO ical_cache (id, url, ok, last_error, last_error_at) VALUES (1, ?, 0, ?, ?) '
        + 'ON CONFLICT(id) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at',
      ).bind(url, error, new Date(now).toISOString()).run();
      if (cache && cache.payload && cacheAge < MAX_STALE_MS) {
        icsText = cache.payload; // last known good FROM THIS URL, degraded
        degraded = true;
      } else {
        return { ok: false, reason: `calendar feed unavailable: ${error}` };
      }
    }
  }

  try {
    const busy = extractBusy(icsText, rangeStartIso, rangeEndIso, settings.timezone);
    return { ok: true, busy, degraded };
  } catch (e) {
    return { ok: false, reason: `calendar feed unparseable: ${String(e.message || e).slice(0, 200)}` };
  }
}

async function fetchIcs(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'text/calendar, text/plain, */*' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_ICS_BYTES) throw new Error('feed too large');
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('not an iCalendar feed');
    return text;
  } finally {
    clearTimeout(t);
  }
}

export async function calendarHealth(db, settings) {
  if (!settings.calendarFeedUrl) return { configured: false };
  const cache = await db.prepare('SELECT fetched_at, ok, last_error, last_error_at FROM ical_cache WHERE id = 1').first();
  return {
    configured: true,
    lastGoodFetch: cache && cache.ok ? cache.fetched_at : (cache ? cache.fetched_at : null),
    lastError: cache ? cache.last_error : null,
    lastErrorAt: cache ? cache.last_error_at : null,
  };
}
