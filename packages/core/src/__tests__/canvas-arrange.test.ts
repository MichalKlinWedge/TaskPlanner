import { describe, expect, it } from 'vitest';
import { canvasArrangePlan, canvasArrangeSummary, canvasDueBucket, type CanvasArrange, type CanvasArrangeContext, type CanvasArrangeTask } from '../canvas-arrange.ts';
import { canvasArrowSegment, canvasCardRect, canvasLayout, cellKey, type CanvasCell, type CanvasSegment } from '../canvas.ts';
import type { Dependency } from '../dependencies.ts';
import { uuidv5 } from '../ids.ts';
import type { CanvasGroup } from '../schemas/model.ts';
import type { Priority, TaskStatus } from '../schemas/primitives.ts';
import type { TaskOp } from '../tasks.ts';

const L = 'list-1';
type T = CanvasArrangeTask;

const task = (id: string, cell: [number, number] | null, extra: Partial<T> = {}): T => ({
  id,
  canvasPos: cell ? { col: cell[0], row: cell[1] } : null,
  sortKey: id,
  priority: 4 as Priority,
  status: 'todo' as TaskStatus,
  dueDate: null,
  tagIds: [],
  ...extra,
});

const group = (id: string, name: string, col: number, row: number, w: number, h: number, color: string | null = null): CanvasGroup => ({ id, name, color, col, row, w, h });

/** Zastosowanie operacji planu do zadań i grup (jak `mutateMany`). */
function apply(tasks: T[], groups: readonly CanvasGroup[], ops: readonly TaskOp[]): { tasks: T[]; groups: CanvasGroup[] } {
  let nextGroups = [...groups];
  const byId = new Map(tasks.map((t) => [t.id, { ...t }]));
  for (const op of ops) {
    if (op.table === 'lists') nextGroups = (op.patch.canvas_groups as CanvasGroup[] | null) ?? [];
    else if (op.table === 'tasks') byId.get(op.id)!.canvasPos = op.patch.canvas_pos as CanvasCell | null;
  }
  return { tasks: [...byId.values()], groups: nextGroups };
}

const plan = (tasks: T[], mode: CanvasArrange, ctx: Partial<CanvasArrangeContext> = {}) => canvasArrangePlan(canvasLayout(tasks), mode, { listId: L, groups: [], ...ctx });
/** Komórki kart po id (karta bez komórki → błąd testu). */
const positions = (tasks: T[]) => (id: string): CanvasCell => tasks.find((t) => t.id === id)?.canvasPos ?? { col: NaN, row: NaN };
const cells = (tasks: T[]) => Object.fromEntries(tasks.map((t) => [t.id, t.canvasPos ? cellKey(t.canvasPos) : null]));
const noOverlap = (tasks: T[]) => {
  const keys = tasks.filter((t) => t.canvasPos).map((t) => cellKey(t.canvasPos!));
  expect(new Set(keys).size).toBe(keys.length);
};

const P1 = '00000000-0000-4000-8000-0000000000a1';

describe('Ułóż według priorytetu / koloru / osoby / statusu / terminu', () => {
  const tasks = [
    task('a', [5, 5], { priority: 2 }),
    task('b', [9, 1], { priority: 1 }),
    task('c', [3, 8], { priority: 2 }),
    task('d', [7, 3], { priority: 4 }),
    task('e', null, { priority: 1 }),
  ];

  it('kolumny wg priorytetu z ramkami, od lewego górnego rogu kart, z kartą z paska', () => {
    const p = plan(tasks, { kind: 'by', by: 'priority' });
    const after = apply(tasks, [], p.ops);
    // Kotwica (3, 1) = lewy górny róg kart; bloki 1 kolumny, między nimi pusta kolumna.
    expect(cells(after.tasks)).toEqual({ b: '3:1', e: '3:2', a: '5:1', c: '5:2', d: '7:1' });
    expect(after.groups.map((g) => [g.name, g.col, g.row, g.w, g.h, g.color])).toEqual([
      ['!1 Krytyczny', 3, 1, 1, 2, '#dc2626'],
      ['!2 Wysoki', 5, 1, 1, 2, '#ea580c'],
      ['!4 Niski', 7, 1, 1, 1, '#71717a'],
    ]);
    expect(p.added).toBe(3);
    expect(p.moves.filter((m) => !m.from).map((m) => m.id)).toEqual(['e']);
    expect(canvasArrangeSummary(p)).toBe('5 karteczek (z paska 1) · ramki: +3');
  });

  it('ponowne ułożenie tym samym sposobem nie zmienia nic; ramki mają deterministyczne id', () => {
    const first = plan(tasks, { kind: 'by', by: 'priority' });
    const after = apply(tasks, [], first.ops);
    expect(after.groups[0]!.id).toBe(uuidv5(`canvas-arrange:${L}:priority:1`));
    expect(plan(tasks, { kind: 'by', by: 'priority' }).ops).toEqual(first.ops);
    const again = plan(after.tasks, { kind: 'by', by: 'priority' }, { groups: after.groups });
    expect(again.ops).toEqual([]);
    expect(canvasArrangeSummary(again)).toBe('nic do zmiany — karteczki już tak leżą');
  });

  it('„Cofnij” przywraca komórki i grupy', () => {
    const groups = [group(P1, 'Pomysły', 5, 5, 1, 1)];
    const p = plan(tasks, { kind: 'by', by: 'priority' }, { groups });
    const after = apply(tasks, groups, p.ops);
    const back = apply(after.tasks, after.groups, p.undo);
    expect(cells(back.tasks)).toEqual(cells(tasks));
    expect(back.groups).toEqual(groups);
  });

  it('bez ramek: tylko komórki; grupa, z której wyszły wszystkie karty, znika', () => {
    const groups = [group(P1, 'Pomysły', 5, 5, 1, 1), group('g-empty', 'Puste', 20, 20, 2, 2)];
    const p = plan(tasks, { kind: 'by', by: 'priority', frames: false }, { groups });
    const after = apply(tasks, groups, p.ops);
    expect(after.groups.map((g) => g.name)).toEqual(['Puste']);
    expect(p.removed).toBe(1);
    expect(p.added).toBe(0);
  });

  it('grupa o nazwie kategorii jest przejmowana (przesunięta), nie dublowana; kolor użytkownika zostaje', () => {
    const groups = [group(P1, '!2 Wysoki', 0, 0, 3, 3, '#16A34A')];
    const p = plan(tasks, { kind: 'by', by: 'priority' }, { groups });
    const after = apply(tasks, groups, p.ops);
    expect(after.groups.filter((g) => g.name === '!2 Wysoki')).toEqual([group(P1, '!2 Wysoki', 5, 1, 1, 2, '#16A34A')]);
    expect(p.added).toBe(2);
    expect(p.changed).toBe(1);
  });

  it('szerokość bloku rośnie z największą kategorią (co 8 kart, maks. 4)', () => {
    const many = Array.from({ length: 20 }, (_, i) => task(`t${String(i).padStart(2, '0')}`, [i, 0], { priority: i < 17 ? 1 : 3 }));
    const after = apply(many, [], plan(many, { kind: 'by', by: 'priority' }).ops);
    // 17 kart → 3 kolumny; drugi blok od kolumny 4.
    expect(after.groups.map((g) => [g.col, g.w, g.h])).toEqual([
      [0, 3, 6],
      [4, 3, 1],
    ]);
    noOverlap(after.tasks);
  });

  it('kolor: pierwszy kolorowy tag w kolejności tagów, potem bez koloru', () => {
    const tags = new Map([
      ['t-red', { id: 't-red', name: 'czerwony', color: '#EF4444', sortKey: 'b' }],
      ['t-blue', { id: 't-blue', name: 'niebieski', color: '#3B82F6', sortKey: 'a' }],
      ['t-plain', { id: 't-plain', name: 'zwykły', color: null, sortKey: 'c' }],
    ]);
    const ts = [task('a', [0, 0], { tagIds: ['t-plain', 't-red'] }), task('b', [1, 0], { tagIds: [] }), task('c', [2, 0], { tagIds: ['t-blue', 't-red'] })];
    const after = apply(ts, [], plan(ts, { kind: 'by', by: 'color' }, { tags }).ops);
    expect(after.groups.map((g) => [g.name, g.color])).toEqual([
      ['niebieski', '#3B82F6'],
      ['czerwony', '#EF4444'],
      ['Bez kolorowego tagu', null],
    ]);
    expect(cells(after.tasks)).toEqual({ c: '0:0', a: '2:0', b: '4:0' });
  });

  it('odpowiedzialny alfabetycznie, status w kolejności statusów', () => {
    const ts = [task('a', [0, 0], { assigneeId: 'p-z', status: 'done' }), task('b', [1, 0], { assigneeId: 'p-a', status: 'in_progress' }), task('c', [2, 0], { status: 'todo' })];
    const collaborators = [
      { id: 'p-z', name: 'Żaneta' },
      { id: 'p-a', name: 'Ania' },
    ];
    expect(apply(ts, [], plan(ts, { kind: 'by', by: 'assignee' }, { collaborators }).ops).groups.map((g) => g.name)).toEqual(['Ania', 'Żaneta', 'Bez odpowiedzialnego']);
    expect(apply(ts, [], plan(ts, { kind: 'by', by: 'status' }).ops).groups.map((g) => g.name)).toEqual(['Do zrobienia', 'W trakcie', 'Gotowe']);
  });

  it('termin: kategorie względem dziś i pierwszego dnia tygodnia', () => {
    const today = '2026-11-18'; // środa
    const b = (dueDate: string | null, status: TaskStatus = 'todo', fdw = 1) => canvasDueBucket({ dueDate, status }, today, fdw);
    expect([b('2026-11-17'), b('2026-11-17', 'done'), b(today), b('2026-11-19'), b('2026-11-22'), b('2026-11-23'), b(null)]).toEqual(['overdue', 'past', 'today', 'tomorrow', 'week', 'later', 'none']);
    // Tydzień od niedzieli: sobota 21.11 to koniec tygodnia.
    expect([b('2026-11-21', 'todo', 7), b('2026-11-22', 'todo', 7)]).toEqual(['week', 'later']);
    const ts = [task('a', [0, 0], { dueDate: '2026-11-30' }), task('b', [1, 0], { dueDate: '2026-11-10' }), task('c', [2, 0])];
    expect(apply(ts, [], plan(ts, { kind: 'by', by: 'due' }, { today }).ops).groups.map((g) => g.name)).toEqual(['Zaległe', 'Później', 'Bez terminu']);
  });

  it('zaznaczenie: tylko zaznaczone karty, układ omija karty spoza zakresu i ich grupy', () => {
    const ts = [task('a', [0, 0], { priority: 1 }), task('b', [0, 1], { priority: 2 }), task('x', [1, 0]), task('y', [2, 0]), task('t', null, { priority: 1 })];
    const groups = [group('gx', 'Inne', 1, 0, 2, 1)];
    const p = plan(ts, { kind: 'by', by: 'priority' }, { groups, selection: new Set(['a', 'b', 't']) });
    const after = apply(ts, groups, p.ops);
    expect(after.tasks.find((t) => t.id === 'x')!.canvasPos).toEqual({ col: 1, row: 0 });
    noOverlap(after.tasks);
    // Ramki nowych kolumn nie nachodzą na grupę „Inne”, a karty x i y nie trafiają do nowych ramek.
    const inside = (g: CanvasGroup, c: CanvasCell) => c.col >= g.col && c.col < g.col + g.w && c.row >= g.row && c.row < g.row + g.h;
    const fresh = after.groups.filter((g) => g.id !== 'gx');
    expect(fresh).toHaveLength(2);
    for (const g of fresh) {
      expect(inside(g, { col: 1, row: 0 }) || inside(g, { col: 2, row: 0 })).toBe(false);
      expect(g.col + g.w <= 1 || g.col >= 3 || g.row + g.h <= 0 || g.row >= 1).toBe(true);
    }
    expect(after.groups.find((g) => g.id === 'gx')).toEqual(groups[0]);
  });

  it('bez paska: karty z paska zostają w pasku', () => {
    const p = plan(tasks, { kind: 'by', by: 'priority' }, { withTray: false });
    expect(apply(tasks, [], p.ops).tasks.find((t) => t.id === 'e')!.canvasPos).toBeNull();
  });

  it('karta pokazana obok (kolizja dwóch osób) dostaje zapis komórki z układu', () => {
    const ts = [task('a', [0, 0], { priority: 1 }), task('b', [0, 0], { priority: 1 })];
    const p = plan(ts, { kind: 'by', by: 'priority', frames: false });
    const after = apply(ts, [], p.ops);
    noOverlap(after.tasks);
    expect(p.ops.map((o) => o.id)).toContain('b');
  });

  it('pusta tablica i pusty zakres', () => {
    expect(plan([], { kind: 'by', by: 'priority' }).ops).toEqual([]);
    expect(plan([task('a', [0, 0])], { kind: 'by', by: 'priority' }, { selection: new Set(['zzz']) }).ops).toEqual([]);
  });
});

describe('Ułóż według strzałek', () => {
  const dep = (id: string, predecessorId: string, successorId: string): Dependency => ({ id, predecessorId, successorId, lagDays: 0 });

  it('warstwy od lewej do prawej (co druga kolumna), karty bez połączeń z boku', () => {
    // a → b → c, a → c (najdłuższa ścieżka: c w warstwie 2); d wynika z b; e, f bez połączeń.
    const ts = [task('a', [4, 4]), task('b', [0, 0]), task('c', [1, 0]), task('d', [2, 0], { derivedFrom: ['b'] }), task('e', [3, 0]), task('f', null)];
    const deps = [dep('1', 'a', 'b'), dep('2', 'b', 'c'), dep('3', 'a', 'c')];
    const p = plan(ts, { kind: 'arrows' }, { dependencies: deps });
    const after = apply(ts, [], p.ops);
    const at = positions(after.tasks);
    expect(at('a')).toEqual({ col: 0, row: 0 });
    expect(at('b')).toEqual({ col: 2, row: 0 });
    expect(at('c').col).toBe(4);
    expect(at('d').col).toBe(4);
    // Bez połączeń: blok za najszerszą składową (kolumna 5 = 4 + 1).
    expect(at('e').col).toBeGreaterThanOrEqual(6);
    expect(at('f').col).toBeGreaterThanOrEqual(6);
    noOverlap(after.tasks);
    expect(p.groups).toEqual([]);
  });

  it('poprzednik zawsze na lewo od następnika; składowe jedna pod drugą; ponowne ułożenie = 0 zmian', () => {
    const ts = [task('a', [0, 0]), task('b', [1, 0]), task('c', [2, 0]), task('d', [3, 0])];
    const deps = [dep('1', 'b', 'a'), dep('2', 'd', 'c')];
    const p = plan(ts, { kind: 'arrows' }, { dependencies: deps });
    const after = apply(ts, [], p.ops);
    const at = positions(after.tasks);
    expect(at('b').col).toBeLessThan(at('a').col);
    expect(at('d').col).toBeLessThan(at('c').col);
    expect(at('c').row).toBe(at('a').row + 2);
    expect(plan(after.tasks, { kind: 'arrows' }, { dependencies: deps }).ops).toEqual([]);
  });

  it('koło z mieszania „blokuje” i „wynika z” — rozcięte, bez nachodzenia, deterministycznie', () => {
    const ts = [task('a', [0, 0], { derivedFrom: ['b'] }), task('b', [1, 0])];
    const deps = [dep('1', 'a', 'b')];
    const p1 = plan(ts, { kind: 'arrows' }, { dependencies: deps });
    const p2 = plan([...ts].reverse(), { kind: 'arrows' }, { dependencies: deps });
    expect(p1.ops).toEqual(p2.ops);
    noOverlap(apply(ts, [], p1.ops).tasks);
  });

  it('kolejność w warstwie wg średniej pozycji poprzedników (mniej skrzyżowań)', () => {
    // Poprzednicy p1 (wyżej), p2 (niżej); następniki s2 (od p2) leżały wyżej niż s1 (od p1).
    const ts = [task('p1', [0, 0]), task('p2', [0, 1]), task('s2', [5, 0]), task('s1', [5, 1])];
    const deps = [dep('1', 'p1', 's1'), dep('2', 'p2', 's2')];
    const after = apply(ts, [], plan(ts, { kind: 'arrows' }, { dependencies: deps }).ops);
    const at = positions(after.tasks);
    expect(at('s1').row).toBeLessThan(at('s2').row);
  });
});

describe('Ułóż według hierarchii', () => {
  // a (główne): a1 (a11, a12), a2; b (główne): b1; c, d — bez podzadań. Kolejność rodzeństwa = sort_key.
  const tree = (): T[] => [
    task('a', [5, 5], { sortKey: 'a' }),
    task('a1', [0, 0], { sortKey: 'a', parentId: 'a' }),
    task('a2', [9, 9], { sortKey: 'b', parentId: 'a' }),
    task('a11', null, { sortKey: 'b', parentId: 'a1' }),
    task('a12', [3, 3], { sortKey: 'a', parentId: 'a1' }),
    task('b', [1, 7], { sortKey: 'b' }),
    task('b1', [2, 7], { sortKey: 'a', parentId: 'b' }),
    task('c', [8, 0], { sortKey: 'c' }),
    task('d', [8, 1], { sortKey: 'd' }),
  ];

  /** Linie rodzic → podzadanie i karty w pikselach (jak `ArrowLayer`) — sprawdzenie geometrii. */
  const lines = (tasks: T[]) => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const main = (t: T): string => {
      const parent = t.parentId ? byId.get(t.parentId) : undefined;
      return parent ? main(parent) : t.id;
    };
    const rects = tasks.map((t) => ({ id: t.id, main: main(t), rect: canvasCardRect(t.canvasPos!) }));
    const rectOf = new Map(rects.map((r) => [r.id, r.rect]));
    const segments = tasks.flatMap((t) => {
      const from = t.parentId ? rectOf.get(t.parentId) : undefined;
      const seg = from ? canvasArrowSegment(from, rectOf.get(t.id)!, 0, 0) : null;
      return seg ? [{ from: t.parentId!, to: t.id, main: main(t), seg }] : [];
    });
    return { rects, segments };
  };
  const side = (s: CanvasSegment, x: number, y: number) => Math.sign((s.x2 - s.x1) * (y - s.y1) - (s.y2 - s.y1) * (x - s.x1));
  const crosses = (p: CanvasSegment, q: CanvasSegment) =>
    side(p, q.x1, q.y1) * side(p, q.x2, q.y2) < 0 && side(q, p.x1, p.y1) * side(q, p.x2, p.y2) < 0;
  const underCard = (s: CanvasSegment, r: { x: number; y: number; w: number; h: number }) =>
    Array.from({ length: 101 }, (_, i) => i / 100).some((k) => {
      const [x, y] = [s.x1 + (s.x2 - s.x1) * k, s.y1 + (s.y2 - s.y1) * k];
      return x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;
    });
  /** Żadne dwie linie się nie krzyżują i żadna nie idzie pod kartą innego zadania głównego; zwraca liczbę linii. */
  const clean = (tasks: T[]) => {
    noOverlap(tasks);
    const { rects, segments } = lines(tasks);
    const bad: string[] = [];
    segments.forEach((p, i) => {
      for (const q of segments.slice(i + 1)) if (p.from !== q.from && crosses(p.seg, q.seg)) bad.push(`${p.from}→${p.to} × ${q.from}→${q.to}`);
      for (const r of rects) if (r.main !== p.main && underCard(p.seg, r.rect)) bad.push(`${p.from}→${p.to} pod ${r.id}`);
    });
    expect(bad).toEqual([]);
    return segments.length;
  };
  /** Zadania główne i tylko one w najwyższym wierszu. */
  const mainsOnTop = (tasks: T[]) => {
    const top = Math.min(...tasks.map((t) => t.canvasPos!.row));
    for (const t of tasks) expect(t.canvasPos!.row === top, t.id).toBe(!t.parentId);
  };

  it('drzewo z góry na dół: główne w pierwszym rzędzie, podzadania pod nimi, każde drzewo we własnym pasie kolumn', () => {
    const ts = tree();
    const p = plan(ts, { kind: 'hierarchy' });
    const after = apply(ts, [], p.ops);
    // Kotwica (0, 0) = lewy górny róg kart na tablicy; zadania bez podzadań obok siebie.
    expect(cells(after.tasks)).toEqual({
      a: '1:0',
      a1: '0:2',
      a12: '0:4',
      a11: '1:4',
      a2: '2:2',
      b: '4:0',
      b1: '4:2',
      c: '6:0',
      d: '7:0',
    });
    expect(clean(after.tasks)).toBe(5);
    mainsOnTop(after.tasks);
    expect(p.groups).toEqual([]);
    expect(plan(after.tasks, { kind: 'hierarchy' }).ops).toEqual([]);
  });

  it('kontrola pomocnika: przeplecione drzewa są wykrywane jako krzyżujące się', () => {
    const ts = [task('p', [0, 0]), task('q', [2, 0]), task('p1', [2, 2], { parentId: 'p' }), task('q1', [0, 2], { parentId: 'q' })];
    expect(() => clean(ts)).toThrow();
  });

  it('ponad 5 podzadań bez własnych podzadań = siatka pod rodzicem, poddrzewa obok', () => {
    const ts = [
      task('m', [4, 4]),
      ...Array.from({ length: 10 }, (_, i) => task(`m${i}`, [i, 9], { parentId: 'm' })),
      task('mx', [0, 0], { parentId: 'm' }),
      task('mx1', [1, 0], { parentId: 'mx' }),
      task('n', [0, 1]),
      task('n1', [0, 2], { parentId: 'n' }),
    ];
    const after = apply(ts, [], plan(ts, { kind: 'hierarchy' }).ops);
    const at = positions(after.tasks);
    // 10 liści: szerokość 4, wiersze 2–4; rodzic nad siatką; poddrzewo `mx` zaraz za nią, `n` za pustą kolumną.
    expect([at('m0'), at('m3'), at('m4'), at('m9')]).toEqual([
      { col: 0, row: 2 },
      { col: 3, row: 2 },
      { col: 0, row: 3 },
      { col: 1, row: 4 },
    ]);
    expect([at('m'), at('mx'), at('mx1'), at('n')]).toEqual([
      { col: 1, row: 0 },
      { col: 4, row: 2 },
      { col: 4, row: 4 },
      { col: 6, row: 0 },
    ]);
    clean(after.tasks);
    mainsOnTop(after.tasks);
  });

  it('losowe drzewa: linie się nie krzyżują, główne w pierwszym rzędzie, powtórka bez zmian', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 20; round++) {
      const ts: T[] = [];
      const depth = new Map<string, number>();
      for (let i = 0; i < 70; i++) {
        const candidates = ts.filter((t) => depth.get(t.id)! < 4);
        const parent = random() < 0.2 ? undefined : candidates[Math.floor(random() * candidates.length)];
        const id = `t${String(i).padStart(2, '0')}`;
        depth.set(id, parent ? depth.get(parent.id)! + 1 : 0);
        ts.push(task(id, random() < 0.1 ? null : [i % 9, Math.floor(i / 9)], { parentId: parent?.id ?? null, sortKey: String(random()) }));
      }
      const after = apply(ts, [], plan(ts, { kind: 'hierarchy' }).ops);
      clean(after.tasks);
      mainsOnTop(after.tasks);
      expect(plan(after.tasks, { kind: 'hierarchy' }).ops).toEqual([]);
      // Wynik nie zależy od kolejności wejścia.
      const reversed = [...ts].reverse();
      expect(cells(apply(reversed, [], plan(reversed, { kind: 'hierarchy' }).ops).tasks)).toEqual(cells(after.tasks));
    }
  });

  it('podzadania bez rodzica w układzie: od drugiego poziomu za zadaniami głównymi, bez głównych — od pierwszego rzędu', () => {
    const ts = [...tree(), task('o', [2, 2], { parentId: 'ukryte' }), task('o1', [2, 3], { parentId: 'o' })];
    const after = apply(ts, [], plan(ts, { kind: 'hierarchy' }).ops);
    const at = positions(after.tasks);
    expect([at('o'), at('o1')]).toEqual([
      { col: 9, row: 2 },
      { col: 9, row: 4 },
    ]);
    mainsOnTop(after.tasks);
    clean(after.tasks);
    const sel = apply(ts, [], plan(ts, { kind: 'hierarchy' }, { selection: new Set(['a1', 'a11', 'a12']) }).ops);
    const on = positions(sel.tasks);
    expect(on('a11').row - on('a1').row).toBe(2);
    expect(on('a12').col).toBe(on('a1').col);
    noOverlap(sel.tasks);
  });

  it('pętla rodziców nie wywraca układu; same zadania główne = jeden rząd', () => {
    const loop = [task('m', [0, 0]), task('x', [1, 0], { parentId: 'y' }), task('y', [2, 0], { parentId: 'x' })];
    const after = apply(loop, [], plan(loop, { kind: 'hierarchy' }).ops);
    noOverlap(after.tasks);
    expect(positions(after.tasks)('m')).toEqual({ col: 0, row: 0 });
    const top = tree().filter((t) => !t.parentId);
    expect(cells(apply(top, [], plan(top, { kind: 'hierarchy' }).ops).tasks)).toEqual({ a: '1:0', b: '2:0', c: '3:0', d: '4:0' });
  });
});

describe('Zagęść', () => {
  it('ciągi pustych kolumn i wierszy skracają się do jednej; róg stoi; grupy jadą z kartami', () => {
    const ts = [task('a', [2, 3]), task('b', [3, 3]), task('c', [9, 3]), task('d', [9, 10]), task('h', null)];
    const groups = [group('g', 'G', 8, 2, 3, 10)];
    const p = canvasArrangePlan(canvasLayout(ts), { kind: 'compact' }, { listId: L, groups, selection: new Set(['a']) });
    const after = apply(ts, groups, p.ops);
    expect(cells(after.tasks)).toEqual({ a: '2:3', b: '3:3', c: '6:3', d: '6:5', h: null });
    // Krawędzie grupy (kolumny 8 i 10, wiersze 2 i 11) liczą się jak zawartość.
    expect(after.groups).toEqual([group('g', 'G', 5, 2, 3, 5)]);
    expect(canvasArrangePlan(canvasLayout(after.tasks), { kind: 'compact' }, { listId: L, groups: after.groups }).ops).toEqual([]);
    const back = apply(after.tasks, after.groups, p.undo);
    expect(cells(back.tasks)).toEqual(cells(ts));
    expect(back.groups).toEqual(groups);
  });

  it('zwarta tablica — nic do zmiany', () => {
    const ts = [task('a', [0, 0]), task('b', [2, 0])];
    expect(canvasArrangePlan(canvasLayout(ts), { kind: 'compact' }, { listId: L, groups: [] }).ops).toEqual([]);
  });
});

describe('wydajność', () => {
  it('500 kart: każdy sposób < 50 ms', () => {
    const tags = new Map(Array.from({ length: 5 }, (_, i) => [`tag${i}`, { id: `tag${i}`, name: `tag ${i}`, color: '#112233', sortKey: String(i) }]));
    const ts = Array.from({ length: 500 }, (_, i) =>
      task(`t${String(i).padStart(3, '0')}`, [(i * 7) % 60, Math.floor(i / 20) * 2], {
        priority: ((i % 4) + 1) as Priority,
        tagIds: [`tag${i % 5}`],
        parentId: i % 12 ? `t${String(i % 4 ? i - (i % 4) : i - (i % 12)).padStart(3, '0')}` : null,
        derivedFrom: i % 2 && i > 25 ? [`t${String(i - 25).padStart(3, '0')}`] : null,
      }),
    );
    const deps = Array.from({ length: 240 }, (_, i) => dep(i));
    function dep(i: number): Dependency {
      const a = i * 2;
      return { id: `d${i}`, predecessorId: `t${String(a).padStart(3, '0')}`, successorId: `t${String(a + 1).padStart(3, '0')}`, lagDays: 0 };
    }
    const layout = canvasLayout(ts);
    const ctx: CanvasArrangeContext = { listId: L, groups: [group(P1, 'G', 0, 0, 5, 5)], tags, dependencies: deps, today: '2026-11-18' };
    const modes: CanvasArrange[] = [{ kind: 'by', by: 'color' }, { kind: 'by', by: 'priority' }, { kind: 'arrows' }, { kind: 'hierarchy' }, { kind: 'compact' }];
    for (const mode of modes) canvasArrangePlan(layout, mode, ctx); // rozgrzewka JIT
    for (const mode of modes) {
      const t0 = performance.now();
      const p = canvasArrangePlan(layout, mode, ctx);
      const ms = performance.now() - t0;
      expect(ms, `${JSON.stringify(mode)}: ${ms.toFixed(1)} ms`).toBeLessThan(50);
      noOverlap(apply(ts, ctx.groups, p.ops).tasks);
    }
  });
});
