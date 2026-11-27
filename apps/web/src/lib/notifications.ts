"use client";

/**
 * Centrum powiadomień (v1.x, N1–N3): wiersze `notifications` z lokalnej bazy (tworzy je serwer, przychodzą
 * zwykłą synchronizacją) i ustawienia z profilu. Zaznaczenie „przeczytane” / usunięcie = `mutateMany`
 * (outbox — działa offline). Otwarcie zadania z nagłówka: zdarzenie okna `tp-open-task` (nasłuchuje `Shell`).
 *
 * Do tego wybite przypomnienia (ostatnie 24 h, zadanie otwarte) liczone tutaj z lokalnych danych tymi samymi regułami
 * co `reminders-push` (własne wiersze `reminders` + automatyczne przypomnienie odpowiedzialnego we wspólnej
 * przestrzeni) — core `reminderNotifications`. Nie mają wiersza w bazie: „przeczytane” / „usunięte” pamięta ta
 * przeglądarka (`localStorage` `tp-reminder-bell`, wspólne dla kart).
 */
import {
  addDays,
  assigneeReminderRules,
  dismissOps,
  EMPTY_REMINDER_BELL,
  HabitSettings,
  localDateAt,
  markReadOps,
  NotificationPrefs,
  Recurrence,
  REMINDER_BELL_WINDOW_MS,
  reminderBellUpdate,
  reminderFireTimes,
  reminderNotifications,
  snoozeReminderOps,
  toHabitCompletion,
  toNotification,
  toReminderRule,
  type AppNotification,
  type HabitCompletion,
  type LocalTime,
  type ReminderBellState,
  type ReminderTask,
  type ViewTask,
} from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { parseSettings } from "./app-data";
import { useLocalQuery } from "./local-store";

interface Row extends Record<string, string | number | null> {
  id: string;
  kind: string;
  task_id: string | null;
  workspace_id: string | null;
  actor_id: string | null;
  data: string | null;
  group_key: string | null;
  at: string;
  read_at: string | null;
}

/** Tyle najnowszych wierszy czyta dzwonek (więcej i tak nie zmieści się na liście). */
const LIMIT = 300;

export function useNotifications(store: TabStore | null, userId: string): { list: AppNotification[]; prefs: NotificationPrefs; timeZone: string | undefined } {
  const { rows } = useLocalQuery<Row>(
    store,
    `select id, kind, task_id, workspace_id, actor_id, data, group_key, at, read_at from notifications where deleted_at is null order by at desc limit ${LIMIT}`,
    [],
    ["notifications"],
  );
  const { rows: profile } = useLocalQuery<{ settings: string | null }>(store, "select settings from profiles where id = ?", [userId], ["profiles"]);
  const settings = useMemo(() => {
    try {
      return parseSettings(profile[0]?.settings ? JSON.parse(profile[0].settings) : {});
    } catch {
      return parseSettings({});
    }
  }, [profile]);
  const reminders = useReminderNotifications(store, userId, settings.timeZone, settings.defaultReminderTime, settings.notifications);
  const list = useMemo(
    () => [...rows.map((r) => toNotification(r)).filter((n): n is AppNotification => n !== null), ...reminders],
    [rows, reminders],
  );
  return { list, prefs: settings.notifications, timeZone: settings.timeZone };
}

// ── Przeczytane / usunięte (baza + przypomnienia z tej przeglądarki) ─────────────────────────

/** Zaznaczenie jako przeczytane: wiersze z bazy przez outbox, przypomnienia — w tej przeglądarce. */
export function markNotificationsRead(store: TabStore, list: readonly AppNotification[]) {
  const ops = markReadOps(list, new Date());
  if (ops.length) void store.mutateMany(ops).catch(() => undefined);
  setBell(reminderBellUpdate(bellState(), list.filter((n) => !n.readAt), "read"));
}

export function dismissNotifications(store: TabStore, list: readonly AppNotification[]) {
  const ops = dismissOps(list, new Date());
  if (ops.length) void store.mutateMany(ops).catch(() => undefined);
  setBell(reminderBellUpdate(bellState(), list, "dismissed"));
}

/**
 * „Przypomnij za N min” przy przypomnieniu w dzwonku: jednorazowe przypomnienie (`reminders`, jak „Odłóż”
 * z powiadomienia push — wyśle je `reminders-push`, a po wybiciu wróci tu), poprzednie odłożenie znika, a ten
 * wpis — z dzwonka. Wynik: godzina nowego przypomnienia albo `null`, gdy zadanie już zamknięte / usunięte.
 */
export async function snoozeReminderNotification(store: TabStore, n: AppNotification, userId: string, minutes: number, timeZone: string | undefined): Promise<LocalTime | null> {
  if (!n.taskId) return null;
  const [tasks, rows] = await Promise.all([
    store.query<{ id: string; kind: string; status: string; time_zone: string | null }>("select id, kind, status, time_zone from tasks where id = ? and deleted_at is null", [n.taskId]),
    store.query<{ id: string; task_id: string; kind: string; offset_min: number | null; at_date: string | null; at_time: string | null }>(
      "select id, task_id, kind, offset_min, at_date, at_time from reminders where task_id = ? and deleted_at is null",
      [n.taskId],
    ),
  ]);
  const task = tasks[0];
  if (!task) return null;
  const snoozed = snoozeReminderOps(
    { id: task.id, kind: task.kind === "habit" ? "habit" : "task", status: task.status as ViewTask["status"] },
    rows.map(toReminderRule),
    { userId, now: new Date(), timeZone: task.time_zone ?? timeZone, minutes },
  );
  if (!snoozed) return null;
  await store.mutateMany(snoozed.ops);
  dismissNotifications(store, [n]);
  return snoozed.time;
}

// ── Przypomnienia w dzwonku ──────────────────────────────────────────────────────────────────

const BELL_KEY = "tp-reminder-bell";
let bell: ReminderBellState | null = null;
const bellListeners = new Set<() => void>();

function bellState(): ReminderBellState {
  if (bell) return bell;
  try {
    const raw = JSON.parse(localStorage.getItem(BELL_KEY) ?? "null") as Partial<ReminderBellState> | null;
    bell = {
      read: Array.isArray(raw?.read) ? raw.read.filter((x): x is string => typeof x === "string") : [],
      dismissed: Array.isArray(raw?.dismissed) ? raw.dismissed.filter((x): x is string => typeof x === "string") : [],
      readBefore: typeof raw?.readBefore === "string" ? raw.readBefore : null,
      popped: Array.isArray(raw?.popped) ? raw.popped.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    bell = EMPTY_REMINDER_BELL;
  }
  return bell;
}

function setBell(next: ReminderBellState) {
  if (next === bellState()) return;
  bell = next;
  try {
    localStorage.setItem(BELL_KEY, JSON.stringify(next));
  } catch {
    // Pełny localStorage — stan zostaje w tej karcie.
  }
  bellListeners.forEach((l) => l());
}

/** Stan przypomnień w dzwonku tej przeglądarki (wspólny dla kart). */
export const useReminderBell = (): ReminderBellState => useSyncExternalStore(subscribeBell, bellState, () => EMPTY_REMINDER_BELL);

/** Zamknięcie okna przypomnienia bez decyzji: wpis zostaje w dzwonku (nieprzeczytany), okno nie wraca. */
export function closeReminderPopups(list: readonly AppNotification[]) {
  setBell(reminderBellUpdate(bellState(), list, "popped"));
}

function subscribeBell(listener: () => void) {
  bellListeners.add(listener);
  // Inne karty tej przeglądarki.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== BELL_KEY) return;
    bell = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    bellListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

type TaskRow = Record<string, string | number | null>;

const parse = (value: string | number | null): unknown => {
  try {
    return typeof value === "string" ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

/** Wybite przypomnienia z lokalnych danych; przeliczane co minutę i przy zmianie zadań / przypomnień. */
function useReminderNotifications(
  store: TabStore | null,
  userId: string,
  timeZone: string | undefined,
  defaultTime: string,
  prefs: NotificationPrefs,
): AppNotification[] {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const state = useReminderBell();
  const today = localDateAt(now, timeZone);
  const { rows: rules } = useLocalQuery<{ id: string; task_id: string; kind: string; offset_min: number | null; at_date: string | null; at_time: string | null }>(
    store,
    // Przypomnienie dostaje jego autor (jak `reminders-push`) — we wspólnej przestrzeni nie dzwonią cudze.
    "select id, task_id, kind, offset_min, at_date, at_time from reminders where deleted_at is null and (created_by is null or created_by = ?)",
    [userId],
    ["reminders"],
  );
  const { rows: tasks } = useLocalQuery<TaskRow>(
    store,
    `select t.id, t.kind, t.status, t.title, t.due_date, t.due_time, t.recurrence, t.time_zone, t.habit, t.assignee_id, t.created_by, l.scope_id as workspace_id,
            coalesce((select s.members from _scopes s where s.id = l.scope_id), 1) as members
       from tasks t join lists l on l.id = t.list_id
      where t.deleted_at is null and t.status not in ('done', 'cancelled')
        and (t.id in (select r.task_id from reminders r where r.deleted_at is null and (r.created_by is null or r.created_by = ?))
             or (t.due_time is not null and t.due_date between ? and ?))`,
    // Do jutra: automatyczne przypomnienie może wybić przed terminem (`autoReminderOffset`).
    [userId, addDays(today, -1), addDays(today, 1)],
    ["tasks", "reminders", "lists"],
  );
  const { rows: mine } = useLocalQuery<{ scope_id: string; collaborator_id: string }>(
    store,
    "select scope_id, collaborator_id from scope_collaborators where user_id = ?",
    [userId],
    ["scope_collaborators"],
  );
  const { rows: joined } = useLocalQuery<{ task_id: string }>(
    store,
    `select distinct p.task_id from task_participants p join scope_collaborators sc on sc.collaborator_id = p.collaborator_id
      where p.deleted_at is null and sc.user_id = ?`,
    [userId],
    ["task_participants", "scope_collaborators"],
  );
  const { rows: completions } = useLocalQuery<TaskRow>(
    store,
    `select c.task_id, c.occurrence_date, c.kind, c.value from task_completions c join tasks t on t.id = c.task_id
      where c.deleted_at is null and t.kind = 'habit' and c.occurrence_date >= ?`,
    [addDays(today, -2)],
    ["task_completions"],
  );
  // Minuta jako zależność: bez przeliczania co 30 s, gdy nic nowego nie mogło wybić.
  const minute = Math.floor(now.getTime() / 60_000);
  return useMemo(() => {
    const at = new Date(minute * 60_000 + 59_999);
    const list: (ReminderTask & { workspaceId: string; assigneeId: string | null; createdBy: string | null })[] = tasks.map((r) => {
      const recurrence = Recurrence.safeParse(parse(r.recurrence));
      const habit = HabitSettings.safeParse(parse(r.habit));
      return {
        id: String(r.id),
        kind: r.kind === "habit" ? "habit" : "task",
        status: String(r.status) as ReminderTask["status"],
        title: String(r.title ?? ""),
        dueDate: (r.due_date as ReminderTask["dueDate"]) ?? null,
        dueTime: (r.due_time as ReminderTask["dueTime"]) ?? null,
        recurrence: recurrence.success ? recurrence.data : null,
        habit: habit.success ? habit.data : null,
        timeZone: (r.time_zone as string | null) ?? null,
        workspaceId: String(r.workspace_id ?? ""),
        assigneeId: (r.assignee_id as string | null) ?? null,
        createdBy: (r.created_by as string | null) ?? null,
      };
    });
    const byId = new Map(list.map((t) => [t.id, t]));
    const participating = new Set(joined.map((r) => r.task_id));
    const mineSet = new Set(mine.map((c) => `${c.scope_id}|${c.collaborator_id}`));
    // Udostępnione przestrzenie (więcej niż jeden członek): odpowiedzialny dostaje też przypomnienie w chwili terminu.
    const shared = new Set(tasks.filter((r) => Number(r.members) > 1).map((r) => String(r.workspace_id)));
    const assigned = assigneeReminderRules(list, {
      userId,
      shared,
      createdBy: (id) => byId.get(id)?.createdBy ?? userId,
      accountOf: (workspaceId, id) => (mineSet.has(`${workspaceId}|${id}`) ? userId : null),
      participates: (id) => participating.has(id),
      prefs,
    });
    const habitCompletions = new Map<string, HabitCompletion[]>();
    for (const c of completions) {
      const id = String(c.task_id);
      habitCompletions.set(id, [...(habitCompletions.get(id) ?? []), toHabitCompletion(c as { occurrence_date: unknown; kind: unknown; value: unknown })]);
    }
    const fires = reminderFireTimes(list, [...rules.map(toReminderRule), ...assigned], {
      from: new Date(at.getTime() - REMINDER_BELL_WINDOW_MS),
      to: at,
      timeZone,
      defaultTime: defaultTime as LocalTime,
      habitCompletions,
    });
    return reminderNotifications(fires, byId, state, at, timeZone);
  }, [tasks, rules, mine, joined, completions, state, minute, userId, timeZone, defaultTime, prefs]);
}

export const OPEN_TASK_EVENT = "tp-open-task";

/** Otwarcie zadania w panelu z miejsca poza `Shell` (nagłówek). */
export function requestOpenTask(taskId: string) {
  window.dispatchEvent(new CustomEvent(OPEN_TASK_EVENT, { detail: { taskId } }));
}
