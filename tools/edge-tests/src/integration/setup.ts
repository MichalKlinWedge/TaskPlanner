/**
 * Testy integracyjne PoC-6: lokalny Supabase (`npm run supabase -- start`) i funkcje z `.env.test`
 * (`npm run serve:test --workspace tools/edge-tests` w osobnym terminalu).
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { TestProject } from 'vitest/node';

import { readEnv, sql } from '../setup.ts';

export interface EdgeConfig {
  url: string;
  anonKey: string;
  serviceKey: string;
  functionsUrl: string;
  cronSecret: string;
  inboundSecret: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    edge: EdgeConfig;
  }
}

export default async function setup(project: TestProject) {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  let raw: string;
  try {
    raw = execSync('npx --yes supabase@2.122.0 status -o json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new Error('Lokalny Supabase nie działa — uruchom `npm run supabase -- start`.');
  }
  const status = JSON.parse(raw.slice(raw.indexOf('{')));
  const env = readEnv(`${root}supabase/functions/.env.test`);
  if (!env.CRON_SECRET) throw new Error('Brak supabase/functions/.env.test — uruchom `npm run setup --workspace tools/edge-tests`.');
  const functionsUrl = `${status.API_URL}/functions/v1`;
  const probe = await fetch(`${functionsUrl}/reminders-push`, { method: 'POST' }).catch(() => null);
  if (probe?.status !== 401) {
    throw new Error('Edge Functions nie odpowiadają — uruchom `npm run serve:test --workspace tools/edge-tests`.');
  }
  // Poprzednie przebiegi: ich konta kalendarzy (fałszywe Google, ICS) odpytywałby cron.
  sql(`delete from auth.users where email like '%@edge.test.local'`);
  project.provide('edge', {
    url: status.API_URL,
    anonKey: status.PUBLISHABLE_KEY ?? status.ANON_KEY,
    serviceKey: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY,
    functionsUrl,
    cronSecret: env.CRON_SECRET,
    inboundSecret: env.INBOUND_SECRET!,
  });
}
