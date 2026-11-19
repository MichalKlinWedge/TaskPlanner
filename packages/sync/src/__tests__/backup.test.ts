/**
 * Kopia JSON nad lokalną bazą (Etap 13): eksport → nowa, pusta baza → import daje te same dane,
 * drugi import nic nie zmienia, wszystko idzie przez outbox (`push_changes`) z tymi samymi id.
 * Bez serwera (atrapa `Remote`); z prawdziwym serwerem — `backup.integration.test.ts`.
 */
import { BACKUP_TABLES, backupRowCount, compareBackups, readBackup, uuidv7, type Backup } from '@taskplanner/core';
import { afterEach, describe, expect, it } from 'vitest';

import { openNodeDb } from '../adapters/node.ts';
import { applyBackupPlan, exportBackup, planBackupImport } from '../backup.ts';
import { SyncEngine } from '../engine.ts';
import type { Remote } from '../remote.ts';
import { fillSample } from './helpers/sample-data.ts';

const USER = '0190a000-0000-7000-8000-0000000000aa';
const OTHER = '0190a000-0000-7000-8000-0000000000bb';
const offline: Remote = { push: () => Promise.reject(new Error('offline')), pull: () => Promise.reject(new Error('offline')) };
const open: { close(): void }[] = [];

async function device(userId = USER) {
  const db = openNodeDb();
  open.push(db);
  const engine = await SyncEngine.open({ db, remote: offline, userId, autoSync: false });
  return { engine, query: engine.db.all.bind(engine.db), mutateMany: engine.mutateMany.bind(engine) };
}

afterEach(() => open.splice(0).forEach((db) => db.close()));

const roundTrip = (backup: Backup) => readBackup(JSON.parse(JSON.stringify(backup)));

describe('kopia JSON nad lokalną bazą', () => {
  it('eksport → pusta baza → import: te same dane, przez outbox, z tymi samymi id', async () => {
    const a = await device();
    await fillSample(a.engine, USER);
    const backup = await exportBackup(a.query, USER, '2026-11-18T21:00:00.000Z');
    expect(backupRowCount(backup)).toBeGreaterThan(15);
    for (const table of ['profiles', 'workspaces', 'lists', 'tasks', 'tags', 'task_tags', 'reminders', 'task_completions', 'time_entries', 'saved_filters', 'review_sessions'] as const) {
      expect(backup.tables[table].length, table).toBeGreaterThan(0);
    }

    // Plik przechodzi walidację (także wiersze zapisane offline, bez wartości domyślnych serwera).
    const { backup: file, invalid } = roundTrip(backup);
    expect(invalid).toEqual([]);

    const b = await device();
    const plan = await planBackupImport(b.query, file, USER);
    expect(plan.ops).toHaveLength(backupRowCount(backup));
    await applyBackupPlan(b.mutateMany, plan);

    expect(compareBackups(backup, await exportBackup(b.query, USER))).toEqual([]);
    expect(await b.engine.pendingCount()).toBe(plan.ops.length);
    const outbox = await b.query<{ tbl: string; row_id: string }>('select tbl, row_id from _outbox order by seq');
    expect(outbox.map((o) => `${o.tbl}:${o.row_id}`)).toEqual(plan.ops.map((o) => `${o.table}:${o.id}`));
    // Zakres liczony lokalnie jak na serwerze (zadanie z listy, tag w zakresie osobistym).
    const task = (await b.engine.get('tasks', backup.tables.tasks[0]!.id))!;
    expect(task.scope_id).toBe(backup.tables.lists.find((l) => l.id === task.list_id)!.scope_id);
    expect(new Set((await b.query('select scope_id from tags')).map((t) => t.scope_id))).toEqual(new Set([USER]));
  });

  it('drugi import tego samego pliku — zero zmian', async () => {
    const a = await device();
    await fillSample(a.engine, USER);
    const { backup } = roundTrip(await exportBackup(a.query, USER));
    const again = await planBackupImport(a.query, backup, USER);
    expect(again.ops).toEqual([]);
    for (const table of BACKUP_TABLES) expect(again.stats[table].added + again.stats[table].changed, table).toBe(0);
  });

  it('import przywraca zmienione i usunięte, niczego nie kasuje', async () => {
    const a = await device();
    const { ids } = await fillSample(a.engine, USER);
    const { backup } = roundTrip(await exportBackup(a.query, USER));
    const extra = uuidv7();
    await a.engine.mutateMany([
      { table: 'tasks', id: ids[2]!, patch: { title: 'Zmieniony' } },
      { table: 'tasks', id: ids[1]!, patch: { deleted_at: '2026-11-19T08:00:00.000Z' } },
      { table: 'tasks', id: extra, patch: { list_id: backup.tables.tasks[0]!.list_id, title: 'Po kopii', sort_key: 'z' } },
    ]);
    const plan = await planBackupImport(a.query, backup, USER);
    expect(plan.ops.map((o) => [o.id, Object.keys(o.patch)])).toEqual([
      [ids[1], ['deleted_at']],
      [ids[2], ['title']],
    ].sort((x, y) => backup.tables.tasks.findIndex((t) => t.id === x[0]) - backup.tables.tasks.findIndex((t) => t.id === y[0])));
    await applyBackupPlan(a.mutateMany, plan);
    expect((await a.engine.get('tasks', ids[2]!))?.title).not.toBe('Zmieniony');
    expect((await a.engine.get('tasks', ids[1]!))?.deleted_at).toBeNull();
    expect((await a.engine.get('tasks', extra))?.title).toBe('Po kopii');
  });

  it('kopia innego konta: zakres osobisty i profil na zalogowanego', async () => {
    const a = await device();
    await fillSample(a.engine, USER);
    const { backup } = roundTrip(await exportBackup(a.query, USER));
    const b = await device(OTHER);
    const plan = await planBackupImport(b.query, backup, OTHER);
    expect(plan.otherAccount).toBe(true);
    await applyBackupPlan(b.mutateMany, plan);
    const moved = await exportBackup(b.query, OTHER);
    expect(moved.tables.profiles.map((p) => p.id)).toEqual([OTHER]);
    expect(new Set(moved.tables.tags.map((t) => t.scope_id))).toEqual(new Set([OTHER]));
    expect(compareBackups(backup, moved)).toEqual([]);
  });
});
