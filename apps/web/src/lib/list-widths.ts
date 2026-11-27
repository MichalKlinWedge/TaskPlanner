/**
 * Szerokości kolumn widoku listy ustawiane przeciąganiem w nagłówku (`TaskColumnsHeader`).
 * Zależą od ekranu, więc są per urządzenie: `localStorage` `tp-list-widths` = { [listId]: { title?, due?, … } } w px.
 * `title` = cały obszar zadania (zwijanie, odhaczenie, tytuł) od lewej krawędzi wiersza do pierwszej kolumny.
 */
import type { ListColumn } from "@taskplanner/core";
import { useCallback, useState } from "react";

export type WidthColumn = ListColumn | "title";
export type ColumnWidths = Partial<Record<WidthColumn, number>>;

const KEY = "tp-list-widths";
export const MIN_WIDTH: Record<WidthColumn, number> = { title: 160, start: 48, due: 48, duration: 40, description: 32, attachments: 40, tags: 48 };
export const MAX_WIDTH = 1200;

function readAll(): Record<string, ColumnWidths> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, ColumnWidths>) : {};
  } catch {
    return {};
  }
}

export const clampWidth = (column: WidthColumn, px: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH[column], px)));

/** Szerokości kolumn listy i zmiana jednej z nich (`null` = domyślna). */
export function useListWidths(listId: string): [ColumnWidths, (column: WidthColumn, px: number | null) => void] {
  const [all, setAll] = useState(readAll);
  const setWidth = useCallback(
    (column: WidthColumn, px: number | null) => {
      setAll((current) => {
        const widths = { ...current[listId] };
        if (px === null) delete widths[column];
        else widths[column] = clampWidth(column, px);
        const next = { ...current };
        if (Object.keys(widths).length) next[listId] = widths;
        else delete next[listId];
        try {
          localStorage.setItem(KEY, JSON.stringify(next));
        } catch {
          // Bez zapisu (tryb prywatny) — szerokość działa do odświeżenia.
        }
        return next;
      });
    },
    [listId],
  );
  return [all[listId] ?? {}, setWidth];
}
