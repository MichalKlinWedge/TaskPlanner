/**
 * Filtr doraźny (chipy, niezapisany) pamiętany osobno dla każdego widoku (R-06): klucz = trasa
 * (`routeHash`), pamięć = `sessionStorage` tej karty (do jej zamknięcia), osobno dla każdego konta.
 * Reguły mapy w core `view-memory.ts`; listy trzymają swój filtr w `view_prefs.filter`.
 */
import { parseAdhocFilters, withAdhocFilter, type AdhocFilters, type FilterQuery } from "@taskplanner/core";
import { useCallback, useState } from "react";

const STORAGE = "tp-adhoc-filters";
const EMPTY: FilterQuery = {};

function read(userId: string): AdhocFilters {
  try {
    return parseAdhocFilters(sessionStorage.getItem(`${STORAGE}:${userId}`));
  } catch {
    return {};
  }
}

function write(userId: string, key: string, query: FilterQuery) {
  try {
    sessionStorage.setItem(`${STORAGE}:${userId}`, JSON.stringify(withAdhocFilter(read(userId), key, query)));
  } catch {
    // Bez pamięci karty — filtr trwa do zmiany widoku.
  }
}

/** Filtr widoku `key` i jego zmiana; po zmianie klucza (inny widok) wraca filtr zapamiętany dla tamtego widoku. */
export function useAdhocFilter(userId: string, key: string): [FilterQuery, (query: FilterQuery) => void] {
  const [state, setState] = useState(() => ({ key, query: read(userId)[key] ?? EMPTY }));
  let query = state.query;
  if (state.key !== key) {
    query = read(userId)[key] ?? EMPTY;
    setState({ key, query });
  }
  const set = useCallback(
    (next: FilterQuery) => {
      setState({ key, query: next });
      write(userId, key, next);
    },
    [userId, key],
  );
  return [query, set];
}
