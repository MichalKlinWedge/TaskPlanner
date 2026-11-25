"use client";

/**
 * „? Pomoc” w pasku Karteczek: okienko z opisem sterowania (mysz, klawisze). Zastępuje podpowiedź, która
 * nie mieściła się w pasku. Zamyka je klik poza okienkiem, Esc albo ponowny klik w przycisk.
 */
import { useRef, useState } from "react";

import { useClickOutside } from "@/lib/use-click-outside";
import { Button } from "./ui";

const HELP: { title: string; rows: [string, string][] }[] = [
  {
    title: "Karteczki",
    rows: [
      ["Dwuklik w puste miejsce, N", "nowa karteczka"],
      ["Przeciąganie karty, strzałki ← ↑ → ↓", "przesunięcie zaznaczonych"],
      ["Shift + przeciąganie", "zaznaczanie ramką"],
      ["Ctrl + A", "zaznaczenie wszystkich"],
    ],
  },
  {
    title: "Połączenia",
    rows: [
      ["● na karcie → inna karta", "strzałka „blokuje” albo „wynika z”"],
      ["Klik w strzałkę, potem Delete", "usunięcie połączenia"],
    ],
  },
  {
    title: "Widok",
    rows: [
      ["Przeciąganie tła, kółko, Spacja + przeciąganie", "przesuwanie tablicy"],
      ["Ctrl + kółko, dwa palce, + i −", "powiększenie"],
      ["0", "powiększenie 100 %"],
    ],
  },
];

/** Okienko wychodzące poza prawą krawędź okna (przycisk na końcu zawiniętego paska) przesuwa się w lewo. */
const keepOnScreen = (el: HTMLElement | null) => {
  if (!el) return;
  const over = el.getBoundingClientRect().right - (document.documentElement.clientWidth - 16);
  if (over > 0) el.style.left = `${-over}px`;
};

export function CanvasHelpButton() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useClickOutside(open, () => setOpen(false), root);

  return (
    <span
      ref={root}
      className="relative"
      onKeyDown={(e) => {
        if (!open || e.key !== "Escape") return;
        // Esc zamyka okienko, nie pełny ekran ani zaznaczenie.
        e.stopPropagation();
        setOpen(false);
      }}
    >
      <Button className="py-1 text-xs" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="canvas-help" title="Sterowanie: mysz i klawisze" data-testid="canvas-help-button">
        ? Pomoc
      </Button>
      {open ? (
        <div
          ref={keepOnScreen}
          id="canvas-help"
          role="region"
          aria-label="Sterowanie w Karteczkach"
          className="absolute left-0 top-full z-40 mt-1 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-xs shadow-lg"
          data-testid="canvas-help"
        >
          {HELP.map((section) => (
            <section key={section.title}>
              <h3 className="mb-1 font-semibold">{section.title}</h3>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                {section.rows.map(([how, what]) => (
                  <div key={how} className="contents">
                    <dt>{how}</dt>
                    <dd className="text-[var(--muted)]">{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      ) : null}
    </span>
  );
}
