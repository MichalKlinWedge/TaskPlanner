"use client";

/** Zależności koniec→początek z lokalnej bazy (oś czasu, panel zadania) jako `Dependency` z `core`. */
import type { Dependency } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useMemo } from "react";

import { useLocalQuery } from "./local-store";

interface Row extends Record<string, string | number | null> {
  id: string;
  predecessor_id: string;
  successor_id: string;
  lag_days: number;
}

export function useDependencies(store: TabStore | null): Dependency[] {
  const { rows } = useLocalQuery<Row>(store, "select id, predecessor_id, successor_id, lag_days from task_dependencies where deleted_at is null", [], ["task_dependencies"]);
  return useMemo(() => rows.map((r) => ({ id: r.id, predecessorId: r.predecessor_id, successorId: r.successor_id, lagDays: Number(r.lag_days) || 0 })), [rows]);
}
