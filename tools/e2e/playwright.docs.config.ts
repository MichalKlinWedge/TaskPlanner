/**
 * Zrzuty ekranu instrukcji użytkownika (`docs/instrukcja/img`) — ten sam build produkcyjny co E2E, konta
 * z przykładowymi danymi zakładane od zera (`docs/setup.ts`). Uruchomienie: `npm run docs:screens`.
 */
import { defineConfig } from '@playwright/test';

import base from './playwright.config.ts';
import { demoZone } from './docs/demo-data.ts';

const viewport = { width: 1360, height: 860 };

export default defineConfig({
  ...base,
  testDir: 'docs',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  reporter: [['list']],
  globalSetup: './docs/setup.ts',
  use: { ...base.use, storageState: '.auth/docs-anna.json', timezoneId: demoZone(), viewport, deviceScaleFactor: 1.5, colorScheme: 'light', screenshot: 'off', trace: 'off', permissions: ['notifications'] },
  // Zainstalowany Chrome (tymczasowy profil) z `--lang`: pola daty i godziny po polsku (headless shell ma zawsze format angielski).
  projects: [{ name: 'chromium', use: { browserName: 'chromium', channel: 'chrome', viewport, launchOptions: { args: ['--lang=pl-PL'] } } }],
});
