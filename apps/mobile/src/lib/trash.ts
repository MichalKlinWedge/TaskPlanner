/** Zadania w koszu (ostatnie 30 dni) z lokalnej bazy — ekran „Kosz” i podgląd zadania z kosza. */
import { toTrashedTask, trashSince, type TrashedTask } from '@taskplanner/core';
import { TRASH_SQL, type SqlRow } from '@taskplanner/sync';
import { useState } from 'react';

import { useLocalQuery } from './local-query';

/** `null` = jeszcze nie wczytane albo `enabled` = `false` (zwykłe zadanie nie czyta kosza). */
export function useTrash(enabled = true): TrashedTask[] | null {
  const [since] = useState(() => trashSince(Date.now()));
  return (
    useLocalQuery(
      ['tasks', 'task_tags', 'lists'],
      async (engine) => (enabled ? (await engine.db.all<SqlRow>(TRASH_SQL, [since])).map(toTrashedTask) : null),
      [since, enabled],
    ) ?? null
  );
}
