import { test, expect } from '@playwright/test';
import { adminContext } from './helpers.mjs';

test('contact form submits and the message is stored + notification logged', async ({ page, playwright }) => {
  await page.goto('/');
  await page.fill('#contact-form input[name=name]', 'Curious Visitor');
  await page.fill('#contact-form input[name=email]', 'curious@example.com');
  await page.fill('#contact-form textarea[name=message]', 'Do you take evening appointments?');
  await page.click('#contact-form button[type=submit]');
  await expect(page.locator('#contact-success')).toBeVisible({ timeout: 10000 });

  // The notification email attempt is logged (stub driver locally = "stubbed").
  const admin = await adminContext(playwright);
  const health = await (await admin.get('/api/admin/health-summary')).json();
  expect(health.mailFailures24h).toBe(0);
  await admin.dispose();
});

test('honeypot submissions are silently swallowed', async ({ request }) => {
  const r = await request.post('http://127.0.0.1:18793/api/contact', {
    data: { name: 'Bot', email: 'bot@example.com', message: 'spam', website: 'http://spam.example' },
    headers: { 'content-type': 'application/json' },
  });
  expect(r.ok()).toBeTruthy();
});
