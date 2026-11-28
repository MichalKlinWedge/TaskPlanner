"use client";

/**
 * Widok tagu i zapisanego filtra (M4) oraz „Zapisz jako filtr” z chipów dowolnego widoku. Wynik
 * liczy `applyFilter` z `core`; bez warunku statusu widać tylko otwarte zadania.
 */
import { filterChips, isEmptyFilter, keyBetween, plural, selectFiltered, sortTasks, tagWorkspacesPatch, uuidv7, type FilterQuery, type ViewContext, type ViewTask } from "@taskplanner/core";
import { useState, type FormEvent } from "react";

import { useAdhocFilter } from "@/lib/adhoc-filters";
import type { AppData, SavedFilter, Tag } from "@/lib/app-data";
import { routeHash, type Route } from "@/lib/route";

import { useAppEnv } from "./app-env";
import { TaskExportButton } from "./export";
import { FilterBar } from "./filter-bar";
import { TagColorPicker } from "./tag-chip";
import { TaskItem, useTaskActions } from "./task-item";
import { Button, Input } from "./ui";
import { ColumnsScroll, useViewColumns } from "./views";

/** Zadania pasujące do filtra; bez warunku statusu — tylko otwarte. */
export const filtered = (tasks: readonly ViewTask[], query: FilterQuery, ctx: ViewContext): ViewTask[] => selectFiltered(tasks, query, ctx);

/** Liczniki paska bocznego: otwarte zadania tagu / pasujące do filtra. */
export function filterCount(tasks: readonly ViewTask[], query: FilterQuery, ctx: ViewContext): number {
  return filtered(tasks, query, ctx).length;
}

/** Wyniki z kolumnami widoku (`view` z `useViewColumns`). */
function Results({ data, ctx, query, view }: { data: AppData; ctx: ViewContext; query: FilterQuery; view: ReturnType<typeof useViewColumns> }) {
  const tasks = sortTasks(filtered(data.tasks, query, ctx), view.sort.by, view.sort.dir);
  const names = new Map(data.lists.map((l) => [l.id, l.kind === "inbox" ? `Inbox (${data.workspaces.find((w) => w.id === l.workspaceId)?.name})` : l.name]));
  if (!tasks.length) return <p className="py-6 text-center text-sm text-[var(--muted)]">Żadne zadanie nie pasuje.</p>;
  return (
    <ColumnsScroll columns={view.cols.columns}>
      {view.columnsHeader}
      <ul className="divide-y divide-[var(--line)]">
        {tasks.map((t) => (
          <TaskItem key={t.id} task={t} today={ctx.today} listName={names.get(t.listId)} {...view.cols} />
        ))}
      </ul>
    </ColumnsScroll>
  );
}

/** „Zapisz jako filtr”: nazwa w polu obok chipów. */
export function SaveFilter({ query, onSaved }: { query: FilterQuery; onSaved?: (id: string) => void }) {
  const { data } = useAppEnv();
  const { run } = useTaskActions();
  const [name, setName] = useState<string | null>(null);
  if (isEmptyFilter(query)) return null;
  if (name === null) {
    return (
      <button type="button" className="ml-auto px-1 text-[var(--accent)] hover:underline" onClick={() => setName("")}>
        Zapisz jako filtr
      </button>
    );
  }
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!value) return;
    const id = uuidv7();
    await run([{ table: "saved_filters", id, patch: { name: value.slice(0, 60), icon: null, query, sort_key: keyBetween(data.savedFilters.at(-1)?.sortKey) } }], { text: `Zapisano filtr „${value}”` });
    setName(null);
    onSaved?.(id);
  };
  return (
    <form onSubmit={(e) => void save(e)} className="ml-auto flex gap-1">
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nazwa filtra" aria-label="Nazwa filtra" maxLength={60} className="w-40 py-0.5 text-xs" onKeyDown={(e) => e.key === "Escape" && setName(null)} />
      <Button type="submit" disabled={!name.trim()}>
        Zapisz
      </Button>
    </form>
  );
}

export function TagView({ data, ctx, tag, navigate }: { data: AppData; ctx: ViewContext; tag: Tag; navigate: (route: Route) => void }) {
  const { run } = useTaskActions();
  // Warunek tego tagu zawsze jest; dodatkowe chipy pamiętane per widok jak w Inbox / Dziś (R-06).
  const { userId } = useAppEnv();
  const [extra, setExtra] = useAdhocFilter(userId, routeHash({ view: "tag", id: tag.id }));
  const base: FilterQuery = { tags: { ids: [tag.id], match: "any" } };
  const query: FilterQuery = extra.tags ? extra : { ...extra, tags: base.tags };
  const setQuery = (q: FilterQuery) => setExtra(JSON.stringify(q) === JSON.stringify(base) ? {} : q);
  const [renaming, setRenaming] = useState(false);
  const count = filtered(data.tasks, query, ctx).length;
  const update = (patch: Record<string, unknown>) => run([{ table: "tags", id: tag.id, patch }]);
  const view = useViewColumns("tag", ctx, { sortable: true });

  return (
    <>
      <header className="tp-view-header mb-2 flex flex-wrap items-center gap-2">
        <span className="h-3 w-3 rounded-full" style={{ background: tag.color ?? "var(--muted)" }} />
        {renaming ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
              if (name && name !== tag.name) void update({ name: name.slice(0, 60) });
              setRenaming(false);
            }}
          >
            <Input name="name" autoFocus defaultValue={tag.name} aria-label="Nazwa tagu" maxLength={60} onBlur={(e) => e.currentTarget.form?.requestSubmit()} />
          </form>
        ) : tag.shared ? (
          <h1 className="text-xl font-semibold">@{tag.name}</h1>
        ) : (
          <h1 className="text-xl font-semibold">
            <button type="button" title="Zmień nazwę" className="rounded px-1 hover:bg-[var(--hover)]" onClick={() => setRenaming(true)}>
              @{tag.name}
            </button>
          </h1>
        )}
        <span className="text-sm text-[var(--muted)]">{plural(count, ["zadanie", "zadania", "zadań"])}</span>
        <span className="flex-1" />
        {tag.shared ? (
          <span className="text-xs text-[var(--muted)]" data-testid="tag-shared">
            Tag innego członka przestrzeni — nazwę i kolor zmienia jego autor
          </span>
        ) : (
          <>
            <TagColorPicker value={tag.color} onChange={(color) => void update({ color })} />
            <Button
              kind="ghost"
              onClick={() => {
                if (!window.confirm(`Usunąć tag „${tag.name}”? Zadania zostaną, stracą tylko ten tag.`)) return;
                void update({ deleted_at: new Date().toISOString() });
                navigate({ view: "today" });
              }}
            >
              Usuń tag
            </Button>
          </>
        )}
        <TaskExportButton title={`@${tag.name}`} data={data} ctx={ctx} count={count} rows={() => sortTasks(filtered(data.tasks, query, ctx), view.sort.by, view.sort.dir).map((task) => ({ task }))} />
      </header>
      <div className="mb-3" hidden={tag.shared}>
        <WorkspaceChips ids={tag.workspaceIds} workspaces={data.workspaces} label="Przestrzenie tagu" onChange={(ids) => void update(tagWorkspacesPatch(ids))} />
      </div>
      <div className="mb-2 flex flex-wrap gap-2">
        {view.sortControls}
        {view.picker}
      </div>
      <FilterBar query={query} onChange={(q) => setQuery(q.tags ? q : { ...q, tags: base.tags })}>
        <SaveFilter query={query} onSaved={(id) => navigate({ view: "filter", id })} />
      </FilterBar>
      <Results data={data} ctx={ctx} query={query} view={view} />
    </>
  );
}

/** Przestrzenie, w których tag / współpracownik się pokazuje i podpowiada; żadna zaznaczona = wszystkie. */
export function WorkspaceChips({ ids, workspaces, label, onChange }: { ids: readonly string[] | null | undefined; workspaces: AppData["workspaces"]; label: string; onChange: (ids: string[]) => void }) {
  const chosen = (ids ?? []).filter((id) => workspaces.some((w) => w.id === id));
  const chip = (pressed: boolean) => `rounded-full border px-2.5 py-0.5 ${pressed ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)] hover:bg-[var(--hover)]"}`;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label={label}>
      <span className="text-[var(--muted)]">Widoczny w:</span>
      <button type="button" aria-pressed={!chosen.length} onClick={() => onChange([])} className={chip(!chosen.length)}>
        wszystkich przestrzeniach
      </button>
      {workspaces.map((w) => {
        const on = chosen.includes(w.id);
        return (
          <button key={w.id} type="button" aria-pressed={on} onClick={() => onChange(on ? chosen.filter((id) => id !== w.id) : [...chosen, w.id])} className={`inline-flex items-center gap-1 ${chip(on)}`}>
            <span className="h-2 w-2 rounded-full" style={{ background: w.color ?? "var(--muted)" }} />
            {w.name}
          </button>
        );
      })}
    </div>
  );
}

export function SavedFilterView({ data, ctx, filter, navigate }: { data: AppData; ctx: ViewContext; filter: SavedFilter; navigate: (route: Route) => void }) {
  const { run } = useTaskActions();
  // Zmiany na ekranie są ważne dla tej wersji zapisanego filtra; zapis z innego urządzenia je zastępuje.
  const saved = JSON.stringify(filter.query);
  const [draft, setDraft] = useState<{ key: string; query: FilterQuery } | null>(null);
  const query = draft?.key === saved ? draft.query : filter.query;
  const setQuery = (next: FilterQuery) => setDraft({ key: saved, query: next });
  const [renaming, setRenaming] = useState(false);
  const changed = JSON.stringify(query) !== saved;
  const count = filtered(data.tasks, query, ctx).length;
  const update = (patch: Record<string, unknown>) => run([{ table: "saved_filters", id: filter.id, patch }]);
  const view = useViewColumns("filter", ctx, { sortable: true });
  const names = {
    tags: new Map(data.tags.map((t) => [t.id, t.name])),
    lists: new Map(data.lists.map((l) => [l.id, l.name])),
    assignees: new Map(data.collaborators.map((c) => [c.id, c.name])),
  };

  return (
    <>
      <header className="tp-view-header mb-2 flex flex-wrap items-center gap-2">
        {renaming ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
              if (name && name !== filter.name) void update({ name: name.slice(0, 60) });
              setRenaming(false);
            }}
          >
            <Input name="name" autoFocus defaultValue={filter.name} aria-label="Nazwa filtra" maxLength={60} onBlur={(e) => e.currentTarget.form?.requestSubmit()} />
          </form>
        ) : (
          <h1 className="text-xl font-semibold">
            <button type="button" title="Zmień nazwę" className="rounded px-1 hover:bg-[var(--hover)]" onClick={() => setRenaming(true)}>
              {filter.name}
            </button>
          </h1>
        )}
        <span className="text-sm text-[var(--muted)]">{plural(count, ["zadanie", "zadania", "zadań"])}</span>
        <span className="flex-1" />
        {changed ? (
          <>
            <Button kind="primary" onClick={() => void update({ query })} disabled={isEmptyFilter(query)}>
              Zapisz zmiany
            </Button>
            <Button kind="ghost" onClick={() => setQuery(filter.query)}>
              Przywróć
            </Button>
          </>
        ) : null}
        <Button
          kind="ghost"
          onClick={() => {
            if (!window.confirm(`Usunąć filtr „${filter.name}”? Zadania zostaną.`)) return;
            void update({ deleted_at: new Date().toISOString() });
            navigate({ view: "today" });
          }}
        >
          Usuń filtr
        </Button>
        <TaskExportButton title={filter.name} data={data} ctx={ctx} count={count} rows={() => sortTasks(filtered(data.tasks, query, ctx), view.sort.by, view.sort.dir).map((task) => ({ task }))} />
      </header>
      {!changed ? <p className="mb-2 text-xs text-[var(--muted)]">{filterChips(filter.query, names).map((c) => c.label).join(" · ")}</p> : null}
      <div className="mb-2 flex flex-wrap gap-2">
        {view.sortControls}
        {view.picker}
      </div>
      <FilterBar query={query} onChange={setQuery} />
      <Results data={data} ctx={ctx} query={query} view={view} />
    </>
  );
}
