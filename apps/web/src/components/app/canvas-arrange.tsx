"use client";

/**
 * Menu „Ułóż” w pasku Karteczek: „Według …” (kolumny kategorii z ramkami grup), „Według strzałek”,
 * „Według hierarchii” i „Zagęść”. Logika w core `canvas-arrange.ts` (`canvasArrangePlan`); tu tylko menu, podgląd (plan
 * przekazany do tablicy przy najechaniu / fokusie pozycji) i zastosowanie jedną paczką z „Cofnij”.
 * Opcje pamiętane na urządzeniu (`tp-canvas-arrange`).
 */
import {
  CANVAS_ARRANGE_BY,
  canvasArrangePlan,
  canvasArrangeSummary,
  type CanvasArrange,
  type CanvasArrangeBy,
  type CanvasArrangeContext,
  type CanvasArrangePlan,
  type CanvasArrangeTask,
  type CanvasLayout,
} from "@taskplanner/core";
import { useEffect, useRef, useState } from "react";

import { Button } from "./ui";

interface ArrangePrefs {
  scope: "all" | "selection";
  frames: boolean;
  tray: boolean;
}

const PREFS_KEY = "tp-canvas-arrange";
const DEFAULT_PREFS: ArrangePrefs = { scope: "all", frames: true, tray: true };

function loadPrefs(): ArrangePrefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<ArrangePrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: ArrangePrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Bez zapisu — następnym razem domyślne opcje.
  }
}

interface Item {
  key: string;
  label: string;
  mode: CanvasArrange;
  hint: string;
}

const MARK = "tp-canvas-arrange";

/** Plan z pomiarem czasu obliczenia (`performance.measure` „tp-canvas-arrange” — czyta go `npm run perf:canvas`). */
function measuredPlan<T extends CanvasArrangeTask>(layout: CanvasLayout<T>, mode: CanvasArrange, ctx: CanvasArrangeContext): CanvasArrangePlan {
  const t0 = performance.now();
  const plan = canvasArrangePlan(layout, mode, ctx);
  try {
    performance.measure(MARK, { start: t0, end: performance.now(), detail: mode });
  } catch {
    // Starsza przeglądarka bez `measure` z opcjami — bez pomiaru.
  }
  return plan;
}

export function CanvasArrangeButton<T extends CanvasArrangeTask>({
  layout,
  context,
  selected,
  editable,
  hierarchy,
  onPreview,
  onApply,
}: {
  layout: CanvasLayout<T>;
  /** Kontekst bez zakresu i paska (te ustawia menu). */
  context: Omit<CanvasArrangeContext, "selection" | "withTray">;
  /** Zaznaczone zadania (karty z tablicy i z paska). */
  selected: ReadonlySet<string>;
  editable: boolean;
  /**
   * „Według hierarchii” układa zawsze z podzadaniami: w trybie „Tylko główne” tablica podaje tu układ wszystkich
   * kart i zaznaczenie poszerzone o podzadania (`null` = podzadania już są na tablicy).
   */
  hierarchy: (() => { layout: CanvasLayout<T>; selected: ReadonlySet<string> }) | null;
  onPreview: (plan: CanvasArrangePlan | null) => void;
  onApply: (plan: CanvasArrangePlan, label: string, mode: CanvasArrange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<ArrangePrefs>(loadPrefs);
  const [hover, setHover] = useState<{ key: string; plan: CanvasArrangePlan } | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const previewRef = useRef(onPreview);
  useEffect(() => {
    previewRef.current = onPreview;
  });

  const close = () => {
    setOpen(false);
    setHover(null);
    previewRef.current(null);
  };
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false);
        setHover(null);
        previewRef.current(null);
      }
    };
    window.addEventListener("pointerdown", down);
    return () => window.removeEventListener("pointerdown", down);
  }, [open]);
  // Bez edycji (offline, gość) menu znika razem z podglądem.
  const shown = open && editable;
  useEffect(() => {
    if (!editable) previewRef.current(null);
  }, [editable]);

  const update = (patch: Partial<ArrangePrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
    setHover(null);
    previewRef.current(null);
  };

  const selectedCount = selected.size;
  const scope = prefs.scope === "selection" && selectedCount ? "selection" : "all";
  const ctx: CanvasArrangeContext = { ...context, selection: scope === "selection" ? selected : null, withTray: prefs.tray };

  const items: Item[] = [
    ...(Object.keys(CANVAS_ARRANGE_BY) as CanvasArrangeBy[]).map((by) => ({
      key: by,
      label: `Według ${CANVAS_ARRANGE_BY[by].toLowerCase()}`,
      mode: { kind: "by", by, frames: prefs.frames } as CanvasArrange,
      hint: "Kolumny kategorii",
    })),
    { key: "arrows", label: "Według strzałek", mode: { kind: "arrows" }, hint: "Poprzednik na lewo od następnika, karty bez połączeń z boku" },
    {
      key: "hierarchy",
      label: "Według hierarchii",
      mode: { kind: "hierarchy" },
      hint: `Zadania główne w pierwszym rzędzie, podzadania pod nimi${hierarchy ? " — przełączy na „Z podzadaniami”" : ""}`,
    },
    { key: "compact", label: "Zagęść", mode: { kind: "compact" }, hint: "Najwyżej jedna pusta kolumna / wiersz odstępu; grupy jadą z kartami (zawsze cała tablica)" },
  ];

  const planFor = (item: Item): CanvasArrangePlan => {
    const full = item.mode.kind === "hierarchy" ? hierarchy?.() : null;
    return full
      ? measuredPlan(full.layout, item.mode, { ...ctx, selection: scope === "selection" ? full.selected : null })
      : measuredPlan(layout, item.mode, ctx);
  };
  const show = (item: Item) => {
    const plan = planFor(item);
    setHover({ key: item.key, plan });
    previewRef.current(plan);
  };
  const apply = (item: Item) => {
    const plan = hover?.key === item.key ? hover.plan : planFor(item);
    close();
    onApply(plan, item.label, item.mode);
  };

  return (
    <span
      ref={root}
      className="relative"
      onKeyDown={(e) => {
        if (!shown) return;
        // Esc zamyka menu (nie pełny ekran) — także z fokusem na przycisku; klawisze nie trafiają do skrótów tablicy.
        e.stopPropagation();
        if (e.key === "Escape") close();
      }}
    >
      <Button
        className="py-1 text-xs"
        disabled={!editable || (!layout.placed.length && !layout.tray.length)}
        onClick={() => (shown ? close() : setOpen(true))}
        aria-expanded={shown}
        aria-haspopup="menu"
        title="Automatyczne układanie karteczek — podgląd po najechaniu, klik stosuje (z „Cofnij”)"
        data-testid="canvas-arrange"
      >
        ⊞ Ułóż ▾
      </Button>
      {shown ? (
        <div
          className="absolute left-0 top-full z-40 mt-1 flex w-80 flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-2 text-xs shadow-lg"
          data-testid="canvas-arrange-menu"
        >
          <div className="flex items-center gap-2 px-1">
            <span className="w-14 shrink-0 text-[var(--muted)]">Zakres</span>
            <div className="flex flex-1 overflow-hidden rounded-md border border-[var(--line)]" role="radiogroup" aria-label="Zakres">
              {(
                [
                  ["all", "Cała tablica", false],
                  ["selection", selectedCount ? `Zaznaczenie (${selectedCount})` : "Zaznaczenie", !selectedCount],
                ] as const
              ).map(([key, text, off]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={scope === key}
                  disabled={off}
                  onClick={() => update({ scope: key })}
                  className={`flex-1 px-2 py-1 disabled:opacity-40 ${scope === key ? "bg-[var(--accent)] text-white" : "hover:bg-[var(--hover)]"}`}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 px-1">
            <input type="checkbox" checked={prefs.frames} onChange={(e) => update({ frames: e.target.checked })} />
            Ramki grup z nazwą kategorii („Według …”)
          </label>
          <label className="flex items-center gap-2 px-1">
            <input type="checkbox" checked={prefs.tray} disabled={scope === "selection"} onChange={(e) => update({ tray: e.target.checked })} />
            Z kartami z paska „Do ułożenia”
          </label>
          <ul
            role="menu"
            aria-label="Ułóż"
            className="flex flex-col border-t border-[var(--line)] pt-1"
            onPointerLeave={() => {
              setHover(null);
              previewRef.current(null);
            }}
          >
            {items.map((item) => (
              <li key={item.key} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={`flex w-full flex-col items-start rounded px-2 py-1 text-left hover:bg-[var(--hover)] focus:bg-[var(--hover)] focus:outline-none`}
                  onPointerEnter={() => show(item)}
                  onFocus={() => show(item)}
                  onClick={() => apply(item)}
                  data-testid={`canvas-arrange-${item.key}`}
                >
                  <span className="font-medium">{item.label}</span>
                  <span className="text-[11px] text-[var(--muted)]">{hover?.key === item.key ? previewText(hover.plan) : item.hint}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="px-1 text-[11px] text-[var(--muted)]">Najedź na sposób — przerywane obrysy pokażą, gdzie trafią karty. Klik układa; „Cofnij” w dymku przywraca.</p>
        </div>
      ) : null}
    </span>
  );
}

function previewText(plan: CanvasArrangePlan): string {
  const text = canvasArrangeSummary(plan);
  return plan.note ? `${text} · ${plan.note}` : text;
}
