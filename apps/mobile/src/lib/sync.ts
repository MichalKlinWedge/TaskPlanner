/**
 * Lokalna baza telefonu (expo-sqlite) i silnik synchronizacji. Jeden silnik na proces:
 * ekrany, akcje z powiadomień i widżet korzystają z tej samej instancji (zadanie w tle przy
 * działającej aplikacji wykonuje się w tym samym środowisku JS).
 *
 * Silnik nie wysyła sam (`autoSync: false`): zadanie w tle tylko zapisuje wiersz + outbox,
 * a wysyłkę zleca `requestSync()` — gdy użytkownik jest zalogowany. Na ekranie synchronizację
 * budzą też: Realtime, powrót sieci (`expo-network`), powrót aplikacji na wierzch i ponowienia
 * po błędzie (kryterium MVP-1: zmiana z trybu samolotowego na serwerze < 5 s po włączeniu sieci).
 */
import { createClient, isAuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseRemote, SYNCED_TABLES, SyncEngine, type LocalDb, type PullProgress, type Remote, type SyncedTable } from '@taskplanner/sync';
import { openExpoDb } from '@taskplanner/sync/expo';
import * as Network from 'expo-network';
import { openDatabaseAsync } from 'expo-sqlite';
import Storage from 'expo-sqlite/kv-store';
import { AppState } from 'react-native';

import { readJson, serverConfig, sessionUser, writeJson } from './config';
import { reportError } from './error-log';
import { perfLog } from './perf';

export const DB_NAME = 'taskplanner.db';

/** Limit czasu żądania do Supabase (poza Storage — pliki mogą iść długo). */
const FETCH_TIMEOUT_MS = 30_000;
/** Funkcje ✨ (`ai/…`): odpowiedź modelu z naprawą i modelem zastępczym; limit funkcji to 150 s. */
const AI_TIMEOUT_MS = 140_000;

/**
 * `fetch` z limitem czasu: bez niego jedno zawieszone połączenie (otwarte gniazdo bez odpowiedzi,
 * np. po zmianie sieci) trzyma synchronizację do restartu aplikacji. Po przekroczeniu żądanie kończy
 * się błędem, a silnik ponawia je jak każdy błąd sieci.
 */
const fetchWithTimeout: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/storage/v1/')) return fetch(input, init);
  const controller = new AbortController();
  const outer = init?.signal;
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener('abort', () => controller.abort(), { once: true });
  // Funkcje ✨ czekają na model dostawcy (z naprawą odpowiedzi i modelem zastępczym).
  const timeoutMs = url.includes('/functions/v1/ai/') ? AI_TIMEOUT_MS : FETCH_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal })
    .catch((error: unknown) => {
      if (controller.signal.aborted && !outer?.aborted) throw new Error(`Serwer nie odpowiedział w ${timeoutMs / 1000} s (timeout)`); // „timeout” — `isTransientError`, nie do dziennika błędów
      throw error;
    })
    .finally(() => clearTimeout(timer));
};

let client: SupabaseClient | null = null;
let clientFor = '';

export function supabaseClient(): SupabaseClient {
  const config = serverConfig();
  if (!config) throw new Error('Brak adresu serwera — ustaw go w „Konto i serwer”.');
  const id = `${config.url}|${config.key}`;
  if (!client || clientFor !== id) {
    client = createClient(config.url, config.key, {
      // PKCE: link z maila i powrót z Google przychodzą z `?code=`, który wymienia ten sam klient
      // (weryfikator kodu leży w tym samym kv-store).
      auth: { storage: Storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'pkce' },
      global: { fetch: fetchWithTimeout },
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

// ── Stan synchronizacji (wskaźnik na ekranach) ──────────────────────────────────────────────

export interface SyncStatus {
  syncing: boolean;
  /** Ostatnia udana synchronizacja (ms) — zapamiętana per użytkownik. */
  lastAt: number | null;
  error: string | null;
  /** Pobieranie stronami: numer strony, `done` po ostatniej. */
  pull: { page: number; done: boolean } | null;
  /** Jeszcze żadna synchronizacja tego konta się nie udała (pierwsza pełna migawka). */
  firstSync: boolean;
  /** Pomiar ostatniego pobrania z wierszami (zapamiętany): ile trwało zapytanie, a ile zapis do SQLite. */
  pullPerf: PullPerf | null;
  /** Konto jest, ale sesji Supabase już nie ma (`checkAuth`) — synchronizacja czeka na ponowne logowanie; dane lokalne zostają. */
  authLost: boolean;
}

/** Suma stron jednego pobrania: `fetchMs` = `pull_changes` (sieć + serwer + JSON), `writeMs` = transakcja w expo-sqlite. */
export interface PullPerf {
  at: number;
  pages: number;
  rows: number;
  fetchMs: number;
  writeMs: number;
  /** Czekanie na kolejkę bazy przed zapisem strony. */
  waitMs: number;
  /** Część zapisu: scalenie w JS. */
  mergeMs: number;
  totalMs: number;
  /** Najwolniejsza strona (ms zapytania / zapisu). */
  slowest: { fetchMs: number; writeMs: number };
}

type Listener = () => void;
const statusListeners = new Set<Listener>();
const lastAtKey = (userId: string) => `sync.lastAt.${userId}`;
const PULL_PERF_KEY = 'sync.pullPerf';

function initialStatus(): SyncStatus {
  const lastAt = Number(Storage.getItemSync(lastAtKey(sessionUser().id))) || null;
  return { syncing: false, lastAt, error: null, pull: null, firstSync: lastAt === null, pullPerf: readJson<PullPerf | null>(PULL_PERF_KEY, null), authLost: false };
}

/** Bieżące pobranie (strony jednej synchronizacji); zapisywane od 100 wierszy. */
let perf: PullPerf | null = null;

function recordPullPage(page: PullProgress) {
  if (page.page === 1 || !perf) perf = { at: Date.now(), pages: 0, rows: 0, fetchMs: 0, writeMs: 0, waitMs: 0, mergeMs: 0, totalMs: 0, slowest: { fetchMs: 0, writeMs: 0 } };
  perf.pages = page.page;
  perf.rows += page.rows;
  perf.fetchMs += page.fetchMs;
  perf.writeMs += page.writeMs;
  perf.waitMs += page.waitMs;
  perf.mergeMs += page.mergeMs;
  perf.totalMs = Date.now() - perf.at;
  if (page.fetchMs + page.writeMs > perf.slowest.fetchMs + perf.slowest.writeMs) perf.slowest = { fetchMs: page.fetchMs, writeMs: page.writeMs };
  if (page.done) perfLog('pull', perf.totalMs, JSON.stringify(perf));
  // Drobne pobrania (pojedyncza zmiana z webu) nie nadpisują pomiaru dużego.
  if (page.done && perf.rows >= 100) {
    writeJson(PULL_PERF_KEY, perf);
    setStatus({ pullPerf: { ...perf } });
  }
}

let status: SyncStatus = initialStatus();

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  statusListeners.forEach((l) => l());
}

export const syncStatus = () => status;

export function onSyncStatus(listener: Listener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Czy klient Supabase ma sesję zapamiętanego konta. Bez niej zapytania idą jako `anon` („permission
 * denied for function pull_changes”): telefon pamięta konto i dane, ale sesja przepadła (odświeżenie
 * odrzucone, dane aplikacji zachowane przy odinstalowaniu). Wtedy `authLost` — synchronizacja stoi,
 * a Ustawienia pozwalają zalogować się ponownie bez czyszczenia danych (to samo konto = te same dane).
 * Błąd sieci przy odświeżaniu tokenu nie jest utratą sesji.
 */
export async function checkAuth(): Promise<boolean> {
  const user = sessionUser();
  if (!user.online || !serverConfig()) return true;
  let ok = true;
  try {
    const { data, error } = await supabaseClient().auth.getSession();
    ok = data.session ? data.session.user.id === user.id : !!error && isAuthRetryableFetchError(error);
  } catch {
    ok = true;
  }
  if (sessionUser().id === user.id && status.authLost === ok) setStatus(ok ? { authLost: false } : { authLost: true, syncing: false, error: 'sesja wygasła — zaloguj się ponownie' });
  return ok;
}

// ── Zmiana konta (ekrany odświeżają zapytania i bramkę onboardingu) ─────────────────────────

const sessionListeners = new Set<Listener>();

export function onSessionChange(listener: Listener): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

export function notifySessionChange() {
  status = initialStatus();
  statusListeners.forEach((l) => l());
  sessionListeners.forEach((l) => l());
}

/**
 * Po każdej udanej synchronizacji (zadania są już na serwerze): kolejka plików, podglądy linków,
 * dziennik błędów.
 */
const syncedListeners = new Set<Listener>();

export function onSynced(listener: Listener): () => void {
  syncedListeners.add(listener);
  return () => syncedListeners.delete(listener);
}

// ── Silnik ──────────────────────────────────────────────────────────────────────────────────

let dbPromise: Promise<LocalDb> | null = null;
let enginePromise: Promise<SyncEngine> | null = null;
let engineUser = '';
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;

export function localDb(): Promise<LocalDb> {
  dbPromise ??= openDatabaseAsync(DB_NAME).then(openExpoDb);
  return dbPromise;
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/** Po nieudanej synchronizacji: ponowienie za 2, 4, 8… s (najwyżej 30 s), o ile jest konto. */
function scheduleRetry(engine: SyncEngine) {
  if (retryTimer || !sessionUser().online) return;
  const delay = Math.min(30_000, 2_000 * 2 ** Math.min(failures - 1, 4));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (engineUser === engine.userId) engine.requestSync(0);
  }, delay);
}

/** Silnik dla bieżącego użytkownika (albo trybu offline). */
export function localEngine(): Promise<SyncEngine> {
  const user = sessionUser();
  if (!enginePromise || engineUser !== user.id) {
    const previous = enginePromise;
    engineUser = user.id;
    clearRetry();
    failures = 0;
    enginePromise = (async () => {
      (await previous?.catch(() => null))?.stop();
      const engine: SyncEngine = await SyncEngine.open({
        db: await localDb(),
        remote: lazyRemote,
        userId: user.id,
        autoSync: false,
        onError: (error) => {
          setStatus({ error: errorText(error) });
          reportError('sync', error);
        },
        onRejected: (rejected) => {
          setStatus({ error: `odrzucone: ${rejected.map((r) => r.code).join(', ')}` });
          // Jak na webie: każdy kod osobno, bez danych zadań.
          for (const op of rejected) reportError('rejected', { code: op.code, message: op.message });
        },
        onPullProgress: (pull) => {
          recordPullPage(pull);
          setStatus({ pull: { page: pull.page, done: pull.done } });
        },
        onSyncState: (state) => {
          if (state.syncing) return setStatus({ syncing: true });
          if (state.ok) {
            failures = 0;
            clearRetry();
            Storage.setItemSync(lastAtKey(user.id), String(state.at));
            setStatus({ syncing: false, lastAt: state.at, error: null, firstSync: false });
            syncedListeners.forEach((l) => l());
          } else {
            failures++;
            setStatus({ syncing: false, error: errorText(state.error) });
            // Bez sesji ponawianie nic nie da — czeka na ponowne logowanie.
            void checkAuth().then((ok) => ok && scheduleRetry(engine));
          }
        },
      });
      return engine;
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

/** Kilka zmian w jednej transakcji (jedno odświeżenie widoków) — przejście timera, decyzja przeglądu. */
export async function mutateMany(ops: readonly { table: SyncedTable; id: string; patch: Record<string, unknown> }[]) {
  if (!ops.length) return;
  const engine = await localEngine();
  await engine.mutateMany(ops);
  if (sessionUser().online && serverConfig()) engine.requestSync();
}

export async function syncNow(): Promise<number> {
  if (!sessionUser().online) throw new Error('Tryb offline — zaloguj się, żeby synchronizować.');
  const engine = await localEngine();
  const start = Date.now();
  await engine.sync();
  return Date.now() - start;
}

/**
 * Ile zmian z telefonu nie dotarło jeszcze na serwer — po próbie wysłania (wylogowanie czyści lokalne
 * dane, więc niewysłane by przepadły). Bez sieci albo sesji zostaje liczba z kolejki.
 */
export async function unsentChanges(): Promise<number> {
  const engine = await localEngine();
  const left = await engine.pendingCount();
  if (!left || !sessionUser().online || !serverConfig() || !(await checkAuth())) return left;
  await engine.sync().catch(() => undefined);
  return engine.pendingCount();
}

let wakeups: { remove(): void }[] = [];

/** Realtime + pierwsze pobranie + budzenie po powrocie sieci i aplikacji (tylko na ekranie, nie w zadaniu w tle). */
export async function startOnlineSync() {
  if (!sessionUser().online || !serverConfig()) return;
  if (!(await checkAuth())) return;
  const engine = await localEngine();
  engine.start();
  engine.requestSync(0);
  if (!wakeups.length) {
    const wake = async () => {
      if (!sessionUser().online || status.authLost) return;
      (await localEngine()).requestSync(0);
    };
    wakeups = [
      Network.addNetworkStateListener((state) => {
        if (state.isConnected && state.isInternetReachable !== false) void wake();
      }),
      AppState.addEventListener('change', (next) => {
        if (next === 'active') void wake();
      }),
    ];
  }
}

/** Czyści lokalne dane (zmiana użytkownika: wiersze z innego zakresu zostałyby odrzucone). */
export async function resetLocal() {
  const db = await localDb();
  (await enginePromise?.catch(() => null))?.stop();
  enginePromise = null;
  engineUser = '';
  clearRetry();
  await db.transaction(async (tx) => {
    for (const table of SYNCED_TABLES) await tx.run(`delete from ${table}`);
    await tx.run('delete from _outbox');
    await tx.run('delete from _meta');
  });
}
