/** Widoki zbiorcze z opcjami listy: ustawienia w profilu, zadania i kolumny tablicy. */
import { describe, expect, it } from 'vitest';

import { boardColumns, boardDropOps } from '../kanban.ts';
import { ProfileSettings } from '../schemas/model.ts';
import { smartBoard, smartViewsPatch } from '../smart-views.ts';
import { toViewTask, type LocalTaskRow } from '../tasks.ts';
import type { ViewContext, ViewTask } from '../views.ts';

const row: LocalTaskRow = {
  id: 'x',
  scope_id: 'w',
  list_id: 'IN',
  parent_id: null,
  kind: 'task',
  title: 'x',
  status: 'todo',
  priority: 4,
  start_date: null,
  due_date: null,
  due_time: null,
  duration_min: null,
  recurrence: null,
  habit: null,
  completed_at: null,
  created_at: '2026-11-01T10:00:00Z',
  sort_key: 'm',
  postpone_count: 0,
};
const t = (id: string, over: Partial<ViewTask> = {}): ViewTask => ({ ...toViewTask({ ...row, id, title: id }), ...over });
// Czwartek 19.11.2026.
const ctx: ViewContext = { today: '2026-11-19', timeZone: 'Europe/Warsaw', workspaceId: null, firstDayOfWeek: 1 };
const opts = { inboxIds: new Set(['IN']), now: '2026-11-19T12:00' };

const tasks = [
  t('old', { dueDate: '2026-11-03', listId: 'L' }),
  t('mon', { dueDate: '2026-11-16', listId: 'L' }),
  t('late', { dueDate: '2026-11-19', dueTime: '10:00', listId: 'L' }),
  t('now', { dueDate: '2026-11-19' }),
  t('sub', { dueDate: '2026-11-19', parentId: 'plain' }),
  t('fri', { dueDate: '2026-11-27', listId: 'L' }),
  t('far', { dueDate: '2026-12-24', listId: 'L' }),
  t('series', { dueDate: '2026-11-20', listId: 'L', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-20' } as ViewTask['recurrence'] }),
  t('plain'),
  t('done', { status: 'done', completedAt: '2026-11-19T08:00:00Z', dueDate: '2026-11-19', listId: 'L' }),
  t('doneInbox', { status: 'done', completedAt: '2026-11-15T08:00:00Z' }),
];
const ids = (list: readonly ViewTask[]) => list.map((x) => x.id).sort();
const board = (view: Parameters<typeof smartBoard>[0], by: Parameters<typeof boardColumns>[1]) => {
  const b = smartBoard(view, tasks, ctx, opts);
  return boardColumns(b.tasks, by, { today: ctx.today, firstDayOfWeek: 1, ...b.options });
};
const filled = (cols: ReturnType<typeof board>) => cols.filter((c) => c.tasks.length).map((c) => [c.key, ids(c.tasks), c.fixed ?? false]);

describe('tablica widoku', () => {
  it('Inbox: główne zadania skrzynek i „Gotowe” z 7 dni', () => {
    expect(filled(board('inbox', 'status'))).toEqual([
      ['todo', ['now', 'plain'], false],
      ['done', ['doneInbox'], false],
    ]);
    expect(smartBoard('inbox', tasks, { ...ctx, workspaceId: 'inna' }, opts).tasks).toEqual([]);
  });

  it('Dziś: zaległe, dzisiejsze (także podzadania) i ukończone dziś; nowa karta na dziś', () => {
    expect(filled(board('today', 'status'))).toEqual([
      ['todo', ['late', 'mon', 'now', 'old', 'sub'], false],
      ['done', ['done'], false],
    ]);
    expect(smartBoard('today', tasks, ctx, opts).addDue).toBe('2026-11-19');
  });

  it('Zaległe według dni: starsze niż tydzień stoją w „Wcześniej”, bez dodawania', () => {
    expect(filled(board('overdue', 'weekday'))).toEqual([
      ['before', ['old'], true],
      ['2026-11-16', ['mon'], false],
      ['2026-11-19', ['late'], false],
    ]);
    expect(smartBoard('overdue', tasks, ctx, opts).addDue).toBeUndefined();
  });

  it('Nadchodzące według dni: 14 dni od dziś i „Później”, seria ma jedną kartę', () => {
    const cols = board('upcoming', 'weekday');
    expect(cols.map((c) => c.key).slice(0, 2)).toEqual(['2026-11-19', '2026-11-20']);
    expect(cols.filter((c) => !c.fixed)).toHaveLength(14);
    expect(filled(cols)).toEqual([
      ['2026-11-19', ['late', 'now', 'sub'], false],
      ['2026-11-20', ['series'], false],
      ['2026-11-27', ['fri'], false],
      ['after', ['far'], true],
    ]);
  });

  it('Bez terminu: otwarte bez daty, wszystkie w kolumnie „Bez terminu”; nowa karta bez terminu', () => {
    expect(filled(board('undated', 'status'))).toEqual([['todo', ['plain'], false]]);
    expect(filled(board('undated', 'weekday'))).toEqual([['none', ['plain'], false]]);
    expect(smartBoard('undated', tasks, ctx, opts).addDue).toBeNull();
  });

  it('kolumna tylko do pokazania nie przyjmuje kart; przeniesienie podzadania na listę wraca do rodzica', () => {
    const drop = { today: ctx.today, now: '2026-11-19T11:00:00Z', timeZone: 'Europe/Warsaw' };
    const now = tasks.find((x) => x.id === 'now')!;
    expect(boardDropOps(now, tasks, 'weekday', '2026-11-19', 'after', [], 0, drop)).toEqual({ ops: [], undo: [] });
    const sub = tasks.find((x) => x.id === 'sub')!;
    const { ops, undo } = boardDropOps(sub, tasks, 'list', 'IN', 'L', [], 0, drop);
    expect(ops).toContainEqual({ table: 'tasks', id: 'sub', patch: { list_id: 'L', parent_id: null, canvas_pos: null } });
    expect(undo).toContainEqual({ table: 'tasks', id: 'sub', patch: { list_id: 'IN', parent_id: 'plain' } });
  });

  it('zwykła tablica dalej pomija dni spoza tygodnia i podzadania', () => {
    const cols = boardColumns(tasks, 'weekday', { today: ctx.today });
    expect(cols).toHaveLength(8);
    expect(cols.flatMap((c) => c.tasks.map((x) => x.id))).not.toContain('sub');
  });
});

describe('ustawienia', () => {
  it('zmiana jednego widoku zostawia resztę, puste znikają; uszkodzone nie psują profilu', () => {
    const views = smartViewsPatch({ today: { view: 'kanban' } }, 'inbox', { columns: ['due'], columnTags: [] });
    expect(views).toEqual({ today: { view: 'kanban' }, inbox: { columns: ['due'] } });
    expect(smartViewsPatch(views, 'inbox', { columns: [] })).toEqual({ today: { view: 'kanban' }, inbox: {} });
    expect(ProfileSettings.parse({ views: { inbox: 5, today: { view: 'kanban', boardBy: 'nie ma' } } }).views.today?.view).toBe('kanban');
  });
});
