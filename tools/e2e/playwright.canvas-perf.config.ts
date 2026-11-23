/**
 * Pomiar widoku „Karteczki” na 500 karteczkach jednej listy — ten sam build produkcyjny co E2E,
 * konto `canvas-perf@taskplanner.test` zakładane od zera (`src/canvas-perf-setup.ts`).
 * Wyniki: tabela w konsoli i `tools/e2e/out/perf-canvas.json`; opis w `docs/WYDAJNOSC.md`.
 *
 *   npm run perf:canvas
 */
import { defineConfig } from '@playwright/test';

import perf from './playwright.perf.config.ts';

export default defineConfig({
  ...perf,
  testIgnore: undefined,
  testMatch: 'canvas.spec.ts',
  globalSetup: './src/canvas-perf-setup.ts',
  use: { ...perf.use, storageState: '.auth/canvas-perf.json' },
});
