/**
 * Przypomnienia (SPECYFIKACJA M8, §7.6): z czasu pływającego zadań (`due_date` + `due_time`) i wierszy
 * `reminders` liczy chwile wysłania w oknie (domyślnie 7 dni) w strefie urządzenia albo strefie
 * przypiętej do zadania. Używają tego telefon (planowanie lokalnych powiadomień, najwyżej 50 naraz)
 * i serwer (`reminders-push`, strefa z ustawień profilu) — oba liczą tak samo.
 *
 * - Względne: N minut przed terminem; zadanie bez godziny — przed domyślną godziną z ustawień.
 *   Seria według harmonogramu: każde wystąpienie od bieżącego terminu; „po ukończeniu” — tylko bieżące.
 * - Bezwzględne: konkretny dzień i godzina lokalna, raz (bez powtarzania z serią).
 * - Zamknięte zadania nie przypominają (serwer sprawdza też status w chwili wysyłki).
 * - Nawyk (Etap 8): względne przypomnienie w każdy dzień reguły przed porą nawyku (`habit.time`) albo
 *   domyślną godziną; jednorazowe (`absolute`) — w wybranym dniu i godzinie; z `habitCompletions`
 *   pomija dni już zaliczone, wolne i okresy z osiągniętym celem.
 */
import { addDays, localDateAt, zonedInstant } from './dates.ts';
import { relativeDay } from './format.ts';
import { habitNeedsReminder, type HabitCompletion, type HabitSettings } from './habits.ts';
import { occurrences, type Recurrence } from './recurrence.ts';
import type { LocalDate, LocalTime, ReminderKind } from './schemas/primitives.ts';
import type { ViewTask } from './views.ts';

/** Zadanie do przypomnień: pola widoku + opcjonalna strefa przypięta do zadania (`tasks.time_zone`). */
export type ReminderTask = Pick<ViewTask, 'id' | 'kind' | 'status' | 'title' | 'dueDate' | 'dueTime'> & {
  recurrence: Recurrence | null;
  timeZone?: string | null;
  /** Ustawienia nawyku (`tasks.habit`) — pora i cel. */
  habit?: HabitSettings | null;
};

/** Wiersz `reminders` (camelCase). */
export interface ReminderRule {
  id: string;
  taskId: string;
  kind: ReminderKind;
  offsetMin: number | null;
  atDate: LocalDate | null;
  atTime: LocalTime | null;
}

export interface ReminderFire {
  /** Stały klucz (przypomnienie + wystąpienie) — id powiadomienia, bez duplikatów przy przeplanowaniu. */
  key: string;
  taskId: string;
  reminderId: string;
  /** Dzień wystąpienia, którego dotyczy (seria) albo termin zadania. */
  occurrenceDate: LocalDate | null;
  /** Chwila wysłania (ISO, UTC). */
  fireAt: string;
  /** Termin wystąpienia jako chwila (ISO) — do treści „za 30 min”; `null` dla bezwzględnego bez terminu. */
  dueAt: string | null;
}

export interface ReminderWindow {
  /** Początek okna (włącznie). */
  from: Date | string;
  /** Koniec okna (wyłącznie); domyślnie `from` + 7 dni. */
  to?: Date | string;
  /** Strefa urządzenia / profilu; brak = strefa środowiska. */
  timeZone?: string;
  /** Godzina dla zadań bez godziny (`profiles.settings.defaultReminderTime`). */
  defaultTime: LocalTime;
  /** Najwięcej wyników (telefon: 50 zaplanowanych naraz). */
  limit?: number;
  /** Wpisy nawyków (id zadania → wpisy) — bez nich nawyk przypomina w każdy dzień reguły. */
  habitCompletions?: ReadonlyMap<string, readonly HabitCompletion[]>;
}

export const REMINDER_WINDOW_DAYS = 7;
export const MAX_SCHEDULED_REMINDERS = 50;

const isClosed = (t: Pick<ViewTask, 'status'>) => t.status === 'done' || t.status === 'cancelled';

/**
 * Dni wystąpień: bieżący termin i (seria według harmonogramu) kolejne wystąpienia od `since` do `until`.
 * Zaległa seria przypomina dalej o kolejnych wystąpieniach — jak w „Nadchodzących”.
 */
function occurrenceDates(task: ReminderTask, since: LocalDate, until: LocalDate): LocalDate[] {
  if (!task.dueDate) return [];
  if (task.recurrence?.mode !== 'schedule') return [task.dueDate];
  const start = addDays(task.dueDate, 1) > since ? addDays(task.dueDate, 1) : since;
  return [task.dueDate, ...occurrences(task.recurrence, { from: start, to: until, limit: 400 })];
}

/**
 * Chwile przypomnień w oknie `[from, to)`, od najwcześniejszej, najwyżej `limit`. Wynik jest
 * deterministyczny — to samo wejście daje te same klucze (przeplanowanie nie dubluje powiadomień).
 */
export function reminderFireTimes(tasks: readonly ReminderTask[], rules: readonly ReminderRule[], window: ReminderWindow): ReminderFire[] {
  const from = new Date(window.from).getTime();
  const to = window.to ? new Date(window.to).getTime() : from + REMINDER_WINDOW_DAYS * 86_400_000;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const fires: ReminderFire[] = [];
  const push = (fire: Omit<ReminderFire, 'fireAt' | 'dueAt'> & { fireAt: number; dueAt: number | null }) => {
    if (fire.fireAt < from || fire.fireAt >= to) return;
    fires.push({ ...fire, fireAt: new Date(fire.fireAt).toISOString(), dueAt: fire.dueAt === null ? null : new Date(fire.dueAt).toISOString() });
  };

  for (const rule of rules) {
    const task = byId.get(rule.taskId);
    if (!task || isClosed(task)) continue;
    const zone = task.timeZone ?? window.timeZone;

    if (task.kind === 'habit') {
      if (task.recurrence?.mode !== 'schedule') continue;
      const habit = { ...(task.habit ?? {}), recurrence: task.recurrence };
      const done = window.habitCompletions?.get(task.id);
      if (rule.kind === 'absolute') {
        // Jednorazowe przypomnienie nawyku: dzień i godzina; pomijane, gdy ten dzień jest już zaliczony.
        if (!rule.atDate || !rule.atTime) continue;
        if (!habitNeedsReminder(habit, done ?? [], rule.atDate)) continue;
        push({ key: `${rule.id}:${rule.atDate}`, taskId: task.id, reminderId: rule.id, occurrenceDate: rule.atDate, fireAt: zonedInstant(rule.atDate, rule.atTime, zone).getTime(), dueAt: null });
        continue;
      }
      if (rule.offsetMin === null) continue;
      const since = localDateAt(new Date(from - 86_400_000), zone);
      const until = localDateAt(new Date(to + rule.offsetMin * 60_000 + 86_400_000), zone);
      for (const date of occurrences(task.recurrence, { from: since, to: until, limit: 400 })) {
        if (done && !habitNeedsReminder(habit, done, date)) continue;
        const dueAt = zonedInstant(date, task.habit?.time ?? window.defaultTime, zone).getTime();
        push({ key: `${rule.id}:${date}`, taskId: task.id, reminderId: rule.id, occurrenceDate: date, fireAt: dueAt - rule.offsetMin * 60_000, dueAt });
      }
      continue;
    }

    if (rule.kind === 'absolute') {
      if (!rule.atDate || !rule.atTime) continue;
      const dueAt = task.dueDate ? zonedInstant(task.dueDate, task.dueTime ?? window.defaultTime, zone).getTime() : null;
      push({ key: `${rule.id}:${rule.atDate}`, taskId: task.id, reminderId: rule.id, occurrenceDate: task.dueDate, fireAt: zonedInstant(rule.atDate, rule.atTime, zone).getTime(), dueAt });
      continue;
    }

    if (rule.offsetMin === null || !task.dueDate) continue;
    // Wystąpienia, których przypomnienie może wypaść w oknie: termin do końca okna + wyprzedzenie.
    const since = localDateAt(new Date(from - 86_400_000), zone);
    const until = localDateAt(new Date(to + rule.offsetMin * 60_000 + 86_400_000), zone);
    for (const date of occurrenceDates(task, since, until)) {
      const dueAt = zonedInstant(date, task.dueTime ?? window.defaultTime, zone).getTime();
      if (dueAt - rule.offsetMin * 60_000 >= to) continue;
      push({ key: `${rule.id}:${date}`, taskId: task.id, reminderId: rule.id, occurrenceDate: date, fireAt: dueAt - rule.offsetMin * 60_000, dueAt });
    }
  }

  fires.sort((a, b) => (a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : a.key < b.key ? -1 : 1));
  return fires.slice(0, window.limit ?? Infinity);
}

/** Wiersz lokalnej bazy `reminders` → `ReminderRule`. */
export const toReminderRule = (row: { id: string; task_id: string; kind: string; offset_min: number | null; at_date: string | null; at_time: string | null }): ReminderRule => ({
  id: row.id,
  taskId: row.task_id,
  kind: row.kind === 'absolute' ? 'absolute' : 'relative',
  offsetMin: row.offset_min === null ? null : Number(row.offset_min),
  atDate: row.at_date as LocalDate | null,
  atTime: row.at_time ? (row.at_time.slice(0, 5) as LocalTime) : null,
});

/**
 * Treść powiadomienia: tytuł zadania i kiedy jest termin („Termin: dziś 10:00”, „za 30 min”,
 * „Termin minął 15 min temu” przy odłożonym powiadomieniu).
 */
export function reminderBody(
  task: Pick<ReminderTask, 'title' | 'dueTime'> & Partial<Pick<ReminderTask, 'kind' | 'habit'>>,
  fire: Pick<ReminderFire, 'occurrenceDate' | 'dueAt'>,
  now: Date | string,
  timeZone?: string,
): { title: string; body: string } {
  const at = new Date(now).getTime();
  if (task.kind === 'habit') {
    const target = task.habit?.target;
    return { title: task.title, body: target === undefined ? 'Nawyk na dziś — odhacz, gdy zrobisz' : `Nawyk na dziś · cel ${target}${task.habit?.unit ? ` ${task.habit.unit}` : ''}` };
  }
  if (!fire.occurrenceDate || !fire.dueAt) return { title: task.title, body: 'Przypomnienie' };
  const due = new Date(fire.dueAt).getTime();
  const minutes = Math.round((due - at) / 60_000);
  const day = relativeDay(fire.occurrenceDate, localDateAt(new Date(at), timeZone));
  const when = task.dueTime ? `${day} ${task.dueTime}` : day;
  if (task.dueTime && minutes > 0 && minutes < 120) return { title: task.title, body: `Za ${minutes} min (${task.dueTime})` };
  if (task.dueTime && minutes <= 0 && minutes > -120) return { title: task.title, body: minutes === 0 ? `Teraz (${task.dueTime})` : `Termin minął ${-minutes} min temu` };
  return { title: task.title, body: `Termin: ${when}` };
}

/** Odłożenie powiadomienia („Odłóż 10 min / 1 h”): nowa chwila od teraz. „Do jutra” przesuwa termin zadania (`bulkTaskOps`). */
export const SNOOZE_MINUTES = { '10m': 10, '1h': 60 } as const;
export const snoozeUntil = (now: Date | string, minutes: number): string => new Date(new Date(now).getTime() + minutes * 60_000).toISOString();
