/**
 * Zadanie ↔ wydarzenie kalendarza „TaskPlanner” (Etap 12, SPECYFIKACJA M18). Czysty moduł (bez Deno
 * i bazy) — testy w `tools/edge-tests`.
 *
 * Zadanie z godziną ma czas pływający (`due_date` + `due_time` w strefie z ustawień) albo przypięty
 * (`time_zone`); w Google to chwila (`startMs`/`endMs`) ze strefą wyświetlania. `TaskProjection` to ten rzut —
 * zapisany w `calendar_task_links.pushed` jako stan, w którym obie strony były zgodne. Zmiana w Google →
 * do zadania idą tylko pola, które różnią się od tego stanu (scalanie trójstronne), więc równoległa zmiana
 * innego pola w aplikacji nie ginie.
 */
import { hashText } from './calendar.ts';
import type { GoogleEvent } from './google.ts';
import { isValidZone, zonedParts, zonedToInstant } from './time.ts';

/** Kolumny zadania potrzebne do rzutu. */
export interface TaskForCalendar {
  id: string;
  scope_id: string;
  kind: string;
  title: string;
  status: string;
  due_date: string | null;
  due_time: string | null;
  duration_min: number | null;
  time_zone: string | null;
  deleted_at: string | null;
}

export const TASK_COLUMNS = 'id, scope_id, kind, title, status, due_date, due_time, duration_min, time_zone, deleted_at';

export interface TaskProjection {
  title: string;
  startMs: number;
  endMs: number;
  /** Strefa, w której liczono czas ścienny (zadania, ustawień albo kalendarza). */
  zone: string;
  /** `false`: wydarzenie dodane w Google — jeszcze bez znacznika źródła, trzeba je dopisać. */
  marked?: false;
}

export interface CalendarContext {
  /** Strefa zadań bez `time_zone` (ustawienia → kalendarz „TaskPlanner” → Europe/Warsaw). */
  zone: string;
  defaultDurationMin: number;
  /** Przestrzenie wysyłane do tego kalendarza (pusty = żadna). */
  workspaceIds: ReadonlySet<string>;
}

export const MAX_DURATION_MIN = 10080;
const MINUTE = 60_000;

export const taskZone = (task: Pick<TaskForCalendar, 'time_zone'>, ctx: Pick<CalendarContext, 'zone'>) =>
  task.time_zone && isValidZone(task.time_zone) ? task.time_zone : ctx.zone;

/** Rzut zadania z godziną (bez sprawdzania przestrzeni); `null` = zadanie bez godziny. */
export function projectTask(task: TaskForCalendar, ctx: Pick<CalendarContext, 'zone' | 'defaultDurationMin'>): TaskProjection | null {
  if (!task.due_date || !task.due_time) return null;
  const zone = taskZone(task, ctx);
  const startMs = zonedToInstant(task.due_date, task.due_time, zone);
  const duration = Math.min(Math.max(task.duration_min ?? ctx.defaultDurationMin, 1), MAX_DURATION_MIN);
  return { title: task.title, startMs, endMs: startMs + duration * MINUTE, zone };
}

/** Czy zadanie powinno mieć wydarzenie: zwykłe (nie nawyk), żywe, nieanulowane, z godziną, z wybranej przestrzeni. */
export function desiredProjection(task: TaskForCalendar, ctx: CalendarContext): TaskProjection | null {
  if (task.deleted_at || task.kind !== 'task' || task.status === 'cancelled' || !ctx.workspaceIds.has(task.scope_id)) return null;
  return projectTask(task, ctx);
}

export const sameProjection = (a: TaskProjection, b: TaskProjection) =>
  a.title === b.title && a.startMs === b.startMs && a.endMs === b.endMs && a.zone === b.zone;

/** Trzeba zapisać wydarzenie: zadanie różni się od stanu zgodności albo wydarzenie nie ma znacznika. */
export const needsWrite = (ours: TaskProjection, base: TaskProjection | null | undefined) =>
  !base || base.marked === false || !sameProjection(ours, base);

/** Znacznik źródła: skrót treści, którą zapisała aplikacja. */
export const projectionRev = (p: TaskProjection) => hashText(JSON.stringify([p.title, p.startMs, p.endMs, p.zone]));

/**
 * Identyfikator wydarzenia z id zadania (base32hex: `a–v`, `0–9`). To samo zadanie zawsze daje ten sam
 * identyfikator, więc powtórzone wstawienie po przerwie kończy się 409 zamiast duplikatem.
 */
export const eventIdForTask = (taskId: string) => `tp${taskId.replace(/-/g, '').toLowerCase()}`;

export const TASK_EVENT_DESCRIPTION =
  'Zadanie z TaskPlanner. Przesunięcie, zmiana długości albo tytułu tutaj zmienia zadanie; usunięcie wydarzenia zostawia zadanie bez godziny.';

/** Treść wydarzenia (wstawienie i zmiana). Bez przypomnień Google — przypomina TaskPlanner. */
export function eventBody(taskId: string, p: TaskProjection): Record<string, unknown> {
  return {
    summary: p.title,
    start: { dateTime: new Date(p.startMs).toISOString(), timeZone: p.zone },
    end: { dateTime: new Date(p.endMs).toISOString(), timeZone: p.zone },
    status: 'confirmed',
    description: TASK_EVENT_DESCRIPTION,
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { taskId, tpSource: 'taskplanner', tpRev: projectionRev(p) } },
  };
}

export const eventTaskId = (ev: GoogleEvent): string | null => ev.extendedProperties?.private?.taskId ?? null;

export type EventChange =
  | { kind: 'deleted' }
  | { kind: 'allDay'; date: string }
  | { kind: 'timed'; theirs: TaskProjection };

/** Wydarzenie z Google jako zmiana; czas ścienny w strefie `zone` (tej, w której wydarzenie zapisano). */
export function eventChange(ev: GoogleEvent, zone: string): EventChange | null {
  if (ev.status === 'cancelled') return { kind: 'deleted' };
  if (!ev.start || !ev.end) return null;
  if (ev.start.date) return { kind: 'allDay', date: ev.start.date };
  const startMs = Date.parse(ev.start.dateTime ?? '');
  const endMs = Date.parse(ev.end.dateTime ?? ev.start.dateTime ?? '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return { kind: 'timed', theirs: { title: ev.summary ?? '', startMs, endMs: Math.max(endMs, startMs + MINUTE), zone } };
}

/** Treść wydarzenia jest dokładnie tą, którą zapisała aplikacja (zmiana tylko np. koloru w Google). */
export const isOwnContent = (ev: GoogleEvent, theirs: TaskProjection) =>
  ev.extendedProperties?.private?.tpSource === 'taskplanner' && ev.extendedProperties.private.tpRev === projectionRev(theirs);

const durationMin = (p: TaskProjection) => Math.min(Math.max(Math.round((p.endMs - p.startMs) / MINUTE), 1), MAX_DURATION_MIN);

export type TaskPatch = Partial<Pick<TaskForCalendar, 'title' | 'due_date' | 'due_time' | 'duration_min'>>;

/**
 * Zmiana z Google → pola zadania. `base` = stan zgodności (brak: porównanie z samym zadaniem). Zwraca tylko
 * pola, które zmieniły się w Google i różnią się od zadania — powtórka daje pustą zmianę.
 */
export function taskPatch(change: EventChange, base: TaskProjection | null, task: TaskForCalendar, ctx: Pick<CalendarContext, 'defaultDurationMin'>): TaskPatch {
  const patch: TaskPatch = {};
  if (change.kind === 'deleted') {
    if (task.due_time !== null) patch.due_time = null;
    return patch;
  }
  if (change.kind === 'allDay') {
    if (task.due_date !== change.date) patch.due_date = change.date;
    if (task.due_time !== null) patch.due_time = null;
    return patch;
  }
  const { theirs } = change;
  const title = theirs.title.trim().slice(0, 500);
  if ((!base || theirs.title !== base.title) && title && title !== task.title) patch.title = title;
  if (!base || theirs.startMs !== base.startMs) {
    const wall = zonedParts(theirs.startMs, theirs.zone);
    if (wall.date !== task.due_date) patch.due_date = wall.date;
    if (wall.time !== task.due_time) patch.due_time = wall.time;
  }
  if (!base || theirs.endMs - theirs.startMs !== base.endMs - base.startMs) {
    const minutes = durationMin(theirs);
    if (minutes !== (task.duration_min ?? ctx.defaultDurationMin)) patch.duration_min = minutes;
  }
  return patch;
}

/** Nowe zadanie z wydarzenia dodanego w Google (czas pływający w strefie kontekstu). */
export function taskFromEvent(ev: GoogleEvent, theirs: TaskProjection, listId: string, ctx: Pick<CalendarContext, 'defaultDurationMin'>): Record<string, unknown> {
  const wall = zonedParts(theirs.startMs, theirs.zone);
  const minutes = durationMin(theirs);
  return {
    list_id: listId,
    title: theirs.title.trim().slice(0, 500) || 'Wydarzenie z kalendarza',
    due_date: wall.date,
    due_time: wall.time,
    duration_min: minutes === ctx.defaultDurationMin ? null : minutes,
    source: { kind: 'calendar', eventId: ev.id },
  };
}
