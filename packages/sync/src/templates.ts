/**
 * Szablony projektów (v1.x): odczyt wierszy projektu z lokalnej bazy do migawki
 * (`projectTemplateContent` w `@taskplanner/core`). Wspólne dla webu (`TabStore.query`)
 * i telefonu (`engine.db.all`); zapis szablonu i nowy projekt to zwykłe `mutateMany`.
 */
import type { ProjectSource } from '@taskplanner/core';

import type { BackupQuery } from './backup.ts';
import { decodeRow } from './merge.ts';

/** Wiersze projektu `listId`: lista, nieusunięte zadania, ich tagi z nazwami, przypomnienia użytkownika i zależności. */
export async function readProjectSource(query: BackupQuery, listId: string, userId: string): Promise<ProjectSource> {
  const [list] = await query('select * from lists where id = ? and deleted_at is null', [listId]);
  if (!list) throw new Error('Nie ma takiego projektu.');
  const tasks = (await query('select * from tasks where list_id = ? and deleted_at is null', [listId])).map((row) => decodeRow<ProjectSource['tasks'][number]>('tasks', row));
  const inProject = 'select id from tasks where list_id = ? and deleted_at is null';
  // Kolejność tagów jak w widokach (`TAG_ORDER` w `task-cache.ts`); tag innego członka — nazwa z kopii `scope_tags`.
  const tags = await query<{ task_id: string; name: string | null }>(
    `select tt.task_id, coalesce(g.name, (select s.name from scope_tags s where s.tag_id = tt.tag_id limit 1)) as name
       from task_tags tt left join tags g on g.id = tt.tag_id and g.deleted_at is null
      where tt.deleted_at is null and tt.task_id in (${inProject})
      order by tt.task_id, tt.sort_key is null, tt.sort_key, tt.rowid`,
    [listId],
  );
  const reminders = await query<ProjectSource['reminders'][number]>(
    `select task_id, kind, offset_min, at_date, at_time from reminders
      where deleted_at is null and (created_by is null or created_by = ?) and task_id in (${inProject}) order by rowid`,
    [userId, listId],
  );
  const dependencies = await query<ProjectSource['dependencies'][number]>(
    `select predecessor_id, successor_id, lag_days from task_dependencies
      where deleted_at is null and predecessor_id in (${inProject}) and successor_id in (${inProject}) order by rowid`,
    [listId, listId],
  );
  return {
    list: decodeRow<ProjectSource['list']>('lists', list),
    tasks,
    tags: tags.filter((t): t is { task_id: string; name: string } => Boolean(t.name)),
    reminders: reminders.map((r) => ({ ...r, offset_min: r.offset_min === null ? null : Number(r.offset_min) })),
    dependencies: dependencies.map((d) => ({ ...d, lag_days: Number(d.lag_days ?? 0) })),
  };
}
