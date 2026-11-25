"use client";

/** Wygląd tagu w kolorze (`tags.color`) i wybór koloru — wspólne dla listy, tablicy, panelu zadania i widoku tagu. */
import { COLORS, readableColor } from "@taskplanner/core";
import type { CSSProperties } from "react";

import { CustomColorButton } from "./color-picker";

/** Klasy bąbelka tagu; kolor (jeśli jest) nadaje `tagChipStyle`. */
export const TAG_CHIP = "rounded-full bg-black/5 dark:bg-white/10";

/** Tło i tekst w kolorze tagu; bez koloru — szary bąbelek z `TAG_CHIP`. */
export function tagChipStyle(color: string | null | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  // Dowolny kolor może być za jasny albo za ciemny na tle motywu (`--surface`, `--foreground` z `globals.css`).
  const light = readableColor(color, "#FFFFFF", "#18181B");
  const dark = readableColor(color, "#18181B", "#F4F4F5");
  return { background: `${color}26`, color: light === dark ? light : `light-dark(${light}, ${dark})` };
}

/** Paleta `COLORS` + „bez koloru” i „Inny kolor” (okienko pod paletą). */
export function TagColorPicker({ value, onChange, label = "Kolor tagu" }: { value: string | null | undefined; onChange: (color: string | null) => void; label?: string }) {
  const current = value?.toUpperCase() ?? null;
  return (
    <div className="relative flex flex-wrap items-center gap-1" role="radiogroup" aria-label={label}>
      <button
        type="button"
        role="radio"
        aria-checked={current === null}
        aria-label="Bez koloru"
        title="Bez koloru"
        onClick={() => onChange(null)}
        className="flex h-4 w-4 items-center justify-center rounded-full border border-[var(--line)] text-[9px] leading-none text-[var(--muted)] ring-offset-1 aria-checked:ring-2 aria-checked:ring-[var(--accent)]"
      >
        ∅
      </button>
      {COLORS.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={c.value === current}
          aria-label={c.label}
          title={c.label}
          onClick={() => onChange(c.value)}
          className="h-4 w-4 rounded-full ring-offset-1 aria-checked:ring-2 aria-checked:ring-[var(--accent)]"
          style={{ background: c.value }}
        />
      ))}
      <CustomColorButton value={value} onChange={onChange} className="h-4 w-4 rounded-full" />
    </div>
  );
}
