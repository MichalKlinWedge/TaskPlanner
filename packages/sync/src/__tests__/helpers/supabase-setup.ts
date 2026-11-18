/**
 * Adres i klucze lokalnego Supabase dla testów integracyjnych (`npm run test:sync`).
 * Wymaga `npm run supabase -- start` w katalogu głównym.
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { TestProject } from 'vitest/node';

export interface LocalSupabase {
  url: string;
  anonKey: string;
  serviceKey: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    supabase: LocalSupabase;
  }
}

export default function setup(project: TestProject) {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  let raw: string;
  try {
    raw = execSync('npx --yes supabase@2.122.0 status -o json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new Error('Lokalny Supabase nie działa — uruchom `npm run supabase -- start`.');
  }
  const status = JSON.parse(raw.slice(raw.indexOf('{')));
  project.provide('supabase', {
    url: status.API_URL,
    anonKey: status.PUBLISHABLE_KEY ?? status.ANON_KEY,
    serviceKey: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY,
  });
}
