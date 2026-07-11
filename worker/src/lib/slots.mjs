// Pure booking-slot engine. No I/O, no globals: everything comes in as arguments,
// so every rule here is unit-testable, including DST boundaries.
//
// All returned times are UTC ISO strings. All wall-clock reasoning (windows,
// blackouts, day boundaries) happens in the clinic's IANA timezone.

import { DateTime } from 'luxon';

/**
 * @param {object} args
 * @param {object} args.settings
 *   timezone       IANA zone, e.g. 'America/Vancouver'
 *   durationMin    appointment length
 *   granularityMin slot-start grid step, aligned to each window's start
 *   bumperMin      padding around EXTERNAL calendar events (both sides)
 *   bookingBufferMin padding around existing internal bookings (both sides)
 *   leadHours      minimum notice before a slot can start
 *   horizonDays    how many days ahead slots are offered (inclusive of today)
 * @param {Array<{weekday:number,startMin:number,endMin:number}>} args.windows
 *   weekday: 0=Sunday..6=Saturday (clinic-local); minutes since local midnight
 * @param {Array<string>} args.blackouts  clinic-local 'YYYY-MM-DD' dates fully closed
 * @param {Array<{start:string,end:string}>} args.busy      external events, UTC ISO
 * @param {Array<{start:string,end:string}>} args.bookings  confirmed bookings, UTC ISO
 * @param {string} args.now  UTC ISO
 * @returns {Array<{start:string,end:string}>} sorted, deduped available slots
 */
export function computeSlots({ settings, windows, blackouts = [], busy = [], bookings = [], now }) {
  const {
    timezone, durationMin, granularityMin, bumperMin = 0,
    bookingBufferMin = 0, leadHours = 0, horizonDays = 30,
  } = settings;

  validateSettings(settings);

  const nowDt = DateTime.fromISO(now, { zone: 'utc' });
  if (!nowDt.isValid) throw new Error(`invalid now: ${now}`);
  const earliestStartMs = nowDt.plus({ hours: leadHours }).toMillis();

  const blackoutSet = new Set(blackouts);

  // Blocked intervals in UTC ms, padded per their kind.
  const blocked = [
    ...toPaddedIntervals(busy, bumperMin),
    ...toPaddedIntervals(bookings, bookingBufferMin),
  ];

  const byWeekday = new Map();
  for (const w of windows) {
    validateWindow(w);
    if (!byWeekday.has(w.weekday)) byWeekday.set(w.weekday, []);
    byWeekday.get(w.weekday).push(w);
  }

  const todayLocal = nowDt.setZone(timezone).startOf('day');
  const out = [];
  const seen = new Set();

  for (let d = 0; d < horizonDays; d++) {
    const day = todayLocal.plus({ days: d });
    if (blackoutSet.has(day.toISODate())) continue;
    // luxon: weekday 1=Mon..7=Sun -> ours 0=Sun..6=Sat
    const wd = day.weekday % 7;
    const dayWindows = byWeekday.get(wd);
    if (!dayWindows) continue;

    for (const w of dayWindows) {
      // Window minutes are WALL-CLOCK local times: 9:00 means 9:00 on the clock
      // even on DST days, so set() (not duration addition) is required. On
      // DST-gap days luxon shifts nonexistent times forward, which is the safe
      // direction (never offers a phantom hour).
      const winStart = wallClock(day, w.startMin);
      const winEndMs = wallClock(day, w.endMin).toMillis();

      for (let m = 0; ; m += granularityMin) {
        const slotStart = winStart.plus({ minutes: m });
        const slotStartMs = slotStart.toMillis();
        const slotEndMs = slotStart.plus({ minutes: durationMin }).toMillis();
        if (slotEndMs > winEndMs) break;
        if (slotStartMs < earliestStartMs) continue;
        if (blocked.some((b) => slotStartMs < b.end && b.start < slotEndMs)) continue;

        const startIso = DateTime.fromMillis(slotStartMs, { zone: 'utc' }).toISO({ suppressMilliseconds: true });
        if (seen.has(startIso)) continue;
        seen.add(startIso);
        out.push({
          start: startIso,
          end: DateTime.fromMillis(slotEndMs, { zone: 'utc' }).toISO({ suppressMilliseconds: true }),
        });
      }
    }
  }

  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}

/** True if the exact requested slot start is currently offered. */
export function isSlotAvailable(requestedStartIso, args) {
  const want = DateTime.fromISO(requestedStartIso, { zone: 'utc' });
  if (!want.isValid) return false;
  const wantMs = want.toMillis();
  return computeSlots(args).some((s) => DateTime.fromISO(s.start, { zone: 'utc' }).toMillis() === wantMs);
}

function wallClock(day, minutes) {
  if (minutes === 1440) return day.plus({ days: 1 }).startOf('day'); // calendar-day math, DST-aware
  return day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 });
}

function toPaddedIntervals(items, padMin) {
  const pad = padMin * 60_000;
  const list = [];
  for (const it of items) {
    const s = DateTime.fromISO(it.start, { zone: 'utc' }).toMillis();
    const e = DateTime.fromISO(it.end, { zone: 'utc' }).toMillis();
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) continue; // skip malformed, never crash slot serving
    list.push({ start: s - pad, end: e + pad });
  }
  return mergeIntervals(list);
}

function mergeIntervals(list) {
  if (list.length <= 1) return list;
  list.sort((a, b) => a.start - b.start);
  const merged = [list[0]];
  for (let i = 1; i < list.length; i++) {
    const last = merged[merged.length - 1];
    if (list[i].start <= last.end) last.end = Math.max(last.end, list[i].end);
    else merged.push(list[i]);
  }
  return merged;
}

function validateSettings(s) {
  if (!s.timezone || !DateTime.local().setZone(s.timezone).isValid) {
    throw new Error(`invalid timezone: ${s.timezone}`);
  }
  for (const k of ['durationMin', 'granularityMin']) {
    if (!Number.isInteger(s[k]) || s[k] <= 0) throw new Error(`${k} must be a positive integer`);
  }
  for (const k of ['bumperMin', 'bookingBufferMin', 'leadHours', 'horizonDays']) {
    if (s[k] != null && (!Number.isFinite(s[k]) || s[k] < 0)) throw new Error(`${k} must be >= 0`);
  }
}

function validateWindow(w) {
  if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) throw new Error('weekday out of range');
  if (!Number.isInteger(w.startMin) || !Number.isInteger(w.endMin)
    || w.startMin < 0 || w.endMin > 1440 || w.endMin <= w.startMin) {
    throw new Error('window minutes invalid');
  }
}
