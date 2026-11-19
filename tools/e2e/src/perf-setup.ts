/**
 * Przed pomiarami: konto `perf@taskplanner.test` z danymi z `seed:dev` (≥ 10 000 zadań na serwerze),
 * onboarding, jeśli go nie było, i nowa sesja w `.auth/perf.json`. Danych nie usuwa ani nie zmienia
 * poza onboardingiem — pomiar zmian kończy się „Cofnij”.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { onboardingOps } from '@taskplanner/core';
import type { FullConfig } from '@playwright/test';

import { PERF_EMAIL, TIME_ZONE } from './constants.ts';
import { adminClient, ensureAccount, push, storageState } from './supabase.ts';

export const PERF_AUTH_FILE = fileURLToPath(new URL('../.auth/perf.json', import.meta.url));
export const PERF_MIN_TASKS = 10_000;

export default async function perfSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('Brak baseURL w konfiguracji Playwright.');
  const { account } = await ensureAccount(PERF_EMAIL);
  const admin = adminClient();
  const { data: scopes } = await admin.from('scope_members').select('scope_id').eq('user_id', account.id);
  const { count } = await admin
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .in('scope_id', (scopes ?? []).map((s) => s.scope_id))
    .is('deleted_at', null);
  if ((count ?? 0) < PERF_MIN_TASKS) {
    throw new Error(`${PERF_EMAIL}: ${count ?? 0} zadań na serwerze — najpierw \`npm run seed:dev -- --tasks 10000 --load --email ${PERF_EMAIL}\`.`);
  }
  const { data: profile } = await admin.from('profiles').select('settings').eq('id', account.id).maybeSingle();
  if (!(profile?.settings as { onboarded?: boolean } | null)?.onboarded) {
    const rejected = await push(account, onboardingOps(account.id, { displayName: 'Pomiary', settings: { timeZone: TIME_ZONE } }), 'perf');
    if (rejected) throw new Error(`Onboarding ${PERF_EMAIL}: ${rejected} odrzuconych operacji.`);
  }
  mkdirSync(fileURLToPath(new URL('../.auth/', import.meta.url)), { recursive: true });
  writeFileSync(PERF_AUTH_FILE, JSON.stringify(storageState(account, baseURL)));
}
