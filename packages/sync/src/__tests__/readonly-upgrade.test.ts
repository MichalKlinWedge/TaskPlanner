/** Lokalna baza ze starszej wersji: tabela tylko do odczytu dostaje brakującą kolumnę, a zakresy idą raz od zera. */
import { afterEach, describe, expect, it } from 'vitest';

import { openNodeDb } from '../adapters/node.ts';
import { SyncEngine } from '../engine.ts';
import type { Remote } from '../remote.ts';

const USER = '0190a000-0000-7000-8000-0000000000aa';
const offline: Remote = { push: () => Promise.reject(new Error('offline')), pull: () => Promise.reject(new Error('offline')) };
const open: { close(): void }[] = [];
afterEach(() => open.splice(0).forEach((db) => db.close()));

describe('aktualizacja tabel tylko do odczytu', () => {
  it('scope_collaborators bez user_id: kolumna dochodzi, wiersze zostają, kursory wracają do 0', async () => {
    const db = openNodeDb();
    open.push(db);
    await db.run('create table scope_collaborators (id text primary key, scope_id, collaborator_id, name, acronym, archived_at, created_at, updated_at, row_version)');
    await db.run("insert into scope_collaborators (id, scope_id, collaborator_id, name) values ('k', 'w', 'c', 'Anna')");
    await db.run('create table _meta (key text primary key, value text not null)');
    await db.run("insert into _meta (key, value) values ('since', '{\"w\":7}'), ('readonly_tables', '5')");
    await SyncEngine.open({ db, remote: offline, userId: USER, autoSync: false });
    expect(await db.all('select name, user_id from scope_collaborators')).toEqual([{ name: 'Anna', user_id: null }]);
    expect(await db.all("select value from _meta where key = 'since'")).toEqual([{ value: '{"w":0}' }]);
  });
});
