"use client";

/**
 * Dane powłoki aplikacji z lokalnej bazy: przestrzenie, listy, tagi, współpracownicy, zadania jako
 * `ViewTask` (z tagami i odpowiedzialnym) i dzisiejsze wykonania nawyków. Zapytania odświeżają się po każdej zmianie tabel
 * (także z innej karty i z synchronizacji) — zadania przyrostowo (`createTaskCache`: tylko zmienione
 * wiersze, gotowe `ViewTask` reszty zostają); reguły widoków liczy `@taskplanner/core`.
 */
import { AttachmentPreview, boardColumnDefs, canEditList, FilterQuery, localDateAt, ProfileSettings, sortCollaborators, tagWorkspaceIds, toHabitCompletion, toViewTask, ViewPrefs, type BoardColumnDef, type Collaborator, type GuestAccess, type HabitCompletion, type LocalDate, type LocalTaskRow, type ListKind, type ProjectStatus, type ScopeRole, type ViewTask } from "@taskplanner/core";
import { createTaskCache, type TabStore, type TaskEntry } from "@taskplanner/sync";
import { useEffect, useMemo, useState } from "react";

import { reportError } from "./error-log";

import { useLocalQuery } from "./local-store";

export interface Workspace {
  id: string;
  name: string;
  color: string | null;
  sortKey: string;
  /** Rola w przestrzeni z ostatniej synchronizacji (`_scopes`); `null` = jeszcze nieznana (jak właściciel). */
  role: ScopeRole | null;
  /** Liczba członków przestrzeni (`_scopes.members`); > 1 = przestrzeń udostępniona. */
  members: number;
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
  /** Własne kolumny tablicy listy (kanban „Własne”). */
  boardColumns: BoardColumnDef[];
  /** Dostęp gości współdzielonej przestrzeni (`lists.guest_access`). */
  guestAccess: GuestAccess;
}

/** Czy zalogowany może zmieniać listę i jej zadania (rola w przestrzeni + dostęp gości listy). */
export function listEditable(data: Pick<AppData, "lists" | "workspaces">, listId: string | null | undefined): boolean {
  const list = data.lists.find((l) => l.id === listId);
  return canEditList(data.workspaces.find((w) => w.id === list?.workspaceId)?.role, list?.guestAccess);
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

/** Gotowe `ViewTask` przy wpisach bufora — wpis niezmieniony od poprzedniego odczytu = ten sam obiekt. */
const viewTasks = new WeakMap<TaskEntry, ViewTask>();
const viewTask = (entry: TaskEntry): ViewTask => {
  let task = viewTasks.get(entry);
  if (!task) viewTasks.set(entry, (task = toViewTask(entry.row as unknown as LocalTaskRow, entry.tagIds as string[])));
  return task;
};

/**
 * Zadania z lokalnej bazy: pierwszy odczyt — wszystkie, po zmianie — tylko zmienione (id z `watch`;
 * starsza karta-lider bez id → całość). Bez zmian w zadaniach zostaje ta sama tablica.
 */
function useTaskEntries(store: TabStore): { entries: readonly TaskEntry[]; loaded: boolean } {
  const [state, setState] = useState<{ entries: readonly TaskEntry[]; loaded: boolean }>({ entries: [], loaded: false });
  useEffect(() => {
    let alive = true;
    const cache = createTaskCache((sql, params) => store.query(sql, params), { fullTags: "inline" });
    const run = () =>
      cache.read().then(
        (entries) => alive && setState((prev) => (prev.loaded && prev.entries === entries ? prev : { entries, loaded: true })),
        (error) => reportError("sync", error),
      );
    // Od razu, nie w mikrozadaniu: pełny odczyt zadań ma wejść do kolejki bazy przed resztą zapytań
    // (inaczej „Dziś” czeka na wolniejsze zapytania nawyków i załączników — start +0,35 s).
    void run();
    const off = store.watch(["tasks", "task_tags"], (changes) => {
      cache.note(changes);
      void run();
    });
    return () => {
      alive = false;
      off();
    };
  }, [store]);
  return state;
}

export function useAppData(store: TabStore, today: LocalDate): AppData {
  const workspaces = useLocalQuery<Row>(
    store,
    "select w.id, w.name, w.color, w.sort_key, s.role, s.members from workspaces w left join _scopes s on s.id = w.id where w.deleted_at is null and w.archived_at is null",
    [],
    ["workspaces"],
  );
  const lists = useLocalQuery<Row>(
    store,
    "select id, scope_id, kind, name, color, sort_key, view_prefs, start_date, end_date, project_status, board_columns, guest_access from lists where deleted_at is null and archived_at is null",
    [],
    ["lists"],
  );
  const tags = useLocalQuery<Row>(store, "select id, name, color, sort_key, workspace_ids from tags where deleted_at is null", [], ["tags"]);
  const filters = useLocalQuery<Row>(store, "select id, name, icon, query, sort_key from saved_filters where deleted_at is null", [], ["saved_filters"]);
  const collaborators = useLocalQuery<Row>(store, "select id, name, email, acronym, archived_at, workspace_ids from collaborators where deleted_at is null", [], ["collaborators"]);
  const tasks = useTaskEntries(store);
  const habits = useLocalQuery<Row>(
    store,
    // `join` (jak na telefonie): `task_id in (select … from tasks)` przy 10 000 zadań to ~0,35 s, a zapytanie idzie po każdej zmianie zadań.
    `select c.task_id, c.occurrence_date, c.kind, c.value from task_completions c join tasks t on t.id = c.task_id
       where c.deleted_at is null and t.kind = 'habit' and t.deleted_at is null order by c.occurrence_date`,
    [],
    ["task_completions", "tasks"],
  );
  const attachments = useLocalQuery<Row>(
    store,
    "select id, task_id, kind, storage_path, name, mime, size_bytes, url, preview, created_at from attachments where deleted_at is null order by id",
    [],
    ["attachments"],
  );

  const allLists = useMemo(
    () =>
      lists.rows
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
            boardColumns: boardColumnDefs(r.board_columns),
            guestAccess: (r.guest_access as GuestAccess | null) ?? "edit",
          };
        })
        .sort(byKey),
    [lists.rows],
  );
  // Osobno od reszty: bez zmian w zadaniach i listach zostaje ta sama tablica `ViewTask`.
  // Zadania z zarchiwizowanych list nie trafiają do widoków.
  const viewTaskList = useMemo(() => {
    const listIds = new Set(allLists.map((l) => l.id));
    return tasks.entries.map(viewTask).filter((t) => listIds.has(t.listId));
  }, [tasks.entries, allLists]);

  return useMemo(
    () => ({
      workspaces: workspaces.rows
        .map((r) => ({ id: String(r.id), name: String(r.name), color: r.color as string | null, sortKey: String(r.sort_key), role: (r.role as ScopeRole | null) ?? null, members: Number(r.members) || 1 }))
        .sort(byKey),
      lists: allLists,
      tags: tags.rows.map((r) => ({ id: String(r.id), name: String(r.name), color: r.color as string | null, sortKey: String(r.sort_key), workspaceIds: tagWorkspaceIds(r.workspace_ids) })).sort(byKey),
      // Filtr z nieznanym warunkiem (nowsza wersja aplikacji) — pomijany, a nie psujący widoku.
      savedFilters: filters.rows
        .flatMap((r): SavedFilter[] => {
          const query = FilterQuery.safeParse(json(r.query) ?? {});
          return query.success ? [{ id: String(r.id), name: String(r.name), icon: r.icon as string | null, query: query.data, sortKey: String(r.sort_key) }] : [];
        })
        .sort(byKey),
      collaborators: sortCollaborators(collaborators.rows.map((r) => ({ id: String(r.id), name: String(r.name), email: (r.email as string | null) ?? null, acronym: (r.acronym as string | null) ?? null, archivedAt: (r.archived_at as string | null) ?? null, workspaceIds: tagWorkspaceIds(r.workspace_ids) }))),
      tasks: viewTaskList,
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
      loaded: workspaces.ms !== null && lists.ms !== null && tasks.loaded,
    }),
    [workspaces, lists.ms, allLists, tags, filters, collaborators, tasks.loaded, viewTaskList, habits, attachments, today],
  );
}
