/**
 * Kopia zapasowa JSON własnych danych (Etap 13, „Kopie zapasowe”; bez importu z innych narzędzi —
 * D13). Plik = koperta (`format`, `version`, konto, chwila eksportu) i wiersze tabel
 * synchronizowanych z polami, które zapisuje klient (`MODEL` + `deleted_at`). Import nie omija
 * synchronizacji: z pliku i lokalnej bazy powstaje lista zmian dla `mutateMany` (te same id, tylko
 * pola, które się różnią), więc drugi import tego samego pliku nie zmienia niczego.
 *
 * Poza kopią: `devices` (urządzenia i subskrypcje push są przypisane do przeglądarki / telefonu),
 * tabele integracji (konta i wydarzenia kalendarzy pisze serwer, tokeny są w Vault), pliki
 * załączników w Storage (w kopii jest tylko opis załącznika) i kolumny systemowe (`created_at`,
 * `row_version`, `field_clock` — nadaje je serwer).
 */
import { z } from 'zod';

import { Instant, MODEL, type ModelTable } from './schemas/model.ts';

export const BACKUP_FORMAT = 'taskplanner-backup';
export const BACKUP_VERSION = 1;

/** Tabele w kopii w kolejności importu (rodzice przed dziećmi; współpracownicy przed zadaniami — `tasks.assignee_id`). */
export const BACKUP_TABLES = [
  'profiles', 'workspaces', 'lists', 'collaborators', 'tasks', 'tags', 'task_tags', 'task_completions',
  'reminders', 'task_dependencies', 'time_entries', 'attachments', 'saved_filters', 'review_sessions',
  'task_participants', 'task_comments',
] as const satisfies readonly ModelTable[];
export type BackupTable = (typeof BACKUP_TABLES)[number];

export type BackupRow = { id: string } & Record<string, unknown>;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  /** Chwila eksportu (ISO). */
  exportedAt: string;
  /** Konto, z którego pochodzi kopia (= zakres osobisty i id profilu). */
  userId: string;
  tables: Record<BackupTable, BackupRow[]>;
}

/** Pola wiersza w kopii: `id`, kolumny zapisywane przez klienta i `deleted_at` (kosz też wraca). */
export const backupFields = (table: BackupTable): readonly string[] => [...Object.keys(MODEL[table].shape), 'deleted_at'];

const rowSchemas = Object.fromEntries(
  BACKUP_TABLES.map((table) => [table, z.intersection(MODEL[table], z.object({ deleted_at: Instant.nullable() }))]),
) as unknown as Record<BackupTable, z.ZodType>;

/** Koperta pliku; wiersze sprawdza się osobno (zły wiersz nie przekreśla całej kopii). */
const Envelope = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int(),
  exportedAt: Instant,
  userId: z.uuid(),
  tables: z.partialRecord(z.enum(BACKUP_TABLES), z.array(z.record(z.string(), z.unknown()))),
});

export class BackupError extends Error {
  override name = 'BackupError';
}

export interface InvalidRow {
  table: BackupTable;
  id: string | null;
  message: string;
}

/**
 * Wartości domyślne kolumn `not null` w bazie (migracje). Wiersz zapisany offline ma je lokalnie
 * puste, dopóki nie wróci z serwera — eksport wpisuje to, co wpisałby serwer. Zgodność z bazą
 * sprawdza `supabase/tests/backup.test.sql` (`completed_at = now()` ustawia zawsze klient).
 */
export const BACKUP_DEFAULTS: Partial<Record<BackupTable, Record<string, unknown>>> = {
  lists: { kind: 'list', sort_key: 'n', view_prefs: {} },
  profiles: { settings: {} },
  saved_filters: { query: {}, sort_key: 'n' },
  tags: { sort_key: 'n' },
  task_completions: { kind: 'done' },
  task_dependencies: { kind: 'finish_to_start', lag_days: 0 },
  tasks: { kind: 'task', postpone_count: 0, priority: 4, sort_key: 'n', status: 'todo' },
  workspaces: { sort_key: 'n' },
};

const pick = (table: BackupTable, row: Record<string, unknown>, defaults: Record<string, unknown> = {}): BackupRow =>
  Object.fromEntries(backupFields(table).map((field) => [field, row[field] ?? defaults[field] ?? null])) as BackupRow;

/** Kopia z wierszy lokalnej bazy (`jsonb` już odczytane); wiersze po `id`, tylko pola kopii, puste kolumny `not null` → domyślne bazy. */
export function createBackup({ userId, exportedAt, tables }: { userId: string; exportedAt: string; tables: Partial<Record<BackupTable, readonly Record<string, unknown>[]>> }): Backup {
  const out = {} as Record<BackupTable, BackupRow[]>;
  for (const table of BACKUP_TABLES) {
    out[table] = (tables[table] ?? [])
      .map((row) => pick(table, row, BACKUP_DEFAULTS[table]))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt, userId, tables: out };
}

const issueText = (error: z.ZodError) =>
  error.issues
    .slice(0, 3)
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');

/**
 * Odczyt pliku kopii. Zła koperta (nie ta aplikacja, nowsza wersja) — `BackupError`; wiersze
 * niezgodne ze schematem albo z powtórzonym id są pomijane i wracają w `invalid`.
 * W kopii zostają wartości z pliku, nie wynik `parse` (bez domyślnych i przycinania), żeby
 * import odtworzył dane dokładnie.
 */
export function readBackup(input: unknown): { backup: Backup; invalid: InvalidRow[] } {
  const head = z.object({ format: z.string(), version: z.unknown() }).safeParse(input);
  if (!head.success || head.data.format !== BACKUP_FORMAT) throw new BackupError('To nie jest plik kopii Task Plannera.');
  if (typeof head.data.version === 'number' && head.data.version > BACKUP_VERSION) {
    throw new BackupError(`Kopia z nowszej wersji aplikacji (format ${head.data.version}) — zaktualizuj aplikację.`);
  }
  const envelope = Envelope.safeParse(input);
  if (!envelope.success || envelope.data.version !== BACKUP_VERSION) {
    throw new BackupError(`Uszkodzony plik kopii: ${envelope.success ? 'nieznana wersja formatu' : issueText(envelope.error)}.`);
  }
  const invalid: InvalidRow[] = [];
  const tables = {} as Record<BackupTable, BackupRow[]>;
  for (const table of BACKUP_TABLES) {
    const seen = new Set<string>();
    tables[table] = [];
    for (const raw of envelope.data.tables[table] ?? []) {
      const id = typeof raw.id === 'string' ? raw.id : null;
      const checked = rowSchemas[table].safeParse(raw);
      if (!checked.success) invalid.push({ table, id, message: issueText(checked.error) });
      else if (seen.has(id!)) invalid.push({ table, id, message: 'Powtórzony identyfikator.' });
      else {
        seen.add(id!);
        tables[table].push(pick(table, raw));
      }
    }
  }
  const { exportedAt, userId } = envelope.data;
  return { backup: { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt, userId, tables }, invalid };
}

// ── Porównanie wartości ──────────────────────────────────────────────────────────────────────

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

/**
 * Ta sama wartość pola: `null` = brak, chwile porównywane jako czas (`…Z` z urządzenia i
 * `…+00:00` z Postgresa to ta sama chwila), `jsonb` bez względu na kolejność kluczy.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === 'string' && typeof b === 'string' && INSTANT.test(a) && INSTANT.test(b)) {
    const [x, y] = [Date.parse(a), Date.parse(b)];
    return !Number.isNaN(x) && x === y;
  }
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export interface BackupDifference {
  table: BackupTable;
  id: string;
  /** Brak pola = wiersza nie ma w jednej z kopii. */
  field?: string;
  a: unknown;
  b: unknown;
}

/** Różnice między dwiema kopiami (te same dane = pusta lista); kopia `b` po przeniesieniu na konto `a`. */
export function compareBackups(a: Backup, b: Backup): BackupDifference[] {
  const other = moveToUser(b, a.userId);
  const out: BackupDifference[] = [];
  for (const table of BACKUP_TABLES) {
    const right = new Map(other.tables[table].map((row) => [row.id, row]));
    for (const row of a.tables[table]) {
      const match = right.get(row.id);
      right.delete(row.id);
      if (!match) out.push({ table, id: row.id, a: row, b: undefined });
      else for (const field of backupFields(table)) if (!sameValue(row[field], match[field])) out.push({ table, id: row.id, field, a: row[field], b: match[field] });
    }
    for (const [id, row] of right) out.push({ table, id, a: undefined, b: row });
  }
  return out;
}

// ── Import ───────────────────────────────────────────────────────────────────────────────────

/**
 * Kopia innego konta przeniesiona na `userId`: zakres osobisty (`scope_id` = stare konto) i id
 * profilu dostają nowe konto; wybór kalendarza Google odpada (integracje łączy się od nowa).
 * Id przestrzeni, list i zadań zostają.
 */
export function moveToUser(backup: Backup, userId: string): Backup {
  if (backup.userId === userId) return backup;
  const from = backup.userId;
  const tables = {} as Record<BackupTable, BackupRow[]>;
  for (const table of BACKUP_TABLES) {
    tables[table] = backup.tables[table].map((row) => {
      const next: BackupRow = { ...row };
      if (next.scope_id === from) next.scope_id = userId;
      if (table === 'profiles' && next.id === from) {
        next.id = userId;
        next.calendar_sync = null;
      }
      return next;
    });
  }
  return { ...backup, userId, tables };
}

export interface BackupOp {
  table: BackupTable;
  id: string;
  patch: Record<string, unknown>;
}

export interface BackupPlan {
  /** Zmiany dla `mutateMany` w kolejności importu (rodzice przed dziećmi). */
  ops: BackupOp[];
  /** Na tabelę: nowe wiersze, zmienione, bez zmian. */
  stats: Record<BackupTable, { added: number; changed: number; same: number }>;
  /** Kopia z innego konta (zakres osobisty przeniesiony — `moveToUser`). */
  otherAccount: boolean;
}

/** Zadania tak, żeby rodzic był przed podzadaniem (serwer wylicza listę podzadania z rodzica). */
function parentsFirst(rows: readonly BackupRow[]): BackupRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const depth = new Map<string, number>();
  const depthOf = (row: BackupRow): number => {
    const known = depth.get(row.id);
    if (known !== undefined) return known;
    let d = 0;
    const seen = new Set<string>([row.id]);
    for (let parent = byId.get(row.parent_id as string); parent && !seen.has(parent.id); parent = byId.get(parent.parent_id as string)) {
      seen.add(parent.id);
      d++;
    }
    depth.set(row.id, d);
    return d;
  };
  return [...rows].sort((a, b) => depthOf(a) - depthOf(b));
}

/**
 * Zmiany potrzebne, żeby lokalna baza miała dane z kopii. Wiersz, którego nie ma lokalnie — cały;
 * istniejący — tylko pola o innej wartości; taki sam — nic (import jest idempotentny). Wiersze
 * spoza kopii zostają nietknięte (import przywraca i dokłada, niczego nie usuwa).
 * `local(table, id)` — wiersz lokalnej bazy z odczytanymi `jsonb`.
 */
export function backupImportPlan(backup: Backup, local: (table: BackupTable, id: string) => Record<string, unknown> | undefined, userId: string): BackupPlan {
  const source = moveToUser(backup, userId);
  const ops: BackupOp[] = [];
  const stats = {} as BackupPlan['stats'];
  for (const table of BACKUP_TABLES) {
    const counts = { added: 0, changed: 0, same: 0 };
    stats[table] = counts;
    const fields = backupFields(table).filter((field) => field !== 'id' && !(table === 'profiles' && source !== backup && field === 'calendar_sync'));
    const rows = table === 'tasks' ? parentsFirst(source.tables[table]) : source.tables[table];
    for (const row of rows) {
      const current = local(table, row.id);
      // Puste lokalnie pole `not null` (wiersz jeszcze nie wrócił z serwera) = wartość domyślna bazy.
      const defaults = BACKUP_DEFAULTS[table] ?? {};
      const differs = (field: string) => !current || !sameValue(current[field] ?? defaults[field], row[field]);
      const patch = Object.fromEntries(fields.filter(differs).map((field) => [field, row[field] ?? null]));
      if (!current) counts.added++;
      else if (Object.keys(patch).length) counts.changed++;
      else counts.same++;
      if (Object.keys(patch).length) ops.push({ table, id: row.id, patch });
    }
  }
  return { ops, stats, otherAccount: source !== backup };
}

/** Liczba wierszy w kopii (podsumowanie w UI). */
export const backupRowCount = (backup: Backup): number => BACKUP_TABLES.reduce((sum, table) => sum + backup.tables[table].length, 0);

/** Nazwa pliku eksportu: `taskplanner-RRRR-MM-DD.json` (data lokalna). */
export const backupFileName = (date: string): string => `taskplanner-${date}.json`;
