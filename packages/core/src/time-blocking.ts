/**
 * Time-blocking (SPECYFIKACJA M11, §7.4): plan dnia z zadań z godziną (bloki o długości
 * `duration_min`) i wydarzeń kalendarzy, nakładanie się (ostrzeżenie w kalendarzu i w „Dziś”), wolne
 * okna w godzinach pracy oraz łatki zadania przy przeciąganiu na godzinę. Czas zadań jest pływający —
 * blok liczy się w strefie urządzenia (albo strefie przypiętej do zadania), wydarzenia są chwilami.
 */
import { addDays, isoWeekday, localDateTimeAt, zonedInstant } from './dates.ts';
import { compareCode, compareText, formatMinutes, relativeDay } from './format.ts';
import type { DayState, HabitSlot } from './habits.ts';
import { occurrences, type Recurrence } from './recurrence.ts';
import type { LocalDate, LocalTime } from './schemas/primitives.ts';
import type { ViewTask } from './views.ts';

export type BlockTask = Pick<ViewTask, 'id' | 'title' | 'status' | 'dueDate' | 'dueTime' | 'durationMin' | 'priority'> & {
  recurrence: Recurrence | null;
  timeZone?: string | null;
};

/** Wydarzenie kalendarza (`calendar_events`, kalendarz telefonu): chwile albo daty całodniowe. */
export interface CalendarEventLike {
  id: string;
  title: string;
  allDay: boolean;
  startAt?: string | null;
  endAt?: string | null;
  startDate?: LocalDate | null;
  /** Koniec całodniowego bez włączenia (jak w iCalendar). */
  endDate?: LocalDate | null;
  /** `false` = „wolny” — nie liczy się do konfliktów ani zajętości. Domyślnie zajęty. */
  busy?: boolean;
}

export interface Block {
  /** `habit` — nawyk z porą (`habitSlots`), blok o domyślnej długości, nieprzesuwalny. */
  kind: 'task' | 'event' | 'habit';
  id: string;
  title: string;
  /** Minuty od północy dnia (może być < 0 albo > długości dnia dla bloków przechodzących przez północ). */
  startMin: number;
  endMin: number;
  startAt: string;
  endAt: string;
  /** Zadanie ukończone / anulowane albo wydarzenie „wolny” — bez konfliktów i zajętości. */
  passive: boolean;
  /** Przyszłe wystąpienie serii (do odczytu, jak w „Nadchodzących”). */
  virtual?: boolean;
  /** Stan dnia nawyku (tylko `kind = 'habit'`). */
  habitState?: DayState;
}

/** Nawyk zrobiony albo z dniem wolnym — jak ukończone zadanie (bez konfliktów i zajętości). */
const habitSettled = (state: DayState) => state === 'done' || state === 'skipped';

interface PlanOptions {
  timeZone?: string;
  defaultDurationMin?: number;
  /** Nawyki z porą (`habitSlots`) — bloki obok zadań; brane tylko te z danego dnia. */
  habits?: readonly HabitSlot[];
}

export interface AllDayItem {
  kind: 'task' | 'event';
  id: string;
  title: string;
}

export interface DayPlan {
  date: LocalDate;
  /** Długość dnia w minutach (1380 / 1500 przy zmianie czasu). */
  dayMinutes: number;
  timed: Block[];
  allDay: AllDayItem[];
}

export const DEFAULT_BLOCK_MIN = 30;

const closed = (t: Pick<ViewTask, 'status'>) => t.status === 'done' || t.status === 'cancelled';

/** Czy zadanie (albo jego seria) wypada w danym dniu; `virtual` — przyszłe wystąpienie serii. */
function onDay(task: BlockTask, date: LocalDate): { yes: boolean; virtual: boolean } {
  if (!task.dueDate) return { yes: false, virtual: false };
  if (task.dueDate === date) return { yes: true, virtual: false };
  if (task.recurrence?.mode !== 'schedule' || date < task.dueDate || closed(task)) return { yes: false, virtual: false };
  return { yes: occurrences(task.recurrence, { from: date, to: date, limit: 1 }).length > 0, virtual: true };
}

/**
 * Plan dnia: bloki z godziną (zadania i wydarzenia, przycięte do dnia) od najwcześniejszego oraz
 * pozycje całodniowe (zadania z datą bez godziny, wydarzenia całodniowe).
 */
export function blocksForDay(
  tasks: readonly BlockTask[],
  events: readonly CalendarEventLike[],
  date: LocalDate,
  { timeZone, defaultDurationMin = DEFAULT_BLOCK_MIN, habits = [] }: PlanOptions = {},
): DayPlan {
  const dayStart = zonedInstant(date, '00:00', timeZone).getTime();
  const dayEnd = zonedInstant(addDays(date, 1), '00:00', timeZone).getTime();
  const minutes = (ms: number) => Math.round((ms - dayStart) / 60_000);
  const timed: Block[] = [];
  const allDay: AllDayItem[] = [];

  for (const task of tasks) {
    const { yes, virtual } = onDay(task, date);
    if (!yes) continue;
    if (!task.dueTime) {
      allDay.push({ kind: 'task', id: task.id, title: task.title });
      continue;
    }
    const start = zonedInstant(date, task.dueTime, task.timeZone ?? timeZone).getTime();
    const end = start + (task.durationMin ?? defaultDurationMin) * 60_000;
    timed.push({ kind: 'task', id: task.id, title: task.title, startMin: minutes(start), endMin: minutes(end), startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), passive: closed(task), ...(virtual && { virtual }) });
  }

  for (const slot of habits) {
    if (slot.date !== date) continue;
    const start = zonedInstant(date, slot.time, timeZone).getTime();
    const end = start + defaultDurationMin * 60_000;
    timed.push({ kind: 'habit', id: slot.id, title: slot.title, startMin: minutes(start), endMin: minutes(end), startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), passive: habitSettled(slot.state), ...(slot.future && { virtual: true }), habitState: slot.state });
  }

  for (const event of events) {
    if (event.allDay) {
      if (event.startDate && event.startDate <= date && date < (event.endDate ?? addDays(event.startDate, 1))) allDay.push({ kind: 'event', id: event.id, title: event.title });
      continue;
    }
    if (!event.startAt || !event.endAt) continue;
    const start = new Date(event.startAt).getTime();
    const end = new Date(event.endAt).getTime();
    if (end <= dayStart || start >= dayEnd) continue;
    timed.push({ kind: 'event', id: event.id, title: event.title, startMin: minutes(start), endMin: minutes(end), startAt: event.startAt, endAt: event.endAt, passive: event.busy === false });
  }

  timed.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin || (a.kind === b.kind ? 0 : a.kind === 'event' ? -1 : 1) || compareCode(a.id, b.id));
  return { date, dayMinutes: minutes(dayEnd), timed, allDay };
}

export interface Conflict {
  a: Block;
  b: Block;
  /** Wspólne minuty. */
  overlapMin: number;
}

/**
 * Nakładające się bloki, w których jest choć jedno zadanie (dwa wydarzenia z kalendarza to nie nasz
 * konflikt). Bez ukończonych zadań, wydarzeń „wolny” i przyszłych wystąpień serii.
 */
export function conflicts(blocks: readonly Block[]): Conflict[] {
  const active = blocks.filter((b) => !b.passive && !b.virtual).sort((a, b) => a.startMin - b.startMin);
  const out: Conflict[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length && active[j]!.startMin < active[i]!.endMin; j++) {
      const [a, b] = [active[i]!, active[j]!];
      if (a.kind === 'event' && b.kind === 'event') continue;
      out.push({ a, b, overlapMin: Math.min(a.endMin, b.endMin) - b.startMin });
    }
  }
  return out;
}

/** Id bloków w konflikcie (obramowanie + ikona). */
export const conflictIds = (list: readonly Conflict[]): Set<string> => new Set(list.flatMap((c) => [c.a.id, c.b.id]));

export interface WorkHours {
  /** Dni robocze ISO (1 = poniedziałek). */
  days: readonly number[];
  start: LocalTime;
  end: LocalTime;
}

export interface FreeSlot {
  startMin: number;
  endMin: number;
}

const toMin = (time: LocalTime) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * Godziny pracy dnia w minutach od północy (jak bloki; przy zmianie czasu liczone zegarem ściennym) —
 * wolne okna i cieniowanie osi dnia poza pracą. Dzień wolny albo koniec nie później niż początek → `null`.
 */
export function workWindow(date: LocalDate, work: WorkHours, timeZone?: string): FreeSlot | null {
  if (!work.days.includes(isoWeekday(date))) return null;
  const dayStart = zonedInstant(date, '00:00', timeZone).getTime();
  const wall = (time: LocalTime) => Math.round((zonedInstant(date, time, timeZone).getTime() - dayStart) / 60_000);
  if (toMin(work.end) <= toMin(work.start)) return null;
  const startMin = wall(work.start);
  const endMin = wall(work.end);
  return endMin > startMin ? { startMin, endMin } : null;
}

/**
 * Wolne okna w godzinach pracy dnia (podświetlenie w widoku dnia): przerwy między zajętymi blokami
 * (aktywne zadania i wydarzenia „zajęty”) nie krótsze niż `minMinutes`. Dzień wolny od pracy → brak.
 * Minuty jak w blokach (od północy dnia — przy zmianie czasu godziny pracy liczą się zegarem ściennym).
 */
export function freeSlots(plan: Pick<DayPlan, 'date' | 'timed'>, work: WorkHours, { minMinutes = 15, timeZone }: { minMinutes?: number; timeZone?: string } = {}): FreeSlot[] {
  const window = workWindow(plan.date, work, timeZone);
  if (!window) return [];
  const { startMin: from, endMin: to } = window;
  const busy = plan.timed.filter((b) => !b.passive && !b.virtual && b.endMin > from && b.startMin < to).sort((a, b) => a.startMin - b.startMin);
  const slots: FreeSlot[] = [];
  let cursor = from;
  for (const block of busy) {
    if (block.startMin - cursor >= minMinutes) slots.push({ startMin: cursor, endMin: block.startMin });
    cursor = Math.max(cursor, block.endMin);
  }
  if (to - cursor >= minMinutes) slots.push({ startMin: cursor, endMin: to });
  return slots;
}

/** Zegar ścienny `RRRR-MM-DDTGG:MM` + minuty (czas pływający — bez stref). */
export function addWallMinutes(wall: string, minutes: number): string {
  const ms = Date.parse(`${wall.slice(0, 16)}:00Z`) + Math.round(minutes) * 60_000;
  return new Date(ms).toISOString().slice(0, 16);
}

/** Pozycja kalendarza (FullCalendar na webie, oś dnia na telefonie) — czas jako zegar ścienny. */
export interface CalendarEntry {
  /** Unikalne w zakresie: `task:<id>:<dzień>` / `habit:<id>:<dzień>` / `event:<id>`. */
  key: string;
  kind: 'task' | 'event' | 'habit';
  id: string;
  title: string;
  /** Dzień wystąpienia (wydarzenie — pierwszy dzień w zakresie). */
  date: LocalDate;
  allDay: boolean;
  /** `RRRR-MM-DDTGG:MM` (z godziną) albo data (całodniowe; `end` bez włączenia). */
  start: string;
  end: string;
  passive: boolean;
  virtual: boolean;
  /** Nakłada się z innym aktywnym blokiem (zadanie ↔ zadanie / wydarzenie). */
  conflict: boolean;
  /** Stan dnia nawyku (tylko `kind = 'habit'`). */
  habitState?: DayState;
}

const notCancelled = (t: BlockTask) => t.status !== 'cancelled';

/**
 * Pozycje kalendarza dla dni `[from, to)`: zadania z godziną jako bloki (zegar ścienny z `due_time`
 * i `duration_min`), zadania z datą bez godziny i wydarzenia całodniowe w wierszu „cały dzień”,
 * przyszłe wystąpienia serii jako wirtualne, konflikty z `conflicts` liczone per dzień. Wydarzenie
 * wielodniowe — jedna pozycja (od pierwszego dnia w zakresie). Anulowane zadania pomijane.
 */
export function calendarEntries(
  tasks: readonly BlockTask[],
  events: readonly CalendarEventLike[],
  from: LocalDate,
  to: LocalDate,
  { timeZone, defaultDurationMin = DEFAULT_BLOCK_MIN, habits = [] }: PlanOptions = {},
): CalendarEntry[] {
  const candidates = tasks.filter((t) => notCancelled(t) && t.dueDate && t.dueDate < to && (t.dueDate >= from || (t.recurrence?.mode === 'schedule' && !closed(t))));
  const byId = new Map(candidates.map((t) => [t.id, t]));
  const out: CalendarEntry[] = [];
  const eventEntries = new Map<string, CalendarEntry>();

  for (let date = from; date < to; date = addDays(date, 1)) {
    const plan = blocksForDay(candidates, events, date, { timeZone, defaultDurationMin, habits });
    const hot = conflictIds(conflicts(plan.timed));
    for (const item of plan.allDay) {
      if (item.kind === 'task') {
        const task = byId.get(item.id)!;
        out.push({ key: `task:${item.id}:${date}`, kind: 'task', id: item.id, title: item.title, date, allDay: true, start: date, end: addDays(date, 1), passive: closed(task), virtual: task.dueDate !== date, conflict: false });
      } else if (!eventEntries.has(item.id)) {
        const event = events.find((e) => e.id === item.id)!;
        eventEntries.set(item.id, { key: `event:${item.id}`, kind: 'event', id: item.id, title: item.title, date, allDay: true, start: event.startDate!, end: event.endDate ?? addDays(event.startDate!, 1), passive: event.busy === false, virtual: false, conflict: false });
      }
    }
    for (const block of plan.timed) {
      if (block.kind === 'habit') {
        const start = localDateTimeAt(block.startAt, timeZone);
        out.push({ key: `habit:${block.id}:${date}`, kind: 'habit', id: block.id, title: block.title, date, allDay: false, start, end: addWallMinutes(start, block.endMin - block.startMin), passive: block.passive, virtual: block.virtual === true, conflict: hot.has(block.id), habitState: block.habitState! });
        continue;
      }
      if (block.kind === 'task') {
        const task = byId.get(block.id)!;
        const start = `${date}T${task.dueTime}`;
        out.push({ key: `task:${block.id}:${date}`, kind: 'task', id: block.id, title: block.title, date, allDay: false, start, end: addWallMinutes(start, block.endMin - block.startMin), passive: block.passive, virtual: block.virtual === true, conflict: hot.has(block.id) });
        continue;
      }
      const seen = eventEntries.get(block.id);
      if (seen) seen.conflict ||= hot.has(block.id);
      else eventEntries.set(block.id, { key: `event:${block.id}`, kind: 'event', id: block.id, title: block.title, date, allDay: false, start: localDateTimeAt(block.startAt, timeZone), end: localDateTimeAt(block.endAt, timeZone), passive: block.passive, virtual: false, conflict: hot.has(block.id) });
    }
  }
  return [...out, ...eventEntries.values()];
}

export interface AgendaDay {
  date: LocalDate;
  /** Całodniowe najpierw (wydarzenia przed zadaniami), potem od najwcześniejszej godziny w tym dniu. */
  entries: CalendarEntry[];
}

/**
 * Agenda dni `[from, to)` z pozycji `calendarEntries` (tydzień i miesiąc na telefonie): zadania
 * i nawyki w swoim dniu, wydarzenie (także wielodniowe) w każdym dniu, który obejmuje — wydarzenie
 * z godziną kończące się o północy nie zajmuje następnego dnia.
 */
export function agendaDays(entries: readonly CalendarEntry[], from: LocalDate, to: LocalDate): AgendaDay[] {
  const days = new Map<LocalDate, CalendarEntry[]>();
  for (let date = from; date < to; date = addDays(date, 1)) days.set(date, []);
  for (const entry of entries) {
    if (entry.kind !== 'event') {
      days.get(entry.date)?.push(entry);
      continue;
    }
    const first = entry.start.slice(0, 10);
    const endDay = entry.end.slice(0, 10);
    const until = entry.allDay || entry.end.slice(11, 16) === '00:00' ? endDay : addDays(endDay, 1);
    const last = until > first ? until : addDays(first, 1);
    for (let date = first < from ? from : first; date < last && date < to; date = addDays(date, 1)) days.get(date)?.push(entry);
  }
  return [...days].map(([date, list]) => {
    const startOn = (e: CalendarEntry) => (e.allDay ? '' : e.start.slice(0, 10) < date ? `${date}T00:00` : e.start);
    const eventFirst = (e: CalendarEntry) => (e.allDay && e.kind === 'event' ? 0 : 1);
    return { date, entries: list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || eventFirst(a) - eventFirst(b) || compareCode(startOn(a), startOn(b)) || compareText(a.title, b.title)) };
  });
}

/**
 * Wolne okna dnia (`freeSlots`) jako zegar ścienny — do podświetlenia w widoku dnia kalendarza.
 */
export function freeSlotTimes(
  tasks: readonly BlockTask[],
  events: readonly CalendarEventLike[],
  date: LocalDate,
  work: WorkHours,
  { timeZone, defaultDurationMin, minMinutes, habits }: PlanOptions & { minMinutes?: number } = {},
): { start: string; end: string }[] {
  const plan = blocksForDay(tasks.filter(notCancelled), events, date, { timeZone, defaultDurationMin, habits });
  const dayStart = zonedInstant(date, '00:00', timeZone).getTime();
  const wall = (min: number) => localDateTimeAt(new Date(dayStart + min * 60_000), timeZone);
  return freeSlots(plan, work, { timeZone, minMinutes }).map((s) => ({ start: wall(s.startMin), end: wall(s.endMin) }));
}

/**
 * Układ osi dnia (plan dnia na webie, oś dnia na telefonie): nakładające się bloki obok siebie.
 * Grupa = ciąg bloków połączonych nakładaniem; w grupie każdy blok dostaje pierwszą wolną kolumnę,
 * `lanes` — liczba kolumn grupy (szerokość bloku = 1 / `lanes`). `minMinutes` — najmniejsza długość
 * bloku na ekranie (krótki blok ma minimalną wysokość i przy drobnej skali zasłoniłby następny).
 */
export function blockLanes(blocks: readonly Pick<Block, 'id' | 'kind' | 'startMin' | 'endMin'>[], minMinutes = 0): Map<string, { lane: number; lanes: number }> {
  const out = new Map<string, { lane: number; lanes: number }>();
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  let group: { key: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    for (const g of group) out.set(g.key, { lane: g.lane, lanes: laneEnds.length });
    group = [];
    laneEnds = [];
    groupEnd = -Infinity;
  };
  for (const block of sorted) {
    if (block.startMin >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= block.startMin);
    if (lane < 0) lane = laneEnds.push(0) - 1;
    const end = Math.max(block.endMin, block.startMin + minMinutes);
    laneEnds[lane] = end;
    groupEnd = Math.max(groupEnd, end);
    group.push({ key: `${block.kind}:${block.id}`, lane });
  }
  flush();
  return out;
}

/** Zaokrąglenie minut do siatki (przeciąganie w kalendarzu; domyślnie co 15 min). */
export const snapMinutes = (minutes: number, step = 15): number => Math.round(minutes / step) * step;

/** Wysokość wiersza osi dnia w kalendarzu (min) — do wyboru; domyślnie pół godziny. */
export const CALENDAR_SLOTS = [15, 30, 60] as const;
export type CalendarSlot = (typeof CALENDAR_SLOTS)[number];
export const DEFAULT_CALENDAR_SLOT: CalendarSlot = 30;

/** Zapisany wybór wysokości wiersza; brak albo nieznana wartość → domyślna. */
export const parseCalendarSlot = (stored: string | null): CalendarSlot => CALENDAR_SLOTS.find((s) => String(s) === stored) ?? DEFAULT_CALENDAR_SLOT;

/** Kliknięte miejsce osi dnia → początek wiersza pod kursorem (domyślnie pół godziny), najpóźniej ostatni wiersz doby. */
export const clickedTime = (minutes: number, slot: CalendarSlot = DEFAULT_CALENDAR_SLOT): LocalTime =>
  minutesToTime(Math.min(Math.max(Math.floor(minutes / slot) * slot, 0), 1440 - slot));

/** Minuty od północy → `GG:MM` (0–1439). */
export const minutesToTime = (minutes: number): LocalTime => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` as LocalTime;
};

/**
 * Upuszczenie zadania na godzinę (M11): termin, godzina i czas trwania (szacunek zadania albo
 * domyślny). Początek zakresu po nowym terminie przesuwa się na termin (reguła wiersza zadania).
 */
export function scheduleBlockPatch(
  task: Pick<ViewTask, 'startDate' | 'durationMin'>,
  date: LocalDate,
  startMin: number,
  { durationMin, defaultDurationMin = DEFAULT_BLOCK_MIN }: { durationMin?: number; defaultDurationMin?: number } = {},
): Record<string, unknown> {
  const patch: Record<string, unknown> = { due_date: date, due_time: minutesToTime(startMin), duration_min: Math.max(5, Math.round(durationMin ?? task.durationMin ?? defaultDurationMin)) };
  if (task.startDate && task.startDate > date) patch.start_date = date;
  return patch;
}

/** Zmiana długości bloku (rozciągnięcie krawędzi), co najmniej 5 min. */
export const resizeBlockPatch = (startMin: number, endMin: number): Record<string, unknown> => ({ duration_min: Math.max(5, Math.round(endMin - startMin)) });

/** Blok z powrotem do panelu zadań: zostaje dzień, znika godzina (czas trwania zostaje jako szacunek). */
export const unscheduleBlockPatch = (): Record<string, unknown> => ({ due_time: null });

/**
 * Kiedy jest wydarzenie kalendarza zewnętrznego (okienko szczegółów w kalendarzu): „dziś · 10:00–11:30
 * (1 h 30 min)”, „pt 27 lis 22:00 – sob 28 lis 01:00”, „jutro · cały dzień”, „pt 27 lis – ndz 29 lis · cały
 * dzień”. Godziny na zegarze ściennym strefy `timeZone`; koniec całodniowego jest bez włączenia.
 */
export function calendarEventWhen(event: Pick<CalendarEventLike, 'allDay' | 'startAt' | 'endAt' | 'startDate' | 'endDate'>, today: LocalDate, timeZone?: string): string {
  if (event.allDay) {
    if (!event.startDate) return 'cały dzień';
    const last = event.endDate && event.endDate > addDays(event.startDate, 1) ? addDays(event.endDate, -1) : event.startDate;
    return `${relativeDay(event.startDate, today)}${last !== event.startDate ? ` – ${relativeDay(last, today)}` : ''} · cały dzień`;
  }
  if (!event.startAt) return '';
  const start = localDateTimeAt(event.startAt, timeZone);
  const end = event.endAt ? localDateTimeAt(event.endAt, timeZone) : start;
  const [startDay, startTime] = [start.slice(0, 10), start.slice(11)];
  const [endDay, endTime] = [end.slice(0, 10), end.slice(11)];
  if (startDay !== endDay) return `${relativeDay(startDay, today)} ${startTime} – ${relativeDay(endDay, today)} ${endTime}`;
  const minutes = event.endAt ? Math.round((Date.parse(event.endAt) - Date.parse(event.startAt)) / 60_000) : 0;
  return `${relativeDay(startDay, today)} · ${startTime}${minutes > 0 ? `–${endTime} (${formatMinutes(minutes)})` : ''}`;
}
