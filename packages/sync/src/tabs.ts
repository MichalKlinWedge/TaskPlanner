/**
 * Kilka kart przeglądarki nad jedną lokalną bazą (SPECYFIKACJA §6 „Web”): VFS `opfs-sahpool`
 * daje dostęp wyłączny, więc bazę i silnik synchronizacji trzyma **jedna karta-lider**
 * (Web Locks API). Pozostałe karty wysyłają zapytania i zmiany przez BroadcastChannel i dostają
 * powiadomienia o zmianach. Zamknięcie lidera zwalnia blokadę — kolejna karta przejmuje rolę.
 *
 * Po wdrożeniu nowej wersji liderem może zostać karta otwarta wcześniej (stary kod, starsza baza).
 * Odpowiedzi niosą wersję protokołu (`TAB_PROTOCOL`): lider starszy od karty — albo sprzed
 * wersjonowania, który nieznaną operację „wykonywał” bez błędu — oznacza kartę jako
 * `staleLeader` (UI prosi o odświeżenie tamtej karty), a zapis zbiorczy kończy się błędem zamiast
 * zgubić zmiany. Lider odrzuca operacje, których nie zna.
 */
import { changesFromJson, changesToJson, wholeTables, type TableChanges } from './changes.ts';
import type { SyncEngine } from './engine.ts';
import type { SqlRow, SqlValue } from './local-db.ts';
import { READONLY_TABLES, SYNCED_TABLES, type SyncedTable } from './specs.ts';

/** Tabele, o których zmianach dowiadują się widoki (także tylko do odczytu — kalendarze). */
const WATCHED = [...SYNCED_TABLES, ...READONLY_TABLES];

export interface TabStore {
  readonly isLeader: boolean;
  /** Lider ma starszą wersję aplikacji (zapisy mogą się nie udać) — UI prosi o odświeżenie tamtej karty. */
  readonly staleLeader: boolean;
  onStale(listener: (stale: boolean) => void): () => void;
  query<Row extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  mutate(table: SyncedTable, id: string, patch: Record<string, unknown>): Promise<void>;
  /** Kilka zmian w jednej transakcji, z jednym odświeżeniem widoków (`SyncEngine.mutateMany`). */
  mutateMany(ops: readonly { table: SyncedTable; id: string; patch: Record<string, unknown> }[]): Promise<void>;
  sync(): Promise<void>;
  pendingCount(): Promise<number>;
  /** Zmiana danych w tabelach (w tej albo innej karcie) z id zmienionych wierszy (`SyncEngine.watch`). */
  watch(tables: readonly string[], listener: (changes: TableChanges) => void): () => void;
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

/**
 * Wersja protokołu kart — podbić, gdy dochodzi operacja albo zmienia się schemat lokalnej bazy
 * (nowa kolumna / tabela, której starszy lider nie ma). 1 = brak pola (do Etapu 7), 2 = `mutateMany`,
 * `profiles.focus`, `review_sessions` w przeglądzie, 3 = `collaborators`, `task_participants`,
 * `task_comments`, `tasks.assignee_id`, 4 = `collaborators.acronym`, `collaborators.archived_at`,
 * 5 = `tags.workspace_ids`, 6 = `collaborators.workspace_ids`, 7 = `workspaces.board_columns`,
 * `tasks.board_column_id`, 8 = `lists.board_columns`, 9 = `_scopes` (role w zakresach),
 * 10 = `lists.guest_access`, `_scopes.hidden`, 11 = `_scopes.members`, 12 = `scope_collaborators`, 13 = `scope_tags`, 14 = `tasks.canvas_pos`, `lists.canvas_groups`, `task_tags.sort_key`,
 * 15 = `plugin_rules`, `plugin_requests`, `plugin_connections` (pluginy, M21), 16 = `project_templates`, 17 = `tasks.derived_from`. Pole `ids` w `changed` nie podbija wersji:
 * jest opcjonalne w obie strony (bez niego widoki czytają całe tabele).
 */
export const TAB_PROTOCOL = 17;

/** Błąd zapisu przez lidera ze starszą wersją aplikacji. */
export const STALE_LEADER_MESSAGE = 'Aplikacja jest otwarta w innej karcie w starszej wersji — odśwież albo zamknij tamtą kartę i spróbuj ponownie.';

type Message =
  | { kind: 'request'; id: string; from: string; body: Operation; v?: number }
  | { kind: 'reply'; id: string; to: string; result?: unknown; error?: string; v?: number }
  // `ids` — zmienione wiersze (starsza karta bierze tylko `tables` i czyta całe tabele).
  | { kind: 'changed'; tables: string[]; ids?: Record<string, string[] | null> }
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
  const listeners = new Map<string, Set<(changes: TableChanges) => void>>();
  const roleListeners = new Set<(isLeader: boolean) => void>();
  const waiting = new Map<string, { op: Operation['op']; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let engine: SyncEngine | null = null;
  let ready: Promise<SyncEngine> | null = null;
  let release: (() => void) | null = null;
  let closed = false;
  let stale = false;
  const staleListeners = new Set<(stale: boolean) => void>();
  const setStale = (value: boolean) => {
    if (stale === value) return;
    stale = value;
    staleListeners.forEach((listener) => listener(value));
  };

  const notify = (changes: TableChanges) => {
    const called = new Set<(changes: TableChanges) => void>();
    for (const table of changes.keys()) for (const listener of listeners.get(table) ?? []) if (!called.has(listener)) (called.add(listener), listener(changes));
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
      default:
        throw new Error(`Nieznana operacja kart: ${(body as { op?: string }).op}`);
    }
  };

  // Lider: blokada trzymana do zamknięcia karty (albo `close`).
  void navigator.locks.request(`${name}-leader`, () => {
    if (closed) return;
    ready = createEngine().then((created) => {
      engine = created;
      setStale(false);
      created.watch(WATCHED, (changes) => {
        notify(changes);
        channel.postMessage({ kind: 'changed', tables: [...changes.keys()], ids: changesToJson(changes) } satisfies Message);
      });
      // Rola i odświeżenie widoków dopiero z gotowym silnikiem (`isLeader` = jest silnik).
      roleListeners.forEach((listener) => listener(true));
      notify(wholeTables(WATCHED));
      return created;
    });
    channel.postMessage({ kind: 'leader', tab } satisfies Message);
    return new Promise<void>((resolve) => (release = resolve));
  });

  channel.onmessage = async (event: MessageEvent<Message>) => {
    const message = event.data;
    if (message.kind === 'changed') notify(changesFromJson(message.tables, message.ids));
    else if (message.kind === 'leader' && message.tab !== tab) {
      // Nowy lider — wersję sprawdzi pierwsza odpowiedź.
      setStale(false);
      notify(wholeTables(WATCHED));
    }
    else if (message.kind === 'request' && ready) {
      try {
        const result = await execute(message.body);
        channel.postMessage({ kind: 'reply', id: message.id, to: message.from, result, v: TAB_PROTOCOL } satisfies Message);
      } catch (error) {
        channel.postMessage({ kind: 'reply', id: message.id, to: message.from, error: error instanceof Error ? error.message : String(error), v: TAB_PROTOCOL } satisfies Message);
      }
    } else if (message.kind === 'reply' && message.to === tab) {
      const call = waiting.get(message.id);
      if (!call) return;
      waiting.delete(message.id);
      const older = (message.v ?? 1) < TAB_PROTOCOL;
      setStale(older);
      if (message.error !== undefined) call.reject(new Error(older ? `${STALE_LEADER_MESSAGE} (${message.error})` : message.error));
      else if (older && call.op === 'mutateMany') call.reject(new Error(STALE_LEADER_MESSAGE));
      else call.resolve(message.result);
    }
  };

  const request = async (body: Operation): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      if (ready) return execute(body);
      const id = crypto.randomUUID();
      const reply = new Promise<unknown>((resolve, reject) => {
        waiting.set(id, { op: body.op, resolve, reject });
        setTimeout(() => {
          if (waiting.delete(id)) reject(new Error('timeout'));
        }, timeoutMs);
      });
      channel.postMessage({ kind: 'request', id, from: tab, body, v: TAB_PROTOCOL } satisfies Message);
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
    get staleLeader() {
      return stale;
    },
    onStale(listener) {
      staleListeners.add(listener);
      return () => staleListeners.delete(listener);
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
