/**
 * Jedyne mapowanie tabel synchronizowanych (migracja `*_poc1_sync.sql`) na lokalną bazę.
 * Nowa kolumna w migracji → tutaj też; typy z `packages/db` pilnują zgodności przy `tsc`
 * (każda kolumna bazy musi być albo systemowa, albo w `columns`).
 */
import type { Tables } from '@taskplanner/db';

export const SYNCED_TABLES = ['workspaces', 'lists', 'tasks', 'tags', 'task_tags', 'task_completions'] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

export const SYSTEM_COLUMNS = ['id', 'scope_id', 'created_at', 'updated_at', 'created_by', 'deleted_at', 'row_version', 'field_clock'] as const;
type SystemColumn = (typeof SYSTEM_COLUMNS)[number];

/**
 * `self` — zakres = id wiersza (przestrzeń), `writable` — `scope_id` ustawia klient (lista → przestrzeń,
 * tag → zakres osobisty), `derived` — zakres wylicza się z rodzica (zadanie z listy, tag zadania z zadania).
 */
export type ScopeRule = 'self' | 'writable' | 'derived';

export interface TableSpec<T extends SyncedTable = SyncedTable> {
  /** Kolumny danych (bez systemowych), które klient może zapisać; `scope_id` tylko przy `writable`. */
  columns: readonly (keyof Tables<T> & string)[];
  /** Kolumny `jsonb` — lokalnie tekst JSON. */
  json: readonly (keyof Tables<T> & string)[];
  scope: ScopeRule;
}

type Exhaustive<T extends SyncedTable, C extends readonly string[]> =
  Exclude<keyof Tables<T> & string, SystemColumn | C[number]> extends never ? C : { brakujące_kolumny: Exclude<keyof Tables<T> & string, SystemColumn | C[number]> };

const columns = <T extends SyncedTable>() => <const C extends readonly (keyof Tables<T> & string)[]>(cols: C & Exhaustive<T, C>) => cols;

export const TABLES: { [T in SyncedTable]: TableSpec<T> } = {
  workspaces: {
    columns: columns<'workspaces'>()(['name', 'color', 'icon', 'sort_key', 'archived_at']),
    json: [],
    scope: 'self',
  },
  lists: {
    columns: columns<'lists'>()(['scope_id', 'kind', 'name', 'color', 'icon', 'description_md', 'start_date', 'end_date', 'project_status', 'sort_key', 'view_prefs']),
    json: ['view_prefs'],
    scope: 'writable',
  },
  tasks: {
    columns: columns<'tasks'>()([
      'list_id', 'parent_id', 'kind', 'title', 'description_md', 'status', 'priority', 'start_date', 'due_date', 'due_time',
      'duration_min', 'time_zone', 'recurrence', 'habit', 'completed_at', 'sort_key', 'source', 'postpone_count',
    ]),
    json: ['recurrence', 'habit', 'source'],
    scope: 'derived',
  },
  tags: {
    columns: columns<'tags'>()(['scope_id', 'name', 'color', 'sort_key']),
    json: [],
    scope: 'writable',
  },
  task_tags: {
    columns: columns<'task_tags'>()(['task_id', 'tag_id']),
    json: [],
    scope: 'derived',
  },
  task_completions: {
    columns: columns<'task_completions'>()(['task_id', 'occurrence_date', 'kind', 'value', 'completed_at']),
    json: [],
    scope: 'derived',
  },
};

/** Pola, które klient wysyła w `push_changes` (= `writable_columns` w bazie). */
export const writableFields = (table: SyncedTable): readonly string[] => [...TABLES[table].columns, 'deleted_at'];

/** Wszystkie kolumny lokalnej tabeli. */
export const localColumns = (table: SyncedTable): readonly string[] => [
  ...SYSTEM_COLUMNS,
  ...TABLES[table].columns.filter((c) => c !== 'scope_id'),
];

export const isSyncedTable = (value: string): value is SyncedTable => (SYNCED_TABLES as readonly string[]).includes(value);

/** Schemat lokalnej bazy: tabele synchronizowane + outbox + metadane. */
export function localSchema(): string[] {
  const statements: string[] = [];
  for (const table of SYNCED_TABLES) {
    const cols = localColumns(table)
      .map((c) => (c === 'id' ? 'id text primary key' : c === 'field_clock' ? "field_clock text not null default '{}'" : c))
      .join(', ');
    statements.push(`create table if not exists ${table} (${cols})`);
    statements.push(`create index if not exists ${table}_scope on ${table} (scope_id)`);
  }
  statements.push('create index if not exists tasks_list on tasks (list_id, parent_id)');
  statements.push(
    "create table if not exists _outbox (seq integer primary key autoincrement, op_id text not null unique, tbl text not null, row_id text not null, data text not null, hlc text not null, status text not null default 'pending', error text)",
  );
  statements.push('create index if not exists _outbox_status on _outbox (status, seq)');
  statements.push('create table if not exists _meta (key text primary key, value text not null)');
  return statements;
}
