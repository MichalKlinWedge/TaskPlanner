/**
 * Zapis pola JSON (ustawienia profilu, `view_prefs` listy) liczony z najnowszego wiersza w lokalnej
 * bazie, po kolei w jednej kolejce na bazę. Wartość z ostatniego renderu bywa już nieaktualna: kilka
 * szybkich kliknięć (np. kolejne kolumny w „Kolumny”) przed odświeżeniem widoku nadpisywało się
 * nawzajem i zostawał tylko ostatni wybór. Nieznane klucze (zapisane przez nowszą wersję) zostają.
 */
import { ViewPrefs, type ProfileSettings } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";

import { parseSettings } from "./app-data";

type JsonObject = Record<string, unknown>;

const queues = new WeakMap<TabStore, Promise<unknown>>();

const asObject = (value: unknown): JsonObject => {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
};

/** `undefined` = usunięcie klucza z zapisu. */
const withoutUndefined = (value: JsonObject): JsonObject => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));

function updateJson(store: TabStore, target: { table: "profiles"; column: "settings" } | { table: "lists"; column: "view_prefs" }, id: string, next: (current: JsonObject) => JsonObject): Promise<void> {
  const work = (queues.get(store) ?? Promise.resolve()).then(async () => {
    const [row] = await store.query<{ value: string | null }>(`select ${target.column} as value from ${target.table} where id = ?`, [id]);
    if (!row) throw new Error("Brak wiersza w lokalnej bazie — spróbuj po synchronizacji.");
    await store.mutate(target.table, id, { [target.column]: withoutUndefined(next(asObject(row.value))) });
  });
  queues.set(store, work.catch(() => undefined));
  return work;
}

/** Zmiana ustawień profilu; `patch` dostaje aktualne ustawienia (z domyślnymi). */
export function updateSettings(store: TabStore, userId: string, patch: (settings: ProfileSettings) => Partial<ProfileSettings>): Promise<void> {
  return updateJson(store, { table: "profiles", column: "settings" }, userId, (raw) => ({ ...raw, ...patch(parseSettings(raw)) }));
}

/** Zmiana `view_prefs` listy; `patch` dostaje aktualne ustawienia, klucz z `undefined` znika. */
export function updateListPrefs(store: TabStore, listId: string, patch: (prefs: ViewPrefs) => Partial<ViewPrefs>): Promise<void> {
  return updateJson(store, { table: "lists", column: "view_prefs" }, listId, (raw) => {
    const prefs = ViewPrefs.safeParse(raw);
    return { ...raw, ...patch(prefs.success ? prefs.data : {}) };
  });
}
