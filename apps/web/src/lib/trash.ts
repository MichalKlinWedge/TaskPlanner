"use client";

/** Zadania w koszu (ostatnie 30 dni) z lokalnej bazy — widok „Kosz” i podgląd zadania z kosza w panelu. */
import { toTrashedTask, trashSince, type TrashedTask } from "@taskplanner/core";
import { purgeTasks, TRASH_SQL, type TabStore } from "@taskplanner/sync";
import { useMemo, useState } from "react";

import type { AppData } from "./app-data";
import { reportError } from "./error-log";
import { useLocalQuery } from "./local-store";
import { supabaseBrowser } from "./supabase-browser";

type Row = Record<string, string | number | null>;

export function useTrash(store: TabStore, data: Pick<AppData, "tasks">): { tasks: TrashedTask[]; alive: ReadonlySet<string>; loaded: boolean } {
  // Granica liczona przy wejściu do widoku (stabilna wartość parametru zapytania).
  const [since] = useState(() => trashSince(Date.now()));
  const { rows, ms } = useLocalQuery<Row>(store, TRASH_SQL, [since], ["tasks", "task_tags", "lists"]);
  const tasks = useMemo(() => rows.map(toTrashedTask), [rows]);
  const alive = useMemo(() => new Set(data.tasks.map((t) => t.id)), [data.tasks]);
  return { tasks, alive, loaded: ms !== null };
}

/** Definitywne usunięcie zadania z kosza (z podzadaniami usuniętymi naraz) — tylko z siecią, bez cofnięcia. */
export const purgeFromTrash = (store: TabStore, id: string): Promise<number> =>
  purgeTasks(supabaseBrowser(), [id], { sync: () => store.sync(), onError: (e) => reportError("sync", e, { op: "purge_tasks" }) });
