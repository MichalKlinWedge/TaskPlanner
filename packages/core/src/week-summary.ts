/**
 * Podsumowanie tygodnia (v1.x) — krok przeglądu tygodnia. Wszystkie liczby liczy kod, z lokalnych danych,
 * więc krok działa też offline i bez konta AI; opis słowny (`ai-week-summary.ts`) tylko wstawia te same fakty.
 *
 * Tydzień = ostatnie 7 dni do dziś włącznie (jak krok „Nawyki w tygodniu”), obciążenie = następne 7 dni od jutra.
 */
import { addDays, isoWeekday, localDateAt } from './dates.ts';
import { focusWeek, type TimeEntryRecord } from './focus.ts';
import { dayLabel, formatMinutes, plural } from './format.ts';
import { habitStats, toHabit, type HabitCompletion } from './habits.ts';
import { needsDecision } from './review.ts';
import type { LocalDate } from './schemas/primitives.ts';
import type { WorkHours } from './time-blocking.ts';
import { isOpen, selectToday, selectUpcoming, type ViewContext, type ViewTask } from './views.ts';

/** Ukończone wystąpienie serii (`task_completions`, `kind = 'done'`) z chwilą ukończenia. */
export interface SeriesDone {
  taskId: string;
  completedAt: string;
}

export interface WeekFactsInput {
  tasks: readonly ViewTask[];
  /** Wystąpienia serii ukończone co najmniej od początku tygodnia (wcześniejsze są pomijane). */
  seriesDone: readonly SeriesDone[];
  /** Wszystkie wpisy nawyków. */
  habitCompletions: ReadonlyMap<string, readonly HabitCompletion[]>;
  timeEntries: readonly TimeEntryRecord[];
  workHours: WorkHours;
  now: Date;
}

export interface WeekHabit {
  taskId: string;
  /** Zaliczone okresy z możliwych w tygodniu (bez wolnych i trwającego). */
  done: number;
  possible: number;
}

export interface WeekDay {
  date: LocalDate;
  items: number;
  /** Suma podanych czasów zadań. */
  minutes: number;
}

export interface WeekFacts {
  from: LocalDate;
  to: LocalDate;
  /** Ukończone: zadania i wystąpienia serii, bez nawyków. */
  done: number;
  /** Malejąco po liczbie. */
  doneByList: { listId: string; count: number }[];
  /** Zadania z ukończonych (seria raz), od ostatnio ukończonego. */
  doneTaskIds: string[];
  /** Zadania dodane w tygodniu (także już ukończone). */
  created: number;
  overdue: number;
  /** Otwarte przekładane co najmniej `NEEDS_DECISION_AFTER` razy. */
  postponed: number;
  focusMin: number;
  pomodoros: number;
  habits: WeekHabit[];
  habitsDone: number;
  habitsPossible: number;
  /** Następne 7 dni od jutra, razem z wystąpieniami serii. */
  next: {
    items: number;
    minutes: number;
    /** Ile z `items` nie ma podanego czasu. */
    withoutDuration: number;
    /** Godziny pracy w tych dniach (Ustawienia). */
    workMin: number;
    days: WeekDay[];
    /** Dzień z największą liczbą zadań (przy remisie wcześniejszy); `null`, gdy nic nie ma. */
    busiest: WeekDay | null;
  };
}

/** Pierwszy dzień podsumowania. */
export const weekFactsFrom = (today: LocalDate): LocalDate => addDays(today, -6);

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** Fakty tygodnia w przestrzeni `ctx.workspaceId` (albo we wszystkich). */
export function weekFacts(input: WeekFactsInput, ctx: ViewContext): WeekFacts {
  const { today, timeZone } = ctx;
  const from = weekFactsFrom(today);
  const tasks = input.tasks.filter((t) => !ctx.workspaceId || t.workspaceId === ctx.workspaceId);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Odległe daty odpadają po samym zapisie, bez `Intl` (strefy to najwyżej doba w każdą stronę).
  const early = addDays(from, -2);
  const late = addDays(today, 2);
  const inWeek = (instant: string): boolean => {
    const day = instant.slice(0, 10);
    if (day < early || day > late) return false;
    const local = localDateAt(instant, timeZone);
    return local >= from && local <= today;
  };

  // Ukończone: ostatnie wystąpienie serii zamyka też samo zadanie (ta sama chwila) — liczy się raz.
  const done: { taskId: string; listId: string; at: number }[] = [];
  const series = new Set<string>();
  for (const s of input.seriesDone) {
    const task = byId.get(s.taskId);
    if (task?.kind !== 'task' || !inWeek(s.completedAt)) continue;
    const at = Date.parse(s.completedAt);
    done.push({ taskId: task.id, listId: task.listId, at });
    series.add(`${task.id}|${at}`);
  }
  let created = 0;
  for (const t of tasks) {
    if (t.kind !== 'task') continue;
    if (inWeek(t.createdAt)) created++;
    if (t.status !== 'done' || !t.completedAt || !inWeek(t.completedAt)) continue;
    const at = Date.parse(t.completedAt);
    if (!series.has(`${t.id}|${at}`)) done.push({ taskId: t.id, listId: t.listId, at });
  }
  done.sort((a, b) => b.at - a.at || (a.taskId < b.taskId ? -1 : 1));
  const lists = new Map<string, number>();
  for (const d of done) lists.set(d.listId, (lists.get(d.listId) ?? 0) + 1);

  const entries = ctx.workspaceId ? input.timeEntries.filter((e) => e.taskId !== null && byId.has(e.taskId)) : input.timeEntries;
  // Tydzień `focusWeek` kończący się dziś: zaczyna się w dniu tygodnia pierwszego dnia podsumowania.
  const focus = focusWeek(entries, tasks, { today, firstDayOfWeek: isoWeekday(from), timeZone, now: input.now });

  const habits = tasks.flatMap((t): WeekHabit[] => {
    const habit = t.kind === 'habit' && isOpen(t) ? toHabit(t) : null;
    if (!habit) return [];
    const rate = habitStats(habit, input.habitCompletions.get(t.id) ?? [], today).rates[7];
    return rate.possible ? [{ taskId: t.id, done: rate.done, possible: rate.possible }] : [];
  });

  const days = selectUpcoming(tasks, ctx, { days: 8 })
    .days.slice(1)
    .map(({ date, items }) => ({
      day: { date, items: items.length, minutes: sum(items.map((i) => i.task.durationMin ?? 0)) },
      without: items.filter((i) => !i.task.durationMin).length,
    }));
  const daily = Math.max(0, minutesOf(input.workHours.end) - minutesOf(input.workHours.start));

  return {
    from,
    to: today,
    done: done.length,
    doneByList: [...lists].map(([listId, count]) => ({ listId, count })).sort((a, b) => b.count - a.count || (a.listId < b.listId ? -1 : 1)),
    doneTaskIds: [...new Set(done.map((d) => d.taskId))],
    created,
    overdue: selectToday(tasks, ctx, { completed: 'hidden' }).overdue.length,
    postponed: tasks.filter((t) => t.kind === 'task' && isOpen(t) && needsDecision(t)).length,
    focusMin: focus.total,
    pomodoros: focus.pomodoros,
    habits,
    habitsDone: sum(habits.map((h) => h.done)),
    habitsPossible: sum(habits.map((h) => h.possible)),
    next: {
      items: sum(days.map((d) => d.day.items)),
      minutes: sum(days.map((d) => d.day.minutes)),
      withoutDuration: sum(days.map((d) => d.without)),
      workMin: daily * days.filter((d) => input.workHours.days.includes(isoWeekday(d.day.date))).length,
      days: days.map((d) => d.day),
      busiest: days.reduce<WeekDay | null>((best, { day }) => (day.items > (best?.items ?? 0) ? day : best), null),
    },
  };
}

// ── Fakty słowami ────────────────────────────────────────────────────────────────────────────

/** Fakt jako gotowa fraza z liczbą: `key` wstawia opis AI (`{ukonczone}`), `label` i `value` pokazuje aplikacja. */
export interface WeekFact {
  key: string;
  label: string;
  value: string;
  /** Fraza do zdania, zrozumiała sama z siebie („3 zaległe zadania”). */
  text: string;
}

/** Najwięcej list i nawyków wymienionych z nazwy. */
const MAX_LISTS = 5;
const MAX_HABITS = 8;

export interface WeekFactGroups {
  main: WeekFact[];
  lists: WeekFact[];
  habits: WeekFact[];
}

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

/** Fakty do pokazania (kafelki, listy, nawyki) i do wstawienia w opisie. Nazwy podaje aplikacja. */
export function weekFactTexts(facts: WeekFacts, names: { list: (id: string) => string; task: (id: string) => string }): WeekFactGroups {
  const { next } = facts;
  const main: WeekFact[] = [
    { key: 'ukonczone', label: 'Ukończone', value: String(facts.done), text: plural(facts.done, ['ukończone zadanie', 'ukończone zadania', 'ukończonych zadań']) },
    { key: 'nowe', label: 'Nowe', value: String(facts.created), text: plural(facts.created, ['nowe zadanie', 'nowe zadania', 'nowych zadań']) },
    { key: 'zalegle', label: 'Zaległe', value: String(facts.overdue), text: plural(facts.overdue, ['zaległe zadanie', 'zaległe zadania', 'zaległych zadań']) },
    {
      key: 'przekladane',
      label: 'Przekładane ≥ 3×',
      value: String(facts.postponed),
      text: plural(facts.postponed, ['wielokrotnie przekładane zadanie', 'wielokrotnie przekładane zadania', 'wielokrotnie przekładanych zadań']),
    },
  ];
  if (facts.focusMin) main.push({ key: 'skupienie', label: 'Skupienie', value: formatMinutes(facts.focusMin), text: `${formatMinutes(facts.focusMin)} skupienia` });
  if (facts.pomodoros) main.push({ key: 'pomodoro', label: 'Pomodoro', value: String(facts.pomodoros), text: `${facts.pomodoros} Pomodoro` });
  if (facts.habitsPossible) {
    const value = `${facts.habitsDone} z ${facts.habitsPossible}`;
    main.push({ key: 'nawyki', label: 'Nawyki', value, text: `nawyki wykonane ${value}` });
  }
  main.push({ key: 'przyszlosc', label: 'Następne 7 dni', value: String(next.items), text: `${plural(next.items, TASKS)} na najbliższy tydzień` });
  if (next.minutes) {
    main.push({ key: 'przyszlyCzas', label: 'Zaplanowany czas', value: formatMinutes(next.minutes), text: `${formatMinutes(next.minutes)} zaplanowanej pracy na najbliższy tydzień` });
  }
  if (next.busiest) {
    const day = dayLabel(next.busiest.date);
    main.push({ key: 'pelnyDzien', label: 'Najpełniejszy dzień', value: `${day} (${next.busiest.items})`, text: `${day} (${plural(next.busiest.items, TASKS)})` });
  }
  return {
    main,
    lists: facts.doneByList.slice(0, MAX_LISTS).map(({ listId, count }, i) => {
      const name = names.list(listId);
      return { key: `lista${i + 1}`, label: name, value: String(count), text: `${plural(count, ['ukończone zadanie', 'ukończone zadania', 'ukończonych zadań'])} w „${name}”` };
    }),
    habits: facts.habits.slice(0, MAX_HABITS).map(({ taskId, done, possible }, i) => {
      const name = names.task(taskId);
      return { key: `nawyk${i + 1}`, label: name, value: `${done} z ${possible}`, text: `„${name}” ${done} z ${possible}` };
    }),
  };
}

export const weekFactList = (groups: WeekFactGroups): WeekFact[] => [...groups.main, ...groups.lists, ...groups.habits];

/** „8 h z 40 h godzin pracy, 5 zadań bez podanego czasu”; pusty tekst, gdy nic nie zaplanowano. */
export function nextWeekNote({ next }: Pick<WeekFacts, 'next'>): string {
  if (!next.items) return '';
  const load = next.workMin ? `${formatMinutes(next.minutes)} z ${formatMinutes(next.workMin)} godzin pracy` : formatMinutes(next.minutes);
  return next.withoutDuration ? `${load}, ${plural(next.withoutDuration, TASKS)} bez podanego czasu` : load;
}
