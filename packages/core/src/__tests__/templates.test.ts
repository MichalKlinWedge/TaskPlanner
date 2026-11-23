import { describe, expect, it } from 'vitest';

import { tagId, taskTagId } from '../ids.ts';
import { MODEL } from '../schemas/model.ts';
import {
  deleteTemplateOps,
  parseTemplateContent,
  projectFromTemplateOps,
  projectTemplateContent,
  ProjectTemplateContent,
  projectTemplateOf,
  renameTemplateOp,
  saveTemplateOps,
  templateDates,
  templateHasDates,
  templateSummary,
  type ProjectSource,
} from '../templates.ts';
import type { TaskOp } from '../tasks.ts';

const USER = '00000000-0000-4000-8000-000000000001';
const WORKSPACE = '00000000-0000-4000-8000-0000000000aa';
const COL_A = '00000000-0000-4000-8000-0000000000c1';
const COL_B = '00000000-0000-4000-8000-0000000000c2';
const PILNE = '00000000-0000-4000-8000-0000000000d1';

type SourceTask = ProjectSource['tasks'][number];
const task = (id: string, patch: Partial<SourceTask> = {}): SourceTask => ({
  id,
  parent_id: null,
  kind: 'task',
  title: `Zadanie ${id}`,
  description_md: null,
  status: 'todo',
  priority: 4,
  start_date: null,
  due_date: null,
  due_time: null,
  duration_min: null,
  time_zone: null,
  recurrence: null,
  sort_key: id,
  board_column_id: null,
  deleted_at: null,
  ...patch,
});

/** Projekt 1–20.12.2026: trzy poziomy podzadań, tagi, przypomnienia, zależności, kolumny tablicy. */
const source = (): ProjectSource => ({
  list: {
    color: '#3b82f6',
    icon: null,
    description_md: 'Opis projektu',
    start_date: '2026-12-01',
    end_date: '2026-12-20',
    view_prefs: { view: 'timeline' },
    board_columns: [
      { id: COL_A, name: 'Pomysły' },
      { id: COL_B, name: 'W toku' },
    ],
  },
  tasks: [
    task('b', { title: 'Projekt', start_date: '2026-12-01', due_date: '2026-12-05', status: 'done', board_column_id: COL_B }),
    task('a', { title: 'Analiza', due_date: '2026-12-03', due_time: '10:00', duration_min: 60, priority: 1 }),
    task('b1', { parent_id: 'b', title: 'Szkic', due_date: '2026-12-04' }),
    task('b1x', { parent_id: 'b1', title: 'Szkic — wariant A' }),
    task('b1y', { parent_id: 'b1x', title: 'Szczegóły wariantu' }),
    task('c', { title: 'Wdrożenie', due_date: '2026-12-18', recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=FR;UNTIL=20261218', anchor: '2026-12-04' } }),
    task('x', { title: 'Anulowane', status: 'cancelled', due_date: '2026-12-30' }),
    task('x1', { parent_id: 'x', title: 'Pod anulowanym' }),
    task('d', { title: 'W koszu', deleted_at: '2026-12-02T10:00:00Z' }),
    task('h', { title: 'Nawyk', kind: 'habit' }),
  ],
  tags: [
    { task_id: 'a', name: 'pilne' },
    { task_id: 'a', name: 'klient' },
    { task_id: 'b1', name: 'klient' },
    { task_id: 'x', name: 'zbędne' },
  ],
  reminders: [
    { task_id: 'a', kind: 'relative', offset_min: 30, at_date: null, at_time: null },
    { task_id: 'c', kind: 'absolute', offset_min: null, at_date: '2026-12-17', at_time: '09:00' },
  ],
  dependencies: [
    { predecessor_id: 'a', successor_id: 'b', lag_days: 0 },
    { predecessor_id: 'b', successor_id: 'c', lag_days: 2 },
    { predecessor_id: 'b1', successor_id: 'c', lag_days: -1 },
    { predecessor_id: 'x', successor_id: 'c', lag_days: 0 },
  ],
});

const counter = () => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
};
const ofTable = (ops: TaskOp[], table: TaskOp['table']) => ops.filter((op) => op.table === table);

describe('projectTemplateContent', () => {
  const content = projectTemplateContent(source());

  it('zadania w kolejności drzewa, bez kosza, anulowanych (z poddrzewem) i nawyków', () => {
    expect(content.tasks.map((t) => t.title)).toEqual(['Analiza', 'Projekt', 'Szkic', 'Szkic — wariant A', 'Szczegóły wariantu', 'Wdrożenie']);
    const key = (title: string) => content.tasks.find((t) => t.title === title)!.key;
    expect(content.tasks.find((t) => t.title === 'Szkic')!.parent).toBe(key('Projekt'));
    expect(content.tasks.find((t) => t.title === 'Szczegóły wariantu')!.parent).toBe(key('Szkic — wariant A'));
  });

  it('daty jako dni od początku projektu, długość = koniec projektu', () => {
    expect(content.project.endDay).toBe(19);
    const projekt = content.tasks.find((t) => t.title === 'Projekt')!;
    expect([projekt.startDay, projekt.dueDay]).toEqual([0, 4]);
    expect(content.tasks.find((t) => t.title === 'Analiza')).toMatchObject({ dueDay: 2, dueTime: '10:00', durationMin: 60, priority: 1 });
  });

  it('cykl: kotwica i UNTIL jako przesunięcia, RRULE bez UNTIL', () => {
    expect(content.tasks.find((t) => t.title === 'Wdrożenie')!.recurrence).toEqual({ mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=FR', anchorDay: 3, untilDay: 17 });
  });

  it('tagi po nazwie, przypomnienia, kolumna tablicy', () => {
    const analiza = content.tasks.find((t) => t.title === 'Analiza')!;
    expect(analiza.tags).toEqual(['pilne', 'klient']);
    expect(analiza.reminders).toEqual([{ kind: 'relative', offsetMin: 30 }]);
    expect(content.tasks.find((t) => t.title === 'Wdrożenie')!.reminders).toEqual([{ kind: 'absolute', day: 16, time: '09:00' }]);
    expect(content.project.boardColumns).toEqual(['Pomysły', 'W toku']);
    expect(content.tasks.find((t) => t.title === 'Projekt')!.boardColumn).toBe(1);
  });

  it('zależności tylko między zadaniami szablonu', () => {
    expect(content.dependencies).toHaveLength(3);
    expect(content.dependencies.map((d) => d.lagDays)).toEqual([0, 2, -1]);
  });

  it('projekt bez dat: dzień 0 = najwcześniejsza data, długość = najpóźniejsza', () => {
    const s = source();
    s.list.start_date = null;
    s.list.end_date = null;
    const c = projectTemplateContent(s);
    expect(c.project.endDay).toBe(17);
    expect(c.tasks.find((t) => t.title === 'Projekt')!.startDay).toBe(0);
  });

  it('bez żadnej daty — szablon bez dat', () => {
    const c = projectTemplateContent({ ...source(), list: { ...source().list, start_date: null, end_date: null }, tasks: [task('a'), task('b', { parent_id: 'a' })], reminders: [] });
    expect(c.project.endDay).toBeNull();
    expect(templateHasDates(c)).toBe(false);
    expect(templateSummary(c)).toBe('2 zadania · 1 zależność · bez dat');
  });
});

describe('projectFromTemplateOps', () => {
  const content = projectTemplateContent(source());
  const create = (anchor = { kind: 'end' as const, date: '2027-03-31' }) =>
    projectFromTemplateOps(content, {
      userId: USER,
      workspaceId: WORKSPACE,
      name: ' Nowy projekt ',
      anchor,
      tags: [{ id: PILNE, name: 'Pilne', sortKey: 'a' }],
      lastListSortKey: 'b',
      newId: counter(),
    });

  it('data końca: najpóźniejszy dzień projektu = data końca', () => {
    expect(templateDates(content, { kind: 'end', date: '2027-03-31' })).toEqual({ start: '2027-03-12', end: '2027-03-31' });
    const { listId, ops } = create();
    expect(ofTable(ops, 'lists')).toEqual([
      expect.objectContaining({
        id: listId,
        patch: expect.objectContaining({ scope_id: WORKSPACE, kind: 'project', name: 'Nowy projekt', start_date: '2027-03-12', end_date: '2027-03-31', project_status: 'active', sort_key: 'c', view_prefs: { view: 'timeline' } }),
      }),
    ]);
    const tasks = ofTable(ops, 'tasks');
    expect(tasks.map((t) => t.patch.title)).toEqual(['Analiza', 'Projekt', 'Szkic', 'Szkic — wariant A', 'Szczegóły wariantu', 'Wdrożenie']);
    expect(tasks.every((t) => t.patch.status === 'todo' && t.patch.list_id === listId)).toBe(true);
    const projekt = tasks.find((t) => t.patch.title === 'Projekt')!;
    expect([projekt.patch.start_date, projekt.patch.due_date]).toEqual(['2027-03-12', '2027-03-16']);
    expect(tasks.find((t) => t.patch.title === 'Szkic')!.patch.parent_id).toBe(projekt.id);
    expect(tasks.find((t) => t.patch.title === 'Wdrożenie')!.patch.recurrence).toEqual({ mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=FR;UNTIL=20270329', anchor: '2027-03-15' });
  });

  it('data startu', () => {
    const { ops } = create({ kind: 'start', date: '2027-01-04' } as never);
    expect(ofTable(ops, 'lists')[0]!.patch).toMatchObject({ start_date: '2027-01-04', end_date: '2027-01-23' });
    expect(ofTable(ops, 'reminders').map((r) => r.patch)).toEqual([
      { task_id: expect.any(String), kind: 'relative', offset_min: 30, at_date: null, at_time: null },
      { task_id: expect.any(String), kind: 'absolute', offset_min: null, at_date: '2027-01-20', at_time: '09:00' },
    ]);
  });

  it('kolejność rodzeństwa, kolumny tablicy, tagi istniejące i nowe (jeden wiersz na nazwę)', () => {
    const { ops } = create();
    const tasks = ofTable(ops, 'tasks');
    expect(tasks.filter((t) => t.patch.parent_id === null).map((t) => t.patch.sort_key)).toEqual(['0010', '0020', '0030']);
    const columns = ofTable(ops, 'lists')[0]!.patch.board_columns as { id: string; name: string }[];
    expect(columns.map((c) => c.name)).toEqual(['Pomysły', 'W toku']);
    expect(tasks.find((t) => t.patch.title === 'Projekt')!.patch.board_column_id).toBe(columns[1]!.id);

    expect(ofTable(ops, 'tags')).toEqual([{ table: 'tags', id: tagId(USER, 'klient'), patch: expect.objectContaining({ name: 'klient', workspace_ids: [WORKSPACE] }) }]);
    const analiza = tasks.find((t) => t.patch.title === 'Analiza')!;
    expect(ofTable(ops, 'task_tags').filter((t) => t.patch.task_id === analiza.id)).toEqual([
      { table: 'task_tags', id: taskTagId(analiza.id, PILNE), patch: { task_id: analiza.id, tag_id: PILNE, deleted_at: null, sort_key: '0010' } },
      { table: 'task_tags', id: taskTagId(analiza.id, tagId(USER, 'klient')), patch: { task_id: analiza.id, tag_id: tagId(USER, 'klient'), deleted_at: null, sort_key: '0020' } },
    ]);
  });

  it('zależności na nowe id', () => {
    const { ops } = create();
    const id = (title: string) => ofTable(ops, 'tasks').find((t) => t.patch.title === title)!.id;
    expect(ofTable(ops, 'task_dependencies').map((d) => d.patch)).toEqual([
      { predecessor_id: id('Analiza'), successor_id: id('Projekt'), kind: 'finish_to_start', lag_days: 0 },
      { predecessor_id: id('Projekt'), successor_id: id('Wdrożenie'), kind: 'finish_to_start', lag_days: 2 },
      { predecessor_id: id('Szkic'), successor_id: id('Wdrożenie'), kind: 'finish_to_start', lag_days: -1 },
    ]);
  });

  it('każdy wiersz przechodzi schemat modelu', () => {
    const { ops } = create();
    for (const op of ops) {
      if (op.table === 'tags') continue;
      const schema = MODEL[op.table as keyof typeof MODEL];
      const row = op.table === 'tasks' ? { canvas_pos: null, derived_from: null, board_sort_key: null, habit: null, completed_at: null, assignee_id: null, ...op.patch } : op.table === 'lists' ? { archived_at: null, canvas_groups: null, ...op.patch } : op.patch;
      expect(schema.safeParse({ id: op.id, ...row }).error).toBeUndefined();
    }
  });

  it('szablon z datami wymaga daty, bez dat — nie', () => {
    expect(() => projectFromTemplateOps(content, { userId: USER, workspaceId: WORKSPACE, name: 'X', tags: [] })).toThrow('Podaj datę');
    const plain = projectTemplateContent({ ...source(), list: { ...source().list, start_date: null, end_date: null }, tasks: [task('a')], reminders: [], dependencies: [] });
    const { ops } = projectFromTemplateOps(plain, { userId: USER, workspaceId: WORKSPACE, name: 'X', tags: [], newId: counter() });
    expect(ofTable(ops, 'lists')[0]!.patch).toMatchObject({ start_date: null, end_date: null, board_columns: [expect.objectContaining({ name: 'Pomysły' }), expect.anything()] });
    expect(ofTable(ops, 'tasks')[0]!.patch.due_date).toBeNull();
  });

  it('pusta nazwa projektu', () => {
    expect(() => projectFromTemplateOps(content, { userId: USER, workspaceId: WORKSPACE, name: '  ', tags: [], anchor: { kind: 'start', date: '2027-01-01' } })).toThrow('nazwę');
  });
});

describe('treść i wiersze szablonów', () => {
  const content = projectTemplateContent(source());

  it('schemat pilnuje rodziców, poziomów i zależności', () => {
    const t = content.tasks[0]!;
    expect(ProjectTemplateContent.safeParse({ ...content, tasks: [{ ...t, parent: 'nieznany' }] }).success).toBe(false);
    expect(ProjectTemplateContent.safeParse({ ...content, dependencies: [{ from: t.key, to: 'brak', lagDays: 0 }] }).success).toBe(false);
    const deep = ['a', 'b', 'c', 'd', 'e'].map((key, i, all) => ({ ...t, key, parent: i ? all[i - 1]! : null, boardColumn: null }));
    expect(ProjectTemplateContent.safeParse({ ...content, tasks: deep, dependencies: [] }).success).toBe(false);
    expect(ProjectTemplateContent.safeParse({ ...content, tasks: deep.slice(0, 4), dependencies: [] }).success).toBe(true);
  });

  it('wiersz z lokalnej bazy: JSON tekstem; nowsza wersja → brak treści', () => {
    expect(projectTemplateOf({ id: 't', name: 'A', sort_key: 'a', content: JSON.stringify(content) }).content).toEqual(content);
    expect(parseTemplateContent({ ...content, version: 2 })).toBeNull();
    expect(parseTemplateContent('{')).toBeNull();
    expect(templateSummary(null)).toMatch('nowszej wersji');
    expect(templateSummary(content)).toBe('6 zadań · 3 zależności · 20 dni');
  });

  it('zapis: nowa nazwa → nowy wiersz na końcu, ta sama nazwa → zastąpienie', () => {
    const templates = [{ id: 't1', name: 'Wdrożenie klienta', sortKey: 'a' }];
    const created = saveTemplateOps(templates, ' Remont ', content, () => 'nowy');
    expect(created).toEqual({ id: 'nowy', replaced: false, ops: [{ table: 'project_templates', id: 'nowy', patch: { name: 'Remont', content, sort_key: 'b' } }] });
    const replaced = saveTemplateOps(templates, 'wdrożenie KLIENTA', content);
    expect(replaced.replaced).toBe(true);
    expect(replaced.ops[0]).toEqual({ table: 'project_templates', id: 't1', patch: { name: 'wdrożenie KLIENTA', content, deleted_at: null } });
    expect(MODEL.project_templates.safeParse({ id: '00000000-0000-4000-8000-000000000009', scope_id: USER, ...created.ops[0]!.patch }).success).toBe(true);
  });

  it('zmiana nazwy i usunięcie z cofnięciem', () => {
    expect(renameTemplateOp('t1', ' Nowa ')).toEqual({ table: 'project_templates', id: 't1', patch: { name: 'Nowa' } });
    expect(() => renameTemplateOp('t1', ' ')).toThrow();
    expect(deleteTemplateOps('t1', '2026-11-23T10:00:00.000Z')).toEqual({
      ops: [{ table: 'project_templates', id: 't1', patch: { deleted_at: '2026-11-23T10:00:00.000Z' } }],
      undo: [{ table: 'project_templates', id: 't1', patch: { deleted_at: null } }],
    });
  });
});
