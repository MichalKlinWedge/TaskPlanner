"use client";

/**
 * Paleta poleceń i wyszukiwarka (M17, `Ctrl+K` / `/`) oraz lista skrótów (`?`). Ranking i polecenia
 * są w `core` (`search.ts`, `commands.ts`); tu jest okno, podtryby („Ustaw priorytet…”,
 * „Przenieś do…”, „Wybierz datę…”, „Przełącz przestrzeń”) i pamięć ostatnio używanych.
 */
import {
  applyFilter,
  assigneeChoices,
  buildSearchIndex,
  collaboratorsForWorkspace,
  COMMANDS,
  commandSearchItems,
  datePresets,
  dayChip,
  isEmptyFilter,
  LIST_KIND,
  LIST_SHORTCUTS,
  PLUGIN_SEND_NOTE,
  PRIORITY,
  search,
  selfCollaborator,
  tagCoverage,
  tagsForWorkspace,
  taskSearchItem,
  type FilterQuery,
  type Priority,
  type SearchItem,
  type SearchKind,
} from "@taskplanner/core";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useLocalQuery } from "@/lib/local-store";
import { useDialogFocus } from "@/lib/use-dialog-focus";
import { usePlugins } from "@/lib/plugins";

import { useAppEnv } from "./app-env";
import { FilterBar } from "./filter-bar";
import { useFocus } from "./focus";
import { inputClass } from "./ui";

/** Polecenia, które już działają (reszta przyjdzie z kolejnymi etapami — bez martwych pozycji). */
export const AVAILABLE_COMMANDS = new Set([
  "view.home",
  "view.inbox",
  "view.today",
  "view.overdue",
  "view.upcoming",
  "view.undated",
  "view.kanban",
  "view.calendar",
  "view.timeline",
  "view.habits",
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
  "task.tag",
  "task.assignee",
  "task.delete",
  "plugin.send",
  "list.new_project",
  "workspace.switch",
  "app.theme",
  "app.search",
  "app.palette",
  "app.shortcuts",
]);

/** Polecenia dostępne teraz: bez „Tryb skupienia”, gdy wyłączony w Ustawieniach. */
function useAvailable(): (id: string) => boolean {
  const focusOn = useFocus().settings.enabled;
  return useCallback((id: string) => AVAILABLE_COMMANDS.has(id) && (focusOn || !id.startsWith("focus.")), [focusOn]);
}

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

export type PaletteMode = "all" | "search" | "priority" | "move" | "date" | "workspace" | "send" | "tag" | "assignee";

/** Wybór z palety: pozycja wyszukiwarki albo wartość podtrybu. */
export type PalettePick =
  | { kind: "item"; item: SearchItem }
  | { kind: "priority"; priority: Priority }
  | { kind: "move"; listId: string }
  /** `null` = „Bez terminu”. */
  | { kind: "date"; date: string | null }
  | { kind: "workspace"; workspaceId: string | null }
  | { kind: "send"; ruleId: string }
  /** Tag po nazwie: dodać tym, które go nie mają, albo (`remove`) zdjąć ze wszystkich. */
  | { kind: "tag"; name: string; tagId: string | null; remove: boolean }
  /** `null` = twórca zadania; `self` — „Ja” (wpis może dopiero powstać). */
  | { kind: "assignee"; collaboratorId: string | null; self?: boolean };

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

/** Liczba ustawionych warunków filtra. */
const conditions = (query: FilterQuery) => Object.values(query).filter((v) => v !== undefined).length;

const PLACEHOLDER: Record<PaletteMode, string> = {
  priority: "Priorytet zaznaczonych — 1–4 albo strzałki",
  move: "Przenieś zaznaczone do… (nazwa listy)",
  send: "Wyślij zaznaczone do… (reguła z Ustawień → Integracje)",
  tag: "Tag zaznaczonych — nazwa (nowa nazwa tworzy tag)",
  assignee: "Odpowiedzialny zaznaczonych — imię",
  date: "Termin zaznaczonych — Dziś, Jutro… albo data niżej",
  workspace: "Przestrzeń",
  search: "Szukaj zadań, list, przestrzeni, tagów, filtrów",
  all: "Szukaj albo wpisz polecenie (> — tylko polecenia)",
};

export function CommandPalette({ mode, onClose, onPick }: { mode: PaletteMode; onClose: () => void; onPick: (pick: PalettePick) => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);
  const { data, selectedIds, today, store, workspaceId, email } = useAppEnv();
  const { sendable } = usePlugins(store);
  const available = useAvailable();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Filtr zawęża wyniki do pasujących zadań; trwa do zamknięcia okna.
  const [filter, setFilter] = useState<FilterQuery>({});
  const filtered = !isEmptyFilter(filter);
  const searching = mode === "all" || mode === "search";
  // Opisy tylko w otwartym oknie (dane widoków ich nie trzymają).
  const { rows: descriptionRows } = useLocalQuery<{ id: string; d: string }>(
    searching ? store : null,
    "select id, description_md as d from tasks where deleted_at is null and description_md is not null and description_md <> ''",
    [],
    ["tasks"],
  );
  const descriptions = useMemo(() => new Map(descriptionRows.map((r) => [r.id, r.d])), [descriptionRows]);
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Esc także wtedy, gdy fokus jest na chipach filtra albo zniknął razem z przyciskiem („Wyczyść”).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const names = useMemo(() => new Map(data.workspaces.map((w) => [w.id, w.name])), [data.workspaces]);
  const listName = useMemo(() => new Map(data.lists.map((l) => [l.id, l.kind === "inbox" ? `Inbox (${names.get(l.workspaceId)})` : l.name])), [data.lists, names]);
  const tagName = useMemo(() => new Map(data.tags.map((t) => [t.id, t.name])), [data.tags]);

  // Indeks budowany raz na otwarcie okna (normalizacja nie powtarza się przy każdym znaku).
  const index = useMemo(() => {
    if (!searching) return null;
    // Z filtrem tylko pasujące zadania — listy, tagi, filtry i polecenia nie mają tych warunków.
    const tasks = filtered ? applyFilter(data.tasks, filter, today) : data.tasks;
    const items: SearchItem[] = tasks.map((t) =>
      taskSearchItem(t, { description: descriptions.get(t.id), listName: listName.get(t.listId), tagNames: t.tagIds.map((id) => tagName.get(id) ?? "") }),
    );
    if (filtered) return buildSearchIndex(items);
    for (const l of data.lists) if (l.kind !== "inbox") items.push({ id: `list:${l.id}`, kind: "list", title: l.name, listName: names.get(l.workspaceId), keywords: [LIST_KIND[l.kind]] });
    for (const w of data.workspaces) items.push({ id: `workspace:${w.id}`, kind: "workspace", title: w.name });
    for (const t of data.tags) items.push({ id: `tag:${t.id}`, kind: "tag", title: t.name, keywords: ["tag"] });
    for (const f of data.savedFilters) items.push({ id: `filter:${f.id}`, kind: "filter", title: f.name, keywords: ["filtr"] });
    if (mode === "all") items.push(...commandSearchItems(selectedIds.size).filter((c) => available(c.id)));
    return buildSearchIndex(items);
  }, [mode, searching, filtered, filter, today, descriptions, data.tasks, data.lists, data.workspaces, data.tags, data.savedFilters, listName, tagName, names, selectedIds.size, available]);

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
    if (mode === "send") {
      return sendable
        .filter((r) => (query ? r.name.toLowerCase().includes(query.toLowerCase()) : true))
        .map((r): Option => ({ key: r.id, label: r.name, hint: PLUGIN_SEND_NOTE, pick: { kind: "send", ruleId: r.id } }));
    }
    if (mode === "tag" || mode === "assignee") {
      const chosen = data.tasks.filter((t) => selectedIds.has(t.id));
      const q = query.trim().toLowerCase();
      const has = (name: string) => !q || name.toLowerCase().includes(q);
      if (mode === "tag") {
        const tags = tagsForWorkspace(data.tags, workspaceId, chosen.flatMap((t) => t.tagIds)).filter((t) => has(t.name));
        const items = tags.map((t): Option => {
          const coverage = tagCoverage(chosen, t.id);
          const hint = coverage === "all" ? "zdejmij ze wszystkich" : coverage === "some" ? `dodaj pozostałym (ma ${chosen.filter((x) => x.tagIds.includes(t.id)).length} z ${chosen.length})` : "dodaj";
          return { key: t.id, label: `${coverage === "all" ? "−" : "+"} ${t.name}`, hint, pick: { kind: "tag", name: t.name, tagId: t.id, remove: coverage === "all" } };
        });
        const name = query.trim().replace(/^[@#]/, "");
        if (name && !data.tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) items.push({ key: `new:${name}`, label: `+ ${name}`, hint: "nowy tag", pick: { kind: "tag", name, tagId: null, remove: false } });
        return items;
      }
      const current = chosen.map((t) => t.assigneeId ?? null);
      const same = (id: string | null) => chosen.length > 0 && current.every((c) => c === id);
      const me = selfCollaborator(data.collaborators, { email });
      const people = assigneeChoices(collaboratorsForWorkspace(data.collaborators, workspaceId), null).filter((c) => c.id !== me?.id && has(c.name));
      return [
        ...(has("ja") ? [{ key: "self", label: "Ja", hint: same(me?.id ?? "-") ? "wszystkie już mają" : me ? me.name : "powstanie wpis z Twoim e-mailem", pick: { kind: "assignee", collaboratorId: me?.id ?? null, self: true } } satisfies Option] : []),
        ...(has("twórca") || has("bez") ? [{ key: "creator", label: "Twórca zadania", hint: same(null) ? "wszystkie już mają" : "bez wskazanej osoby", pick: { kind: "assignee", collaboratorId: null } } satisfies Option] : []),
        ...people.map((c): Option => ({ key: c.id, label: c.name, hint: same(c.id) ? "wszystkie już mają" : c.shared ? "z udostępnionej przestrzeni" : undefined, pick: { kind: "assignee", collaboratorId: c.id } })),
      ];
    }
    if (mode === "date") {
      // Gotowe dni jak w arkuszu daty na telefonie (core `datePresets`) i „Bez terminu”; inna data — pole pod listą.
      const presets = datePresets(today).map((d): Option => ({ key: d.date + d.label, label: d.label, hint: dayChip(d.date), pick: { kind: "date", date: d.date } }));
      const none: Option = { key: "none", label: "Bez terminu", hint: "zdejmuje termin", pick: { kind: "date", date: null } };
      const q = query.trim().toLowerCase();
      return [...presets, none].filter((o) => !q || String(o.label).toLowerCase().includes(q));
    }
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
  }, [mode, index, query, data.lists, data.workspaces, data.tasks, data.tags, data.collaborators, selectedIds, workspaceId, email, listName, names, sendable, today]);

  const current = Math.min(active, Math.max(0, options.length - 1));
  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const choose = (option: Option | undefined) => {
    if (!option) return;
    if (option.pick.kind === "item") remember(option.pick.item.id);
    onPick(option.pick);
  };

  const placeholder = PLACEHOLDER[mode];

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Paleta poleceń" className="flex max-h-[70vh] w-full max-w-xl flex-col rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-2xl">
          <>
            <input
              ref={input}
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
            {searching ? (
              <div className="px-4 pt-2">
                <FilterBar
                  query={filter}
                  onChange={(next) => {
                    setFilter(next);
                    setActive(0);
                    // Usunięty chip zabiera fokus — pisanie dalej trafia w pole.
                    if (conditions(next) < conditions(filter)) input.current?.focus();
                  }}
                />
              </div>
            ) : null}
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
                <li className="px-3 py-6 text-center text-sm text-[var(--muted)]">{query ? (filtered ? "Żadne pasujące do filtra zadanie tego nie zawiera." : "Nic nie znaleziono.") : mode === "all" || mode === "search" ? "Zacznij pisać — ostatnio używane pojawią się tutaj." : mode === "send" ? "Brak reguł — dodaj je w Ustawieniach → „Integracje”." : "Brak pozycji."}</li>
              ) : null}
            </ul>
            {mode === "date" ? (
              <form
                className="flex items-center gap-2 border-t border-[var(--line)] p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = new FormData(e.currentTarget).get("date");
                  if (value) onPick({ kind: "date", date: String(value) });
                }}
              >
                <label htmlFor="palette-date" className="text-sm text-[var(--muted)]">
                  Inna data
                </label>
                <input id="palette-date" name="date" type="date" defaultValue={today} className={`${inputClass} flex-1`} onKeyDown={(e) => e.key === "Escape" && onClose()} />
                <button type="submit" className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white">
                  Ustaw
                </button>
              </form>
            ) : null}
            {mode === "all" ? (
              <p className="border-t border-[var(--line)] px-4 py-2 text-xs text-[var(--muted)]">
                {selectedIds.size ? `Zaznaczone: ${selectedIds.size} — akcje działają na nich. ` : "Zaznacz zadania (klik, Ctrl/Shift + klik, J/K), żeby zobaczyć akcje na nich. "}↑↓ Enter · Esc
              </p>
            ) : null}
          </>
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
  { keys: ["["], label: "Zwiń / rozwiń panel boczny" },
];

/** Lista skrótów (`?`): z `core/commands.ts` — tylko działające polecenia. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const available = useAvailable();
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);
  useEffect(() => dialog.current?.querySelector<HTMLButtonElement>("button")?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const rows = [
    ...COMMANDS.filter((c) => c.keys && available(c.id)).map((c) => ({ keys: c.keys!, label: c.label })),
    ...LIST_SHORTCUTS,
    ...EXTRA_SHORTCUTS,
  ];
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Skróty klawiszowe" className="w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Skróty klawiszowe</h2>
          <button type="button" aria-label="Zamknij" className="rounded px-2 py-1 text-[var(--muted)] hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none" onClick={onClose}>
            ✕
          </button>
        </div>
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
