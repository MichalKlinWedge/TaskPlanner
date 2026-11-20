"use client";

/**
 * Dane powłoki aplikacji z lokalnej bazy: przestrzenie, listy, tagi, współpracownicy, zadania jako
 * `ViewTask` (z tagami i odpowiedzialnym) i dzisiejsze wykonania nawyków. Zapytania odświeżają się po każdej zmianie tabel
 * (także z innej karty i z synchronizacji); reguły widoków liczy `@taskplanner/core`.
 */
import { AttachmentPreview, FilterQuery, localDateAt, ProfileSettings, sortCollaborators, tagWorkspaceIds, toHabitCompletion, toViewTask, ViewPrefs, type Collaborator, type HabitCompletion, type LocalDate, type LocalTaskRow, type ListKind, type ProjectStatus, type ViewTask } from "@taskplanner/core";
import type { SqlRow, TabStore } from "@taskplanner/sync";
import { useEffect, useMemo, useState } from "react";

import { useLocalQuery } from "./local-store";

export interface Workspace {
  id: string;
  name: string;
  color: string | null;
  sortKey: string;
}

export interface List {
  id: string;
  workspaceId: string;
  kind: ListKind;
  name: string;
  color: string | null;
  sortKey: string;
  prefs: ViewPrefs;
  /** Daty projektu (oś czasu); inne listy — `null`. */
  startDate: LocalDate | null;
  endDate: LocalDate | null;
  /** Status projektu (przegląd tygodnia: aktywne bez następnego kroku); inne listy — `null`. */
  projectStatus: ProjectStatus | null;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  sortKey: string;
  /** Przestrzenie, w których tag się pokazuje; `null` = wszystkie (core `tagsForWorkspace`). */
  workspaceIds: string[] | null;
}

export interface SavedFilter {
  id: string;
  name: string;
  icon: string | null;
  query: FilterQuery;
  sortKey: string;
}

/** Załącznik zadania (M5): plik w Storage albo link z podglądem strony. */
export interface Attachment {
  id: string;
  taskId: string;
  kind: "file" | "link";
  storagePath: string | null;
  name: string;
  mime: string | null;
  size: number | null;
  url: string | null;
  /** Link: `null` = podgląd jeszcze nie pobrany, `{}` = niedostępny. */
  preview: AttachmentPreview | null;
  createdAt: string;
}

export interface AppData {
  workspaces: Workspace[];
  lists: List[];
  tags: Tag[];
  savedFilters: SavedFilter[];
  /** Współpracownicy (alfabetycznie) — uczestnicy i odpowiedzialni zadań. */
  collaborators: Collaborator[];
  tasks: ViewTask[];
  /** Id nawyków odhaczonych dziś. */
  habitsDoneToday: Set<string>;
  /** Wpisy nawyków (`task_completions`): id nawyku → wpisy (statystyki, pasek dni, „Dziś”). */
  habitCompletions: Map<string, HabitCompletion[]>;
  /** Załączniki: id zadania → wiersze (od najstarszego — id to UUIDv7). */
  attachments: Map<string, Attachment[]>;
  loaded: boolean;
}

type Row = Record<string, string | number | null>;

const json = (value: string | number | null): unknown => {
  try {
    return typeof value === "string" ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

const byKey = <T extends { sortKey: string; id: string }>(a: T, b: T) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1);

/** Ustawienia profilu (z domyślnymi, gdy brak albo błąd). */
export function parseSettings(value: unknown): ProfileSettings {
  const parsed = ProfileSettings.safeParse(typeof value === "string" ? json(value) : (value ?? {}));
  return parsed.success ? parsed.data : ProfileSettings.parse({});
}

/** Dzisiejsza data w strefie użytkownika; zmienia się o północy (sprawdzenie co minutę). */
export function useToday(timeZone?: string): LocalDate {
  const [today, setToday] = useState(() => localDateAt(new Date(), timeZone));
  useEffect(() => {
    const tick = () => setToday(localDateAt(new Date(), timeZone));
    tick();
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, [timeZone]);
  return today;
}

export function useAppData(store: TabStore, today: LocalDate): AppData {
  const workspaces = useLocalQuery<Row>(store, "select id, name, color, sort_key from workspaces where deleted_at is null and archived_at is null", [], ["workspaces"]);
  const lists = useLocalQuery<Row>(
    store,
    "select id, scope_id, kind, name, color, sort_key, view_prefs, start_date, end_date, project_status from lists where deleted_at is null and archived_at is null",
    [],
    ["lists"],
  );
  const tags = useLocalQuery<Row>(store, "select id, name, color, sort_key, workspace_ids from tags where deleted_at is null", [], ["tags"]);
  const filters = useLocalQuery<Row>(store, "select id, name, icon, query, sort_key from saved_filters where deleted_at is null", [], ["saved_filters"]);
  const collaborators = useLocalQuery<Row>(store, "select id, name, email, acronym, archived_at from collaborators where deleted_at is null", [], ["collaborators"]);
  const tasks = useLocalQuery<SqlRow>(
    store,
    `select t.id, t.scope_id, t.list_id, t.parent_id, t.kind, t.title, t.status, t.priority, t.start_date, t.due_date, t.due_time,
            t.duration_min, t.recurrence, t.habit, t.completed_at, t.created_at, t.sort_key, t.board_sort_key, t.postpone_count, t.assignee_id,
            -- Z zegarów pól widoki potrzebują tylko statusu (\`statusChangedAt\`); cały JSON przy 10 000 zadań to ~5 MB na odczyt.
            json_object('status', json_extract(t.field_clock, '$.status')) as field_clock,
            (select group_concat(tt.tag_id) from task_tags tt where tt.task_id = t.id and tt.deleted_at is null) as tag_ids
       from tasks t where t.deleted_at is null`,
    [],
    ["tasks", "task_tags"],
  );
  const habits = useLocalQuery<Row>(
    store,
    `select c.task_id, c.occurrence_date, c.kind, c.value from task_completions c
       where c.deleted_at is null and c.task_id in (select id from tasks where kind = 'habit' and deleted_at is null)
       order by c.occurrence_date`,
    [],
    ["task_completions", "tasks"],
  );
  const attachments = useLocalQuery<Row>(
    store,
    "select id, task_id, kind, storage_path, name, mime, size_bytes, url, preview, created_at from attachments where deleted_at is null order by id",
    [],
    ["attachments"],
  );

  return useMemo(() => {
    const listIds = new Set<string>();
    const allLists = lists.rows
      .map((r): List => {
        const prefs = ViewPrefs.safeParse(json(r.view_prefs) ?? {});
        return {
          id: String(r.id),
          workspaceId: String(r.scope_id),
          kind: r.kind as ListKind,
          name: String(r.name),
          color: r.color as string | null,
          sortKey: String(r.sort_key),
          prefs: prefs.success ? prefs.data : {},
          startDate: (r.start_date as LocalDate | null) ?? null,
          endDate: (r.end_date as LocalDate | null) ?? null,
          projectStatus: (r.project_status as ProjectStatus | null) ?? null,
        };
      })
      .sort(byKey);
    for (const l of allLists) listIds.add(l.id);
    return {
      workspaces: workspaces.rows.map((r) => ({ id: String(r.id), name: String(r.name), color: r.color as string | null, sortKey: String(r.sort_key) })).sort(byKey),
      lists: allLists,
      tags: tags.rows.map((r) => ({ id: String(r.id), name: String(r.name), color: r.color as string | null, sortKey: String(r.sort_key), workspaceIds: tagWorkspaceIds(r.workspace_ids) })).sort(byKey),
      // Filtr z nieznanym warunkiem (nowsza wersja aplikacji) — pomijany, a nie psujący widoku.
      savedFilters: filters.rows
        .flatMap((r): SavedFilter[] => {
          const query = FilterQuery.safeParse(json(r.query) ?? {});
          return query.success ? [{ id: String(r.id), name: String(r.name), icon: r.icon as string | null, query: query.data, sortKey: String(r.sort_key) }] : [];
        })
        .sort(byKey),
      collaborators: sortCollaborators(collaborators.rows.map((r) => ({ id: String(r.id), name: String(r.name), email: (r.email as string | null) ?? null, acronym: (r.acronym as string | null) ?? null, archivedAt: (r.archived_at as string | null) ?? null }))),
      // Zadania z zarchiwizowanych list nie trafiają do widoków.
      tasks: tasks.rows
        .map((r) => toViewTask(r as unknown as LocalTaskRow, typeof r.tag_ids === "string" && r.tag_ids ? r.tag_ids.split(",") : []))
        .filter((t) => listIds.has(t.listId)),
      habitsDoneToday: new Set(habits.rows.filter((r) => r.occurrence_date === today && r.kind === "done").map((r) => String(r.task_id))),
      habitCompletions: habits.rows.reduce((map, r) => {
        const id = String(r.task_id);
        map.set(id, [...(map.get(id) ?? []), toHabitCompletion({ occurrence_date: r.occurrence_date, kind: r.kind, value: r.value })]);
        return map;
      }, new Map<string, HabitCompletion[]>()),
      attachments: attachments.rows.reduce((map, r) => {
        const preview = r.preview === null ? null : AttachmentPreview.safeParse(json(r.preview) ?? {});
        const item: Attachment = {
          id: String(r.id),
          taskId: String(r.task_id),
          kind: r.kind === "link" ? "link" : "file",
          storagePath: (r.storage_path as string | null) ?? null,
          name: String(r.name),
          mime: (r.mime as string | null) ?? null,
          size: r.size_bytes === null ? null : Number(r.size_bytes),
          url: (r.url as string | null) ?? null,
          preview: preview === null ? null : preview.success ? preview.data : {},
          createdAt: String(r.created_at ?? ""),
        };
        map.set(item.taskId, [...(map.get(item.taskId) ?? []), item]);
        return map;
      }, new Map<string, Attachment[]>()),
      loaded: workspaces.ms !== null && lists.ms !== null && tasks.ms !== null,
    };
  }, [workspaces, lists, tags, filters, collaborators, tasks, habits, attachments, today]);
}
