import { describe, expect, it } from 'vitest';

import {
  desiredProjection,
  eventBody,
  eventChange,
  eventIdForTask,
  isOwnContent,
  needsWrite,
  projectTask,
  taskFromEvent,
  taskPatch,
  type TaskForCalendar,
} from '../../../supabase/functions/_shared/task-events.ts';
import type { GoogleEvent } from '../../../supabase/functions/_shared/google.ts';

const WS = '01900000-0000-7000-8000-000000000001';
const ctx = { zone: 'Europe/Warsaw', defaultDurationMin: 30, workspaceIds: new Set([WS]) };
const base: TaskForCalendar = {
  id: '01900000-0000-7000-8000-0000000000aa',
  scope_id: WS,
  kind: 'task',
  title: 'Raport',
  status: 'todo',
  due_date: '2026-11-20',
  due_time: '10:00',
  duration_min: 45,
  time_zone: null,
  deleted_at: null,
};
const ms = (s: string) => Date.parse(s);

describe('rzut zadania na wydarzenie', () => {
  it('czas pływający w strefie z ustawień, przypięty w strefie zadania, domyślna długość', () => {
    expect(projectTask(base, ctx)).toEqual({ title: 'Raport', startMs: ms('2026-11-20T09:00:00Z'), endMs: ms('2026-11-20T09:45:00Z'), zone: 'Europe/Warsaw' });
    const ny = projectTask({ ...base, time_zone: 'America/New_York', duration_min: null }, ctx)!;
    expect(ny).toMatchObject({ startMs: ms('2026-11-20T15:00:00Z'), endMs: ms('2026-11-20T15:30:00Z'), zone: 'America/New_York' });
    // Niepoprawna strefa → strefa z ustawień.
    expect(projectTask({ ...base, time_zone: 'Nie/Ma' }, ctx)!.zone).toBe('Europe/Warsaw');
    // Zmiana czasu (29.03.2026, 2:30 nie istnieje → 3:30 CEST).
    expect(projectTask({ ...base, due_date: '2026-03-29', due_time: '02:30' }, ctx)!.startMs).toBe(ms('2026-03-29T01:30:00Z'));
  });

  it('wydarzenie tylko dla żywego zadania z godziną z wybranej przestrzeni', () => {
    expect(desiredProjection(base, ctx)).not.toBeNull();
    expect(desiredProjection({ ...base, due_time: null }, ctx)).toBeNull();
    expect(desiredProjection({ ...base, deleted_at: '2026-11-19T10:00:00Z' }, ctx)).toBeNull();
    expect(desiredProjection({ ...base, status: 'cancelled' }, ctx)).toBeNull();
    expect(desiredProjection({ ...base, kind: 'habit' }, ctx)).toBeNull();
    expect(desiredProjection({ ...base, scope_id: 'inna' }, ctx)).toBeNull();
    expect(desiredProjection({ ...base, status: 'done' }, ctx)).not.toBeNull();
  });

  it('identyfikator wydarzenia z id zadania: base32hex, stały', () => {
    const id = eventIdForTask(base.id);
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(id).toBe(eventIdForTask(base.id.toUpperCase()));
  });

  it('treść wydarzenia: chwile ISO ze strefą, znacznik źródła, bez przypomnień Google', () => {
    const p = projectTask(base, ctx)!;
    const body = eventBody(base.id, p);
    expect(body).toMatchObject({
      summary: 'Raport',
      start: { dateTime: '2026-11-20T09:00:00.000Z', timeZone: 'Europe/Warsaw' },
      end: { dateTime: '2026-11-20T09:45:00.000Z', timeZone: 'Europe/Warsaw' },
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: { private: { taskId: base.id, tpSource: 'taskplanner' } },
    });
    const ev = body as unknown as GoogleEvent;
    const change = eventChange({ ...ev, start: { dateTime: '2026-11-20T10:00:00+01:00' }, end: { dateTime: '2026-11-20T10:45:00+01:00' } }, 'Europe/Warsaw');
    expect(change).toMatchObject({ kind: 'timed' });
    expect(isOwnContent(ev, (change as { theirs: typeof p }).theirs)).toBe(true);
    expect(isOwnContent({ ...ev, summary: 'Inny' }, { ...p, title: 'Inny' })).toBe(false);
  });

  it('zapis potrzebny przy zmianie treści albo braku znacznika', () => {
    const p = projectTask(base, ctx)!;
    expect(needsWrite(p, null)).toBe(true);
    expect(needsWrite(p, { ...p })).toBe(false);
    expect(needsWrite(p, { ...p, marked: false })).toBe(true);
    expect(needsWrite({ ...p, title: 'X' }, p)).toBe(true);
    expect(needsWrite({ ...p, zone: 'UTC' }, p)).toBe(true);
  });
});

describe('zmiana z Google → pola zadania (scalanie trójstronne)', () => {
  const p = projectTask(base, ctx)!;
  const timed = (over: Partial<typeof p>) => ({ kind: 'timed' as const, theirs: { ...p, ...over } });

  it('przesunięcie → data i godzina w strefie zapisu; zmiana długości → duration_min', () => {
    expect(taskPatch(timed({ startMs: ms('2026-11-21T12:30:00Z'), endMs: ms('2026-11-21T13:15:00Z') }), p, base, ctx)).toEqual({ due_date: '2026-11-21', due_time: '13:30' });
    expect(taskPatch(timed({ endMs: p.endMs + 15 * 60_000 }), p, base, ctx)).toEqual({ duration_min: 60 });
    expect(taskPatch(timed({ title: '  Raport Q4 ' }), p, base, ctx)).toEqual({ title: 'Raport Q4' });
  });

  it('tylko pola zmienione w Google: równoległa zmiana tytułu w aplikacji zostaje', () => {
    const edited = { ...base, title: 'Raport (aplikacja)' };
    expect(taskPatch(timed({ startMs: p.startMs + 3600_000, endMs: p.endMs + 3600_000 }), p, edited, ctx)).toEqual({ due_time: '11:00' });
  });

  it('powtórka tej samej zmiany = brak zmian', () => {
    const moved = { ...base, due_time: '11:00' };
    expect(taskPatch(timed({ startMs: p.startMs + 3600_000, endMs: p.endMs + 3600_000 }), p, moved, ctx)).toEqual({});
    expect(taskPatch(timed({}), p, base, ctx)).toEqual({});
  });

  it('długość równa domyślnej przy zadaniu bez długości — bez zapisu', () => {
    const t = { ...base, duration_min: null };
    const q = projectTask(t, ctx)!;
    expect(taskPatch({ kind: 'timed', theirs: q }, null, t, ctx)).toEqual({});
  });

  it('usunięte → bez godziny (termin zostaje); całodniowe → data bez godziny', () => {
    expect(taskPatch({ kind: 'deleted' }, p, base, ctx)).toEqual({ due_time: null });
    expect(taskPatch({ kind: 'deleted' }, p, { ...base, due_time: null }, ctx)).toEqual({});
    expect(taskPatch({ kind: 'allDay', date: '2026-11-22' }, p, base, ctx)).toEqual({ due_date: '2026-11-22', due_time: null });
  });

  it('wydarzenie Google: anulowane, całodniowe, z godziną (koniec ≥ początek + 1 min)', () => {
    expect(eventChange({ id: 'x', status: 'cancelled' }, 'UTC')).toEqual({ kind: 'deleted' });
    expect(eventChange({ id: 'x', start: { date: '2026-11-20' }, end: { date: '2026-11-21' } }, 'UTC')).toEqual({ kind: 'allDay', date: '2026-11-20' });
    expect(eventChange({ id: 'x', start: { dateTime: '2026-11-20T10:00:00Z' }, end: { dateTime: '2026-11-20T10:00:00Z' } }, 'UTC')).toMatchObject({
      theirs: { title: '', startMs: ms('2026-11-20T10:00:00Z'), endMs: ms('2026-11-20T10:01:00Z') },
    });
    expect(eventChange({ id: 'x' }, 'UTC')).toBeNull();
  });

  it('nowe zadanie z wydarzenia dodanego w Google', () => {
    const ev: GoogleEvent = { id: 'usr1', summary: 'Dentysta', start: { dateTime: '2026-11-20T13:00:00Z' }, end: { dateTime: '2026-11-20T14:00:00Z' } };
    const change = eventChange(ev, 'Europe/Warsaw') as { theirs: ReturnType<typeof projectTask> & object };
    expect(taskFromEvent(ev, change.theirs, 'lista', ctx)).toEqual({
      list_id: 'lista', title: 'Dentysta', due_date: '2026-11-20', due_time: '14:00', duration_min: 60, source: { kind: 'calendar', eventId: 'usr1' },
    });
    expect(taskFromEvent({ ...ev, summary: '' }, { ...change.theirs, title: '', endMs: change.theirs.startMs + 30 * 60_000 }, 'lista', ctx)).toMatchObject({
      title: 'Wydarzenie z kalendarza', duration_min: null,
    });
  });
});
