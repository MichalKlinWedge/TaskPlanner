/**
 * Przyrostowe odświeżanie zadań (`createTaskCache`): po zmianach z `watch` wynik jest taki sam jak
 * pełny odczyt, niezmienione wpisy zostają tymi samymi obiektami, a czytane są tylko zmienione zadania.
 */
import { inboxId, keyBetween, uuidv7 } from '@taskplanner/core';
import { afterEach, describe, expect, it } from 'vitest';

import { openNodeDb } from '../adapters/node.ts';
import { addChange, changesFromJson, changesToJson, MAX_CHANGED_IDS, type ChangeSet, type TableChanges } from '../changes.ts';
import { SyncEngine } from '../engine.ts';
import type { SqlRow, SqlValue } from '../local-db.ts';
import type { Remote } from '../remote.ts';
import { createTaskCache, type TaskEntry } from '../task-cache.ts';
import { fillSample } from './helpers/sample-data.ts';

const USER = '0190a000-0000-7000-8000-0000000000aa';
const offline: Remote = { push: () => Promise.reject(new Error('offline')), pull: () => Promise.reject(new Error('offline')) };
const open: { close(): void }[] = [];
afterEach(() => open.splice(0).forEach((db) => db.close()));

async function setup() {
  const db = openNodeDb();
  open.push(db);
  const engine = await SyncEngine.open({ db, remote: offline, userId: USER, autoSync: false });
  const { ids } = await fillSample(engine, USER);
  const sql: string[] = [];
  const query = (text: string, params?: readonly SqlValue[]) => (sql.push(text), engine.db.all<SqlRow>(text, params));
  const cache = createTaskCache(query);
  const seen: TableChanges[] = [];
  engine.watch(['tasks', 'task_tags', 'tags'], (changes) => (cache.note(changes), seen.push(changes)));
  const workspace = String((await engine.db.all('select id from workspaces'))[0]!.id);
  return { engine, cache, sql, seen, ids, inbox: inboxId(workspace) };
}

const shape = (entries: readonly TaskEntry[]) => [...entries].sort((a, b) => (String(a.row.id) < String(b.row.id) ? -1 : 1)).map((e) => ({ ...e.row, tags: [...e.tagIds] }));

describe('createTaskCache', () => {
  it('zmiana jednego zadania: czyta tylko je, reszta to te same obiekty, wynik = pełny odczyt', async () => {
    const { engine, cache, sql, seen, ids, inbox } = await setup();
    const first = await cache.read();
    expect(first.length).toBeGreaterThan(2);
    expect(await cache.read()).toBe(first);

    sql.length = 0;
    await engine.mutate('tasks', ids[2]!, { title: 'Raport kwartalny' });
    expect(seen.at(-1)).toEqual(new Map([['tasks', new Set([ids[2]])]]));
    const second = await cache.read();
    expect(sql.every((s) => s.includes(' in ('))).toBe(true);
    expect(second.find((e) => e.row.id === ids[2])!.row.title).toBe('Raport kwartalny');
    for (const entry of second) if (entry.row.id !== ids[2]) expect(first).toContain(entry);
    expect(second.map((e) => e.row.id)).toEqual(first.map((e) => e.row.id));

    // Nowe zadanie (na końcu), tag na zadaniu, usunięcie, zmiana innej tabeli.
    const added = uuidv7();
    const tag = uuidv7();
    const link = uuidv7();
    await engine.mutateMany([
      { table: 'tasks', id: added, patch: { list_id: inbox, title: 'Nowe', sort_key: keyBetween(undefined), status: 'todo', priority: 4, kind: 'task', postpone_count: 0 } },
      { table: 'tags', id: tag, patch: { name: 'pilne', sort_key: 'a' } },
      { table: 'task_tags', id: link, patch: { task_id: ids[2], tag_id: tag } },
    ]);
    await engine.remove('tasks', ids[1]!);
    const third = await cache.read();
    expect(third.at(-1)!.row.id).toBe(added);
    expect(third.some((e) => e.row.id === ids[1])).toBe(false);
    expect(third.find((e) => e.row.id === ids[2])!.tagIds).toContain(tag);

    await engine.remove('task_tags', link);
    const fourth = await cache.read();
    expect(fourth.find((e) => e.row.id === ids[2])!.tagIds).not.toContain(tag);

    await engine.mutate('tags', tag, { name: 'bardzo pilne' });
    expect(await cache.read()).toBe(fourth);

    const fresh = createTaskCache((text, params) => engine.db.all<SqlRow>(text, params));
    expect(shape(fourth)).toEqual(shape(await fresh.read()));
  });

  it('nieznane id (`null`), `note()` bez zmian i nieudany odczyt → pełny odczyt', async () => {
    const { engine, cache, sql } = await setup();
    await cache.read();
    sql.length = 0;
    cache.note(new Map([['tasks', null]]));
    await cache.read();
    expect(sql.some((s) => s.includes('from tasks t where t.deleted_at is null') && !s.includes(' in ('))).toBe(true);

    let fail = true;
    const flaky = createTaskCache((text, params) => (fail ? Promise.reject(new Error('baza')) : engine.db.all<SqlRow>(text, params)));
    await expect(flaky.read()).rejects.toThrow('baza');
    fail = false;
    expect((await flaky.read()).length).toBeGreaterThan(0);
  });
});

describe('zmiany w powiadomieniach', () => {
  it('za dużo id → cała tabela; JSON dla kart w obie strony', () => {
    const changes: ChangeSet = new Map();
    for (let i = 0; i <= MAX_CHANGED_IDS; i++) addChange(changes, 'tasks', `t${i}`);
    addChange(changes, 'tags', 'a');
    expect(changes.get('tasks')).toBeNull();
    expect(changesFromJson(['tasks', 'tags'], changesToJson(changes))).toEqual(new Map([['tasks', null], ['tags', new Set(['a'])]]));
    // Starsza karta-lider bez `ids`.
    expect(changesFromJson(['tasks'], undefined)).toEqual(new Map([['tasks', null]]));
  });
});
