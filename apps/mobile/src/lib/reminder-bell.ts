/**
 * Przypomnienia w dzwonku telefonu (jak `lib/notifications.ts` `useReminderNotifications` na webie): wybite w ciągu
 * ostatnich 24 h przypomnienia otwartych zadań — te same reguły co planowanie (`reminderSources` w `scheduler.ts`)
 * i core `reminderNotifications`. Nie mają wiersza w bazie: „przeczytane” / „usunięte” pamięta ten telefon
 * (kv-store `notifications.reminderBell`). Przy wpisie: „Przypomnij za 15 min / 30 min / 1 h” (jednorazowe
 * przypomnienie, poprzednie odłożenie znika) i „Ukończ” (`reminderDoneOps`, z „Cofnij”).
 */
import {
  descendants,
  dismissOps,
  EMPTY_REMINDER_BELL,
  localDateAt,
  relativeDay,
  REMINDER_BELL_WINDOW_MS,
  reminderBellUpdate,
  reminderDoneOps,
  reminderFireTimes,
  reminderNotifications,
  snoozeReminderOps,
  toReminderRule,
  type AppNotification,
  type ReminderBellState,
  type ReminderRule,
  type ReminderTask,
  type TaskOp,
  type ViewTask,
} from '@taskplanner/core';
import { useMemo, useSyncExternalStore } from 'react';

import { onAppData, sharedAppData, type AppData } from './app-data';
import { readJson, writeJson } from './config';
import { markNotificationsRead, useNotificationsData, type NotificationsData } from './notifications';
import { reminderSources } from './scheduler';
import { localEngine, mutateMany } from './sync';

const BELL_KEY = 'notifications.reminderBell';
let bell: ReminderBellState | null = null;
const listeners = new Set<() => void>();

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []);

function bellState(): ReminderBellState {
  if (bell) return bell;
  const raw = readJson<Partial<ReminderBellState> | null>(BELL_KEY, null);
  bell = raw
    ? {
        read: strings(raw.read),
        dismissed: strings(raw.dismissed),
        readBefore: typeof raw.readBefore === 'string' ? raw.readBefore : null,
        popped: strings(raw.popped),
      }
    : EMPTY_REMINDER_BELL;
  return bell;
}

function setBell(next: ReminderBellState) {
  if (next === bellState()) return;
  bell = next;
  writeJson(BELL_KEY, next);
  listeners.forEach((l) => l());
}

const subscribeBell = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Stan przypomnień w dzwonku tego telefonu (okno na środku ekranu czyta z niego `popped`). */
export const useReminderBellState = (): ReminderBellState => useSyncExternalStore(subscribeBell, bellState);

/** Zamknięcie okna przypomnienia bez decyzji: wpis zostaje w dzwonku (nieprzeczytany), okno nie wraca. */
export function closeBellPopups(list: readonly AppNotification[]) {
  setBell(reminderBellUpdate(bellState(), list, 'popped'));
}

// ── Wpisy ────────────────────────────────────────────────────────────────────────────────────

type Sources = { data: AppData; tasks: ReminderTask[]; byId: Map<string, ReminderTask>; rules: ReminderRule[] };

/**
 * Wspólny magazyn wybitych przypomnień (dzwonek jest w nagłówku wielu ekranów — liczone raz): reguły po każdej zmianie
 * danych widoków albo przypomnień, wpisy co minutę i po zmianie stanu „przeczytane”. Działa, póki ktoś słucha.
 */
let sources: Sources | null = null;
let fired: AppNotification[] = [];
let firedMinute = -1;
let generation = 0;
const firedListeners = new Set<() => void>();
let stop: (() => void) | null = null;

function recompute(force = true) {
  const minute = Math.floor(Date.now() / 60_000);
  if (!sources || (!force && minute === firedMinute)) return;
  firedMinute = minute;
  const { data, tasks, byId, rules } = sources;
  const { timeZone, defaultReminderTime } = data.settings;
  const at = new Date(minute * 60_000 + 59_999);
  const fires = reminderFireTimes(tasks, rules, {
    from: new Date(at.getTime() - REMINDER_BELL_WINDOW_MS),
    to: at,
    timeZone,
    defaultTime: defaultReminderTime,
    habitCompletions: data.habitCompletions,
  });
  fired = reminderNotifications(fires, byId, bellState(), at, timeZone);
  firedListeners.forEach((l) => l());
}

function load(data: AppData | null) {
  const run = ++generation;
  void localEngine()
    .then(async (engine) => {
      const current = data ?? sources?.data ?? (await sharedAppData(engine));
      if (!current.loaded || !current.userId) return;
      const next = await reminderSources(current, engine, current.userId);
      if (run !== generation) return;
      sources = { data: current, ...next };
      recompute();
    })
    .catch((error) => console.warn('przypomnienia w dzwonku', error));
}

function start() {
  const offs: (() => void)[] = [onAppData(load), subscribeBell(() => recompute())];
  const timer = setInterval(() => recompute(false), 30_000);
  let alive = true;
  // Reguły czyta osobne zapytanie — zmiana przypomnień (np. „Przypomnij za…”) nie zmienia danych widoków.
  void localEngine()
    .then((engine) => {
      if (alive) offs.push(engine.watch(['reminders', 'scope_collaborators', 'task_participants'], () => load(null)));
    })
    .catch(() => undefined);
  load(null);
  return () => {
    alive = false;
    clearInterval(timer);
    offs.forEach((off) => off());
  };
}

function subscribeFired(listener: () => void) {
  firedListeners.add(listener);
  stop ??= start();
  return () => {
    firedListeners.delete(listener);
    if (firedListeners.size || !stop) return;
    stop();
    stop = null;
    sources = null;
    fired = [];
  };
}

const useReminderNotifications = (): AppNotification[] => useSyncExternalStore(subscribeFired, () => fired);

/** Dzwonek i ekran „Powiadomienia”: wiersze z bazy + wybite przypomnienia z tego telefonu. */
export function useBellNotifications(): NotificationsData {
  const base = useNotificationsData();
  const reminders = useReminderNotifications();
  return useMemo(() => (reminders.length ? { ...base, list: [...base.list, ...reminders] } : base), [base, reminders]);
}

// ── Przeczytane / usunięte ───────────────────────────────────────────────────────────────────

/** Przeczytane: wiersze z bazy przez outbox, przypomnienia — na tym telefonie. */
export function markBellRead(list: readonly AppNotification[]) {
  setBell(
    reminderBellUpdate(
      bellState(),
      list.filter((n) => !n.readAt),
      'read',
    ),
  );
  return markNotificationsRead(list);
}

/** Usunięcie z listy (wiersze z bazy — też na innych urządzeniach). */
export function dismissBell(list: readonly AppNotification[]) {
  setBell(reminderBellUpdate(bellState(), list, 'dismissed'));
  const ops = dismissOps(list, new Date());
  return ops.length ? mutateMany(ops) : Promise.resolve();
}

// ── Akcje przy przypomnieniu ─────────────────────────────────────────────────────────────────

const fireKey = (n: AppNotification) => n.id.slice(2);

async function taskRules(taskId: string): Promise<ReminderRule[]> {
  const engine = await localEngine();
  const rows = await engine.db.all<{
    id: string;
    task_id: string;
    kind: string;
    offset_min: number | null;
    at_date: string | null;
    at_time: string | null;
  }>('select id, task_id, kind, offset_min, at_date, at_time from reminders where task_id = ? and deleted_at is null', [taskId]);
  return rows.map(toReminderRule);
}

/** „Przypomnij za N min”: jednorazowe przypomnienie, wpis znika z dzwonka. Wynik: godzina albo `null` (zadanie zamknięte). */
export async function snoozeBellReminder(n: AppNotification, data: AppData, minutes: number): Promise<string | null> {
  const task = n.taskId ? data.tasks.find((t) => t.id === n.taskId) : undefined;
  if (!task) return null;
  const snoozed = snoozeReminderOps(task, await taskRules(task.id), {
    userId: data.userId,
    now: new Date(),
    timeZone: data.settings.timeZone,
    minutes,
  });
  if (!snoozed) return null;
  await mutateMany(snoozed.ops);
  await dismissBell([n]);
  return snoozed.time;
}

/**
 * „Ukończ” przy przypomnieniu — te same reguły co akcja z powiadomienia systemowego (seria: tylko wystąpienie, którego
 * dotyczy przypomnienie). Wynik do `run` (z „Cofnij”) albo powód, dla którego nic się nie zmienia.
 */
export async function bellReminderDone(n: AppNotification, data: AppData): Promise<{ ops: TaskOp[]; undo: TaskOp[]; text: string } | { note: string; taskId?: string }> {
  const task: ViewTask | undefined = n.taskId ? data.tasks.find((t) => t.id === n.taskId) : undefined;
  if (!task)
    return {
      note: 'Tego zadania już nie ma (usunięte albo w zarchiwizowanej liście).',
    };
  const now = new Date();
  const { timeZone } = data.settings;
  const done = reminderDoneOps(task, fireKey(n), await taskRules(task.id), {
    userId: data.userId,
    now,
    timeZone,
    subtasks: task.recurrence ? descendants(data.tasks, task.id) : [],
  });
  if (!done)
    return {
      note: `„${task.title}” — to przypomnienie jest nieaktualne, nic nie zmieniono.`,
      taskId: task.id,
    };
  const today = localDateAt(now, timeZone);
  return {
    ops: done.ops,
    undo: done.undo,
    text: done.nextDue ? `„${task.title}” — następny termin: ${relativeDay(done.nextDue, today)}` : `Ukończono „${task.title}”`,
  };
}
