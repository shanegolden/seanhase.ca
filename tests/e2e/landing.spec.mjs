import { test, expect } from '@playwright/test';
import { adminContext, seedConfig } from './helpers.mjs';

test.beforeAll(async ({ playwright }) => {
  const admin = await adminContext(playwright);
  await seedConfig(admin);
  await admin.dispose();
});

test('landing page renders every section with honest student copy', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Sean Hase/);
  await expect(page.locator('h1')).toContainText('Feel better');
  await expect(page.locator('#about h2')).toContainText('About Sean');
  await expect(page.locator('#about img')).toBeVisible();
  await expect(page.locator('.card')).toHaveCount(3);
  await expect(page.locator('.services-note')).toContainText(/not yet a Registered Massage Therapist/);
  await expect(page.locator('#book h2')).toBeVisible();
  await expect(page.locator('#contact form')).toBeVisible();
  await expect(page.locator('.footer')).toContainText('Sean Hase');
});

test('booking widget loads real slots with a timezone label', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#bw-tz')).toContainText(/Times shown in/i, { timeout: 15000 });
  await expect(page.locator('.day-chip').first()).toBeVisible();
  await expect(page.locator('.slot-chip').first()).toBeVisible();
});

test('no horizontal overflow on this viewport', async ({ page }) => {
  await page.goto('/');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('clicking the wordmark scrolls back to the top (sticky-header anchor bug)', async ({ page }) => {
  await page.goto('/');
  // behavior:'instant' bypasses the page's own smooth-scroll CSS in setup.
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  await page.click('a.wordmark');
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 }).toBeLessThan(50);
});
