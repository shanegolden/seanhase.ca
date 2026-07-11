import { describe, it, expect } from 'vitest';
import { computeSlots, isSlotAvailable } from '../worker/src/lib/slots.mjs';

// Clinic timezone for all tests. 2026 DST (America/Vancouver):
// spring forward Sun Mar 8 (2:00->3:00), fall back Sun Nov 1.
const TZ = 'America/Vancouver';

// 2026-07-13 is a Monday. July = PDT = UTC-7.
const MON = '2026-07-13';

const base = {
  settings: {
    timezone: TZ, durationMin: 60, granularityMin: 15,
    bumperMin: 15, bookingBufferMin: 15, leadHours: 0, horizonDays: 1,
  },
  windows: [{ weekday: 1, startMin: 9 * 60, endMin: 17 * 60 }], // Mon 9:00-17:00
  blackouts: [],
  busy: [],
  bookings: [],
  now: `${MON}T00:30:00-07:00`, // Monday 00:30 local
};

const starts = (slots) => slots.map((s) => s.start);
const utc = (local, offset = '-07:00') => new Date(`${local}${offset}`).toISOString().replace('.000Z', 'Z');

describe('computeSlots core grid', () => {
  it('offers grid-aligned slots that fit inside the window', () => {
    const slots = computeSlots(base);
    // starts 9:00..16:00 every 15m = 29 slots
    expect(slots).toHaveLength(29);
    expect(slots[0].start).toBe(utc(`${MON}T09:00:00`));
    expect(slots[0].end).toBe(utc(`${MON}T10:00:00`));
    expect(slots.at(-1).start).toBe(utc(`${MON}T16:00:00`)); // last fitting start
  });

  it('aligns the grid to the window start, not the hour', () => {
    const slots = computeSlots({
      ...base,
      settings: { ...base.settings, granularityMin: 30 },
      windows: [{ weekday: 1, startMin: 9 * 60 + 15, endMin: 12 * 60 }], // 9:15-12:00
    });
    expect(starts(slots)).toEqual([
      utc(`${MON}T09:15:00`), utc(`${MON}T09:45:00`), utc(`${MON}T10:15:00`),
      utc(`${MON}T10:45:00`),
    ]); // 11:15 would end 12:15 > 12:00
  });

  it('returns nothing with no windows', () => {
    expect(computeSlots({ ...base, windows: [] })).toEqual([]);
  });

  it('supports multiple windows in one day without duplicates', () => {
    const slots = computeSlots({
      ...base,
      windows: [
        { weekday: 1, startMin: 9 * 60, endMin: 11 * 60 },
        { weekday: 1, startMin: 10 * 60, endMin: 13 * 60 }, // overlaps the first
      ],
    });
    const set = new Set(starts(slots));
    expect(set.size).toBe(slots.length); // deduped
    expect(set.has(utc(`${MON}T10:00:00`))).toBe(true);
    expect(set.has(utc(`${MON}T12:00:00`))).toBe(true);
  });
});

describe("Shane's bumper example (event 1pm-2pm, 15-min bumpers)", () => {
  const withEvent = {
    ...base,
    busy: [{ start: utc(`${MON}T13:00:00`), end: utc(`${MON}T14:00:00`) }],
  };

  it('next available appointment after the event is exactly 2:15pm', () => {
    const slots = computeSlots(withEvent);
    const after = starts(slots).filter((s) => s >= utc(`${MON}T13:00:00`));
    expect(after[0]).toBe(utc(`${MON}T14:15:00`));
  });

  it('blocks 2:00pm and every start that would touch the padded block', () => {
    const s = new Set(starts(computeSlots(withEvent)));
    expect(s.has(utc(`${MON}T14:00:00`))).toBe(false);
    expect(s.has(utc(`${MON}T12:00:00`))).toBe(false); // ends 13:00, inside pad 12:45+
    expect(s.has(utc(`${MON}T12:45:00`))).toBe(false);
  });

  it('still allows a slot ending exactly at the pad start (11:45-12:45)', () => {
    const s = new Set(starts(computeSlots(withEvent)));
    expect(s.has(utc(`${MON}T11:45:00`))).toBe(true);
  });

  it('with zero bumper, 2:00pm is available again', () => {
    const s = new Set(starts(computeSlots({
      ...withEvent,
      settings: { ...base.settings, bumperMin: 0 },
    })));
    expect(s.has(utc(`${MON}T14:00:00`))).toBe(true);
    expect(s.has(utc(`${MON}T13:30:00`))).toBe(false); // overlaps the event itself
  });
});

describe('internal bookings', () => {
  it('existing confirmed bookings block their padded range', () => {
    const slots = computeSlots({
      ...base,
      bookings: [{ start: utc(`${MON}T10:00:00`), end: utc(`${MON}T11:00:00`) }],
    });
    const s = new Set(starts(slots));
    expect(s.has(utc(`${MON}T10:00:00`))).toBe(false);
    expect(s.has(utc(`${MON}T11:00:00`))).toBe(false); // 15m booking buffer
    expect(s.has(utc(`${MON}T11:15:00`))).toBe(true);
  });

  it('booking buffer is independent of external bumper', () => {
    const slots = computeSlots({
      ...base,
      settings: { ...base.settings, bumperMin: 60, bookingBufferMin: 0 },
      bookings: [{ start: utc(`${MON}T10:00:00`), end: utc(`${MON}T11:00:00`) }],
    });
    expect(new Set(starts(slots)).has(utc(`${MON}T11:00:00`))).toBe(true);
  });

  it('overlapping busy blocks merge instead of double-counting pads', () => {
    const slots = computeSlots({
      ...base,
      busy: [
        { start: utc(`${MON}T13:00:00`), end: utc(`${MON}T14:00:00`) },
        { start: utc(`${MON}T13:30:00`), end: utc(`${MON}T14:30:00`) },
      ],
    });
    const after = starts(slots).filter((x) => x >= utc(`${MON}T13:00:00`));
    expect(after[0]).toBe(utc(`${MON}T14:45:00`)); // 14:30 + 15m pad
  });
});

describe('lead time, horizon, blackouts, now', () => {
  it('filters slots inside the lead window', () => {
    const slots = computeSlots({
      ...base,
      settings: { ...base.settings, leadHours: 2 },
      now: `${MON}T10:07:00-07:00`,
    });
    expect(slots[0].start).toBe(utc(`${MON}T12:15:00`)); // first grid start >= 12:07
  });

  it('filters past slots on the current day', () => {
    const slots = computeSlots({ ...base, now: `${MON}T15:59:00-07:00` });
    expect(starts(slots)).toEqual([utc(`${MON}T16:00:00`)]);
  });

  it('offers nothing on blackout dates', () => {
    expect(computeSlots({ ...base, blackouts: [MON] })).toEqual([]);
  });

  it('respects the horizon (no slots beyond it)', () => {
    const slots = computeSlots({
      ...base,
      settings: { ...base.settings, horizonDays: 8 }, // Mon..next Mon
    });
    const days = new Set(slots.map((s) => s.start.slice(0, 10)));
    expect(days).toEqual(new Set(['2026-07-13', '2026-07-20'])); // both Mondays
  });

  it('busy events outside the horizon are ignored', () => {
    const slots = computeSlots({
      ...base,
      busy: [{ start: utc('2026-07-20T13:00:00'), end: utc('2026-07-20T14:00:00') }],
    });
    expect(slots).toHaveLength(29);
  });
});

describe('DST correctness', () => {
  it('spring forward day (Mar 8): 9am local is 16:00 UTC, full slot count', () => {
    const slots = computeSlots({
      ...base,
      windows: [{ weekday: 0, startMin: 9 * 60, endMin: 17 * 60 }], // Sunday
      now: '2026-03-08T00:30:00-08:00', // PST before the jump
    });
    expect(slots[0].start).toBe('2026-03-08T16:00:00Z'); // 9am PDT
    expect(slots).toHaveLength(29);
  });

  it('fall back day (Nov 1): 9am local is 17:00 UTC, full slot count', () => {
    const slots = computeSlots({
      ...base,
      windows: [{ weekday: 0, startMin: 9 * 60, endMin: 17 * 60 }],
      now: '2026-11-01T00:30:00-07:00', // PDT before the fall-back
    });
    expect(slots[0].start).toBe('2026-11-01T17:00:00Z'); // 9am PST
    expect(slots).toHaveLength(29);
  });

  it('a UTC-fixed busy event blocks the correct local time across DST', () => {
    // 20:00Z on Nov 1 = 12:00 PST
    const slots = computeSlots({
      ...base,
      windows: [{ weekday: 0, startMin: 9 * 60, endMin: 17 * 60 }],
      busy: [{ start: '2026-11-01T20:00:00Z', end: '2026-11-01T21:00:00Z' }],
      now: '2026-11-01T00:30:00-07:00',
    });
    const s = new Set(starts(slots));
    expect(s.has('2026-11-01T20:00:00Z')).toBe(false);
    expect(s.has('2026-11-01T21:15:00Z')).toBe(true); // 13:15 PST after pad
  });
});

describe('midnight-spanning and malformed inputs', () => {
  it('a busy event spanning midnight blocks the morning after', () => {
    const slots = computeSlots({
      ...base,
      // Sunday 22:00 -> Monday 09:30 local
      busy: [{ start: utc('2026-07-12T22:00:00'), end: utc(`${MON}T09:30:00`) }],
    });
    expect(slots[0].start).toBe(utc(`${MON}T09:45:00`)); // 9:30 + 15m pad
  });

  it('malformed busy items are skipped, never crash', () => {
    const slots = computeSlots({
      ...base,
      busy: [{ start: 'garbage', end: 'also-garbage' }, { start: utc(`${MON}T13:00:00`), end: utc(`${MON}T12:00:00`) }],
    });
    expect(slots).toHaveLength(29);
  });

  it('rejects invalid settings loudly', () => {
    expect(() => computeSlots({ ...base, settings: { ...base.settings, timezone: 'Not/AZone' } })).toThrow();
    expect(() => computeSlots({ ...base, settings: { ...base.settings, durationMin: 0 } })).toThrow();
    expect(() => computeSlots({ ...base, windows: [{ weekday: 9, startMin: 0, endMin: 60 }] })).toThrow();
  });
});

describe('isSlotAvailable (booking-time revalidation)', () => {
  it('true for an offered slot, false for a blocked or off-grid one', () => {
    expect(isSlotAvailable(utc(`${MON}T09:00:00`), base)).toBe(true);
    expect(isSlotAvailable(utc(`${MON}T09:07:00`), base)).toBe(false);
    const withEvent = { ...base, busy: [{ start: utc(`${MON}T13:00:00`), end: utc(`${MON}T14:00:00`) }] };
    expect(isSlotAvailable(utc(`${MON}T13:00:00`), withEvent)).toBe(false);
    expect(isSlotAvailable(utc(`${MON}T14:15:00`), withEvent)).toBe(true);
  });

  it('cancelling a booking reopens its slot', () => {
    const booked = { ...base, bookings: [{ start: utc(`${MON}T10:00:00`), end: utc(`${MON}T11:00:00`) }] };
    expect(isSlotAvailable(utc(`${MON}T10:00:00`), booked)).toBe(false);
    // cancelled -> the API layer stops passing it in
    expect(isSlotAvailable(utc(`${MON}T10:00:00`), { ...booked, bookings: [] })).toBe(true);
  });
});
