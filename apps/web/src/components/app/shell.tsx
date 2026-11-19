"use client";

/**
 * Powłoka aplikacji (MVP-2): pasek boczny z widokami stałymi i licznikami, przełącznik przestrzeni
 * z trybem „Wszystkie” (M2), listy i projekty przestrzeni, treść według `#` adresu.
 */
import { isOpen, selectInbox, selectToday, type ProfileSettings, type ViewContext } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { useAppData, useToday, type List } from "@/lib/app-data";
import { routeHash, useRoute, type Route } from "@/lib/route";

import { AppEnvProvider } from "./app-env";
import { QuickAddDialog } from "./quick-add";
import { TaskPanel } from "./task-panel";
import { TaskActionsProvider } from "./task-item";
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
  const [quickOpen, setQuickOpen] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  // Szybkie dodawanie z każdego miejsca (M13): `Q` poza polem tekstowym, `Ctrl+Spacja` zawsze.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const ctrlSpace = (event.ctrlKey || event.metaKey) && event.code === "Space";
      const q = event.key.toLowerCase() === "q" && !event.ctrlKey && !event.metaKey && !event.altKey && !isTyping(event.target);
      if (!ctrlSpace && !q) return;
      event.preventDefault();
      setQuickOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ctx: ViewContext = useMemo(() => ({ today, timeZone: settings.timeZone, workspaceId, firstDayOfWeek: settings.firstDayOfWeek }), [today, settings.timeZone, workspaceId, settings.firstDayOfWeek]);

  // Nowe zadania z widoków zbiorczych: Inbox bieżącej przestrzeni, w trybie „Wszystkie” — pierwszej.
  const targetInbox = data.lists.find((l) => l.kind === "inbox" && l.workspaceId === (workspaceId ?? data.workspaces[0]?.id));

  const counts = useMemo(() => {
    const inboxIds = new Set(data.lists.filter((l) => l.kind === "inbox").map((l) => l.id));
    const view = selectToday(data.tasks, ctx, { completed: "hidden" });
    const perList = new Map<string, number>();
    for (const t of data.tasks) if (isOpen(t) && t.kind === "task") perList.set(t.listId, (perList.get(t.listId) ?? 0) + 1);
    return { inbox: selectInbox(data.tasks, inboxIds, ctx).length, today: view.overdue.length + view.today.length, overdue: view.overdue.length, perList };
  }, [data.tasks, data.lists, ctx]);

  // Nowy widok: od góry, a na wąskim ekranie menu się chowa.
  const hash = routeHash(route);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    void Promise.resolve().then(() => setMenuOpen(false));
  }, [hash]);

  if (!data.loaded) return <Splash text="Wczytywanie zadań…" />;

  const list = route.view === "list" ? data.lists.find((l) => l.id === route.id) : undefined;
  const props = { data, ctx, targetInbox };
  const content =
    route.view === "inbox" ? (
      <InboxView {...props} />
    ) : route.view === "today" ? (
      <TodayView {...props} />
    ) : route.view === "upcoming" ? (
      <UpcomingView {...props} />
    ) : route.view === "manage" ? (
      manage
    ) : route.view === "settings" ? (
      settingsView
    ) : route.view === "trash" ? (
      <TrashView data={data} store={store} />
    ) : list ? (
      <ListView key={list.id} data={data} ctx={ctx} list={list} store={store} />
    ) : (
      <p className="py-6 text-sm text-[var(--muted)]">Ta lista nie istnieje albo jest zarchiwizowana.</p>
    );

  const workspaces = workspaceId ? data.workspaces.filter((w) => w.id === workspaceId) : data.workspaces;
  // Okno szybkiego dodawania dodaje tam, skąd je wywołano (lista / „Dziś” z dzisiejszym terminem).
  const quickDefaults = list ? { listId: list.id } : route.view === "today" ? { listId: targetInbox?.id, dueDate: today } : { listId: targetInbox?.id };

  return (
    <AppEnvProvider value={{ store, data, userId, timeZone: settings.timeZone, today, workspaceId, openTask: setOpenTaskId, openTaskId }}>
      <TaskActionsProvider store={store} timeZone={settings.timeZone} tasks={data.tasks}>
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
            </nav>
            {workspaces.map((w) => (
              <WorkspaceLists key={w.id} name={w.name} color={w.color} lists={data.lists.filter((l) => l.workspaceId === w.id && l.kind !== "inbox")} counts={counts.perList} route={route} navigate={navigate} />
            ))}
            <nav className="mt-4 flex flex-col gap-0.5 border-t border-[var(--line)] pt-3">
              <NavItem route={{ view: "manage" }} current={route} navigate={navigate} icon="🗂️" label="Przestrzenie i listy" />
              <NavItem route={{ view: "trash" }} current={route} navigate={navigate} icon="🗑️" label="Kosz" />
              <NavItem route={{ view: "settings" }} current={route} navigate={navigate} icon="⚙️" label="Ustawienia" />
            </nav>
          </aside>
          <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl p-4 pb-20 sm:p-6">{content}</div>
          </main>
          {openTaskId ? <TaskPanel key={openTaskId} taskId={openTaskId} /> : null}
        </div>
        <QuickAddDialog open={quickOpen} onClose={() => setQuickOpen(false)} {...quickDefaults} />
      </TaskActionsProvider>
    </AppEnvProvider>
  );
}

const sameRoute = (a: Route, b: Route) => a.view === b.view && (a.view !== "list" || (b.view === "list" && a.id === b.id));

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
