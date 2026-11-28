/**
 * Ustawienia widoku listy tylko do podglądu (udostępniona z rolą „podgląd” albo z dostępem gościa innym niż
 * „edycja”): sortowanie, grupowanie, filtr, kolumny, „Lista | Tablica”. Zapis do `lists.view_prefs` silnik
 * odrzuca (`ReadOnlyScopeError`), więc gość trzyma swoje ustawienia w tej karcie (`sessionStorage`) — pełny
 * obiekt `ViewPrefs` zamiast tego z bazy. Edytowalne listy zapisują jak dotąd przez `updateListPrefs`.
 */
import type { ViewPrefs } from "@taskplanner/core";
import { useSyncExternalStore } from "react";

const KEY = "tp-readonly-list-prefs";

let cache: Record<string, ViewPrefs> | null = null;
const listeners = new Set<() => void>();

function all(): Record<string, ViewPrefs> {
  if (cache) return cache;
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
    cache = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, ViewPrefs>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** Nowe ustawienia = bieżące (`base`: lokalne albo z bazy) + zmiana; klucz z `undefined` znika (jak `updateListPrefs`). */
export function setLocalListPrefs(listId: string, base: ViewPrefs, patch: (prefs: ViewPrefs) => Partial<ViewPrefs>) {
  const next: Record<string, unknown> = { ...base, ...patch(base) };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  cache = { ...all(), [listId]: next as ViewPrefs };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Pełny magazyn / tryb prywatny — ustawienia zostają w pamięci karty.
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Lokalne ustawienia listy (`null` id = nie dotyczy, np. lista edytowalna). */
export function useLocalListPrefs(listId: string | null | undefined): ViewPrefs | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (listId ? all()[listId] : undefined),
    () => undefined,
  );
}
