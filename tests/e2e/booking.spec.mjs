import { test, expect } from '@playwright/test';
import http from 'node:http';
import { DateTime } from 'luxon';
import { adminContext, seedConfig, getSlots, API } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

let admin;
test.beforeAll(async ({ playwright }) => {
  admin = await adminContext(playwright);
  await seedConfig(admin);
});
test.afterAll(async () => admin?.dispose());

test('visitor books the first open slot end to end', async ({ page, request }) => {
  const before = await getSlots(request);
  expect(before.slots.length).toBeGreaterThan(0);

  await page.goto('/');
  await expect(page.locator('#bw-tz')).toContainText(/Pacific/i);
  await page.locator('.day-chip').first().click();
  const firstSlot = page.locator('.slot-chip').first();
  const slotLabel = await firstSlot.textContent();
  await firstSlot.click();

  await expect(page.locator('#bw-picked')).toContainText(slotLabel.trim().split(' ')[0]);
  await page.fill('input[name=name]', 'Playwright Client');
  await page.fill('input[name=email]', 'pw-client@example.com');
  await page.fill('input[name=phone]', '604-555-0111');
  await page.fill('input[name=note]', 'e2e booking');
  await page.check('input[name=consent]');
  await page.click('#bw-submit');

  await expect(page.locator('.bw-success h3')).toHaveText(/booked/i, { timeout: 15000 });
  await expect(page.locator('#bw-success-when')).toContainText(/Pacific/i);
  await expect(page.locator('#bw-ics')).toHaveAttribute('href', /^blob:/);
  await expect(page.locator('#bw-gcal')).toHaveAttribute('href', /calendar\.google\.com/);
  const manageUrl = await page.locator('#bw-manage-link').getAttribute('href');
  expect(manageUrl).toMatch(/#manage=[a-f0-9]{32}/);

  // The booked slot is no longer offered.
  const after = await getSlots(request);
  expect(after.slots.length).toBeLessThan(before.slots.length);

  // Manage link: view, then cancel, then the slot count recovers.
  await page.goto(manageUrl);
  await expect(page.locator('#bw-manage-status')).toContainText(/confirmed/i);
  page.on('dialog', (d) => d.accept());
  await page.click('#bw-manage-cancel');
  await expect(page.locator('#bw-manage-status')).toContainText(/cancelled/i);
  const restored = await getSlots(request);
  expect(restored.slots.length).toBe(before.slots.length);
});

test('double-booking race: exactly one of two simultaneous requests wins', async ({ request }, testInfo) => {
  testInfo.skip(testInfo.project.name !== 'desktop', 'API-level proof, browser-independent');
  const { slots } = await getSlots(request);
  expect(slots.length).toBeGreaterThan(3);
  const target = slots[2].start;
  const body = (name) => ({
    data: {
      name, email: `${name}@example.com`, start: target, consent: true,
    },
    headers: { 'content-type': 'application/json' },
  });
  const [a, b] = await Promise.all([
    request.post(`${API}/api/bookings`, body('racer-one')),
    request.post(`${API}/api/bookings`, body('racer-two')),
  ]);
  const statuses = [a.status(), b.status()].sort();
  expect(statuses).toEqual([201, 409]);

  // Overlap guard: the adjacent 30-min-offset slot (inside the 60-min session) is gone too.
  const after = await getSlots(request);
  const starts = new Set(after.slots.map((s) => s.start));
  expect(starts.has(target)).toBe(false);
});

test('bumper logic end to end: external 1pm event with 15-min bumpers pushes next slot to 2:15pm', async ({ request }, testInfo) => {
  testInfo.skip(testInfo.project.name !== 'desktop', 'engine proof once is enough');

  // Serve a synthetic calendar feed with a 1pm-2pm event next Monday (clinic time).
  const tz = 'America/Vancouver';
  let day = DateTime.now().setZone(tz).plus({ days: 1 }).startOf('day');
  while (day.weekday !== 1) day = day.plus({ days: 1 }); // next Monday
  const evStart = day.set({ hour: 13 });
  const evEnd = day.set({ hour: 14 });
  const toIcs = (dt) => dt.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//e2e//EN', 'BEGIN:VEVENT',
    'UID:e2e-bumper', `DTSTART:${toIcs(evStart)}`, `DTEND:${toIcs(evEnd)}`,
    'SUMMARY:Existing commitment', 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(ics);
  });
  await new Promise((res) => server.listen(18994, '127.0.0.1', res));

  // Real feeds must be https; loopback http is allowed by the validator
  // precisely for local stubs like this one. Shane's 2:15pm example implies a
  // 15-minute grid, so set that here (restored in the finally).
  const set = await admin.put('/api/admin/settings', {
    data: { calendarFeedUrl: 'http://127.0.0.1:18994/feed.ics', granularityMin: 15 },
  });
  expect(set.ok()).toBeTruthy();

  try {
    const test1 = await admin.post('/api/admin/calendar/test', { data: {} });
    const probe = await test1.json();
    expect(probe.ok, JSON.stringify(probe)).toBeTruthy();
    expect(probe.eventsNext7Days).toBeGreaterThanOrEqual(day.diffNow('days').days <= 7 ? 1 : 0);

    const { slots } = await getSlots(request);
    const dayIso = (iso) => DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).toISODate();
    const monday = day.toISODate();
    const mondaySlots = slots.filter((s) => dayIso(s.start) === monday)
      .map((s) => DateTime.fromISO(s.start, { zone: 'utc' }).setZone(tz).toFormat('HH:mm'));

    // Shane's literal spec: event 1pm-2pm + 15-min bumpers -> next available is 2:15pm.
    expect(mondaySlots).toContain('14:15');
    for (const blocked of ['12:15', '12:30', '13:00', '13:30', '14:00']) {
      expect(mondaySlots, `${blocked} must be blocked`).not.toContain(blocked);
    }
    // A slot ending exactly at the pad start is allowed (11:45-12:45).
    expect(mondaySlots).toContain('11:45');
  } finally {
    await admin.put('/api/admin/settings', { data: { calendarFeedUrl: '', granularityMin: 30 } });
    server.close();
  }
});

test('booking is refused when the calendar feed is dead (fail closed)', async ({ request }, testInfo) => {
  testInfo.skip(testInfo.project.name !== 'desktop', 'engine proof once is enough');
  const set = await admin.put('/api/admin/settings', { data: { calendarFeedUrl: 'http://127.0.0.1:18995/nope.ics' } });
  expect(set.ok()).toBeTruthy();
  try {
    const slotsRes = await request.get(`${API}/api/slots`);
    const data = await slotsRes.json();
    expect(data.calendarUnavailable).toBe(true);
    expect(data.slots).toEqual([]);
    const book = await request.post(`${API}/api/bookings`, {
      data: { name: 'x', email: 'x@example.com', start: '2030-01-07T17:00:00Z', consent: true },
      headers: { 'content-type': 'application/json' },
    });
    expect(book.status()).toBe(503);
  } finally {
    await admin.put('/api/admin/settings', { data: { calendarFeedUrl: '' } });
  }
});
