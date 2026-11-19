/**
 * Testy E2E weba (Etap 13): build produkcyjny (`scripts/dev-alt.mjs --local --prod`, jedyny z Service
 * Workerem) na lokalnym Supabase, konto `e2e@taskplanner.test` zakładane od zera przed każdym
 * przebiegiem. Testy idą po kolei w jednym procesie — dzielą konto i serwer.
 *
 *   npm run test:e2e                      — z korzenia repozytorium
 *   E2E_PORT=3030 npm run test:e2e        — inny port (np. gdy 3020 zajęty)
 */
import { defineConfig, devices } from '@playwright/test';

import { PORT, TIME_ZONE } from './src/constants.ts';

const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './src/global-setup.ts',
  use: {
    baseURL,
    storageState: '.auth/e2e.json',
    locale: 'pl-PL',
    timezoneId: TIME_ZONE,
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } } }],
  webServer: {
    command: `node scripts/dev-alt.mjs --local --port ${PORT} --prod`,
    cwd: '../..',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
