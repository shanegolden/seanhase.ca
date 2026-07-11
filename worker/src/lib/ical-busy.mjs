// Extracts busy intervals from a raw iCalendar (.ics) text within a UTC range.
// Pure: text in, [{start,end}] UTC ISO out. Used for Sean's external calendar feed.
//
// Rules:
// - CANCELLED events and TRANSP:TRANSPARENT ("show me as free") events do not block.
// - Recurring events are expanded (RRULE/RDATE/EXDATE and RECURRENCE-ID overrides).
// - All-day events block the entire clinic-local day(s).
// - Floating times (no timezone) are interpreted in the clinic timezone.

import ICAL from 'ical.js';
import { DateTime } from 'luxon';

// Iterating always starts at the event's own DTSTART (passing a custom start to
// ical.js re-anchors the recurrence grid and corrupts the expansion), so the cap
// must cover years of pre-range occurrences: 5000 daily occurrences ~= 13 years.
const MAX_OCCURRENCES_PER_EVENT = 5000;

export function extractBusy(icsText, rangeStartIso, rangeEndIso, clinicTimezone) {
  const rangeStart = DateTime.fromISO(rangeStartIso, { zone: 'utc' });
  const rangeEnd = DateTime.fromISO(rangeEndIso, { zone: 'utc' });
  if (!rangeStart.isValid || !rangeEnd.isValid || rangeEnd <= rangeStart) {
    throw new Error('invalid busy range');
  }

  const jcal = ICAL.parse(icsText);
  const comp = new ICAL.Component(jcal);

  // Register any VTIMEZONEs so TZID-referenced times convert correctly.
  for (const vtz of comp.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(new ICAL.Timezone(vtz));
    } catch { /* already registered or malformed; non-fatal */ }
  }

  // Group by UID: main events + their RECURRENCE-ID exception overrides.
  const mains = new Map();
  const exceptions = [];
  for (const v of comp.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(v, { strictExceptions: false });
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else mains.set(ev.uid, ev);
  }
  for (const ex of exceptions) {
    const main = mains.get(ex.uid);
    if (main) main.relateException(ex);
    else mains.set(`${ex.uid}#${ex.recurrenceId}`, ex); // orphan override: treat standalone
  }

  const busy = [];
  for (const ev of mains.values()) {
    if (isTransparentOrCancelled(ev)) continue;
    if (ev.isRecurring()) {
      expandRecurring(ev, rangeStart, rangeEnd, clinicTimezone, busy);
    } else {
      pushOccurrence(ev.startDate, ev.endDate, rangeStart, rangeEnd, clinicTimezone, busy, ev);
    }
  }

  busy.sort((a, b) => (a.start < b.start ? -1 : 1));
  return busy;
}

function isTransparentOrCancelled(ev) {
  const c = ev.component;
  const status = (c.getFirstPropertyValue('status') || '').toString().toUpperCase();
  const transp = (c.getFirstPropertyValue('transp') || '').toString().toUpperCase();
  return status === 'CANCELLED' || transp === 'TRANSPARENT';
}

function expandRecurring(ev, rangeStart, rangeEnd, clinicTimezone, busy) {
  const iterator = ev.iterator(); // anchored at DTSTART; see cap comment above
  // Occurrences that START up to 7 days before the range are still resolved, so a
  // multi-day event overlapping into the range is not missed.
  const skipBeforeMs = rangeStart.minus({ days: 7 }).toMillis();
  const rangeEndMs = rangeEnd.toMillis();
  let n = 0;
  let next;
  while ((next = iterator.next()) && n < MAX_OCCURRENCES_PER_EVENT) {
    n++;
    const nextStartMs = toUtcMillis(next, clinicTimezone);
    if (nextStartMs > rangeEndMs) break;
    if (nextStartMs < skipBeforeMs) continue;
    let details;
    try {
      details = ev.getOccurrenceDetails(next);
    } catch {
      continue; // EXDATE'd or unresolvable occurrence
    }
    pushOccurrence(details.startDate, details.endDate, rangeStart, rangeEnd, clinicTimezone, busy, ev);
  }
}

function pushOccurrence(startTime, endTime, rangeStart, rangeEnd, clinicTimezone, busy, ev) {
  if (!startTime) return;
  let startMs;
  let endMs;

  if (startTime.isDate) {
    // All-day: DATE values are floating dates; block the clinic-local day(s).
    const startDay = DateTime.fromISO(startTime.toString(), { zone: clinicTimezone }).startOf('day');
    // RFC5545: DTEND for DATE values is exclusive; default duration one day.
    const endDay = endTime
      ? DateTime.fromISO(endTime.toString(), { zone: clinicTimezone }).startOf('day')
      : startDay.plus({ days: 1 });
    startMs = startDay.toMillis();
    endMs = Math.max(endDay.toMillis(), startDay.plus({ days: 1 }).toMillis());
  } else {
    startMs = toUtcMillis(startTime, clinicTimezone);
    endMs = endTime ? toUtcMillis(endTime, clinicTimezone) : startMs;
    if (endMs <= startMs) endMs = startMs + 1; // zero-length: still a point block
  }

  // Clip to range; drop non-overlapping.
  if (endMs <= rangeStart.toMillis() || startMs >= rangeEnd.toMillis()) return;
  busy.push({
    start: DateTime.fromMillis(startMs, { zone: 'utc' }).toISO({ suppressMilliseconds: true }),
    end: DateTime.fromMillis(endMs, { zone: 'utc' }).toISO({ suppressMilliseconds: true }),
    summary: safeSummary(ev),
  });
}

function toUtcMillis(icalTime, clinicTimezone) {
  const zone = icalTime.zone;
  // Zoned (UTC or a registered VTIMEZONE/IANA zone): ical.js converts correctly.
  if (zone && zone !== ICAL.Timezone.localTimezone) {
    return icalTime.toUnixTime() * 1000;
  }
  // Floating: interpret the wall-clock time in the clinic timezone.
  const dt = DateTime.fromObject({
    year: icalTime.year, month: icalTime.month, day: icalTime.day,
    hour: icalTime.hour, minute: icalTime.minute, second: icalTime.second,
  }, { zone: clinicTimezone });
  return dt.toMillis();
}

function safeSummary(ev) {
  try {
    return (ev.summary || '').toString().slice(0, 120);
  } catch {
    return '';
  }
}
