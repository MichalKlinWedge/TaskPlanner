/**
 * Widoki (M9, M4, §7.1) na małym zestawie zadań; dziś = środa 2026-11-18.
 */
import { describe, expect, it } from 'vitest';

import { localDateAt, weekStart } from '../dates.ts';
import {
  applyFilter,
  buildTree,
  FilterQuery,
  flattenTree,
  groupTasks,
  progress,
  selectInbox,
  selectToday,
  selectUpcoming,
  sortTasks,
  withCompleted,
  type ViewContext,
  type ViewTask,
} from '../views.ts';

const W1 = '0190a000-0000-7000-8000-000000000001';
const W2 = '0190a000-0000-7000-8000-000000000002';
const INBOX = '0190a000-0000-7000-8000-0000000000a1';
const LIST = '0190a000-0000-7000-8000-0000000000a2';
const TAG_A = '0190a000-0000-7000-8000-0000000000b1';
const TAG_B = '0190a000-0000-7000-8000-0000000000b2';

const ctx: ViewContext = { today: '2026-11-18', timeZone: 'Europe/Warsaw' };

let n = 0;
function task(over: Partial<ViewTask> = {}): ViewTask {
  n++;
  return {
    id: over.id ?? `t${String(n).padStart(3, '0')}`,
    workspaceId: W1,
    listId: LIST,
    parentId: null,
    kind: 'task',
    title: over.title ?? `Zadanie ${n}`,
    status: 'todo',
    priority: 4,
    startDate: null,
    dueDate: null,
    dueTime: null,
    durationMin: null,
    recurrence: null,
    habit: null,
    completedAt: null,
    createdAt: '2026-11-01T10:00:00Z',
    sortKey: '0010',
    tagIds: [],
    ...over,
  };
}

const ids = (tasks: readonly ViewTask[]) => tasks.map((t) => t.id);

describe('daty lokalne', () => {
  it('dzień ukończenia według strefy, nie UTC', () => {
    expect(localDateAt('2026-11-18T23:30:00Z', 'Europe/Warsaw')).toBe('2026-11-19');
    expect(localDateAt('2026-11-18T22:59:00Z', 'Europe/Warsaw')).toBe('2026-11-18');
  });
  it('początek tygodnia od poniedziałku albo niedzieli', () => {
    expect(weekStart('2026-11-18')).toBe('2026-11-16');
    expect(weekStart('2026-11-16')).toBe('2026-11-16');
    expect(weekStart('2026-11-22')).toBe('2026-11-16');
    expect(weekStart('2026-11-18', 7)).toBe('2026-11-15');
    expect(weekStart('2026-11-15', 7)).toBe('2026-11-15');
  });
});

describe('Dziś', () => {
  const tasks = [
    task({ id: 'late-old', dueDate: '2026-11-10' }),
    task({ id: 'late-new', dueDate: '2026-11-17', priority: 1 }),
    task({ id: 'late-new-low', dueDate: '2026-11-17', priority: 3 }),
    task({ id: 'today-b', dueDate: '2026-11-18', sortKey: '0020' }),
    task({ id: 'today-a', dueDate: '2026-11-18', sortKey: '0010' }),
    task({ id: 'today-14', dueDate: '2026-11-18', dueTime: '14:00' }),
    task({ id: 'today-08', dueDate: '2026-11-18', dueTime: '08:30' }),
    task({ id: 'range', startDate: '2026-11-16', dueDate: '2026-11-20' }),
    task({ id: 'range-later', startDate: '2026-11-19', dueDate: '2026-11-25' }),
    task({ id: 'tomorrow', dueDate: '2026-11-19' }),
    task({ id: 'undated' }),
    task({ id: 'done-today', dueDate: '2026-11-18', status: 'done', completedAt: '2026-11-18T09:00:00Z' }),
    task({ id: 'done-night', dueDate: '2026-11-17', status: 'done', completedAt: '2026-11-17T23:30:00Z' }),
    task({ id: 'done-yesterday', dueDate: '2026-11-17', status: 'done', completedAt: '2026-11-17T12:00:00Z' }),
    task({ id: 'cancelled', dueDate: '2026-11-15', status: 'cancelled' }),
    task({ id: 'waiting', dueDate: '2026-11-18', status: 'waiting', sortKey: '0030' }),
    task({ id: 'other-ws', dueDate: '2026-11-18', workspaceId: W2, sortKey: '0025' }),
    task({ id: 'habit-daily', kind: 'habit', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-10-01' } }),
    task({ id: 'habit-weekend', kind: 'habit', recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=SA,SU', anchor: '2026-10-01' } }),
    task({ id: 'habit-goal', kind: 'habit', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-10-01' }, habit: { goal: { period: 'week', times: 3 } } }),
    task({ id: 'habit-ended', kind: 'habit', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY;UNTIL=20261110', anchor: '2026-10-01' } }),
    task({ id: 'habit-future', kind: 'habit', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-12-01' } }),
  ];

  it('sekcje i kolejność', () => {
    const view = selectToday(tasks, ctx);
    expect(ids(view.overdue)).toEqual(['late-old', 'late-new', 'late-new-low']);
    expect(ids(view.today)).toEqual(['today-08', 'today-14', 'today-a', 'today-b', 'other-ws', 'waiting']);
    expect(ids(view.ongoing)).toEqual(['range']);
    expect(ids(view.habits).sort()).toEqual(['habit-daily', 'habit-goal']);
    // 23:30 UTC 17.11 = 00:30 w Warszawie 18.11.
    expect(ids(view.done)).toEqual(['done-today', 'done-night']);
  });

  it('tryb jednej przestrzeni i ukryte ukończone', () => {
    const view = selectToday(tasks, { ...ctx, workspaceId: W1 }, { completed: 'hidden' });
    expect(ids(view.today)).not.toContain('other-ws');
    expect(view.done).toEqual([]);
  });

  it('seria zaległa to jedno zadanie, nie lawina wystąpień', () => {
    const series = task({ id: 'series', dueDate: '2026-11-11', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' } });
    const view = selectToday([series], ctx);
    expect(ids(view.overdue)).toEqual(['series']);
    expect(view.today).toEqual([]);
  });

  it('pokazywanie ukończonych w widoku listy', () => {
    expect(ids(withCompleted(tasks, 'hidden', ctx))).not.toContain('done-today');
    const today = ids(withCompleted(tasks, 'today', ctx));
    expect(today).toContain('done-today');
    expect(today).not.toContain('done-yesterday');
    expect(withCompleted(tasks, 'all', ctx)).toHaveLength(tasks.length);
  });
});

describe('Inbox', () => {
  it('otwarte zadania list inbox w kolejności ręcznej', () => {
    const tasks = [
      task({ id: 'i2', listId: INBOX, sortKey: '0020' }),
      task({ id: 'i1', listId: INBOX, sortKey: '0010' }),
      task({ id: 'i-done', listId: INBOX, status: 'done' }),
      task({ id: 'other', listId: LIST }),
      task({ id: 'i-other-ws', listId: INBOX, workspaceId: W2, sortKey: '0030' }),
    ];
    expect(ids(selectInbox(tasks, new Set([INBOX]), ctx))).toEqual(['i1', 'i2', 'i-other-ws']);
    expect(ids(selectInbox(tasks, new Set([INBOX]), { ...ctx, workspaceId: W1 }))).toEqual(['i1', 'i2']);
  });
});

describe('Nadchodzące', () => {
  const day = (view: ReturnType<typeof selectUpcoming>, date: string) => view.days.find((d) => d.date === date)!.items.map((i) => `${i.task.id}${i.virtual ? '*' : ''}`);

  it('14 dni od dziś, także puste; zaległe i bez terminu poza widokiem', () => {
    const view = selectUpcoming([task({ id: 'late', dueDate: '2026-11-10' }), task({ id: 'undated' }), task({ id: 'fri', dueDate: '2026-11-20' })], ctx);
    expect(view.days).toHaveLength(14);
    expect(view.days[0]!.date).toBe('2026-11-18');
    expect(view.days[13]!.date).toBe('2026-12-01');
    expect(view.days.flatMap((d) => d.items).map((i) => i.task.id)).toEqual(['fri']);
  });

  it('wirtualne wystąpienia serii po bieżącym terminie', () => {
    const weekly = task({ id: 'tue', dueDate: '2026-11-24', recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=TU', anchor: '2026-11-03' } });
    const view = selectUpcoming([weekly], ctx);
    expect(day(view, '2026-11-24')).toEqual(['tue']);
    expect(day(view, '2026-12-01')).toEqual(['tue*']);
    expect(day(view, '2026-11-18')).toEqual([]);
  });

  it('zaległa seria: wystąpienia dopiero od jutra (jak nextDue po ukończeniu dziś)', () => {
    const daily = task({ id: 'daily', dueDate: '2026-11-15', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' } });
    const view = selectUpcoming([daily], ctx);
    expect(day(view, '2026-11-18')).toEqual([]);
    expect(day(view, '2026-11-19')).toEqual(['daily*']);
    expect(view.days.flatMap((d) => d.items)).toHaveLength(13);
  });

  it('koniec serii (COUNT), tryb „po ukończeniu” bez wirtualnych, nawyki poza widokiem', () => {
    const counted = task({ id: 'count', dueDate: '2026-11-18', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY;COUNT=20', anchor: '2026-11-01' } });
    const after = task({ id: 'after', dueDate: '2026-11-19', recurrence: { mode: 'after_completion', every: { unit: 'day', n: 2 } } });
    const habit = task({ id: 'habit', kind: 'habit', dueDate: '2026-11-19', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-10-01' } });
    const view = selectUpcoming([counted, after, habit], ctx);
    // COUNT=20 od 1.11 → ostatnie wystąpienie 20.11.
    expect(view.days.flatMap((d) => d.items).map((i) => `${i.task.id}@${i.date}`)).toEqual(['count@2026-11-18', 'after@2026-11-19', 'count@2026-11-19', 'count@2026-11-20']);
  });

  it('„Później” tygodniami, z pierwszym dniem tygodnia z ustawień', () => {
    const tasks = [task({ id: 'd2', dueDate: '2026-12-02' }), task({ id: 'd6', dueDate: '2026-12-06' }), task({ id: 'd7', dueDate: '2026-12-07' }), task({ id: 'jan', dueDate: '2027-01-05' })];
    const later = (first?: number) => selectUpcoming(tasks, { ...ctx, firstDayOfWeek: first }).later.map((w) => `${w.weekStart}:${w.items.map((i) => i.task.id).join(',')}`);
    expect(later()).toEqual(['2026-11-30:d2,d6', '2026-12-07:d7', '2027-01-04:jan']);
    expect(later(7)).toEqual(['2026-11-29:d2', '2026-12-06:d6,d7', '2027-01-03:jan']);
  });

  it('kolejność w dniu: z godziną najpierw, wirtualne za prawdziwymi', () => {
    const tasks = [
      task({ id: 'untimed', dueDate: '2026-11-20' }),
      task({ id: 'timed', dueDate: '2026-11-20', dueTime: '10:00' }),
      task({ id: 'series', dueDate: '2026-11-19', sortKey: '0000', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' } }),
    ];
    expect(day(selectUpcoming(tasks, ctx), '2026-11-20')).toEqual(['timed', 'series*', 'untimed']);
  });
});

describe('filtry', () => {
  const tasks = [
    task({ id: 'a', tagIds: [TAG_A], dueDate: '2026-11-18', priority: 1 }),
    task({ id: 'ab', tagIds: [TAG_A, TAG_B], dueDate: '2026-11-10', dueTime: '09:00' }),
    task({ id: 'b', tagIds: [TAG_B], dueDate: '2026-11-25', status: 'waiting' }),
    task({ id: 'none', listId: INBOX }),
  ];
  const run = (q: FilterQuery) => ids(applyFilter(tasks, FilterQuery.parse(q), ctx.today));

  it('tagi: wszystkie / dowolny', () => {
    expect(run({ tags: { ids: [TAG_A, TAG_B], match: 'all' } })).toEqual(['ab']);
    expect(run({ tags: { ids: [TAG_A, TAG_B], match: 'any' } })).toEqual(['a', 'ab', 'b']);
  });

  it('„Telefony na dziś”: tag ∧ termin ≤ dziś (względnie, z zaległymi)', () => {
    expect(run({ tags: { ids: [TAG_A], match: 'any' }, due: { kind: 'range', to: { offsetDays: 0 } } })).toEqual(['a', 'ab']);
    expect(run({ due: { kind: 'range', from: { offsetDays: 1 }, to: '2026-12-31' } })).toEqual(['b']);
  });

  it('bez terminu, z godziną, priorytet, lista, status', () => {
    expect(run({ due: { kind: 'none' } })).toEqual(['none']);
    expect(run({ due: { kind: 'any' }, hasTime: false })).toEqual(['a', 'b']);
    expect(run({ hasTime: true })).toEqual(['ab']);
    expect(run({ priorities: [1, 2] })).toEqual(['a']);
    expect(run({ lists: [INBOX] })).toEqual(['none']);
    expect(run({ statuses: ['waiting'] })).toEqual(['b']);
    expect(run({})).toHaveLength(4);
  });

  it('schemat odrzuca puste listy i obce wartości', () => {
    expect(FilterQuery.safeParse({ priorities: [] }).success).toBe(false);
    expect(FilterQuery.safeParse({ tags: { ids: ['x'], match: 'any' } }).success).toBe(false);
    expect(FilterQuery.safeParse({ due: { kind: 'range', to: '2026-02-30' } }).success).toBe(false);
  });
});

describe('sortowanie i grupowanie', () => {
  const tasks = [
    task({ id: 's1', priority: 3, dueDate: '2026-11-20', sortKey: '0030', createdAt: '2026-11-03T00:00:00Z', tagIds: [TAG_B] }),
    task({ id: 's2', priority: 1, dueDate: null, sortKey: '0010', createdAt: '2026-11-05T00:00:00Z', listId: INBOX }),
    task({ id: 's3', priority: 3, dueDate: '2026-11-19', dueTime: '12:00', sortKey: '0020', createdAt: '2026-11-04T00:00:00Z', tagIds: [TAG_A, TAG_B], status: 'in_progress' }),
    task({ id: 's4', priority: 4, dueDate: '2026-11-19', sortKey: '0040', createdAt: '2026-11-01T00:00:00Z' }),
  ];

  it('ręcznie, priorytet, termin, data dodania', () => {
    expect(ids(sortTasks(tasks, 'manual'))).toEqual(['s2', 's3', 's1', 's4']);
    expect(ids(sortTasks(tasks, 'priority'))).toEqual(['s2', 's3', 's1', 's4']);
    expect(ids(sortTasks(tasks, 'due'))).toEqual(['s3', 's4', 's1', 's2']);
    expect(ids(sortTasks(tasks, 'created'))).toEqual(['s2', 's3', 's1', 's4']);
    expect(ids(tasks)).toEqual(['s1', 's2', 's3', 's4']);
  });

  const groups = (g: ReturnType<typeof groupTasks>) => g.map((x) => `${x.label}:${ids(x.tasks).join(',')}`);

  it('priorytet, status, data', () => {
    expect(groups(groupTasks(tasks, 'priority'))).toEqual(['Krytyczny:s2', 'Średni:s1,s3', 'Niski:s4']);
    expect(groups(groupTasks(tasks, 'status'))).toEqual(['Do zrobienia:s1,s2,s4', 'W trakcie:s3']);
    expect(groups(groupTasks(tasks, 'date'))).toEqual(['czwartek, 19 listopada:s3,s4', 'piątek, 20 listopada:s1', 'Bez terminu:s2']);
    expect(groupTasks(tasks, 'none')).toHaveLength(1);
  });

  it('tagi (zadanie w każdej swojej grupie) i listy z nazwami', () => {
    const tags = [
      { id: TAG_B, name: 'dom', sortKey: '0010' },
      { id: TAG_A, name: 'telefon', sortKey: '0020' },
    ];
    expect(groups(groupTasks(tasks, 'tag', { tags }))).toEqual(['dom:s1,s3', 'telefon:s3', 'Bez tagu:s2,s4']);
    const lists = [
      { id: INBOX, name: 'Inbox', sortKey: '0000' },
      { id: LIST, name: 'Dom', sortKey: '0010' },
    ];
    expect(groups(groupTasks(tasks, 'list', { lists }))).toEqual(['Inbox:s2', 'Dom:s1,s3,s4']);
  });
});

describe('drzewo podzadań', () => {
  const tasks = [
    task({ id: 'root', sortKey: '0010' }),
    task({ id: 'c2', parentId: 'root', sortKey: '0020', status: 'done' }),
    task({ id: 'c1', parentId: 'root', sortKey: '0010' }),
    task({ id: 'c3', parentId: 'root', sortKey: '0030', status: 'cancelled' }),
    task({ id: 'g1', parentId: 'c1', sortKey: '0010' }),
    task({ id: 'orphan', parentId: 'missing', sortKey: '0005' }),
  ];

  it('kolejność ręczna, głębokość, sieroty jako korzenie', () => {
    const tree = buildTree(tasks);
    expect(flattenTree(tree).map((n) => `${'  '.repeat(n.depth)}${n.task.id}`)).toEqual(['orphan', 'root', '  c1', '    g1', '  c2', '  c3']);
    expect(flattenTree(tree, new Set(['c1'])).map((n) => n.task.id)).toEqual(['orphan', 'root', 'c1', 'c2', 'c3']);
  });

  it('postęp bez anulowanych', () => {
    const root = buildTree(tasks).find((n) => n.task.id === 'root')!;
    expect(progress(root)).toEqual({ done: 1, total: 2 });
  });
});

describe('wydajność', () => {
  it('Dziś i Nadchodzące na 2 000 zadań (200 serii) < 50 ms', () => {
    const many = Array.from({ length: 2000 }, (_, i) =>
      task({
        id: `p${i}`,
        dueDate: i % 3 ? `2026-${String(10 + (i % 3)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}` : null,
        recurrence: i % 10 === 0 ? { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO,TH', anchor: '2025-01-06' } : null,
        sortKey: String(i).padStart(4, '0'),
      }),
    );
    const start = performance.now();
    selectToday(many, ctx);
    selectUpcoming(many, ctx);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
