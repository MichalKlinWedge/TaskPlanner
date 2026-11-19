import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { inboxId, uuidv7 } from '@taskplanner/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { inject } from 'vitest';

export { sql } from '../setup.ts';

/** Konta testów PoC-6 — usuwane na starcie przebiegu (`setup.ts`), razem z kontami kalendarzy. */
export const TEST_DOMAIN = 'edge.test.local';

export const edge = () => inject('edge');

export function adminClient(): SupabaseClient {
  const { url, serviceKey } = edge();
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export interface TestUser {
  id: string;
  email: string;
  client: SupabaseClient;
  jwt: string;
}

export async function createUser(label: string): Promise<TestUser> {
  const { url, anonKey } = edge();
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@${TEST_DOMAIN}`;
  const password = 'haslo-testowe-123';
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s, error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2 || !s.session) throw new Error(`signIn: ${e2?.message}`);
  return { id: data.user.id, email, client, jwt: s.session.access_token };
}

let counter = 0;
const hlc = () => `${String(Date.now()).padStart(15, '0')}:${String(++counter % 100000).padStart(5, '0')}:test`;
const op = (table: string, id: string, set: Record<string, unknown>) => ({ op: uuidv7(), table, id, set, hlc: hlc() });

/** Przestrzeń z Inboxem (jak klient: `push_changes`). */
export async function createWorkspace(user: TestUser, name: string, extraLists: { name: string; kind?: string }[] = []) {
  const ws = uuidv7();
  const inbox = inboxId(ws);
  const lists = extraLists.map((l) => ({ id: uuidv7(), ...l }));
  const { data, error } = await user.client.rpc('push_changes', {
    p_ops: [
      op('workspaces', ws, { name }),
      op('lists', inbox, { scope_id: ws, kind: 'inbox', name: 'Inbox' }),
      ...lists.map((l) => op('lists', l.id, { scope_id: ws, kind: l.kind ?? 'list', name: l.name })),
    ],
  });
  if (error || data.rejected.length) throw new Error(`push_changes: ${error?.message ?? JSON.stringify(data.rejected)}`);
  return { id: ws, inbox, lists: Object.fromEntries(lists.map((l) => [l.name, l.id])) as Record<string, string> };
}

export async function createTag(user: TestUser, id: string, name: string) {
  const { data, error } = await user.client.rpc('push_changes', { p_ops: [op('tags', id, { name })] });
  if (error || data.rejected.length) throw new Error(`tag: ${error?.message ?? JSON.stringify(data.rejected)}`);
}

export function fn(path: string, init: RequestInit & { jwt?: string; cron?: boolean } = {}): Promise<Response> {
  const { functionsUrl, cronSecret } = edge();
  const headers = new Headers(init.headers);
  if (init.jwt) headers.set('authorization', `Bearer ${init.jwt}`);
  if (init.cron) headers.set('x-cron-secret', cronSecret);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${functionsUrl}/${path}`, { method: 'POST', ...init, headers });
}

export async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 10_000, label = 'warunek', intervalMs = 50): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Nie doczekano się: ${label} (${timeoutMs} ms)`);
}

/** Pomiary do `docs/POC_WYNIKI.md` — dopisywane do `tools/edge-tests/out/pomiary.jsonl`. */
export function measure(label: string, ms: number) {
  const dir = fileURLToPath(new URL('../../out/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  appendFileSync(`${dir}pomiary.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), label, ms: Math.round(ms) })}
`);
  console.log(`[pomiar] ${label}: ${Math.round(ms)} ms`);
}
