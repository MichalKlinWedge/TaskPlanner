/**
 * Wyszukiwarka i paleta poleceń (SPECYFIKACJA M17): jedno dopasowanie dla zadań, list,
 * przestrzeni, tagów, filtrów, widoków i akcji. Bez polskich znaków i wielkości liter („zolw”
 * znajduje „Żółw”, „lodz” — „Łódź”), każde słowo zapytania musi pasować do początku jakiegoś słowa;
 * ranking: tytuł > tagi > lista > opis, dokładne słowo > początek > środek, otwarte przed
 * zamkniętymi, ostatnio używane wyżej. Działa na wierszach z lokalnej bazy (offline) — przy kilku
 * tysiącach zadań przegląd w pamięci wystarcza; FTS5 może później zawęzić kandydatów.
 */
import { normalizeWord } from './quick-add.ts';
import type { ViewTask } from './views.ts';

export type SearchKind = 'task' | 'list' | 'workspace' | 'tag' | 'filter' | 'view' | 'action';

export interface SearchItem {
  id: string;
  kind: SearchKind;
  title: string;
  /** Tagi (zadania), nazwa listy, opis, dodatkowe słowa kluczowe (akcje: „dark”, „motyw”). */
  tags?: readonly string[];
  listName?: string;
  description?: string;
  keywords?: readonly string[];
  /** Zamknięte zadanie, zarchiwizowana lista — niżej w wynikach. */
  closed?: boolean;
}

interface Field {
  words: string[];
  weight: number;
}

export interface SearchIndex {
  entries: { item: SearchItem; title: string; fields: Field[] }[];
}

/** Tekst do porównań: małe litery, bez ogonków (także „ł”). */
export const normalizeText = (text: string): string => normalizeWord(text);

const words = (text: string | undefined) => (text ? normalizeText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean) : []);
const unique = (list: string[]) => [...new Set(list)];

const WEIGHT = { title: 10, tags: 6, keywords: 5, list: 4, description: 2 } as const;

/** Indeks budowany raz po zmianie danych (normalizacja nie powtarza się przy każdym znaku). */
export function buildSearchIndex(items: readonly SearchItem[]): SearchIndex {
  return {
    entries: items.map((item) => ({
      item,
      title: normalizeText(item.title),
      fields: [
        { words: unique(words(item.title)), weight: WEIGHT.title },
        { words: unique((item.tags ?? []).flatMap(words)), weight: WEIGHT.tags },
        { words: unique((item.keywords ?? []).flatMap(words)), weight: WEIGHT.keywords },
        { words: unique(words(item.listName)), weight: WEIGHT.list },
        { words: unique(words(item.description)), weight: WEIGHT.description },
      ],
    })),
  };
}

export interface SearchResult {
  item: SearchItem;
  score: number;
  /** Zakresy `[od, do)` w tytule do podświetlenia. */
  highlights: [number, number][];
}

/** Dopasowanie słowa zapytania do słowa tekstu: 1 dokładne, 0,8 początek, 0,3 środek (od 3 znaków). */
function wordMatch(term: string, word: string): number {
  if (word === term) return 1;
  if (word.startsWith(term)) return 0.8;
  return term.length >= 3 && word.includes(term) ? 0.3 : 0;
}

function termScore(term: string, fields: readonly Field[]): number {
  let best = 0;
  for (const field of fields) {
    for (const word of field.words) best = Math.max(best, wordMatch(term, word) * field.weight);
  }
  return best;
}

function highlights(title: string, normalized: string, terms: readonly string[]): [number, number][] {
  // Normalizacja zachowuje długość dla polskich liter; inaczej bez podświetlenia.
  if (normalized.length !== title.length) return [];
  const ranges: [number, number][] = [];
  for (const term of terms) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gu');
    for (const m of normalized.matchAll(re)) {
      const start = m.index + m[1]!.length;
      ranges.push([start, start + term.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

export interface SearchOptions {
  limit?: number;
  /** Ostatnie użycie (id → ISO) — wyżej w wynikach, a przy pustym zapytaniu jedyna lista. */
  recent?: ReadonlyMap<string, string>;
  /** Tylko te rodzaje (np. paleta akcji po „>”). */
  kinds?: readonly SearchKind[];
}

/**
 * Wyniki od najlepszego. Puste zapytanie = ostatnio używane. Ostatnio używane dostają premię
 * malejącą z kolejnością (najświeższe +3), więc nie przeskakują wyraźnie lepszego dopasowania.
 */
export function search(index: SearchIndex, query: string, { limit = 20, recent, kinds }: SearchOptions = {}): SearchResult[] {
  const terms = [...new Set(words(query))];
  const allowed = (item: SearchItem) => !kinds || kinds.includes(item.kind);
  const recency = new Map([...(recent ?? [])].sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([id], i) => [id, i]));

  if (!terms.length) {
    return index.entries
      .filter((e) => allowed(e.item) && recency.has(e.item.id))
      .sort((a, b) => recency.get(a.item.id)! - recency.get(b.item.id)!)
      .slice(0, limit)
      .map((e) => ({ item: e.item, score: 0, highlights: [] }));
  }

  const phrase = terms.join(' ');
  const results: { entry: SearchIndex['entries'][number]; score: number }[] = [];
  for (const entry of index.entries) {
    if (!allowed(entry.item)) continue;
    let score = 0;
    for (const term of terms) {
      const s = termScore(term, entry.fields);
      if (s === 0) {
        score = 0;
        break;
      }
      score += s;
    }
    if (score === 0) continue;
    if (entry.title.startsWith(phrase)) score += 4;
    if (entry.item.closed) score -= 5;
    const rank = recency.get(entry.item.id);
    if (rank !== undefined) score += 3 / (1 + rank);
    results.push({ entry, score });
  }
  // Remis: krótszy tytuł (bliższy zapytaniu), potem alfabetycznie. Podświetlenia tylko dla pokazanych.
  return results
    .sort((a, b) => b.score - a.score || a.entry.title.length - b.entry.title.length || a.entry.title.localeCompare(b.entry.title, 'pl'))
    .slice(0, limit)
    .map(({ entry, score }) => ({ item: entry.item, score, highlights: highlights(entry.item.title, entry.title, terms) }));
}

/** Zadanie jako pozycja wyszukiwarki (nazwy tagów i listy z lokalnej bazy). */
export const taskSearchItem = (task: ViewTask, extra: { description?: string | null; listName?: string; tagNames?: readonly string[] } = {}): SearchItem => ({
  id: task.id,
  kind: 'task',
  title: task.title,
  description: extra.description ?? undefined,
  listName: extra.listName,
  tags: extra.tagNames,
  closed: task.status === 'done' || task.status === 'cancelled',
});
