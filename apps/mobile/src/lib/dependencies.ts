/** Zależności koniec→początek z lokalnej bazy jako `Dependency` z `core`. */
import type { Dependency } from '@taskplanner/core';
import { useMemo } from 'react';

import { useLocalQuery } from './local-query';

export function useDependencies(): Dependency[] {
  const rows = useLocalQuery(['task_dependencies'], (engine) =>
    engine.db.all<{ id: string; predecessor_id: string; successor_id: string; lag_days: number }>('select id, predecessor_id, successor_id, lag_days from task_dependencies where deleted_at is null'),
  );
  return useMemo(() => (rows ?? []).map((r) => ({ id: r.id, predecessorId: r.predecessor_id, successorId: r.successor_id, lagDays: Number(r.lag_days) || 0 })), [rows]);
}
