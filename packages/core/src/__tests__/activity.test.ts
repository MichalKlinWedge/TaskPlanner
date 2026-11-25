import { describe, expect, it } from 'vitest';

import { activityEntries, type ActivityNames, type ActivityRow } from '../activity.ts';

const RULE = 'e7100000-0000-4000-8000-000000000001';
const names: ActivityNames = {
  lists: new Map([['l1', 'Praca']]),
  people: new Map([['p1', 'Jan Kowalski']]),
  rules: new Map([[RULE, 'Zgłoś błąd']]),
};
const other: ActivityNames = { ...names, rules: new Map() };
const row = (id: number, at: string, changes: Record<string, unknown>, source: unknown = null): ActivityRow => ({ id, at, changes, source });
const tag = (name: string) => ({ id: `g-${name}`, name });

describe('activityEntries', () => {
  it('pola zadania z nazwami, bez kolejności ręcznej', () => {
    expect(activityEntries([row(2, 'b', { assignee_id: 'p1', due_time: '10:30:00', sort_key: 'n' }), row(1, 'a', { board_sort_key: 'm' })], names)).toEqual([
      { id: 2, at: 'b', created: false, by: null, lines: ['Odpowiedzialny: Jan Kowalski', 'Godzina: 10:30'] },
    ]);
  });

  it('nowe zadanie z tagami = jeden wpis, tagi w jednej linii, w kolejności dodania', () => {
    const rows = [
      row(3, 'a', { tag_added: tag('pilne') }),
      row(2, 'a', { tag_added: tag('bug') }),
      row(1, 'a', { kind: 'task', list_id: 'l1', title: 'Zgłoszenie', due_date: null, postpone_count: 0 }),
    ];
    expect(activityEntries(rows, names)).toEqual([
      { id: 3, at: 'a', created: true, by: null, lines: ['Lista: Praca', 'Tytuł: Zgłoszenie', 'Dodano tagi: bug, pilne'] },
    ]);
  });

  it('zmiana z reguły po wysyłce — osobny wpis z nazwą reguły tylko dla właściciela', () => {
    const rows = [
      row(4, 'b', { tag_removed: tag('zgłoś') }, { kind: 'plugin', ruleId: RULE }),
      row(3, 'b', { tag_added: tag('wysłane') }, { kind: 'plugin', ruleId: RULE }),
      row(2, 'b', { status: 'done' }, { kind: 'plugin', ruleId: RULE }),
      row(1, 'b', { priority: 2 }),
    ];
    expect(activityEntries(rows, names).map((e) => [e.by, e.lines])).toEqual([
      ['reguła integracji „Zgłoś błąd”', ['Status: Gotowe', 'Dodano tag: wysłane', 'Usunięto tag: zgłoś']],
      [null, [expect.stringMatching(/^Priorytet: /)]],
    ]);
    expect(activityEntries(rows, other)[0]!.by).toBe('reguła integracji');
    expect(activityEntries([row(1, 'a', { due_date: '2026-11-30' }, { kind: 'calendar' })], names)[0]!.by).toBe('Kalendarz Google');
  });

  it('wysyłki: ręczna z wynikiem, reguła zdarzeniowa, połączenie już nieznane', () => {
    const text = (d: Record<string, unknown>, n = names) => activityEntries([row(1, 'a', { delivery: { id: 'd', ruleId: RULE, plugin: 'gitlab', ...d } })], n)[0]!.lines[0];
    expect(text({ status: 'sent', trigger: 'manual' })).toBe('Wyślij do…: wysłano do GitLab (reguła „Zgłoś błąd”)');
    expect(text({ status: 'sent', trigger: 'manual' }, other)).toBe('Wyślij do…: wysłano do GitLab');
    expect(text({ status: 'dead', trigger: 'manual' }, other)).toBe('Wyślij do…: wysyłka do GitLab nie powiodła się');
    expect(text({ status: 'skipped', trigger: 'manual' }, other)).toBe('Wyślij do…: wysyłka do GitLab pominięta');
    expect(text({ status: 'sent', trigger: 'event' })).toBe('Integracja: wysłano do GitLab (reguła „Zgłoś błąd”)');
    expect(text({ status: 'sent', trigger: 'manual', plugin: null }, other)).toBe('Wyślij do…: wysłano');
  });
});
