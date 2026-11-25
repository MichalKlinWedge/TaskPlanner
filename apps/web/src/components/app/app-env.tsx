"use client";

/**
 * Wspólne dane powłoki dla komponentów głębiej w drzewie (szybkie dodawanie, panel zadania,
 * wiersze zadań): lokalna baza, dane widoków, użytkownik, dziś i otwieranie panelu zadania.
 */
import type { LocalDate, ProfileSettings, TrashedTask } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { createContext, useContext } from "react";

import type { AppData } from "@/lib/app-data";

export type TaskPanelMode = "edit" | "preview";

export interface AppEnv {
  store: TabStore;
  data: AppData;
  /** Podgląd zadania z kosza: zadania w koszu (są wtedy też w `data.tasks`) — tylko do odczytu. */
  trashed?: ReadonlyMap<string, TrashedTask>;
  userId: string;
  timeZone?: string;
  /** Ustawienia profilu (sparsowane, z domyślnymi). */
  settings: ProfileSettings;
  today: LocalDate;
  /** Bieżąca przestrzeń; `null` = „Wszystkie”. */
  workspaceId: string | null;
  /** Otwarcie panelu zadania (`null` zamyka): formularz albo podgląd samych wypełnionych danych. */
  openTask: (id: string | null, mode?: TaskPanelMode) => void;
  /** Tryb otwartego panelu zadania. */
  openTaskMode: TaskPanelMode;
  /** Zadanie otwarte w panelu. */
  openTaskId: string | null;
  /** Zaznaczone zadania (akcje palety i skrótów działają na nich). */
  selectedIds: ReadonlySet<string>;
  /** `only` — tylko to; `toggle` — Ctrl+klik; `range` — Shift+klik (od ostatnio wybranego). */
  select: (id: string, mode?: "only" | "toggle" | "range") => void;
}

/** Zadania widoczne w treści, w kolejności na ekranie (bez wirtualnych wystąpień serii). */
export const visibleTaskIds = (): string[] => [
  ...new Set([...document.querySelectorAll<HTMLElement>("main [data-task-id]:not([data-virtual])")].map((el) => el.dataset.taskId!)),
];

const EnvContext = createContext<AppEnv | null>(null);
export const AppEnvProvider = EnvContext.Provider;

export function useAppEnv(): AppEnv {
  const env = useContext(EnvContext);
  if (!env) throw new Error("useAppEnv poza <AppEnvProvider>.");
  return env;
}

/** Ostatni klucz kolejności wśród rodzeństwa: zadania główne listy albo podzadania rodzica. */
export const lastSortKey = (data: AppData, listOrParentId: string): string | undefined =>
  data.tasks.reduce<string | undefined>(
    (max, t) => ((t.parentId === listOrParentId || (t.listId === listOrParentId && t.parentId === null)) && (!max || t.sortKey > max) ? t.sortKey : max),
    undefined,
  );
