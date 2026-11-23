import { describe, expect, it } from 'vitest';
import {
  addCanvasGroupOps,
  canvasArrangeOps,
  canvasBounds,
  canvasColorTag,
  canvasGroupsOf,
  canvasLayout,
  canvasMoveOps,
  canvasPlaceOps,
  canvasUnplaceOps,
  cellInGroup,
  cellKey,
  fitTitle,
  moveCanvasGroupOps,
  nearestFreeCell,
  removeCanvasGroupOps,
  updateCanvasGroupOps,
  zoomCanvasViewport,
} from '../canvas.ts';
import { canvasPosOf, moveTaskOps, reorderTaskTagOps } from '../tasks.ts';
import { taskTagId } from '../ids.ts';

const card = (id: string, col?: number, row?: number, sortKey = id) => ({ id, sortKey, canvasPos: col === undefined ? null : { col, row: row! } });
const occupied = (...cells: [number, number][]) => new Set(cells.map(([col, row]) => cellKey({ col, row })));
const G1 = '00000000-0000-4000-8000-0000000000a1';
const G2 = '00000000-0000-4000-8000-0000000000a2';

describe('nearestFreeCell', () => {
  it('wolna komórka — ta sama', () => {
    expect(nearestFreeCell(occupied([1, 1]), { col: 0, row: 0 })).toEqual({ col: 0, row: 0 });
  });
  it('zajęta — najbliższa sąsiednia, remis: wyżej, potem w lewo', () => {
    expect(nearestFreeCell(occupied([0, 0]), { col: 0, row: 0 })).toEqual({ col: 0, row: -1 });
    expect(nearestFreeCell(occupied([0, 0], [0, -1]), { col: 0, row: 0 })).toEqual({ col: -1, row: 0 });
  });
  it('bliżej po prostej niż po przekątnej', () => {
    // Wolne tylko (1, 1) po przekątnej i (2, 0) — (1, 1): odległość √2 < 2.
    const taken = occupied([0, 0], [0, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [1, -1], [-1, 1]);
    expect(nearestFreeCell(taken, { col: 0, row: 0 })).toEqual({ col: 1, row: 1 });
  });
  it('cały pierścień zajęty — następny', () => {
    const taken = new Set<string>();
    for (let c = -1; c <= 1; c++) for (let r = -1; r <= 1; r++) taken.add(cellKey({ col: c, row: r }));
    expect(nearestFreeCell(taken, { col: 0, row: 0 })).toEqual({ col: 0, row: -2 });
  });
});

describe('canvasLayout', () => {
  it('karty z komórką na siatce, bez komórki w pasku w kolejności ręcznej', () => {
    const layout = canvasLayout([card('b', 0, 0), card('z'), card('a', 2, 1), card('y', undefined, undefined, '0005')]);
    expect(layout.placed.map((p) => [p.task.id, p.cell, p.displaced])).toEqual([
      ['a', { col: 2, row: 1 }, false],
      ['b', { col: 0, row: 0 }, false],
    ]);
    expect(layout.tray.map((t) => t.id)).toEqual(['y', 'z']);
    expect([...layout.occupied].sort()).toEqual(['0:0', '2:1']);
  });
  it('kolizja dwóch osób: komórka dla mniejszego id, druga karta obok (deterministycznie)', () => {
    const a = canvasLayout([card('k2', 0, 0), card('k1', 0, 0)]);
    const b = canvasLayout([card('k1', 0, 0), card('k2', 0, 0)]);
    expect(a.placed).toEqual(b.placed);
    expect(a.placed.find((p) => p.task.id === 'k1')).toMatchObject({ cell: { col: 0, row: 0 }, displaced: false });
    expect(a.placed.find((p) => p.task.id === 'k2')).toMatchObject({ cell: { col: 0, row: -1 }, displaced: true });
  });
  it('karta przesunięta przez kolizję nie zajmuje cudzej zapisanej komórki', () => {
    // k3 ma swoją komórkę (0, -1) — k2 (kolizja w 0,0) musi pójść gdzie indziej.
    const layout = canvasLayout([card('k1', 0, 0), card('k2', 0, 0), card('k3', 0, -1)]);
    const cells = layout.placed.map((p) => cellKey(p.cell));
    expect(new Set(cells).size).toBe(3);
    expect(layout.placed.find((p) => p.task.id === 'k3')!.cell).toEqual({ col: 0, row: -1 });
  });
});

describe('canvasMoveOps', () => {
  it('jedna karta na wolną komórkę', () => {
    const layout = canvasLayout([card('a', 0, 0), card('b', 1, 0)]);
    const move = canvasMoveOps(layout, [{ id: 'a', cell: { col: 0, row: 0 }, saved: { col: 0, row: 0 } }], { col: 0, row: 2 });
    expect(move.ops).toEqual([{ table: 'tasks', id: 'a', patch: { canvas_pos: { col: 0, row: 2 } } }]);
    expect(move.undo).toEqual([{ table: 'tasks', id: 'a', patch: { canvas_pos: { col: 0, row: 0 } } }]);
  });
  it('na zajętą komórkę — najbliższa wolna (nigdy na inną kartę)', () => {
    const layout = canvasLayout([card('a', 0, 0), card('b', 3, 0)]);
    const move = canvasMoveOps(layout, [{ id: 'a', cell: { col: 0, row: 0 }, saved: { col: 0, row: 0 } }], { col: 3, row: 0 });
    expect(move.delta).toEqual({ col: 3, row: -1 });
    expect(move.ops[0]!.patch).toEqual({ canvas_pos: { col: 3, row: -1 } });
  });
  it('karta może wrócić na własne miejsce bloku (przesunięcie o jedną komórkę w bok)', () => {
    const layout = canvasLayout([card('a', 0, 0), card('b', 1, 0)]);
    const move = canvasMoveOps(
      layout,
      [
        { id: 'a', cell: { col: 0, row: 0 }, saved: { col: 0, row: 0 } },
        { id: 'b', cell: { col: 1, row: 0 }, saved: { col: 1, row: 0 } },
      ],
      { col: 1, row: 0 },
    );
    expect(move.delta).toEqual({ col: 1, row: 0 });
    expect(move.ops.map((o) => o.patch.canvas_pos)).toEqual([
      { col: 1, row: 0 },
      { col: 2, row: 0 },
    ]);
  });
  it('blok omija zajęte komórki w całości', () => {
    const layout = canvasLayout([card('a', 0, 0), card('b', 1, 0), card('x', 4, 0)]);
    const move = canvasMoveOps(
      layout,
      [
        { id: 'a', cell: { col: 0, row: 0 }, saved: { col: 0, row: 0 } },
        { id: 'b', cell: { col: 1, row: 0 }, saved: { col: 1, row: 0 } },
      ],
      { col: 3, row: 0 },
    );
    const cells = move.ops.map((o) => cellKey(o.patch.canvas_pos as { col: number; row: number }));
    expect(cells).not.toContain('4:0');
    expect(move.delta).toEqual({ col: 3, row: -1 });
  });
  it('karta przesunięta przez kolizję zapisuje komórkę nawet bez ruchu', () => {
    const layout = canvasLayout([card('k1', 0, 0), card('k2', 0, 0)]);
    const k2 = layout.placed.find((p) => p.task.id === 'k2')!;
    const move = canvasMoveOps(layout, [{ id: 'k2', cell: k2.cell, saved: k2.task.canvasPos }], { col: 0, row: 0 });
    expect(move.ops).toEqual([{ table: 'tasks', id: 'k2', patch: { canvas_pos: { col: 0, row: -1 } } }]);
  });
  it('bez ruchu — bez operacji', () => {
    const layout = canvasLayout([card('a', 0, 0)]);
    expect(canvasMoveOps(layout, [{ id: 'a', cell: { col: 0, row: 0 }, saved: { col: 0, row: 0 } }], { col: 0, row: 0 }).ops).toEqual([]);
  });
});

describe('pasek „Do ułożenia”', () => {
  it('położenie karty z paska i powrót do paska', () => {
    const layout = canvasLayout([card('a', 0, 0), card('n')]);
    const place = canvasPlaceOps(layout, 'n', { col: 0, row: 0 });
    expect(place.cell).toEqual({ col: 0, row: -1 });
    expect(place.undo).toEqual([{ table: 'tasks', id: 'n', patch: { canvas_pos: null } }]);
    expect(canvasUnplaceOps([{ id: 'a', saved: { col: 0, row: 0 } }, { id: 'n', saved: null }])).toEqual({
      ops: [{ table: 'tasks', id: 'a', patch: { canvas_pos: null } }],
      undo: [{ table: 'tasks', id: 'a', patch: { canvas_pos: { col: 0, row: 0 } } }],
    });
  });
  it('„Ułóż wszystkie” — wierszami pod kartami, z pominięciem zajętych komórek', () => {
    const layout = canvasLayout([card('a', 2, 0), card('b', 3, 1), card('t1', undefined, undefined, '1'), card('t2', undefined, undefined, '2'), card('t3', undefined, undefined, '3')]);
    const { ops, undo } = canvasArrangeOps(layout, 2);
    expect(ops.map((o) => [o.id, o.patch.canvas_pos])).toEqual([
      ['t1', { col: 2, row: 2 }],
      ['t2', { col: 3, row: 2 }],
      ['t3', { col: 2, row: 3 }],
    ]);
    expect(undo.every((o) => o.patch.canvas_pos === null)).toBe(true);
  });
  it('„Ułóż wszystkie” na pustej tablicy — od (0, 0)', () => {
    const { ops } = canvasArrangeOps(canvasLayout([card('t1')]));
    expect(ops[0]!.patch.canvas_pos).toEqual({ col: 0, row: 0 });
  });
});

describe('grupy', () => {
  const groups = [{ id: G1, name: 'Pomysły', color: null, col: 0, row: 0, w: 2, h: 1 }];

  it('odczyt z JSON-a; uszkodzone → []', () => {
    expect(canvasGroupsOf(JSON.stringify(groups))).toEqual(groups);
    expect(canvasGroupsOf('nie json')).toEqual([]);
    expect(canvasGroupsOf([{ id: 'x' }])).toEqual([]);
    expect(canvasGroupsOf(null)).toEqual([]);
  });
  it('przynależność = komórka w prostokącie', () => {
    expect(cellInGroup({ col: 1, row: 0 }, groups[0]!)).toBe(true);
    expect(cellInGroup({ col: 2, row: 0 }, groups[0]!)).toBe(false);
  });
  it('dodanie, zmiana, usunięcie z „Cofnij”', () => {
    const add = addCanvasGroupOps('L', groups, { col: 5, row: 5, w: 0, h: 2 }, { name: '  Ryzyka  ', newId: () => G2 });
    expect(add.ops[0]!.patch.canvas_groups).toEqual([...groups, { id: G2, name: 'Ryzyka', color: null, col: 5, row: 5, w: 1, h: 2 }]);
    expect(add.undo[0]!.patch.canvas_groups).toEqual(groups);
    const renamed = updateCanvasGroupOps('L', groups, G1, { name: 'Nowe', color: '#16A34A', w: 3 });
    expect(renamed.ops[0]!.patch.canvas_groups).toEqual([{ ...groups[0], name: 'Nowe', color: '#16A34A', w: 3 }]);
    expect(removeCanvasGroupOps('L', groups, G1).ops[0]!.patch.canvas_groups).toBeNull();
    expect(updateCanvasGroupOps('L', groups, 'brak', { name: 'x' }).ops).toEqual([]);
  });
  it('przesunięcie grupy przenosi jej karty; ramka o przesunięcie kart', () => {
    const layout = canvasLayout([card('a', 0, 0), card('b', 1, 0), card('c', 5, 0), card('x', 1, 3)]);
    const move = moveCanvasGroupOps('L', groups, G1, layout, { col: 0, row: 3 });
    // (1, 3) zajęte przez „x” spoza grupy — blok idzie obok.
    const cards = move.ops.filter((o) => o.table === 'tasks');
    expect(cards.map((o) => o.id).sort()).toEqual(['a', 'b']);
    expect(cards.map((o) => cellKey(o.patch.canvas_pos as { col: number; row: number }))).not.toContain('1:3');
    const frame = move.ops.find((o) => o.table === 'lists')!.patch.canvas_groups as { col: number; row: number }[];
    expect(frame[0]).toMatchObject({ col: move.delta.col, row: move.delta.row });
    expect(move.undo.find((o) => o.table === 'lists')!.patch.canvas_groups).toEqual(groups);
  });
});

describe('wygląd', () => {
  it('kolor = pierwszy kolorowy tag w kolejności zadania', () => {
    const tags = new Map([
      ['t1', { id: 't1', color: null }],
      ['t2', { id: 't2', color: '#DC2626' }],
      ['t3', { id: 't3', color: '#16A34A' }],
    ]);
    expect(canvasColorTag({ tagIds: ['t1', 't3', 't2'] }, tags)?.id).toBe('t3');
    expect(canvasColorTag({ tagIds: ['t1'] }, tags)).toBeNull();
    expect(canvasColorTag({ tagIds: [] }, tags)).toBeNull();
  });
  it('granice komórek', () => {
    expect(canvasBounds([])).toBeNull();
    expect(canvasBounds([{ col: -1, row: 2 }, { col: 3, row: 0 }])).toEqual({ col: -1, row: 0, w: 5, h: 3 });
  });
});

describe('fitTitle', () => {
  // Szerokość: 0,5 · rozmiar na znak (czcionka o stałej szerokości).
  const measure = (text: string, size: number) => text.length * size * 0.5;
  const box = { width: 100, height: 60 };

  it('krótki tytuł — największa czcionka w jednej linii', () => {
    expect(fitTitle('Kot', measure, box)).toEqual({ size: 22, lines: ['Kot'], clipped: false });
  });
  it('dłuższy — mniejsza czcionka i zawijanie po słowach', () => {
    const fit = fitTitle('Przygotować plan warsztatów zespołu', measure, box);
    expect(fit.clipped).toBe(false);
    expect(fit.size).toBeLessThan(22);
    expect(fit.lines.join(' ')).toBe('Przygotować plan warsztatów zespołu');
    for (const line of fit.lines) expect(measure(line, fit.size)).toBeLessThanOrEqual(box.width);
    expect(fit.lines.length * fit.size * 1.2).toBeLessThanOrEqual(box.height);
  });
  it('rozmiar rośnie, gdy tytuł się skraca (ten sam kształt karty)', () => {
    const long = fitTitle('Zebrać pomysły na nową stronę główną serwisu', measure, box).size;
    const short = fitTitle('Pomysły', measure, box).size;
    expect(short).toBeGreaterThan(long);
  });
  it('za długi nawet przy najmniejszej — ucięty „…” w granicach pola', () => {
    const fit = fitTitle('słowo '.repeat(80), measure, box);
    expect(fit).toMatchObject({ size: 11, clipped: true });
    expect(fit.lines.length).toBeLessThanOrEqual(Math.floor(60 / (11 * 1.2)));
    expect(fit.lines.at(-1)!.endsWith('…')).toBe(true);
    for (const line of fit.lines) expect(measure(line, 11)).toBeLessThanOrEqual(box.width);
  });
  it('jedno bardzo długie słowo — ucięte', () => {
    const fit = fitTitle('A'.repeat(200), measure, box);
    expect(fit.clipped).toBe(true);
    expect(measure(fit.lines[0]!, 11)).toBeLessThanOrEqual(box.width);
  });
});

describe('zadania i karteczki', () => {
  it('canvasPosOf: tekst JSON, obiekt, uszkodzone', () => {
    expect(canvasPosOf('{"col":2,"row":-1}')).toEqual({ col: 2, row: -1 });
    expect(canvasPosOf({ col: 0, row: 0 })).toEqual({ col: 0, row: 0 });
    expect(canvasPosOf(null)).toBeNull();
    expect(canvasPosOf('{"col":1.5,"row":0}')).toBeNull();
    expect(canvasPosOf('zly')).toBeNull();
  });
  it('przeniesienie na inną listę zdejmuje karteczkę z tablicy', () => {
    const ops = moveTaskOps([{ id: 'a', parentId: null, listId: 'L1' }], 'a', 'L2');
    expect(ops[0]!.patch).toEqual({ list_id: 'L2', canvas_pos: null });
  });
  it('kolejność tagów zadania: klucze dla wszystkich w nowej kolejności', () => {
    const ops = reorderTaskTagOps('T', ['x', 'y', 'z'], 2, 0);
    expect(ops).toEqual([
      { table: 'task_tags', id: taskTagId('T', 'z'), patch: { task_id: 'T', tag_id: 'z', sort_key: '0010' } },
      { table: 'task_tags', id: taskTagId('T', 'x'), patch: { task_id: 'T', tag_id: 'x', sort_key: '0020' } },
      { table: 'task_tags', id: taskTagId('T', 'y'), patch: { task_id: 'T', tag_id: 'y', sort_key: '0030' } },
    ]);
    expect(reorderTaskTagOps('T', ['x'], 0, 0)).toEqual([]);
  });
});

describe('zoomCanvasViewport', () => {
  const view = { zoom: 1, x: 100, y: 50 };
  it('punkt pod kursorem stoi w miejscu', () => {
    const next = zoomCanvasViewport(view, 2, { x: 300, y: 250 });
    expect(next.zoom).toBe(2);
    // Punkt tablicy (200, 200) był pod (300, 250) i nadal jest.
    expect({ x: next.x + 200 * next.zoom, y: next.y + 200 * next.zoom }).toEqual({ x: 300, y: 250 });
  });
  it('szczypanie: powiększenie i przesunięcie razem ze środkiem palców', () => {
    const next = zoomCanvasViewport(view, 1.5, { x: 300, y: 250 }, { x: 340, y: 230 });
    expect({ x: next.x + 200 * next.zoom, y: next.y + 200 * next.zoom }).toEqual({ x: 340, y: 230 });
  });
  it('granice powiększenia', () => {
    expect(zoomCanvasViewport(view, 100, { x: 0, y: 0 }).zoom).toBe(2);
    expect(zoomCanvasViewport(view, 0.001, { x: 0, y: 0 }).zoom).toBe(0.25);
  });
});
