"use client";

/**
 * „Pokaż” w kalendarzu: które listy (zadania, nawyki) i które kalendarze zewnętrzne są w widoku. Wybór
 * jest per przeglądarka (`localStorage` `tp-calendar-hidden` — ukryte id), nowa lista i nowy kalendarz
 * są widoczne. Ukryte nie liczą się też do konfliktów, wolnych okien ani panelu zadań bez godziny.
 * Widoczność kalendarza na koncie (Ustawienia → „Połączone kalendarze”) jest osobna: ukryty tam nie
 * synchronizuje wydarzeń i tu się nie pojawia.
 */
import { projectFilterLabel } from "@taskplanner/core";
import { useCallback, useMemo, useState } from "react";

import type { AppData } from "@/lib/app-data";
import { useLocalQuery } from "@/lib/local-store";

import { useAppEnv } from "./app-env";
import { Popover } from "./filter-bar";

const KEY = "tp-calendar-hidden";

export interface CalendarHidden {
  lists: ReadonlySet<string>;
  calendars: ReadonlySet<string>;
}

const ids = (value: unknown): Set<string> => new Set(Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []);

export function readCalendarHidden(): CalendarHidden {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as { lists?: unknown; calendars?: unknown };
    return { lists: ids(v.lists), calendars: ids(v.calendars) };
  } catch {
    return { lists: new Set(), calendars: new Set() };
  }
}

export function storeCalendarHidden(hidden: CalendarHidden) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ lists: [...hidden.lists], calendars: [...hidden.calendars] }));
  } catch {
    // Bez pamięci przeglądarki — do odświeżenia.
  }
}

export interface ExternalCalendar extends Record<string, string | null> {
  id: string;
  name: string;
  color: string | null;
}

/** Kalendarze zewnętrzne widoczne na koncie (bez kalendarza „Task Planner” — jego wydarzenia to zadania). */
export function useExternalCalendars(): ExternalCalendar[] {
  const { store } = useAppEnv();
  return useLocalQuery<ExternalCalendar>(store, "select id, name, color from calendars where visible = 1 and is_task_target = 0 order by name", [], ["calendars"]).rows;
}

const dotColor = (color: string | null) => (color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : "var(--muted)");

function Item({ checked, onChange, color, name, ...rest }: { checked: boolean; onChange: () => void; color: string | null; name: string; "data-list"?: string; "data-calendar"?: string }) {
  return (
    <label {...rest} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)]">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: dotColor(color) }} aria-hidden />
      <span className="truncate">{name}</span>
    </label>
  );
}

export function CalendarSources({ data, workspaceId, calendars, hidden, onChange }: { data: AppData; workspaceId: string | null; calendars: readonly ExternalCalendar[]; hidden: CalendarHidden; onChange: (hidden: CalendarHidden) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  // Przestrzenie (bieżąca albo wszystkie) z listami: Inbox pierwszy, potem kolejność ręczna.
  const groups = useMemo(
    () =>
      data.workspaces
        .filter((w) => !workspaceId || w.id === workspaceId)
        .map((w) => ({
          workspace: w,
          lists: data.lists
            .filter((l) => l.workspaceId === w.id)
            .sort((a, b) => Number(b.kind === "inbox") - Number(a.kind === "inbox") || (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)),
        }))
        .filter((g) => g.lists.length),
    [data.workspaces, data.lists, workspaceId],
  );
  const lists = groups.flatMap((g) => g.lists);
  const all = [...lists.map((l) => ({ id: l.id, name: l.kind === "inbox" ? `Inbox (${groups.find((g) => g.lists.includes(l))?.workspace.name})` : l.name })), ...calendars];
  const hiddenAll = new Set([...hidden.lists, ...hidden.calendars]);
  const label = projectFilterLabel(all, hiddenAll);
  const filtered = label !== "wszystkie";

  const setLists = (change: (next: Set<string>) => void) => {
    const next = new Set(hidden.lists);
    change(next);
    onChange({ ...hidden, lists: next });
  };
  const toggleCalendar = (id: string) => {
    const next = new Set(hidden.calendars);
    if (!next.delete(id)) next.add(id);
    onChange({ ...hidden, calendars: next });
  };

  return (
    <span className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="calendar-sources"
        className={`max-w-56 truncate rounded-md border px-2.5 py-1 text-xs ${filtered ? "border-transparent bg-indigo-100 text-indigo-900 dark:bg-indigo-900/50 dark:text-indigo-100" : "border-[var(--line)] hover:bg-black/5 dark:hover:bg-white/10"}`}
        onClick={() => setOpen((o) => !o)}
      >
        Pokaż: {label} ▾
      </button>
      {open ? (
        <Popover onClose={close}>
          <div className="mb-1 flex gap-3 px-2 text-xs">
            <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => onChange({ lists: new Set(), calendars: new Set() })}>
              Wszystkie
            </button>
            <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => onChange({ lists: new Set(lists.map((l) => l.id)), calendars: new Set(calendars.map((c) => c.id)) })}>
              Żadne
            </button>
          </div>
          {groups.map(({ workspace, lists: own }) => {
            const shown = own.filter((l) => !hidden.lists.has(l.id)).length;
            return (
              <div key={workspace.id} role="group" aria-label={workspace.name} className="mt-1">
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs font-semibold text-[var(--muted)] uppercase hover:bg-[var(--hover)]">
                  <input
                    type="checkbox"
                    checked={shown === own.length}
                    ref={(el) => {
                      if (el) el.indeterminate = shown > 0 && shown < own.length;
                    }}
                    onChange={() => setLists((next) => own.forEach((l) => (shown === own.length ? next.add(l.id) : next.delete(l.id))))}
                  />
                  <span className="truncate">{workspace.name}</span>
                </label>
                <div className="pl-4">
                  {own.map((l) => (
                    <Item key={l.id} data-list={l.id} checked={!hidden.lists.has(l.id)} onChange={() => setLists((next) => void (next.delete(l.id) || next.add(l.id)))} color={l.color ?? workspace.color} name={l.kind === "inbox" ? "Inbox" : l.name} />
                  ))}
                </div>
              </div>
            );
          })}
          {calendars.length ? (
            <div role="group" aria-label="Kalendarze zewnętrzne" className="mt-2 border-t border-[var(--line)] pt-1">
              <div className="px-2 py-1 text-xs font-semibold text-[var(--muted)] uppercase">Kalendarze zewnętrzne</div>
              {calendars.map((c) => (
                <Item key={c.id} data-calendar={c.id} checked={!hidden.calendars.has(c.id)} onChange={() => toggleCalendar(c.id)} color={c.color} name={c.name} />
              ))}
            </div>
          ) : null}
        </Popover>
      ) : null}
    </span>
  );
}
