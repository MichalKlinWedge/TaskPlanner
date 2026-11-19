"use client";

/**
 * Paleta poleceń i wyszukiwarka (M17, `Ctrl+K` / `/`) oraz lista skrótów (`?`). Ranking i polecenia
 * są w `core` (`search.ts`, `commands.ts`); tu jest okno, podtryby („Ustaw priorytet…”,
 * „Przenieś do…”, „Wybierz datę…”, „Przełącz przestrzeń”) i pamięć ostatnio używanych.
 */
import {
  buildSearchIndex,
  COMMANDS,
  commandSearchItems,
  LIST_KIND,
  LIST_SHORTCUTS,
  PRIORITY,
  search,
  taskSearchItem,
  type Priority,
  type SearchItem,
  type SearchKind,
} from "@taskplanner/core";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useAppEnv } from "./app-env";
import { inputClass } from "./ui";

/** Polecenia, które już działają (reszta przyjdzie z kolejnymi etapami — bez martwych pozycji). */
export const AVAILABLE_COMMANDS = new Set([
  "view.inbox",
  "view.today",
  "view.upcoming",
  "view.kanban",
  "view.calendar",
  "view.timeline",
  "focus.start",
  "review.daily",
  "review.weekly",
  "task.quick_add",
  "task.complete",
  "task.priority",
  "task.today",
  "task.tomorrow",
  "task.date",
  "task.move",
  "task.delete",
  "list.new_project",
  "workspace.switch",
  "app.theme",
  "app.search",
  "app.palette",
  "app.shortcuts",
]);

const RECENT_KEY = "tp-recent";
const readRecent = (): Map<string, string> => {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(RECENT_KEY) ?? "{}") as Record<string, string>));
  } catch {
    return new Map();
  }
};
const remember = (id: string) => {
  try {
    const recent = [...readRecent()].filter(([k]) => k !== id);
    recent.unshift([id, new Date().toISOString()]);
    localStorage.setItem(RECENT_KEY, JSON.stringify(Object.fromEntries(recent.slice(0, 30))));
  } catch {
    // Bez pamięci przeglądarki — bez „ostatnio używanych”.
  }
};

export type PaletteMode = "all" | "search" | "priority" | "move" | "date" | "workspace";

/** Wybór z palety: pozycja wyszukiwarki albo wartość podtrybu. */
export type PalettePick =
  | { kind: "item"; item: SearchItem }
  | { kind: "priority"; priority: Priority }
  | { kind: "move"; listId: string }
  | { kind: "date"; date: string }
  | { kind: "workspace"; workspaceId: string | null };

interface Option {
  key: string;
  label: ReactNode;
  hint?: string;
  pick: PalettePick;
}

const KIND_HINT: Record<SearchKind, string> = {
  task: "Zadanie",
  list: "Lista",
  workspace: "Przestrzeń",
  tag: "Tag",
  filter: "Filtr",
  view: "Widok",
  action: "Akcja",
};

const keyHint = (id: string) => COMMANDS.find((c) => c.id === id)?.keys?.join(" ");

function highlighted(title: string, ranges: [number, number][]): ReactNode {
  if (!ranges.length) return title;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    out.push(title.slice(at, from), <mark key={from} className="rounded bg-amber-200/70 text-inherit dark:bg-amber-700/60">{title.slice(from, to)}</mark>);
    at = to;
  }
  out.push(title.slice(at));
  return out;
}

export function CommandPalette({ mode, onClose, onPick }: { mode: PaletteMode; onClose: () => void; onPick: (pick: PalettePick) => void }) {
  const { data, selectedIds, today } = useAppEnv();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const names = useMemo(() => new Map(data.workspaces.map((w) => [w.id, w.name])), [data.workspaces]);
  const listName = useMemo(() => new Map(data.lists.map((l) => [l.id, l.kind === "inbox" ? `Inbox (${names.get(l.workspaceId)})` : l.name])), [data.lists, names]);
  const tagName = useMemo(() => new Map(data.tags.map((t) => [t.id, t.name])), [data.tags]);

  // Indeks budowany raz na otwarcie okna (normalizacja nie powtarza się przy każdym znaku).
  const index = useMemo(() => {
    if (mode !== "all" && mode !== "search") return null;
    const items: SearchItem[] = data.tasks.map((t) => taskSearchItem(t, { listName: listName.get(t.listId), tagNames: t.tagIds.map((id) => tagName.get(id) ?? "") }));
    for (const l of data.lists) if (l.kind !== "inbox") items.push({ id: `list:${l.id}`, kind: "list", title: l.name, listName: names.get(l.workspaceId) });
    for (const w of data.workspaces) items.push({ id: `workspace:${w.id}`, kind: "workspace", title: w.name });
    for (const t of data.tags) items.push({ id: `tag:${t.id}`, kind: "tag", title: t.name, keywords: ["tag"] });
    for (const f of data.savedFilters) items.push({ id: `filter:${f.id}`, kind: "filter", title: f.name, keywords: ["filtr"] });
    if (mode === "all") items.push(...commandSearchItems(selectedIds.size).filter((c) => AVAILABLE_COMMANDS.has(c.id)));
    return buildSearchIndex(items);
  }, [mode, data.tasks, data.lists, data.workspaces, data.tags, data.savedFilters, listName, tagName, names, selectedIds.size]);

  const options: Option[] = useMemo(() => {
    if (mode === "priority") {
      return ([1, 2, 3, 4] as const).map((p) => ({ key: String(p), label: PRIORITY[p].label, hint: PRIORITY[p].short, pick: { kind: "priority", priority: p } }));
    }
    if (mode === "workspace") {
      const all: Option = { key: "all", label: "Wszystkie przestrzenie", pick: { kind: "workspace", workspaceId: null } };
      return [all, ...data.workspaces.map((w): Option => ({ key: w.id, label: w.name, pick: { kind: "workspace", workspaceId: w.id } }))].filter((o) =>
        query ? String(o.label).toLowerCase().includes(query.toLowerCase()) : true,
      );
    }
    if (mode === "move") {
      const items = data.lists.map((l) => ({ id: l.id, kind: "list" as const, title: listName.get(l.id) ?? l.name, listName: names.get(l.workspaceId) }));
      const results = query ? search(buildSearchIndex(items), query, { limit: 30 }).map((r) => r.item) : items;
      return results.map((item) => {
        const l = data.lists.find((x) => x.id === item.id)!;
        return { key: l.id, label: item.title, hint: `${names.get(l.workspaceId)} · ${LIST_KIND[l.kind]}`, pick: { kind: "move", listId: l.id } };
      });
    }
    if (mode === "date") return [];
    if (!index) return [];
    const kinds: SearchKind[] | undefined = mode === "search" ? ["task", "list", "workspace", "tag", "filter"] : query.startsWith(">") ? ["action", "view"] : undefined;
    const text = query.replace(/^>/, "");
    return search(index, text, { limit: 30, recent: readRecent(), kinds }).map((r) => ({
      key: r.item.id,
      label: highlighted(r.item.title, r.highlights),
      hint:
        r.item.kind === "task"
          ? [r.item.listName, r.item.closed ? "zamknięte" : null].filter(Boolean).join(" · ")
          : r.item.kind === "action" || r.item.kind === "view"
            ? [KIND_HINT[r.item.kind], keyHint(r.item.id)].filter(Boolean).join(" · ")
            : KIND_HINT[r.item.kind],
      pick: { kind: "item", item: r.item },
    }));
  }, [mode, index, query, data.lists, data.workspaces, listName, names]);

  const current = Math.min(active, Math.max(0, options.length - 1));
  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const choose = (option: Option | undefined) => {
    if (!option) return;
    if (option.pick.kind === "item") remember(option.pick.item.id);
    onPick(option.pick);
  };

  const placeholder =
    mode === "priority"
      ? "Priorytet zaznaczonych — 1–4 albo strzałki"
      : mode === "move"
        ? "Przenieś zaznaczone do… (nazwa listy)"
        : mode === "date"
          ? "Termin zaznaczonych"
          : mode === "workspace"
            ? "Przestrzeń"
            : mode === "search"
              ? "Szukaj zadań, list, przestrzeni, tagów, filtrów"
              : "Szukaj albo wpisz polecenie (> — tylko polecenia)";

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Paleta poleceń" className="flex max-h-[70vh] w-full max-w-xl flex-col rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-2xl">
        {mode === "date" ? (
          <form
            className="flex gap-2 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              const value = new FormData(e.currentTarget).get("date");
              if (value) onPick({ kind: "date", date: String(value) });
            }}
          >
            <input name="date" type="date" autoFocus defaultValue={today} aria-label={placeholder} className={`${inputClass} flex-1`} onKeyDown={(e) => e.key === "Escape" && onClose()} />
            <button type="submit" className="rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-white">
              Ustaw
            </button>
          </form>
        ) : (
          <>
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((i) => Math.min(i + 1, options.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  choose(options[current]);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                } else if (mode === "priority" && /^[1-4]$/.test(e.key)) {
                  e.preventDefault();
                  choose(options[Number(e.key) - 1]);
                }
              }}
              placeholder={placeholder}
              aria-label={placeholder}
              aria-controls="palette-results"
              aria-activedescendant={options[current] ? `palette-${current}` : undefined}
              className="w-full rounded-t-xl border-b border-[var(--line)] bg-transparent px-4 py-3 text-base outline-none"
            />
            <ul ref={list} id="palette-results" role="listbox" className="overflow-y-auto p-1">
              {options.map((o, i) => (
                <li
                  key={o.key}
                  id={`palette-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === current}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(o)}
                  className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm ${i === current ? "bg-[var(--hover)]" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint ? <span className="shrink-0 text-xs text-[var(--muted)]">{o.hint}</span> : null}
                </li>
              ))}
              {!options.length ? (
                <li className="px-3 py-6 text-center text-sm text-[var(--muted)]">{query ? "Nic nie znaleziono." : mode === "all" || mode === "search" ? "Zacznij pisać — ostatnio używane pojawią się tutaj." : "Brak pozycji."}</li>
              ) : null}
            </ul>
            {mode === "all" ? (
              <p className="border-t border-[var(--line)] px-4 py-2 text-xs text-[var(--muted)]">
                {selectedIds.size ? `Zaznaczone: ${selectedIds.size} — akcje działają na nich. ` : "Zaznacz zadania (klik, Ctrl/Shift + klik, J/K), żeby zobaczyć akcje na nich. "}↑↓ Enter · Esc
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

const EXTRA_SHORTCUTS: readonly { keys: readonly string[]; label: string }[] = [
  { keys: ["Enter"], label: "Otwórz zaznaczone zadanie" },
  { keys: ["Esc"], label: "Zamknij panel / odznacz" },
  { keys: ["Ctrl+klik"], label: "Dodaj do zaznaczenia" },
  { keys: ["Shift+klik"], label: "Zaznacz zakres" },
  { keys: ["Ctrl+Spacja"], label: "Szybkie dodawanie (także w polu tekstowym)" },
];

/** Lista skrótów (`?`): z `core/commands.ts` — tylko działające polecenia. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const rows = [
    ...COMMANDS.filter((c) => c.keys && AVAILABLE_COMMANDS.has(c.id)).map((c) => ({ keys: c.keys!, label: c.label })),
    ...LIST_SHORTCUTS,
    ...EXTRA_SHORTCUTS,
  ];
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Skróty klawiszowe" className="w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-2xl">
        <h2 className="mb-3 text-base font-semibold">Skróty klawiszowe</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="flex gap-1">
                {r.keys.map((k) => (
                  <kbd key={k} className="rounded border border-[var(--line)] bg-[var(--hover)] px-1.5 text-xs">
                    {k}
                  </kbd>
                ))}
              </dt>
              <dd>{r.label}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-[var(--muted)]">Skróty jednoklawiszowe nie działają w polach tekstowych. Esc — zamknij.</p>
      </div>
    </div>
  );
}
