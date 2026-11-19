/**
 * Przegląd dnia i tygodnia (SPECYFIKACJA M16, §7.8). Kolejki liczą się z tych samych reguł co
 * widoki (`views.ts`); akcja przeglądu to łatka pól zadania, którą aplikacja zapisuje przez
 * `mutate` (ukończenie i usunięcie mają własne ścieżki — seria, kosz).
 */
import { z } from 'zod';

import { addDays, daysBetween, isoWeekday, localDateAt, localDateTimeAt } from './dates.ts';
import { habitDays, type DayState, type HabitCompletion } from './habits.ts';
import type { ScheduleRecurrence } from './recurrence.ts';
import { LocalDate, type ListKind, type LocalTime, type ProjectStatus } from './schemas/primitives.ts';
import type { BulkAction, TaskOp } from './tasks.ts';
import { isOpen, selectInbox, selectToday, selectUpcoming, type UpcomingView, type ViewContext, type ViewTask } from './views.ts';

/** Od tylu przesunięć zadanie jest oznaczane do decyzji (zrób, zmniejsz, usuń). */
export const NEEDS_DECISION_AFTER = 3;
/** „Oczekuje” dłużej niż tyle dni trafia do przeglądu tygodnia. */
export const WAITING_DAYS = 7;

export const needsDecision = (task: Pick<ViewTask, 'postponeCount'>): boolean => task.postponeCount >= NEEDS_DECISION_AFTER;

export interface ReviewItem {
  task: ViewTask;
  section: 'overdue' | 'today';
  needsDecision: boolean;
}

/** Przegląd dnia: najpierw zaległe (od najstarszych), potem dzisiejsze nieukończone. */
export function dailyReviewQueue(tasks: readonly ViewTask[], ctx: ViewContext): ReviewItem[] {
  const { overdue, today } = selectToday(tasks, ctx, { completed: 'hidden' });
  const item = (section: ReviewItem['section']) => (task: ViewTask) => ({ task, section, needsDecision: needsDecision(task) });
  return [...overdue.map(item('overdue')), ...today.map(item('today'))];
}

/** Decyzja przy zadaniu (klawisze 1–6 na webie). */
export const ReviewAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done') }),
  z.object({ kind: z.literal('today') }),
  z.object({ kind: z.literal('tomorrow') }),
  z.object({ kind: z.literal('date'), date: LocalDate }),
  z.object({ kind: z.literal('someday') }),
  z.object({ kind: z.literal('delete') }),
]);
export type ReviewAction = z.infer<typeof ReviewAction>;

export interface TaskPatch {
  dueDate: LocalDate | null;
  dueTime?: null;
  startDate?: LocalDate | null;
  postponeCount?: number;
}

/**
 * Łatka terminu dla „Dziś / Jutro / Wybierz datę / Kiedyś”. Godzina zostaje (spotkanie o 9:00
 * jutro też o 9:00), zakres wielodniowy przesuwa się w całości; przesunięcie na później i „Kiedyś”
 * zwiększają `postpone_count`. `null` = nic do zapisania (ukończenie / usunięcie, ten sam dzień,
 * „Kiedyś” dla serii — seria bez terminu przestałaby się powtarzać).
 */
export function reschedulePatch(task: ViewTask, action: ReviewAction, ctx: ViewContext): TaskPatch | null {
  if (action.kind === 'done' || action.kind === 'delete') return null;
  const target = action.kind === 'today' ? ctx.today : action.kind === 'tomorrow' ? addDays(ctx.today, 1) : action.kind === 'date' ? action.date : null;
  if (target === task.dueDate) return null;
  const later = target === null || !task.dueDate || target > task.dueDate;
  const postponeCount = later && task.dueDate ? task.postponeCount + 1 : undefined;
  if (target === null) {
    if (task.recurrence) return null;
    return { dueDate: null, dueTime: null, startDate: null, ...(postponeCount !== undefined && { postponeCount }) };
  }
  const patch: TaskPatch = { dueDate: target };
  if (task.startDate && task.dueDate) patch.startDate = addDays(task.startDate, daysBetween(task.dueDate, target));
  if (postponeCount !== undefined) patch.postponeCount = postponeCount;
  return patch;
}

export interface ReviewList {
  id: string;
  workspaceId: string;
  kind: ListKind;
  /** Status projektu (`kind = 'project'`). */
  status: ProjectStatus | null;
  archivedAt?: string | null;
}

export interface WeeklyReview {
  /** 1. Inbox do zera. */
  inbox: ViewTask[];
  /** 2. Zaległe. */
  overdue: ViewTask[];
  /** 3. Aktywne projekty bez następnego kroku (bez otwartego zadania z terminem). */
  projectsWithoutNext: ReviewList[];
  /** 4. „Oczekuje” dłużej niż `WAITING_DAYS`. */
  waiting: { task: ViewTask; days: number }[];
  /** 5. Nadchodzący tydzień (obok wydarzenia kalendarza). */
  upcoming: UpcomingView;
  /** 6. Nawyki — ostatnie 7 dni. */
  habits: { task: ViewTask; days: { date: LocalDate; state: DayState }[] }[];
  /** Przesuwane ≥ 3 razy — do decyzji. */
  needsDecision: ViewTask[];
}

/** Kroki przeglądu tygodnia (M16), w kolejności asystenta. */
export function weeklyReview(
  input: { tasks: readonly ViewTask[]; lists: readonly ReviewList[]; completions?: ReadonlyMap<string, readonly HabitCompletion[]> },
  ctx: ViewContext,
): WeeklyReview {
  const { today } = ctx;
  const inWorkspace = (workspaceId: string) => !ctx.workspaceId || workspaceId === ctx.workspaceId;
  const lists = input.lists.filter((l) => !l.archivedAt && inWorkspace(l.workspaceId));
  const tasks = input.tasks.filter((t) => inWorkspace(t.workspaceId));
  const open = tasks.filter((t) => t.kind === 'task' && isOpen(t));

  const withNext = new Set(open.filter((t) => t.dueDate).map((t) => t.listId));
  const sinceStatus = (t: ViewTask) => daysBetween(localDateAt(t.statusChangedAt ?? t.createdAt, ctx.timeZone), today);

  return {
    inbox: selectInbox(tasks, new Set(lists.filter((l) => l.kind === 'inbox').map((l) => l.id)), ctx),
    overdue: selectToday(tasks, ctx, { completed: 'hidden' }).overdue,
    projectsWithoutNext: lists.filter((l) => l.kind === 'project' && l.status === 'active' && !withNext.has(l.id)),
    waiting: open
      .filter((t) => t.status === 'waiting')
      .map((task) => ({ task, days: sinceStatus(task) }))
      .filter((w) => w.days > WAITING_DAYS)
      .sort((a, b) => b.days - a.days),
    upcoming: selectUpcoming(tasks, ctx, { days: 7 }),
    habits: tasks
      .filter((t) => t.kind === 'habit' && isOpen(t) && t.recurrence?.mode === 'schedule')
      .map((task) => ({
        task,
        days: habitDays({ ...task.habit, recurrence: task.recurrence as ScheduleRecurrence }, input.completions?.get(task.id) ?? [], addDays(today, -6), today, today),
      })),
    needsDecision: open.filter(needsDecision),
  };
}

/** Zawartość `review_sessions.stats`. */
export const ReviewStats = z.object({
  reviewed: z.number().int().min(0),
  done: z.number().int().min(0),
  rescheduled: z.number().int().min(0),
  someday: z.number().int().min(0),
  deleted: z.number().int().min(0),
  /** Ile z przejrzanych było oznaczonych do decyzji. */
  needsDecision: z.number().int().min(0),
});
export type ReviewStats = z.infer<typeof ReviewStats>;

/** Statystyki sesji z dziennika decyzji (ostatnia decyzja przy zadaniu się liczy). */
export function reviewStats(log: readonly { task: ViewTask; action: ReviewAction }[]): ReviewStats {
  const last = new Map(log.map((e) => [e.task.id, e]));
  const stats: ReviewStats = { reviewed: last.size, done: 0, rescheduled: 0, someday: 0, deleted: 0, needsDecision: 0 };
  for (const { task, action } of last.values()) {
    if (action.kind === 'done') stats.done++;
    else if (action.kind === 'delete') stats.deleted++;
    else if (action.kind === 'someday') stats.someday++;
    else stats.rescheduled++;
    if (needsDecision(task)) stats.needsDecision++;
  }
  return stats;
}

// ── Asystent przeglądu w aplikacji (Etap 9) ──────────────────────────────────────────────────

/** Decyzja przeglądu jako akcja zbiorcza (`bulkTaskOps` — te same reguły i „Cofnij” co w widokach). */
export const reviewBulkAction = (action: ReviewAction): BulkAction => (action.kind === 'done' ? { kind: 'complete' } : action);

export type ReviewKind = 'daily' | 'weekly';

/** Początek sesji (`review_sessions`, zakres osobisty); koniec dopisuje `reviewFinishOp`. */
export const reviewStartOp = (id: string, kind: ReviewKind, now: Date): TaskOp => ({
  table: 'review_sessions',
  id,
  patch: { kind, started_at: now.toISOString(), finished_at: null, stats: null },
});

export const reviewFinishOp = (id: string, stats: ReviewStats, now: Date): TaskOp => ({ table: 'review_sessions', id, patch: { finished_at: now.toISOString(), stats } });

export interface ReviewSchedule {
  dailyReview: { enabled: boolean; time: LocalTime };
  weeklyReview: { enabled: boolean; weekday: number; time: LocalTime };
}

/**
 * Przeglądy, o których pora przypomnieć: włączone, godzina (w strefie użytkownika) minęła, a dziś
 * nie było jeszcze przypomnienia ani skończonej sesji tego rodzaju (`last` — daty lokalne).
 * Przegląd tygodnia tylko w swój dzień tygodnia.
 */
export function reviewsDue(schedule: ReviewSchedule, now: Date, { timeZone, last = {} }: { timeZone?: string; last?: Partial<Record<ReviewKind, LocalDate | null>> }): ReviewKind[] {
  const local = localDateTimeAt(now, timeZone);
  const today = local.slice(0, 10) as LocalDate;
  const time = local.slice(11, 16);
  const due: ReviewKind[] = [];
  if (schedule.weeklyReview.enabled && isoWeekday(today) === schedule.weeklyReview.weekday && time >= schedule.weeklyReview.time && last.weekly !== today) due.push('weekly');
  if (schedule.dailyReview.enabled && time >= schedule.dailyReview.time && last.daily !== today) due.push('daily');
  return due;
}

export interface DailySummary {
  /** Ukończone dziś (zadania, bez nawyków). */
  doneToday: ViewTask[];
  /** Plan na jutro: zadania z terminem jutro (z serii — bieżące wystąpienie). */
  tomorrow: ViewTask[];
}

/** Koniec przeglądu dnia (M16): podsumowanie i plan na jutro. */
export function dailySummary(tasks: readonly ViewTask[], ctx: ViewContext): DailySummary {
  const inWorkspace = (t: ViewTask) => !ctx.workspaceId || t.workspaceId === ctx.workspaceId;
  const doneToday = tasks.filter((t) => inWorkspace(t) && t.kind === 'task' && t.status === 'done' && t.completedAt && localDateAt(t.completedAt, ctx.timeZone) === ctx.today);
  const tomorrow = selectToday(tasks, { ...ctx, today: addDays(ctx.today, 1) }, { completed: 'hidden' }).today.filter((t) => t.kind === 'task');
  return { doneToday, tomorrow };
}
