/**
 * „✨ Rozbij na kroki”: kontekst bez e-maili, polecenie, schemat odpowiedzi, szkic i operacje z cofnięciem.
 */
import { describe, expect, it } from 'vitest';

import {
  AiBreakdownRequest,
  AiTaskBreakdown,
  BREAKDOWN_MAX_DESCRIPTION,
  BREAKDOWN_MAX_STEPS,
  breakdownDrafts,
  breakdownMinutes,
  breakdownOps,
  breakdownPrompt,
  breakdownRequest,
  canBreakDown,
  maskEmails,
  type AiBreakdownStep,
} from '../ai-breakdown.ts';
import type { ViewTask } from '../views.ts';

const TODAY = '2026-11-24';
const ACCOUNT = '0190a000-0000-4000-8000-00000000000a';

const task = (over: Partial<ViewTask> & { id: string }): ViewTask => ({
  workspaceId: 'w1',
  listId: 'l1',
  parentId: null,
  kind: 'task',
  title: over.id,
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
const step = (title: string, over: Partial<AiBreakdownStep> = {}): AiBreakdownStep => ({ title, durationMin: null, offsetDays: null, priority: null, afterPrevious: false, ...over });

const move = task({ id: 'move', title: 'Przeprowadzka', dueDate: '2026-12-01', durationMin: 600 });
const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};

describe('kontekst dla dostawcy', () => {
  it('maskuje e-maile w tytule, opisie, podzadaniach i wskazówce; przycina opis; przechodzi schemat funkcji', () => {
    const tasks = [
      { ...move, title: 'Przeprowadzka jan.k@example.com' },
      task({ id: 's2', parentId: 'move', title: 'Firma: biuro@firma.pl', sortKey: 'c', status: 'done' }),
      task({ id: 's1', parentId: 'move', title: 'Kartony', sortKey: 'b' }),
      task({ id: 's3', parentId: 'move', title: 'Anulowane', sortKey: 'd', status: 'cancelled' }),
      task({ id: 'obce', title: 'Inne zadanie' }),
    ];
    const request = breakdownRequest(tasks[0]!, { accountId: ACCOUNT, tasks, description: `kontakt <a.b@c.example.org>, ${'x'.repeat(5000)}`, hint: ' pisz na me@x.pl ', today: TODAY });
    expect(AiBreakdownRequest.parse(request)).toEqual(request);
    expect(request.task.title).toBe('Przeprowadzka [e-mail]');
    expect(request.task.description).toHaveLength(BREAKDOWN_MAX_DESCRIPTION);
    expect(request.task.description).toMatch(/^kontakt <\[e-mail\]>, xxx/);
    expect(request.subtasks).toEqual([{ title: 'Kartony', done: false }, { title: 'Firma: [e-mail]', done: true }]);
    expect(request.hint).toBe('pisz na [e-mail]');
    expect(JSON.stringify(request)).not.toContain('@');
    expect(JSON.stringify(request)).not.toContain('Inne zadanie');
  });

  it('maskEmails nie rusza tagów i zwykłych małp', () => {
    expect(maskEmails('zadanie @dom i cena 5 @ 3, kontakt: a@b.pl.')).toBe('zadanie @dom i cena 5 @ 3, kontakt: [e-mail].');
  });

  it('polecenie: okno dni do terminu od dziś albo od początku; bez terminu i po terminie — bez dat', () => {
    const prompt = (over: Partial<ViewTask>, hint: string | null = null) =>
      breakdownPrompt(breakdownRequest({ ...move, ...over }, { accountId: ACCOUNT, tasks: [], description: null, hint, today: TODAY }));
    expect(prompt({})).toContain('liczba dni od 2026-11-24 (0 = ten dzień), najwyżej 7 (termin zadania 2026-12-01)');
    expect(prompt({ startDate: '2026-11-28' })).toContain('liczba dni od 2026-11-28 (0 = ten dzień), najwyżej 3');
    expect(prompt({ dueDate: null })).toContain('offsetDays: null, chyba że');
    expect(prompt({ dueDate: '2026-11-20' })).toContain('offsetDays: null, chyba że');
    expect(prompt({})).toContain('bliska 600 min');
    expect(prompt({}, 'tylko wieczory')).toContain('"wskazowkaUzytkownika":"tylko wieczory"');
  });
});

describe('schemat odpowiedzi', () => {
  it('brakujące i null to to samo; tytuł przycięty', () => {
    expect(AiTaskBreakdown.parse({ steps: [{ title: ' Spakuj kuchnię ', durationMin: null }, { title: 'Zamów auto', durationMin: 30, offsetDays: 2, priority: 2, afterPrevious: true }] })).toEqual({
      steps: [step('Spakuj kuchnię'), step('Zamów auto', { durationMin: 30, offsetDays: 2, priority: 2, afterPrevious: true })],
    });
  });

  it('odrzuca pusty szkic, za dużo kroków, ujemne dni i zmyślony priorytet', () => {
    const bad = (value: unknown) => expect(AiTaskBreakdown.safeParse(value).success).toBe(false);
    bad({ steps: [] });
    bad({ steps: Array.from({ length: BREAKDOWN_MAX_STEPS + 1 }, (_, i) => ({ title: `Krok ${i}` })) });
    bad({ steps: [{ title: 'A', offsetDays: -1 }] });
    bad({ steps: [{ title: 'A', priority: 5 }] });
    bad({ steps: [{ title: '  ' }] });
    bad({ kroki: [] });
  });
});

describe('szkic', () => {
  it('daty od dziś, nie dalej niż termin; krok „po poprzednim” nie przed poprzednim; pierwszy nigdy „po poprzednim”', () => {
    const drafts = breakdownDrafts(
      [step('A', { offsetDays: 3, afterPrevious: true }), step('B', { offsetDays: 1, afterPrevious: true }), step('C', { offsetDays: 90 }), step('D')],
      move,
      { tasks: [move], today: TODAY },
    );
    expect(drafts.map((d) => [d.title, d.dueDate, d.afterPrevious])).toEqual([
      ['A', '2026-11-27', false],
      ['B', '2026-11-27', true],
      ['C', '2026-12-01', false],
      ['D', null, false],
    ]);
    expect(drafts.every((d) => d.selected && d.priority === 4)).toBe(true);
  });

  it('daty od początku zadania; zadanie po terminie — kroki bez dat', () => {
    expect(breakdownDrafts([step('A', { offsetDays: 1 })], { ...move, startDate: '2026-11-28' }, { tasks: [], today: TODAY })[0]!.dueDate).toBe('2026-11-29');
    expect(breakdownDrafts([step('A', { offsetDays: 1 })], { ...move, dueDate: '2026-11-20' }, { tasks: [], today: TODAY })[0]!.dueDate).toBeNull();
    expect(breakdownDrafts([step('A', { offsetDays: 1 })], { ...move, dueDate: null }, { tasks: [], today: TODAY })[0]!.dueDate).toBe('2026-11-25');
  });

  it('pomija powtórzenia podzadań, zadania i kroków (bez wielkości liter i znaków)', () => {
    const tasks = [move, task({ id: 's1', parentId: 'move', title: 'Spakować książki' }), task({ id: 's2', parentId: 'move', title: 'Anulowane', status: 'cancelled' })];
    const drafts = breakdownDrafts([step('spakowac KSIAZKI'), step('przeprowadzka'), step('Umyć okna'), step('umyć okna '), step('Anulowane')], move, { tasks, today: TODAY });
    expect(drafts.map((d) => d.title)).toEqual(['Umyć okna', 'Anulowane']);
  });

  it('suma czasów tylko zaznaczonych', () => {
    const drafts = breakdownDrafts([step('A', { durationMin: 30 }), step('B', { durationMin: 60 }), step('C')], move, { tasks: [], today: TODAY });
    expect(breakdownMinutes(drafts)).toBe(90);
    expect(breakdownMinutes(drafts.map((d) => ({ ...d, selected: d.title !== 'B' })))).toBe(30);
  });
});

describe('operacje', () => {
  const existing = task({ id: 's1', parentId: 'move', title: 'Kartony', sortKey: 'm' });
  const tasks = [move, existing];
  const drafts = breakdownDrafts([step('A', { durationMin: 30, offsetDays: 0 }), step('B', { afterPrevious: true }), step('C', { afterPrevious: true, priority: 2 })], move, { tasks, today: TODAY });
  const options = () => ({ tasks, deps: [], today: TODAY, now: '2026-11-24T10:00:00Z', newId: ids() });

  it('podzadania po istniejących, rosnące klucze, zależności po poprzednim, cofnięcie wszystkiego', () => {
    const result = breakdownOps(drafts, 'move', options())!;
    const created = result.ops.filter((op) => op.table === 'tasks');
    expect(result.count).toBe(3);
    expect(created.map((op) => op.patch.title)).toEqual(['A', 'B', 'C']);
    expect(created[0]!.patch).toMatchObject({ list_id: 'l1', parent_id: 'move', kind: 'task', status: 'todo', priority: 4, due_date: TODAY, due_time: null, duration_min: 30 });
    expect(created[2]!.patch.priority).toBe(2);
    const keys = ['m', ...created.map((op) => String(op.patch.sort_key))];
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(4);
    const links = result.ops.filter((op) => op.table === 'task_dependencies');
    expect(links.map((op) => [op.patch.predecessor_id, op.patch.successor_id])).toEqual([[created[0]!.id, created[1]!.id], [created[1]!.id, created[2]!.id]]);
    expect(new Set(result.ops.map((op) => op.id)).size).toBe(5);
    expect(result.undo).toHaveLength(5);
    expect(new Set(result.undo.map((op) => op.id))).toEqual(new Set(result.ops.map((op) => op.id)));
    expect(result.undo.every((op) => op.patch.deleted_at === '2026-11-24T10:00:00.000Z')).toBe(true);
    expect(result.undo[0]!.table).toBe('task_dependencies');
  });

  it('odznaczony krok: zależność łączy sąsiednie zaznaczone; poprawiony tytuł, data przycięta do terminu', () => {
    const edited = drafts.map((d) => (d.title === 'B' ? { ...d, selected: false } : d.title === 'C' ? { ...d, title: ' C2 ', dueDate: '2027-01-01' } : d));
    const result = breakdownOps(edited, 'move', options())!;
    const created = result.ops.filter((op) => op.table === 'tasks');
    expect(created.map((op) => [op.patch.title, op.patch.due_date])).toEqual([['A', TODAY], ['C2', '2026-12-01']]);
    expect(result.ops.filter((op) => op.table === 'task_dependencies').map((op) => [op.patch.predecessor_id, op.patch.successor_id])).toEqual([[created[0]!.id, created[1]!.id]]);
  });

  it('null: nic nie zaznaczono, zadanie zamknięte / usunięte, nawyk, ostatni poziom', () => {
    expect(breakdownOps(drafts.map((d) => ({ ...d, selected: false })), 'move', options())).toBeNull();
    expect(breakdownOps(drafts, 'nie-ma', options())).toBeNull();
    expect(breakdownOps(drafts, 'move', { ...options(), tasks: [{ ...move, status: 'done' }] })).toBeNull();
    expect(canBreakDown([], { ...move, kind: 'habit' })).toBe(false);
    const chain = [task({ id: 't1' }), task({ id: 't2', parentId: 't1' }), task({ id: 't3', parentId: 't2' }), task({ id: 't4', parentId: 't3' })];
    expect(canBreakDown(chain, chain[2]!)).toBe(true);
    expect(canBreakDown(chain, chain[3]!)).toBe(false);
    expect(breakdownOps(drafts, 't4', { ...options(), tasks: chain })).toBeNull();
  });
});
