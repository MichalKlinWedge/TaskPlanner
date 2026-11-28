/**
 * Filtr doraźny (chipy, niezapisany) pamiętany osobno dla każdego widoku (R-06, jak na webie): klucz =
 * widok (`inbox`, `today`, `upcoming`, `overdue`, `undated`, `board`, `tag:<id>`), pamięć = proces aplikacji (do jej
 * zamknięcia), osobno dla każdego konta. Tablica widoku (`/board?view=inbox`) dzieli filtr z jego zakładką.
 * Reguły mapy w core `view-memory.ts`; listy trzymają swój filtr w `view_prefs.filter`.
 */
import { withAdhocFilter, type AdhocFilters, type FilterQuery } from '@taskplanner/core';
import { useCallback, useSyncExternalStore } from 'react';

const EMPTY: FilterQuery = {};
let memory: AdhocFilters = {};
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Filtr widoku `key` i jego zmiana (wspólna dla wszystkich ekranów tego widoku). */
export function useAdhocFilter(userId: string, key: string): [FilterQuery, (query: FilterQuery) => void] {
  const full = `${userId}:${key}`;
  const query = useSyncExternalStore(subscribe, () => memory[full] ?? EMPTY);
  const set = useCallback(
    (next: FilterQuery) => {
      memory = withAdhocFilter(memory, full, next);
      for (const listener of listeners) listener();
    },
    [full],
  );
  return [query, set];
}
