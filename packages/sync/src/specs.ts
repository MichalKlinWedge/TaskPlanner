/**
 * Jedyne mapowanie tabel synchronizowanych (migracja `*_poc1_sync.sql`) na lokalną bazę.
 * Nowa kolumna w migracji → tutaj też; typy z `packages/db` pilnują zgodności przy `tsc`
 * (każda kolumna bazy musi być albo systemowa, albo w `columns`).
 */
import type { Tables } from '@taskplanner/db';

/** Kolejność = `synced_tables()` w bazie (rodzice przed dziećmi). */
export const SYNCED_TABLES = [
  'workspaces', 'lists', 'tasks', 'tags', 'task_tags', 'task_completions', 'profiles', 'devices',
  'reminders', 'task_dependencies', 'time_entries', 'attachments', 'saved_filters', 'review_sessions',
  'collaborators', 'task_participants', 'task_comments',
] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

export const SYSTEM_COLUMNS = ['id', 'scope_id', 'created_at', 'updated_at', 'created_by', 'deleted_at', 'row_version', 'field_clock'] as const;
type SystemColumn = (typeof SYSTEM_COLUMNS)[number];

/**
 * `self` — zakres = id wiersza (przestrzeń, profil), `writable` — `scope_id` ustawia klient (lista →
 * przestrzeń), `personal` — zakres osobisty (klient może podać, domyślnie zalogowany użytkownik),
 * `derived` — zakres wylicza się z rodzica (zadanie z listy, wiersze zadania z zadania, zależność
 * z poprzednika, wpis czasu z zadania albo zakres osobisty).
 */
export type ScopeRule = 'self' | 'writable' | 'personal' | 'derived';

export interface TableSpec<T extends SyncedTable = SyncedTable> {
  /** Kolumny danych (bez systemowych), które klient może zapisać; `scope_id` tylko przy `writable` i `personal`. */
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
    columns: columns<'lists'>()(['scope_id', 'kind', 'name', 'color', 'icon', 'description_md', 'start_date', 'end_date', 'project_status', 'sort_key', 'view_prefs', 'archived_at']),
    json: ['view_prefs'],
    scope: 'writable',
  },
  tasks: {
    columns: columns<'tasks'>()([
      'list_id', 'parent_id', 'kind', 'title', 'description_md', 'status', 'priority', 'start_date', 'due_date', 'due_time',
      'duration_min', 'time_zone', 'recurrence', 'habit', 'completed_at', 'sort_key', 'board_sort_key', 'source', 'postpone_count',
      'assignee_id',
    ]),
    json: ['recurrence', 'habit', 'source'],
    scope: 'derived',
  },
  tags: {
    columns: columns<'tags'>()(['scope_id', 'name', 'color', 'sort_key', 'workspace_ids']),
    json: ['workspace_ids'],
    scope: 'personal',
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
  profiles: {
    columns: columns<'profiles'>()(['display_name', 'settings', 'focus', 'calendar_sync']),
    json: ['settings', 'focus', 'calendar_sync'],
    scope: 'self',
  },
  devices: {
    columns: columns<'devices'>()(['scope_id', 'name', 'platform', 'reminder_channel', 'push_subscription', 'last_sync_at']),
    json: ['push_subscription'],
    scope: 'personal',
  },
  reminders: {
    columns: columns<'reminders'>()(['task_id', 'kind', 'offset_min', 'at_date', 'at_time']),
    json: [],
    scope: 'derived',
  },
  task_dependencies: {
    columns: columns<'task_dependencies'>()(['predecessor_id', 'successor_id', 'kind', 'lag_days']),
    json: [],
    scope: 'derived',
  },
  time_entries: {
    columns: columns<'time_entries'>()(['task_id', 'kind', 'started_at', 'ended_at', 'pomodoro_index']),
    json: [],
    scope: 'derived',
  },
  attachments: {
    columns: columns<'attachments'>()(['task_id', 'kind', 'storage_path', 'name', 'mime', 'size_bytes', 'url', 'preview']),
    json: ['preview'],
    scope: 'derived',
  },
  saved_filters: {
    columns: columns<'saved_filters'>()(['scope_id', 'name', 'icon', 'query', 'sort_key']),
    json: ['query'],
    scope: 'personal',
  },
  review_sessions: {
    columns: columns<'review_sessions'>()(['scope_id', 'kind', 'started_at', 'finished_at', 'stats']),
    json: ['stats'],
    scope: 'personal',
  },
  collaborators: {
    columns: columns<'collaborators'>()(['scope_id', 'name', 'email', 'acronym', 'archived_at']),
    json: [],
    scope: 'personal',
  },
  task_participants: {
    columns: columns<'task_participants'>()(['task_id', 'collaborator_id']),
    json: [],
    scope: 'derived',
  },
  task_comments: {
    columns: columns<'task_comments'>()(['task_id', 'body', 'posted_at', 'edited_at']),
    json: [],
    scope: 'derived',
  },
};

// ── Tylko do odczytu (integracje, `pulled_readonly_tables()`) ─────────────────────────────────

/**
 * Tabele, które przychodzą w `pull_changes`, ale klient ich nie pisze (zapis: Edge Functions).
 * Lokalnie bez `field_clock` i outboxu; usunięcie (nagrobek / `deleted_at`) kasuje wiersz.
 */
export const READONLY_TABLES = ['calendar_accounts', 'calendars', 'calendar_events'] as const;
export type ReadonlyTable = (typeof READONLY_TABLES)[number];

const readonlyColumns = <T extends ReadonlyTable>() => <const C extends readonly (keyof Tables<T> & string)[]>(cols: C) => cols;

/** Lokalne kolumny (poza `id`, `scope_id`) — tylko te, które `pull_changes` wysyła klientom. */
export const READONLY: { [T in ReadonlyTable]: { columns: readonly string[]; bool: readonly string[] } } = {
  calendar_accounts: {
    columns: readonlyColumns<'calendar_accounts'>()(['provider', 'label', 'status', 'last_synced_at', 'last_error', 'created_at', 'updated_at', 'row_version']),
    bool: [],
  },
  calendars: {
    columns: readonlyColumns<'calendars'>()(['account_id', 'name', 'color', 'visible', 'is_task_target', 'last_synced_at', 'created_at', 'updated_at', 'row_version']),
    bool: ['visible', 'is_task_target'],
  },
  calendar_events: {
    columns: readonlyColumns<'calendar_events'>()([
      'calendar_id', 'external_id', 'title', 'all_day', 'start_at', 'end_at', 'start_date', 'end_date', 'location', 'task_id', 'created_at', 'updated_at', 'row_version',
    ]),
    bool: ['all_day'],
  },
};

export const readonlyColumnsOf = (table: ReadonlyTable): readonly string[] => ['id', 'scope_id', ...READONLY[table].columns];

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
  // Etap 13 (10 000 zadań): tagi zadania w zapytaniu widoków (`app-data.ts`) i podzadania bez listy
  // — bez indeksu każde zadanie przeglądało całe `task_tags` (start weba ~13 s).
  statements.push('create index if not exists tasks_parent on tasks (parent_id)');
  for (const table of ['reminders', 'attachments', 'time_entries', 'task_tags', 'task_completions', 'task_participants', 'task_comments'] as const) {
    statements.push(`create index if not exists ${table}_task on ${table} (task_id)`);
  }
  statements.push('create index if not exists task_dependencies_predecessor on task_dependencies (predecessor_id)');
  statements.push('create index if not exists task_dependencies_successor on task_dependencies (successor_id)');
  for (const table of READONLY_TABLES) {
    statements.push(`create table if not exists ${table} (${readonlyColumnsOf(table).map((c) => (c === 'id' ? 'id text primary key' : c)).join(', ')})`);
  }
  statements.push('create index if not exists calendars_account on calendars (account_id)');
  statements.push('create index if not exists calendar_events_calendar on calendar_events (calendar_id)');
  statements.push('create index if not exists calendar_events_start on calendar_events (start_at)');
  statements.push(
    "create table if not exists _outbox (seq integer primary key autoincrement, op_id text not null unique, tbl text not null, row_id text not null, data text not null, hlc text not null, status text not null default 'pending', error text)",
  );
  statements.push('create index if not exists _outbox_status on _outbox (status, seq)');
  statements.push('create table if not exists _meta (key text primary key, value text not null)');
  return statements;
}
