import { defineConfig, devices } from '@playwright/test';

const API = 'http://127.0.0.1:18793';
const SITE = 'http://127.0.0.1:18992';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  fullyParallel: false, // journeys share one D1; ordered within files
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: SITE,
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: { ...devices['iPhone 13'] },
      testMatch: ['**/landing.spec.mjs', '**/booking.spec.mjs'], // visitor journeys on a phone
    },
  ],
  webServer: [
    {
      // Fresh D1 every run (cleanup lives HERE because this command runs exactly
      // once, while the config file is re-evaluated by every worker process).
      command: 'node -e "fs.rmSync(\'.wrangler-e2e\',{recursive:true,force:true})" && npx wrangler d1 migrations apply seanhase --local --persist-to .wrangler-e2e --config worker/wrangler.toml && node admin/build.mjs && npx wrangler dev --config worker/wrangler.toml --persist-to .wrangler-e2e --port 18793 --var DEV_MODE:1',
      url: `${API}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node site/build.mjs && npx http-server site -p 18992 -c-1 --silent',
      url: SITE,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { API_BASE: API },
    },
  ],
});

export { API, SITE };
