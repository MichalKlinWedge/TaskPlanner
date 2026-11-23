/**
 * Wspólne elementy testów: otwarcie aplikacji po synchronizacji (`openApp`) i odczyt serwera
 * (`server`) — sprawdzenie, że zmiana z UI doszła przez synchronizację.
 */
import { readFileSync } from 'node:fs';

import { expect, test as base, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import { ACCOUNT_FILE } from './global-setup.ts';
import { adminClient } from './supabase.ts';

export interface ServerTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  list_id: string;
  start_date: string | null;
  due_date: string | null;
  due_time: string | null;
  duration_min: number | null;
  canvas_pos: { col: number; row: number } | null;
  derived_from: string[] | null;
  deleted_at: string | null;
}

export interface ServerDependency {
  id: string;
  predecessor_id: string;
  successor_id: string;
  deleted_at: string | null;
}

/** Odczyt serwera kluczem `service_role`, zawężony do zakresów użytkownika E2E. */
export class Server {
  readonly client: SupabaseClient;
  readonly userId: string;

  constructor(client: SupabaseClient, userId: string) {
    this.client = client;
    this.userId = userId;
  }

  private async scopes(): Promise<string[]> {
    const { data, error } = await this.client.from('scope_members').select('scope_id').eq('user_id', this.userId);
    if (error) throw new Error(`scope_members: ${error.message}`);
    return data.map((r) => String(r.scope_id));
  }

  async task(title: string): Promise<ServerTask | null> {
    const { data, error } = await this.client.from('tasks').select('*').in('scope_id', await this.scopes()).eq('title', title).is('deleted_at', null).maybeSingle();
    if (error) throw new Error(`tasks: ${error.message}`);
    return data as ServerTask | null;
  }

  /** Wiersze `task_dependencies` poprzednik → następnik (także usunięte miękko). */
  async dependencies(predecessorId: string, successorId: string): Promise<ServerDependency[]> {
    const { data, error } = await this.client.from('task_dependencies').select('id, predecessor_id, successor_id, deleted_at').eq('predecessor_id', predecessorId).eq('successor_id', successorId);
    if (error) throw new Error(`task_dependencies: ${error.message}`);
    return data as ServerDependency[];
  }

  /** Czeka, aż zależność poprzednik → następnik na serwerze spełni warunek. */
  async waitForDependency(predecessorId: string, successorId: string, check: (rows: ServerDependency[]) => boolean, timeout = 15_000): Promise<ServerDependency[]> {
    const end = Date.now() + timeout;
    let last: ServerDependency[] = [];
    while (Date.now() < end) {
      last = await this.dependencies(predecessorId, successorId);
      if (check(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Zależność ${predecessorId} → ${successorId} na serwerze nie spełnia warunku po ${timeout} ms; ostatnio: ${JSON.stringify(last)}`);
  }

  /** Czeka, aż zadanie na serwerze spełni warunek (synchronizacja w tle). */
  async waitForTask(title: string, check: (task: ServerTask) => boolean = () => true, timeout = 15_000): Promise<ServerTask> {
    const end = Date.now() + timeout;
    let last: ServerTask | null = null;
    while (Date.now() < end) {
      last = await this.task(title);
      if (last && check(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Zadanie „${title}” na serwerze nie spełnia warunku po ${timeout} ms; ostatnio: ${JSON.stringify(last)}`);
  }
}

/** Unikalny tytuł w obrębie przebiegu (konto jest wspólne dla testów). */
export const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}`;

/** Aplikacja po starcie: powłoka widoczna, pierwsza synchronizacja zakończona. */
export async function openApp(page: Page, hash = '#/today') {
  await page.goto(`/${hash}`);
  await expect(page.getByRole('complementary', { name: 'Nawigacja' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sync-status')).toHaveText('Zsynchronizowano', { timeout: 30_000 });
}

export const test = base.extend<{ server: Server }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright wymaga destrukturyzacji fixture'ów
  server: async ({}, use) => {
    const { id } = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8')) as { id: string };
    await use(new Server(adminClient(), id));
  },
});

export { expect };

/** Wiersz zadania w treści widoku (lista, Dziś, Nadchodzące). */
export const taskRow = (page: Page, title: string) => page.locator('main [data-task-id]').filter({ hasText: title });
