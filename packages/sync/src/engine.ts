/**
 * Silnik synchronizacji local-first (SPECYFIKACJA §6). UI czyta i pisze tylko lokalną bazę;
 * `mutate` zapisuje wiersz i wpis outboxu w jednej transakcji, `sync` wysyła outbox
 * (`push_changes`) i pobiera przyrosty (`pull_changes`), Realtime jest tylko sygnałem do pobrania.
 */
import { HlcClock, READONLY_LIST_NOTE, uuidv7, type Hlc } from '@taskplanner/core';

import { addChange, type ChangeSet, type TableChanges } from './changes.ts';
import type { LocalDb, SqlRow } from './local-db.ts';
import { encodeRow, encodeValue, mergeClocks, mergeRemote, parseClock, rowChanged, type RemoteRow } from './merge.ts';
import type { PullResult, PushResult, RejectedOp, Remote } from './remote.ts';
import { localColumns, localSchema, READONLY, READONLY_TABLES, readonlyColumnsOf, SYNCED_TABLES, TABLES, writableFields, type ReadonlyTable, type SyncedTable } from './specs.ts';

export interface SyncEngineOptions {
  db: LocalDb;
  remote: Remote;
  /** Zalogowany użytkownik = jego zakres osobisty. */
  userId: string;
  /** Identyfikator urządzenia (węzeł HLC); bez niego — zapisany w bazie albo nowy. */
  deviceId?: string;
  now?: () => number;
  onRejected?: (rejected: RejectedOp[]) => void;
  onError?: (error: unknown) => void;
  /** Wysyłka zaraz po zapisie (domyślnie tak; testy sterują ręcznie). */
  autoSync?: boolean;
  /** Wierszy na stronę `pull_changes` (domyślnie 1 000). */
  pullPageSize?: number;
  /** Postęp pobierania (wskaźnik pierwszej synchronizacji) z pomiarem strony. */
  onPullProgress?: (progress: PullProgress) => void;
  /** Początek i koniec każdej synchronizacji (wskaźnik stanu): `ok` po udanej, `error` po nieudanej. */
  onSyncState?: (state: { syncing: true } | { syncing: false; ok: boolean; error?: unknown; at: number }) => void;
}

/** Strona `pull_changes`: numer, `done` po ostatniej, liczba wierszy, czas zapytania i czas zapisu do lokalnej bazy (ms). */
export interface PullProgress {
  page: number;
  done: boolean;
  rows: number;
  fetchMs: number;
  /** Transakcja zapisu (SQL + scalenie w JS), bez czekania w kolejce bazy. */
  writeMs: number;
  /** Czekanie na kolejkę bazy przed transakcją (inne zapytania, np. odświeżenie widoków). */
  waitMs: number;
  /** Z tego scalenie w JS (`mergeRemote`). */
  mergeMs: number;
}

/** Słuchacz zmian: dostaje wszystkie zmienione wiersze tej transakcji (też z innych tabel). */
type Listener = (changes: TableChanges) => void;

const PUSH_BATCH = 200;
const PULL_PAGE = 1000;
/**
 * Parametrów na jedno polecenie przy zapisie hurtowym. 999 = najniższy limit SQLite
 * (`SQLITE_MAX_VARIABLE_NUMBER` w starszych buildach); przy ~25 kolumnach to ~40 wierszy na polecenie.
 */
const MAX_PARAMS = 999;

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
/** Wersja zestawu tabel tylko do odczytu — zmiana wymusza ponowne pobranie zakresu osobistego. */
const READONLY_VERSION = '1';
/**
 * Zestaw tabel i kolumn synchronizowanych. Starsza wersja aplikacji pomijała w `pull_changes` tabele
 * i kolumny, których nie znała, a kursory zakresów i tak szły dalej — po aktualizacji te wiersze
 * nie przyszłyby same. Zmiana zestawu = raz wszystkie zakresy od zera (scalenie jest idempotentne).
 */
const SYNCED_SCHEMA = SYNCED_TABLES.map((t) => `${t}(${TABLES[t].columns.join(',')})`).join(';');
/** Wydarzenia kalendarzy starsze niż tyle dni (koniec) — usuwane lokalnie (okno serwera: −30 dni). */
const CALENDAR_KEEP_DAYS = 30;

export const READONLY_SCOPE_MESSAGE = 'Ta przestrzeń jest udostępniona Ci tylko do podglądu — zmiany może wprowadzać jej właściciel albo edytor.';

/**
 * Zmiana w przestrzeni, w której użytkownik ma rolę `viewer`, albo w liście udostępnionej mu tylko do
 * podglądu (`lists.guest_access`) — cała operacja `mutateMany` się wycofuje.
 */
export class ReadOnlyScopeError extends Error {
  constructor(message = READONLY_SCOPE_MESSAGE) {
    super(message);
    this.name = 'ReadOnlyScopeError';
  }
}

/** Tabele z kolumną `task_id` (dzieci zadania) — do czyszczenia danych ukrytych list. */
const TASK_CHILD_TABLES = SYNCED_TABLES.filter((t) => (TABLES[t].columns as readonly string[]).includes('task_id'));

export class SyncEngine {
  readonly db: LocalDb;
  readonly userId: string;
  private readonly remote: Remote;
  private readonly now: () => number;
  private clock!: HlcClock;
  private since: Record<string, number> = {};
  private listeners = new Map<string, Set<Listener>>();
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly options: SyncEngineOptions;

  private constructor(options: SyncEngineOptions) {
    this.options = options;
    this.db = options.db;
    this.remote = options.remote;
    this.userId = options.userId;
    this.now = options.now ?? (() => Date.now());
  }

  static async open(options: SyncEngineOptions): Promise<SyncEngine> {
    const engine = new SyncEngine(options);
    await engine.init();
    return engine;
  }

  get deviceId(): string {
    return this.clock.node;
  }

  private async init() {
    for (const statement of localSchema()) await this.db.run(statement);
    // `_scopes` sprzed dostępu gości do list (v1.x): bez kolumny `hidden`.
    const scopeColumns = new Set((await this.db.all<{ name: string }>('select name from pragma_table_info(?)', ['_scopes'])).map((c) => c.name));
    if (!scopeColumns.has('hidden')) await this.db.run("alter table _scopes add column hidden text not null default '[]'");
    // Baza z wcześniejszej wersji: brakujące kolumny dochodzą jako puste (wartości przyjdą z serwera
    // przy następnej zmianie wiersza; puste = domyślne, jak w bazie).
    for (const table of SYNCED_TABLES) {
      const existing = new Set((await this.db.all<{ name: string }>('select name from pragma_table_info(?)', [table])).map((c) => c.name));
      for (const column of localColumns(table)) {
        if (!existing.has(column)) await this.db.run(`alter table ${table} add column ${column}`);
      }
    }
    const meta = Object.fromEntries((await this.db.all<{ key: string; value: string }>('select key, value from _meta')).map((r) => [r.key, r.value]));
    const deviceId = this.options.deviceId ?? meta.device_id ?? uuidv7(this.now()).replace(/-/g, '').slice(-12);
    if (meta.device_id !== deviceId) await this.setMeta(this.db, 'device_id', deviceId);
    this.clock = new HlcClock(deviceId, this.now, meta.clock);
    this.since = meta.since ? JSON.parse(meta.since) : {};
    // Tabele tylko do odczytu doszły po pierwszej synchronizacji: zakres osobisty raz od zera (jego
    // wiersze przychodzą ponownie i scalają się bez zmian; przestrzenie — bez ponownego pobierania).
    if (meta.readonly_tables !== READONLY_VERSION) {
      if (this.since[this.userId] !== undefined) this.since[this.userId] = 0;
      await this.db.transaction(async (tx) => {
        await this.setMeta(tx, 'since', JSON.stringify(this.since));
        await this.setMeta(tx, 'readonly_tables', READONLY_VERSION);
      });
    }
    if (meta.synced_schema !== SYNCED_SCHEMA) {
      this.since = Object.fromEntries(Object.keys(this.since).map((scope) => [scope, 0]));
      await this.db.transaction(async (tx) => {
        await this.setMeta(tx, 'since', JSON.stringify(this.since));
        await this.setMeta(tx, 'synced_schema', SYNCED_SCHEMA);
      });
    }
  }

  private setMeta(db: LocalDb, key: string, value: string) {
    return db.run('insert into _meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value', [key, value]);
  }

  // ── Odczyt i powiadomienia ─────────────────────────────────────────────────────────────────

  /**
   * Zmiana danych w podanych tabelach (po zatwierdzeniu transakcji). Słuchacz dostaje id zmienionych
   * wierszy (`null` — nieznane, np. usunięcie zakresu) — widoki doczytują tylko je (`createTaskCache`).
   */
  watch(tables: readonly string[], listener: Listener): () => void {
    for (const table of tables) {
      if (!this.listeners.has(table)) this.listeners.set(table, new Set());
      this.listeners.get(table)!.add(listener);
    }
    return () => tables.forEach((table) => this.listeners.get(table)?.delete(listener));
  }

  private notify(changes: TableChanges) {
    const called = new Set<Listener>();
    for (const table of changes.keys()) {
      for (const listener of this.listeners.get(table) ?? []) {
        if (!called.has(listener)) {
          called.add(listener);
          listener(changes);
        }
      }
    }
  }

  async get(table: SyncedTable | ReadonlyTable, id: string): Promise<SqlRow | undefined> {
    return (await this.db.all(`select * from ${table} where id = ?`, [id]))[0];
  }

  async pendingCount(): Promise<number> {
    return Number((await this.db.all<{ n: number }>("select count(*) as n from _outbox where status = 'pending'"))[0]?.n ?? 0);
  }

  async rejectedOps(): Promise<SqlRow[]> {
    return this.db.all("select * from _outbox where status = 'rejected' order by seq");
  }

  // ── Zapis lokalny ──────────────────────────────────────────────────────────────────────────

  /** Wstaw albo zmień wiersz: tylko podane pola, z nowym HLC; wpis do outboxu w tej samej transakcji. */
  async mutate(table: SyncedTable, id: string, patch: Record<string, unknown>): Promise<Hlc> {
    const [hlc] = await this.mutateMany([{ table, id, patch }]);
    return hlc!;
  }

  /**
   * Kilka zmian w jednej transakcji (przesunięcie projektu na osi, operacje grupowe): jedno
   * powiadomienie widoków i jedna synchronizacja zamiast osobnych dla każdej zmiany. Pola spoza
   * tabeli — błąd przed zapisem czegokolwiek.
   */
  async mutateMany(ops: readonly { table: SyncedTable; id: string; patch: Record<string, unknown> }[]): Promise<Hlc[]> {
    if (!ops.length) return [];
    for (const { table, patch } of ops) {
      const allowed = writableFields(table);
      const unknown = Object.keys(patch).filter((f) => !allowed.includes(f));
      if (unknown.length) throw new Error(`Pola spoza ${table}: ${unknown.join(', ')}`);
    }
    const stamps = await this.db.transaction(async (tx) => {
      const out: Hlc[] = [];
      // Przestrzeń udostępniona do podglądu: serwer i tak odrzuci zmianę (TP003), więc nie zapisujemy jej lokalnie.
      const readOnly = new Set((await tx.all("select id from _scopes where role = 'viewer'")).map((r) => String(r.id)));
      // Gość (edytor): listy tylko do podglądu i zakaz zmiany dostępu gości — jak `stamp_row` w bazie.
      const guestScopes = new Set((await tx.all("select id from _scopes where role <> 'owner'")).map((r) => String(r.id)));
      const readOnlyLists = guestScopes.size
        ? new Set((await tx.all("select l.id from lists l join _scopes s on s.id = l.scope_id where s.role = 'editor' and l.guest_access = 'view'")).map((r) => String(r.id)))
        : new Set<string>();
      for (const { table, id, patch } of ops) {
        const fields = Object.keys(patch);
        const stamp = this.clock.tick();
        const current = (await tx.all(`select * from ${table} where id = ?`, [id]))[0];
        const row: SqlRow = current ? { ...current } : Object.fromEntries(localColumns(table).map((c) => [c, null]));
        row.id = id;
        for (const field of fields) row[field] = encodeValue(table, field, patch[field]);
        const clock = parseClock(current?.field_clock);
        for (const field of fields) clock[field] = stamp;
        row.field_clock = JSON.stringify(clock);
        await this.deriveScope(tx, table, row);
        if (readOnly.size && (readOnly.has(String(row.scope_id)) || readOnly.has(String(current?.scope_id)))) throw new ReadOnlyScopeError();
        if (guestScopes.has(String(row.scope_id)) || guestScopes.has(String(current?.scope_id))) {
          if (table === 'lists') {
            if ((row.guest_access ?? 'edit') !== 'edit' || (current && (current.guest_access ?? 'edit') !== 'edit')) throw new ReadOnlyScopeError(READONLY_LIST_NOTE);
          } else if (readOnlyLists.size && (await this.rowLists(tx, table, row, current)).some((list) => readOnlyLists.has(list))) {
            throw new ReadOnlyScopeError(READONLY_LIST_NOTE);
          }
        }
        await this.upsert(tx, table, row);
        await tx.run('insert into _outbox (op_id, tbl, row_id, data, hlc) values (?, ?, ?, ?, ?)', [uuidv7(this.now()), table, id, JSON.stringify(patch), stamp]);
        out.push(stamp);
      }
      await this.setMeta(tx, 'clock', this.clock.last);
      return out;
    });
    const changes: ChangeSet = new Map();
    for (const { table, id } of ops) addChange(changes, table, id);
    this.notify(changes);
    if (this.options.autoSync !== false) this.requestSync();
    return stamps;
  }

  /** Miękkie usunięcie (`deleted_at`). */
  remove(table: SyncedTable, id: string): Promise<Hlc> {
    return this.mutate(table, id, { deleted_at: new Date(this.now()).toISOString() });
  }

  /** Zakres wiersza liczony lokalnie jak w triggerach bazy (UI filtruje po przestrzeni przed synchronizacją). */
  private async deriveScope(tx: LocalDb, table: SyncedTable, row: SqlRow) {
    const rule = TABLES[table].scope;
    const taskScope = async (taskId: unknown) =>
      (await tx.all('select scope_id from tasks where id = ?', [(taskId as string | null | undefined) ?? null]))[0]?.scope_id;
    if (rule === 'self') row.scope_id = row.id ?? null;
    else if (rule === 'personal') row.scope_id = row.scope_id ?? this.userId;
    else if (table === 'tasks') {
      if (row.parent_id) {
        const parent = (await tx.all('select list_id from tasks where id = ?', [row.parent_id]))[0];
        if (parent?.list_id) row.list_id = parent.list_id;
      }
      const list = (await tx.all('select scope_id from lists where id = ?', [row.list_id ?? null]))[0];
      if (list?.scope_id) row.scope_id = list.scope_id;
    } else if (table === 'task_dependencies') {
      row.scope_id = (await taskScope(row.predecessor_id)) ?? row.scope_id ?? null;
    } else if (table === 'time_entries') {
      row.scope_id = row.task_id ? ((await taskScope(row.task_id)) ?? row.scope_id ?? null) : this.userId;
    } else if (rule === 'derived') {
      row.scope_id = (await taskScope(row.task_id)) ?? row.scope_id ?? null;
    }
  }

  /** Listy wiersza przed i po zmianie (zadanie — jego lista, dziecko zadania — lista zadania, zależność — obu zadań). */
  private async rowLists(tx: LocalDb, table: SyncedTable, row: SqlRow, current: SqlRow | undefined): Promise<string[]> {
    const tasks = new Set<unknown>();
    const lists = new Set<unknown>();
    for (const r of current ? [row, current] : [row]) {
      if (table === 'tasks') lists.add(r.list_id);
      else if (table === 'task_dependencies') [r.predecessor_id, r.successor_id].forEach((id) => tasks.add(id));
      else if (TASK_CHILD_TABLES.includes(table)) tasks.add(r.task_id);
    }
    const taskIds = [...tasks].filter((id): id is string => typeof id === 'string');
    if (taskIds.length) {
      for (const r of await tx.all(`select list_id from tasks where id in (${taskIds.map(() => '?').join(', ')})`, taskIds)) lists.add(r.list_id);
    }
    return [...lists].filter((id): id is string => typeof id === 'string');
  }

  /**
   * Usunięcie z urządzenia list, które stały się ukryte, i zadań, które na nie trafiły — razem
   * z podzadaniami, dziećmi zadań, zależnościami i niewysłanymi zmianami tych wierszy (serwer i tak
   * by je odrzucił). Bez outboxu: to nie jest usunięcie danych, tylko utrata wglądu.
   */
  private async purge(tx: LocalDb, { lists = [], tasks = [] }: { lists?: readonly string[]; tasks?: readonly string[] }, touched: ChangeSet) {
    const taskIds = new Set(tasks);
    for (const part of chunks(lists, MAX_PARAMS)) {
      for (const r of await tx.all(`select id from tasks where list_id in (${part.map(() => '?').join(', ')})`, part)) taskIds.add(String(r.id));
    }
    for (let frontier = [...taskIds]; frontier.length; ) {
      const next: string[] = [];
      for (const part of chunks(frontier, MAX_PARAMS)) {
        for (const r of await tx.all(`select id from tasks where parent_id in (${part.map(() => '?').join(', ')})`, part)) {
          if (!taskIds.has(String(r.id))) {
            taskIds.add(String(r.id));
            next.push(String(r.id));
          }
        }
      }
      frontier = next;
    }
    /** `where` z jednym `(?)` na listę id (albo `perId` takich miejsc). */
    const drop = async (table: SyncedTable, where: string, ids: readonly string[], perId = 1) => {
      for (const part of chunks(ids, Math.floor((MAX_PARAMS - 1) / perId))) {
        const condition = where.replaceAll('(?)', `(${part.map(() => '?').join(', ')})`);
        const params = Array.from({ length: perId }, () => part).flat();
        await tx.run(`delete from _outbox where tbl = ? and row_id in (select id from ${table} where ${condition})`, [table, ...params]);
        await tx.run(`delete from ${table} where ${condition}`, params);
      }
      addChange(touched, table, null);
    };
    const allTasks = [...taskIds];
    if (allTasks.length) {
      for (const table of TASK_CHILD_TABLES) await drop(table, 'task_id in (?)', allTasks);
      await drop('task_dependencies', 'predecessor_id in (?) or successor_id in (?)', allTasks, 2);
      await drop('tasks', 'id in (?)', allTasks);
    }
    if (lists.length) await drop('lists', 'id in (?)', lists);
  }

  private upsert(tx: LocalDb, table: SyncedTable, row: SqlRow) {
    return this.upsertMany(tx, table, [row]);
  }

  /**
   * Wiele wierszy jednym poleceniem `insert … values (…), (…)` (porcje do `MAX_PARAMS`).
   * Na telefonie każde wywołanie to przejście przez most JS ↔ natywny — zapis po wierszu
   * był głównym kosztem pierwszej synchronizacji (MVP-1, M8).
   */
  private async upsertMany(tx: LocalDb, table: SyncedTable, rows: readonly SqlRow[]) {
    if (!rows.length) return;
    const columns = localColumns(table);
    const placeholders = `(${columns.map(() => '?').join(', ')})`;
    const update = columns.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
    for (const part of chunks(rows, Math.max(1, Math.floor(MAX_PARAMS / columns.length)))) {
      await tx.run(
        `insert into ${table} (${columns.join(', ')}) values ${part.map(() => placeholders).join(', ')}
         on conflict (id) do update set ${update}`,
        part.flatMap((row) => columns.map((c) => row[c] ?? null)),
      );
    }
  }

  /** Lokalne wiersze o podanych id (porcjami). */
  private async loadMany(tx: LocalDb, table: SyncedTable, ids: readonly string[]): Promise<Map<string, SqlRow>> {
    const out = new Map<string, SqlRow>();
    for (const part of chunks(ids, MAX_PARAMS)) {
      for (const row of await tx.all(`select * from ${table} where id in (${part.map(() => '?').join(', ')})`, part)) out.set(row.id as string, row);
    }
    return out;
  }

  // ── Synchronizacja ─────────────────────────────────────────────────────────────────────────

  /** Wysłanie outboxu i pobranie zmian; wywołania w trakcie trwającej synchronizacji łączą się w jedną następną. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      this.options.onSyncState?.({ syncing: true });
      try {
        do {
          this.again = false;
          await this.push();
          await this.pull();
        } while (this.again);
        this.options.onSyncState?.({ syncing: false, ok: true, at: this.now() });
      } catch (error) {
        this.options.onSyncState?.({ syncing: false, ok: false, error, at: this.now() });
        throw error;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Synchronizacja „wkrótce” (łączy serię zapisów w jedną wysyłkę). */
  requestSync(delayMs = 30) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sync().catch((error) => this.options.onError?.(error));
    }, delayMs);
  }

  /** Nasłuch Realtime: każdy sygnał i gotowość subskrypcji = pobranie przyrostowe. */
  start() {
    if (this.unsubscribe || !this.remote.subscribe) return;
    this.unsubscribe = this.remote.subscribe(
      () => this.requestSync(),
      () => this.requestSync(0),
    );
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async push(): Promise<void> {
    for (;;) {
      const ops = await this.db.all<{ seq: number; op_id: string; tbl: string; row_id: string; data: string; hlc: string } & SqlRow>(
        "select seq, op_id, tbl, row_id, data, hlc from _outbox where status = 'pending' order by seq limit ?",
        [PUSH_BATCH],
      );
      if (!ops.length) return;
      const result: PushResult = await this.remote.push(
        ops.map((o) => ({ op: o.op_id, table: o.tbl as SyncedTable, id: o.row_id, set: JSON.parse(o.data), hlc: o.hlc })),
      );
      const rejected = new Map(result.rejected.map((r) => [r.op, r]));
      const touched: ChangeSet = new Map();
      await this.db.transaction(async (tx) => {
        for (const op of ops) {
          const reason = rejected.get(op.op_id);
          if (reason) await tx.run("update _outbox set status = 'rejected', error = ? where seq = ?", [`${reason.code}: ${reason.message}`, op.seq]);
          else await tx.run('delete from _outbox where seq = ?', [op.seq]);
        }
        // Wersja serwera nadpisuje lokalną (odrzucona albo obcięta zmiana nie może zostać „nowsza”).
        for (const { table, id, row } of result.rows) {
          addChange(touched, table, id);
          if (row) await this.upsert(tx, table, encodeRow(table, row));
          else await tx.run(`delete from ${table} where id = ?`, [id]);
        }
        this.clock.receive(result.serverHlc);
        await this.setMeta(tx, 'clock', this.clock.last);
      });
      if (touched.size) this.notify(touched);
      if (result.rejected.length) this.options.onRejected?.(result.rejected);
    }
  }

  /** Wiersz tabeli tylko do odczytu: zastąpienie albo usunięcie (z dziećmi usuniętego konta / kalendarza). */
  private async applyReadonly(tx: LocalDb, table: ReadonlyTable, remote: RemoteRow) {
    const id = String(remote.id);
    if (remote.deleted_at) {
      if (table === 'calendar_accounts') {
        await tx.run('delete from calendar_events where calendar_id in (select id from calendars where account_id = ?)', [id]);
        await tx.run('delete from calendars where account_id = ?', [id]);
      }
      if (table === 'calendars') await tx.run('delete from calendar_events where calendar_id = ?', [id]);
      await tx.run(`delete from ${table} where id = ?`, [id]);
      return;
    }
    const columns = readonlyColumnsOf(table);
    const bool = READONLY[table].bool;
    await tx.run(
      `insert or replace into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
      columns.map((c) => {
        const value = remote[c];
        if (value === undefined || value === null) return null;
        if (bool.includes(c)) return value ? 1 : 0;
        return typeof value === 'object' ? JSON.stringify(value) : (value as string | number);
      }),
    );
  }

  /** Pobranie wszystkich zmian stronami (`pull_changes` z limitem; pierwsza pełna migawka też w porcjach). */
  async pull(): Promise<void> {
    // Słuchacze (odświeżenie widoków) dostają zmiany raz, po ostatniej stronie: odczyty między
    // stronami stawały w kolejce bazy przed zapisem kolejnej (na telefonie 16 s z 23 s pierwszej synchronizacji).
    const touched: ChangeSet = new Map();
    try {
      for (let page = 0; ; page++) {
        const { more, ...timing } = await this.pullPage(touched);
        this.options.onPullProgress?.({ page: page + 1, done: !more, ...timing });
        if (!more) return;
      }
    } finally {
      if (touched.size) this.notify(touched);
    }
  }

  private async pullPage(touched: ChangeSet): Promise<{ more: boolean } & Omit<PullProgress, 'page' | 'done'>> {
    const started = Date.now();
    const result: PullResult = await this.remote.pull(this.since, this.options.pullPageSize ?? PULL_PAGE);
    const fetched = Date.now();
    let count = 0;
    let began = 0;
    let mergeMs = 0;
    let more = result.more === true;
    await this.db.transaction(async (tx) => {
      began = Date.now();
      // Tabela po tabeli (rodzice przed dziećmi): jedno zapytanie o lokalne wiersze, scalenie w JS,
      // zapis hurtowy. Wiersze, w których coś zostało lokalne (niewysłana zmiana), dostają zakres
      // liczony z rodzica już zapisanego w tej transakcji — po kolei, po zapisie hurtowym reszty.
      for (const table of SYNCED_TABLES) {
        const remotes = (result.tables[table] ?? []) as RemoteRow[];
        if (!remotes.length) continue;
        count += remotes.length;
        const locals = await this.loadMany(tx, table, remotes.map((r) => r.id as string));
        const plain: SqlRow[] = [];
        const won: SqlRow[] = [];
        const merging = Date.now();
        for (const remote of remotes) {
          const local = locals.get(remote.id as string);
          const { row, localWon } = mergeRemote(table, local, remote);
          (localWon ? won : plain).push(row);
          // Słuchacze tylko przy realnej zmianie (nie przy powrocie własnego zapisu z nową wersją).
          if (rowChanged(local, row)) addChange(touched, table, String(row.id));
        }
        mergeMs += Date.now() - merging;
        await this.upsertMany(tx, table, plain);
        for (const row of won) {
          await this.deriveScope(tx, table, row);
          await this.upsert(tx, table, row);
        }
      }
      // Wiersze, które przestały być widoczne (przeniesione na ukrytą listę) — usuwane u siebie.
      for (const gone of result.tables._gone ?? []) {
        if (gone.table === 'tasks') await this.purge(tx, { tasks: [gone.id] }, touched);
        else if (gone.table === 'lists') await this.purge(tx, { lists: [gone.id] }, touched);
        else if ((SYNCED_TABLES as readonly string[]).includes(gone.table)) {
          await tx.run('delete from _outbox where tbl = ? and row_id = ?', [gone.table, gone.id]);
          await tx.run(`delete from ${gone.table} where id = ?`, [gone.id]);
          addChange(touched, gone.table, gone.id);
        }
      }
      for (const table of READONLY_TABLES) {
        for (const remote of (result.tables[table] ?? []) as RemoteRow[]) {
          await this.applyReadonly(tx, table, remote);
          // Usunięcie konta / kalendarza zabiera też wiersze dzieci — id nieznane.
          addChange(touched, table, null);
        }
      }
      // Wydarzenia sprzed okna synchronizacji (serwer też je usuwa — `cron/renew`).
      const cutoff = new Date(this.now() - CALENDAR_KEEP_DAYS * 86_400_000).toISOString();
      await tx.run('delete from calendar_events where (all_day = 0 and end_at < ?) or (all_day = 1 and end_date < ?)', [cutoff, cutoff.slice(0, 10)]);
      // Zakres, do którego użytkownik stracił dostęp: jego wiersze znikają z urządzenia.
      for (const scope of Object.keys(this.since)) {
        if (!result.scopes[scope]) {
          for (const table of [...SYNCED_TABLES, ...READONLY_TABLES]) {
            await tx.run(`delete from ${table} where scope_id = ?`, [scope]);
            addChange(touched, table, null);
          }
        }
      }
      // Ukryte listy (`lists.guest_access = 'hidden'`, nie właściciel): nowo ukryte znikają z urządzenia,
      // odsłonięte — zakres od zera (ich wiersze nie przyszły w przyrostach).
      const storedScopes = await tx.all<{ id: string; kind: string; role: string; hidden: string }>('select id, kind, role, hidden from _scopes');
      const storedHidden = new Map(storedScopes.map((s) => [s.id, new Set<string>(JSON.parse(s.hidden || '[]') as string[])]));
      const repull: string[] = [];
      for (const [id, info] of Object.entries(result.scopes)) {
        const before = storedHidden.get(id) ?? new Set<string>();
        const after = new Set(info.hidden ?? []);
        const hidden = [...after].filter((list) => !before.has(list));
        if (hidden.length) await this.purge(tx, { lists: hidden }, touched);
        if ([...before].some((list) => !after.has(list)) && this.since[id] !== undefined) repull.push(id);
      }
      // Role w zakresach (współdzielone przestrzenie, `viewer` = tylko odczyt) — widoki czytają `_scopes`
      // razem z `workspaces`, więc zmiana roli odświeża je jak zmiana przestrzeni.
      const scopeKey = (id: string, kind: string, role: string, hidden: Iterable<string>) => `${id}:${kind}:${role}:${[...hidden].sort().join('|')}`;
      const roles = Object.entries(result.scopes).map(([id, info]) => scopeKey(id, info.kind, info.role, info.hidden ?? [])).sort();
      const stored = storedScopes.map((s) => scopeKey(s.id, s.kind, s.role, storedHidden.get(s.id) ?? [])).sort();
      if (roles.join() !== stored.join()) {
        await tx.run('delete from _scopes');
        for (const [id, info] of Object.entries(result.scopes)) {
          await tx.run('insert into _scopes (id, kind, role, hidden) values (?, ?, ?, ?)', [id, info.kind, info.role, JSON.stringify(info.hidden ?? [])]);
        }
        addChange(touched, 'workspaces', null);
        addChange(touched, 'lists', null);
      }
      this.since = Object.fromEntries(Object.entries(result.scopes).map(([id, info]) => [id, info.version]));
      for (const id of repull) this.since[id] = 0;
      if (repull.length) more = true;
      await this.setMeta(tx, 'since', JSON.stringify(this.since));
      this.clock.receive(result.serverHlc);
      await this.setMeta(tx, 'clock', this.clock.last);
    });
    const written = Date.now();
    return { more, rows: count, fetchMs: fetched - started, writeMs: written - began, waitMs: began - fetched, mergeMs };
  }
}

export { mergeClocks };
