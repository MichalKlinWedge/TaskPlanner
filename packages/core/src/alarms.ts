/**
 * Przypomnienie w trybie alarmu na telefonie (M8): pełnoekranowa plansza z tytułem, opisem i przyciskami
 * „Zakończ” / „Edytuj” / „Czekaj N min”. Alarm dzwoni bez JS (moduł natywny `task-alarm`), więc dostaje
 * z góry całą treść; tu są reguły: treść planszy i różnica między tym, co zaplanowane, a tym, co być powinno.
 */
import { dayMonth } from './format.ts';
import { habitNeedsReminder, type HabitCompletion } from './habits.ts';
import { parseMarkdown, spansText } from './markdown.ts';
import { reminderBody, type ReminderFire, type ReminderTask } from './reminders.ts';
import type { LocalDate } from './schemas/primitives.ts';

/** Sposób przypominania na telefonie (ustawienie urządzenia). */
export type ReminderMode = 'banner' | 'alarm';

export const ALARM_SNOOZE_CHOICES = [5, 10, 15, 30, 60] as const;
export const DEFAULT_ALARM_SNOOZE = 15;
/** Opis na planszy — dłuższy jest ucięty. */
export const ALARM_DESCRIPTION_LIMIT = 1000;

export interface AlarmEntry {
  id: string;
  taskId: string;
  /** Chwila alarmu (ms). */
  at: number;
  title: string;
  body: string;
  /** Wiersz pod tytułem po „Czekaj” — `body` („Za 10 min”) byłoby już nieaktualne. */
  snoozedBody: string;
  description: string;
  occurrenceDate: LocalDate | null;
  habit: boolean;
  snoozeMin: number;
  /** Po „Czekaj”. */
  snoozed?: boolean;
}

/** Opis zadania (Markdown) jako zwykły tekst na planszę: listy z punktorami, pola ☐ / ☑, tabele po wierszach. */
export function descriptionText(source: string | null | undefined, limit = ALARM_DESCRIPTION_LIMIT): string {
  const parts = parseMarkdown(source).map((b): string => {
    if (b.kind === 'code') return b.text;
    if (b.kind === 'rule') return '';
    if (b.kind === 'table') return [b.header, ...b.rows].map((row) => row.map(spansText).join(' · ')).join('\n');
    if (b.kind === 'list')
      return b.items
        .map((i) => `${'  '.repeat(i.depth)}${i.checked === undefined ? (i.ordered ? `${i.number ?? 1}.` : '•') : i.checked ? '☑' : '☐'} ${spansText(i.spans)}`)
        .join('\n');
    return spansText(b.spans);
  });
  const text = parts
    .filter((t) => t.trim())
    .join('\n\n')
    .trim();
  const chars = [...text];
  return chars.length > limit
    ? `${chars
        .slice(0, limit - 1)
        .join('')
        .trimEnd()}…`
    : text;
}

/** Wpis alarmu dla chwili przypomnienia `fire`. */
export function alarmEntry(
  id: string,
  task: ReminderTask,
  fire: Pick<ReminderFire, 'fireAt' | 'occurrenceDate' | 'dueAt'>,
  options: { description?: string | null; snoozeMin: number; timeZone?: string },
): AlarmEntry {
  const { title, body } = reminderBody(task, fire, fire.fireAt, task.timeZone ?? options.timeZone);
  const habit = task.kind === 'habit';
  const due = !habit && fire.occurrenceDate && fire.dueAt ? ` · termin ${dayMonth(fire.occurrenceDate)}${task.dueTime ? ` ${task.dueTime}` : ''}` : '';
  return {
    id,
    taskId: task.id,
    at: new Date(fire.fireAt).getTime(),
    title,
    body,
    snoozedBody: `Odłożone${due}`,
    description: descriptionText(options.description),
    occurrenceDate: fire.occurrenceDate,
    habit,
    snoozeMin: options.snoozeMin,
  };
}

/**
 * Czy odłożony albo dzwoniący alarm ma jeszcze o czym przypominać: zadanie istnieje i jest otwarte, jego termin
 * (wystąpienie serii) nie poszedł dalej, a dzień nawyku nie jest załatwiony.
 */
export function alarmStillDue(
  entry: Pick<AlarmEntry, 'occurrenceDate'>,
  task: ReminderTask | undefined,
  habitCompletions?: ReadonlyMap<string, readonly HabitCompletion[]>,
): boolean {
  if (!task || task.status === 'done' || task.status === 'cancelled') return false;
  if (task.kind === 'habit') {
    if (!entry.occurrenceDate || task.recurrence?.mode !== 'schedule') return true;
    return habitNeedsReminder({ ...(task.habit ?? {}), recurrence: task.recurrence }, habitCompletions?.get(task.id) ?? [], entry.occurrenceDate);
  }
  return !(entry.occurrenceDate && task.dueDate && task.dueDate > entry.occurrenceDate);
}

const FIELDS = ['taskId', 'at', 'title', 'body', 'snoozedBody', 'description', 'occurrenceDate', 'habit', 'snoozeMin'] as const satisfies readonly (keyof AlarmEntry)[];
const same = (a: AlarmEntry, b: AlarmEntry) => FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));

export interface AlarmPlan {
  /** Do zaplanowania (nowe i zmienione). */
  set: AlarmEntry[];
  /** Zaplanowane do odwołania. */
  cancel: string[];
  /** Dzwoniące do zamknięcia. */
  dismiss: string[];
}

/**
 * Różnica między `wanted` a stanem modułu natywnego. Alarm, którego chwila właśnie minęła, nie jest odwoływany
 * (system może go jeszcze nie dostarczyć) — chyba że nie ma już o czym przypominać.
 */
export function alarmPlan(
  wanted: readonly AlarmEntry[],
  state: { scheduled: readonly AlarmEntry[]; ringing: readonly AlarmEntry[] },
  now: number,
  stillDue: (entry: AlarmEntry) => boolean,
): AlarmPlan {
  const current = new Map(state.scheduled.map((e) => [e.id, e]));
  const ids = new Set(wanted.map((e) => e.id));
  return {
    set: wanted.filter((e) => {
      const old = current.get(e.id);
      return !old || !same(old, e);
    }),
    cancel: state.scheduled.filter((e) => !ids.has(e.id) && (e.snoozed || e.at <= now ? !stillDue(e) : true)).map((e) => e.id),
    dismiss: state.ringing.filter((e) => !stillDue(e)).map((e) => e.id),
  };
}
