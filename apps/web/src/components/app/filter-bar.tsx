"use client";

/**
 * Chipy filtrów nad widokiem (M4): tagi (wszystkie / dowolny), priorytet, lista, status,
 * odpowiedzialny, termin, godzina. Aktywny warunek = chip z „×”; „+ Filtr” dodaje kolejny. Opis warunków i gotowe zakresy
 * terminu są w `core` (`filterChips`, `DUE_PRESETS`).
 */
import { ASSIGNEE_CREATOR, ASSIGNEE_CREATOR_LABEL, collaboratorsByStatus, DUE_PRESETS, duePreset, filterChips, isEmptyFilter, LIST_KIND, PRIORITY, tagsForWorkspace, TASK_STATUS, type DuePreset, type FilterQuery, type Priority, type TaskStatus } from "@taskplanner/core";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useAppEnv } from "./app-env";

type Field = "tags" | "priorities" | "lists" | "statuses" | "assignees" | "due" | "hasTime";

const FIELD_LABEL: Record<Field, string> = {
  tags: "Tagi",
  priorities: "Priorytet",
  lists: "Lista",
  statuses: "Status",
  assignees: "Odpowiedzialny",
  due: "Termin",
  hasTime: "Godzina",
};

const toggle = <T,>(list: readonly T[] | undefined, value: T): T[] | undefined => {
  const next = list?.includes(value) ? list.filter((v) => v !== value) : [...(list ?? []), value];
  return next.length ? next : undefined;
};

export function Popover({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="absolute top-full left-0 z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded-lg border border-[var(--line)] bg-[var(--surface)] p-2 text-sm shadow-lg">
      {children}
    </div>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)]">
      <input type="checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  );
}

export function FilterBar({ query, onChange, hide = [], children }: { query: FilterQuery; onChange: (query: FilterQuery) => void; hide?: readonly Field[]; children?: ReactNode }) {
  const { data, workspaceId } = useAppEnv();
  const [open, setOpen] = useState<Field | "add" | null>(null);
  // Tagi bieżącej przestrzeni + już zaznaczone (nie mogą zniknąć z chipa).
  const tags = tagsForWorkspace(data.tags, workspaceId, query.tags?.ids);
  const names = {
    tags: new Map(data.tags.map((t) => [t.id, t.name])),
    lists: new Map(data.lists.map((l) => [l.id, l.kind === "inbox" ? `Inbox (${data.workspaces.find((w) => w.id === l.workspaceId)?.name})` : l.name])),
    workspaces: new Map(data.workspaces.map((w) => [w.id, w.name])),
    assignees: new Map(data.collaborators.map((c) => [c.id, c.name])),
  };
  const set = (patch: Partial<FilterQuery>) => onChange({ ...query, ...patch });
  const chips = filterChips(query, names).filter((c) => !hide.includes(c.field as Field));
  const unused = (Object.keys(FIELD_LABEL) as Field[]).filter((f) => !hide.includes(f) && query[f] === undefined);

  const editor = (field: Field) => {
    switch (field) {
      case "tags":
        return (
          <>
            {tags.length ? null : <p className="px-2 py-1 text-xs text-[var(--muted)]">Brak tagów — dodaj je w zadaniu (@tag).</p>}
            {tags.map((t) => (
              <Check key={t.id} checked={!!query.tags?.ids.includes(t.id)} onChange={() => {
                const ids = toggle(query.tags?.ids, t.id);
                set({ tags: ids ? { ids, match: query.tags?.match ?? "any" } : undefined });
              }}>
                {t.name}
              </Check>
            ))}
            {query.tags && query.tags.ids.length > 1 ? (
              <div className="mt-1 flex gap-1 border-t border-[var(--line)] px-2 pt-2 text-xs">
                {(["any", "all"] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={query.tags!.match === m} onClick={() => set({ tags: { ...query.tags!, match: m } })} className={`rounded px-2 py-0.5 ${query.tags!.match === m ? "bg-[var(--accent)] text-white" : "border border-[var(--line)]"}`}>
                    {m === "any" ? "dowolny" : "wszystkie"}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        );
      case "priorities":
        return ([1, 2, 3, 4] as Priority[]).map((p) => (
          <Check key={p} checked={!!query.priorities?.includes(p)} onChange={() => set({ priorities: toggle(query.priorities, p) })}>
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: PRIORITY[p].color }} />
            {PRIORITY[p].label}
          </Check>
        ));
      case "lists":
        return data.workspaces.map((w) => (
          <div key={w.id}>
            <p className="px-2 pt-1 text-xs font-semibold text-[var(--muted)]">{w.name}</p>
            {data.lists
              .filter((l) => l.workspaceId === w.id)
              .map((l) => (
                <Check key={l.id} checked={!!query.lists?.includes(l.id)} onChange={() => set({ lists: toggle(query.lists, l.id) })}>
                  {l.kind === "inbox" ? "Inbox" : l.name}
                  {l.kind === "project" ? <span className="text-xs text-[var(--muted)]">{LIST_KIND.project}</span> : null}
                </Check>
              ))}
          </div>
        ));
      case "statuses":
        return (Object.keys(TASK_STATUS) as TaskStatus[]).map((s) => (
          <Check key={s} checked={!!query.statuses?.includes(s)} onChange={() => set({ statuses: toggle(query.statuses, s) })}>
            {TASK_STATUS[s]}
          </Check>
        ));
      case "assignees":
        return (
          <>
            <Check checked={!!query.assignees?.includes(ASSIGNEE_CREATOR)} onChange={() => set({ assignees: toggle(query.assignees, ASSIGNEE_CREATOR) })}>
              <span title="Zadania bez wskazanej osoby odpowiedzialnej">{ASSIGNEE_CREATOR_LABEL}</span>
            </Check>
            {collaboratorsByStatus(data.collaborators).map((c) => (
              <Check key={c.id} checked={!!query.assignees?.includes(c.id)} onChange={() => set({ assignees: toggle(query.assignees, c.id) })}>
                {c.name}
                {c.archivedAt ? <span className="text-xs text-[var(--muted)]">nieaktywny</span> : null}
              </Check>
            ))}
          </>
        );
      case "due": {
        const current = duePreset(query.due);
        return (Object.keys(DUE_PRESETS) as DuePreset[]).map((k) => (
          <label key={k} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)]">
            <input type="radio" name="due" checked={current === k} onChange={() => set({ due: DUE_PRESETS[k].due })} />
            {DUE_PRESETS[k].label}
          </label>
        ));
      }
      case "hasTime":
        return ([true, false] as const).map((v) => (
          <label key={String(v)} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)]">
            <input type="radio" name="hasTime" checked={query.hasTime === v} onChange={() => set({ hasTime: v })} />
            {v ? "Z godziną" : "Bez godziny"}
          </label>
        ));
    }
  };

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="Filtry">
      {chips.map((chip) => (
        <span key={chip.field} className="relative inline-flex items-center rounded-full bg-indigo-100 text-indigo-900 dark:bg-indigo-900/50 dark:text-indigo-100">
          <button type="button" className="py-0.5 pr-1 pl-2.5" aria-expanded={open === chip.field} onClick={() => setOpen(open === chip.field ? null : (chip.field as Field))}>
            {chip.label}
          </button>
          <button type="button" aria-label={`Usuń filtr: ${chip.label}`} className="py-0.5 pr-2 pl-1 opacity-60 hover:opacity-100" onClick={() => set({ [chip.field]: undefined })}>
            ×
          </button>
          {open === chip.field ? <Popover onClose={() => setOpen(null)}>{editor(chip.field as Field)}</Popover> : null}
        </span>
      ))}
      {unused.length ? (
        <span className="relative">
          <button type="button" aria-expanded={open === "add"} onClick={() => setOpen(open === "add" ? null : "add")} className="rounded-full border border-dashed border-[var(--line)] px-2.5 py-0.5 text-[var(--muted)] hover:text-[var(--foreground)]">
            + Filtr
          </button>
          {open === "add" ? (
            <Popover onClose={() => setOpen(null)}>
              {unused.map((f) => (
                <button key={f} type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--hover)]" onClick={() => setOpen(f)}>
                  {FIELD_LABEL[f]}
                </button>
              ))}
            </Popover>
          ) : null}
          {open && open !== "add" && unused.includes(open) ? <Popover onClose={() => setOpen(null)}>{editor(open)}</Popover> : null}
        </span>
      ) : null}
      {!isEmptyFilter(query) ? (
        <button type="button" className="px-1 text-[var(--muted)] hover:text-[var(--foreground)]" onClick={() => onChange({})}>
          Wyczyść
        </button>
      ) : null}
      {children}
    </div>
  );
}
