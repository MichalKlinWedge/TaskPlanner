/**
 * Zmienione wiersze jednej transakcji lokalnej bazy (zapis, wysyłka, strona pobierania): tabela →
 * id wierszy albo `null`, gdy nie wiadomo, które (usunięcie hurtowe, bardzo duża zmiana). Widoki
 * doczytują tylko zmienione wiersze (`createTaskCache`); `null` = odczyt całej tabeli.
 */

export type TableChanges = ReadonlyMap<string, ReadonlySet<string> | null>;
export type ChangeSet = Map<string, Set<string> | null>;

/** Powyżej tylu id w tabeli lista nic nie daje (widok i tak czyta całość) — `null`. */
export const MAX_CHANGED_IDS = 1000;

/** Dopisanie zmiany: `id` `null` = cała tabela. */
export function addChange(changes: ChangeSet, table: string, id: string | null): void {
  if (!changes.has(table)) changes.set(table, id === null ? null : new Set([id]));
  else {
    const ids = changes.get(table);
    if (ids === null || ids === undefined) return;
    if (id === null || ids.size >= MAX_CHANGED_IDS) changes.set(table, null);
    else ids.add(id);
  }
}

/** Złączenie zmian (kilka powiadomień przed odczytem). */
export function mergeChanges(into: ChangeSet, from: TableChanges): void {
  for (const [table, ids] of from) {
    if (ids === null) addChange(into, table, null);
    else for (const id of ids) addChange(into, table, id);
  }
}

/** Wszystkie podane tabele zmienione w całości (nowy lider kart, starszy lider bez id). */
export const wholeTables = (tables: Iterable<string>): TableChanges => new Map([...tables].map((t) => [t, null]));

/** Postać do `postMessage` (BroadcastChannel klonuje `Map`/`Set`, ale starsze karty czytają tylko `tables`). */
export const changesToJson = (changes: TableChanges): Record<string, string[] | null> =>
  Object.fromEntries([...changes].map(([t, ids]) => [t, ids ? [...ids] : null]));

export const changesFromJson = (tables: readonly string[], ids: Record<string, string[] | null> | undefined): TableChanges =>
  new Map(tables.map((t) => [t, ids?.[t] ? new Set(ids[t]) : null]));
