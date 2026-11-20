"use client";

/**
 * Eksport do Excela z widoków: przycisk z ikoną XLS, zapis skoroszytu (`core` `xlsxWorkbook`) jako
 * pobranie pliku i nazwy kolumn arkusza zadań z danych aplikacji (`tasksSheet`).
 */
import { exportFileName, plural, tasksSheet, XLSX_MIME, xlsxWorkbook, type TaskExportNames, type TaskExportRow, type ViewContext, type XlsxSheet } from "@taskplanner/core";

import type { AppData } from "@/lib/app-data";

import { useTaskActions } from "./task-item";

/** Ikona pliku arkusza: zielona kartka z zagiętym rogiem i napisem „XLS”. */
export function XlsIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
      <path d="M5 2h10l5 5v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="#1d7a45" />
      <path d="M15 2v4a1 1 0 0 0 1 1h4z" fill="#8fd1a8" />
      <text x="12" y="18.2" textAnchor="middle" fontSize="7" fontWeight="700" fontFamily="Arial, Helvetica, sans-serif" fill="#fff">
        XLS
      </text>
    </svg>
  );
}

/** Pobranie skoroszytu jako plik. */
export function downloadXlsx(fileName: string, sheets: readonly XlsxSheet[]): void {
  const blob = new Blob([xlsxWorkbook(sheets)], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Nazwy list (Inbox z przestrzenią), przestrzeni, tagów i współpracowników do arkusza zadań. */
export function exportNames(data: AppData): TaskExportNames {
  const workspaces = new Map(data.workspaces.map((w) => [w.id, w.name]));
  return {
    workspaces,
    lists: new Map(data.lists.map((l) => [l.id, l.kind === "inbox" ? `Inbox (${workspaces.get(l.workspaceId) ?? ""})` : l.name])),
    tags: new Map(data.tags.map((t) => [t.id, t.name])),
    collaborators: new Map(data.collaborators.map((c) => [c.id, c.name])),
  };
}

/**
 * Przycisk „Eksport XLSX”: arkusze budowane dopiero po kliknięciu (`build`), potem pobranie pliku i
 * komunikat (`summary` — np. ile wierszy).
 */
export function ExportButton({ fileName, build, summary, disabled, title = "Zapisz widoczne zadania do pliku Excel", testId }: { fileName: string; build: () => XlsxSheet[]; summary?: () => string; disabled?: boolean; title?: string; testId?: string }) {
  const { notify } = useTaskActions();
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      data-testid={testId}
      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 py-1 text-xs hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
      onClick={() => {
        downloadXlsx(fileName, build());
        notify(`Zapisano ${fileName}${summary ? `: ${summary()}` : ""}.`);
      }}
    >
      <XlsIcon />
      Eksport XLSX
    </button>
  );
}

/** Eksport zadań widoku: `rows` liczone po kliknięciu, w kolejności widoku (z sekcjami / poziomami). */
export function TaskExportButton({ title, data, ctx, rows, count }: { title: string; data: AppData; ctx: ViewContext; rows: () => TaskExportRow[]; count: number }) {
  return (
    <ExportButton
      fileName={exportFileName(title, ctx.today)}
      build={() => [tasksSheet(rows(), exportNames(data), { name: title, timeZone: ctx.timeZone })]}
      summary={() => plural(count, ["zadanie", "zadania", "zadań"])}
      disabled={!count}
      testId="view-export"
    />
  );
}
