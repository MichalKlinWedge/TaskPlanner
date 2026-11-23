/**
 * Zadania dla widoków z przyrostowym odświeżaniem: pierwszy odczyt bierze wszystkie zadania, a po
 * zmianie (`watch` z id wierszy) tylko zmienione zadania i ich tagi. Niezmienione wpisy zostają tymi
 * samymi obiektami — aplikacja trzyma przy nich gotowe `ViewTask` (`WeakMap`) i nie liczy ich od nowa.
 * Przy 10 000 zadań pełny odczyt to ~0,4 s na telefonie (`docs/WYDAJNOSC.md`), zmienione — kilka ms.
 */
import { addChange, mergeChanges, type ChangeSet, type TableChanges } from './changes.ts';
import type { SqlRow, SqlValue } from './local-db.ts';

/**
 * Kolumny wiersza dla `toViewTask` (alias `t`). Z `field_clock` tylko `status`: widoki nie czytają
 * innych zegarów, a cały JSON przy 10 000 zadań to ~5 MB na odczyt.
 */
export const TASK_COLUMNS = `t.id, t.scope_id, t.list_id, t.parent_id, t.kind, t.title, t.status, t.priority, t.start_date, t.due_date, t.due_time,
  t.duration_min, t.recurrence, t.habit, t.completed_at, t.created_at, t.sort_key, t.board_sort_key, t.postpone_count, t.assignee_id, t.board_column_id, t.canvas_pos,
  json_object('status', json_extract(t.field_clock, '$.status')) as field_clock`;

/**
 * Kolejność tagów zadania: najpierw z `sort_key` (ułożone w panelu zadania), potem reszta w kolejności
 * dodania (`rowid`).
 */
const TAG_ORDER = 'sort_key is null, sort_key, rowid';

/** Nieusunięte zadanie z id tagów (`TAG_ORDER`). Nowy obiekt tylko po zmianie zadania albo jego tagów. */
export interface TaskEntry {
  readonly row: SqlRow;
  readonly tagIds: readonly string[];
}

type Query = (sql: string, params?: readonly SqlValue[]) => Promise<SqlRow[]>;

export interface TaskCache {
  /** Zmiany z `watch` (inne tabele pomijane); bez argumentu — wszystko od nowa. */
  note(changes?: TableChanges): void;
  /** Aktualne zadania; ta sama tablica, gdy od poprzedniego odczytu nic się nie zmieniło. Odczyty idą po kolei. */
  read(): Promise<readonly TaskEntry[]>;
}

const TABLES = ['tasks', 'task_tags'] as const;
/** Więcej zmienionych zadań — jeden pełny odczyt jest tańszy niż długie `in (…)`. */
const MAX_IDS = 400;
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export interface TaskCacheOptions {
  /**
   * Tagi w pełnym odczycie: `'separate'` — osobne zapytanie pogrupowane w JS (telefon: podzapytanie
   * na każde zadanie było tam najdroższą częścią odczytu), `'inline'` — `group_concat` w tym samym
   * zapytaniu (web: jedna odpowiedź z workera zamiast dwóch).
   */
  fullTags?: 'separate' | 'inline';
}

export function createTaskCache(query: Query, { fullTags = 'separate' }: TaskCacheOptions = {}): TaskCache {
  let entries: Map<string, TaskEntry> | null = null;
  let list: readonly TaskEntry[] = [];
  let pending: ChangeSet | 'all' = 'all';
  let chain: Promise<unknown> = Promise.resolve();

  const groupTags = (rows: SqlRow[]) => {
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const id = String(r.task_id);
      const ids = out.get(id);
      if (ids) ids.push(String(r.tag_id));
      else out.set(id, [String(r.tag_id)]);
    }
    return out;
  };

  const full = async () => {
    if (fullTags === 'inline') {
      const rows = await query(
        `select ${TASK_COLUMNS}, (select group_concat(tag_id) from (select tt.tag_id from task_tags tt where tt.task_id = t.id and tt.deleted_at is null order by ${TAG_ORDER})) as tag_ids
           from tasks t where t.deleted_at is null`,
      );
      entries = new Map(
        rows.map((row) => {
          const { tag_ids: tagIds, ...rest } = row;
          return [String(row.id), { row: rest, tagIds: typeof tagIds === 'string' && tagIds ? tagIds.split(',') : [] }];
        }),
      );
      list = [...entries.values()];
      return;
    }
    const [rows, tags] = await Promise.all([
      query(`select ${TASK_COLUMNS} from tasks t where t.deleted_at is null`),
      // Osobno i pogrupowane w JS: podzapytanie na każde zadanie było najdroższą częścią odczytu na telefonie.
      query(`select task_id, tag_id from task_tags where deleted_at is null order by ${TAG_ORDER}`),
    ]);
    const tagsOf = groupTags(tags);
    entries = new Map(rows.map((row) => [String(row.id), { row, tagIds: tagsOf.get(String(row.id)) ?? [] }]));
    list = [...entries.values()];
  };

  const step = async () => {
    const work = pending;
    pending = new Map();
    try {
      if (work === 'all' || !entries) return await full();
      const taskIds = work.get('tasks');
      const tagRowIds = work.get('task_tags');
      if (taskIds === null || tagRowIds === null || (taskIds?.size ?? 0) + (tagRowIds?.size ?? 0) > MAX_IDS) return await full();
      const ids = new Set(taskIds ?? []);
      if (tagRowIds?.size) {
        // Usunięte powiązanie zostaje w bazie z `deleted_at` — zadanie znajdzie się i tak.
        for (const r of await query(`select distinct task_id from task_tags where id in (${marks(tagRowIds.size)})`, [...tagRowIds])) ids.add(String(r.task_id));
      }
      if (ids.size > MAX_IDS) return await full();
      if (!ids.size) return;
      const params = [...ids];
      const [rows, tags] = await Promise.all([
        query(`select ${TASK_COLUMNS} from tasks t where t.deleted_at is null and t.id in (${marks(params.length)})`, params),
        query(`select task_id, tag_id from task_tags where deleted_at is null and task_id in (${marks(params.length)}) order by ${TAG_ORDER}`, params),
      ]);
      const tagsOf = groupTags(tags);
      const found = new Map(rows.map((row) => [String(row.id), row]));
      const next = new Map(entries);
      for (const id of ids) {
        const row = found.get(id);
        // Zmiana w miejscu zostawia zadanie na jego pozycji; nowe idzie na koniec (jak `rowid` w pełnym odczycie).
        if (row) next.set(id, { row, tagIds: tagsOf.get(id) ?? [] });
        else next.delete(id);
      }
      entries = next;
      list = [...next.values()];
    } catch (error) {
      // Nieudany odczyt — następny bierze wszystko od nowa (zmiany z tego kroku już zdjęte z kolejki).
      pending = 'all';
      throw error;
    }
  };

  return {
    note(changes) {
      if (pending === 'all') return;
      if (!changes) {
        pending = 'all';
        return;
      }
      for (const table of TABLES) {
        if (!changes.has(table)) continue;
        const ids = changes.get(table);
        if (ids === null || ids === undefined) addChange(pending, table, null);
        else mergeChanges(pending, new Map([[table, ids]]));
      }
    },
    read() {
      const result = chain.then(step).then(() => list);
      chain = result.catch(() => undefined);
      return result;
    },
  };
}
