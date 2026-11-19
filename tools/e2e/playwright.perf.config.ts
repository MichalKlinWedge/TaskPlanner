/**
 * Pomiary wydajności na 10 000 zadań (Etap 13, SPECYFIKACJA §9) — ten sam build produkcyjny co E2E,
 * konto `perf@taskplanner.test` z danymi z `npm run seed:dev -- --tasks 10000 --load --email perf@taskplanner.test`.
 * Wyniki: tabela w konsoli i `tools/e2e/out/perf.json`; opis w `docs/WYDAJNOSC.md`.
 *
 *   npm run perf
 */
import { defineConfig, devices } from '@playwright/test';

import base from './playwright.config.ts';

export default defineConfig({
  ...base,
  testDir: 'perf',
  globalSetup: './src/perf-setup.ts',
  timeout: 300_000,
  reporter: [['list']],
  use: { ...base.use, storageState: '.auth/perf.json', trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } } }],
});
