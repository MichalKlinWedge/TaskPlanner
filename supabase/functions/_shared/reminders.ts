/**
 * Plan wysyłek Web Push (`reminders-push`, SPECYFIKACJA M8 web): z wierszy bazy liczy przypomnienia
 * należne w oknie `[now − lookback, now + lead)` tak samo jak telefon (`core/reminders.ts`), w strefie
 * i z domyślną godziną z ustawień profilu, i rozdziela je na urządzenia użytkownika, które mają włączone
 * przypomnienia i subskrypcję push. Przypomnienie dostaje autor wiersza `reminders` (`created_by`),
 * a w udostępnionej przestrzeni osoba odpowiedzialna dodatkowo automatyczne w chwili terminu (`assigned`
 * — RPC `assignee_reminder_tasks`, która sprawdza też członkostwo i ukryte listy).
 * Nawyk (Etap 8) przypomina o swojej porze w dni reguły, z pominięciem dni już zaliczonych / wolnych
 * (`completions`); powiadomienie ma wtedy akcję „Zrobione” (`payload.habit`, `payload.date` — Service Worker).
 * Tryb skupienia (Etap 7): koniec etapu z `profiles.focus` (`core` `focusEndPush`) — powiadomienie także
 * przy zamkniętej karcie (`payload.focus`; Service Worker pomija je, gdy karta aplikacji jest na wierzchu).
 * Bez Deno — testowane w Node (`tools/edge-tests`).
 */
import { focusEndPush, parseFocusState } from '../../../packages/core/src/focus.ts';
import { HabitSettings, toHabitCompletion, type HabitCompletion } from '../../../packages/core/src/habits.ts';
import { assigneeReminderRule, reminderBody, reminderFireTimes, toReminderRule, type ReminderTask } from '../../../packages/core/src/reminders.ts';
import { Recurrence } from '../../../packages/core/src/recurrence.ts';
import { ProfileSettings, PushSubscriptionJson } from '../../../packages/core/src/schemas/model.ts';

/** Okno: spóźnione do 10 min (przerwa crona, ponowienie) i do 30 s naprzód (cron startuje chwilę przed). */
export const LOOKBACK_MS = 10 * 60_000;
export const LEAD_MS = 30_000;

export interface DeviceRow {
  id: string;
  scope_id: string;
  platform: string;
  reminder_channel: string;
  push_subscription: unknown;
  deleted_at: string | null;
}

export interface ReminderRow {
  id: string;
  task_id: string;
  kind: string;
  offset_min: number | null;
  at_date: string | null;
  at_time: string | null;
  created_by: string | null;
  /** Zakres przypomnienia (przestrzeń zadania) — do sprawdzenia, czy autor nadal do niej należy. */
  scope_id?: string;
  tasks: {
    id: string;
    /** Lista zadania — przypomnienie z listy ukrytej przed autorem (gościem) nie dzwoni. */
    list_id?: string;
    kind: string;
    status: string;
    title: string;
    due_date: string | null;
    due_time: string | null;
    recurrence: unknown;
    habit?: unknown;
    time_zone: string | null;
    deleted_at: string | null;
  } | null;
}

/** Wiersz `task_completions` nawyku (ostatnie dni). */
export interface CompletionRow {
  task_id: string;
  occurrence_date: string;
  kind: string;
  value: number | null;
}

export interface ProfileRow {
  id: string;
  settings: unknown;
  /** Stan timera skupienia (`profiles.focus`). */
  focus?: unknown;
}

export interface PlannedPush {
  userId: string;
  deviceId: string;
  fireKey: string;
  /** `null` — koniec etapu skupienia bez zadania. */
  taskId: string | null;
  fireAt: string;
  subscription: PushSubscriptionJson;
  payload: { key: string; title: string; body: string; url: string; taskId?: string; habit?: true; date?: string; focus?: true };
}

/** Urządzenia, które dostają Web Push: przeglądarka z włączonymi przypomnieniami i ważną subskrypcją. */
export function pushDevices(devices: readonly DeviceRow[], { allowHttp = false } = {}): (DeviceRow & { subscription: PushSubscriptionJson })[] {
  const out: (DeviceRow & { subscription: PushSubscriptionJson })[] = [];
  for (const d of devices) {
    if (d.deleted_at || d.platform !== 'web' || d.reminder_channel !== 'enabled') continue;
    const sub = PushSubscriptionJson.safeParse(d.push_subscription);
    if (!sub.success || !(allowHttp || sub.data.endpoint.startsWith('https://'))) continue;
    out.push({ ...d, subscription: sub.data });
  }
  return out;
}

/** Członkostwo w zakresie (`scope_members`). */
export interface MembershipRow {
  scope_id: string;
  user_id: string;
  role?: string;
}

/** Lista ukryta przed gośćmi (`lists.guest_access = 'hidden'`). */
export interface HiddenListRow {
  id: string;
  scope_id: string;
}

/** Zadanie z automatycznym przypomnieniem konta `user_id` (RPC `assignee_reminder_tasks`). */
export type AssignedTaskRow = { user_id: string } & Omit<NonNullable<ReminderRow['tasks']>, 'list_id' | 'habit' | 'deleted_at'>;

const reminderTask = (t: Omit<NonNullable<ReminderRow['tasks']>, 'list_id' | 'deleted_at'>): ReminderTask => {
  const rec = t.recurrence ? Recurrence.safeParse(t.recurrence) : null;
  const habit = t.kind === 'habit' && t.habit ? HabitSettings.safeParse(t.habit) : null;
  return {
    id: t.id,
    kind: t.kind as ReminderTask['kind'],
    status: t.status as ReminderTask['status'],
    title: t.title,
    dueDate: t.due_date as ReminderTask['dueDate'],
    dueTime: t.due_time ? (t.due_time.slice(0, 5) as ReminderTask['dueTime']) : null,
    recurrence: rec?.success ? rec.data : null,
    timeZone: t.time_zone,
    habit: habit?.success ? habit.data : null,
  };
};

export function planPushes(
  {
    devices,
    reminders,
    profiles,
    completions = [],
    memberships,
    hiddenLists = [],
    assigned = [],
  }: {
    devices: readonly DeviceRow[];
    reminders: readonly ReminderRow[];
    profiles: readonly ProfileRow[];
    completions?: readonly CompletionRow[];
    memberships?: readonly MembershipRow[];
    hiddenLists?: readonly HiddenListRow[];
    assigned?: readonly AssignedTaskRow[];
  },
  { now, allowHttp = false }: { now: Date | string; allowHttp?: boolean },
): PlannedPush[] {
  const at = new Date(now).getTime();
  const targets = pushDevices(devices, { allowHttp });
  const byUser = new Map<string, typeof targets>();
  for (const d of targets) byUser.set(d.scope_id, [...(byUser.get(d.scope_id) ?? []), d]);
  const settings = new Map(profiles.map((p) => [p.id, ProfileSettings.parse(p.settings ?? {})]));
  const focus = new Map(profiles.map((p) => [p.id, p.focus]));
  const habitCompletions = new Map<string, HabitCompletion[]>();
  for (const c of completions) habitCompletions.set(c.task_id, [...(habitCompletions.get(c.task_id) ?? []), toHabitCompletion(c)]);

  const member = new Set((memberships ?? []).map((m) => `${m.scope_id}:${m.user_id}`));
  const owner = new Set((memberships ?? []).filter((m) => m.role === 'owner').map((m) => `${m.scope_id}:${m.user_id}`));
  const hiddenScope = new Map(hiddenLists.map((l) => [l.id, l.scope_id]));
  /** Lista ukryta przed użytkownikiem (nie jest właścicielem jej przestrzeni). */
  const hiddenFor = (listId: string | undefined, userId: string) => {
    const scope = listId ? hiddenScope.get(listId) : undefined;
    return scope !== undefined && !owner.has(`${scope}:${userId}`);
  };

  const plan: PlannedPush[] = [];
  for (const [userId, userDevices] of byUser) {
    const s = settings.get(userId) ?? ProfileSettings.parse({});
    // Koniec etapu skupienia, który już minął (bez wyprzedzenia — powiadomienie nie przychodzi przed końcem).
    const end = focusEndPush(parseFocusState(focus.get(userId) ?? null), s.focus, { from: new Date(at - LOOKBACK_MS), to: new Date(at) });
    if (end) {
      for (const device of userDevices) {
        plan.push({
          userId,
          deviceId: device.id,
          fireKey: end.key,
          taskId: end.taskId,
          fireAt: end.endsAt,
          subscription: device.subscription,
          payload: { key: end.key, title: end.title, body: end.body, url: end.taskId ? `/#/focus/${end.taskId}` : '/#/focus', focus: true },
        });
      }
    }
    // Współdzielona przestrzeń (v1.x): przypomnienie dzwoni u autora, dopóki należy do przestrzeni.
    // Lista ukryta przed gościem: jego przypomnienia z niej milkną (wracają po odsłonięciu).
    const rows = reminders.filter(
      (r) =>
        r.created_by === userId &&
        r.tasks &&
        !r.tasks.deleted_at &&
        (!memberships || !r.scope_id || member.has(`${r.scope_id}:${userId}`)) &&
        !hiddenFor(r.tasks.list_id, userId),
    );
    const mine = assigned.filter((t) => t.user_id === userId);
    if (!rows.length && !mine.length) continue;
    const tasks = new Map<string, ReminderTask>();
    for (const t of mine) tasks.set(t.id, reminderTask(t));
    for (const r of rows) tasks.set(r.tasks!.id, reminderTask(r.tasks!));
    const fires = reminderFireTimes([...tasks.values()], [...rows.map(toReminderRule), ...mine.map((t) => assigneeReminderRule(t.id))], {
      from: new Date(at - LOOKBACK_MS),
      to: new Date(at + LEAD_MS),
      timeZone: s.timeZone,
      defaultTime: s.defaultReminderTime,
      habitCompletions,
    });
    for (const fire of fires) {
      const task = tasks.get(fire.taskId)!;
      const text = reminderBody(task, fire, now, task.timeZone ?? s.timeZone);
      for (const device of userDevices) {
        plan.push({
          userId,
          deviceId: device.id,
          fireKey: fire.key,
          taskId: fire.taskId,
          fireAt: fire.fireAt,
          subscription: device.subscription,
          payload: { key: fire.key, ...text, url: `/?task=${fire.taskId}`, taskId: fire.taskId, ...(task.kind === 'habit' && fire.occurrenceDate ? { habit: true as const, date: fire.occurrenceDate } : {}) },
        });
      }
    }
  }
  return plan;
}
