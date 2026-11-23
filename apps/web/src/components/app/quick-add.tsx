"use client";

/**
 * Szybkie dodawanie (M13): pole z parserem z `core/quick-add.ts`, rozpoznane fragmenty jako chipy
 * (klik cofa rozpoznanie), podgląd tytułu i listy docelowej, wiele linii naraz (wklejenie).
 * Ten sam komponent w widokach (pole na górze) i w oknie wywoływanym klawiszem `Q` / `Ctrl+Spacja`.
 */
import { findUrl, linkName, localDateTimeAt, parseQuickAdd, withLinkOps, plural, quickAddChip, quickAddTaskOps, suppressToken, taskTagOps, type LocalDate, type TaskOp, type QuickAddContext, type QuickAddTokenKind } from "@taskplanner/core";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";

import { lastSortKey, useAppEnv } from "./app-env";
import { useTaskActions } from "./task-item";
import { inputClass } from "./ui";

const KIND_STYLE: Record<QuickAddTokenKind, string> = {
  date: "bg-blue-100 text-blue-900 dark:bg-blue-900/50 dark:text-blue-100",
  time: "bg-blue-100 text-blue-900 dark:bg-blue-900/50 dark:text-blue-100",
  duration: "bg-cyan-100 text-cyan-900 dark:bg-cyan-900/50 dark:text-cyan-100",
  priority: "bg-red-100 text-red-900 dark:bg-red-900/50 dark:text-red-100",
  target: "bg-green-100 text-green-900 dark:bg-green-900/50 dark:text-green-100",
  tag: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100",
  recurrence: "bg-violet-100 text-violet-900 dark:bg-violet-900/50 dark:text-violet-100",
  reminder: "bg-pink-100 text-pink-900 dark:bg-pink-900/50 dark:text-pink-100",
};

export interface QuickAddProps {
  /** Lista, gdy wpis nie wskazuje innej; brak = Inbox bieżącej (albo pierwszej) przestrzeni. */
  listId?: string;
  /** Termin, gdy wpis go nie podaje. */
  dueDate?: LocalDate | null;
  /** Pola z kolumny tablicy (status, priorytet), gdy wpis ich nie podaje; tagi dokładane. */
  defaults?: { status?: string; priority?: number; tagNames?: readonly string[]; boardColumnId?: string; /** Komórka karteczki (widok „Karteczki”) — tylko pierwsze zadanie, gdy zostaje na `listId`. */ canvasPos?: { col: number; row: number } };
  /** Podzadanie tego zadania (lista rodzica, wskazanie listy we wpisie pomijane). */
  parent?: { id: string; listId: string };
  placeholder?: string;
  autoFocus?: boolean;
  /** Po dodaniu (Enter); `more` = Ctrl+Enter — okno zostaje otwarte. */
  onAdded?: (more: boolean) => void;
  onCancel?: () => void;
  /** Tekst na start (udostępnienie, zakładka). */
  initialText?: string;
  /** Adres z udostępnienia / zakładki — załącznik i źródło `link` pierwszego zadania (Etap 10). */
  link?: { url: string; shared: true };
}

export function QuickAdd({ listId, dueDate, parent, defaults, placeholder = "Dodaj zadanie", autoFocus, onAdded, onCancel, initialText, link }: QuickAddProps) {
  const { data, userId, timeZone, today, workspaceId } = useAppEnv();
  const { run, notify } = useTaskActions();
  const [text, setText] = useState(initialText ?? "");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const names = useMemo(() => new Map(data.workspaces.map((w) => [w.id, w.name])), [data.workspaces]);
  const defaultListId = parent?.listId ?? listId ?? data.lists.find((l) => l.kind === "inbox" && l.workspaceId === (workspaceId ?? data.workspaces[0]?.id))?.id;
  const defaultWorkspace = data.lists.find((l) => l.id === defaultListId)?.workspaceId ?? workspaceId;

  const parserContext = useMemo(
    (): Omit<QuickAddContext, "now"> => ({
      currentWorkspace: defaultWorkspace ? names.get(defaultWorkspace) : undefined,
      workspaces: data.workspaces.map((w) => w.name),
      lists: data.lists.filter((l) => l.kind !== "inbox").map((l) => ({ workspace: names.get(l.workspaceId) ?? "", name: l.name, kind: l.kind })),
      tags: data.tags.map((t) => t.name),
    }),
    [data.workspaces, data.lists, data.tags, names, defaultWorkspace],
  );
  const parse = (value: string) => parseQuickAdd(value, { ...parserContext, now: localDateTimeAt(new Date(), timeZone) });
  const result = useMemo(() => parse(text), [text, parserContext, timeZone]); // eslint-disable-line react-hooks/exhaustive-deps

  const scope = (listIdFallback: string) => ({
    userId,
    workspaces: data.workspaces,
    lists: data.lists,
    tags: data.tags,
    defaultListId: listIdFallback,
    defaultDueDate: dueDate ?? null,
    parent,
    lastSortKey: (id: string) => lastSortKey(data, id),
  });

  const listName = (id: string) => {
    const list = data.lists.find((l) => l.id === id);
    if (!list) return "";
    return list.kind === "inbox" ? `Inbox („${names.get(list.workspaceId)}”)` : list.name;
  };

  const add = async (lines: string[], more: boolean) => {
    if (!defaultListId) return notify("Brak listy docelowej — utwórz przestrzeń w „Przestrzenie i listy”.");
    const ops: TaskOp[] = [];
    const added: { taskId: string; listId: string }[] = [];
    // Kolejne zadania z jednego wklejenia idą po sobie: klucz kolejności z poprzedniego.
    const keys = new Map<string, string>();
    for (const line of lines) {
      const parsed = parse(line);
      if (!parsed.title.trim()) continue;
      const base = scope(defaultListId);
      const result = quickAddTaskOps(parsed, line, { ...base, lastSortKey: (id) => keys.get(id) ?? base.lastSortKey(id) });
      keys.set(parent?.id ?? result.listId, result.ops[0]!.patch.sort_key as string);
      if (defaults?.status) Object.assign(result.ops[0]!.patch, { status: defaults.status }, defaults.status === "done" ? { completed_at: new Date().toISOString() } : {});
      if (defaults?.priority && !parsed.fields.priority) result.ops[0]!.patch.priority = defaults.priority;
      if (defaults?.boardColumnId) result.ops[0]!.patch.board_column_id = defaults.boardColumnId;
      if (defaults?.canvasPos && !added.length && result.listId === listId) result.ops[0]!.patch.canvas_pos = defaults.canvasPos;
      // Adres w tytule (wklejony) albo z udostępnienia → załącznik-link; podgląd strony dociągnie tytuł.
      ops.push(...withLinkOps(result, { title: parsed.title, url: added.length === 0 ? link?.url : null, shared: added.length === 0 && Boolean(link) }));
      if (defaults?.tagNames?.length) ops.push(...taskTagOps({ userId, tags: data.tags }, result.taskId, defaults.tagNames, data.lists.find((l) => l.id === result.listId)?.workspaceId).filter((op) => !ops.some((o) => o.table === op.table && o.id === op.id)));
      added.push(result);
    }
    if (!added.length) return notify("Zadanie musi mieć tytuł.");
    const at = new Date().toISOString();
    await run(ops, {
      text: added.length === 1 ? `Dodano do ${listName(added[0]!.listId)}` : `Dodano ${plural(added.length, ["zadanie", "zadania", "zadań"])}`,
      undo: added.map((a) => ({ table: "tasks" as const, id: a.taskId, patch: { deleted_at: at } })),
    });
    setText("");
    onAdded?.(more);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (text.trim()) void add([text], event.ctrlKey || event.metaKey);
    } else if (event.key === "Escape") {
      if (text) setText("");
      else onCancel?.();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");
    const lines = pasted
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return;
    event.preventDefault();
    if (window.confirm(`Dodać ${plural(lines.length, ["zadanie", "zadania", "zadań"])} (każda linia osobno)?`)) void add(lines, true);
    else setText(lines.join(" "));
  };

  // Podgląd listy docelowej: te same reguły co zapis (wskazana lista / przestrzeń albo domyślna).
  let target: string | null = null;
  if (text.trim() && defaultListId && result.title.trim()) target = quickAddTaskOps(result, text, { ...scope(defaultListId), newId: () => "podglad" }).listId;

  return (
    <div className="my-2">
      <input
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={`+ ${placeholder}`}
        aria-label={placeholder}
        aria-describedby={text ? "quick-add-preview" : undefined}
        maxLength={1000}
        disabled={!defaultListId}
        className={`${inputClass} w-full`}
      />
      {text.trim() ? (
        <div id="quick-add-preview" className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-[var(--muted)]">
            {result.title.trim() ? <strong className="font-medium text-[var(--foreground)]">{result.title}</strong> : <em>bez tytułu</em>}
            {target ? ` → ${listName(target)}` : ""}
          </span>
          {findUrl(result.title) || link ? (
            <span className="rounded-full bg-black/5 px-2 py-0.5 font-medium dark:bg-white/10" title="Link trafi do załączników zadania">
              🔗 {linkName(link?.url ?? findUrl(result.title)!)}
            </span>
          ) : null}
          {result.tokens.map((token) => {
            const label = quickAddChip(token, result, today);
            return (
              <button
                key={token.start}
                type="button"
                title="Cofnij rozpoznanie — fragment wróci do tytułu"
                aria-label={`${label} — cofnij rozpoznanie`}
                onClick={() => {
                  setText(suppressToken(text, token));
                  input.current?.focus();
                }}
                className={`rounded-full px-2 py-0.5 font-medium ${KIND_STYLE[token.kind]}`}
              >
                {label} <span aria-hidden>×</span>
              </button>
            );
          })}
          <span className="ml-auto text-[var(--muted)]">Enter — dodaj{onAdded ? " · Ctrl+Enter — dodaj i pisz dalej" : ""}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Okno szybkiego dodawania nad bieżącym widokiem. */
export function QuickAddDialog({ open, onClose, ...props }: QuickAddProps & { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-[15vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Szybkie dodawanie" className="w-full max-w-xl rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 shadow-2xl">
        <QuickAdd {...props} autoFocus onAdded={(more) => !more && onClose()} onCancel={onClose} />
        <p className="px-1 text-xs text-[var(--muted)]">
          Np. „Zapłacić rachunek jutro o 10 #dom !wysoki @telefon ~15m” · Esc — zamknij
        </p>
      </div>
    </div>
  );
}
