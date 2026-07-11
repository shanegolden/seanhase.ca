import { describe, it, expect } from 'vitest';
import { extractBusy } from '../worker/src/lib/ical-busy.mjs';

const TZ = 'America/Vancouver';
const RANGE = ['2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z'];

const VTZ = `BEGIN:VTIMEZONE
TZID:America/Vancouver
BEGIN:DAYLIGHT
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
TZNAME:PDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
TZNAME:PST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;

const wrap = (events) => `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//test//EN
${VTZ}
${events}
END:VCALENDAR`.replace(/\n/g, '\r\n');

describe('extractBusy', () => {
  it('converts a TZID event to correct UTC (PDT = UTC-7 in July)', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e1
DTSTART;TZID=America/Vancouver:20260713T130000
DTEND;TZID=America/Vancouver:20260713T140000
SUMMARY:Dentist
END:VEVENT`), ...RANGE, TZ);
    expect(busy).toEqual([
      { start: '2026-07-13T20:00:00Z', end: '2026-07-13T21:00:00Z', summary: 'Dentist' },
    ]);
  });

  it('handles UTC (Z) events directly', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e2
DTSTART:20260713T200000Z
DTEND:20260713T210000Z
SUMMARY:Call
END:VEVENT`), ...RANGE, TZ);
    expect(busy[0].start).toBe('2026-07-13T20:00:00Z');
  });

  it('interprets floating times in the clinic timezone', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e3
DTSTART:20260713T130000
DTEND:20260713T140000
SUMMARY:Floating
END:VEVENT`), ...RANGE, TZ);
    expect(busy[0].start).toBe('2026-07-13T20:00:00Z'); // 13:00 PDT
  });

  it('expands weekly recurrence with COUNT and honors EXDATE', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e4
DTSTART;TZID=America/Vancouver:20260706T100000
DTEND;TZID=America/Vancouver:20260706T110000
RRULE:FREQ=WEEKLY;COUNT=4
EXDATE;TZID=America/Vancouver:20260720T100000
SUMMARY:Class
END:VEVENT`), ...RANGE, TZ);
    const days = busy.map((b) => b.start.slice(0, 10));
    expect(days).toEqual(['2026-07-06', '2026-07-13', '2026-07-27']); // 20th excluded
  });

  it('honors a RECURRENCE-ID override that moves one occurrence', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e5
DTSTART;TZID=America/Vancouver:20260706T100000
DTEND;TZID=America/Vancouver:20260706T110000
RRULE:FREQ=WEEKLY;COUNT=2
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:e5
RECURRENCE-ID;TZID=America/Vancouver:20260713T100000
DTSTART;TZID=America/Vancouver:20260713T150000
DTEND;TZID=America/Vancouver:20260713T160000
SUMMARY:Standup (moved)
END:VEVENT`), ...RANGE, TZ);
    const starts = busy.map((b) => b.start);
    expect(starts).toContain('2026-07-06T17:00:00Z'); // 10:00 PDT normal
    expect(starts).toContain('2026-07-13T22:00:00Z'); // moved to 15:00 PDT
    expect(starts).not.toContain('2026-07-13T17:00:00Z'); // original time gone
  });

  it('blocks the whole clinic-local day for all-day events', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e6
DTSTART;VALUE=DATE:20260714
DTEND;VALUE=DATE:20260715
SUMMARY:Away
END:VEVENT`), ...RANGE, TZ);
    expect(busy[0].start).toBe('2026-07-14T07:00:00Z'); // local midnight PDT
    expect(busy[0].end).toBe('2026-07-15T07:00:00Z');
  });

  it('skips TRANSPARENT and CANCELLED events', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e7
DTSTART:20260713T200000Z
DTEND:20260713T210000Z
TRANSP:TRANSPARENT
SUMMARY:Free block
END:VEVENT
BEGIN:VEVENT
UID:e8
DTSTART:20260714T200000Z
DTEND:20260714T210000Z
STATUS:CANCELLED
SUMMARY:Cancelled thing
END:VEVENT`), ...RANGE, TZ);
    expect(busy).toEqual([]);
  });

  it('clips events to the requested range and drops outsiders', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e9
DTSTART:20260630T230000Z
DTEND:20260701T010000Z
SUMMARY:Spans range start
END:VEVENT
BEGIN:VEVENT
UID:e10
DTSTART:20260901T100000Z
DTEND:20260901T110000Z
SUMMARY:Outside
END:VEVENT`), ...RANGE, TZ);
    expect(busy).toHaveLength(1);
    expect(busy[0].summary).toBe('Spans range start');
  });

  it('a recurring event that started before the range still yields occurrences inside it', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e11
DTSTART;TZID=America/Vancouver:20250106T100000
DTEND;TZID=America/Vancouver:20250106T110000
RRULE:FREQ=WEEKLY
SUMMARY:Long running
END:VEVENT`), ...RANGE, TZ);
    expect(busy.length).toBeGreaterThanOrEqual(4); // every Monday in July 2026
    expect(busy[0].start.slice(0, 10)).toBe('2026-07-06');
  });

  it('throws on malformed ics text', () => {
    expect(() => extractBusy('not an ics file', ...RANGE, TZ)).toThrow();
  });

  it('all-day event without DTEND defaults to blocking exactly one day', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e12
DTSTART;VALUE=DATE:20260714
SUMMARY:Away no end
END:VEVENT`), ...RANGE, TZ);
    expect(busy[0].start).toBe('2026-07-14T07:00:00Z'); // local midnight PDT
    expect(busy[0].end).toBe('2026-07-15T07:00:00Z'); // full day, NOT zero-length
  });

  it('all-day event with DTEND equal to DTSTART still blocks a full day (defensive floor)', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e13
DTSTART;VALUE=DATE:20260714
DTEND;VALUE=DATE:20260714
SUMMARY:Zero-length allday
END:VEVENT`), ...RANGE, TZ);
    expect(busy[0].end).toBe('2026-07-15T07:00:00Z');
  });

  it('a cancelled single occurrence of a recurring event does not block', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e14
DTSTART;TZID=America/Vancouver:20260706T100000
DTEND;TZID=America/Vancouver:20260706T110000
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Weekly thing
END:VEVENT
BEGIN:VEVENT
UID:e14
RECURRENCE-ID;TZID=America/Vancouver:20260713T100000
DTSTART;TZID=America/Vancouver:20260713T100000
DTEND;TZID=America/Vancouver:20260713T110000
STATUS:CANCELLED
SUMMARY:Weekly thing
END:VEVENT`), ...RANGE, TZ);
    const days = busy.map((b) => b.start.slice(0, 10));
    expect(days).toEqual(['2026-07-06', '2026-07-20']); // the 13th is cancelled
  });

  it('a transparent (free) single occurrence of a recurring event does not block', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e15
DTSTART;TZID=America/Vancouver:20260706T100000
DTEND;TZID=America/Vancouver:20260706T110000
RRULE:FREQ=WEEKLY;COUNT=2
SUMMARY:Weekly thing
END:VEVENT
BEGIN:VEVENT
UID:e15
RECURRENCE-ID;TZID=America/Vancouver:20260713T100000
DTSTART;TZID=America/Vancouver:20260713T100000
DTEND;TZID=America/Vancouver:20260713T110000
TRANSP:TRANSPARENT
SUMMARY:Weekly thing (free)
END:VEVENT`), ...RANGE, TZ);
    expect(busy.map((b) => b.start.slice(0, 10))).toEqual(['2026-07-06']);
  });

  it('a daily event running since 2008 still blocks every day in range', () => {
    const busy = extractBusy(wrap(`BEGIN:VEVENT
UID:e16
DTSTART;TZID=America/Vancouver:20080115T070000
DTEND;TZID=America/Vancouver:20080115T080000
RRULE:FREQ=DAILY
SUMMARY:Morning routine
END:VEVENT`), ...RANGE, TZ);
    expect(busy.length).toBeGreaterThanOrEqual(30); // every day of July 2026
    expect(busy[0].start.slice(0, 10)).toBe('2026-07-01'); // clipped to range start
  });

  it('fails CLOSED (throws) when a pathological recurrence cannot be expanded to the range', () => {
    expect(() => extractBusy(wrap(`BEGIN:VEVENT
UID:e17
DTSTART:20260601T000000Z
DTEND:20260601T000100Z
RRULE:FREQ=SECONDLY
SUMMARY:Hostile
END:VEVENT`), ...RANGE, TZ)).toThrow(/cap exceeded/);
  });
});
