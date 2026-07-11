import { test, expect } from '@playwright/test';
import { adminContext, seedConfig, ADMIN_PASSWORD, API } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
  const admin = await adminContext(playwright);
  await seedConfig(admin);
  await admin.dispose();
});

test('wrong password is rejected with a readable error', async ({ page }) => {
  await page.goto(`${API}/`);
  await page.fill('input[type=password]', 'definitely-wrong-1');
  await page.click('button.primary');
  await expect(page.locator('.error')).toContainText(/wrong password/i);
});

test('login reaches the dashboard with live stats', async ({ page }) => {
  await page.goto(`${API}/`);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('button.primary');
  await expect(page.locator('.stat-row')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('h1')).toHaveText('Dashboard');
});

test('content edit round-trips through save and shows honest publish failure without a token', async ({ page }) => {
  await page.goto(`${API}/`);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('button.primary');
  await page.click("button.tab:text('Content')");
  const headline = page.locator('section.panel').first().locator('input').nth(1);
  const unique = `Feel better. Move better. [e2e ${Date.now() % 100000}]`;
  await headline.fill(unique);
  await page.click("button:text('Save draft')");
  await expect(page.locator('.toast')).toContainText(/saved/i);

  await page.reload();
  await page.click("button.tab:text('Content')");
  await expect(page.locator('section.panel').first().locator('input').nth(1)).toHaveValue(unique);

  // Publish without a GitHub token must fail LOUDLY, never silently.
  await page.click("button:text('Publish to site')");
  await expect(page.locator('.banner.err')).toContainText(/failed/i, { timeout: 20000 });

  // Restore the canonical headline for later runs.
  await page.locator('section.panel').first().locator('input').nth(1).fill('Feel better. Move better.');
  await page.click("button:text('Save draft')");
});

test('availability edits change public slots', async ({ page, request, playwright }) => {
  await page.goto(`${API}/`);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('button.primary');
  await page.click("button.tab:text('Availability')");
  await expect(page.locator('.day-row')).toHaveCount(7);

  // Bump session length through the UI and verify the public API follows.
  const duration = page.locator('label:has-text("Session length") input');
  await duration.fill('90');
  await duration.dispatchEvent('change');
  await expect(page.locator('.toast')).toContainText(/saved/i);
  const slots90 = await (await request.get(`${API}/api/slots`)).json();
  expect(slots90.durationMin).toBe(90);

  // Restore.
  const admin = await adminContext(playwright);
  await seedConfig(admin);
  await admin.dispose();
});

test('admin sees and can cancel a booking', async ({ page, request }) => {
  // Create a booking via the public API.
  const slots = await (await request.get(`${API}/api/slots`)).json();
  const target = slots.slots.at(-1);
  const made = await request.post(`${API}/api/bookings`, {
    data: { name: 'Cancel Me', email: 'cancelme@example.com', start: target.start, consent: true },
    headers: { 'content-type': 'application/json' },
  });
  expect(made.status()).toBe(201);

  await page.goto(`${API}/`);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('button.primary');
  await page.click("button.tab:text('Bookings')");
  const row = page.locator('tr', { hasText: 'Cancel Me' }).first();
  await expect(row).toBeVisible();
  page.on('dialog', (d) => d.accept());
  await row.locator("button:text('Cancel')").click();
  await expect(page.locator('.toast')).toContainText(/cancelled/i);

  const after = await (await request.get(`${API}/api/slots`)).json();
  expect(after.slots.map((s) => s.start)).toContain(target.start);
});
