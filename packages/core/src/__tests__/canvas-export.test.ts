import { describe, expect, it } from 'vitest';
import { CANVAS_CARD, CANVAS_DEFAULT_COLOR, CANVAS_STEP, canvasArrows, canvasLayout, fitTitle } from '../canvas.ts';
import {
  CANVAS_EXPORT_THEMES,
  CANVAS_PDF,
  CANVAS_TITLE_BOX,
  canvasExportScene,
  canvasPdfPages,
  canvasRasterScale,
  mixHex,
  splitAxis,
  type CanvasDrawOp,
  type CanvasExportInput,
  type CanvasExportTask,
  type CanvasMeasure,
} from '../canvas-export.ts';
import { pdfPageSize } from '../pdf.ts';
import type { CanvasGroup } from '../schemas/model.ts';
import type { Priority, TaskStatus } from '../schemas/primitives.ts';

/** Sztuczna czcionka: szerokość proporcjonalna do liczby znaków. */
const measure: CanvasMeasure = (text, size) => text.length * size * 0.55;
const G = '00000000-0000-4000-8000-0000000000a1';

const task = (id: string, col: number | null, row = 0, extra: Partial<CanvasExportTask> = {}): CanvasExportTask => ({
  id,
  title: `Karta ${id}`,
  priority: 4 as Priority,
  status: 'todo' as TaskStatus,
  tagIds: [],
  parentId: null,
  canvasPos: col === null ? null : { col, row },
  sortKey: id,
  ...extra,
});

const tags = new Map([
  ['t-red', { id: 't-red', name: 'pilne', color: '#ef4444', sortKey: 'b' }],
  ['t-blue', { id: 't-blue', name: 'pomysł', color: '#3b82f6', sortKey: 'a' }],
  ['t-none', { id: 't-none', name: 'szary', color: null, sortKey: 'c' }],
]);

function input(tasks: CanvasExportTask[], extra: Partial<CanvasExportInput> = {}): CanvasExportInput {
  const layout = canvasLayout(tasks);
  return { listName: 'Burza mózgów', today: '2026-11-23', placed: layout.placed, trayCount: layout.tray.length, groups: [], tags, ...extra };
}

const texts = (ops: CanvasDrawOp[]) => ops.flatMap((o) => (o.kind === 'text' ? [o] : []));
const polygons = (ops: CanvasDrawOp[]) => ops.flatMap((o) => (o.kind === 'polygon' ? [o] : []));

describe('mixHex', () => {
  it('liczy jak color-mix w srgb', () => {
    expect(mixHex('#ff0000', '#ffffff', 0.38)).toBe('#ff9e9e');
    expect(mixHex('#000', '#fff', 0.5)).toBe('#808080');
    expect(mixHex('#3b82f6', '#18181b', 1)).toBe('#3b82f6');
    expect(mixHex('zły', '#ffffff', 0)).toBe('#ffffff');
  });
});

describe('canvasExportScene', () => {
  it('strzałki: pod kartami, styl wg rodzaju, naruszenie na czerwono, tylko z obu końcami w pliku; legenda rodzajów', () => {
    const tasks = [task('a', 0, 0), task('b', 1, 0, { derivedFrom: ['a'] } as Partial<CanvasExportTask>), task('c', 0, 1, { parentId: 'a' }), task('d', null)];
    const deps = [
      { id: 'd1', predecessorId: 'a', successorId: 'b', lagDays: 0 },
      { id: 'd2', predecessorId: 'c', successorId: 'b', lagDays: 0 },
      { id: 'd3', predecessorId: 'a', successorId: 'd', lagDays: 0 },
    ];
    const all = tasks.map((t) => ({ ...t, derivedFrom: (t as { derivedFrom?: string[] }).derivedFrom ?? null }));
    const { arrows } = canvasArrows(new Set(['a', 'b', 'c']), all, deps, new Set(['d2']));
    const scene = canvasExportScene(input(tasks, { arrows }), { measure });
    const lines = scene.ops.flatMap((o, i) => (o.kind === 'line' ? [{ o, i }] : []));
    const firstCard = scene.ops.findIndex((o) => o.kind === 'polygon' && o.shadow === 'card');
    // „blokuje” a → b: ciągła 2 px + pełny grot; c → b naruszona — kolor `danger`.
    // (Próbka „blokuje” w legendzie leży za kartami — liczą się tylko linie przed pierwszą kartą.)
    const solid = lines.filter(({ o, i }) => i < firstCard && o.lineWidth === 2 && !o.dash && o.points.length === 2);
    expect(solid.map(({ o }) => o.stroke).sort()).toEqual([CANVAS_EXPORT_THEMES.light.danger, CANVAS_EXPORT_THEMES.light.muted].sort());
    // „wynika z” — przerywana, rodzic → podzadanie — kropkowana z kropką.
    expect(lines.some(({ o, i }) => i < firstCard && o.dash?.join() === '6,4')).toBe(true);
    expect(lines.some(({ o, i }) => i < firstCard && o.dash?.join() === '2,4')).toBe(true);
    expect(scene.ops.some((o, i) => i < firstCard && o.kind === 'circle' && o.r === 3)).toBe(true);
    // Legenda: trzy rodzaje strzałek.
    expect(texts(scene.ops).map((t) => t.text)).toEqual(expect.arrayContaining(['blokuje', 'wynika z', 'podzadanie']));
    // Zaznaczenie tylko „a” i „c”: zostaje linia rodzic → podzadanie, strzałek do „b” nie ma.
    const part = canvasExportScene(input(tasks, { arrows }), { measure, selection: new Set(['a', 'c']) });
    const partCard = part.ops.findIndex((o) => o.kind === 'polygon' && o.shadow === 'card');
    expect(part.ops.some((o, i) => i < partCard && o.kind === 'line' && o.lineWidth === 2 && !o.dash)).toBe(false);
    expect(texts(part.ops).map((t) => t.text)).not.toContain('blokuje');
    expect(texts(part.ops).map((t) => t.text)).toContain('podzadanie');
  });

  it('karty w komórkach względem lewego górnego rogu tablicy, kolor z pierwszego kolorowego tagu', () => {
    const tasks = [task('a', 0, 0, { tagIds: ['t-none', 't-red', 't-blue'] }), task('b', 2, 1), task('c', null)];
    const scene = canvasExportScene(input(tasks), { measure });
    expect(scene.cards).toBe(2);
    const faces = polygons(scene.ops).filter((p) => p.shadow === 'card');
    expect(faces).toHaveLength(2);
    const [a, b] = faces.map((f) => f.points[0]!);
    expect(b![0] - a![0]).toBe(2 * CANVAS_STEP.x);
    expect(b![1] - a![1]).toBe(CANVAS_STEP.y);
    expect(faces[0]!.fill).toBe(mixHex('#ef4444', '#ffffff', 0.38));
    expect(faces[1]!.fill).toBe(mixHex(CANVAS_DEFAULT_COLOR, '#ffffff', 0.38));
    // Szerokość: 3 kolumny kart (2 kroki + karta) + marginesy, minimum 480 px.
    expect(scene.width).toBe(Math.max(480, 2 * CANVAS_STEP.x + CANVAS_CARD.width + 64));
    expect(scene.background).toBe('#ffffff');
  });

  it('nagłówek z nazwą listy, datą, liczbą kart i pominiętym paskiem „Do ułożenia”', () => {
    const scene = canvasExportScene(input([task('a', 0), task('b', 1), task('c', null)]), { measure });
    const t = texts(scene.ops).map((o) => o.text);
    expect(t[0]).toBe('Burza mózgów');
    expect(t[1]).toBe('Karteczki · 23 listopada 2026 · 2 karteczki · 1 w „Do ułożenia” (pominięte)');
  });

  it('tytuł łamany przez fitTitle jak na ekranie (to samo pole), zamknięte przygaszone i przekreślone', () => {
    const title = 'Przygotować listę pomysłów na nową stronę główną i zebrać opinie klientów';
    const scene = canvasExportScene(input([task('a', 0, 0, { title, status: 'done' })]), { measure });
    const fit = fitTitle(title, (t, size) => measure(t, size, 500), CANVAS_TITLE_BOX);
    const lines = texts(scene.ops).filter((o) => o.weight === 500 && o.size === fit.size);
    expect(lines.map((l) => l.text)).toEqual(fit.lines);
    expect(lines.every((l) => l.alpha === 0.5)).toBe(true);
    expect(scene.ops.filter((o) => o.kind === 'line' && o.points.length === 2 && o.alpha === 0.5)).toHaveLength(fit.lines.length);
  });

  it('ramka według priorytetu: podwójna, ciągła, przerywana — bez przekątnej przy zagiętym rogu', () => {
    const frames = (priority: Priority) => {
      const scene = canvasExportScene(input([task('a', 0, 0, { priority })]), { measure, legend: false });
      return scene.ops.filter((o): o is Extract<CanvasDrawOp, { kind: 'line' }> => o.kind === 'line' && o.points.length === 5);
    };
    expect(frames(1)).toHaveLength(2);
    expect(frames(1)[0]!.stroke).toBe('#dc2626');
    expect(frames(2)).toHaveLength(1);
    expect(frames(2)[0]!.lineWidth).toBe(3);
    expect(frames(4)[0]!.dash).toEqual([4, 3]);
  });

  it('osoby: odpowiedzialny pełny przy prawej krawędzi, do 3 uczestników w obrysie, potem „+N”; licznik podzadań i rodzic', () => {
    const people = new Map([
      ['a', { assignee: { name: 'Ola Nowak' }, participants: ['Jan Kowal', 'Ewa Lis', 'Piotr Mak', 'Zofia Wrona'].map((name) => ({ name })) }],
    ]);
    const scene = canvasExportScene(
      input([task('a', 0, 0), task('s', 1, 0, { parentId: 'a' })], {
        people,
        subtasks: new Map([['a', { done: 1, total: 3 }]]),
        parentTitles: new Map([['s', 'Karta a']]),
      }),
      { measure },
    );
    const t = texts(scene.ops);
    const badge = (text: string) => t.find((o) => o.text === text && o.size === 10)!;
    expect(badge('ON').color).toBe(CANVAS_EXPORT_THEMES.light.assigneeText);
    expect(['JK', 'EL', 'PM'].map((b) => badge(b).color)).toEqual(Array(3).fill(CANVAS_EXPORT_THEMES.light.participantText));
    expect(t.some((o) => o.text === 'ZW')).toBe(false);
    expect(t.some((o) => o.text === '+1')).toBe(true);
    // Kolejność od lewej: uczestnicy, „+1”, odpowiedzialny.
    expect(badge('JK').x).toBeLessThan(badge('PM').x);
    expect(badge('PM').x).toBeLessThan(t.find((o) => o.text === '+1')!.x);
    expect(t.find((o) => o.text === '+1')!.x).toBeLessThan(badge('ON').x);
    expect(t.some((o) => o.text === '↳ 1/3')).toBe(true);
    expect(t.some((o) => o.text === '↑ Karta a')).toBe(true);
  });

  it('zaznaczenie: tylko zaznaczone karty i grupy, w których leżą; legenda z ich kolorów', () => {
    const groups: CanvasGroup[] = [
      { id: G, name: 'Ryzyka', color: '#10b981', col: 0, row: 0, w: 2, h: 1 },
      { id: '00000000-0000-4000-8000-0000000000a2', name: 'Inne', color: null, col: 5, row: 5, w: 1, h: 1 },
    ];
    const tasks = [task('a', 0, 0, { tagIds: ['t-blue'] }), task('b', 1, 0), task('c', 5, 5, { tagIds: ['t-red'] })];
    const scene = canvasExportScene(input(tasks, { groups }), { measure, selection: new Set(['a', 'b']) });
    expect(scene.cards).toBe(2);
    const t = texts(scene.ops).map((o) => o.text);
    expect(t).toContain('Ryzyka');
    expect(t).not.toContain('Inne');
    expect(t[1]).toContain('2 karteczki (zaznaczenie)');
    expect(t).toContain('@pomysł');
    expect(t).not.toContain('@pilne');
    expect(t).toContain('bez kolorowego tagu');
    // Tablica zaczyna się od ramki grupy (z nagłówkiem nad krawędzią), nie od karty.
    const frame = scene.ops.find((o) => o.kind === 'rect' && o.lineWidth === 2) as Extract<CanvasDrawOp, { kind: 'rect' }>;
    expect(frame.x).toBe(32 + 1);
  });

  it('legenda w kolejności tagów, wyłączana opcją; motyw ciemny', () => {
    const tasks = [task('a', 0, 0, { tagIds: ['t-red'] }), task('b', 1, 0, { tagIds: ['t-blue'] })];
    const scene = canvasExportScene(input(tasks), { measure, theme: 'dark' });
    const legend = texts(scene.ops).filter((o) => o.text.startsWith('@')).map((o) => o.text);
    expect(legend).toEqual(['@pomysł', '@pilne']);
    expect(scene.background).toBe(CANVAS_EXPORT_THEMES.dark.background);
    const without = canvasExportScene(input(tasks), { measure, legend: false });
    expect(texts(without.ops).some((o) => o.text.startsWith('@'))).toBe(false);
    expect(without.height).toBeLessThan(scene.height);
  });

  it('pusta tablica: komunikat zamiast kart', () => {
    const scene = canvasExportScene(input([task('a', null)]), { measure });
    expect(scene.cards).toBe(0);
    expect(texts(scene.ops).some((o) => o.text === 'Brak karteczek na tablicy.')).toBe(true);
  });

  it('linie siatki leżą w połowie odstępu między kartami', () => {
    const scene = canvasExportScene(input([task('a', -1, -1), task('b', 3, 2)]), { measure });
    const face = polygons(scene.ops).find((p) => p.shadow === 'card')!;
    const [x, y] = face.points[0]!;
    const mod = (v: number, n: number) => ((v % n) + n) % n;
    expect(mod(x - scene.grid.x, CANVAS_STEP.x)).toBe(CANVAS_CARD.gap / 2);
    expect(mod(y - scene.grid.y, CANVAS_STEP.y)).toBe(CANVAS_CARD.gap / 2);
  });
});

describe('canvasRasterScale', () => {
  it('2× dla zwykłej tablicy, mniej przy dużej (bok i pole płótna)', () => {
    expect(canvasRasterScale(2000, 1000)).toBe(2);
    expect(canvasRasterScale(12_000, 500)).toBeCloseTo(16_384 / 12_000);
    const s = canvasRasterScale(8000, 6000);
    expect(8000 * s * 6000 * s).toBeLessThanOrEqual(36_000_001);
  });
});

describe('splitAxis / canvasPdfPages', () => {
  it('cięcie po liniach siatki, gdy się da', () => {
    expect(splitAxis(1000, 400, 10, 100)).toEqual([[0, 310], [310, 710], [710, 1000]]);
    // Krok większy niż strona — cięcie twarde.
    expect(splitAxis(500, 200, 0, 300)).toEqual([[0, 200], [200, 300], [300, 500]]);
    expect(splitAxis(100, 400, 0, 50)).toEqual([[0, 100]]);
  });

  it('dopasowanie: jedna strona A4 poziomo, obraz w marginesach, bez powiększania ponad miarę', () => {
    const page = pdfPageSize('a4', 'landscape');
    const big = canvasPdfPages({ width: 4000, height: 1500, grid: { x: 0, y: 0, stepX: 204, stepY: 144 } }, { paper: 'a4', orientation: 'landscape', mode: 'fit' });
    expect(big).toHaveLength(1);
    expect(big[0]!.width).toBe(page.width);
    expect(big[0]!.place.w).toBeCloseTo(page.width - 2 * CANVAS_PDF.margin);
    expect(big[0]!.place.h).toBeLessThan(page.height - 2 * CANVAS_PDF.margin);
    const small = canvasPdfPages({ width: 500, height: 300, grid: { x: 0, y: 0, stepX: 204, stepY: 144 } }, { paper: 'a3', orientation: 'portrait', mode: 'fit' });
    expect(small[0]!.place.w).toBe(500 * CANVAS_PDF.fitMaxScale);
    expect(small[0]!.rasterScale).toBe(2);
  });

  it('kilka stron: stała skala, wiersze × kolumny ze stopką, karty nieprzecięte', () => {
    const grid = { x: 20, y: 92, stepX: CANVAS_STEP.x, stepY: CANVAS_STEP.y };
    const pages = canvasPdfPages({ width: 4000, height: 1500, grid }, { paper: 'a4', orientation: 'landscape', mode: 'pages' });
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.every((p) => p.place.w === p.crop.w * CANVAS_PDF.pagesScale)).toBe(true);
    expect(pages[0]!.label?.text).toBe(`Strona 1 z ${pages.length} (wiersz 1, kolumna 1)`);
    // Wewnętrzne krawędzie stron na liniach siatki.
    const inner = pages.filter((p) => p.crop.x + p.crop.w < 4000).map((p) => p.crop.x + p.crop.w);
    expect(inner.every((x) => (x - grid.x) % grid.stepX === 0)).toBe(true);
    // Pokrycie bez dziur.
    const area = pages.reduce((sum, p) => sum + p.crop.w * p.crop.h, 0);
    expect(area).toBeCloseTo(4000 * 1500);
    const one = canvasPdfPages({ width: 600, height: 400, grid }, { paper: 'a3', orientation: 'landscape', mode: 'pages' });
    expect(one).toHaveLength(1);
    expect(one[0]!.label).toBeUndefined();
  });
});
