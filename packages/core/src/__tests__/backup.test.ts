/**
 * Kopia JSON (Etap 13): koperta i walidacja wierszy, porównanie wartości, plan importu
 * (idempotentny, rodzice przed dziećmi, przeniesienie na inne konto).
 */
import { describe, expect, it } from 'vitest';

import { BackupError, backupFields, backupImportPlan, compareBackups, createBackup, readBackup, sameValue, type Backup, type BackupTable } from '../backup.ts';

const U = '0190a000-0000-7000-8000-0000000000aa';
const U2 = '0190a000-0000-7000-8000-0000000000bb';
const W = '0190a000-0000-7000-8000-000000000001';
const L = '0190a000-0000-7000-8000-000000000002';
const T1 = '0190a000-0000-7000-8000-000000000011';
const T2 = '0190a000-0000-7000-8000-000000000012';
const T3 = '0190a000-0000-7000-8000-000000000013';
const G = '0190a000-0000-7000-8000-000000000021';

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  list_id: L,
  parent_id: null,
  kind: 'task',
  title: `Zadanie ${id.slice(-2)}`,
  description_md: null,
  status: 'todo',
  priority: 4,
  start_date: null,
  due_date: null,
  due_time: null,
  duration_min: null,
  time_zone: null,
  recurrence: null,
  habit: null,
  completed_at: null,
  sort_key: 'a0',
  board_sort_key: null,
  source: null,
  postpone_count: 0,
  deleted_at: null,
  ...extra,
});

const sample = (): Backup =>
  createBackup({
    userId: U,
    exportedAt: '2026-11-19T10:00:00.000Z',
    tables: {
      profiles: [{ id: U, display_name: 'Ja', settings: { timeZone: 'Europe/Warsaw', onboarded: true }, focus: null, calendar_sync: { accountId: W, workspaceIds: [W] }, deleted_at: null, field_clock: '{}' }],
      workspaces: [{ id: W, name: 'Dom', color: '#16a34a', icon: null, sort_key: 'a0', archived_at: null, deleted_at: null }],
      lists: [{ id: L, scope_id: W, kind: 'inbox', name: 'Inbox', color: null, icon: null, description_md: null, start_date: null, end_date: null, project_status: null, sort_key: 'a0', view_prefs: {}, archived_at: null, deleted_at: null }],
      // Podzadanie przed rodzicem (sortowanie po id) — import i tak wyśle rodzica pierwszego.
      tasks: [task(T3, { parent_id: T2 }), task(T2, { parent_id: T1 }), task(T1, { deleted_at: '2026-11-18T08:00:00.123456+00:00' })].reverse(),
      tags: [{ id: G, scope_id: U, name: 'telefon', color: null, sort_key: 'a0', deleted_at: null }],
    },
  });

const asLocal = (backup: Backup) => {
  const rows = new Map<string, Record<string, unknown>>();
  for (const [table, list] of Object.entries(backup.tables)) for (const row of list) rows.set(`${table}:${row.id}`, row);
  return (table: BackupTable, id: string) => rows.get(`${table}:${id}`);
};

describe('plik kopii', () => {
  it('eksport ma tylko pola kopii, wiersze po id', () => {
    const backup = sample();
    expect(Object.keys(backup.tables.profiles[0]!).sort()).toEqual([...backupFields('profiles')].sort());
    expect(backup.tables.tasks.map((t) => t.id)).toEqual([T1, T2, T3]);
    expect('devices' in backup.tables).toBe(false);
  });

  it('przechodzi przez JSON bez zmian i bez błędnych wierszy', () => {
    const backup = sample();
    const { backup: read, invalid } = readBackup(JSON.parse(JSON.stringify(backup)));
    expect(invalid).toEqual([]);
    expect(read).toEqual(backup);
  });

  it('wartości z pliku zostają dokładne (bez domyślnych i przycinania)', () => {
    const backup = sample();
    const { backup: read } = readBackup(JSON.parse(JSON.stringify(backup)));
    expect(read.tables.profiles[0]!.settings).toEqual({ timeZone: 'Europe/Warsaw', onboarded: true });
  });

  it('obca albo nowsza koperta — czytelny błąd', () => {
    expect(() => readBackup({ hello: 1 })).toThrow(BackupError);
    expect(() => readBackup({ ...sample(), version: 2 })).toThrow(/nowszej wersji/);
    expect(() => readBackup({ ...sample(), userId: 'x' })).toThrow(/Uszkodzony plik kopii/);
  });

  it('zły wiersz i powtórzony id są pomijane z opisem', () => {
    const backup = sample();
    const file = JSON.parse(JSON.stringify(backup));
    file.tables.tasks.push({ ...file.tables.tasks[0], title: '' });
    file.tables.tasks.push(task('0190a000-0000-7000-8000-000000000099', { priority: 9 }));
    const { backup: read, invalid } = readBackup(file);
    expect(read.tables.tasks).toHaveLength(3);
    expect(invalid.map((i) => [i.table, i.id])).toEqual([
      ['tasks', T1],
      ['tasks', '0190a000-0000-7000-8000-000000000099'],
    ]);
    expect(invalid[1]!.message).toMatch(/priority/);
  });
});

describe('sameValue', () => {
  it('chwile jako czas, jsonb bez kolejności kluczy, null = brak', () => {
    expect(sameValue('2026-11-19T10:00:00.000Z', '2026-11-19T10:00:00+00:00')).toBe(true);
    expect(sameValue('2026-11-19T10:00:00.000Z', '2026-11-19T11:00:00+00:00')).toBe(false);
    expect(sameValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(null, 0)).toBe(false);
    expect(sameValue('2026-11-19', '2026-11-19')).toBe(true);
  });
});

describe('plan importu', () => {
  it('pusta baza: wszystkie wiersze, rodzic przed podzadaniem', () => {
    const plan = backupImportPlan(sample(), () => undefined, U);
    expect(plan.otherAccount).toBe(false);
    expect(plan.ops.filter((o) => o.table === 'tasks').map((o) => o.id)).toEqual([T1, T2, T3]);
    expect(plan.ops.map((o) => o.table)).toEqual(['profiles', 'workspaces', 'lists', 'tasks', 'tasks', 'tasks', 'tags']);
    expect(plan.stats.tasks).toEqual({ added: 3, changed: 0, same: 0 });
    expect(plan.ops[0]!.patch).not.toHaveProperty('id');
    expect(plan.ops.find((o) => o.id === T1)!.patch.deleted_at).toBe('2026-11-18T08:00:00.123456+00:00');
  });

  it('te same dane lokalnie — nic do zrobienia (idempotentny)', () => {
    const backup = sample();
    const plan = backupImportPlan(backup, asLocal(backup), U);
    expect(plan.ops).toEqual([]);
    expect(plan.stats.tasks).toEqual({ added: 0, changed: 0, same: 3 });
  });

  it('zmienione lokalnie — tylko różniące się pola', () => {
    const backup = sample();
    const local = asLocal(backup);
    const plan = backupImportPlan(backup, (table, id) => (id === T2 ? { ...local(table, id), title: 'Inny', deleted_at: '2026-11-19T00:00:00Z' } : local(table, id)), U);
    expect(plan.ops).toEqual([{ table: 'tasks', id: T2, patch: { title: 'Zadanie 12', deleted_at: null } }]);
    expect(plan.stats.tasks).toEqual({ added: 0, changed: 1, same: 2 });
  });

  it('kopia innego konta: zakres osobisty i profil na zalogowanego, bez kalendarza Google', () => {
    const plan = backupImportPlan(sample(), () => undefined, U2);
    expect(plan.otherAccount).toBe(true);
    const profile = plan.ops.find((o) => o.table === 'profiles')!;
    expect(profile.id).toBe(U2);
    expect(profile.patch).not.toHaveProperty('calendar_sync');
    expect(plan.ops.find((o) => o.table === 'tags')!.patch.scope_id).toBe(U2);
    expect(plan.ops.find((o) => o.table === 'lists')!.patch.scope_id).toBe(W);
  });
});

describe('compareBackups', () => {
  it('te same dane, także z innego konta', () => {
    const a = sample();
    expect(compareBackups(a, JSON.parse(JSON.stringify(a)))).toEqual([]);
    const moved = { ...a, userId: U2, tables: { ...a.tables, tags: a.tables.tags.map((t) => ({ ...t, scope_id: U2 })), profiles: a.tables.profiles.map((p) => ({ ...p, id: U2 })) } };
    expect(compareBackups(moved, a).filter((d) => d.field !== 'calendar_sync')).toEqual([]);
  });

  it('brak wiersza i inne pole', () => {
    const a = sample();
    const b = { ...a, tables: { ...a.tables, tasks: [{ ...a.tables.tasks[0]!, title: 'X' }, a.tables.tasks[1]!] } };
    expect(compareBackups(a, b).map((d) => [d.id, d.field])).toEqual([
      [T1, 'title'],
      [T3, undefined],
    ]);
  });
});
