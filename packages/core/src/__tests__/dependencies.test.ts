/**
 * Zależności koniec→początek (M12, §7.3): cykle, naruszenia, przesuwanie kaskadowe, zakres projektu.
 */
import { describe, expect, it } from 'vitest';

import { addWorkdays, daysBetween } from '../dates.ts';
import { detectCycle, projectSpan, shiftSuccessors, taskSpan, violations, type Dependency, type ScheduledTask } from '../dependencies.ts';

const t = (id: string, startDate: string | null, dueDate: string | null, extra: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id,
  startDate,
  dueDate,
  dueTime: null,
  durationMin: null,
  ...extra,
});
const dep = (predecessorId: string, successorId: string, lagDays = 0): Dependency => ({ id: `${predecessorId}>${successorId}`, predecessorId, successorId, lagDays });

describe('daty robocze', () => {
  it('dni między datami i dni robocze (pon.–pt. albo własne)', () => {
    expect(daysBetween('2026-11-18', '2026-11-25')).toBe(7);
    expect(daysBetween('2026-11-25', '2026-11-18')).toBe(-7);
    expect(addWorkdays('2026-11-20', 1)).toBe('2026-11-23'); // pt → pon
    expect(addWorkdays('2026-11-23', -1)).toBe('2026-11-20');
    expect(addWorkdays('2026-11-21', 1)).toBe('2026-11-23'); // sob → pon
    expect(addWorkdays('2026-11-18', 5)).toBe('2026-11-25');
    expect(addWorkdays('2026-11-18', 2, [1, 3, 5])).toBe('2026-11-23');
  });
});

describe('zakres zadania', () => {
  it('początek z start_date, koniec z terminu, godziny i czasu trwania', () => {
    expect(taskSpan(t('a', '2026-11-16', '2026-11-20'))).toEqual({ start: '2026-11-16', end: '2026-11-20' });
    expect(taskSpan(t('a', null, '2026-11-20'))).toEqual({ start: '2026-11-20', end: '2026-11-20' });
    expect(taskSpan(t('a', null, null))).toBeNull();
    expect(taskSpan(t('a', null, '2026-11-20', { dueTime: '22:00', durationMin: 180 }))).toEqual({ start: '2026-11-20', end: '2026-11-21' });
    expect(taskSpan(t('a', null, '2026-11-20', { dueTime: '22:00', durationMin: 120 }))).toEqual({ start: '2026-11-20', end: '2026-11-20' });
    // start_date po terminie (błędne dane) — jednodniowy pasek.
    expect(taskSpan(t('a', '2026-11-25', '2026-11-20'))).toEqual({ start: '2026-11-20', end: '2026-11-20' });
  });
});

describe('cykle', () => {
  const deps = [dep('A', 'B'), dep('B', 'C'), dep('C', 'D'), dep('X', 'C')];

  it('zamknięcie cyklu zwraca ścieżkę', () => {
    expect(detectCycle(deps, { predecessorId: 'D', successorId: 'A' })).toEqual(['D', 'A', 'B', 'C', 'D']);
    expect(detectCycle(deps, { predecessorId: 'B', successorId: 'A' })).toEqual(['B', 'A', 'B']);
    expect(detectCycle(deps, { predecessorId: 'A', successorId: 'A' })).toEqual(['A', 'A']);
  });

  it('krawędź bez cyklu (także równoległa ścieżka) przechodzi', () => {
    expect(detectCycle(deps, { predecessorId: 'A', successorId: 'D' })).toBeNull();
    expect(detectCycle(deps, { predecessorId: 'D', successorId: 'X2' })).toBeNull();
    expect(detectCycle([], { predecessorId: 'A', successorId: 'B' })).toBeNull();
  });
});

describe('naruszenia', () => {
  it('następnik przed końcem poprzednika + opóźnienie', () => {
    const tasks = [t('A', '2026-11-16', '2026-11-20'), t('B', '2026-11-19', '2026-11-22'), t('C', null, '2026-11-22'), t('D', '2026-11-23', '2026-11-24'), t('E', null, null)];
    const found = violations(tasks, [dep('A', 'B'), dep('A', 'C'), dep('A', 'D', 2), dep('A', 'E')]);
    // C (22.11) i D (23.11 ≥ 20.11 + 2) w porządku; E bez terminu pominięte.
    expect(found.map((v) => `${v.dependency.id}:${v.start}<${v.earliestStart}(${v.days})`)).toEqual(['A>B:2026-11-19<2026-11-20(1)']);
    // B w dniu końca A przy lag = 0 — w porządku.
    expect(violations([t('A', null, '2026-11-20'), t('B', null, '2026-11-20')], [dep('A', 'B')])).toEqual([]);
    expect(violations([t('A', null, '2026-11-20'), t('B', null, '2026-11-21')], [dep('A', 'B', 2)]).map((v) => v.days)).toEqual([1]);
  });
});

describe('przesuwanie', () => {
  const tasks = [t('A', '2026-11-16', '2026-11-20'), t('B', null, '2026-11-23'), t('C', '2026-11-24', '2026-11-26'), t('D', null, null), t('Z', null, '2026-11-30')];
  const deps = [dep('A', 'B'), dep('B', 'C'), dep('B', 'D'), dep('C', 'A2')];
  const changes = (c: ReturnType<typeof shiftSuccessors>) => c.map((x) => `${x.id}:${x.startDate ?? '-'}..${x.dueDate}`);

  it('„Przesuń zależne”: przechodnio o tyle samo, bez zadań bez terminu i niepowiązanych', () => {
    expect(changes(shiftSuccessors(tasks, deps, 'A', 3))).toEqual(['A:2026-11-19..2026-11-23', 'B:-..2026-11-26', 'C:2026-11-27..2026-11-29']);
    expect(changes(shiftSuccessors(tasks, deps, 'B', -2))).toEqual(['B:-..2026-11-21', 'C:2026-11-22..2026-11-24']);
  });

  it('„Tylko to zadanie” i zero', () => {
    expect(changes(shiftSuccessors(tasks, deps, 'A', 3, { cascade: false }))).toEqual(['A:2026-11-19..2026-11-23']);
    expect(shiftSuccessors(tasks, deps, 'A', 0)).toEqual([]);
  });

  it('w dniach roboczych', () => {
    expect(changes(shiftSuccessors(tasks, deps, 'A', 1, { workdays: [1, 2, 3, 4, 5] }))).toEqual(['A:2026-11-17..2026-11-23', 'B:-..2026-11-24', 'C:2026-11-25..2026-11-27']);
  });

  it('po przesunięciu kaskadowym naruszeń nie przybywa', () => {
    const before = violations(tasks, [dep('A', 'B'), dep('B', 'C')]);
    const moved = new Map(shiftSuccessors(tasks, deps, 'A', 5).map((c) => [c.id, c]));
    const after = tasks.map((x) => ({ ...x, ...moved.get(x.id) }));
    expect(violations(after, [dep('A', 'B'), dep('B', 'C')])).toHaveLength(before.length);
  });
});

describe('zakres projektu', () => {
  const tasks = [t('a', '2026-11-10', '2026-11-12'), t('b', null, '2026-12-01'), t('c', null, null)];
  it('daty projektu, brakujące z zadań', () => {
    expect(projectSpan({ startDate: '2026-11-01', endDate: '2026-12-31' }, tasks)).toEqual({ start: '2026-11-01', end: '2026-12-31' });
    expect(projectSpan({ startDate: null, endDate: null }, tasks)).toEqual({ start: '2026-11-10', end: '2026-12-01' });
    expect(projectSpan({ startDate: '2026-11-05', endDate: null }, tasks)).toEqual({ start: '2026-11-05', end: '2026-12-01' });
    expect(projectSpan({ startDate: null, endDate: null }, [])).toBeNull();
  });
});
