/**
 * Konta demonstracyjne instrukcji użytkownika w LOKALNYM Supabase (zakładane od zera): Anna (dane
 * z `demo-data.ts`), Piotr (edytor jej przestrzeni „Remont”, zaprasza do własnej) i nowa osoba przed onboardingiem.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defaultWorkspaceId, localDateAt, onboardingOps } from '@taskplanner/core';
import type { FullConfig } from '@playwright/test';

import { adminClient, freshAccount, push, storageState } from '../src/supabase.ts';
import { demoDeliveries, demoIds, demoOps, demoServerRows, demoZone } from './demo-data.ts';

const auth = (name: string) => fileURLToPath(new URL(`../.auth/${name}.json`, import.meta.url));
export const AUTH = { anna: auth('docs-anna'), piotr: auth('docs-piotr'), fresh: auth('docs-fresh'), info: auth('docs-info') };

export interface DocsInfo {
  anna: string;
  timeZone: string;
  today: string;
  /** Przestrzeń Piotra, do której zaprasza Annę (zrzut „zaproszenie”). */
  club: string;
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('Brak baseURL w konfiguracji Playwright.');
  const timeZone = demoZone();
  const today = localDateAt(new Date(), timeZone);
  const admin = adminClient();
  const check = async (what: string, rejected: Promise<number>) => {
    const n = await rejected;
    if (n) throw new Error(`${what}: ${n} odrzuconych operacji.`);
  };

  const anna = await freshAccount('anna.nowicka@example.com');
  await check('Dane Anny', push(anna, demoOps(anna.id, today, timeZone), 'docs'));
  const ops = await demoServerRows(admin, anna, today, timeZone);
  await check('Reguły i załącznik', push(anna, ops, 'docs-2'));
  await demoDeliveries(admin, anna, today, timeZone);

  const piotr = await freshAccount('piotr.zielinski@example.com');
  await check('Dane Piotra', push(piotr, onboardingOps(piotr.id, { displayName: 'Piotr', settings: { timeZone } }), 'docs-p'));
  const club = defaultWorkspaceId(piotr.id, 'personal');
  await check('Przestrzeń Piotra', push(piotr, [{ table: 'workspaces', id: club, patch: { name: 'Klub rowerowy' } }], 'docs-p2'));
  const { error } = await admin.from('scope_members').insert({ scope_id: demoIds(anna.id).shared, user_id: piotr.id, role: 'editor' });
  if (error) throw new Error(`scope_members: ${error.message}`);

  const fresh = await freshAccount('nowa.osoba@example.com');
  mkdirSync(fileURLToPath(new URL('../.auth/', import.meta.url)), { recursive: true });
  for (const [file, account] of [[AUTH.anna, anna], [AUTH.piotr, piotr], [AUTH.fresh, fresh]] as const) {
    writeFileSync(file, JSON.stringify(storageState(account, baseURL)));
  }
  writeFileSync(AUTH.info, JSON.stringify({ anna: anna.id, timeZone, today, club } satisfies DocsInfo));
}
