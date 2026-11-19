/**
 * Urządzenia testowe: osobna lokalna baza (node:sqlite w pamięci), osobny klient Supabase,
 * przełącznik sieci i przesunięcie zegara. Ten sam użytkownik może mieć kilka urządzeń.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { inject } from 'vitest';

import { openNodeDb } from '../../adapters/node.ts';
import { SyncEngine, type PullProgress } from '../../engine.ts';
import { supabaseRemote, type RejectedOp, type Remote } from '../../remote.ts';

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export interface Device {
  name: string;
  engine: SyncEngine;
  client: SupabaseClient;
  /** Przesunięcie zegara urządzenia w ms. */
  clock: { offset: number };
  net: { online: boolean };
  /** Liczba wywołań `pull_changes` (do sprawdzania, co je wywołało). */
  stats: { pulls: number };
  rejected: RejectedOp[];
  close(): Promise<void>;
}

const config = () => inject('supabase');

export async function createUser(label: string): Promise<TestUser> {
  const { url, serviceKey } = config();
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@test.local`;
  const password = 'haslo-testowe-123';
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  return { id: data.user.id, email, password };
}

/** Usunięcie konta (kaskadą znikają jego zakresy i wszystkie wiersze) — utrata danych na serwerze. */
export async function deleteUser(id: string): Promise<void> {
  const { url, serviceKey } = config();
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) throw new Error(`deleteUser: ${error.message}`);
}

export async function createDevice(user: TestUser, name: string, options: { pullPageSize?: number; onPullProgress?: (p: PullProgress) => void } = {}): Promise<Device> {
  const { url, anonKey } = config();
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`signIn: ${error.message}`);
  const net = { online: true };
  const clock = { offset: 0 };
  const rejected: RejectedOp[] = [];
  const stats = { pulls: 0 };
  const base = supabaseRemote(client, `sync-${name}-${crypto.randomUUID()}`);
  const offline = () => Promise.reject(new Error(`${name}: brak sieci`));
  const remote: Remote = {
    push: (ops) => (net.online ? base.push(ops) : offline()),
    pull: (since, limit) => {
      stats.pulls++;
      return net.online ? base.pull(since, limit) : offline();
    },
    subscribe: base.subscribe!,
  };
  const db = openNodeDb();
  const engine = await SyncEngine.open({
    db,
    remote,
    userId: user.id,
    deviceId: name,
    now: () => Date.now() + clock.offset,
    autoSync: false,
    onRejected: (ops) => rejected.push(...ops),
    ...options,
  });
  return {
    name,
    engine,
    client,
    clock,
    net,
    stats,
    rejected,
    async close() {
      engine.stop();
      await client.removeAllChannels();
      await client.auth.signOut();
      db.close();
    },
  };
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000, label = 'warunek'): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Nie doczekano się: ${label} (${timeoutMs} ms)`);
}
