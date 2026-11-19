/**
 * `npm run seed:dev -- --load [--today RRRR-MM-DD] [--seed 1] [--email adres]` — zestaw z `generate.ts`
 * do LOKALNEGO Supabase przez `push_changes` jak z urządzenia. Domyślnie jako `dev@taskplanner.test`
 * (`npm run dev:user`, hasło z `.env.local`); inne konto zakładane kluczem `service_role` z losowym
 * hasłem (nigdzie nie zapisanym — skrypty pomiarów ustawiają własne). Identyfikatory są
 * deterministyczne: ponowne uruchomienie nie dubluje danych.
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { completionId, HlcClock, taskTagId, uuidv7 } from '@taskplanner/core';
import { createClient } from '@supabase/supabase-js';

import type { SeedDataset } from './generate.ts';

interface Op {
  op: string;
  table: string;
  id: string;
  set: Record<string, unknown>;
  hlc: string;
}

export const DEV_EMAIL = 'dev@taskplanner.test';

/** Hasło konta: deweloperskie z `.env.local`, inne — nowe losowe ustawione kluczem `service_role`. */
async function passwordFor(email: string, root: string, status: { API_URL: string; SECRET_KEY?: string; SERVICE_ROLE_KEY?: string }): Promise<string> {
  if (email === DEV_EMAIL) {
    const env = readFileSync(`${root}.env.local`, 'utf8');
    const password = /^DEV_USER_PASSWORD=(.+)$/m.exec(env)?.[1]?.trim();
    if (!password) throw new Error('Brak DEV_USER_PASSWORD w .env.local — najpierw `npm run dev:user`.');
    return password;
  }
  const admin = createClient(status.API_URL, (status.SECRET_KEY ?? status.SERVICE_ROLE_KEY)!, { auth: { persistSession: false } });
  const password = randomBytes(18).toString('base64url');
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const user = data.users.find((u) => u.email === email);
    if (user) {
      const { error: e } = await admin.auth.admin.updateUserById(user.id, { password });
      if (e) throw new Error(`updateUser ${email}: ${e.message}`);
      return password;
    }
    if (data.users.length < 1000) break;
  }
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  console.log(`${email}: konto utworzone`);
  return password;
}

export async function loadDataset(dataset: SeedDataset, email = DEV_EMAIL): Promise<void> {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const raw = execSync('npx --yes supabase@2.122.0 status -o json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const status = JSON.parse(raw.slice(raw.indexOf('{')));
  const password = await passwordFor(email, root, status);
  const client = createClient(status.API_URL, status.PUBLISHABLE_KEY ?? status.ANON_KEY, { auth: { persistSession: false } });
  const { data: auth, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !auth.user) throw new Error(`Logowanie ${email}: ${error?.message}`);
  const userId = auth.user.id;

  const clock = new HlcClock('seed');
  const ops: Op[] = [];
  const add = (table: string, id: string, set: Record<string, unknown>) => ops.push({ op: uuidv7(), table, id, set, hlc: clock.tick() });

  for (const w of dataset.workspaces) add('workspaces', w.id, { name: w.name, color: w.color, sort_key: w.sortKey });
  for (const l of dataset.lists) {
    add('lists', l.id, {
      scope_id: l.workspaceId,
      kind: l.kind,
      name: l.name,
      start_date: l.startDate,
      end_date: l.endDate,
      project_status: l.kind === 'project' ? 'active' : null,
      sort_key: l.sortKey,
    });
  }
  for (const t of dataset.tags) add('tags', t.id, { scope_id: userId, name: t.name });
  for (const t of dataset.tasks) {
    add('tasks', t.id, {
      list_id: t.listId,
      parent_id: t.parentId,
      kind: t.kind,
      title: t.title,
      status: t.status,
      priority: t.priority,
      start_date: t.startDate,
      due_date: t.dueDate,
      due_time: t.dueTime,
      duration_min: t.durationMin,
      recurrence: t.recurrence,
      completed_at: t.status === 'done' ? (t.completedAt ?? new Date().toISOString()) : null,
      sort_key: t.sortKey,
    });
  }
  for (const t of dataset.tasks) for (const tag of t.tagIds) add('task_tags', taskTagId(t.id, tag), { task_id: t.id, tag_id: tag });
  for (const c of dataset.completions) {
    add('task_completions', completionId(c.taskId, c.occurrenceDate), { task_id: c.taskId, occurrence_date: c.occurrenceDate, kind: c.kind });
  }

  const start = Date.now();
  let rejected = 0;
  for (let i = 0; i < ops.length; i += 200) {
    const { data, error: pushError } = await client.rpc('push_changes', { p_ops: ops.slice(i, i + 200) });
    if (pushError) throw new Error(`push_changes: ${pushError.message}`);
    rejected += data.rejected.length;
    if (data.rejected.length) console.warn(data.rejected.slice(0, 3));
  }
  console.log(`${ops.length} operacji w ${Date.now() - start} ms (odrzucone: ${rejected}) → ${email}`);
}
