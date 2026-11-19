"use client";

/**
 * Powłoka aplikacji (MVP-2): pasek boczny z widokami stałymi i licznikami, przełącznik przestrzeni
 * z trybem „Wszystkie” (M2), listy i projekty przestrzeni, treść według `#` adresu.
 */
import { applyFilter, BOARD_BY, bulkTaskOps, isEmptyFilter, isOpen, plural, selectInbox, selectToday, type BoardBy, type BulkAction, type FilterQuery, type LocalDate, type ProfileSettings, type ViewContext } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { useAppData, useToday, type List } from "@/lib/app-data";
import { GOOGLE_RETURN_PARAM } from "@/lib/calendars";
import { routeHash, useRoute, type Route } from "@/lib/route";

import { AppEnvProvider, useAppEnv, visibleTaskIds } from "./app-env";
import { Board } from "./board";
import { CalendarScreen } from "./calendar";
import { CommandPalette, ShortcutsDialog, type PaletteMode, type PalettePick } from "./command-palette";
import { FilterBar } from "./filter-bar";
import { filterCount, SavedFilterView, SaveFilter, TagView } from "./filter-views";
import { QuickAddDialog } from "./quick-add";
import { TaskPanel } from "./task-panel";
import { TaskActionsProvider, useTaskActions } from "./task-item";
import { Select, Splash } from "./ui";
import { InboxView, ListView, TodayView, TrashView, UpcomingView } from "./views";

const WORKSPACE_KEY = "tp-workspace";
const ALL = "all";

// Wybrana przestrzeń — per przeglądarka (jak ostatni widok), nie synchronizowana.
const workspaceListeners = new Set<() => void>();
function readWorkspace(): string {
  try {
    return localStorage.getItem(WORKSPACE_KEY) ?? ALL;
  } catch {
    return ALL;
  }
}
function writeWorkspace(id: string) {
  try {
    localStorage.setItem(WORKSPACE_KEY, id);
  } catch {
    // Bez pamięci przeglądarki wybór działa do odświeżenia.
  }
  workspaceListeners.forEach((l) => l());
}
const subscribeWorkspace = (listener: () => void) => {
  workspaceListeners.add(listener);
  return () => void workspaceListeners.delete(listener);
};

/** Pole tekstowe albo edytor — skróty jednoklawiszowe wtedy nie działają. */
const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function Shell({
  store,
  userId,
  settings,
  manage,
  settingsView,
}: {
  store: TabStore;
  userId: string;
  settings: ProfileSettings;
  manage: ReactNode;
  settingsView: ReactNode;
}) {
  const today = useToday(settings.timeZone);
  const data = useAppData(store, today);
  const [route, navigate] = useRoute();
  const stored = useSyncExternalStore(subscribeWorkspace, readWorkspace, () => ALL);
  const workspaceId = stored !== ALL && data.workspaces.some((w) => w.id === stored) ? stored : null;
  const [menuOpen, setMenuOpen] = useState(false);
  // Skrót „Szybkie dodawanie” z ikony aplikacji: `/?quick=1`.
  const [quickOpen, setQuickOpen] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("quick"));
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("quick")) {
      url.searchParams.delete("quick");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    // Powrót z ekranu zgody Google (`lib/calendars.ts`) → ustawienia z listą kalendarzy.
    if (url.searchParams.has(GOOGLE_RETURN_PARAM)) {
      url.searchParams.delete(GOOGLE_RETURN_PARAM);
      url.searchParams.delete("account");
      url.hash = "#/settings";
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
  }, []);
  // Klik w przypomnienie przy zamkniętej karcie: `/?task=<id>` (Service Worker, M8).
  const [openTaskId, setOpenTaskId] = useState<string | null>(() => (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("task") : null));
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("task")) {
      url.searchParams.delete("task");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "open-task" && typeof event.data.taskId === "string") setOpenTaskId(event.data.taskId);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);

  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const select = useCallback((id: string, mode: "only" | "toggle" | "range" = "only") => {
    setSelected((current) => {
      if (mode === "toggle") return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      if (mode === "range" && anchor.current) {
        const ids = visibleTaskIds();
        const [a, b] = [ids.indexOf(anchor.current), ids.indexOf(id)].sort((x, y) => x - y);
        if (a! >= 0 && b! >= 0) return ids.slice(a, b! + 1);
      }
      return [id];
    });
    if (mode !== "range") anchor.current = id;
  }, []);

  const ctx: ViewContext = useMemo(() => ({ today, timeZone: settings.timeZone, workspaceId, firstDayOfWeek: settings.firstDayOfWeek }), [today, settings.timeZone, workspaceId, settings.firstDayOfWeek]);

  // Nowe zadania z widoków zbiorczych: Inbox bieżącej przestrzeni, w trybie „Wszystkie” — pierwszej.
  const targetInbox = data.lists.find((l) => l.kind === "inbox" && l.workspaceId === (workspaceId ?? data.workspaces[0]?.id));

  const counts = useMemo(() => {
    const inboxIds = new Set(data.lists.filter((l) => l.kind === "inbox").map((l) => l.id));
    const view = selectToday(data.tasks, ctx, { completed: "hidden" });
    const perList = new Map<string, number>();
    const perTag = new Map<string, number>();
    for (const t of data.tasks) {
      if (!isOpen(t) || t.kind !== "task") continue;
      perList.set(t.listId, (perList.get(t.listId) ?? 0) + 1);
      if (!ctx.workspaceId || t.workspaceId === ctx.workspaceId) for (const id of t.tagIds) perTag.set(id, (perTag.get(id) ?? 0) + 1);
    }
    const perFilter = new Map(data.savedFilters.map((f) => [f.id, filterCount(data.tasks, f.query, ctx)]));
    return { inbox: selectInbox(data.tasks, inboxIds, ctx).length, today: view.overdue.length + view.today.length, overdue: view.overdue.length, perList, perTag, perFilter };
  }, [data.tasks, data.lists, data.savedFilters, ctx]);

  // Kryterium kolumn tablicy `#/board` — per przeglądarka (tablica listy ma je w `view_prefs`).
  const [boardBy, setBoardByState] = useState<BoardBy>(() => {
    try {
      const value = localStorage.getItem("tp-board-by");
      return value && value in BOARD_BY ? (value as BoardBy) : "status";
    } catch {
      return "status";
    }
  });
  const setBoardBy = (by: BoardBy) => {
    setBoardByState(by);
    try {
      localStorage.setItem("tp-board-by", by);
    } catch {
      // Bez pamięci przeglądarki — do odświeżenia.
    }
  };

  // Filtr doraźny (chipy) nad Inbox / Dziś / Nadchodzące / listą — do zmiany widoku.
  const [adhoc, setAdhoc] = useState<FilterQuery>({});

  // Nowy widok: od góry, a na wąskim ekranie menu się chowa.
  const hash = routeHash(route);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    void Promise.resolve().then(() => {
      setMenuOpen(false);
      setSelected([]);
      setAdhoc({});
    });
  }, [hash]);

  if (!data.loaded) return <Splash text="Wczytywanie zadań…" />;

  const list = route.view === "list" ? data.lists.find((l) => l.id === route.id) : undefined;
  const tag = route.view === "tag" ? data.tags.find((t) => t.id === route.id) : undefined;
  const savedFilter = route.view === "filter" ? data.savedFilters.find((f) => f.id === route.id) : undefined;
  const filterable = ["inbox", "today", "upcoming", "list", "board"].includes(route.view);
  const wide = route.view === "board" || route.view === "calendar" || list?.prefs.view === "kanban";
  // Widoki dostają zadania po filtrze doraźnym; liczniki paska bocznego liczą się z pełnych danych.
  const viewData = filterable && !isEmptyFilter(adhoc) ? { ...data, tasks: applyFilter(data.tasks, adhoc, today) } : data;
  const toolbar = filterable ? (
    <FilterBar query={adhoc} onChange={setAdhoc} hide={route.view === "list" ? ["lists"] : []}>
      <SaveFilter query={adhoc} onSaved={(id) => navigate({ view: "filter", id })} />
    </FilterBar>
  ) : null;
  const props = { data: viewData, ctx, targetInbox, toolbar };
  const body =
    route.view === "inbox" ? (
      <InboxView {...props} />
    ) : route.view === "today" ? (
      <TodayView {...props} />
    ) : route.view === "upcoming" ? (
      <UpcomingView {...props} />
    ) : route.view === "board" ? (
      <>
        <header className="mb-2">
          <h1 className="text-xl font-semibold">Tablica</h1>
          <p className="text-sm text-[var(--muted)]">{workspaceId ? data.workspaces.find((w) => w.id === workspaceId)?.name : "Wszystkie przestrzenie"} — zawęź chipami filtrów</p>
        </header>
        {toolbar}
        <Board
          data={data}
          ctx={ctx}
          tasks={viewData.tasks.filter((t) => !workspaceId || t.workspaceId === workspaceId)}
          by={boardBy}
          onBy={setBoardBy}
          listId={targetInbox?.id}
          showList
        />
      </>
    ) : route.view === "calendar" ? (
      <>
        <h1 className="sr-only">Kalendarz</h1>
        <CalendarScreen data={data} ctx={ctx} settings={settings} />
      </>
    ) : route.view === "manage" ? (
      manage
    ) : route.view === "settings" ? (
      settingsView
    ) : route.view === "trash" ? (
      <TrashView data={data} store={store} />
    ) : list ? (
      <ListView key={list.id} data={viewData} ctx={ctx} list={list} store={store} toolbar={toolbar} />
    ) : tag ? (
      <TagView key={tag.id} data={data} ctx={ctx} tag={tag} navigate={navigate} />
    ) : savedFilter ? (
      <SavedFilterView key={savedFilter.id} data={data} ctx={ctx} filter={savedFilter} navigate={navigate} />
    ) : route.view === "tag" || route.view === "filter" ? (
      <p className="py-6 text-sm text-[var(--muted)]">{route.view === "tag" ? "Ten tag został usunięty." : "Ten filtr został usunięty."}</p>
    ) : (
      <p className="py-6 text-sm text-[var(--muted)]">Ta lista nie istnieje albo jest zarchiwizowana.</p>
    );

  const content = body;

  const workspaces = workspaceId ? data.workspaces.filter((w) => w.id === workspaceId) : data.workspaces;
  // Okno szybkiego dodawania dodaje tam, skąd je wywołano (lista / „Dziś” z dzisiejszym terminem).
  const quickDefaults = list ? { listId: list.id } : route.view === "today" ? { listId: targetInbox?.id, dueDate: today } : { listId: targetInbox?.id };

  return (
    <AppEnvProvider value={{ store, data, userId, timeZone: settings.timeZone, today, workspaceId, openTask: setOpenTaskId, openTaskId, selectedIds, select }}>
      <TaskActionsProvider store={store} timeZone={settings.timeZone} tasks={data.tasks}>
        <ReminderToasts />
        <Keyboard
          blocked={quickOpen || palette !== null || shortcutsOpen}
          selected={selected}
          setSelected={setSelected}
          navigate={navigate}
          openQuick={() => setQuickOpen(true)}
          openPalette={setPalette}
          openShortcuts={() => setShortcutsOpen(true)}
        />
        <div className="flex min-h-0 flex-1">
          <button
            type="button"
            className="fixed right-4 bottom-4 z-20 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white shadow-lg md:hidden"
            aria-expanded={menuOpen}
            aria-controls="sidebar"
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? "Zamknij" : "Menu"}
          </button>
          <aside
            id="sidebar"
            aria-label="Nawigacja"
            className={`${menuOpen ? "fixed inset-0 z-10 block" : "hidden"} w-full shrink-0 overflow-y-auto border-r border-[var(--line)] bg-[var(--surface)] p-3 text-sm md:static md:block md:w-64`}
          >
            <Select
              aria-label="Przestrzeń"
              value={workspaceId ?? ALL}
              onChange={(e) => writeWorkspace(e.target.value)}
              className="mb-3 w-full"
            >
              <option value={ALL}>Wszystkie przestrzenie</option>
              {data.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
            <button
              type="button"
              onClick={() => setQuickOpen(true)}
              title="Szybkie dodawanie (Q, Ctrl+Spacja)"
              className="mb-3 flex w-full items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 font-medium text-white hover:opacity-90"
            >
              <span aria-hidden>+</span> Dodaj zadanie
              <kbd className="ml-auto rounded bg-white/20 px-1.5 text-xs font-normal">Q</kbd>
            </button>
            <nav className="flex flex-col gap-0.5">
              <NavItem route={{ view: "inbox" }} current={route} navigate={navigate} icon="📥" label="Inbox" count={counts.inbox} />
              <NavItem route={{ view: "today" }} current={route} navigate={navigate} icon="☀️" label="Dziś" count={counts.today} alert={counts.overdue > 0} />
              <NavItem route={{ view: "upcoming" }} current={route} navigate={navigate} icon="📅" label="Nadchodzące" />
              <NavItem route={{ view: "board" }} current={route} navigate={navigate} icon="▦" label="Tablica" />
              <NavItem route={{ view: "calendar" }} current={route} navigate={navigate} icon="🗓" label="Kalendarz" />
            </nav>
            {workspaces.map((w) => (
              <WorkspaceLists key={w.id} name={w.name} color={w.color} lists={data.lists.filter((l) => l.workspaceId === w.id && l.kind !== "inbox")} counts={counts.perList} route={route} navigate={navigate} />
            ))}
            {data.savedFilters.length ? (
              <SidebarSection title="Filtry">
                {data.savedFilters.map((f) => (
                  <NavItem key={f.id} route={{ view: "filter", id: f.id }} current={route} navigate={navigate} icon="⚲" label={f.name} count={counts.perFilter.get(f.id)} />
                ))}
              </SidebarSection>
            ) : null}
            {data.tags.length ? (
              <SidebarSection title="Tagi">
                {data.tags.map((t) => (
                  <NavItem key={t.id} route={{ view: "tag", id: t.id }} current={route} navigate={navigate} color={t.color} label={`@${t.name}`} count={counts.perTag.get(t.id)} />
                ))}
              </SidebarSection>
            ) : null}
            <nav className="mt-4 flex flex-col gap-0.5 border-t border-[var(--line)] pt-3">
              <NavItem route={{ view: "manage" }} current={route} navigate={navigate} icon="🗂️" label="Przestrzenie i listy" />
              <NavItem route={{ view: "trash" }} current={route} navigate={navigate} icon="🗑️" label="Kosz" />
              <NavItem route={{ view: "settings" }} current={route} navigate={navigate} icon="⚙️" label="Ustawienia" />
            </nav>
          </aside>
          <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
            <div className={`mx-auto w-full p-4 pb-20 sm:p-6 ${wide ? "" : "max-w-3xl"}`}>{content}</div>
          </main>
          {openTaskId ? <TaskPanel key={openTaskId} taskId={openTaskId} /> : null}
        </div>
        <QuickAddDialog open={quickOpen} onClose={() => setQuickOpen(false)} {...quickDefaults} />
        {palette ? (
          <PaletteHost
            mode={palette}
            setMode={setPalette}
            selected={selected}
            navigate={navigate}
            openQuick={() => setQuickOpen(true)}
            openShortcuts={() => setShortcutsOpen(true)}
            settings={settings}
          />
        ) : null}
        {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
      </TaskActionsProvider>
    </AppEnvProvider>
  );
}

const sameRoute = (a: Route, b: Route) => routeHash(a) === routeHash(b);

/** Sekcja paska bocznego zwijana kliknięciem w nagłówek (stan per przeglądarka). */
function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  const key = `tp-section-${title}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== "0";
    } catch {
      return true;
    }
  });
  return (
    <section className="mt-4">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            try {
              localStorage.setItem(key, open ? "0" : "1");
            } catch {
              // Bez pamięci przeglądarki — tylko do odświeżenia.
            }
          }}
          className="mb-1 flex w-full items-center gap-1 px-2 text-left text-xs font-semibold tracking-wide text-[var(--muted)] uppercase hover:text-[var(--foreground)]"
        >
          <span aria-hidden>{open ? "▾" : "▸"}</span> {title}
        </button>
      </h2>
      {open ? <nav className="flex flex-col gap-0.5">{children}</nav> : null}
    </section>
  );
}

function NavItem({
  route,
  current,
  navigate,
  icon,
  color,
  label,
  count,
  alert,
  project,
}: {
  route: Route;
  current: Route;
  navigate: (route: Route) => void;
  icon?: string;
  color?: string | null;
  label: string;
  count?: number;
  alert?: boolean;
  /** Projekt: znacznik w kształcie rombu (lista — kropka). */
  project?: boolean;
}) {
  const active = sameRoute(route, current);
  return (
    <a
      href={routeHash(route)}
      onClick={(e) => {
        e.preventDefault();
        navigate(route);
      }}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${active ? "bg-[var(--hover)] font-medium" : "hover:bg-[var(--hover)]"}`}
    >
      {icon ? (
        <span aria-hidden className="w-5 text-center">
          {icon}
        </span>
      ) : (
        <span aria-hidden className="flex w-5 justify-center">
          <span className={`h-2.5 w-2.5 ${project ? "rotate-45 rounded-[2px]" : "rounded-full"}`} style={{ background: color ?? "var(--muted)" }} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? <span className={`text-xs ${alert ? "font-semibold text-[var(--danger)]" : "text-[var(--muted)]"}`}>{count}</span> : null}
    </a>
  );
}

function WorkspaceLists({
  name,
  color,
  lists,
  counts,
  route,
  navigate,
}: {
  name: string;
  color: string | null;
  lists: List[];
  counts: Map<string, number>;
  route: Route;
  navigate: (route: Route) => void;
}) {
  return (
    <section className="mt-4">
      <h2 className="mb-1 flex items-center gap-2 px-2 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
        <span className="h-2 w-2 rounded-full" style={{ background: color ?? "var(--muted)" }} />
        {name}
      </h2>
      {lists.length ? (
        <nav className="flex flex-col gap-0.5">
          {lists.map((l) => (
            <NavItem key={l.id} route={{ view: "list", id: l.id }} current={route} navigate={navigate} color={l.color} label={l.name} project={l.kind === "project"} count={counts.get(l.id)} />
          ))}
        </nav>
      ) : (
        <p className="px-2 text-xs text-[var(--muted)]">Brak list</p>
      )}
    </section>
  );
}

// ── Klawiatura i polecenia ───────────────────────────────────────────────────────────────────

const GO: Record<string, Route> = { i: { view: "inbox" }, t: { view: "today" }, u: { view: "upcoming" }, k: { view: "board" }, c: { view: "calendar" } };

/** Akcja na zaznaczonych z dymkiem „Cofnij”. */
function useBulk(selected: readonly string[]) {
  const { data, today, timeZone } = useAppEnv();
  const { run, notify } = useTaskActions();
  return useCallback(
    (action: BulkAction, label: string) => {
      const tasks = data.tasks.filter((t) => selected.includes(t.id));
      if (!tasks.length) return notify("Najpierw zaznacz zadanie (klik albo J / K).");
      const { ops, undo } = bulkTaskOps(tasks, data.tasks, action, { today, now: new Date(), timeZone });
      if (!ops.length) return notify("Nic do zmiany.");
      void run(ops, { text: `${label}: ${tasks.length === 1 ? `„${tasks[0]!.title}”` : plural(tasks.length, ["zadanie", "zadania", "zadań"])}`, undo });
    },
    [data.tasks, selected, today, timeZone, run, notify],
  );
}

/** Skróty klawiszowe (M17); jednoklawiszowe nie działają w polach tekstowych ani przy otwartym oknie. */
/** Przypomnienie push przy otwartej karcie — także dymek w aplikacji (M8). */
function ReminderToasts() {
  const { notify } = useTaskActions();
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "reminder") notify(`🔔 ${event.data.title ?? "Przypomnienie"}${event.data.body ? ` — ${event.data.body}` : ""}`);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [notify]);
  return null;
}

function Keyboard({
  blocked,
  selected,
  setSelected,
  navigate,
  openQuick,
  openPalette,
  openShortcuts,
}: {
  blocked: boolean;
  selected: string[];
  setSelected: (ids: string[]) => void;
  navigate: (route: Route) => void;
  openQuick: () => void;
  openPalette: (mode: PaletteMode) => void;
  openShortcuts: () => void;
}) {
  const { openTask, openTaskId } = useAppEnv();
  const bulk = useBulk(selected);
  const pendingG = useRef(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.code === "Space") {
        event.preventDefault();
        return openQuick();
      }
      if (ctrl && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!blocked) openPalette("all");
        return;
      }
      if (blocked || ctrl || event.altKey || isTyping(event.target)) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      // Sekwencja G → I / T / U, najwyżej sekundę po G.
      if (Date.now() - pendingG.current < 1000 && GO[key]) {
        pendingG.current = 0;
        event.preventDefault();
        return navigate(GO[key]);
      }
      pendingG.current = 0;

      // Shift — rozszerzenie zaznaczenia od pierwszego zaznaczonego (zakres w kolejności na ekranie).
      const move = (delta: number, extend: boolean) => {
        const ids = visibleTaskIds();
        if (!ids.length) return;
        const last = selected.at(-1);
        const at = last ? ids.indexOf(last) : -1;
        const next = ids[at === -1 ? (delta > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, at + delta))]!;
        const anchor = extend && selected.length ? ids.indexOf(selected[0]!) : -1;
        if (anchor >= 0) {
          const end = ids.indexOf(next);
          const range = anchor <= end ? ids.slice(anchor, end + 1) : ids.slice(end, anchor + 1).reverse();
          setSelected(range);
        } else setSelected([next]);
        if (openTaskId) openTask(next);
        document.querySelector(`main [data-task-id="${next}"]`)?.scrollIntoView({ block: "nearest" });
      };

      const handlers: Record<string, () => void> = {
        g: () => void (pendingG.current = Date.now()),
        q: openQuick,
        "/": () => openPalette("search"),
        "?": openShortcuts,
        j: () => move(1, event.shiftKey),
        k: () => move(-1, event.shiftKey),
        Enter: () => openTask(selected.at(-1)!),
        Escape: () => (openTaskId ? openTask(null) : setSelected([])),
        e: () => bulk({ kind: "complete" }, "Ukończono"),
        t: () => bulk({ kind: "today" }, "Na dziś"),
        m: () => bulk({ kind: "tomorrow" }, "Na jutro"),
        d: () => (selected.length ? openPalette("date") : bulk({ kind: "today" }, "")),
        Delete: () => bulk({ kind: "delete" }, "W koszu"),
        "1": () => bulk({ kind: "priority", priority: 1 }, "Priorytet krytyczny"),
        "2": () => bulk({ kind: "priority", priority: 2 }, "Priorytet wysoki"),
        "3": () => bulk({ kind: "priority", priority: 3 }, "Priorytet średni"),
        "4": () => bulk({ kind: "priority", priority: 4 }, "Priorytet niski"),
      };
      const handler = handlers[key];
      // Enter bez zaznaczenia zostaje przyciskom i linkom.
      if (!handler || (key === "Enter" && !selected.length)) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [blocked, selected, setSelected, navigate, openQuick, openPalette, openShortcuts, openTask, openTaskId, bulk]);

  return null;
}

/** Paleta i wykonanie wybranego polecenia. */
function PaletteHost({
  mode,
  setMode,
  selected,
  navigate,
  openQuick,
  openShortcuts,
  settings,
}: {
  mode: PaletteMode;
  setMode: (mode: PaletteMode | null) => void;
  selected: string[];
  navigate: (route: Route) => void;
  openQuick: () => void;
  openShortcuts: () => void;
  settings: ProfileSettings;
}) {
  const { data, store, userId, openTask, select } = useAppEnv();
  const { notify } = useTaskActions();
  const bulk = useBulk(selected);
  const close = () => setMode(null);
  const then = (work: () => void) => {
    close();
    work();
  };

  const onPick = (pick: PalettePick) => {
    if (pick.kind === "priority") return then(() => bulk({ kind: "priority", priority: pick.priority }, "Priorytet"));
    if (pick.kind === "move") return then(() => bulk({ kind: "move", listId: pick.listId }, `Przeniesiono do „${data.lists.find((l) => l.id === pick.listId)?.name}”`));
    if (pick.kind === "date") return then(() => bulk({ kind: "date", date: pick.date as LocalDate }, "Nowy termin"));
    if (pick.kind === "workspace") return then(() => writeWorkspace(pick.workspaceId ?? ALL));

    const { item } = pick;
    if (item.kind === "task") {
      const task = data.tasks.find((t) => t.id === item.id);
      return then(() => {
        if (!task) return;
        navigate({ view: "list", id: task.listId });
        // Po zmianie widoku (który czyści zaznaczenie) — zaznacz i otwórz zadanie.
        setTimeout(() => {
          select(task.id);
          openTask(task.id);
          document.querySelector(`main [data-task-id="${task.id}"]`)?.scrollIntoView({ block: "center" });
        }, 50);
      });
    }
    if (item.kind === "list") return then(() => navigate({ view: "list", id: item.id.slice("list:".length) }));
    if (item.kind === "workspace") return then(() => writeWorkspace(item.id.slice("workspace:".length)));
    if (item.kind === "tag") return then(() => navigate({ view: "tag", id: item.id.slice("tag:".length) }));
    if (item.kind === "filter") return then(() => navigate({ view: "filter", id: item.id.slice("filter:".length) }));

    const actions: Record<string, () => void> = {
      "view.inbox": () => then(() => navigate({ view: "inbox" })),
      "view.today": () => then(() => navigate({ view: "today" })),
      "view.upcoming": () => then(() => navigate({ view: "upcoming" })),
      "view.kanban": () => then(() => navigate({ view: "board" })),
      "view.calendar": () => then(() => navigate({ view: "calendar" })),
      "task.quick_add": () => then(openQuick),
      "task.complete": () => then(() => bulk({ kind: "complete" }, "Ukończono")),
      "task.today": () => then(() => bulk({ kind: "today" }, "Na dziś")),
      "task.tomorrow": () => then(() => bulk({ kind: "tomorrow" }, "Na jutro")),
      "task.delete": () => then(() => bulk({ kind: "delete" }, "W koszu")),
      "task.priority": () => setMode("priority"),
      "task.move": () => setMode("move"),
      "task.date": () => setMode("date"),
      "workspace.switch": () => setMode("workspace"),
      "list.new_project": () => then(() => navigate({ view: "manage" })),
      "app.search": () => setMode("search"),
      "app.palette": () => setMode("all"),
      "app.shortcuts": () => then(openShortcuts),
      "app.theme": () =>
        then(() => {
          const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
          void store.mutate("profiles", userId, { settings: { ...settings, theme, onboarded: true } }).catch((e: unknown) => notify(String(e)));
        }),
    };
    actions[item.id]?.();
  };

  return <CommandPalette key={mode} mode={mode} onClose={close} onPick={onPick} />;
}
