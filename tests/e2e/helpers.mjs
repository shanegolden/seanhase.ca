import { expect } from '@playwright/test';

export const API = 'http://127.0.0.1:18793';
export const ADMIN_EMAIL = 'sean-e2e@example.com';
export const ADMIN_PASSWORD = 'e2e-password-2026';

const H = { 'content-type': 'application/json', 'x-seanhase-admin': '1' };

let cached = null;

/** Bootstrap (first run on a fresh D1) or log in; returns a logged-in APIRequestContext.
 *  Memoized per worker so the suite doesn't burn the login rate limit. */
export async function adminContext(playwright) {
  if (cached) return cached;
  const ctx = await playwright.request.newContext({ baseURL: API, extraHTTPHeaders: H });
  cached = ctx;
  ctx.dispose = async () => {}; // shared: individual tests must not tear it down
  const boot = await ctx.post('/api/admin/bootstrap', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!boot.ok()) {
    expect(boot.status(), 'bootstrap should 409 only when already provisioned').toBe(409);
    const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } });
    expect(login.ok()).toBeTruthy();
  }
  return ctx;
}

/** Deterministic booking configuration for the whole suite. */
export async function seedConfig(admin) {
  const s = await admin.put('/api/admin/settings', {
    data: {
      durationMin: 60, granularityMin: 30, bumperMin: 15, bookingBufferMin: 15,
      leadHours: 0, horizonDays: 21, timezone: 'America/Vancouver',
    },
  });
  expect(s.ok()).toBeTruthy();
  const w = await admin.put('/api/admin/windows', {
    data: {
      windows: [
        { weekday: 1, startMin: 9 * 60, endMin: 17 * 60 },   // Monday 9-5
        { weekday: 3, startMin: 12 * 60, endMin: 20 * 60 },  // Wednesday 12-8
      ],
    },
  });
  expect(w.ok()).toBeTruthy();
}

export async function getSlots(request) {
  const r = await request.get(`${API}/api/slots`);
  expect(r.ok()).toBeTruthy();
  return r.json();
}
