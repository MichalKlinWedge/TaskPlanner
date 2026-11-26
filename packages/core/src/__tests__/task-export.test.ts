/** Eksport zadań z widoków do arkusza: kolumny, sekcje, wcięcie, nazwy, nazwa pliku. */
import { describe, expect, it } from 'vitest';

import { exportFileName, taskExportNames, tasksSheet, type TaskExportNames } from '../task-export.ts';
import type { ViewTask } from '../views.ts';

const task = (over: Partial<ViewTask>): ViewTask => ({
  id: 't1',
  workspaceId: 'w1',
  listId: 'l1',
  parentId: null,
  kind: 'task',
  title: 'Zadanie',
  status: 'todo',
  priority: 4,
  startDate: null,
  dueDate: null,
  dueTime: null,
  durationMin: null,
  recurrence: null,
  habit: null,
  completedAt: null,
  createdAt: '2026-11-01T10:00:00Z',
  sortKey: 'a',
  tagIds: [],
  postponeCount: 0,
  ...over,
});

const names: TaskExportNames = {
  lists: new Map([['l1', 'Remont kuchni']]),
  workspaces: new Map([['w1', 'Dom']]),
  tags: new Map([
    ['g1', 'zakupy'],
    ['g2', 'pilne'],
  ]),
  collaborators: new Map([['c1', 'Piotr Kowalski']]),
};

describe('eksport zadań', () => {
  it('wiersz zadania: przestrzeń, lista, terminy, czas, priorytet, status, tagi, odpowiedzialny, seria, ukończenie', () => {
    const sheet = tasksSheet(
      [
        {
          task: task({ title: 'Kupić płytki', dueDate: '2026-11-20', dueTime: '09:30', startDate: '2026-11-18', durationMin: 90, priority: 2, tagIds: ['g1', 'g2', 'brak'], assigneeId: 'c1', recurrence: { rrule: 'FREQ=WEEKLY' } as ViewTask['recurrence'] }),
        },
        { task: task({ id: 't2', title: 'Fuga', parentId: 't1', status: 'done', completedAt: '2026-11-19T23:30:00Z' }), depth: 1 },
      ],
      names,
      { timeZone: 'Europe/Warsaw' },
    );
    expect(sheet.columns.map((c) => c.header)).toEqual(['Zadanie', 'Przestrzeń', 'Lista', 'Termin', 'Godzina', 'Początek', 'Czas', 'Priorytet', 'Status', 'Tagi', 'Odpowiedzialny', 'Powtarza się', 'Ukończono']);
    expect(sheet.rows[0]).toEqual(['Kupić płytki', 'Dom', 'Remont kuchni', { date: '2026-11-20' }, '09:30', { date: '2026-11-18' }, '1 h 30 min', 'Wysoki', 'Do zrobienia', 'zakupy, pilne', 'Piotr Kowalski', 'tak', null]);
    // Ukończenie = dzień w strefie (23:30 UTC = 20.11 w Warszawie).
    expect(sheet.rows[1]!.slice(-5)).toEqual(['Gotowe', '', '', '', { date: '2026-11-20' }]);
    expect(sheet.indents).toEqual([0, 1]);
    expect(sheet.indentColumn).toBe(0);
  });

  it('sekcja widoku jako pierwsza kolumna; wystąpienie serii z własnym terminem', () => {
    const sheet = tasksSheet(
      [
        { task: task({ dueDate: '2026-11-10' }), section: 'Zaległe' },
        { task: task({ id: 't2', dueDate: '2026-11-20' }), section: 'Jutro', date: '2026-11-27' },
      ],
      names,
      { name: 'Dziś' },
    );
    expect(sheet.name).toBe('Dziś');
    expect(sheet.columns[0]!.header).toBe('Sekcja');
    expect(sheet.indentColumn).toBe(1);
    expect(sheet.rows.map((r) => [r[0], r[4]])).toEqual([
      ['Zaległe', { date: '2026-11-10' }],
      ['Jutro', { date: '2026-11-27' }],
    ]);
  });

  it('nazwy z danych aplikacji: Inbox z przestrzenią', () => {
    const n = taskExportNames({
      workspaces: [{ id: 'w1', name: 'Dom' }],
      lists: [
        { id: 'i1', name: 'Inbox', kind: 'inbox', workspaceId: 'w1' },
        { id: 'l1', name: 'Remont', kind: 'project', workspaceId: 'w1' },
        { id: 'i2', name: 'Inbox', kind: 'inbox', workspaceId: 'w9' },
      ],
      tags: [{ id: 'g1', name: 'zakupy' }],
      collaborators: [{ id: 'c1', name: 'Ola' }],
    });
    expect([...n.lists.values()]).toEqual(['Inbox (Dom)', 'Remont', 'Inbox ()']);
    expect(n.workspaces.get('w1')).toBe('Dom');
    expect(n.tags.get('g1')).toBe('zakupy');
    expect(n.collaborators.get('c1')).toBe('Ola');
  });

  it('nazwa pliku bez polskich znaków', () => {
    expect(exportFileName('Remont kuchni — Łazienka!', '2026-11-20')).toBe('remont-kuchni-lazienka-2026-11-20.xlsx');
    expect(exportFileName('@@@', '2026-11-20')).toBe('zadania-2026-11-20.xlsx');
    expect(exportFileName('Burza mózgów', '2026-11-23', 'png')).toBe('burza-mozgow-2026-11-23.png');
  });
});
