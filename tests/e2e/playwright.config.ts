import { defineConfig, devices } from '@playwright/test';

/**
 * Real-stack journeys: the whole Sathi stack must already be running (CI: compose.yaml + compose.test.yaml,
 * locally: `docker compose up -d`). Nothing is mocked — the AI service runs with the fake LLM/search providers
 * when no API key is configured, and e-mails are read from Mailpit.
 *
 *   BASE_URL     default http://localhost:8080
 *   MAILPIT_URL  default http://localhost:8025
 *   SATHI_ADMIN_EMAIL / SATHI_ADMIN_PASSWORD  default: SEED_ADMIN_* from the repo-root .env
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // The journeys share one database; run them one at a time (also keeps memory low on small machines).
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: './test-results',
  use: {
    baseURL: process.env['BASE_URL'] ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
