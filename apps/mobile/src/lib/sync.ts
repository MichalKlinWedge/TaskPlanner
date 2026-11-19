/**
 * Lokalna baza telefonu (expo-sqlite) i silnik synchronizacji (PoC-1). Jeden silnik na proces:
 * ekrany, akcje z powiadomień i widżet korzystają z tej samej instancji (zadanie w tle przy
 * działającej aplikacji wykonuje się w tym samym środowisku JS).
 *
 * Silnik nie wysyła sam (`autoSync: false`): zadanie w tle tylko zapisuje wiersz + outbox,
 * a wysyłkę zleca `requestSync()` — gdy użytkownik jest zalogowany.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseRemote, SYNCED_TABLES, SyncEngine, type LocalDb, type Remote, type SyncedTable } from '@taskplanner/sync';
import { openExpoDb } from '@taskplanner/sync/expo';
import { openDatabaseAsync } from 'expo-sqlite';
import Storage from 'expo-sqlite/kv-store';

import { saveSessionUser, serverConfig, sessionUser } from './config';

export const DB_NAME = 'taskplanner.db';

let client: SupabaseClient | null = null;
let clientFor = '';

export function supabaseClient(): SupabaseClient {
  const config = serverConfig();
  if (!config) throw new Error('Brak adresu serwera — ustaw go w „Serwer i konto”.');
  const id = `${config.url}|${config.key}`;
  if (!client || clientFor !== id) {
    client = createClient(config.url, config.key, {
      auth: { storage: Storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    clientFor = id;
  }
  return client;
}

/** Klient Supabase powstaje dopiero przy pierwszej synchronizacji — zapis w tle go nie potrzebuje. */
const lazyRemote: Remote = {
  push: (ops) => supabaseRemote(supabaseClient()).push(ops),
  pull: (since, limit) => supabaseRemote(supabaseClient()).pull(since, limit),
  subscribe: (onChange, onReady) => supabaseRemote(supabaseClient()).subscribe!(onChange, onReady),
};

type Listener = () => void;
const statusListeners = new Set<Listener>();
export let lastSyncError: string | null = null;
export let lastSyncAt: number | null = null;

function setSyncStatus(error: string | null) {
  lastSyncError = error;
  if (!error) lastSyncAt = Date.now();
  statusListeners.forEach((l) => l());
}

export function onSyncStatus(listener: Listener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

let dbPromise: Promise<LocalDb> | null = null;
let enginePromise: Promise<SyncEngine> | null = null;
let engineUser = '';

export function localDb(): Promise<LocalDb> {
  dbPromise ??= openDatabaseAsync(DB_NAME).then(openExpoDb);
  return dbPromise;
}

/** Silnik dla bieżącego użytkownika (albo trybu offline). */
export function localEngine(): Promise<SyncEngine> {
  const user = sessionUser();
  if (!enginePromise || engineUser !== user.id) {
    const previous = enginePromise;
    engineUser = user.id;
    enginePromise = (async () => {
      (await previous?.catch(() => null))?.stop();
      return SyncEngine.open({
        db: await localDb(),
        remote: lazyRemote,
        userId: user.id,
        autoSync: false,
        onError: (error) => setSyncStatus(error instanceof Error ? error.message : String(error)),
        onRejected: (rejected) => setSyncStatus(`odrzucone: ${rejected.map((r) => r.code).join(', ')}`),
      });
    })();
    enginePromise.catch(() => {
      enginePromise = null;
    });
  }
  return enginePromise;
}

/** Zapis lokalny + outbox; wysyłka „wkrótce”, jeśli jest konto. */
export async function mutate(table: SyncedTable, id: string, patch: Record<string, unknown>) {
  const engine = await localEngine();
  await engine.mutate(table, id, patch);
  if (sessionUser().online && serverConfig()) engine.requestSync();
}

export async function syncNow(): Promise<number> {
  if (!sessionUser().online) throw new Error('Tryb offline — zaloguj się, żeby synchronizować.');
  const engine = await localEngine();
  const start = Date.now();
  try {
    await engine.sync();
    setSyncStatus(null);
  } catch (error) {
    setSyncStatus(error instanceof Error ? error.message : String(error));
    throw error;
  }
  return Date.now() - start;
}

/** Realtime + pierwsze pobranie (tylko na ekranie, nie w zadaniu w tle). */
export async function startOnlineSync() {
  if (!sessionUser().online || !serverConfig()) return;
  const engine = await localEngine();
  engine.start();
  engine.requestSync(0);
}

/** Czyści lokalne dane (zmiana użytkownika: wiersze z innego zakresu zostałyby odrzucone). */
export async function resetLocal() {
  const db = await localDb();
  (await enginePromise?.catch(() => null))?.stop();
  enginePromise = null;
  await db.transaction(async (tx) => {
    for (const table of SYNCED_TABLES) await tx.run(`delete from ${table}`);
    await tx.run('delete from _outbox');
    await tx.run('delete from _meta');
  });
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabaseClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (sessionUser().id !== data.user.id) await resetLocal().catch(() => undefined);
  saveSessionUser({ id: data.user.id, email: data.user.email ?? email });
  await startOnlineSync();
}

export async function signOut() {
  await supabaseClient()
    .auth.signOut()
    .catch(() => undefined);
  await resetLocal().catch(() => undefined);
  saveSessionUser(null);
}
