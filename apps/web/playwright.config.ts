import { defineConfig, devices } from '@playwright/test';

/**
 * Journeys run against the mock API build (`ng serve --configuration mock`), so no backend is needed.
 * Each test gets a fresh browser context → fresh sessionStorage → fresh mock database.
 */
const PORT = Number(process.env['E2E_PORT'] ?? 4300);

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  // One worker locally keeps memory low (the dev server + Chromium already need ~2 GB).
  workers: process.env['CI'] ? 2 : 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list']],
  outputDir: './e2e/.results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
  },
  webServer: {
    command: `npx ng serve --configuration mock --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 300_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
