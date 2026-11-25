/**
 * Szablony projektów nad lokalną bazą (offline): projekt → `readProjectSource` → szablon (wiersz
 * `project_templates` przez outbox) → nowy projekt z datą końca → jego migawka = ta sama treść.
 */
import { projectFromTemplateOps, projectTemplateContent, projectTemplateOf, saveTemplateOps, uuidv7 } from '@taskplanner/core';
import { afterEach, describe, expect, it } from 'vitest';

import { openNodeDb } from '../adapters/node.ts';
import { SyncEngine } from '../engine.ts';
import type { Remote } from '../remote.ts';
import { readProjectSource } from '../templates.ts';

const USER = '0190a000-0000-7000-8000-0000000000aa';
const offline: Remote = { push: () => Promise.reject(new Error('offline')), pull: () => Promise.reject(new Error('offline')) };
const open: { close(): void }[] = [];
afterEach(() => open.splice(0).forEach((db) => db.close()));

describe('szablony projektów nad lokalną bazą', () => {
  it('projekt → szablon → nowy projekt z datą końca (offline, przez outbox)', async () => {
    const db = openNodeDb();
    open.push(db);
    const engine = await SyncEngine.open({ db, remote: offline, userId: USER, autoSync: false });
    const query = engine.db.all.bind(engine.db);

    const ws = uuidv7();
    const list = uuidv7();
    const [a, b, b1, b1a, tag] = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    const task = (id: string, patch: Record<string, unknown>) => ({ table: 'tasks' as const, id, patch: { list_id: list, kind: 'task', status: 'todo', priority: 4, postpone_count: 0, ...patch } });
    await engine.mutateMany([
      { table: 'workspaces', id: ws, patch: { name: 'Praca', sort_key: 'a' } },
      { table: 'lists', id: list, patch: { scope_id: ws, kind: 'project', name: 'Wdrożenie', sort_key: 'b', start_date: '2026-12-01', end_date: '2026-12-10', view_prefs: {} } },
      task(a, { parent_id: null, title: 'Analiza', due_date: '2026-12-02', sort_key: 'a' }),
      task(b, { parent_id: null, title: 'Budowa', start_date: '2026-12-03', due_date: '2026-12-10', sort_key: 'b', status: 'done' }),
      task(b1, { parent_id: b, title: 'Moduł', due_date: '2026-12-06', sort_key: 'a' }),
      task(b1a, { parent_id: b1, title: 'Testy modułu', sort_key: 'a' }),
      { table: 'tags', id: tag, patch: { scope_id: USER, name: 'klient', sort_key: 'a' } },
      { table: 'task_tags', id: uuidv7(), patch: { task_id: a, tag_id: tag } },
      { table: 'reminders', id: uuidv7(), patch: { task_id: b1, kind: 'relative', offset_min: 60 } },
      { table: 'task_dependencies', id: uuidv7(), patch: { predecessor_id: a, successor_id: b, kind: 'finish_to_start', lag_days: 1 } },
    ]);

    // Przypomnienie innego członka przestrzeni nie trafia do szablonu.
    await db.run("insert into reminders (id, scope_id, task_id, kind, offset_min, created_by) values (?, ?, ?, 'relative', 5, ?)", [uuidv7(), ws, a, uuidv7()]);
    const content = projectTemplateContent(await readProjectSource(query, list, USER));
    expect(content.project.endDay).toBe(9);
    expect(content.tasks.map((t) => t.title)).toEqual(['Analiza', 'Budowa', 'Moduł', 'Testy modułu']);

    const saved = saveTemplateOps([], 'Wdrożenie klienta', content);
    await engine.mutateMany(saved.ops);
    const [row] = await query<{ id: string; name: string; sort_key: string; content: string }>('select id, name, sort_key, content from project_templates');
    expect(projectTemplateOf(row!).content).toEqual(content);

    const { listId, ops } = projectFromTemplateOps(content, { userId: USER, workspaceId: ws, name: 'Wdrożenie 2', anchor: { kind: 'end', date: '2027-02-28' }, tags: [{ id: tag, name: 'klient', sortKey: 'a' }], lastListSortKey: 'b' });
    await engine.mutateMany(ops);
    const copy = await readProjectSource(query, listId, USER);
    expect(copy.list).toMatchObject({ start_date: '2027-02-19', end_date: '2027-02-28' });
    expect(copy.tasks.find((t) => t.title === 'Budowa')).toMatchObject({ status: 'todo', start_date: '2027-02-21', due_date: '2027-02-28' });
    expect(projectTemplateContent(copy)).toEqual(content);

    // Wszystko czeka w outboxie na `push_changes` (szablon, lista, zadania, tag zadania, przypomnienie, zależność).
    const pending = await query<{ tbl: string }>("select tbl from _outbox where status = 'pending'");
    expect(new Set(pending.map((p) => p.tbl))).toEqual(new Set(['workspaces', 'lists', 'tasks', 'tags', 'task_tags', 'reminders', 'task_dependencies', 'project_templates']));
  });
});
