"use client";

/**
 * Powłoka aplikacji (MVP-2): pasek boczny z widokami stałymi i licznikami, przełącznik przestrzeni
 * z trybem „Wszystkie” (M2), listy i projekty przestrzeni, treść według `#` adresu.
 */
import { applyFilter, BOARD_BY, bulkTaskOps, sharedText, habitsForDay, isEmptyFilter, isOpen, listShareBadge, plural, selectInbox, selectToday, tagsForWorkspace, type BoardBy, type BulkAction, type FilterQuery, type ListShareBadge, type LocalDate, type ProfileSettings, type ViewContext } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { useAppData, useToday, type List, type Workspace } from "@/lib/app-data";
import { GOOGLE_RETURN_PARAM } from "@/lib/calendars";
import { DEFAULT_ROUTE, routeHash, useRoute, type Route } from "@/lib/route";

import { AppEnvProvider, useAppEnv, visibleTaskIds } from "./app-env";
import { Board } from "./board";
import { CalendarScreen } from "./calendar";
import { DayPlan } from "./day-plan";
import { CommandPalette, ShortcutsDialog, type PaletteMode, type PalettePick } from "./command-palette";
import { TaskExportButton } from "./export";
import { FilterBar } from "./filter-bar";
import { FocusIndicator, FocusProvider, FocusScreen, useFocus } from "./focus";
import { DailyReview, ReviewNudge, WeeklyReview } from "./review";
import { filterCount, SavedFilterView, SaveFilter, TagView } from "./filter-views";
import { AttachmentsProvider } from "./attachments";
import { CollaboratorsView } from "./collaborators";
import { HabitDetail, HabitNotificationActions, HabitsView } from "./habits";
import { QuickAddDialog } from "./quick-add";
import { TaskPanel } from "./task-panel";
import { TaskActionsProvider, useTaskActions } from "./task-item";
import { Select, Splash } from "./ui";
import { InboxView, ListView, TodayView, TrashView, UpcomingView } from "./views";

// Oś czasu (SVAR Gantt) — osobny kawałek kodu, dociągany w wolnej chwili po starcie i przy pierwszym otwarciu.
const loadTimeline = () => import("./timeline");
const TimelineScreen = dynamic(() => loadTimeline().then((m) => m.TimelineScreen), { ssr: false, loading: () => <Splash text="Wczytywanie osi czasu…" /> });

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
  // Pasek boczny zwinięty do ikon (per przeglądarka); `peek` = rozwinięty chwilowo nad treścią, chowa się po wyborze.
  const [collapsed, setCollapsedState] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [peek, setPeek] = useState(false);
  const setCollapsed = useCallback((value: boolean) => {
    setCollapsedState(value);
    setPeek(false);
    try {
      localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
    } catch {
      // Bez pamięci przeglądarki — do odświeżenia.
    }
  }, []);
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!peek) return;
    const onDown = (e: PointerEvent) => {
      if (!asideRef.current?.contains(e.target as Node)) setPeek(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPeek(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [peek]);
  // Etap 10: udostępnienie (Web Share Target) i zakładka: `/?share_title=…&share_text=…&share_url=…`.
  const [shared, setShared] = useState(() => (typeof window !== "undefined" ? readShare(new URLSearchParams(window.location.search)) : null));
  // Skrót „Szybkie dodawanie” z ikony aplikacji: `/?quick=1`.
  const [quickOpen, setQuickOpen] = useState(() => typeof window !== "undefined" && (new URLSearchParams(window.location.search).has("quick") || shared !== null));
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("quick") || SHARE_PARAMS.some((p) => url.searchParams.has(p))) {
      url.searchParams.delete("quick");
      for (const p of SHARE_PARAMS) url.searchParams.delete(p);
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
  // Klik poza panelem zadania zamyka go — po obsłudze kliknięcia (zamknięcie przy `pointerdown` przesunęłoby
  // układ pod kursorem), chyba że to kliknięcie otworzyło inne zadanie. Bez zamykania: wiersze i karty zadań
  // (zaznaczanie, odhaczanie, przeciąganie), okna dialogowe, komunikat z „Cofnij”, pasek boczny (zamyka sam)
  // i pasek przewijania.
  const openTaskRef = useRef(openTaskId);
  useLayoutEffect(() => {
    openTaskRef.current = openTaskId;
  });
  useEffect(() => {
    let pressed: { id: string | null; outside: boolean } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      const id = openTaskRef.current;
      const scrollbar = !!target && target.scrollHeight > target.clientHeight && e.offsetX > target.clientWidth;
      pressed = {
        id,
        outside:
          !!id &&
          !!target?.isConnected &&
          e.button === 0 &&
          !scrollbar &&
          !target.closest('aside[aria-label="Zadanie"], [data-task-panel], #sidebar, [role=dialog], [role=status], [data-task-id], [data-card]'),
      };
    };
    const onClick = () => {
      const p = pressed;
      pressed = null;
      if (p?.outside && openTaskRef.current === p.id) setOpenTaskId(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick);
    };
  }, []);
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
    const habits = habitsForDay(data.tasks, data.habitCompletions, ctx.today, ctx.today, ctx.workspaceId).filter((h) => !h.settled).length;
    return { inbox: selectInbox(data.tasks, inboxIds, ctx).length, today: view.overdue.length + view.today.length, overdue: view.overdue.length, habits, perList, perTag, perFilter };
  }, [data.tasks, data.lists, data.savedFilters, data.habitCompletions, ctx]);

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

  // Filtr doraźny (chipy) nad Inbox / Dziś / Nadchodzące — do zmiany widoku; lista pamięta swój w `view_prefs.filter`.
  const [adhoc, setAdhoc] = useState<FilterQuery>({});

  // Nowy widok: od góry, a na wąskim ekranie menu się chowa.
  const hash = routeHash(route);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    void Promise.resolve().then(() => {
      setMenuOpen(false);
      setPeek(false);
      setSelected([]);
      setAdhoc({});
    });
  }, [hash]);

  // „Wyjdź” z trybu skupienia wraca do ostatniego innego widoku.
  const [lastRoute, setLastRoute] = useState<Route>(DEFAULT_ROUTE);
  if (route.view !== "focus" && route.view !== "review" && routeHash(route) !== routeHash(lastRoute)) setLastRoute(route);

  // Oś czasu zostaje zamontowana po pierwszym otwarciu — powrót do niej bez ponownego rysowania.
  const [timelineOpened, setTimelineOpened] = useState(false);
  if (route.view === "timeline" && !timelineOpened) setTimelineOpened(true);
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 2000));
    idle(() => void loadTimeline());
  }, []);

  if (!data.loaded) return <Splash text="Wczytywanie zadań…" />;

  const list = route.view === "list" ? data.lists.find((l) => l.id === route.id) : undefined;
  const tag = route.view === "tag" ? data.tags.find((t) => t.id === route.id) : undefined;
  const savedFilter = route.view === "filter" ? data.savedFilters.find((f) => f.id === route.id) : undefined;
  const filterable = ["inbox", "today", "upcoming", "list", "board"].includes(route.view);
  const wide = route.view === "board" || route.view === "calendar" || route.view === "timeline" || list?.prefs.view === "kanban";
  // Widoki dostają zadania po filtrze doraźnym; liczniki paska bocznego liczą się z pełnych danych.
  const query = list ? (list.prefs.filter ?? {}) : adhoc;
  const viewData = filterable && !isEmptyFilter(query) ? { ...data, tasks: applyFilter(data.tasks, query, today) } : data;
  const toolbar = !filterable ? null : list ? (
    <ListFilterBar list={list} store={store} onSaved={(id) => navigate({ view: "filter", id })} />
  ) : (
    <FilterBar query={adhoc} onChange={setAdhoc}>
      <SaveFilter query={adhoc} onSaved={(id) => navigate({ view: "filter", id })} />
    </FilterBar>
  );
  const props = { data: viewData, ctx, targetInbox, toolbar };
  const boardTasks = route.view === "board" ? viewData.tasks.filter((t) => !workspaceId || t.workspaceId === workspaceId) : [];
  const body =
    route.view === "inbox" ? (
      <InboxView {...props} />
    ) : route.view === "today" ? (
      <TodayView {...props} aside={<DayPlan data={data} ctx={ctx} settings={settings} />} />
    ) : route.view === "upcoming" ? (
      <UpcomingView {...props} />
    ) : route.view === "board" ? (
      <>
        <header className="tp-view-header mb-2 flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold">Tablica</h1>
            <p className="text-sm text-[var(--muted)]">{workspaceId ? data.workspaces.find((w) => w.id === workspaceId)?.name : "Wszystkie przestrzenie"} — zawęź chipami filtrów</p>
          </div>
          <TaskExportButton title="Tablica" data={data} ctx={ctx} count={boardTasks.length} rows={() => boardTasks.map((task) => ({ task }))} />
        </header>
        {toolbar}
        <Board
          data={data}
          ctx={ctx}
          tasks={boardTasks}
          by={boardBy}
          onBy={setBoardBy}
          listId={targetInbox?.id}
          showList
          addLabel={targetInbox ? `Dodaj do Inboxu („${data.workspaces.find((w) => w.id === targetInbox.workspaceId)?.name ?? ""}”)` : undefined}
        />
      </>
    ) : route.view === "calendar" ? (
      <>
        <h1 className="sr-only">Kalendarz</h1>
        <CalendarScreen data={data} ctx={ctx} settings={settings} />
      </>
    ) : route.view === "habits" ? (
      <HabitsView data={data} ctx={ctx} targetInbox={targetInbox} navigate={navigate} />
    ) : route.view === "habit" ? (
      <HabitDetail key={route.id} id={route.id} data={data} ctx={ctx} navigate={navigate} />
    ) : route.view === "timeline" ? null : route.view === "focus" && !settings.focus.enabled ? (
      <p className="p-6 text-sm text-[var(--muted)]" data-testid="focus-disabled">
        Tryb skupienia jest wyłączony — włącz go w <a href="#/settings" className="text-[var(--accent)] underline">Ustawieniach</a>.
      </p>
    ) : route.view === "focus" ? (
      <FocusScreen key={route.id ?? ""} taskId={route.id ?? null} ctx={ctx} onExit={() => navigate(lastRoute)} navigate={navigate} />
    ) : route.view === "review" ? (
      route.id === "weekly" ? (
        <WeeklyReview ctx={ctx} onExit={() => navigate(lastRoute)} navigate={navigate} />
      ) : (
        <DailyReview ctx={ctx} settings={settings} onExit={() => navigate(lastRoute)} navigate={navigate} />
      )
    ) : route.view === "manage" ? (
      manage
    ) : route.view === "settings" ? (
      settingsView
    ) : route.view === "trash" ? (
      <TrashView data={data} store={store} />
    ) : route.view === "people" ? (
      <CollaboratorsView />
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

  const content = (
    <>
      {body}
      {timelineOpened ? (
        <div hidden={route.view !== "timeline"}>
          <TimelineScreen data={data} ctx={ctx} active={route.view === "timeline"} />
        </div>
      ) : null}
    </>
  );

  const workspaces = workspaceId ? data.workspaces.filter((w) => w.id === workspaceId) : data.workspaces;
  // „Wszystkie przestrzenie”: górny Inbox to suma, więc Inbox każdej przestrzeni stoi też na czele jej sekcji.
  // Przy jednej przestrzeni górny Inbox jest właśnie nim — bez powtórki.
  const sectionLists = (id: string) => {
    const own = data.lists.filter((l) => l.workspaceId === id);
    const inbox = workspaceId ? [] : own.filter((l) => l.kind === "inbox");
    return [...inbox, ...own.filter((l) => l.kind !== "inbox")];
  };
  // Tagi przypisane do innych przestrzeni chowają się (otwarty zostaje do wyjścia z jego widoku).
  const sidebarTags = tagsForWorkspace(data.tags, workspaceId, route.view === "tag" ? [route.id] : []);
  const mainNav: NavEntry[] = [
    { route: { view: "inbox" }, icon: "📥", label: "Inbox", count: counts.inbox },
    { route: { view: "today" }, icon: "☀️", label: "Dziś", count: counts.today, alert: counts.overdue > 0 },
    { route: { view: "upcoming" }, icon: "📅", label: "Nadchodzące" },
    { route: { view: "board" }, icon: "▦", label: "Tablica" },
    { route: { view: "calendar" }, icon: "🗓", label: "Kalendarz" },
    { route: { view: "timeline" }, icon: "📊", label: "Oś czasu" },
    { route: { view: "habits" }, icon: "🌱", label: "Nawyki", count: counts.habits || undefined },
  ];
  const bottomNav: NavEntry[] = [
    { route: { view: "manage" }, icon: "🗂️", label: "Przestrzenie i listy" },
    { route: { view: "people" }, icon: "👥", label: "Współpracownicy" },
    { route: { view: "review", id: "daily" }, icon: "🧭", label: "Przegląd dnia" },
    { route: { view: "review", id: "weekly" }, icon: "🗒️", label: "Przegląd tygodnia" },
    { route: { view: "trash" }, icon: "🗑️", label: "Kosz" },
  ];
  const rail = collapsed && !peek;
  const openQuickFromSidebar = () => {
    setPeek(false);
    setQuickOpen(true);
  };
  const sideButton = "hidden shrink-0 rounded-md px-2 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--foreground)] md:block";
  // Okno szybkiego dodawania dodaje tam, skąd je wywołano (lista / „Dziś” z dzisiejszym terminem).
  const quickDefaults = list ? { listId: list.id } : route.view === "today" ? { listId: targetInbox?.id, dueDate: today } : { listId: targetInbox?.id };

  return (
    <AppEnvProvider value={{ store, data, userId, timeZone: settings.timeZone, settings, today, workspaceId, openTask: setOpenTaskId, openTaskId, selectedIds, select }}>
      <TaskActionsProvider store={store} timeZone={settings.timeZone} tasks={data.tasks}>
        <AttachmentsProvider store={store} userId={userId}>
        <FocusProvider store={store} userId={userId} settings={settings}>
        <ReminderToasts />
        <HabitNotificationActions />
        <Keyboard
          blocked={quickOpen || palette !== null || shortcutsOpen || route.view === "focus" || route.view === "review"}
          selected={selected}
          setSelected={setSelected}
          navigate={navigate}
          openQuick={() => setQuickOpen(true)}
          openPalette={setPalette}
          openShortcuts={() => setShortcutsOpen(true)}
          toggleSidebar={() => setCollapsed(!collapsed)}
        />
        <div className="relative flex min-h-0 flex-1">
          {route.view === "focus" ? null : (
          <button
            type="button"
            className="fixed right-4 bottom-4 z-20 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white shadow-lg md:hidden"
            aria-expanded={menuOpen}
            aria-controls="sidebar"
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? "Zamknij" : "Menu"}
          </button>
          )}
          {collapsed && peek && route.view !== "focus" ? <div aria-hidden className="hidden w-14 shrink-0 border-r border-[var(--line)] bg-[var(--surface)] md:block" /> : null}
          <aside
            id="sidebar"
            ref={asideRef}
            aria-label="Nawigacja"
            className={`${menuOpen ? "fixed inset-0 z-10 block" : "hidden"} w-full shrink-0 overflow-y-auto border-r border-[var(--line)] bg-[var(--surface)] p-3 text-sm ${route.view === "focus" ? "md:hidden" : "md:block"} ${rail ? "md:static md:w-14 md:px-2" : peek ? "md:absolute md:inset-y-0 md:left-0 md:z-30 md:w-64 md:shadow-xl" : "md:static md:w-64"}`}
            // Każda pozycja panelu bocznego zamyka panel zadania (edycje zapisały się już przy `blur`), a rozwinięty chwilowo — też siebie.
            onClickCapture={(e) => {
              const target = e.target as Element;
              if (openTaskId && target.closest("a, button, select, [role=button]")) setOpenTaskId(null);
              if (peek && target.closest("a")) setPeek(false);
            }}
          >
            {rail ? (
              <div className="hidden flex-col items-center gap-0.5 md:flex">
                <button type="button" onClick={() => setPeek(true)} title="Rozwiń panel boczny ([)" aria-label="Rozwiń panel boczny" aria-expanded={false} className="mb-1 h-9 w-10 rounded-md text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--foreground)]">
                  »
                </button>
                <FocusIndicator navigate={navigate} compact />
                <button
                  type="button"
                  onClick={openQuickFromSidebar}
                  title="Dodaj zadanie (Q, Ctrl+Spacja)"
                  aria-label="Dodaj zadanie"
                  className="mb-2 flex h-9 w-10 items-center justify-center rounded-md bg-[var(--accent)] text-lg font-medium text-white hover:opacity-90"
                >
                  +
                </button>
                {mainNav.map((n) => (
                  <NavItem key={routeHash(n.route)} {...n} current={route} navigate={navigate} compact />
                ))}
                <div className="my-2 w-8 border-t border-[var(--line)]" />
                {bottomNav.map((n) => (
                  <NavItem key={routeHash(n.route)} {...n} current={route} navigate={navigate} compact />
                ))}
              </div>
            ) : null}
            {/* Zwinięty: pełna treść tylko schowana — przypomnienia o przeglądzie i licznik skupienia działają dalej. */}
            <div className={rail ? "md:hidden" : undefined}>
            <div className="mb-3 flex gap-1">
              <Select aria-label="Przestrzeń" value={workspaceId ?? ALL} onChange={(e) => writeWorkspace(e.target.value)} className="min-w-0 flex-1">
                <option value={ALL}>Wszystkie przestrzenie</option>
                {data.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.role === "viewer" ? `${w.name} (podgląd)` : w.role === "editor" ? `${w.name} (udostępniona)` : w.name}
                  </option>
                ))}
              </Select>
              {peek ? (
                <button type="button" onClick={() => setCollapsed(false)} title="Przypnij panel boczny ([)" aria-label="Przypnij panel boczny" className={sideButton}>
                  📌
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => (peek ? setPeek(false) : setCollapsed(true))}
                title={peek ? "Schowaj panel boczny (Esc)" : "Zwiń panel boczny do ikon ([)"}
                aria-label={peek ? "Schowaj panel boczny" : "Zwiń panel boczny"}
                className={sideButton}
              >
                «
              </button>
            </div>
            <FocusIndicator navigate={navigate} />
            <ReviewNudge settings={settings} navigate={navigate} />
            <button
              type="button"
              onClick={openQuickFromSidebar}
              title="Szybkie dodawanie (Q, Ctrl+Spacja)"
              className="mb-3 flex w-full items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 font-medium text-white hover:opacity-90"
            >
              <span aria-hidden>+</span> Dodaj zadanie
              <kbd className="ml-auto rounded bg-white/20 px-1.5 text-xs font-normal">Q</kbd>
            </button>
            <nav className="flex flex-col gap-0.5">
              {mainNav.map((n) => (
                <NavItem key={routeHash(n.route)} {...n} current={route} navigate={navigate} />
              ))}
            </nav>
            {workspaces.map((w) => (
              <WorkspaceLists key={w.id} name={w.name} color={w.color} role={w.role} members={w.members} lists={sectionLists(w.id)} counts={counts.perList} route={route} navigate={navigate} />
            ))}
            {data.savedFilters.length ? (
              <SidebarSection title="Filtry">
                {data.savedFilters.map((f) => (
                  <NavItem key={f.id} route={{ view: "filter", id: f.id }} current={route} navigate={navigate} icon="⚲" label={f.name} count={counts.perFilter.get(f.id)} />
                ))}
              </SidebarSection>
            ) : null}
            {sidebarTags.length ? (
              <SidebarSection title="Tagi">
                {sidebarTags.map((t) => (
                  <NavItem key={t.id} route={{ view: "tag", id: t.id }} current={route} navigate={navigate} color={t.color} label={`@${t.name}`} count={counts.perTag.get(t.id)} />
                ))}
              </SidebarSection>
            ) : null}
            <nav className="mt-4 flex flex-col gap-0.5 border-t border-[var(--line)] pt-3">
              {bottomNav.map((n) => (
                <NavItem key={routeHash(n.route)} {...n} current={route} navigate={navigate} />
              ))}
            </nav>
            </div>
          </aside>
          <main ref={mainRef} className="@container min-w-0 flex-1 overflow-y-auto lg:[&:has(~[data-task-panel=full])]:hidden">
            <div className={`mx-auto w-full p-4 pb-20 [--tp-pad:1rem] sm:p-6 sm:[--tp-pad:1.5rem] ${wide ? "" : route.view === "today" ? "max-w-5xl" : list?.prefs.columns?.length ? "max-w-6xl" : "max-w-3xl"}`}>{content}</div>
          </main>
          {openTaskId ? <TaskPanel key={openTaskId} taskId={openTaskId} /> : null}
        </div>
        <QuickAddDialog
          key={shared ? "shared" : "quick"}
          open={quickOpen}
          onClose={() => {
            setQuickOpen(false);
            setShared(null);
          }}
          {...quickDefaults}
          {...(shared && { initialText: shared.text, link: shared.url ? { url: shared.url, shared: true } : undefined, placeholder: "Zadanie z udostępnionego linku" })}
        />
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
        </FocusProvider>
        </AttachmentsProvider>
      </TaskActionsProvider>
    </AppEnvProvider>
  );
}

const sameRoute = (a: Route, b: Route) => routeHash(a) === routeHash(b);

const COLLAPSED_KEY = "tp-sidebar-collapsed";

type NavEntry = { route: Route; icon: string; label: string; count?: number; alert?: boolean };

/** Sekcja paska bocznego zwijana kliknięciem w nagłówek (stan per przeglądarka). */
/** Chipy filtra listy: zapis w `view_prefs.filter` tej listy (synchronizowany), więc wybór wraca po powrocie do listy. */
function ListFilterBar({ list, store, onSaved }: { list: List; store: TabStore; onSaved: (id: string) => void }) {
  const { notify } = useTaskActions();
  const query = list.prefs.filter ?? {};
  const onChange = (next: FilterQuery) => {
    const prefs = { ...list.prefs };
    delete prefs.filter;
    if (!isEmptyFilter(next)) prefs.filter = next;
    void store.mutate("lists", list.id, { view_prefs: prefs }).catch((e: unknown) => notify(String(e)));
  };
  return (
    <FilterBar query={query} onChange={onChange} hide={["lists"]}>
      <SaveFilter query={query} onSaved={onSaved} />
    </FilterBar>
  );
}

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
  compact,
  badge,
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
  /** Zwinięty pasek boczny: sama ikona, nazwa w podpowiedzi, licznik jako plakietka. */
  compact?: boolean;
  /** Ikona udostępnienia listy (core `listShareBadge`). */
  badge?: ListShareBadge | null;
}) {
  const active = sameRoute(route, current);
  if (compact)
    return (
      <a
        href={routeHash(route)}
        onClick={(e) => {
          e.preventDefault();
          navigate(route);
        }}
        aria-current={active ? "page" : undefined}
        title={count ? `${label} (${count})` : label}
        className={`relative flex h-9 w-10 items-center justify-center rounded-md ${active ? "bg-[var(--hover)]" : "hover:bg-[var(--hover)]"}`}
      >
        <span aria-hidden>{icon}</span>
        <span className="sr-only">{label}</span>
        {count ? (
          <span
            className={`absolute -top-0.5 -right-1 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 ${alert ? "bg-[var(--danger)] font-semibold text-white" : "border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)]"}`}
          >
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </a>
    );
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
      {badge ? (
        <span className="shrink-0 text-xs opacity-70" title={badge.label} aria-label={badge.label} data-testid="list-share-badge">
          {badge.icon}
        </span>
      ) : null}
      {count ? <span className={`text-xs ${alert ? "font-semibold text-[var(--danger)]" : "text-[var(--muted)]"}`}>{count}</span> : null}
    </a>
  );
}

function WorkspaceLists({
  name,
  color,
  role,
  members,
  lists,
  counts,
  route,
  navigate,
}: {
  name: string;
  color: string | null;
  role: Workspace["role"];
  members: number;
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
        {role === "editor" || role === "viewer" ? (
          <span className="font-normal tracking-normal normal-case" title={role === "viewer" ? "Udostępniona Ci do podglądu" : "Udostępniona Ci do edycji"}>
            {role === "viewer" ? "· podgląd" : "· udostępniona"}
          </span>
        ) : null}
      </h2>
      {lists.length ? (
        <nav className="flex flex-col gap-0.5">
          {lists.map((l) => (
            <NavItem key={l.id} route={{ view: "list", id: l.id }} current={route} navigate={navigate} color={l.color} label={l.name} project={l.kind === "project"} count={counts.get(l.id)} badge={listShareBadge(role, l.guestAccess, members)} />
          ))}
        </nav>
      ) : (
        <p className="px-2 text-xs text-[var(--muted)]">Brak list</p>
      )}
    </section>
  );
}

// ── Klawiatura i polecenia ───────────────────────────────────────────────────────────────────

/** Tryb skupienia z zadaniem (zaznaczonym albo otwartym) albo bez. */
const focusRoute = (taskId: string | null | undefined): Route => (taskId ? { view: "focus", id: taskId } : { view: "focus" });

/** Parametry udostępnienia (manifest `share_target`, zakładka w „Ustawieniach”). */
export const SHARE_PARAMS = ["share_title", "share_text", "share_url"] as const;

function readShare(params: URLSearchParams): { text: string; url: string | null } | null {
  if (!SHARE_PARAMS.some((p) => params.get(p))) return null;
  const result = sharedText({ title: params.get("share_title"), text: params.get("share_text"), url: params.get("share_url") });
  return result.text ? result : null;
}

const GO: Record<string, Route> = { i: { view: "inbox" }, t: { view: "today" }, u: { view: "upcoming" }, k: { view: "board" }, c: { view: "calendar" }, o: { view: "timeline" }, h: { view: "habits" } };

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
  toggleSidebar,
}: {
  blocked: boolean;
  selected: string[];
  setSelected: (ids: string[]) => void;
  navigate: (route: Route) => void;
  openQuick: () => void;
  openPalette: (mode: PaletteMode) => void;
  openShortcuts: () => void;
  toggleSidebar: () => void;
}) {
  const { openTask, openTaskId } = useAppEnv();
  const focusOn = useFocus().settings.enabled;
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
        "[": toggleSidebar,
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
        ...(focusOn && { f: () => navigate(focusRoute(selected.at(-1) ?? openTaskId)) }),
      };
      const handler = handlers[key];
      // Enter bez zaznaczenia zostaje przyciskom i linkom.
      if (!handler || (key === "Enter" && !selected.length)) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [blocked, selected, setSelected, navigate, openQuick, openPalette, openShortcuts, toggleSidebar, openTask, openTaskId, bulk, focusOn]);

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
      "view.timeline": () => then(() => navigate({ view: "timeline" })),
      "view.habits": () => then(() => navigate({ view: "habits" })),
      "focus.start": () => then(() => navigate(focusRoute(selected.at(-1) ?? null))),
      "review.daily": () => then(() => navigate({ view: "review", id: "daily" })),
      "review.weekly": () => then(() => navigate({ view: "review", id: "weekly" })),
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
