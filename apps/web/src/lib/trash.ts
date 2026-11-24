"use client";

/** Zadania w koszu (ostatnie 30 dni) z lokalnej bazy — widok „Kosz” i podgląd zadania z kosza w panelu. */
import { toTrashedTask, trashSince, type TrashedTask } from "@taskplanner/core";
import { TRASH_SQL, type TabStore } from "@taskplanner/sync";
import { useMemo, useState } from "react";

import type { AppData } from "./app-data";
import { useLocalQuery } from "./local-store";

type Row = Record<string, string | number | null>;

export function useTrash(store: TabStore, data: Pick<AppData, "tasks">): { tasks: TrashedTask[]; alive: ReadonlySet<string>; loaded: boolean } {
  // Granica liczona przy wejściu do widoku (stabilna wartość parametru zapytania).
  const [since] = useState(() => trashSince(Date.now()));
  const { rows, ms } = useLocalQuery<Row>(store, TRASH_SQL, [since], ["tasks", "task_tags", "lists"]);
  const tasks = useMemo(() => rows.map(toTrashedTask), [rows]);
  const alive = useMemo(() => new Set(data.tasks.map((t) => t.id)), [data.tasks]);
  return { tasks, alive, loaded: ms !== null };
}
