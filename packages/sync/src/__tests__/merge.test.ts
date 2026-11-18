import { describe, expect, it } from 'vitest';

import { decodeRow, encodeRow, mergeClocks, mergeRemote } from '../merge.ts';

const h = (wall: number, node = 'dev') => `${String(wall).padStart(15, '0')}:00000:${node}`;

describe('scalanie wiersza z serwera', () => {
  const remote = {
    id: 't1',
    scope_id: 'w1',
    list_id: 'l1',
    title: 'Z serwera',
    priority: 2,
    recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY' },
    row_version: 7,
    field_clock: { title: h(2000), priority: h(2000) },
  };

  it('bez wiersza lokalnego — wiersz serwera (jsonb jako tekst)', () => {
    const { row, localWon } = mergeRemote('tasks', undefined, remote);
    expect(localWon).toBe(false);
    expect(row.title).toBe('Z serwera');
    expect(row.recurrence).toBe('{"mode":"schedule","rrule":"FREQ=DAILY"}');
    expect(decodeRow('tasks', row)).toMatchObject({ recurrence: { rrule: 'FREQ=DAILY' } });
  });

  it('pole z nowszym lokalnym HLC (niewysłana zmiana) zostaje lokalne, reszta z serwera', () => {
    const local = { ...encodeRow('tasks', { ...remote, title: 'Lokalnie', priority: 4 }), field_clock: JSON.stringify({ title: h(3000), priority: h(1000) }) };
    const { row, localWon } = mergeRemote('tasks', local, remote);
    expect(localWon).toBe(true);
    expect(row.title).toBe('Lokalnie');
    expect(row.priority).toBe(2);
    expect(JSON.parse(row.field_clock as string)).toEqual({ title: h(3000), priority: h(2000) });
  });

  it('remis HLC — wartość serwera (pole wyliczone przez trigger)', () => {
    const local = { ...encodeRow('tasks', { ...remote, list_id: 'inna' }), field_clock: JSON.stringify({ list_id: h(2000) }) };
    const { row } = mergeRemote('tasks', local, { ...remote, field_clock: { ...remote.field_clock, list_id: h(2000) } });
    expect(row.list_id).toBe('l1');
  });

  it('kolumny systemowe zawsze z serwera', () => {
    const local = { ...encodeRow('tasks', { ...remote, row_version: 3, scope_id: 'stary' }) };
    expect(mergeRemote('tasks', local, remote).row).toMatchObject({ row_version: 7, scope_id: 'w1' });
  });

  it('zegary pól łączone maksimum', () => {
    expect(mergeClocks({ a: h(1), b: h(5) }, { a: h(2), c: h(3) })).toEqual({ a: h(2), b: h(5), c: h(3) });
  });
});
