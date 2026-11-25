"use client";

/** Dowolny kolor obok palety `COLORS`: szersza paleta, pole #RRGGBB i systemowy próbnik — wspólne dla tagów, list, przestrzeni i grup karteczek. */
import { COLOR_GRID, isPaletteColor, parseHexColor } from "@taskplanner/core";
import { useRef, useState } from "react";

import { useClickOutside } from "@/lib/use-click-outside";

import { Button, inputClass } from "./ui";

const RAINBOW = "conic-gradient(#ef4444, #eab308, #22c55e, #06b6d4, #3b82f6, #d946ef, #ef4444)";

/** Kółko „Inny kolor” na końcu palety: wybrany kolor spoza palety albo tęcza. */
export function CustomColorSwatch({ value, open, onClick, className }: { value: string | null | undefined; open: boolean; onClick: () => void; className: string }) {
  const custom = value && !isPaletteColor(value) ? value : null;
  return (
    <button
      type="button"
      aria-label="Inny kolor"
      aria-expanded={open}
      title={custom ? `Inny kolor (${custom.toUpperCase()})` : "Inny kolor"}
      onClick={onClick}
      className={`${className} rounded-full ring-offset-1 ${custom ? "ring-2 ring-[var(--accent)]" : ""}`}
      style={{ background: custom ?? RAINBOW }}
    />
  );
}

/** Klik w szerszej palecie wybiera od razu; hex i próbnik systemowy — „Ustaw” / Enter. */
export function CustomColorPanel({ value, onChange }: { value: string | null | undefined; onChange: (color: string) => void }) {
  const [text, setText] = useState(value?.toUpperCase() ?? "");
  const color = parseHexColor(text);
  const invalid = Boolean(text.trim()) && !color;
  const current = value?.toUpperCase();
  return (
    <div role="group" aria-label="Wybór innego koloru" className="flex w-full min-w-58 flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        {COLOR_GRID.map((row, i) => (
          <div key={i} className="flex gap-0.5">
            {row.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                title={c}
                aria-pressed={c === current}
                onClick={() => onChange(c)}
                className="h-4 flex-1 rounded-sm hover:scale-110 aria-pressed:ring-2 aria-pressed:ring-[var(--accent)]"
                style={{ background: c }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          aria-label="Próbnik kolorów"
          title="Próbnik kolorów"
          value={(color ?? "#4F46E5").toLowerCase()}
          onChange={(e) => setText(e.target.value.toUpperCase())}
          className="h-7 w-8 shrink-0 cursor-pointer rounded border border-[var(--line)] bg-transparent p-0.5"
        />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // Pole bywa wewnątrz formularza nowej listy — Enter nie może go wysłać.
            e.preventDefault();
            if (color) onChange(color);
          }}
          placeholder="#RRGGBB"
          maxLength={9}
          spellCheck={false}
          autoComplete="off"
          aria-label="Kolor w zapisie #RRGGBB"
          aria-invalid={invalid}
          className={`${inputClass} w-24 flex-1 px-2! py-1! font-mono text-xs! ${invalid ? "border-[var(--danger)]!" : ""}`}
        />
        <Button kind="primary" className="px-2! py-1! text-xs!" disabled={!color} onClick={() => color && onChange(color)}>
          Ustaw
        </Button>
      </div>
    </div>
  );
}

/** Przycisk „Inny kolor” z panelem w okienku pod paletą (rodzic palety ma `relative`). */
export function CustomColorButton({ value, onChange, className }: { value: string | null | undefined; onChange: (color: string) => void; className: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useClickOutside(open, () => setOpen(false), root);
  return (
    <span
      ref={root}
      className="inline-flex"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.stopPropagation();
        setOpen(false);
      }}
    >
      <CustomColorSwatch value={value} open={open} onClick={() => setOpen((o) => !o)} className={className} />
      {open ? (
        <div className="absolute top-full left-0 z-30 mt-2 rounded-md border border-[var(--line)] bg-[var(--surface)] p-2 shadow-lg">
          <CustomColorPanel
            value={value}
            onChange={(color) => {
              setOpen(false);
              onChange(color);
            }}
          />
        </div>
      ) : null}
    </span>
  );
}
