/**
 * Kilka kart przeglądarki nad jedną lokalną bazą (SPECYFIKACJA §6 „Web”): VFS `opfs-sahpool`
 * daje dostęp wyłączny, więc bazę i silnik synchronizacji trzyma **jedna karta-lider**
 * (Web Locks API). Pozostałe karty wysyłają zapytania i zmiany przez BroadcastChannel i dostają
 * powiadomienia o zmianach. Zamknięcie lidera zwalnia blokadę — kolejna karta przejmuje rolę.
 */
import type { SyncEngine } from './engine.ts';
import type { SqlRow, SqlValue } from './local-db.ts';
import { READONLY_TABLES, SYNCED_TABLES, type SyncedTable } from './specs.ts';

/** Tabele, o których zmianach dowiadują się widoki (także tylko do odczytu — kalendarze). */
const WATCHED = [...SYNCED_TABLES, ...READONLY_TABLES];

export interface TabStore {
  readonly isLeader: boolean;
  query<Row extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  mutate(table: SyncedTable, id: string, patch: Record<string, unknown>): Promise<void>;
  /** Kilka zmian w jednej transakcji, z jednym odświeżeniem widoków (`SyncEngine.mutateMany`). */
  mutateMany(ops: readonly { table: SyncedTable; id: string; patch: Record<string, unknown> }[]): Promise<void>;
  sync(): Promise<void>;
  pendingCount(): Promise<number>;
  /** Zmiana danych w tabelach (w tej albo innej karcie). */
  watch(tables: readonly string[], listener: () => void): () => void;
  /** Zmiana roli karty (lider / zwykła). */
  onRole(listener: (isLeader: boolean) => void): () => void;
  close(): void;
}

type Operation =
  | { op: 'query'; sql: string; params: SqlValue[] }
  | { op: 'mutate'; table: SyncedTable; id: string; patch: Record<string, unknown> }
  | { op: 'mutateMany'; ops: { table: SyncedTable; id: string; patch: Record<string, unknown> }[] }
  | { op: 'sync' }
  | { op: 'pending' };

type Message =
  | { kind: 'request'; id: string; from: string; body: Operation }
  | { kind: 'reply'; id: string; to: string; result?: unknown; error?: string }
  | { kind: 'changed'; tables: string[] }
  | { kind: 'leader'; tab: string };

export interface TabStoreOptions {
  /** Nazwa kanału i blokady (jedna na bazę). */
  name?: string;
  /** Wywoływane tylko w karcie, która została liderem: otwórz bazę i silnik. */
  createEngine: () => Promise<SyncEngine>;
  /** Czas oczekiwania na odpowiedź lidera przed ponowieniem (zmiana lidera w trakcie). */
  timeoutMs?: number;
}

export function connectTabs({ name = 'taskplanner', createEngine, timeoutMs = 4000 }: TabStoreOptions): TabStore {
  const tab = crypto.randomUUID();
  const channel = new BroadcastChannel(name);
  const listeners = new Map<string, Set<() => void>>();
  const roleListeners = new Set<(isLeader: boolean) => void>();
  const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let engine: SyncEngine | null = null;
  let ready: Promise<SyncEngine> | null = null;
  let release: (() => void) | null = null;
  let closed = false;

  const notify = (tables: Iterable<string>) => {
    const called = new Set<() => void>();
    for (const table of tables) for (const listener of listeners.get(table) ?? []) if (!called.has(listener)) (called.add(listener), listener());
  };

  const execute = async (body: Operation): Promise<unknown> => {
    const current = await ready!;
    switch (body.op) {
      case 'query':
        return current.db.all(body.sql, body.params);
      case 'mutate':
        await current.mutate(body.table, body.id, body.patch);
        return null;
      case 'mutateMany':
        await current.mutateMany(body.ops);
        return null;
      case 'sync':
        return current.sync();
      case 'pending':
        return current.pendingCount();
    }
  };

  // Lider: blokada trzymana do zamknięcia karty (albo `close`).
  void navigator.locks.request(`${name}-leader`, () => {
    if (closed) return;
    ready = createEngine().then((created) => {
      engine = created;
      for (const table of WATCHED) {
        created.watch([table], () => {
          notify([table]);
          channel.postMessage({ kind: 'changed', tables: [table] } satisfies Message);
        });
      }
      // Rola i odświeżenie widoków dopiero z gotowym silnikiem (`isLeader` = jest silnik).
      roleListeners.forEach((listener) => listener(true));
      notify(WATCHED);
      return created;
    });
    channel.postMessage({ kind: 'leader', tab } satisfies Message);
    return new Promise<void>((resolve) => (release = resolve));
  });

  channel.onmessage = async (event: MessageEvent<Message>) => {
    const message = event.data;
    if (message.kind === 'changed') notify(message.tables);
    else if (message.kind === 'leader' && message.tab !== tab) notify(WATCHED);
    else if (message.kind === 'request' && ready) {
      try {
        const result = await execute(message.body);
        channel.postMessage({ kind: 'reply', id: message.id, to: message.from, result } satisfies Message);
      } catch (error) {
        channel.postMessage({ kind: 'reply', id: message.id, to: message.from, error: String(error) } satisfies Message);
      }
    } else if (message.kind === 'reply' && message.to === tab) {
      const call = waiting.get(message.id);
      if (!call) return;
      waiting.delete(message.id);
      if (message.error !== undefined) call.reject(new Error(message.error));
      else call.resolve(message.result);
    }
  };

  const request = async (body: Operation): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      if (ready) return execute(body);
      const id = crypto.randomUUID();
      const reply = new Promise<unknown>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        setTimeout(() => {
          if (waiting.delete(id)) reject(new Error('timeout'));
        }, timeoutMs);
      });
      channel.postMessage({ kind: 'request', id, from: tab, body } satisfies Message);
      try {
        return await reply;
      } catch (error) {
        // Brak odpowiedzi: lider właśnie się zmienia — spróbuj jeszcze raz (może to my).
        if ((error as Error).message !== 'timeout' || attempt >= 3) throw error;
      }
    }
  };

  return {
    get isLeader() {
      return engine !== null;
    },
    query: (sql, params = []) => request({ op: 'query', sql, params: [...params] }) as Promise<never>,
    mutate: async (table, id, patch) => {
      await request({ op: 'mutate', table, id, patch });
    },
    mutateMany: async (ops) => {
      await request({ op: 'mutateMany', ops: [...ops] });
    },
    sync: async () => {
      await request({ op: 'sync' });
    },
    pendingCount: () => request({ op: 'pending' }) as Promise<number>,
    watch(tables, listener) {
      for (const table of tables) {
        if (!listeners.has(table)) listeners.set(table, new Set());
        listeners.get(table)!.add(listener);
      }
      return () => tables.forEach((table) => listeners.get(table)?.delete(listener));
    },
    onRole(listener) {
      roleListeners.add(listener);
      return () => roleListeners.delete(listener);
    },
    close() {
      closed = true;
      engine?.stop();
      release?.();
      channel.close();
    },
  };
}
