"use client";

/**
 * Wybór sortowania (lista, widoki zbiorcze, tagi / filtry, tablica) i — poza kolejnością ręczną /
 * domyślną — przycisk odwrócenia kierunku. Etykiety kierunku z core `sortDirLabel`.
 */
import { sortDirLabel, type SortBy, type SortDir } from "@taskplanner/core";

import { Select } from "./ui";

/** Sortowanie przekazywane do widoku (np. tablicy): wybór, etykiety opcji i zmiana (`undefined` usuwa pole). */
export interface SortChoice {
  by: SortBy;
  dir: SortDir;
  labels: Partial<Record<SortBy, string>>;
  onChange: (patch: { sortBy?: SortBy; sortDir?: SortDir }) => void;
}

export function SortControls({ by, dir, labels, title, onBy, onDir }: { by: SortBy; dir: SortDir; labels: Partial<Record<SortBy, string>>; title?: string; onBy: (by: SortBy) => void; onDir: () => void }) {
  return (
    <>
      <Select aria-label="Sortowanie" title={title} value={by} onChange={(e) => onBy(e.target.value as SortBy)} className="py-1 text-xs">
        {(Object.keys(labels) as SortBy[]).map((k) => (
          <option key={k} value={k}>
            {labels[k]}
          </option>
        ))}
      </Select>
      {by === "manual" ? null : (
        <button
          type="button"
          onClick={onDir}
          className="rounded-md border border-[var(--line)] px-2 py-1 text-xs hover:bg-[var(--hover)]"
          title="Odwróć kierunek sortowania"
          aria-label={`Kierunek sortowania: ${sortDirLabel(by, dir)}`}
          data-testid="sort-dir"
        >
          {dir === "desc" ? "▼" : "▲"} {sortDirLabel(by, dir)}
        </button>
      )}
    </>
  );
}
