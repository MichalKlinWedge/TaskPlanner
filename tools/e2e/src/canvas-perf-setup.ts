/**
 * Przed pomiarem „Karteczek”: konto `canvas-perf@taskplanner.test` od zera, onboarding i lista
 * w widoku „Karteczki” z 500 ułożonymi karteczkami (25 kolumn × 20 wierszy; różne długości tytułów,
 * priorytety, kolorowe tagi, część z osobą odpowiedzialną) — przez `push_changes`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { collaboratorId, defaultWorkspaceId, onboardingOps, uuidv5 } from '@taskplanner/core';
import type { FullConfig } from '@playwright/test';

import { CANVAS_PERF_CARDS, CANVAS_PERF_EMAIL, TIME_ZONE } from './constants.ts';
import { freshAccount, push, storageState } from './supabase.ts';

export const CANVAS_PERF_AUTH_FILE = fileURLToPath(new URL('../.auth/canvas-perf.json', import.meta.url));
export const CANVAS_PERF_LIST_FILE = fileURLToPath(new URL('../.auth/canvas-perf-list.json', import.meta.url));
export const CANVAS_PERF_LIST = 'Burza 500';

const COLUMNS = 25;
const WORDS = ['analiza', 'klienci', 'nowy', 'proces', 'budżet', 'ryzyko', 'zespół', 'kampania', 'dostawca', 'raport', 'wdrożenie', 'szkolenie', 'aplikacja', 'jakość', 'termin'];
const TAGS = [
  { name: 'pomysł', color: '#FACC15' },
  { name: 'ryzyko', color: '#EF4444' },
  { name: 'klient', color: '#3B82F6' },
  { name: 'koszt', color: '#22C55E' },
  { name: 'pytanie', color: '#A855F7' },
];
const PEOPLE = [
  { name: 'Ola Nowak', acronym: 'ON' },
  { name: 'Jan Kowal', acronym: 'JK' },
  { name: 'Ewa Lis', acronym: 'EL' },
];

export default async function canvasPerfSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('Brak baseURL w konfiguracji Playwright.');
  const account = await freshAccount(CANVAS_PERF_EMAIL);
  const list = uuidv5(`canvas-perf:list:${account.id}`);
  const tagIds = TAGS.map((t) => uuidv5(`canvas-perf:tag:${t.name}:${account.id}`));
  const people = PEOPLE.map((p) => collaboratorId(account.id, p.name));
  const ops: Parameters<typeof push>[1][number][] = [
    ...onboardingOps(account.id, { displayName: 'Karteczki', settings: { timeZone: TIME_ZONE } }),
    { table: 'lists', id: list, patch: { scope_id: defaultWorkspaceId(account.id, 'work'), kind: 'list', name: CANVAS_PERF_LIST, sort_key: 'c', view_prefs: { view: 'canvas' } } },
    ...TAGS.map((t, i) => ({ table: 'tags', id: tagIds[i]!, patch: { name: t.name, color: t.color, sort_key: String.fromCharCode(97 + i) } })),
    ...PEOPLE.map((p, i) => ({ table: 'collaborators', id: people[i]!, patch: { name: p.name, acronym: p.acronym } })),
  ];
  for (let i = 0; i < CANVAS_PERF_CARDS; i++) {
    const id = uuidv5(`canvas-perf:task:${i}:${account.id}`);
    // Tytuły od 1 do 14 słów — dopasowanie czcionki w pełnym zakresie.
    const title = Array.from({ length: 1 + (i % 14) }, (_, w) => WORDS[(i * 7 + w * 3) % WORDS.length]).join(' ') + ` ${i + 1}`;
    ops.push({
      table: 'tasks',
      id,
      patch: {
        list_id: list,
        title,
        sort_key: `k${String(i).padStart(4, '0')}`,
        priority: 1 + (i % 4),
        assignee_id: i % 3 === 0 ? people[i % PEOPLE.length]! : null,
        canvas_pos: { col: i % COLUMNS, row: Math.floor(i / COLUMNS) },
      },
    });
    if (i % 5 !== 4) ops.push({ table: 'task_tags', id: uuidv5(`canvas-perf:tt:${i}:${account.id}`), patch: { task_id: id, tag_id: tagIds[i % TAGS.length]!, sort_key: 'a' } });
  }
  const rejected = await push(account, ops, 'canvas-perf');
  if (rejected) throw new Error(`Przygotowanie ${CANVAS_PERF_EMAIL}: ${rejected} odrzuconych operacji.`);
  mkdirSync(fileURLToPath(new URL('../.auth/', import.meta.url)), { recursive: true });
  writeFileSync(CANVAS_PERF_AUTH_FILE, JSON.stringify(storageState(account, baseURL)));
  writeFileSync(CANVAS_PERF_LIST_FILE, JSON.stringify({ id: list }));
}
