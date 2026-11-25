/** Akcje powiadomienia w przeglądarce: „Ukończ” (powtórki, stare wystąpienia serii) i „Odłóż 10 min”. */
import { describe, expect, it } from 'vitest';

import { reminderDoneOps, snoozeReminderId, snoozeReminderOps } from '../reminder-actions.ts';
import type { ReminderRule } from '../reminders.ts';
import { toViewTask, type LocalTaskRow } from '../tasks.ts';

const WAW = 'Europe/Warsaw';
const task = (over: Partial<LocalTaskRow> = {}) =>
  toViewTask({
    id: 't1', scope_id: 'w', list_id: 'l', parent_id: null, kind: 'task', title: 'Lekarz', status: 'todo', priority: 4, start_date: null, due_date: '2026-11-20', due_time: '10:00',
    duration_min: null, recurrence: null, habit: null, completed_at: null, created_at: null, sort_key: 'k', board_sort_key: null, postpone_count: 0, ...over,
  } as LocalTaskRow);
const daily = JSON.stringify({ mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' });
const rel: ReminderRule = { id: 'r', taskId: 't1', kind: 'relative', offsetMin: 30, atDate: null, atTime: null };
const abs: ReminderRule = { id: 'a', taskId: 't1', kind: 'absolute', offsetMin: null, atDate: '2026-11-20', atTime: '09:30' };
const snoozed = (time: string): ReminderRule => ({ ...abs, id: snoozeReminderId('u', 't1', '2026-11-20', time), atTime: time });
const now = '2026-11-20T08:30:20Z'; // 9:30:20 w Warszawie
const opts = { now, timeZone: WAW, userId: 'u' };

describe('snoozeReminderOps', () => {
  it('jednorazowe przypomnienie za 10 min, pełna minuta w górę', () => {
    const r = snoozeReminderOps(task(), [rel], opts)!;
    expect(r.time).toBe('09:41');
    expect(r.ops).toEqual([
      { table: 'reminders', id: snoozeReminderId('u', 't1', '2026-11-20', '09:41'), patch: { task_id: 't1', kind: 'absolute', offset_min: null, at_date: '2026-11-20', at_time: '09:41', deleted_at: null } },
    ]);
    expect(r.undo).toEqual([{ table: 'reminders', id: r.ops[0]!.id, patch: { deleted_at: '2026-11-20T08:30:20.000Z' } }]);
  });

  it('przez północ — następny dzień', () => {
    expect(snoozeReminderOps(task(), [], { ...opts, now: '2026-11-20T22:55:00Z' })!.ops[0]!.patch).toMatchObject({ at_date: '2026-11-21', at_time: '00:05' });
  });

  it('kolejne odłożenie zastępuje poprzednie; zwykłe i cudze jednorazowe zostają', () => {
    const other = { ...abs, id: snoozeReminderId('kto-inny', 't1', '2026-11-20', '09:31'), atTime: '09:31' as const };
    const r = snoozeReminderOps(task(), [rel, abs, other, snoozed('09:30')], opts)!;
    expect(r.ops.map((op) => op.id)).toEqual([snoozeReminderId('u', 't1', '2026-11-20', '09:41'), snoozed('09:30').id]);
    expect(r.undo[1]).toEqual({ table: 'reminders', id: snoozed('09:30').id, patch: { deleted_at: null } });
    // Ta sama minuta drugi raz — ten sam wiersz, niczego nie usuwa.
    expect(snoozeReminderOps(task(), [snoozed('09:41')], opts)!.ops).toHaveLength(1);
  });

  it('zamknięte zadanie i nawyk — null', () => {
    expect(snoozeReminderOps(task({ status: 'done' }), [], opts)).toBeNull();
    expect(snoozeReminderOps(task({ kind: 'habit' }), [], opts)).toBeNull();
  });
});

describe('reminderDoneOps', () => {
  it('zwykłe zadanie: ukończone, odłożone przypomnienie znika; cofnięcie je przywraca', () => {
    const r = reminderDoneOps(task(), 'r:2026-11-20', [rel, snoozed('09:41')], opts)!;
    expect(r.ops[0]).toMatchObject({ table: 'tasks', id: 't1', patch: { status: 'done' } });
    expect(r.ops.at(-1)).toMatchObject({ table: 'reminders', id: snoozed('09:41').id });
    expect(r.undo.at(-1)).toEqual({ table: 'reminders', id: snoozed('09:41').id, patch: { deleted_at: null } });
    expect(reminderDoneOps(task({ status: 'done' }), 'r:2026-11-20', [rel], opts)).toBeNull();
  });

  it('seria: tylko bieżące wystąpienie', () => {
    const series = task({ recurrence: daily });
    expect(reminderDoneOps(series, 'r:2026-11-20', [rel], opts)!.nextDue).toBe('2026-11-21');
    expect(reminderDoneOps(series, 'r:2026-11-19', [rel], opts)).toBeNull();
    // Automatyczne (osoba odpowiedzialna) niesie dzień wystąpienia, choć nie ma wiersza.
    expect(reminderDoneOps(series, 'a-t1:2026-11-20', [], opts)!.nextDue).toBe('2026-11-21');
    expect(reminderDoneOps(series, 'a-t1:2026-11-19', [], opts)).toBeNull();
    // Jednorazowe nie zna wystąpienia: po ukończeniu (termin w przyszłości) nic.
    expect(reminderDoneOps(series, 'a:2026-11-20', [abs], opts)).not.toBeNull();
    expect(reminderDoneOps(task({ recurrence: daily, due_date: '2026-11-21' }), 'a:2026-11-20', [abs], opts)).toBeNull();
  });
});
