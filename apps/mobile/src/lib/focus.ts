/**
 * Tryb skupienia na telefonie (Etap 7, M14) nad `core/focus.ts` — jak `components/app/focus.tsx`
 * na webie. Stan timera to znaczniki czasu w `profiles.focus` (synchronizowane: web widzi ten sam
 * timer), odcinki pracy i przerw to `time_entries`; każde przejście to `focusCommand`
 * (`lib/headless.ts`, jedna transakcja) — z ekranu, z akcji powiadomienia i przy otwarciu aplikacji.
 *
 * Powiadomienia (Android): trwałe „Praca — do 14:25” z akcjami Pauza / Pomiń / Stop, a na koniec
 * etapu zaplanowane alarmy (dokładne, jak przypomnienia M8) — działają przy zamkniętej aplikacji:
 * koniec pracy podmienia trwałe powiadomienie na „Przerwa — do …” (ten sam identyfikator), koniec
 * przerwy przychodzi osobno z „Start pracy”. Stan w bazie dolicza się przy następnym poleceniu
 * albo otwarciu aplikacji — w chwili końca etapu, nie „teraz”.
 */
import {
  advanceFocus,
  FOCUS_IDLE,
  FOCUS_PHASE,
  focusElapsed,
  focusEntryId,
  focusMinutes,
  focusRemaining,
  formatTimer,
  localDateTimeAt,
  orphanEntryOps,
  parseFocusState,
  phaseEndsAt,
  type FocusSettings,
  type FocusState,
  type TimeEntryRecord,
} from '@taskplanner/core';
import type { SqlRow, SyncEngine } from '@taskplanner/sync';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import { useSyncExternalStore } from 'react';

import { parseSettings } from './app-data';
import { readJson, writeJson } from './config';
import { focusCommand, focusStamp, loadFocus, type FocusNow } from './headless';
import { localEngine, mutateMany, onSessionChange } from './sync';

// ── Dane: stan timera i wpisy czasu ──────────────────────────────────────────────────────────

export interface FocusData extends FocusNow {
  entries: TimeEntryRecord[];
  loaded: boolean;
}

const EMPTY: FocusData = { userId: '', state: FOCUS_IDLE, settings: parseSettings({}).focus, entries: [], loaded: false };

async function loadFocusData(engine: SyncEngine): Promise<FocusData> {
  const [profile, rows] = await Promise.all([
    engine.db.all<SqlRow>('select focus, settings from profiles where id = ?', [engine.userId]),
    engine.db.all<SqlRow>('select id, task_id, kind, started_at, ended_at, pomodoro_index from time_entries where deleted_at is null'),
  ]);
  const settings = parseSettings(profile[0]?.settings);
  return {
    userId: engine.userId,
    state: parseFocusState(profile[0]?.focus ?? null),
    settings: settings.focus,
    timeZone: settings.timeZone,
    entries: rows.map((r) => ({
      id: String(r.id),
      taskId: (r.task_id as string | null) ?? null,
      kind: r.kind as TimeEntryRecord['kind'],
      startedAt: String(r.started_at),
      endedAt: (r.ended_at as string | null) ?? null,
      pomodoroIndex: r.pomodoro_index === null || r.pomodoro_index === undefined ? null : Number(r.pomodoro_index),
    })),
    loaded: true,
  };
}

let data: FocusData = EMPTY;
const listeners = new Set<() => void>();
let started = false;
let unwatch: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;

function reload() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    localEngine()
      .then(loadFocusData)
      .then((next) => {
        data = next;
        listeners.forEach((l) => l());
      })
      .catch((error) => console.warn('timer skupienia', error));
  }, 30);
}

function attach() {
  unwatch?.();
  data = EMPTY;
  listeners.forEach((l) => l());
  localEngine()
    .then((engine) => {
      unwatch = engine.watch(['profiles', 'time_entries'], reload);
      reload();
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

export const useFocusData = (): FocusData => useSyncExternalStore(subscribe, () => data);

/** Zmiany timera poza Reactem (praca w tle: powiadomienia, doliczanie końca etapu). */
export function onFocusData(listener: (data: FocusData) => void): () => void {
  return subscribe(() => listener(data));
}

/** Minuty pracy nad zadaniem (wpisy `focus` i `manual`, otwarty do teraz). */
export const spentMinutes = (entries: readonly TimeEntryRecord[], taskId: string, now = new Date()) => focusMinutes(entries, now, { taskId });

const isBreak = (s: FocusState) => s.phase === 'short_break' || s.phase === 'long_break';
export const isTicking = (s: FocusState) => !s.paused && (s.phase === 'focus' || s.phase === 'stopwatch' || isBreak(s));

/** Otwarte wpisy porzucone przez równoległą zmianę timera na innym urządzeniu — zamknięcie. */
export async function closeOrphans(d: FocusData) {
  const ops = orphanEntryOps(d.entries, d.state, new Date(), d.settings);
  if (ops.length) await mutateMany(ops);
}

// ── Powiadomienia ────────────────────────────────────────────────────────────────────────────

export const FOCUS_CHANNEL = 'focus';
export const FOCUS_END_CHANNEL = 'focus-end';
/** Trwałe powiadomienie (i alarm końca pracy, który je podmienia). */
const ONGOING_ID = 'focus';
/** Alarm końca przerwy. */
const BREAK_END_ID = 'focus_end';
export const FOCUS_CATEGORY = { running: 'focus_running', paused: 'focus_paused', ready: 'focus_ready' } as const;
export const FOCUS_ACTION = { pause: 'focus_pause', resume: 'focus_resume', skip: 'focus_skip', stop: 'focus_stop', continue: 'focus_continue' } as const;

/** Dane powiadomienia timera; `stamp` — stan, którego dotyczy (akcja ze starego nic nie zrobi). */
export interface FocusNotificationData extends Record<string, unknown> {
  focus: true;
  stamp: string;
}

export async function setupFocusNotifications() {
  await Notifications.setNotificationChannelAsync(FOCUS_CHANNEL, {
    name: 'Timer skupienia',
    description: 'Trwałe powiadomienie z bieżącym etapem',
    importance: AndroidImportance.LOW,
    lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
  });
  await Notifications.setNotificationChannelAsync(FOCUS_END_CHANNEL, {
    name: 'Koniec etapu skupienia',
    importance: AndroidImportance.HIGH,
    vibrationPattern: [0, 300, 150, 300],
    lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
  });
  const background = { opensAppToForeground: false };
  await Notifications.setNotificationCategoryAsync(FOCUS_CATEGORY.running, [
    { identifier: FOCUS_ACTION.pause, buttonTitle: 'Pauza', options: background },
    { identifier: FOCUS_ACTION.skip, buttonTitle: 'Pomiń', options: background },
    { identifier: FOCUS_ACTION.stop, buttonTitle: 'Stop', options: background },
  ]);
  await Notifications.setNotificationCategoryAsync(FOCUS_CATEGORY.paused, [
    { identifier: FOCUS_ACTION.resume, buttonTitle: 'Wznów', options: background },
    { identifier: FOCUS_ACTION.stop, buttonTitle: 'Stop', options: background },
  ]);
  await Notifications.setNotificationCategoryAsync(FOCUS_CATEGORY.ready, [
    { identifier: FOCUS_ACTION.continue, buttonTitle: 'Start pracy', options: background },
    { identifier: FOCUS_ACTION.stop, buttonTitle: 'Stop', options: background },
  ]);
}

const clock = (ms: number, timeZone?: string) => localDateTimeAt(new Date(ms), timeZone).slice(11, 16);

interface Content {
  title: string;
  body: string;
  category: string;
  sticky: boolean;
}

/** Treść powiadomienia dla stanu (`now` — chwila pokazania). */
export function focusContent(state: FocusState, settings: FocusSettings, taskTitle: string | null, now: Date, timeZone?: string): Content | null {
  const task = taskTitle ?? 'Bez zadania';
  if (state.phase === 'idle') return null;
  if (state.phase === 'ready') return { title: 'Koniec przerwy — wróć do pracy', body: task, category: FOCUS_CATEGORY.ready, sticky: false };
  const label = `${FOCUS_PHASE[state.phase]}${state.phase === 'focus' ? ` · Pomodoro ${state.completedFocus + 1}` : ''}`;
  if (state.paused) {
    const left = focusRemaining(state, now, settings);
    return { title: `Pauza — ${label}`, body: `${left === null ? `${formatTimer(focusElapsed(state, now))} na stoperze` : `zostało ${formatTimer(left)}`} · ${task}`, category: FOCUS_CATEGORY.paused, sticky: true };
  }
  if (state.phase === 'stopwatch') {
    const since = Date.parse(state.segmentStartedAt ?? now.toISOString()) - state.elapsedMs;
    return { title: `${label} — od ${clock(since, timeZone)}`, body: task, category: FOCUS_CATEGORY.running, sticky: true };
  }
  const end = phaseEndsAt(state, settings);
  return { title: `${label} — do ${end ? clock(end.getTime(), timeZone) : '…'}`, body: task, category: FOCUS_CATEGORY.running, sticky: true };
}

const SYNC_KEY = 'focus.notification';

async function taskTitle(id: string | null): Promise<string | null> {
  if (!id) return null;
  const engine = await localEngine();
  return (await engine.db.all<{ title: string }>('select title from tasks where id = ?', [id]))[0]?.title ?? null;
}

const request = (id: string, content: Content, stamp: string, channelId: string, at?: number): Notifications.NotificationRequestInput => ({
  identifier: id,
  content: {
    title: content.title,
    body: content.body,
    data: { focus: true, stamp } satisfies FocusNotificationData,
    categoryIdentifier: content.category,
    sticky: content.sticky,
    autoDismiss: !content.sticky,
  },
  trigger: at === undefined ? { channelId } : { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId },
});

let syncing: Promise<void> = Promise.resolve();

/**
 * Powiadomienia zgodne ze stanem: trwałe teraz, alarmy końca etapu (koniec pracy → przerwa,
 * koniec przerwy → „Start pracy”). Bez zmian stanu nic nie przeplanowuje (podpis w kv-store).
 */
export function syncFocusNotifications(given?: FocusNow): Promise<void> {
  syncing = syncing.then(() => syncOnce(given)).catch((error) => console.warn('powiadomienia timera', error));
  return syncing;
}

async function syncOnce(given?: FocusNow) {
  if (Platform.OS !== 'android') return;
  if (!(await Notifications.getPermissionsAsync()).granted) return;
  const { state, settings, userId, timeZone } = given ?? (await loadFocus());
  const title = await taskTitle(state.taskId);
  const signature = JSON.stringify([focusStamp(state), state.taskId, title, settings, timeZone ?? null]);
  if (readJson<string | null>(SYNC_KEY, null) === signature) return;
  await Notifications.cancelScheduledNotificationAsync(ONGOING_ID).catch(() => undefined);
  await Notifications.cancelScheduledNotificationAsync(BREAK_END_ID).catch(() => undefined);
  await Notifications.dismissNotificationAsync(BREAK_END_ID).catch(() => undefined);
  const now = new Date();
  const content = focusContent(state, settings, title, now, timeZone);
  if (!content) {
    await Notifications.dismissNotificationAsync(ONGOING_ID).catch(() => undefined);
    writeJson(SYNC_KEY, signature);
    return;
  }
  // „Gotowe” (po przerwie) przychodzi jako alarm końca przerwy — nie dublujemy go trwałym.
  if (state.phase === 'ready') await Notifications.dismissNotificationAsync(ONGOING_ID).catch(() => undefined);
  else await Notifications.scheduleNotificationAsync(request(ONGOING_ID, content, focusStamp(state), FOCUS_CHANNEL));

  const end = phaseEndsAt(state, settings);
  if (end && !state.paused) {
    const newId = focusEntryId(userId);
    const next = advanceFocus(state, end, { settings, newId }).state;
    if (state.phase === 'focus') {
      // Koniec pracy: przerwa zaczyna się sama — podmienia trwałe powiadomienie, z dźwiękiem.
      const breakContent = focusContent(next, settings, title, end, timeZone);
      if (breakContent) {
        await Notifications.scheduleNotificationAsync(
          request(ONGOING_ID, { ...breakContent, title: `Koniec pracy · ${breakContent.title}` }, focusStamp(next), FOCUS_END_CHANNEL, end.getTime()),
        );
      }
      const breakEnd = phaseEndsAt(next, settings);
      if (breakEnd) {
        const ready = advanceFocus(next, breakEnd, { settings, newId }).state;
        const readyContent = focusContent(ready, settings, title, breakEnd, timeZone);
        if (readyContent) await Notifications.scheduleNotificationAsync(request(BREAK_END_ID, readyContent, focusStamp(ready), FOCUS_END_CHANNEL, breakEnd.getTime()));
      }
    } else if (next.phase === 'ready') {
      const readyContent = focusContent(next, settings, title, end, timeZone);
      if (readyContent) await Notifications.scheduleNotificationAsync(request(BREAK_END_ID, readyContent, focusStamp(next), FOCUS_END_CHANNEL, end.getTime()));
    }
  }
  writeJson(SYNC_KEY, signature);
}

/** Po zmianie konta albo wyczyszczeniu danych: następna synchronizacja powiadomień od nowa. */
export const forgetFocusNotifications = () => writeJson(SYNC_KEY, null);

/**
 * Praca timera, gdy aplikacja działa: powiadomienia po każdej zmianie stanu (też z innego
 * urządzenia), doliczenie końca etapu w chwili końca, przy starcie i po powrocie na wierzch,
 * zamykanie porzuconych wpisów. `onPhaseEnd` — sygnał na ekranie (wibracja).
 */
export function startFocusWork(onPhaseEnd?: (finished: FocusState, next: FocusState) => void): () => void {
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  let orphanTimer: ReturnType<typeof setTimeout> | null = null;
  const advance = () =>
    void focusCommand({ kind: 'advance' })
      .then((result) => result.changed && onPhaseEnd?.(data.state, result.state))
      .catch((error) => console.warn('timer skupienia', error));
  forgetFocusNotifications();
  const off = onFocusData((d) => {
    if (!d.loaded) return;
    void syncFocusNotifications(d);
    if (endTimer) clearTimeout(endTimer);
    const end = phaseEndsAt(d.state, d.settings);
    endTimer = end ? setTimeout(advance, Math.max(0, end.getTime() - Date.now()) + 50) : null;
    if (orphanTimer) clearTimeout(orphanTimer);
    orphanTimer = setTimeout(() => void closeOrphans(d).catch(() => undefined), 3000);
  });
  advance();
  const sub = AppState.addEventListener('change', (next) => {
    if (next === 'active') advance();
  });
  return () => {
    off();
    sub.remove();
    if (endTimer) clearTimeout(endTimer);
    if (orphanTimer) clearTimeout(orphanTimer);
  };
}
