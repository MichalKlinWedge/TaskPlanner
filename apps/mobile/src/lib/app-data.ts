/**
 * Dane widoków z lokalnej bazy (MVP-3): przestrzenie, listy, tagi, zapisane filtry, współpracownicy,
 * zadania jako `ViewTask` (z tagami i odpowiedzialnym), dzisiejsze wykonania nawyków i ustawienia profilu. Jeden magazyn na
 * proces: zakładki, ekrany i widżet czytają ten sam wynik, a odświeżenie po zmianie tabel
 * (zapis, synchronizacja — także kilka stron pierwszej) łączy się w jedno zapytanie. Zadania
 * odświeżają się przyrostowo (`createTaskCache`: tylko zmienione wiersze, gotowe `ViewTask` reszty zostają).
 * Reguły widoków liczy `@taskplanner/core` — tu jest tylko mapowanie wierszy, jak na webie
 * (`apps/web/src/lib/app-data.ts`).
 */
import { boardColumnDefs, canEditList, listShareBadge, FilterQuery, localDateAt, ProfileSettings, scopeCollaborator, scopeTag, tagWorkspaceIds, toHabitCompletion, toViewTask, ViewPrefs, withSharedCollaborators, withSharedTags, type BoardColumnDef, type Collaborator, type GuestAccess, type HabitCompletion, type ListShareBadge, type LocalDate, type ListKind, type LocalTaskRow, type ProjectStatus, type ViewContext, type ViewTask, type ScopeRole } from '@taskplanner/core';
import { createTaskCache, TASK_COLUMNS, type SqlRow, type SyncEngine, type TaskCache, type TaskEntry } from '@taskplanner/sync';
import Storage from 'expo-sqlite/kv-store';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { perfEnd, perfLog } from './perf';
import { localEngine, onSessionChange } from './sync';

export interface Workspace {
  id: string;
  name: string;
  color: string | null;
  sortKey: string;
  /** Rola z ostatniej synchronizacji (`_scopes`); `null` = jeszcze nieznana (jak właściciel). */
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
  /** Status projektu (`kind = 'project'`). */
  projectStatus: ProjectStatus | null;
  /** Własne kolumny tablicy listy (tryb „Własne”, core `boardColumnDefs`). */
  boardColumns: BoardColumnDef[];
  /** Daty projektu (`kind = 'project'`, oś czasu). */
  startDate: LocalDate | null;
  endDate: LocalDate | null;
  /** Dostęp gości współdzielonej przestrzeni (`lists.guest_access`). */
  guestAccess: GuestAccess;
}

/** Czy zalogowany może zmieniać listę i jej zadania (rola w przestrzeni + dostęp gości listy). */
export function listEditable(data: Pick<AppData, 'lists' | 'workspaces'>, listId: string | null | undefined): boolean {
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
  /** Tag innego członka z kopii w udostępnionej przestrzeni (`scope_tags`): tylko do przypinania, bez edycji. */
  shared?: boolean;
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
  /** Współpracownicy (alfabetycznie) — uczestnicy i odpowiedzialni zadań. */
  collaborators: Collaborator[];
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
  collaborators: [],
  tasks: [],
  habitsDoneToday: new Set(),
  habitCompletions: new Map(),
  settings: ProfileSettings.parse({}),
  loaded: false,
};

/** Kolumny wiersza dla `toViewTask` (alias `t`) — też kosz (`@taskplanner/sync`). */
export { TASK_COLUMNS };

/** Gotowe `ViewTask` przy wpisach bufora — wpis niezmieniony od poprzedniego odczytu = ten sam obiekt. */
const viewTasks = new WeakMap<TaskEntry, ViewTask>();
const viewTask = (entry: TaskEntry): ViewTask => {
  let task = viewTasks.get(entry);
  if (!task) viewTasks.set(entry, (task = toViewTask(entry.row as unknown as LocalTaskRow, entry.tagIds as string[])));
  return task;
};
/** Poprzednia lista zadań — bez zmian w zadaniach i listach zostaje ta sama tablica (widoki nie liczą od nowa). */
let lastTasks: { entries: readonly TaskEntry[]; lists: string; tasks: ViewTask[] } | null = null;

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

/**
 * Wszystko naraz z lokalnej bazy — ekrany, przeplanowanie przypomnień, widżet, zadanie w tle.
 * Z buforem zadań (magazyn ekranów) czyta tylko zmienione zadania; bez niego — wszystkie.
 */
export async function loadAppData(engine: SyncEngine, cache: TaskCache = createTaskCache((sql, params) => engine.db.all(sql, params))): Promise<AppData> {
  const { db } = engine;
  const settings = await loadSettings(engine);
  const today = localDateAt(new Date(), settings.timeZone);
  const queried = Date.now();
  const [workspaces, lists, tags, sharedTags, filters, collaborators, sharedPeople, entries, habits] = await Promise.all([
    db.all<SqlRow>('select w.id, w.name, w.color, w.sort_key, s.role, s.members from workspaces w left join _scopes s on s.id = w.id where w.deleted_at is null and w.archived_at is null'),
    db.all<SqlRow>('select id, scope_id, kind, name, color, sort_key, view_prefs, project_status, board_columns, guest_access, start_date, end_date from lists where deleted_at is null and archived_at is null'),
    db.all<SqlRow>('select id, name, color, sort_key, workspace_ids from tags where deleted_at is null'),
    // Tagi innych członków z udostępnionych przestrzeni.
    db.all<SqlRow>('select scope_id, tag_id, name, color from scope_tags'),
    db.all<SqlRow>('select id, name, icon, query, sort_key from saved_filters where deleted_at is null'),
    db.all<SqlRow>('select id, name, email, acronym, archived_at, workspace_ids from collaborators where deleted_at is null'),
    // Cudze osoby z udostępnionych przestrzeni (odpowiedzialni / uczestnicy wskazani przez innych).
    db.all<SqlRow>('select scope_id, collaborator_id, name, acronym, archived_at from scope_collaborators'),
    cache.read(),
    db.all<SqlRow>(
      `select c.task_id, c.occurrence_date, c.kind, c.value from task_completions c join tasks t on t.id = c.task_id
        where c.deleted_at is null and t.kind = 'habit' and t.deleted_at is null order by c.occurrence_date`,
    ),
  ]);
  perfLog('dane widoków: zapytania', Date.now() - queried);
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
        boardColumns: boardColumnDefs(r.board_columns),
        startDate: (r.start_date as LocalDate | null) ?? null,
        endDate: (r.end_date as LocalDate | null) ?? null,
        guestAccess: (r.guest_access as GuestAccess | null) ?? 'edit',
      };
    })
    .sort(byKey);
  const listIds = new Set(allLists.map((l) => l.id));
  const listKey = allLists.map((l) => l.id).join();
  // Zadania z zarchiwizowanych list nie trafiają do widoków.
  const tasks =
    lastTasks && lastTasks.entries === entries && lastTasks.lists === listKey ? lastTasks.tasks : entries.map(viewTask).filter((t) => listIds.has(t.listId));
  lastTasks = { entries, lists: listKey, tasks };
  return {
    userId: engine.userId,
    workspaces: workspaces
      .map((r) => ({ id: String(r.id), name: String(r.name), color: r.color as string | null, sortKey: String(r.sort_key), role: (r.role as ScopeRole | null) ?? null, members: Number(r.members) || 1 }))
      .sort(byKey),
    lists: allLists,
    tags: withSharedTags(
      tags.map((r) => ({ id: String(r.id), name: String(r.name), color: r.color as string | null, sortKey: String(r.sort_key), workspaceIds: tagWorkspaceIds(r.workspace_ids) })).sort(byKey),
      sharedTags.map(scopeTag),
    ),
    // Filtr z nieznanym warunkiem (nowsza wersja aplikacji) — pomijany, a nie psujący widoku.
    savedFilters: filters
      .flatMap((r): SavedFilter[] => {
        const query = FilterQuery.safeParse(json(r.query) ?? {});
        return query.success ? [{ id: String(r.id), name: String(r.name), icon: r.icon as string | null, query: query.data, sortKey: String(r.sort_key) }] : [];
      })
      .sort(byKey),
    collaborators: withSharedCollaborators(
      collaborators.map((r) => ({ id: String(r.id), name: String(r.name), email: (r.email as string | null) ?? null, acronym: (r.acronym as string | null) ?? null, archivedAt: (r.archived_at as string | null) ?? null, workspaceIds: tagWorkspaceIds(r.workspace_ids) })),
      sharedPeople.map(scopeCollaborator),
    ),
    tasks,
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

const WATCHED = ['workspaces', 'lists', 'tags', 'saved_filters', 'collaborators', 'scope_collaborators', 'scope_tags', 'tasks', 'task_tags', 'task_completions', 'profiles'];

let data: AppData = EMPTY;
const listeners = new Set<() => void>();
let started = false;
let unwatch: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;
let loading = false;
let dirty = false;
/** Bufor zadań silnika bieżącej sesji (nowy po zmianie konta). */
let cache: { engine: SyncEngine; tasks: TaskCache } | null = null;

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
      const engine = await localEngine();
      if (cache?.engine !== engine) cache = { engine, tasks: createTaskCache((sql, params) => engine.db.all(sql, params)) };
      data = await loadAppData(engine, cache.tasks);
      perfLog('dane widoków', Date.now() - started, `${data.tasks.length} zadań`);
      listeners.forEach((l) => l());
      perfEnd('ukończenie');
      perfEnd('cofnij');
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
      unwatch = engine.watch(WATCHED, (changes) => {
        if (cache?.engine === engine) cache.tasks.note(changes);
        refreshAppData();
      });
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
 * Dane dla przypomnień i widżetu bez drugiego pełnego odczytu: gdy na ekranie działa magazyn —
 * jego wynik (po zaległym odświeżeniu); bez ekranów albo w tle (timery JS stoją) — odczyt z bazy.
 * Przy starcie trzy równoległe odczyty 10 000 zadań (ekrany, przypomnienia, widżet) wydłużały
 * odczyt dla „Dziś” z ~0,4 do ~0,9 s (`docs/WYDAJNOSC.md`).
 */
export async function sharedAppData(engine: SyncEngine): Promise<AppData> {
  if (!started || AppState.currentState !== 'active' || (data.loaded && engine.userId !== data.userId)) return loadAppData(engine);
  if (data.loaded && !loading && !timer) return data;
  return new Promise<AppData>((resolve) => {
    const fallback = setTimeout(() => {
      off();
      resolve(loadAppData(engine));
    }, 10_000);
    const off = subscribe(() => {
      if (!data.loaded) return;
      clearTimeout(fallback);
      off();
      resolve(data);
    });
  });
}

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
/** Ikona udostępnienia listy (core `listShareBadge`) — `null` w przestrzeni nikomu nieudostępnionej. */
export function useListShareBadge(listId: string | undefined): ListShareBadge | null {
  const data = useAppData();
  return useMemo(() => {
    const list = data.lists.find((l) => l.id === listId);
    const space = data.workspaces.find((w) => w.id === list?.workspaceId);
    return list ? listShareBadge(space?.role, list.guestAccess, space?.members) : null;
  }, [data.lists, data.workspaces, listId]);
}

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
