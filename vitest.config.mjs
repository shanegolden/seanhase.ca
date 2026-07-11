import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/*.test.mjs'], // unit suites only; tests/e2e belongs to Playwright
  },
});
