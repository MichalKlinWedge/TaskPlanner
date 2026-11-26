/**
 * Pamięć widoku po obu stronach (backlog web ↔ APK, R-06 i R-12).
 *
 * R-06: filtr doraźny (chipy, niezapisany) jest pamiętany osobno dla każdego widoku (klucz = trasa:
 * Inbox, Dziś, tag X…) do zamknięcia karty / aplikacji; listy trzymają swój w `view_prefs.filter`.
 * R-12: zaznaczenie zostaje po akcji grupowej; zadania, które zniknęły z widoku (usunięte,
 * przeniesione, ukończone tam, gdzie ukończonych nie widać), z niego wypadają.
 */
import { FilterQuery, isEmptyFilter } from './views.ts';

/** Filtry doraźne po kluczu widoku. */
export type AdhocFilters = Readonly<Record<string, FilterQuery>>;

/** Najwięcej pamiętanych widoków — najdawniej zmienione wypadają pierwsze. */
export const ADHOC_FILTERS_MAX = 50;

/** Odczyt z pamięci przeglądarki (JSON); złe wpisy (np. ze starszej wersji) są pomijane. */
export function parseAdhocFilters(raw: string | null | undefined): AdhocFilters {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, FilterQuery> = {};
  for (const [key, query] of Object.entries(value)) {
    const parsed = FilterQuery.safeParse(query);
    if (parsed.success && !isEmptyFilter(parsed.data)) result[key] = parsed.data;
  }
  return result;
}

/** Nowa mapa z filtrem widoku `key` (pusty filtr = usunięcie wpisu); ostatnio zmieniony idzie na koniec. */
export function withAdhocFilter(filters: AdhocFilters, key: string, query: FilterQuery): AdhocFilters {
  const entries = Object.entries(filters).filter(([k]) => k !== key);
  if (!isEmptyFilter(query)) entries.push([key, query]);
  return Object.fromEntries(entries.slice(-ADHOC_FILTERS_MAX));
}

/**
 * Zaznaczenie po zmianie danych: wypadają zadania, które były widoczne (`before`) i już ich nie
 * widać (`after`). Zaznaczonych, których widok nie śledzi (np. karta bez wiersza zadania), nie rusza.
 * Bez zmian zwraca tę samą tablicę (stan Reacta się nie zmienia).
 */
export function keepShownSelection<T extends string>(selected: readonly T[], before: ReadonlySet<string>, after: ReadonlySet<string>): readonly T[] {
  const kept = selected.filter((id) => after.has(id) || !before.has(id));
  return kept.length === selected.length ? selected : kept;
}
