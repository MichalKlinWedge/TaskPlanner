"use client";

/**
 * Przycisk „Eksport” w pasku Karteczek: okienko z opcjami i pobranie PNG / PDF. Rysowanie z modelu
 * (core `canvasExportScene`, `lib/canvas-export.ts`), nie zrzut DOM; tylko odczyt lokalnych danych,
 * więc działa offline i dla gościa z podglądem. Opcje pamiętane na urządzeniu (`tp-canvas-export`).
 */
import { exportFileName, plural, type CanvasExportPerson, type CanvasExportTask, type CanvasExportThemeName, type CanvasGroup, type CanvasPdfMode, type LocalDate, type PdfOrientation, type PdfPaper, type PlacedCard } from "@taskplanner/core";
import { useEffect, useRef, useState } from "react";

import { canvasPdf, canvasPng, exportScene } from "@/lib/canvas-export";
import type { Tag } from "@/lib/app-data";
import { reportError } from "@/lib/error-log";

import { downloadBlob } from "./export";
import { useTaskActions } from "./task-item";
import { Button } from "./ui";

interface ExportPrefs {
  scope: "all" | "selection";
  theme: "light" | "current";
  legend: boolean;
  paper: PdfPaper;
  orientation: PdfOrientation;
  mode: CanvasPdfMode;
}

const PREFS_KEY = "tp-canvas-export";
const DEFAULT_PREFS: ExportPrefs = { scope: "all", theme: "light", legend: true, paper: "a4", orientation: "landscape", mode: "fit" };

function loadPrefs(): ExportPrefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<ExportPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: ExportPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Bez zapisu — następnym razem domyślne opcje.
  }
}

/** Ikona obrazu: kartka z zagiętym rogiem i górami. */
function ImageIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden focusable="false">
      <path d="M5 2h10l5 5v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="#7c3aed" />
      <path d="M15 2v4a1 1 0 0 0 1 1h4z" fill="#c4b5fd" />
      <circle cx="9" cy="11" r="1.6" fill="#fff" />
      <path d="M6.5 19l3.5-4.5 2.5 3 2-2.5 3 4z" fill="#fff" />
    </svg>
  );
}

function Choice<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: readonly (readonly [T, string, boolean?])[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[var(--muted)]">{label}</span>
      <div className="flex flex-1 overflow-hidden rounded-md border border-[var(--line)]" role="radiogroup" aria-label={label}>
        {options.map(([key, text, off]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={value === key}
            disabled={disabled || off}
            onClick={() => onChange(key)}
            className={`flex-1 px-2 py-1 disabled:opacity-40 ${value === key ? "bg-[var(--accent)] text-white" : "hover:bg-[var(--hover)]"}`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CanvasExportButton({
  listName,
  today,
  placed,
  trayCount,
  groups,
  tags,
  people,
  subtasks,
  titles,
  selected,
}: {
  listName: string;
  today: LocalDate;
  placed: readonly PlacedCard<CanvasExportTask>[];
  trayCount: number;
  groups: readonly CanvasGroup[];
  tags: ReadonlyMap<string, Tag>;
  people: ReadonlyMap<string, { assignee: CanvasExportPerson | null; participants: readonly CanvasExportPerson[] }>;
  subtasks: ReadonlyMap<string, { done: number; total: number }>;
  /** Tytuły zadań (id → tytuł) — „↑ rodzic” na karcie podzadania. */
  titles: ReadonlyMap<string, string>;
  /** Zaznaczone zadania (karty). */
  selected: ReadonlySet<string>;
}) {
  const { notify } = useTaskActions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useState<ExportPrefs>(loadPrefs);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const update = (patch: Partial<ExportPrefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  const selectedCount = placed.filter((p) => selected.has(p.task.id)).length;
  const scope = prefs.scope === "selection" && selectedCount ? "selection" : "all";

  const download = async (format: "png" | "pdf") => {
    setBusy(true);
    try {
      const parentTitles = new Map(placed.flatMap((p) => (p.task.parentId ? [[p.task.id, titles.get(p.task.parentId) ?? ""] as const] : [])));
      const theme: CanvasExportThemeName = prefs.theme === "current" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      const scene = await exportScene(
        { listName, today, placed, trayCount, groups, tags, people, subtasks, parentTitles },
        { selection: scope === "selection" ? selected : null, legend: prefs.legend, theme },
      );
      const fileName = exportFileName(listName, today, format);
      if (format === "png") {
        const { blob, scale } = await canvasPng(scene);
        downloadBlob(fileName, blob);
        notify(`Zapisano ${fileName}: ${plural(scene.cards, ["karteczka", "karteczki", "karteczek"])}${scale < 2 ? ` (zmniejszone do ${Math.round(scale * 100)} % — duża tablica)` : ""}.`);
      } else {
        const { blob, pages } = await canvasPdf(scene, { paper: prefs.paper, orientation: prefs.orientation, mode: prefs.mode }, listName);
        downloadBlob(fileName, blob);
        notify(`Zapisano ${fileName}: ${plural(pages, ["strona", "strony", "stron"])}.`);
      }
      setOpen(false);
    } catch (error) {
      reportError("error", error, { where: "canvas-export", format });
      notify(`Nie udało się zapisać pliku: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span ref={root} className="relative">
      <Button className="py-1 text-xs" disabled={!placed.length} onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Zapisz tablicę jako obraz PNG albo PDF" data-testid="canvas-export">
        <ImageIcon />
        Eksport
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Eksport karteczek"
          className="absolute right-0 top-full z-40 mt-1 flex w-80 flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-xs shadow-lg"
          onKeyDown={(e) => {
            // Esc zamyka okienko (nie pełny ekran); klawisze nie trafiają do skrótów tablicy.
            e.stopPropagation();
            if (e.key === "Escape") setOpen(false);
          }}
          data-testid="canvas-export-dialog"
        >
          <Choice
            label="Zakres"
            value={scope}
            options={[
              ["all", "Cała tablica"],
              ["selection", selectedCount ? `Zaznaczenie (${selectedCount})` : "Zaznaczenie", !selectedCount],
            ]}
            onChange={(v) => update({ scope: v })}
          />
          <Choice
            label="Motyw"
            value={prefs.theme}
            options={[
              ["light", "Jasny"],
              ["current", "Bieżący"],
            ]}
            onChange={(v) => update({ theme: v })}
          />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={prefs.legend} onChange={(e) => update({ legend: e.target.checked })} />
            Legenda kolorów tagów
          </label>
          <div className="flex flex-col gap-2 border-t border-[var(--line)] pt-2">
            <span className="font-medium">PDF</span>
            <Choice
              label="Papier"
              value={prefs.paper}
              options={[
                ["a4", "A4"],
                ["a3", "A3"],
              ]}
              onChange={(v) => update({ paper: v })}
            />
            <Choice
              label="Orientacja"
              value={prefs.orientation}
              options={[
                ["landscape", "Pozioma"],
                ["portrait", "Pionowa"],
              ]}
              onChange={(v) => update({ orientation: v })}
            />
            <Choice
              label="Układ"
              value={prefs.mode}
              options={[
                ["fit", "Jedna strona"],
                ["pages", "Kilka stron"],
              ]}
              onChange={(v) => update({ mode: v })}
            />
          </div>
          <div className="flex justify-end gap-2 border-t border-[var(--line)] pt-2">
            <Button className="py-1 text-xs" disabled={busy} onClick={() => void download("png")} data-testid="canvas-export-png">
              Pobierz PNG
            </Button>
            <Button kind="primary" className="py-1 text-xs" disabled={busy} onClick={() => void download("pdf")} data-testid="canvas-export-pdf">
              Pobierz PDF
            </Button>
          </div>
          <p className="text-[11px] text-[var(--muted)]">Karty z paska „Do ułożenia” nie trafiają do pliku. „Kilka stron” — stała skala, strony cięte między kartami.</p>
        </div>
      ) : null}
    </span>
  );
}
