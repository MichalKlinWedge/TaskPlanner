/**
 * Przed testami E2E: konto `e2e@taskplanner.test` od zera w LOKALNYM Supabase (stare usuwane razem
 * z danymi), onboarding, projekt z jednym zadaniem z datami (oś czasu) i lista w widoku „Karteczki”
 * (dwa kolorowe tagi, osoba odpowiedzialna) — przez `push_changes`
 * jak z urządzenia. Sesja trafia do `.auth/e2e.json` (git-ignored) jako `storageState` przeglądarki.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { addDays, collaboratorId, defaultWorkspaceId, localDateAt, onboardingOps, uuidv5 } from '@taskplanner/core';
import type { FullConfig } from '@playwright/test';

import { E2E_CANVAS, E2E_CANVAS_LIST, E2E_EMAIL, E2E_PROJECT, E2E_TIMELINE_TASK, TIME_ZONE } from './constants.ts';
import { freshAccount, push, storageState } from './supabase.ts';

export const AUTH_FILE = fileURLToPath(new URL('../.auth/e2e.json', import.meta.url));
export const ACCOUNT_FILE = fileURLToPath(new URL('../.auth/e2e-account.json', import.meta.url));

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('Brak baseURL w konfiguracji Playwright.');
  const account = await freshAccount(E2E_EMAIL);
  const today = localDateAt(new Date(), TIME_ZONE);
  const work = defaultWorkspaceId(account.id, 'work');
  const project = uuidv5(`e2e:project:${account.id}`);
  const canvas = canvasIds(account.id);
  const rejected = await push(account, [
    ...onboardingOps(account.id, { displayName: 'E2E', settings: { timeZone: TIME_ZONE } }),
    { table: 'lists', id: project, patch: { scope_id: work, kind: 'project', name: E2E_PROJECT, start_date: addDays(today, -7), end_date: addDays(today, 30), project_status: 'active', sort_key: 'b' } },
    { table: 'tasks', id: uuidv5(`e2e:timeline:${account.id}`), patch: { list_id: project, title: E2E_TIMELINE_TASK, start_date: addDays(today, 1), due_date: addDays(today, 3), sort_key: 'a' } },
    { table: 'lists', id: canvas.list, patch: { scope_id: work, kind: 'list', name: E2E_CANVAS_LIST, sort_key: 'c', view_prefs: { view: 'canvas' } } },
    { table: 'tags', id: canvas.blue, patch: { name: 'niebieski', color: '#3B82F6', sort_key: 'a' } },
    { table: 'tags', id: canvas.red, patch: { name: 'czerwony', color: '#EF4444', sort_key: 'b' } },
    { table: 'collaborators', id: canvas.person, patch: { name: E2E_CANVAS.person, acronym: 'ON' } },
    { table: 'tasks', id: canvas.first, patch: { list_id: canvas.list, title: E2E_CANVAS.first, sort_key: 'a', priority: 1, assignee_id: canvas.person, canvas_pos: { col: 0, row: 0 } } },
    { table: 'tasks', id: canvas.second, patch: { list_id: canvas.list, title: E2E_CANVAS.second, sort_key: 'b', canvas_pos: { col: 1, row: 0 } } },
    { table: 'tasks', id: canvas.tray, patch: { list_id: canvas.list, title: E2E_CANVAS.tray, sort_key: 'c' } },
    { table: 'task_tags', id: uuidv5(`e2e:canvas:tt-blue:${account.id}`), patch: { task_id: canvas.first, tag_id: canvas.blue, sort_key: 'a' } },
    { table: 'task_tags', id: uuidv5(`e2e:canvas:tt-red:${account.id}`), patch: { task_id: canvas.first, tag_id: canvas.red, sort_key: 'b' } },
  ]);
  if (rejected) throw new Error(`Przygotowanie konta E2E: ${rejected} odrzuconych operacji.`);
  mkdirSync(fileURLToPath(new URL('../.auth/', import.meta.url)), { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(storageState(account, baseURL)));
  // Testy sprawdzają serwer kluczem `service_role` w zakresach tego użytkownika.
  writeFileSync(ACCOUNT_FILE, JSON.stringify({ id: account.id }));
}

/** Identyfikatory danych widoku „Karteczki” konta E2E (test sięga po nie przez `server.userId`). */
export const canvasIds = (userId: string) => ({
  list: uuidv5(`e2e:canvas:${userId}`),
  first: uuidv5(`e2e:canvas:first:${userId}`),
  second: uuidv5(`e2e:canvas:second:${userId}`),
  tray: uuidv5(`e2e:canvas:tray:${userId}`),
  blue: uuidv5(`e2e:canvas:blue:${userId}`),
  red: uuidv5(`e2e:canvas:red:${userId}`),
  person: collaboratorId(userId, E2E_CANVAS.person),
});
