/**
 * Strona startowa (v1.x): liczby do pulpitu — kafelki, ukończone / dodane w ostatnich dniach, obciążenie
 * najbliższego tygodnia, otwarte według priorytetu, postęp list i projektów, seria dni z ukończonym zadaniem.
 * Wszystko z lokalnych danych, więc pulpit działa offline; aplikacje tylko rysują wynik.
 */
import { addDays, localDateAt, zonedInstant } from './dates.ts';
import { focusMinutes, type TimeEntryLike } from './focus.ts';
import { habitsForDay, type HabitCompletion } from './habits.ts';
import type { LocalDate, Priority } from './schemas/primitives.ts';
import { isOpen, selectInbox, selectToday, selectUpcoming, type ViewContext, type ViewTask } from './views.ts';
import type { SeriesDone } from './week-summary.ts';

/** Ile dni wstecz pokazuje wykres „Ukończone i dodane”. */
export const HOME_HISTORY_DAYS = 14;
/** Ile dni naprzód pokazuje „Najbliższe dni” (od dziś). */
export const HOME_UPCOMING_DAYS = 7;
/** Ile list / projektów pokazuje „Postęp”. */
export const HOME_LISTS = 5;

export interface HomeStatsInput {
  tasks: readonly ViewTask[];
  /** Listy: id, rodzaj (Inbox nie trafia do „Postępu”). */
  lists: readonly { id: string; kind: string }[];
  /** Ukończone wystąpienia serii od co najmniej `homeStatsFrom(today) − 2 dni`. */
  seriesDone: readonly SeriesDone[];
  habitCompletions: ReadonlyMap<string, readonly HabitCompletion[]>;
  /** Odcinki trybu skupienia (minuty dziś). */
  timeEntries: readonly TimeEntryLike[];
  now: Date;
}

export interface HomeDay {
  date: LocalDate;
  done: number;
  created: number;
}

export interface HomeLoadDay {
  date: LocalDate;
  items: number;
  /** Suma „Czas (min)” zadań dnia (bez czasu = 0). */
  minutes: number;
}

export interface HomeListProgress {
  listId: string;
  open: number;
  done: number;
}

export interface HomeStats {
  open: number;
  inbox: number;
  today: number;
  overdue: number;
  doneToday: number;
  /** Ostatnie 7 dni do dziś włącznie. */
  doneWeek: number;
  /** To samo w poprzednich 7 dniach — do strzałki trendu. */
  donePrevWeek: number;
  createdWeek: number;
  /** Kolejne dni z co najmniej jednym ukończonym zadaniem, kończąc na dziś (albo wczoraj, gdy dziś jeszcze nic). */
  streak: number;
  focusTodayMin: number;
  habitsDone: number;
  habitsTotal: number;
  /** Od najstarszego; ostatni = dziś. */
  history: HomeDay[];
  upcoming: HomeLoadDay[];
  /** Otwarte zadania według priorytetu (1 = krytyczny … 4 = niski). */
  priority: Record<Priority, number>;
  /** Listy i projekty z największą liczbą otwartych zadań (bez Inboxu). */
  lists: HomeListProgress[];
}

/** Pierwszy dzień historii, z której liczy się pulpit (seria dni może sięgać dalej — wtedy ucina się na nim). */
export const homeStatsFrom = (today: LocalDate): LocalDate => addDays(today, -(HOME_HISTORY_DAYS * 2 - 1));

export function homeStats(input: HomeStatsInput, ctx: ViewContext): HomeStats {
  const { today, timeZone } = ctx;
  const from = homeStatsFrom(today);
  const tasks = input.tasks.filter((t) => !ctx.workspaceId || t.workspaceId === ctx.workspaceId);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Odległe daty odpadają po samym zapisie, bez `Intl` (strefy to najwyżej doba w każdą stronę).
  const early = addDays(from, -2);
  const late = addDays(today, 2);
  const dayOf = (instant: string): LocalDate | null => {
    const day = instant.slice(0, 10);
    if (day < early || day > late) return null;
    const local = localDateAt(instant, timeZone);
    return local >= from && local <= today ? local : null;
  };

  const done = new Map<LocalDate, number>();
  const created = new Map<LocalDate, number>();
  const bump = (map: Map<LocalDate, number>, day: LocalDate) => map.set(day, (map.get(day) ?? 0) + 1);
  // Ostatnie wystąpienie serii zamyka też samo zadanie (ta sama chwila) — liczy się raz (jak `weekFacts`).
  const series = new Set<string>();
  for (const s of input.seriesDone) {
    const task = byId.get(s.taskId);
    const day = task?.kind === 'task' ? dayOf(s.completedAt) : null;
    if (!day) continue;
    bump(done, day);
    series.add(`${s.taskId}|${Date.parse(s.completedAt)}`);
  }
  for (const t of tasks) {
    if (t.kind !== 'task') continue;
    const made = dayOf(t.createdAt);
    if (made) bump(created, made);
    if (t.status !== 'done' || !t.completedAt) continue;
    const day = dayOf(t.completedAt);
    if (day && !series.has(`${t.id}|${Date.parse(t.completedAt)}`)) bump(done, day);
  }

  const history: HomeDay[] = [];
  for (let i = HOME_HISTORY_DAYS - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    history.push({ date, done: done.get(date) ?? 0, created: created.get(date) ?? 0 });
  }
  const sumDays = (map: Map<LocalDate, number>, start: number, count: number) => {
    let n = 0;
    for (let i = start; i < start + count; i++) n += map.get(addDays(today, -i)) ?? 0;
    return n;
  };

  let streak = 0;
  for (let i = done.get(today) ? 0 : 1; addDays(today, -i) >= from && done.get(addDays(today, -i)); i++) streak++;

  const open = tasks.filter((t) => t.kind === 'task' && isOpen(t));
  const inboxIds = new Set(input.lists.filter((l) => l.kind === 'inbox').map((l) => l.id));
  const todayView = selectToday(tasks, ctx, { completed: 'hidden' });

  const priority: Record<Priority, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const t of open) priority[t.priority]++;

  const perList = new Map<string, HomeListProgress>();
  for (const t of tasks) {
    if (t.kind !== 'task' || t.status === 'cancelled' || inboxIds.has(t.listId)) continue;
    const entry = perList.get(t.listId) ?? { listId: t.listId, open: 0, done: 0 };
    if (t.status === 'done') entry.done++;
    else entry.open++;
    perList.set(t.listId, entry);
  }
  const known = new Set(input.lists.map((l) => l.id));
  const lists = [...perList.values()]
    .filter((l) => l.open > 0 && known.has(l.listId))
    .sort((a, b) => b.open - a.open || (a.listId < b.listId ? -1 : 1))
    .slice(0, HOME_LISTS);

  const upcoming = selectUpcoming(tasks, ctx, { days: HOME_UPCOMING_DAYS }).days.map(({ date, items }) => {
    const real = items.filter((i) => i.task.kind === 'task');
    return { date, items: real.length, minutes: real.reduce((n, i) => n + (i.task.durationMin ?? 0), 0) };
  });

  const habits = habitsForDay(tasks, input.habitCompletions, today, today, ctx.workspaceId);
  const focusTodayMin = focusMinutes(ctx.workspaceId ? input.timeEntries.filter((e) => e.taskId !== null && byId.has(e.taskId)) : input.timeEntries, input.now, {
    from: zonedInstant(today, '00:00', timeZone),
    to: zonedInstant(addDays(today, 1), '00:00', timeZone),
  });

  return {
    open: open.length,
    inbox: selectInbox(tasks, inboxIds, ctx).length,
    today: todayView.today.length,
    overdue: todayView.overdue.length,
    doneToday: done.get(today) ?? 0,
    doneWeek: sumDays(done, 0, 7),
    donePrevWeek: sumDays(done, 7, 7),
    createdWeek: sumDays(created, 0, 7),
    streak,
    focusTodayMin,
    habitsDone: habits.filter((h) => h.settled).length,
    habitsTotal: habits.length,
    history,
    upcoming,
    priority,
    lists,
  };
}

/** Ton kafelka pulpitu: `ok` = zielone tło (dobrze), `bad` = czerwonawe (coś nie tak), `info` = żółte (do wiadomości). */
export type HomeTone = 'ok' | 'bad' | 'info';

export interface HomeTileTones {
  today: HomeTone;
  overdue: HomeTone;
  inbox: HomeTone;
  open: HomeTone;
  doneToday: HomeTone;
  doneWeek: HomeTone;
  createdWeek: HomeTone;
  habits: HomeTone;
  focus: HomeTone;
}

/** Tony kafelków — jedna reguła dla webu i telefonu. */
export function homeTileTones(s: HomeStats): HomeTileTones {
  return {
    today: s.today ? 'info' : 'ok',
    overdue: s.overdue ? 'bad' : 'ok',
    inbox: s.inbox ? 'info' : 'ok',
    open: 'info',
    doneToday: s.doneToday ? 'ok' : 'info',
    doneWeek: s.doneWeek < s.donePrevWeek ? 'bad' : 'ok',
    createdWeek: s.createdWeek > s.doneWeek ? 'bad' : 'ok',
    habits: s.habitsDone === s.habitsTotal ? 'ok' : 'info',
    focus: s.focusTodayMin ? 'ok' : 'info',
  };
}

/** Postęp dnia na kafelku „Na dziś”: ukończone dziś wobec ukończonych + wciąż otwartych na dziś. */
export function homeTodayProgress(s: HomeStats): { done: number; total: number; pct: number } {
  const total = s.doneToday + s.today;
  return { done: s.doneToday, total, pct: total ? Math.round((s.doneToday / total) * 100) : 0 };
}
