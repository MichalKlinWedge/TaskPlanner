/**
 * Oś czasu (M12, Etap 6): wiersze, postęp, naruszenia, operacje z osi. Kryterium odbioru Etapu 6:
 * „Remont kuchni” — 15 zadań, 8 zależności, przesunięcie o tydzień jednym ruchem bez naruszeń,
 * próba cyklu zablokowana.
 */
import { describe, expect, it } from 'vitest';

import { addDays } from '../dates.ts';
import { violations, type Dependency } from '../dependencies.ts';
import type { TaskOp } from '../tasks.ts';
import { addDependencyOps, dependencyErrorText, projectFilterLabel, removeDependencyOps, shiftProjectOps, taskLinks, timelineChangeOps, timelineFileName, timelineGridSheet, timelineModel, timelinePeriods, timelineRowSpans, timelineSheet, visibleProjects, lighten, type TimelineProject, type TimelineTask } from '../timeline.ts';

const W = 'ws-1';
const task = (id: string, startDate: string | null, dueDate: string | null, over: Partial<TimelineTask> = {}): TimelineTask => ({
  id,
  listId: 'p1',
  parentId: null,
  workspaceId: W,
  kind: 'task',
  title: id,
  status: 'todo',
  sortKey: 'a',
  startDate,
  dueDate,
  dueTime: null,
  durationMin: null,
  ...over,
});
const dep = (predecessorId: string, successorId: string, lagDays = 0): Dependency => ({ id: `${predecessorId}>${successorId}`, predecessorId, successorId, lagDays });

/** Wynik operacji naniesiony na zadania (jak lokalna baza po `mutate`). */
const applyOps = (tasks: TimelineTask[], ops: readonly TaskOp[]): TimelineTask[] =>
  tasks.map((t) => {
    const patch = Object.assign({}, ...ops.filter((o) => o.table === 'tasks' && o.id === t.id).map((o) => o.patch)) as Record<string, string | null>;
    return { ...t, ...('start_date' in patch ? { startDate: patch.start_date } : {}), ...('due_date' in patch ? { dueDate: patch.due_date } : {}) };
  });

describe('wiersze osi', () => {
  it('projekt → zadania → podzadania po początku; bez terminu tylko z potomkiem z terminem', () => {
    const tasks = [
      task('b', null, '2026-11-25', { sortKey: 'c' }),
      task('a', '2026-11-20', '2026-11-23', { sortKey: 'a' }),
      task('parent', null, null, { sortKey: 'b' }),
      task('kid', null, '2026-11-24', { parentId: 'parent', status: 'done' }),
      task('kid2', null, null, { parentId: 'parent' }),
      task('nodate', null, null),
      task('x', null, '2026-11-25', { status: 'cancelled' }),
      task('h', null, '2026-11-25', { kind: 'habit' }),
      task('other', null, '2026-11-25', { listId: 'zwykla' }),
    ];
    const model = timelineModel([{ id: 'p1', name: 'Remont', startDate: null, endDate: null }], tasks, [dep('a', 'b', 3)]);
    expect(model.rows.map((r) => [r.id, r.parentId, r.span?.start ?? null, r.span?.end ?? null, r.progress, r.violated])).toEqual([
      ['p1', null, '2026-11-20', '2026-11-25', 17, false],
      ['a', 'p1', '2026-11-20', '2026-11-23', 0, false],
      ['parent', 'p1', null, null, 50, false],
      ['kid', 'parent', '2026-11-24', '2026-11-24', 100, false],
      ['b', 'p1', '2026-11-25', '2026-11-25', 0, true],
    ]);
    expect(model.undated).toBe(2);
    expect(model.links.map((l) => l.id)).toEqual(['a>b']);
    expect(model.violations[0]).toMatchObject({ earliestStart: '2026-11-26', days: 1 });

    // Z zadaniami bez terminu: całe drzewo, wiersze bez paska na końcu rodzeństwa; licznik bez zmian.
    const all = timelineModel([{ id: 'p1', name: 'Remont', startDate: null, endDate: null }], tasks, [dep('a', 'b', 3)], { withUndated: true });
    expect(all.rows.map((r) => [r.id, r.parentId, r.span?.start ?? null])).toEqual([
      ['p1', null, '2026-11-20'],
      ['a', 'p1', '2026-11-20'],
      ['parent', 'p1', null],
      ['kid', 'parent', '2026-11-24'],
      ['kid2', 'parent', null],
      ['b', 'p1', '2026-11-25'],
      ['nodate', 'p1', null],
    ]);
    expect(all.undated).toBe(2);
    expect(all.links).toEqual(model.links);
    const spans = timelineRowSpans(all.rows);
    expect(spans.get('parent')).toEqual({ start: '2026-11-24', end: '2026-11-24' });
    expect(spans.has('kid2')).toBe(false);
    expect(spans.has('nodate')).toBe(false);
    expect(spans.get('a')).toEqual({ start: '2026-11-20', end: '2026-11-23' });
  });

  it('kolejność po dacie początku (bez paska — najwcześniejszy potomek), przy równej dacie ręczna', () => {
    const tasks = [
      task('late', '2027-01-23', '2027-02-17', { sortKey: 'a' }),
      task('early', '2026-11-29', '2027-01-17', { sortKey: 'b' }),
      task('group', null, null, { sortKey: 'c' }),
      task('g2', null, '2026-12-10', { parentId: 'group', sortKey: 'a' }),
      task('g1', '2026-11-23', '2026-11-23', { parentId: 'group', sortKey: 'b' }),
      task('same2', '2026-11-29', '2026-11-29', { sortKey: 'd' }),
    ];
    const model = timelineModel([{ id: 'p1', name: 'Magazyn', startDate: null, endDate: null }], tasks, []);
    expect(model.rows.map((r) => r.id)).toEqual(['p1', 'group', 'g1', 'g2', 'early', 'same2', 'late']);
  });

  it('projekt bez zadań z terminem — wiersz z datami projektu albo bez paska', () => {
    const model = timelineModel(
      [
        { id: 'p1', name: 'A', startDate: '2026-12-01', endDate: null },
        { id: 'p2', name: 'B', startDate: null, endDate: null },
      ],
      [],
      [],
    );
    expect(model.rows.map((r) => [r.id, r.span])).toEqual([
      ['p1', { start: '2026-12-01', end: '2026-12-01' }],
      ['p2', null],
    ]);
  });
});

describe('zmiany z osi', () => {
  const tasks = [task('a', null, '2026-11-20'), task('b', '2026-11-21', '2026-11-23'), task('c', null, '2026-11-25', { dueTime: '23:00', durationMin: 120 })];
  const deps = [dep('a', 'b'), dep('b', 'c')];

  it('przesunięcie z „Przesuń zależne” i „Tylko to zadanie”', () => {
    const all = timelineChangeOps(tasks, deps, 'a', { start: '2026-11-22', end: '2026-11-22' });
    expect(all.ops).toEqual([
      { table: 'tasks', id: 'a', patch: { due_date: '2026-11-22' } },
      { table: 'tasks', id: 'b', patch: { start_date: '2026-11-23', due_date: '2026-11-25' } },
      { table: 'tasks', id: 'c', patch: { due_date: '2026-11-27' } },
    ]);
    expect(all.undo[1]).toEqual({ table: 'tasks', id: 'b', patch: { start_date: '2026-11-21', due_date: '2026-11-23' } });
    expect(timelineChangeOps(tasks, deps, 'a', { start: '2026-11-22', end: '2026-11-22' }, { cascade: false }).ops).toHaveLength(1);
  });

  it('rozciągnięcie: jednodniowe dostaje początek; koniec przesuwa następników; godzina po północy zostaje', () => {
    expect(timelineChangeOps(tasks, deps, 'a', { start: '2026-11-20', end: '2026-11-21' }).ops).toEqual([
      { table: 'tasks', id: 'a', patch: { start_date: '2026-11-20', due_date: '2026-11-21' } },
      { table: 'tasks', id: 'b', patch: { start_date: '2026-11-22', due_date: '2026-11-24' } },
      { table: 'tasks', id: 'c', patch: { due_date: '2026-11-26' } },
    ]);
    // Zmiana początku nie rusza następników.
    expect(timelineChangeOps(tasks, deps, 'b', { start: '2026-11-22', end: '2026-11-23' }).ops).toEqual([{ table: 'tasks', id: 'b', patch: { start_date: '2026-11-22' } }]);
    // c kończy się 26.11 (23:00 + 2 h) — koniec paska 27.11 → termin 26.11.
    expect(timelineChangeOps(tasks, deps, 'c', { start: '2026-11-25', end: '2026-11-27' }).ops).toEqual([{ table: 'tasks', id: 'c', patch: { start_date: '2026-11-25', due_date: '2026-11-26' } }]);
    // Skrócenie do jednego dnia zdejmuje początek.
    expect(timelineChangeOps(tasks, deps, 'b', { start: '2026-11-23', end: '2026-11-23' }).ops).toEqual([{ table: 'tasks', id: 'b', patch: { start_date: null } }]);
    expect(timelineChangeOps(tasks, deps, 'b', { start: '2026-11-21', end: '2026-11-23' }).ops).toEqual([]);
  });
});

describe('zależności', () => {
  const tasks = [task('a', null, '2026-11-20'), task('b', null, '2026-11-21'), task('c', null, '2026-11-22'), task('z', null, '2026-11-22', { workspaceId: 'ws-2' })];
  const deps = [dep('a', 'b'), dep('b', 'c')];

  it('dodanie: cykl, duplikat, inna przestrzeń — błąd; poprawna — operacja z opóźnieniem', () => {
    const cycle = addDependencyOps(tasks, deps, { predecessorId: 'c', successorId: 'a' });
    expect(cycle).toEqual({ error: { reason: 'cycle', cycle: ['c', 'a', 'b', 'c'] } });
    expect('error' in cycle && dependencyErrorText(cycle.error, (id) => id.toUpperCase())).toBe('Ta zależność zamknęłaby cykl: C → A → B → C.');
    expect(addDependencyOps(tasks, deps, { predecessorId: 'a', successorId: 'a' })).toEqual({ error: { reason: 'cycle', cycle: ['a', 'a'] } });
    expect(addDependencyOps(tasks, deps, { predecessorId: 'a', successorId: 'b' })).toEqual({ error: { reason: 'duplicate' } });
    expect(addDependencyOps(tasks, deps, { predecessorId: 'a', successorId: 'z' })).toEqual({ error: { reason: 'workspace' } });
    const ok = addDependencyOps(tasks, deps, { predecessorId: 'a', successorId: 'c', lagDays: 400.4 }, 'd1');
    expect(ok).toMatchObject({ id: 'd1', ops: [{ table: 'task_dependencies', id: 'd1', patch: { predecessor_id: 'a', successor_id: 'c', kind: 'finish_to_start', lag_days: 365 } }] });
    expect(removeDependencyOps('d1', '2026-11-19T10:00:00Z')).toEqual({
      ops: [{ table: 'task_dependencies', id: 'd1', patch: { deleted_at: '2026-11-19T10:00:00.000Z' } }],
      undo: [{ table: 'task_dependencies', id: 'd1', patch: { deleted_at: null } }],
    });
  });

  it('poprzednicy i następnicy zadania z naruszeniem', () => {
    const links = taskLinks('b', tasks, [dep('a', 'b', 2), dep('b', 'c'), dep('x', 'b')]);
    expect(links.predecessors.map((l) => [l.otherId, l.violation?.days ?? 0])).toEqual([['a', 1]]);
    expect(links.successors.map((l) => [l.otherId, l.violation])).toEqual([['c', null]]);
  });
});

describe('kryterium odbioru: „Remont kuchni”', () => {
  const project: TimelineProject = { id: 'p1', name: 'Remont kuchni', startDate: '2026-11-23', endDate: '2026-12-31' };
  const plan: [string, number, number][] = [
    ['Pomiary', 0, 1],
    ['Projekt kuchni', 1, 3],
    ['Zamówienie mebli', 4, 1],
    ['Zamówienie AGD', 4, 1],
    ['Demontaż starej zabudowy', 7, 2],
    ['Instalacja wodna', 9, 2],
    ['Instalacja elektryczna', 9, 2],
    ['Tynki i gładzie', 11, 3],
    ['Malowanie', 14, 2],
    ['Płytki', 16, 3],
    ['Montaż mebli', 25, 3],
    ['Montaż AGD', 28, 1],
    ['Blat i zlew', 28, 1],
    ['Oświetlenie', 29, 1],
    ['Sprzątanie', 30, 1],
  ];
  const tasks = plan.map(([title, offset, days], i) => task(`t${i + 1}`, days > 1 ? addDays('2026-11-23', offset) : null, addDays('2026-11-23', offset + days - 1), { title, sortKey: String(i) }));
  const deps = [dep('t1', 't2'), dep('t2', 't3'), dep('t2', 't4'), dep('t5', 't6'), dep('t6', 't8'), dep('t8', 't9'), dep('t3', 't11', 14), dep('t11', 't12')];

  it('15 zadań i 8 zależności bez naruszeń; projekt przesunięty o tydzień — dalej bez naruszeń', () => {
    expect(tasks).toHaveLength(15);
    expect(deps).toHaveLength(8);
    expect(timelineModel([project], tasks, deps).violations).toEqual([]);

    const week = shiftProjectOps(project, tasks, deps, 7);
    expect(week.changed).toBe(15);
    expect(week.ops.at(-1)).toEqual({ table: 'lists', id: 'p1', patch: { start_date: '2026-11-30', end_date: '2027-01-07' } });
    const moved = applyOps(tasks, week.ops);
    expect(moved.every((t, i) => t.dueDate === addDays(tasks[i]!.dueDate!, 7))).toBe(true);
    expect(violations(moved, deps)).toEqual([]);
    expect(applyOps(moved, week.undo)).toEqual(tasks);
  });

  it('przesunięcie pierwszego zadania o tydzień z „Przesuń zależne” — bez naruszeń; bez kaskady — naruszenie', () => {
    const first = timelineChangeOps(tasks, deps, 't1', { start: '2026-11-30', end: '2026-11-30' });
    expect(first.changed).toBe(6); // t1, t2, t3, t4, t11, t12
    expect(violations(applyOps(tasks, first.ops), deps)).toEqual([]);
    const alone = timelineChangeOps(tasks, deps, 't1', { start: '2026-11-30', end: '2026-11-30' }, { cascade: false });
    expect(violations(applyOps(tasks, alone.ops), deps).map((v) => v.dependency.id)).toEqual(['t1>t2']);
  });

  it('próba cyklu (Montaż AGD → Pomiary → … → Montaż AGD) zablokowana', () => {
    const result = addDependencyOps(tasks, deps, { predecessorId: 't12', successorId: 't1' });
    expect(result).toEqual({ error: { reason: 'cycle', cycle: ['t12', 't1', 't2', 't3', 't11', 't12'] } });
  });
});

describe('filtr projektów i eksport', () => {
  const projects: TimelineProject[] = [
    { id: 'p1', name: 'Remont', startDate: null, endDate: null },
    { id: 'p2', name: 'Ogród', startDate: null, endDate: null },
    { id: 'p3', name: 'Auto', startDate: null, endDate: null },
  ];

  it('ukryte projekty znikają z osi, nowy projekt jest widoczny', () => {
    expect(visibleProjects(projects, new Set()).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(visibleProjects(projects, new Set(['p2', 'usuniety'])).map((p) => p.id)).toEqual(['p1', 'p3']);
    expect(projectFilterLabel(projects, new Set())).toBe('wszystkie');
    expect(projectFilterLabel(projects, new Set(['p2']))).toBe('2 z 3');
    expect(projectFilterLabel(projects, new Set(['p2', 'p3']))).toBe('Remont');
    expect(projectFilterLabel(projects, new Set(['p1', 'p2', 'p3']))).toBe('żaden');
  });

  it('arkusz: wiersze osi z poziomem, datami, postępem, poprzednikami i naruszeniem', () => {
    const tasks = [
      task('a', '2026-11-20', '2026-11-23', { title: 'Projekt wnętrza', sortKey: 'a' }),
      task('b', null, '2026-11-24', { title: 'Zakupy', sortKey: 'b', priority: 2 } as Partial<TimelineTask>),
      task('kid', null, '2026-11-24', { title: 'Płytki', parentId: 'b', status: 'done' }),
      task('o', null, '2026-11-26', { title: 'Sadzenie', listId: 'p2' }),
    ];
    const model = timelineModel(visibleProjects(projects, new Set(['p2'])), tasks, [dep('a', 'b', 2)]);
    const sheet = timelineSheet(model, tasks);
    expect(sheet.columns.map((c) => c.header)).toEqual(['Projekt', 'Zadanie', 'Typ', 'Początek', 'Koniec', 'Dni', 'Postęp', 'Status', 'Priorytet', 'Poprzednicy', 'Naruszenie']);
    expect(sheet.rows).toEqual([
      ['Remont', 'Remont', 'Projekt', { date: '2026-11-20' }, { date: '2026-11-24' }, 5, { percent: 0.33 }, '', '', '', ''],
      ['Remont', 'Projekt wnętrza', 'Zadanie', { date: '2026-11-20' }, { date: '2026-11-23' }, 4, { percent: 0 }, 'Do zrobienia', '', '', ''],
      ['Remont', 'Zakupy', 'Zadanie', { date: '2026-11-24' }, { date: '2026-11-24' }, 1, { percent: 1 }, 'Do zrobienia', 'Wysoki', 'Projekt wnętrza (+2 dni)', '1 dzień za wcześnie po „Projekt wnętrza”'],
      ['Remont', 'Płytki', 'Podzadanie', { date: '2026-11-24' }, { date: '2026-11-24' }, 1, { percent: 1 }, 'Gotowe', '', '', ''],
      ['Auto', 'Auto', 'Projekt', null, null, null, { percent: 0 }, '', '', '', ''],
    ]);
    expect(sheet.indents).toEqual([0, 1, 1, 2, 0]);
    expect(timelineFileName('2026-11-20')).toBe('os-czasu-2026-11-20.xlsx');
  });

  it('okresy skali: dni, tygodnie od pierwszego dnia tygodnia, miesiące', () => {
    expect(timelinePeriods('2026-11-29', '2026-12-01', 'day').map((p) => [p.label, p.group])).toEqual([
      ['29', 'listopad 2026'],
      ['30', 'listopad 2026'],
      ['1', 'grudzień 2026'],
    ]);
    expect(timelinePeriods('2026-11-20', '2026-11-30', 'week')).toEqual([
      { start: '2026-11-16', end: '2026-11-22', label: '16.11', group: 'listopad 2026' },
      { start: '2026-11-23', end: '2026-11-29', label: '23.11', group: 'listopad 2026' },
      { start: '2026-11-30', end: '2026-12-06', label: '30.11', group: 'listopad 2026' },
    ]);
    expect(timelinePeriods('2026-11-20', '2026-11-20', 'week', 7)[0]!.start).toBe('2026-11-15');
    expect(timelinePeriods('2026-12-31', '2027-01-01', 'month').map((p) => [p.start, p.end, p.label, p.group])).toEqual([
      ['2026-12-01', '2026-12-31', 'grudzień', '2026'],
      ['2027-01-01', '2027-01-31', 'styczeń', '2027'],
    ]);
    expect(lighten('#ff0000', 0.35)).toBe('#ff5959');
  });

  it('siatka osi: kolumna na okres, pasek = komórki z tłem, miesiąc nad dniami, dziś w nagłówku', () => {
    const tasks = [
      task('a', '2026-11-20', '2026-11-23', { title: 'Projekt wnętrza', sortKey: 'a' }),
      task('b', null, '2026-11-24', { title: 'Zakupy', sortKey: 'b' }),
      task('kid', null, '2026-11-24', { title: 'Płytki', parentId: 'b', status: 'done' }),
    ];
    const model = timelineModel(visibleProjects(projects, new Set(['p2'])), tasks, [dep('a', 'b', 2)]);
    const sheet = timelineGridSheet(model, { scale: 'day', today: '2026-11-22', colors: new Map([['p1', '#ff0000']]) });
    expect(sheet.columns.map((c) => c.header)).toEqual(['Zadanie', 'Początek', 'Koniec', 'Postęp', '20', '21', '22', '23', '24']);
    expect(sheet.columns.slice(4).map((c) => c.fill)).toEqual([undefined, '#e5e7eb', '#fde68a', undefined, undefined]);
    expect(sheet.headerRows).toEqual([[null, null, null, null, 'listopad 2026', null, null, null, null]]);
    expect(sheet.merges).toEqual(['E1:I1']);
    expect(sheet.freezeColumns).toBe(4);
    const bars = sheet.rows.map((r) => r.slice(4).map((c) => (c && typeof c === 'object' && 'fill' in c ? c.fill : '·')));
    expect(bars).toEqual([
      ['#ff0000', '#ff0000', '#ff0000', '#ff0000', '#ff0000'],
      ['#ff5959', '#ff5959', '#ff5959', '#ff5959', '·'],
      ['·', '·', '·', '·', '#f87171'],
      ['·', '·', '·', '·', '#d1d5db'],
      ['·', '·', '·', '·', '·'],
    ]);
    expect(sheet.rows[1]!.slice(0, 4)).toEqual(['Projekt wnętrza', { date: '2026-11-20' }, { date: '2026-11-23' }, { percent: 0 }]);
    expect(sheet.indents).toEqual([0, 1, 1, 2, 0]);
    const months = timelineGridSheet(model, { scale: 'month', today: '2026-11-22' });
    expect(months.columns.slice(4).map((c) => c.header)).toEqual(['listopad']);
    expect(months.rows[0]![4]).toEqual({ fill: '#6366f1' });
    expect(timelineGridSheet(timelineModel([], [], []), { scale: 'week', today: '2026-11-22' })).toMatchObject({ rows: [], headerRows: undefined, merges: [] });
  });
});
