"use client";

/**
 * Tryb skupienia (Etap 7, M14): Pomodoro i stoper nad `core/focus.ts`. Stan timera to znaczniki
 * czasu w `profiles.focus` (jedno pole synchronizowane — drugie urządzenie widzi ten sam timer),
 * każdy odcinek pracy i przerwy to wpis `time_entries`; przejście = jedna transakcja `mutateMany`.
 *
 * Koniec etapu dolicza ta karta, która akurat działa (`advanceFocus` z id deterministycznymi —
 * kilka kart albo urządzeń zapisze te same wpisy), a po otwarciu aplikacji etap zamyka się w chwili
 * swojego końca. Dźwięk w widocznej karcie, powiadomienie, gdy karta jest w tle.
 */
import {
  advanceFocus,
  FOCUS_PHASE,
  focusEndText,
  focusElapsed,
  focusEntryId,
  focusMinutes,
  focusRemaining,
  focusStepOps,
  focusWeek,
  formatMinutes,
  formatTimer,
  manualEntryOps,
  normalizeText,
  orphanEntryOps,
  parseFocusState,
  pauseFocus,
  phaseEndsAt,
  phaseMs,
  plural,
  PRIORITY,
  resumeFocus,
  selectToday,
  skipPhase,
  startFocus,
  stopFocus,
  WEEKDAY,
  isoWeekday,
  type FocusPhase,
  type FocusSettings,
  type FocusState,
  type FocusStep,
  type ProfileSettings,
  type TimeEntryRecord,
  type ViewContext,
  type ViewTask,
} from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useLocalQuery } from "@/lib/local-store";
import type { Route } from "@/lib/route";

import { useAppEnv } from "./app-env";
import { TaskItem, useTaskActions } from "./task-item";
import { DescriptionEditor } from "./task-panel";
import { Button, Input } from "./ui";

type Row = Record<string, string | number | null>;

interface FocusApi {
  state: FocusState;
  settings: FocusSettings;
  entries: TimeEntryRecord[];
  /** Zegar odświeżany co sekundę, gdy timer biegnie. */
  now: number;
  start: (taskId: string | null, mode?: "pomodoro" | "stopwatch") => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  skip: () => void;
  /** Minuty pracy nad zadaniem (wpisy `focus` i `manual`, otwarty do teraz). */
  spent: (taskId: string) => number;
}

const FocusContext = createContext<FocusApi | null>(null);

export function useFocus(): FocusApi {
  const api = useContext(FocusContext);
  if (!api) throw new Error("useFocus poza <FocusProvider>.");
  return api;
}

const isBreak = (phase: FocusPhase) => phase === "short_break" || phase === "long_break";
const isTicking = (s: FocusState) => !s.paused && (s.phase === "focus" || s.phase === "stopwatch" || isBreak(s.phase));

// ── Dźwięk i powiadomienie końca etapu ───────────────────────────────────────────────────────

let audio: AudioContext | null = null;
/** Przeglądarka gra dźwięk dopiero po geście użytkownika — kontekst powstaje przy pierwszym kliknięciu. */
function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
  } catch {
    audio = null;
  }
}

function chime(rising: boolean) {
  if (!audio || audio.state !== "running") return;
  const t = audio.currentTime;
  (rising ? [660, 880] : [880, 660]).forEach((freq, i) => {
    const osc = audio!.createOscillator();
    const gain = audio!.createGain();
    const at = t + i * 0.22;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
    osc.connect(gain).connect(audio!.destination);
    osc.start(at);
    osc.stop(at + 0.22);
  });
}

async function showNotification(title: string, body: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const options = { body, tag: "tp-focus", icon: "/icons/icon-192.png" };
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration) await registration.showNotification(title, options);
    else new Notification(title, options);
  } catch {
    // Bez powiadomień — zostaje dymek w aplikacji.
  }
}

// ── Stan timera ──────────────────────────────────────────────────────────────────────────────

export function FocusProvider({ store, userId, settings, children }: { store: TabStore; userId: string; settings: ProfileSettings; children: ReactNode }) {
  const { notify } = useTaskActions();
  const profile = useLocalQuery<Row>(store, "select focus from profiles where id = ?", [userId], ["profiles"]);
  const rows = useLocalQuery<Row>(store, "select id, task_id, kind, started_at, ended_at, pomodoro_index from time_entries where deleted_at is null", [], ["time_entries"]);
  const focusSettings = settings.focus;
  const raw = profile.rows[0]?.focus ?? null;
  const state = useMemo(() => parseFocusState(raw), [raw]);
  const entries = useMemo(
    () =>
      rows.rows.map(
        (r): TimeEntryRecord => ({
          id: String(r.id),
          taskId: (r.task_id as string | null) ?? null,
          kind: r.kind as TimeEntryRecord["kind"],
          startedAt: String(r.started_at),
          endedAt: (r.ended_at as string | null) ?? null,
          pomodoroIndex: r.pomodoro_index === null || r.pomodoro_index === undefined ? null : Number(r.pomodoro_index),
        }),
      ),
    [rows.rows],
  );
  const loaded = profile.ms !== null && rows.ms !== null;

  // Zegar: co sekundę tylko przy biegnącym etapie.
  const ticking = isTicking(state);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    if (!ticking) return () => clearTimeout(first);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [ticking]);

  const write = useCallback(
    (step: FocusStep) => {
      if (!step.entries.length && JSON.stringify(step.state) === JSON.stringify(state)) return;
      void store.mutateMany(focusStepOps(userId, step)).catch((e: unknown) => notify(`Timer: ${e instanceof Error ? e.message : String(e)}`));
    },
    [store, userId, state, notify],
  );

  // Koniec etapu: zamknięcie w chwili końca, przerwa / „gotowe”; dźwięk lub powiadomienie tylko „na żywo”.
  const advanced = useRef<string | null>(null);
  const endsAt = phaseEndsAt(state, focusSettings)?.getTime() ?? null;
  useEffect(() => {
    if (!loaded || endsAt === null || endsAt > now) return;
    const key = `${state.entryId}:${endsAt}`;
    if (advanced.current === key) return;
    advanced.current = key;
    const step = advanceFocus(state, new Date(now), { settings: focusSettings, newId: focusEntryId(userId) });
    write(step);
    if (now - endsAt < 60_000) {
      const text = focusEndText(state.phase, step.state);
      if (document.visibilityState === "visible") {
        chime(state.phase !== "focus");
        notify(`⏱ ${text.title} — ${text.body}`);
      } else void showNotification(text.title, text.body);
    }
  }, [loaded, endsAt, now, state, focusSettings, userId, write, notify]);

  // Wpisy porzucone przez równoległą zmianę timera na innym urządzeniu (po chwili na synchronizację).
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      const ops = orphanEntryOps(entries, state, new Date(), focusSettings);
      if (ops.length) void store.mutateMany(ops).catch(() => undefined);
    }, 3000);
    return () => clearTimeout(timer);
  }, [loaded, entries, state, focusSettings, store]);

  // Gest użytkownika odblokowuje dźwięk (przeglądarka nie gra bez niego).
  useEffect(() => {
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    return () => window.removeEventListener("pointerdown", unlockAudio);
  }, []);

  // Pozostały czas w tytule karty.
  useEffect(() => {
    if (state.phase === "idle") return;
    const original = document.title;
    const remaining = focusRemaining(state, new Date(now), focusSettings);
    document.title = `${state.phase === "ready" ? "✓" : formatTimer(remaining ?? focusElapsed(state, new Date(now)))} · ${FOCUS_PHASE[state.phase]}${state.paused ? " (pauza)" : ""}`;
    return () => {
      document.title = original;
    };
  }, [state, now, focusSettings]);

  const api = useMemo<FocusApi>(() => {
    const at = () => new Date();
    const newId = focusEntryId(userId);
    return {
      state,
      settings: focusSettings,
      entries,
      now,
      start: (taskId, mode = "pomodoro") => {
        unlockAudio();
        write(startFocus(state, { taskId, mode, now: at(), newId }));
      },
      pause: () => write(pauseFocus(state, at())),
      resume: () => write(resumeFocus(state, at(), newId)),
      stop: () => write(stopFocus(state, at())),
      skip: () => write(skipPhase(state, at(), { settings: focusSettings, newId })),
      spent: (taskId) => focusMinutes(entries, new Date(now), { taskId }),
    };
  }, [state, focusSettings, entries, now, userId, write]);

  return <FocusContext.Provider value={api}>{children}</FocusContext.Provider>;
}

/** Tarcza: pozostały czas etapu, a stoper — czas od startu. */
function dial(api: FocusApi): string {
  const { state, now, settings } = api;
  if (state.phase === "idle" || state.phase === "ready") return formatTimer(phaseMs("focus", settings) ?? 0);
  const remaining = focusRemaining(state, new Date(now), settings);
  return remaining === null ? formatTimer(Math.floor(focusElapsed(state, new Date(now)) / 1000) * 1000) : formatTimer(remaining);
}

// ── Wskaźnik w pasku bocznym ─────────────────────────────────────────────────────────────────

/** Aktywny timer (także uruchomiony na innym urządzeniu) — klik otwiera tryb skupienia. */
export function FocusIndicator({ navigate }: { navigate: (route: Route) => void }) {
  const api = useFocus();
  const { data } = useAppEnv();
  const { state } = api;
  if (state.phase === "idle") return null;
  const task = state.taskId ? data.tasks.find((t) => t.id === state.taskId) : undefined;
  return (
    <button
      type="button"
      onClick={() => navigate({ view: "focus" })}
      data-testid="focus-indicator"
      className={`mb-3 flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left ${isBreak(state.phase) || state.phase === "ready" ? "border-green-500/50 bg-green-500/10" : "border-[var(--accent)]/50 bg-[var(--accent)]/10"}`}
      title="Tryb skupienia (F)"
    >
      <span aria-hidden>{state.paused ? "⏸" : state.phase === "ready" ? "✓" : "⏱"}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-[var(--muted)]">
          {FOCUS_PHASE[state.phase]}
          {state.paused ? " · pauza" : ""}
        </span>
        <span className="block truncate">{task?.title ?? "Bez zadania"}</span>
      </span>
      <span className="font-mono text-sm tabular-nums">{state.phase === "ready" ? "" : dial(api)}</span>
    </button>
  );
}

// ── Czas w panelu zadania ────────────────────────────────────────────────────────────────────

/** „Spędzono 1 h 20 min / szac. 2 h”, start skupienia i ręczny wpis. */
export function TaskTimeField({ task }: { task: ViewTask }) {
  const api = useFocus();
  const { run } = useTaskActions();
  const [adding, setAdding] = useState(false);
  const [minutes, setMinutes] = useState("30");
  const spent = api.spent(task.id);
  const estimate = task.durationMin;
  const active = api.state.phase !== "idle" && api.state.taskId === task.id;
  const add = () => {
    const ops = manualEntryOps(task.id, Number(minutes), new Date());
    if (!ops.length) return;
    void run(ops, { text: `Dodano ${formatMinutes(Number(minutes))} pracy`, undo: ops.map((op) => ({ ...op, patch: { deleted_at: new Date().toISOString() } })) });
    setAdding(false);
  };
  return (
    <section className="border-t border-[var(--line)] pt-3" aria-label="Czas pracy">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">Czas pracy</h3>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span data-testid="task-spent">
          {spent ? `Spędzono ${formatMinutes(spent)}` : "Jeszcze bez czasu pracy"}
          {estimate ? <span className="text-[var(--muted)]"> / szac. {formatMinutes(estimate)}</span> : null}
        </span>
        {active ? <span className="rounded bg-[var(--accent)]/10 px-1.5 text-xs">⏱ {FOCUS_PHASE[api.state.phase]} {api.state.phase === "ready" ? "" : dial(api)}</span> : null}
        <span className="ml-auto flex gap-1">
          <a href={`#/focus/${task.id}`} className="rounded-md border border-[var(--line)] px-2 py-0.5 text-xs hover:bg-[var(--hover)]">
            ▶ Skup się
          </a>
          <button type="button" className="rounded-md px-2 py-0.5 text-xs text-[var(--accent)] hover:bg-[var(--hover)]" onClick={() => setAdding((a) => !a)}>
            + Dodaj czas
          </button>
        </span>
      </div>
      {estimate ? (
        <div className="mt-1 h-1.5 overflow-hidden rounded bg-black/10 dark:bg-white/10" aria-hidden>
          <div className={`h-full ${spent > estimate ? "bg-[var(--danger)]" : "bg-[var(--accent)]"}`} style={{ width: `${Math.min(100, (spent / estimate) * 100)}%` }} />
        </div>
      ) : null}
      {adding ? (
        <form
          className="mt-2 flex items-center gap-2 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Minuty pracy" className="w-20 py-0.5 text-xs" autoFocus />
          <span>min, do teraz</span>
          <Button type="submit" className="px-2 py-0.5 text-xs">
            Dodaj
          </Button>
        </form>
      ) : null}
    </section>
  );
}

// ── Ekran skupienia ──────────────────────────────────────────────────────────────────────────

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName));

export function FocusScreen({ taskId, ctx, onExit, navigate }: { taskId: string | null; ctx: ViewContext; onExit: () => void; navigate: (route: Route) => void }) {
  const api = useFocus();
  const { data, today } = useAppEnv();
  const { toggle } = useTaskActions();
  const { state, settings } = api;
  const shownId = taskId ?? state.taskId;
  const task = shownId ? data.tasks.find((t) => t.id === shownId) : undefined;
  const timerTask = state.taskId ? data.tasks.find((t) => t.id === state.taskId) : undefined;
  const active = state.phase !== "idle";
  const other = active && taskId !== null && taskId !== state.taskId;

  // Spacja — pauza / wznowienie / start, Esc — wyjście (poza polami i przyciskami).
  const latest = useRef({ api, task, onExit });
  useEffect(() => {
    latest.current = { api, task, onExit };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      const { api: a, task: t, onExit: exit } = latest.current;
      if (event.key === "Escape") {
        event.preventDefault();
        exit();
      } else if (event.key === " ") {
        event.preventDefault();
        if (a.state.paused) a.resume();
        else if (isTicking(a.state)) a.pause();
        else a.start(t?.id ?? a.state.taskId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const total = phaseMs(state.phase, settings);
  const progress = total && active ? Math.min(1, focusElapsed(state, new Date(api.now)) / total) : 0;
  const list = task ? data.lists.find((l) => l.id === task.listId) : undefined;
  const children = task ? data.tasks.filter((t) => t.parentId === task.id).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)) : [];
  const spent = task ? api.spent(task.id) : 0;
  const inSeries = state.completedFocus % settings.longBreakEvery;

  const complete = () => {
    if (!task) return;
    if (task.status !== "done" && state.taskId === task.id && active) api.stop();
    void toggle(task);
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6" data-testid="focus-screen">
      <header className="flex items-center gap-2">
        <button type="button" onClick={onExit} className="rounded-md px-2 py-1 text-sm text-[var(--muted)] hover:bg-[var(--hover)]">
          ← Wyjdź <kbd className="ml-1 text-xs">Esc</kbd>
        </button>
        <h1 className="ml-auto text-sm font-semibold text-[var(--muted)]">Tryb skupienia</h1>
      </header>

      {other ? (
        <p className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm" role="status">
          Timer działa dla „{timerTask?.title ?? "zadania bez nazwy"}”.{" "}
          <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => api.start(taskId)}>
            Przełącz na to zadanie
          </button>{" "}
          ·{" "}
          <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => navigate({ view: "focus" })}>
            Pokaż
          </button>
        </p>
      ) : null}

      <section aria-label="Timer" className="flex flex-col items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-6">
        <p className={`text-sm font-medium ${isBreak(state.phase) || state.phase === "ready" ? "text-green-600 dark:text-green-400" : "text-[var(--accent)]"}`} data-testid="focus-phase">
          {state.phase === "idle" ? `Pomodoro ${settings.focusMin} min` : FOCUS_PHASE[state.phase]}
          {state.phase === "focus" ? ` ${inSeries + 1}/${settings.longBreakEvery}` : ""}
          {state.paused ? " · pauza" : ""}
        </p>
        <p className="text-7xl font-light tabular-nums sm:text-8xl" aria-live="off" data-testid="focus-dial">
          {state.phase === "ready" ? "✓" : dial(api)}
        </p>
        {total ? (
          <div className="h-1.5 w-full max-w-sm overflow-hidden rounded bg-black/10 dark:bg-white/10" aria-hidden>
            <div className={`h-full ${isBreak(state.phase) ? "bg-green-500" : "bg-[var(--accent)]"}`} style={{ width: `${progress * 100}%` }} />
          </div>
        ) : null}
        <div className="flex gap-1.5" aria-label={`Ukończone w serii: ${inSeries} z ${settings.longBreakEvery}`}>
          {Array.from({ length: settings.longBreakEvery }, (_, i) => (
            <span key={i} className={`h-2.5 w-2.5 rounded-full ${i < inSeries ? "bg-[var(--accent)]" : "bg-black/15 dark:bg-white/15"}`} />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {state.phase === "idle" || other ? (
            <>
              <Button kind="primary" onClick={() => api.start(task?.id ?? null)} disabled={other}>
                ▶ Pomodoro
              </Button>
              <Button onClick={() => api.start(task?.id ?? null, "stopwatch")} disabled={other}>
                ⏱ Stoper
              </Button>
            </>
          ) : state.phase === "ready" ? (
            <>
              <Button kind="primary" onClick={() => api.start(state.taskId)}>
                ▶ Następna praca
              </Button>
              <Button onClick={api.stop}>■ Zakończ</Button>
            </>
          ) : (
            <>
              {state.paused ? (
                <Button kind="primary" onClick={api.resume}>
                  ▶ Wznów
                </Button>
              ) : (
                <Button kind="primary" onClick={api.pause}>
                  ⏸ Pauza
                </Button>
              )}
              {state.phase !== "stopwatch" ? <Button onClick={api.skip}>⏭ {state.phase === "focus" ? "Zakończ etap" : "Pomiń przerwę"}</Button> : null}
              <Button onClick={api.stop}>■ Stop</Button>
            </>
          )}
        </div>
        <p className="text-xs text-[var(--muted)]">Spacja — start / pauza. Zamknięcie karty nie zatrzymuje timera.</p>
      </section>

      {task ? (
        <section aria-label="Zadanie" className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <button
              type="button"
              role="checkbox"
              aria-checked={task.status === "done"}
              aria-label={task.status === "done" ? "Przywróć zadanie" : "Ukończ zadanie"}
              onClick={complete}
              className="mt-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-xs text-white"
              style={{ borderColor: PRIORITY[task.priority].color, background: task.status === "done" ? PRIORITY[task.priority].color : "transparent" }}
            >
              {task.status === "done" ? "✓" : ""}
            </button>
            <div className="min-w-0">
              <h2 className={`text-2xl font-semibold ${task.status === "done" ? "line-through opacity-60" : ""}`}>{task.title}</h2>
              <p className="text-sm text-[var(--muted)]">
                {list ? (list.kind === "inbox" ? "Inbox" : list.name) : ""}
                {" · "}
                <span data-testid="focus-spent">
                  {spent ? `spędzono ${formatMinutes(spent)}` : "jeszcze bez czasu pracy"}
                  {task.durationMin ? ` / szac. ${formatMinutes(task.durationMin)}` : ""}
                </span>
              </p>
            </div>
          </div>
          <DescriptionEditor key={task.id} taskId={task.id} />
          {children.length ? (
            <div>
              <h3 className="mb-1 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
                Podzadania · {children.filter((c) => c.status === "done").length}/{children.filter((c) => c.status !== "cancelled").length}
              </h3>
              <ul className="divide-y divide-[var(--line)]">
                {children.map((c) => (
                  <TaskItem key={c.id} task={c} today={today} />
                ))}
              </ul>
            </div>
          ) : null}
          {state.taskId !== task.id && !other && active ? (
            <Button className="self-start" onClick={() => api.start(task.id)}>
              Przełącz timer na to zadanie
            </Button>
          ) : null}
        </section>
      ) : shownId ? (
        <p className="text-sm text-[var(--muted)]">Tego zadania już nie ma.</p>
      ) : state.phase === "idle" ? (
        <TaskPicker ctx={ctx} navigate={navigate} />
      ) : null}

      <WeekStats ctx={ctx} />
    </div>
  );
}

/** Wybór zadania: dzisiejsze i zaległe na górze, wyszukiwanie bez polskich znaków. */
function TaskPicker({ ctx, navigate }: { ctx: ViewContext; navigate: (route: Route) => void }) {
  const { data } = useAppEnv();
  const [query, setQuery] = useState("");
  const options = useMemo(() => {
    const open = data.tasks.filter((t) => t.kind === "task" && (t.status === "todo" || t.status === "in_progress") && (!ctx.workspaceId || t.workspaceId === ctx.workspaceId));
    const q = normalizeText(query.trim());
    if (q) return open.filter((t) => normalizeText(t.title).includes(q)).slice(0, 8);
    const today = selectToday(open, ctx, { completed: "hidden" });
    return [...today.overdue, ...today.today].slice(0, 8);
  }, [data.tasks, ctx, query]);
  return (
    <section aria-label="Wybór zadania" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Nad czym pracujesz?</h2>
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Szukaj zadania…" aria-label="Szukaj zadania" />
      <ul className="divide-y divide-[var(--line)] rounded-md border border-[var(--line)] text-sm">
        {options.map((t) => (
          <li key={t.id}>
            <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--hover)]" onClick={() => navigate({ view: "focus", id: t.id })}>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PRIORITY[t.priority].color }} />
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {t.durationMin ? <span className="text-xs text-[var(--muted)]">{formatMinutes(t.durationMin)}</span> : null}
            </button>
          </li>
        ))}
        {!options.length ? <li className="px-3 py-1.5 text-[var(--muted)]">{query ? "Nic nie pasuje." : "Na dziś nic — wyszukaj zadanie albo zacznij bez zadania."}</li> : null}
      </ul>
      <p className="text-xs text-[var(--muted)]">Albo zacznij bez zadania przyciskiem timera — czas trafi do „Bez zadania”.</p>
    </section>
  );
}

/** Statystyki tygodnia (M14): minuty pracy na dzień, przestrzeń, projekt / listę i zadanie. */
function WeekStats({ ctx }: { ctx: ViewContext }) {
  const api = useFocus();
  const { data } = useAppEnv();
  const minute = Math.floor(api.now / 60_000);
  const week = useMemo(
    () => focusWeek(api.entries, data.tasks, { today: ctx.today, firstDayOfWeek: ctx.firstDayOfWeek, timeZone: ctx.timeZone, now: new Date(minute * 60_000) }),
    [api.entries, data.tasks, ctx.today, ctx.firstDayOfWeek, ctx.timeZone, minute],
  );
  const max = Math.max(60, ...week.days.map((d) => d.minutes));
  const workspace = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const lists = new Map(data.lists.map((l) => [l.id, l.kind === "inbox" ? `Inbox (${workspace.get(l.workspaceId) ?? "?"})` : l.name]));
  const tasks = new Map(data.tasks.map((t) => [t.id, t.title]));
  const top = (buckets: typeof week.byTask, names: Map<string, string>) =>
    buckets.slice(0, 5).map((b) => ({ key: b.id ?? "none", name: b.id ? (names.get(b.id) ?? "(usunięte)") : "Bez zadania", minutes: b.minutes }));

  return (
    <section aria-label="Ten tydzień" className="rounded-xl border border-[var(--line)] p-4 text-sm" data-testid="focus-week">
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3">
        <h2 className="font-semibold">Ten tydzień</h2>
        <span>{week.total ? formatMinutes(week.total) : "0 min"} pracy</span>
        <span className="text-[var(--muted)]">{plural(week.pomodoros, ["Pomodoro", "Pomodoro", "Pomodoro"])}</span>
      </header>
      <div className="mb-4 flex h-24 items-end gap-2" aria-label="Minuty pracy na dzień">
        {week.days.map((d) => (
          <div key={d.date} className="flex flex-1 flex-col items-center gap-1" title={`${d.date}: ${formatMinutes(d.minutes)}`}>
            <div className={`w-full rounded-t ${d.date === ctx.today ? "bg-[var(--accent)]" : "bg-[var(--accent)]/50"}`} style={{ height: `${(d.minutes / max) * 72}px` }} />
            <span className={`text-[10px] ${d.date === ctx.today ? "font-semibold" : "text-[var(--muted)]"}`}>{WEEKDAY[isoWeekday(d.date) as keyof typeof WEEKDAY].short}</span>
          </div>
        ))}
      </div>
      {week.total ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <Breakdown title="Przestrzenie" rows={top(week.byWorkspace, workspace)} total={week.total} />
          <Breakdown title="Listy i projekty" rows={top(week.byList, lists)} total={week.total} />
          <Breakdown title="Zadania" rows={top(week.byTask, tasks)} total={week.total} />
        </div>
      ) : (
        <p className="text-[var(--muted)]">W tym tygodniu jeszcze bez zapisanej pracy.</p>
      )}
    </section>
  );
}

function Breakdown({ title, rows, total }: { title: string; rows: { key: string; name: string; minutes: number }[]; total: number }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">{title}</h3>
      <ul className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.key}>
            <div className="flex justify-between gap-2 text-xs">
              <span className="truncate">{r.name}</span>
              <span className="shrink-0 text-[var(--muted)]">{formatMinutes(r.minutes)}</span>
            </div>
            <div className="h-1 rounded bg-[var(--accent)]/60" style={{ width: `${(r.minutes / total) * 100}%` }} />
          </li>
        ))}
      </ul>
    </div>
  );
}
