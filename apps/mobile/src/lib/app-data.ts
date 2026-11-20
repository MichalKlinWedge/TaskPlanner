/**
 * Dane widoków z lokalnej bazy (MVP-3): przestrzenie, listy, tagi, zapisane filtry, zadania jako
 * `ViewTask` (z tagami), dzisiejsze wykonania nawyków i ustawienia profilu. Jeden magazyn na
 * proces: zakładki, ekrany i widżet czytają ten sam wynik, a odświeżenie po zmianie tabel
 * (zapis, synchronizacja — także kilka stron pierwszej) łączy się w jedno zapytanie.
 * Reguły widoków liczy `@taskplanner/core` — tu jest tylko mapowanie wierszy, jak na webie
 * (`apps/web/src/lib/app-data.ts`).
 */
import { FilterQuery, localDateAt, ProfileSettings, toHabitCompletion, toViewTask, ViewPrefs, type HabitCompletion, type LocalDate, type ListKind, type LocalTaskRow, type ProjectStatus, type ViewContext, type ViewTask } from '@taskplanner/core';
import type { SqlRow, SyncEngine } from '@taskplanner/sync';
import Storage from 'expo-sqlite/kv-store';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { localEngine, onSessionChange } from './sync';

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
  /** Status projektu (`kind = 'project'`). */
  projectStatus: ProjectStatus | null;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  sortKey: string;
}

export interface SavedFilter {
  id: string;
  name: string;
  icon: string | null;
  query: FilterQuery;
  sortKey: string;
}

export interface AppData {
  userId: string;
  workspaces: Workspace[];
  lists: List[];
  tags: Tag[];
  savedFilters: SavedFilter[];
  tasks: ViewTask[];
  /** Id nawyków odhaczonych dziś. */
  habitsDoneToday: Set<string>;
  /** Wpisy nawyków (id zadania → wpisy od najstarszego) — statystyki, blok „Dziś”, przypomnienia. */
  habitCompletions: Map<string, HabitCompletion[]>;
  settings: ProfileSettings;
  loaded: boolean;
}

const json = (value: unknown): unknown => {
  try {
    return typeof value === 'string' ? JSON.parse(value) : (value ?? null);
  } catch {
    return null;
  }
};

const byKey = <T extends { sortKey: string; id: string }>(a: T, b: T) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1);

export const parseSettings = (value: unknown): ProfileSettings => {
  const parsed = ProfileSettings.safeParse(json(value) ?? {});
  return parsed.success ? parsed.data : ProfileSettings.parse({});
};

const EMPTY: AppData = {
  userId: '',
  workspaces: [],
  lists: [],
  tags: [],
  savedFilters: [],
  tasks: [],
  habitsDoneToday: new Set(),
  habitCompletions: new Map(),
  settings: ProfileSettings.parse({}),
  loaded: false,
};

/** Kolumny wiersza dla `toViewTask` (alias `t`) — też kosz. */
export const TASK_COLUMNS = `t.id, t.scope_id, t.list_id, t.parent_id, t.kind, t.title, t.status, t.priority, t.start_date, t.due_date, t.due_time,
  t.duration_min, t.recurrence, t.habit, t.completed_at, t.created_at, t.sort_key, t.board_sort_key, t.postpone_count, t.field_clock`;

const loadSettings = async (engine: SyncEngine): Promise<ProfileSettings> =>
  parseSettings((await engine.db.all<SqlRow>('select settings from profiles where id = ?', [engine.userId]))[0]?.settings);

/**
 * Jedno zadanie i ustawienia — dla akcji bez ekranu (powiadomienie, widżet). Pełne `loadAppData`
 * to w tle nawet kilkadziesiąt sekund, a Android zamraża proces wkrótce po odebraniu akcji.
 */
export async function loadTask(engine: SyncEngine, id: string): Promise<{ task: ViewTask | null; settings: ProfileSettings }> {
  const [settings, rows, tags] = await Promise.all([
    loadSettings(engine),
    engine.db.all<SqlRow>(`select ${TASK_COLUMNS} from tasks t where t.id = ? and t.deleted_at is null`, [id]),
    engine.db.all<SqlRow>('select tag_id from task_tags where task_id = ? and deleted_at is null order by rowid', [id]),
  ]);
  const row = rows[0];
  return { task: row ? toViewTask(row as unknown as LocalTaskRow, tags.map((r) => String(r.tag_id))) : null, settings };
}

/** Wszystko naraz z lokalnej bazy — ekrany, przeplanowanie przypomnień, widżet, zadanie w tle. */
export async function loadAppData(engine: SyncEngine): Promise<AppData> {
  const { db } = engine;
  const settings = await loadSettings(engine);
  const today = localDateAt(new Date(), settings.timeZone);
  const queried = Date.now();
  const [workspaces, lists, tags, filters, tasks, taskTags, habits] = await Promise.all([
    db.all<SqlRow>('select id, name, color, sort_key from workspaces where deleted_at is null and archived_at is null'),
    db.all<SqlRow>('select id, scope_id, kind, name, color, sort_key, view_prefs, project_status from lists where deleted_at is null and archived_at is null'),
    db.all<SqlRow>('select id, name, color, sort_key from tags where deleted_at is null'),
    db.all<SqlRow>('select id, name, icon, query, sort_key from saved_filters where deleted_at is null'),
    db.all<SqlRow>(`select ${TASK_COLUMNS} from tasks t where t.deleted_at is null`),
    // Osobno i pogrupowane w JS: podzapytanie na każde zadanie było najdroższą częścią odczytu na telefonie.
    db.all<SqlRow>('select task_id, tag_id from task_tags where deleted_at is null order by rowid'),
    db.all<SqlRow>(
      `select c.task_id, c.occurrence_date, c.kind, c.value from task_completions c join tasks t on t.id = c.task_id
        where c.deleted_at is null and t.kind = 'habit' and t.deleted_at is null order by c.occurrence_date`,
    ),
  ]);
  if (__DEV__) console.info('dane widoków: zapytania', `${Date.now() - queried} ms`);
  const tagsOf = new Map<string, string[]>();
  for (const r of taskTags) {
    const id = String(r.task_id);
    const list = tagsOf.get(id);
    if (list) list.push(String(r.tag_id));
    else tagsOf.set(id, [String(r.tag_id)]);
  }
  const allLists = lists
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
        projectStatus: (r.project_status as ProjectStatus | null) ?? null,
      };
    })
    .sort(byKey);
  const listIds = new Set(allLists.map((l) => l.id));
  return {
    userId: engine.userId,
    workspaces: workspaces.map((r) => ({ id: String(r.id), name: String(r.name), color: r.color as string | null, sortKey: String(r.sort_key) })).sort(byKey),
    lists: allLists,
    tags: tags.map((r) => ({ id: String(r.id), name: String(r.name), color: r.color as string | null, sortKey: String(r.sort_key) })).sort(byKey),
    // Filtr z nieznanym warunkiem (nowsza wersja aplikacji) — pomijany, a nie psujący widoku.
    savedFilters: filters
      .flatMap((r): SavedFilter[] => {
        const query = FilterQuery.safeParse(json(r.query) ?? {});
        return query.success ? [{ id: String(r.id), name: String(r.name), icon: r.icon as string | null, query: query.data, sortKey: String(r.sort_key) }] : [];
      })
      .sort(byKey),
    // Zadania z zarchiwizowanych list nie trafiają do widoków.
    tasks: tasks
      .map((r) => toViewTask(r as unknown as LocalTaskRow, tagsOf.get(String(r.id)) ?? []))
      .filter((t) => listIds.has(t.listId)),
    habitsDoneToday: new Set(habits.filter((r) => r.occurrence_date === today && r.kind === 'done').map((r) => String(r.task_id))),
    habitCompletions: habits.reduce((map, r) => {
      const id = String(r.task_id);
      const entry = toHabitCompletion({ occurrence_date: r.occurrence_date, kind: r.kind, value: r.value });
      const list = map.get(id);
      if (list) list.push(entry);
      else map.set(id, [entry]);
      return map;
    }, new Map<string, HabitCompletion[]>()),
    settings,
    loaded: true,
  };
}

// ── Magazyn ─────────────────────────────────────────────────────────────────────────────────

const WATCHED = ['workspaces', 'lists', 'tags', 'saved_filters', 'tasks', 'task_tags', 'task_completions', 'profiles'];

let data: AppData = EMPTY;
const listeners = new Set<() => void>();
let started = false;
let unwatch: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;
let loading = false;
let dirty = false;

async function reload() {
  if (loading) {
    dirty = true;
    return;
  }
  loading = true;
  try {
    do {
      dirty = false;
      const started = Date.now();
      data = await loadAppData(await localEngine());
      if (__DEV__) console.info('dane widoków', `${data.tasks.length} zadań, ${Date.now() - started} ms`);
      listeners.forEach((l) => l());
    } while (dirty);
  } catch (error) {
    console.warn('dane widoków', error);
  } finally {
    loading = false;
  }
}

/** Odświeżenie „wkrótce”: seria zmian (strony synchronizacji) = jedno zapytanie. */
export function refreshAppData(delayMs = 40) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void reload();
  }, delayMs);
}

function attach() {
  unwatch?.();
  data = EMPTY;
  listeners.forEach((l) => l());
  localEngine()
    .then((engine) => {
      unwatch = engine.watch(WATCHED, () => refreshAppData());
      void reload();
    })
    .catch((error) => console.warn('lokalna baza', error));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!started) {
    started = true;
    attach();
    onSessionChange(attach);
  }
  return () => listeners.delete(listener);
}

export const useAppData = (): AppData => useSyncExternalStore(subscribe, () => data);

/**
 * Zmiany danych poza Reactem — dla pracy, która musi ruszyć także w tle (przypomnienia, widżet):
 * gdy aplikacja jest w tle, render Reacta (a z nim efekty) czeka do powrotu na ekran.
 */
export function onAppData(listener: (data: AppData) => void): () => void {
  return subscribe(() => listener(data));
}

// ── Bieżąca przestrzeń i dzień ──────────────────────────────────────────────────────────────

const WORKSPACE_KEY = 'ui.workspace';
const workspaceListeners = new Set<() => void>();

/** Tryb jednej przestrzeni (M2); `null` = „Wszystkie”. Zapamiętany na telefonie. */
export const currentWorkspace = (): string | null => Storage.getItemSync(WORKSPACE_KEY) || null;

export function setCurrentWorkspace(id: string | null) {
  if (id) Storage.setItemSync(WORKSPACE_KEY, id);
  else Storage.removeItemSync(WORKSPACE_KEY);
  workspaceListeners.forEach((l) => l());
}

const subscribeWorkspace = (listener: () => void) => {
  workspaceListeners.add(listener);
  return () => workspaceListeners.delete(listener);
};

export function useWorkspace(data: AppData): string | null {
  const id = useSyncExternalStore(subscribeWorkspace, currentWorkspace);
  // Przestrzeń usunięta albo z innego konta — „Wszystkie”.
  return id && data.workspaces.some((w) => w.id === id) ? id : null;
}

/** Dzisiejsza data w strefie użytkownika; zmienia się o północy (sprawdzenie co minutę). */
export function useToday(timeZone?: string): LocalDate {
  const [today, setToday] = useState(() => localDateAt(new Date(), timeZone));
  useEffect(() => {
    const tick = () => setToday(localDateAt(new Date(), timeZone));
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [timeZone]);
  return today;
}

/** Dane, dziś i kontekst widoków (`ViewContext`) — wspólne dla ekranów. */
export function useView() {
  const data = useAppData();
  const today = useToday(data.settings.timeZone);
  const workspaceId = useWorkspace(data);
  const ctx: ViewContext = useMemo(
    () => ({ today, timeZone: data.settings.timeZone, workspaceId, firstDayOfWeek: data.settings.firstDayOfWeek }),
    [today, data.settings.timeZone, workspaceId, data.settings.firstDayOfWeek],
  );
  return { data, today, ctx, workspaceId };
}

/** Ostatni klucz kolejności wśród rodzeństwa: zadania główne listy albo podzadania rodzica. */
export const lastSortKey = (data: AppData, listOrParentId: string): string | undefined =>
  data.tasks.reduce<string | undefined>(
    (max, t) => ((t.parentId === listOrParentId || (t.listId === listOrParentId && t.parentId === null)) && (!max || t.sortKey > max) ? t.sortKey : max),
    undefined,
  );

/** Nazwa listy do pokazania: Inbox z nazwą przestrzeni. */
export function listLabel(data: AppData, listId: string): string {
  const list = data.lists.find((l) => l.id === listId);
  if (!list) return '';
  return list.kind === 'inbox' ? `Inbox (${data.workspaces.find((w) => w.id === list.workspaceId)?.name ?? '—'})` : list.name;
}

/** Inbox, do którego trafiają nowe zadania z widoków zbiorczych: bieżącej albo pierwszej przestrzeni. */
export const targetInbox = (data: AppData, workspaceId: string | null): List | undefined =>
  data.lists.find((l) => l.kind === 'inbox' && l.workspaceId === (workspaceId ?? data.workspaces[0]?.id)) ?? data.lists.find((l) => l.kind === 'inbox');
