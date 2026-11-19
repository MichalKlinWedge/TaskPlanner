"use client";

/**
 * Widok tagu i zapisanego filtra (M4) oraz „Zapisz jako filtr” z chipów dowolnego widoku. Wynik
 * liczy `applyFilter` z `core`; bez warunku statusu widać tylko otwarte zadania.
 */
import { applyFilter, COLORS, filterChips, isEmptyFilter, isOpen, keyBetween, plural, sortTasks, uuidv7, type FilterQuery, type ViewContext, type ViewTask } from "@taskplanner/core";
import { useState, type FormEvent } from "react";

import type { AppData, SavedFilter, Tag } from "@/lib/app-data";
import type { Route } from "@/lib/route";

import { useAppEnv } from "./app-env";
import { FilterBar } from "./filter-bar";
import { TaskItem, useTaskActions } from "./task-item";
import { Button, Input } from "./ui";

/** Zadania pasujące do filtra; bez warunku statusu — tylko otwarte. */
export function filtered(tasks: readonly ViewTask[], query: FilterQuery, ctx: ViewContext): ViewTask[] {
  const scoped = tasks.filter((t) => t.kind === "task" && (!ctx.workspaceId || t.workspaceId === ctx.workspaceId));
  return applyFilter(query.statuses ? scoped : scoped.filter(isOpen), query, ctx.today);
}

/** Liczniki paska bocznego: otwarte zadania tagu / pasujące do filtra. */
export function filterCount(tasks: readonly ViewTask[], query: FilterQuery, ctx: ViewContext): number {
  return filtered(tasks, query, ctx).length;
}

function Results({ data, ctx, query }: { data: AppData; ctx: ViewContext; query: FilterQuery }) {
  const tasks = sortTasks(filtered(data.tasks, query, ctx), "due");
  const names = new Map(data.lists.map((l) => [l.id, l.kind === "inbox" ? `Inbox (${data.workspaces.find((w) => w.id === l.workspaceId)?.name})` : l.name]));
  if (!tasks.length) return <p className="py-6 text-center text-sm text-[var(--muted)]">Żadne zadanie nie pasuje.</p>;
  return (
    <ul className="divide-y divide-[var(--line)]">
      {tasks.map((t) => (
        <TaskItem key={t.id} task={t} today={ctx.today} listName={names.get(t.listId)} />
      ))}
    </ul>
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
  const [query, setQuery] = useState<FilterQuery>({ tags: { ids: [tag.id], match: "any" } });
  const [renaming, setRenaming] = useState(false);
  const count = filtered(data.tasks, query, ctx).length;
  const update = (patch: Record<string, unknown>) => run([{ table: "tags", id: tag.id, patch }]);

  return (
    <>
      <header className="mb-2 flex flex-wrap items-center gap-2">
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
        ) : (
          <h1 className="text-xl font-semibold">
            <button type="button" title="Zmień nazwę" className="rounded px-1 hover:bg-[var(--hover)]" onClick={() => setRenaming(true)}>
              @{tag.name}
            </button>
          </h1>
        )}
        <span className="text-sm text-[var(--muted)]">{plural(count, ["zadanie", "zadania", "zadań"])}</span>
        <span className="flex-1" />
        <div className="flex gap-1" role="radiogroup" aria-label="Kolor tagu">
          {COLORS.map((c) => (
            <button key={c.value} type="button" role="radio" aria-checked={c.value === tag.color} aria-label={c.label} title={c.label} onClick={() => void update({ color: c.value })} className="h-4 w-4 rounded-full ring-offset-1 aria-checked:ring-2 aria-checked:ring-[var(--accent)]" style={{ background: c.value }} />
          ))}
        </div>
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
      </header>
      <FilterBar query={query} onChange={(q) => setQuery(q.tags ? q : { ...q, tags: { ids: [tag.id], match: "any" } })}>
        <SaveFilter query={query} onSaved={(id) => navigate({ view: "filter", id })} />
      </FilterBar>
      <Results data={data} ctx={ctx} query={query} />
    </>
  );
}

export function SavedFilterView({ data, ctx, filter, navigate }: { data: AppData; ctx: ViewContext; filter: SavedFilter; navigate: (route: Route) => void }) {
  const { run } = useTaskActions();
  const [query, setQuery] = useState<FilterQuery>(filter.query);
  const [renaming, setRenaming] = useState(false);
  const changed = JSON.stringify(query) !== JSON.stringify(filter.query);
  const count = filtered(data.tasks, query, ctx).length;
  const update = (patch: Record<string, unknown>) => run([{ table: "saved_filters", id: filter.id, patch }]);
  const names = {
    tags: new Map(data.tags.map((t) => [t.id, t.name])),
    lists: new Map(data.lists.map((l) => [l.id, l.name])),
  };

  return (
    <>
      <header className="mb-2 flex flex-wrap items-center gap-2">
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
      </header>
      {!changed ? <p className="mb-2 text-xs text-[var(--muted)]">{filterChips(filter.query, names).map((c) => c.label).join(" · ")}</p> : null}
      <FilterBar query={query} onChange={setQuery} />
      <Results data={data} ctx={ctx} query={query} />
    </>
  );
}
