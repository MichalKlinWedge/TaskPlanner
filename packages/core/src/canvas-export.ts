/**
 * Eksport tablicy „Karteczki” do PNG i PDF (v1.x, tylko web): plan rysowania z modelu zamiast zrzutu
 * DOM. `canvasExportScene` zamienia ułożenie (`canvasLayout`), grupy, tagi, osoby i podzadania na
 * listę prostych operacji (`rect` / `polygon` / `line` / `circle` / `text`) we współrzędnych pliku
 * przy 100 % — web tylko je wykonuje na `<canvas>` 2D. Kolory liczone jak `color-mix(in srgb, …)`
 * w CSS widoku (`mixHex`), tytuł dopasowany tą samą funkcją `fitTitle` i tym samym polem co na
 * ekranie. Strzałki między kartami (`canvasArrows`) — te same odcinki (`canvasArrowSegment`) i style
 * co w widoku: `line` / `polygon` / `circle` pod kartami.
 *
 * `canvasRasterScale` dobiera skalę obrazu w limicie płótna przeglądarki, `canvasPdfPages` dzieli
 * plan na strony PDF (jedna strona dopasowana albo kilka stron w stałej skali, cięcie po siatce).
 */
import {
  CANVAS_CARD,
  CANVAS_DEFAULT_COLOR,
  CANVAS_FRAME,
  CANVAS_STEP,
  canvasArrowHead,
  canvasArrowSegment,
  canvasCardRect,
  canvasColorTag,
  cellInGroup,
  fitTitle,
  type CanvasArrow,
  type CanvasArrowKind,
  type PlacedCard,
} from './canvas.ts';
import { collaboratorBadge } from './collaborators.ts';
import { dayMonth, plural } from './format.ts';
import { PRIORITY } from './labels.ts';
import { pdfPageSize, type PdfOrientation, type PdfPaper } from './pdf.ts';
import type { CanvasGroup } from './schemas/model.ts';
import type { LocalDate } from './schemas/primitives.ts';
import type { ViewTask } from './views.ts';

// ── Operacje rysowania ──────────────────────────────────────────────────────────────────────────

export type CanvasPoint = readonly [number, number];

interface Paint {
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  /** Wzór kreski (px), np. `[4, 3]`. */
  dash?: readonly number[];
  /** Krycie 0–1 (karty ukończone / anulowane). */
  alpha?: number;
  /** Miękki cień pod kształtem (karta, zagięty róg). */
  shadow?: 'card' | 'fold';
}

export type CanvasDrawOp =
  | ({ kind: 'rect'; x: number; y: number; w: number; h: number; radius?: number } & Paint)
  | ({ kind: 'polygon'; points: readonly CanvasPoint[] } & Paint)
  /** Łamana otwarta (ramka bez przekątnej przy zagiętym rogu, przekreślenie, później strzałki). */
  | ({ kind: 'line'; points: readonly CanvasPoint[]; stroke: string; lineWidth: number } & Omit<Paint, 'fill' | 'stroke' | 'lineWidth'>)
  | ({ kind: 'circle'; x: number; y: number; r: number } & Paint)
  /** Tekst: `y` = środek linii (`textBaseline = 'middle'`). */
  | { kind: 'text'; x: number; y: number; text: string; size: number; weight: CanvasFontWeight; color: string; align?: 'left' | 'center' | 'right'; alpha?: number };

export type CanvasFontWeight = 400 | 500 | 600 | 700;
/** Szerokość tekstu w px (ta sama czcionka co w widoku). */
export type CanvasMeasure = (text: string, size: number, weight: CanvasFontWeight) => number;

// ── Motyw i kolory ──────────────────────────────────────────────────────────────────────────────

export type CanvasExportThemeName = 'light' | 'dark';

export interface CanvasExportTheme {
  background: string;
  surface: string;
  text: string;
  muted: string;
  line: string;
  /** Naruszona kolejność („blokuje” na czerwono, `--danger`). */
  danger: string;
  /** Znaczek odpowiedzialnego (pełny) i uczestnika (obrys). */
  assignee: string;
  assigneeText: string;
  participant: string;
  participantText: string;
}

/** Palety eksportu = wartości `--background` / `--surface` / … z `globals.css` (jasny: białe tło do druku). */
export const CANVAS_EXPORT_THEMES: Record<CanvasExportThemeName, CanvasExportTheme> = {
  light: {
    background: '#ffffff',
    surface: '#ffffff',
    text: '#18181b',
    muted: '#71717a',
    line: '#e4e4e7',
    danger: '#dc2626',
    assignee: '#0284c7',
    assigneeText: '#ffffff',
    participant: '#0284c7',
    participantText: '#0369a1',
  },
  dark: {
    background: '#09090b',
    surface: '#18181b',
    text: '#f4f4f5',
    muted: '#a1a1aa',
    line: '#27272a',
    danger: '#f87171',
    assignee: '#0ea5e9',
    assigneeText: '#ffffff',
    participant: '#38bdf8',
    participantText: '#7dd3fc',
  },
};

function rgbOf(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, '');
  const full = /^[0-9a-f]{3}$/i.test(hex) ? [...hex].map((c) => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/** `color-mix(in srgb, a share, b)` → `#rrggbb` (`share` 0–1 = udział `a`); zły kolor = szary. */
export function mixHex(a: string, b: string, share: number): string {
  const ca = rgbOf(a) ?? [161, 161, 170];
  const cb = rgbOf(b) ?? [161, 161, 170];
  const t = Math.min(1, Math.max(0, share));
  return `#${ca.map((v, i) => Math.round(v * t + cb[i]! * (1 - t)).toString(16).padStart(2, '0')).join('')}`;
}

// ── Wymiary ─────────────────────────────────────────────────────────────────────────────────────

/** Części karty i ramki grupy przy 100 % (te same wartości co w `canvas.tsx`). */
export const CANVAS_CARD_PARTS = { pad: 10, foot: 28, fold: 18, groupPad: 10, groupTab: 18 } as const;
/** Pole tytułu karty (`fitTitle`) — jak na ekranie. */
export const CANVAS_TITLE_BOX = {
  width: CANVAS_CARD.width - 2 * CANVAS_CARD_PARTS.pad,
  height: CANVAS_CARD.height - CANVAS_CARD_PARTS.pad - CANVAS_CARD_PARTS.foot,
} as const;
/** Ilu uczestników rysować na karcie (dalej „+N”). */
export const CANVAS_MAX_PARTICIPANTS = 3;

const MARGIN = 32;
const HEADER = 56;
const HEADER_GAP = 16;
const LEGEND_GAP = 24;
const LEGEND_ROW = 20;
const MIN_WIDTH = 480;
const MAX_TITLE_WIDTH = 1600;
const EMPTY = { w: 400, h: 80 };

// ── Plan rysowania ──────────────────────────────────────────────────────────────────────────────

export type CanvasExportTask = Pick<ViewTask, 'id' | 'title' | 'priority' | 'status' | 'tagIds' | 'parentId' | 'canvasPos' | 'sortKey'>;
export interface CanvasExportTag {
  id: string;
  name: string;
  color: string | null;
  sortKey: string;
}
export interface CanvasExportPerson {
  name: string;
  acronym?: string | null;
}

export interface CanvasExportInput {
  listName: string;
  today: LocalDate;
  /** Karty na tablicy (`canvasLayout(…).placed`). */
  placed: readonly PlacedCard<CanvasExportTask>[];
  /** Ile kart leży w pasku „Do ułożenia” (nie trafiają do pliku). */
  trayCount?: number;
  groups: readonly CanvasGroup[];
  tags: ReadonlyMap<string, CanvasExportTag>;
  people?: ReadonlyMap<string, { assignee: CanvasExportPerson | null; participants: readonly CanvasExportPerson[] }>;
  /** Postęp podzadań (`canvasSubtaskProgress`). */
  subtasks?: ReadonlyMap<string, { done: number; total: number }>;
  /** Tytuł rodzica karty-podzadania (tryb „Z podzadaniami”). */
  parentTitles?: ReadonlyMap<string, string>;
  /** Strzałki między kartami (`canvasArrows(…).arrows`); rysowane te, których oba końce są w pliku. */
  arrows?: readonly CanvasArrow[];
}

/** Opis strzałek w legendzie. */
const ARROW_LEGEND: Record<CanvasArrowKind, string> = { blocks: 'blokuje', derived: 'wynika z', parent: 'podzadanie' };

export interface CanvasExportOptions {
  measure: CanvasMeasure;
  /** Tylko te karty (i grupy, w których leżą); brak / pusty zbiór = cała tablica. */
  selection?: ReadonlySet<string> | null;
  /** Legenda kolorów tagów pod tablicą (domyślnie tak). */
  legend?: boolean;
  theme?: CanvasExportThemeName;
}

export interface CanvasScene {
  width: number;
  height: number;
  background: string;
  ops: CanvasDrawOp[];
  /** Linie siatki między kartami (`x + k·stepX`, `y + k·stepY`) — tam `canvasPdfPages` tnie strony. */
  grid: { x: number; y: number; stepX: number; stepY: number };
  /** Ile kart na rysunku. */
  cards: number;
}

/** Tekst skrócony „…” do szerokości `width`. */
function truncate(text: string, width: number, measure: (t: string) => number): string {
  if (measure(text) <= width) return text;
  let cut = text;
  while (cut && measure(`${cut}…`) > width) cut = cut.slice(0, -1);
  return cut ? `${cut.trimEnd()}…` : '';
}

/** Plan rysowania tablicy (nagłówek, grupy, karty, legenda) we współrzędnych pliku przy 100 %. */
export function canvasExportScene(input: CanvasExportInput, options: CanvasExportOptions): CanvasScene {
  const theme = CANVAS_EXPORT_THEMES[options.theme ?? 'light'];
  const { measure } = options;
  const selection = options.selection?.size ? options.selection : null;
  const placed = selection ? input.placed.filter((p) => selection.has(p.task.id)) : [...input.placed];
  const groups = selection ? input.groups.filter((g) => placed.some((p) => cellInGroup(p.cell, g))) : [...input.groups];
  const { groupPad, groupTab } = CANVAS_CARD_PARTS;

  // Prostokąt tablicy w świecie (px przy 100 %): karty i ramki grup z nagłówkiem nad krawędzią.
  const groupBox = (g: CanvasGroup) => {
    const x = g.col * CANVAS_STEP.x - groupPad;
    const y = g.row * CANVAS_STEP.y - groupPad;
    return { x, y, w: g.w * CANVAS_STEP.x - CANVAS_CARD.gap + 2 * groupPad, h: g.h * CANVAS_STEP.y - CANVAS_CARD.gap + 2 * groupPad };
  };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const p of placed) extend(p.cell.col * CANVAS_STEP.x, p.cell.row * CANVAS_STEP.y, CANVAS_CARD.width, CANVAS_CARD.height);
  for (const g of groups) {
    const b = groupBox(g);
    extend(b.x, b.y - groupTab / 2, b.w, b.h + groupTab / 2);
  }
  const empty = minX === Infinity;
  if (empty) extend(0, 0, EMPTY.w, EMPTY.h);
  const boardW = maxX - minX;
  const boardH = maxY - minY;

  // Nagłówek.
  const cardsText = plural(placed.length, ['karteczka', 'karteczki', 'karteczek']);
  const subtitle = [
    'Karteczki',
    `${dayMonth(input.today)} ${input.today.slice(0, 4)}`,
    selection ? `${cardsText} (zaznaczenie)` : cardsText,
    ...(!selection && input.trayCount ? [`${input.trayCount} w „Do ułożenia” (pominięte)`] : []),
  ].join(' · ');
  const titleWidth = Math.min(MAX_TITLE_WIDTH, measure(input.listName, 22, 700));
  const contentW = Math.ceil(Math.max(boardW, titleWidth, measure(subtitle, 13, 400), MIN_WIDTH - 2 * MARGIN));

  // Legenda: kolorowe tagi kart w kolejności tagów + „bez kolorowego tagu”.
  const placedIds = new Map(placed.map((p) => [p.task.id, p]));
  const arrows = (input.arrows ?? []).filter((a) => placedIds.has(a.fromId) && placedIds.has(a.toId));
  type LegendItem = { color: string; label: string; arrow?: CanvasArrowKind };
  const legendItems: LegendItem[] = [];
  if (options.legend ?? true) {
    const seen = new Map<string, CanvasExportTag>();
    let plain = 0;
    for (const p of placed) {
      const tag = canvasColorTag(p.task, input.tags);
      if (tag) seen.set(tag.id, tag);
      else plain++;
    }
    for (const tag of [...seen.values()].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))) legendItems.push({ color: tag.color!, label: `@${tag.name}` });
    if (plain && seen.size) legendItems.push({ color: CANVAS_DEFAULT_COLOR, label: 'bez kolorowego tagu' });
    // Rodzaje strzałek obecne w pliku (próbka linii zamiast kwadratu koloru).
    for (const kind of ['blocks', 'derived', 'parent'] as const) {
      if (arrows.some((a) => a.kind === kind)) legendItems.push({ color: theme.muted, label: ARROW_LEGEND[kind], arrow: kind });
    }
  }
  const SAMPLE = 26;
  const legendRows: { x: number; item: LegendItem; width: number }[][] = [];
  for (const item of legendItems) {
    const width = (item.arrow ? SAMPLE + 4 : 14) + measure(item.label, 12, 400);
    const row = legendRows.at(-1);
    const end = row?.length ? row.at(-1)!.x + row.at(-1)!.width + 16 : 0;
    if (row && end + width <= contentW) row.push({ x: end, item, width });
    else legendRows.push([{ x: 0, item, width }]);
  }

  const boardTop = MARGIN + HEADER + HEADER_GAP;
  const legendTop = boardTop + boardH + LEGEND_GAP;
  const width = contentW + 2 * MARGIN;
  const height = Math.ceil((legendRows.length ? legendTop + legendRows.length * LEGEND_ROW : boardTop + boardH) + MARGIN);
  const ox = MARGIN - minX;
  const oy = boardTop - minY;
  const ops: CanvasDrawOp[] = [];

  ops.push({ kind: 'text', x: MARGIN, y: MARGIN + 13, text: truncate(input.listName, contentW, (t) => measure(t, 22, 700)), size: 22, weight: 700, color: theme.text });
  ops.push({ kind: 'text', x: MARGIN, y: MARGIN + 42, text: subtitle, size: 13, weight: 400, color: theme.muted });
  ops.push({ kind: 'line', points: [[MARGIN, MARGIN + HEADER], [MARGIN + contentW, MARGIN + HEADER]], stroke: theme.line, lineWidth: 1 });

  if (empty) ops.push({ kind: 'text', x: MARGIN + contentW / 2, y: boardTop + EMPTY.h / 2, text: 'Brak karteczek na tablicy.', size: 13, weight: 400, color: theme.muted, align: 'center' });

  // Grupy pod kartami.
  for (const g of groups) {
    const b = groupBox(g);
    const color = g.color ?? theme.muted;
    const border = mixHex(color, theme.background, 0.75);
    const x = ox + b.x;
    const y = oy + b.y;
    ops.push({ kind: 'rect', x: x + 1, y: y + 1, w: b.w - 2, h: b.h - 2, radius: 7, fill: mixHex(color, theme.background, 0.12), stroke: border, lineWidth: 2 });
    const name = g.name || 'Grupa';
    const maxTab = b.w - 20;
    const label = truncate(name, maxTab - 14, (t) => measure(t, 11, 500));
    const tabW = Math.min(maxTab, measure(label, 11, 500) + 14);
    const tabX = x + 10;
    const tabY = y - groupTab / 2 + 1;
    ops.push({ kind: 'rect', x: tabX, y: tabY, w: tabW, h: groupTab, radius: 6, fill: mixHex(color, theme.surface, 0.25), stroke: border, lineWidth: 1 });
    ops.push({ kind: 'text', x: tabX + 7, y: tabY + groupTab / 2, text: label, size: 11, weight: 500, color: theme.text });
  }

  // Strzałki między grupami a kartami (jak warstwa SVG w widoku).
  for (const arrow of arrows) {
    const seg = canvasArrowSegment(canvasCardRect(placedIds.get(arrow.fromId)!.cell), canvasCardRect(placedIds.get(arrow.toId)!.cell), arrow.offset);
    if (seg) arrowOps(ops, arrow.kind, arrow.violated ? theme.danger : theme.muted, { x1: seg.x1 + ox, y1: seg.y1 + oy, x2: seg.x2 + ox, y2: seg.y2 + oy });
  }

  for (const p of placed) cardOps(ops, p, ox + p.cell.col * CANVAS_STEP.x, oy + p.cell.row * CANVAS_STEP.y, input, theme, measure);

  legendRows.forEach((row, i) => {
    const cy = legendTop + i * LEGEND_ROW + LEGEND_ROW / 2;
    for (const { x, item } of row) {
      if (item.arrow) arrowOps(ops, item.arrow, item.color, { x1: MARGIN + x, y1: cy, x2: MARGIN + x + SAMPLE, y2: cy });
      else ops.push({ kind: 'rect', x: MARGIN + x, y: cy - 5, w: 10, h: 10, radius: 2, fill: item.color });
      ops.push({ kind: 'text', x: MARGIN + x + (item.arrow ? SAMPLE + 4 : 14), y: cy, text: item.label, size: 12, weight: 400, color: theme.text });
    }
  });

  return {
    width,
    height,
    background: theme.background,
    ops,
    grid: { x: ox - CANVAS_CARD.gap / 2, y: oy - CANVAS_CARD.gap / 2, stepX: CANVAS_STEP.x, stepY: CANVAS_STEP.y },
    cards: placed.length,
  };
}

/**
 * Strzałka jak w widoku: „blokuje” — ciągła 2 px z pełnym grotem (linia kończy się u podstawy grotu),
 * „wynika z” — przerywana 1,5 px z otwartym grotem, rodzic → podzadanie — kropkowana z kropką przy rodzicu.
 */
function arrowOps(ops: CanvasDrawOp[], kind: CanvasArrowKind, color: string, seg: { x1: number; y1: number; x2: number; y2: number }) {
  if (kind === 'parent') {
    ops.push({ kind: 'line', points: [[seg.x1, seg.y1], [seg.x2, seg.y2]], stroke: color, lineWidth: 1.25, dash: [2, 4], alpha: 0.7 });
    ops.push({ kind: 'circle', x: seg.x1, y: seg.y1, r: 3, fill: color, alpha: 0.7 });
    return;
  }
  const head = canvasArrowHead(seg, kind === 'blocks' ? 10 : 9, kind === 'blocks' ? 8 : 9);
  if (kind === 'blocks') {
    const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1) || 1;
    const end: CanvasPoint = [seg.x2 - ((seg.x2 - seg.x1) / len) * 8, seg.y2 - ((seg.y2 - seg.y1) / len) * 8];
    ops.push({ kind: 'line', points: [[seg.x1, seg.y1], end], stroke: color, lineWidth: 2 });
    ops.push({ kind: 'polygon', points: head, fill: color });
  } else {
    ops.push({ kind: 'line', points: [[seg.x1, seg.y1], [seg.x2, seg.y2]], stroke: color, lineWidth: 1.5, dash: [6, 4] });
    ops.push({ kind: 'line', points: head, stroke: color, lineWidth: 1.5 });
  }
}

/** Jedna karta: przód z zagiętym rogiem, ramka priorytetu, tytuł, pasek z podzadaniami i osobami. */
function cardOps(ops: CanvasDrawOp[], p: PlacedCard<CanvasExportTask>, x: number, y: number, input: CanvasExportInput, theme: CanvasExportTheme, measure: CanvasMeasure) {
  const { width: w, height: h } = CANVAS_CARD;
  const { pad, foot, fold: F } = CANVAS_CARD_PARTS;
  const task = p.task;
  const color = canvasColorTag(task, input.tags)?.color ?? CANVAS_DEFAULT_COLOR;
  const closed = task.status === 'done' || task.status === 'cancelled';
  const alpha = closed ? 0.5 : undefined;
  const face = mixHex(color, theme.surface, 0.38);
  const frame = CANVAS_FRAME[task.priority];
  const frameColor = PRIORITY[task.priority].color;

  ops.push({ kind: 'polygon', points: [[x, y], [x + w, y], [x + w, y + h - F], [x + w - F, y + h], [x, y + h]], fill: face, shadow: 'card', alpha });
  // Ramka wewnątrz kształtu, bez przekątnej (jak `border` przyciętego `clip-path` na ekranie).
  const border = (inset: number, lineWidth: number, dash?: readonly number[]) =>
    ops.push({
      kind: 'line',
      points: [[x + w - F, y + h - inset], [x + inset, y + h - inset], [x + inset, y + inset], [x + w - inset, y + inset], [x + w - inset, y + h - F]],
      stroke: frameColor,
      lineWidth,
      dash,
      alpha,
    });
  if (frame.style === 'double') {
    const third = frame.width / 3;
    border(third / 2, third);
    border(frame.width - third / 2, third);
  } else border(frame.width / 2, frame.width, frame.style === 'dashed' ? [4, 3] : undefined);
  ops.push({ kind: 'polygon', points: [[x + w - F, y + h - F], [x + w, y + h - F], [x + w - F, y + h]], fill: mixHex(mixHex(color, theme.surface, 0.3), '#000000', 0.85), shadow: 'fold', alpha });

  // Tytuł: ta sama czcionka i pole co na ekranie.
  const left = x + frame.width + pad;
  const right = x + w - frame.width - pad;
  const fit = fitTitle(task.title || '…', (t, size) => measure(t, size, 500), CANVAS_TITLE_BOX);
  fit.lines.forEach((line, i) => {
    const cy = y + frame.width + pad + (i + 0.5) * fit.size * 1.2;
    ops.push({ kind: 'text', x: left, y: cy, text: line, size: fit.size, weight: 500, color: theme.text, alpha });
    if (closed) ops.push({ kind: 'line', points: [[left, cy + fit.size * 0.05], [left + measure(line, fit.size, 500), cy + fit.size * 0.05]], stroke: theme.text, lineWidth: Math.max(1, fit.size / 14), alpha });
  });

  // Pasek na dole: od prawej odpowiedzialny, „+N”, uczestnicy; od lewej „↑ rodzic” i „↳ d/t”.
  const cy = y + h - frame.width - foot + 10;
  const badgeWidth = (text: string) => Math.max(20, measure(text, 10, 600) + 8);
  let edge = right;
  const people = input.people?.get(task.id);
  const badge = (text: string, filled: boolean) => {
    const bw = badgeWidth(text);
    edge -= bw;
    ops.push({ kind: 'rect', x: edge, y: cy - 10, w: bw, h: 20, radius: 10, fill: filled ? theme.assignee : mixHex(theme.surface, face, 0.7), stroke: filled ? undefined : theme.participant, lineWidth: filled ? undefined : 1, alpha });
    ops.push({ kind: 'text', x: edge + bw / 2, y: cy, text, size: 10, weight: 600, color: filled ? theme.assigneeText : theme.participantText, align: 'center', alpha });
    edge -= 4;
  };
  if (people?.assignee) badge(collaboratorBadge(people.assignee), true);
  const participants = people?.participants ?? [];
  if (participants.length > CANVAS_MAX_PARTICIPANTS) {
    const more = `+${participants.length - CANVAS_MAX_PARTICIPANTS}`;
    edge -= measure(more, 11, 400);
    ops.push({ kind: 'text', x: edge, y: cy, text: more, size: 11, weight: 400, color: theme.muted, alpha });
    edge -= 4;
  }
  for (const person of participants.slice(0, CANVAS_MAX_PARTICIPANTS).reverse()) badge(collaboratorBadge(person), false);

  const progress = input.subtasks?.get(task.id);
  const counter = progress?.total ? `↳ ${progress.done}/${progress.total}` : null;
  const counterW = counter ? measure(counter, 11, 400) : 0;
  let start = left;
  const parent = task.parentId ? input.parentTitles?.get(task.id) : undefined;
  if (parent !== undefined) {
    const room = edge - left - (counter ? counterW + 4 : 0);
    const text = truncate(`↑ ${parent}`, room, (t) => measure(t, 11, 400));
    if (text) {
      ops.push({ kind: 'text', x: left, y: cy, text, size: 11, weight: 400, color: theme.muted, alpha });
      start = left + measure(text, 11, 400) + 4;
    }
  }
  if (counter && start + counterW <= edge + 4) ops.push({ kind: 'text', x: start, y: cy, text: counter, size: 11, weight: 400, color: theme.muted, alpha });
}

// ── Rozdzielczość ───────────────────────────────────────────────────────────────────────────────

/** Bezpieczny limit płótna przeglądarek (bok i pole w pikselach urządzenia). */
export const CANVAS_EXPORT_LIMITS = { maxSide: 16_384, maxArea: 36_000_000 } as const;

/**
 * Skala obrazu (piksele pliku na px tablicy): `preferred` (PNG — 2×), zmniejszona tak, żeby płótno
 * `width·skala × height·skala` zmieściło się w limicie przeglądarki.
 */
export function canvasRasterScale(width: number, height: number, { preferred = 2, maxSide = CANVAS_EXPORT_LIMITS.maxSide, maxArea = CANVAS_EXPORT_LIMITS.maxArea } = {}): number {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return Math.min(preferred, maxSide / w, maxSide / h, Math.sqrt(maxArea / (w * h)));
}

// ── Strony PDF ──────────────────────────────────────────────────────────────────────────────────

export type CanvasPdfMode = 'fit' | 'pages';

export interface CanvasPdfOptions {
  paper: PdfPaper;
  orientation: PdfOrientation;
  /** `fit` — cała tablica na jednej stronie; `pages` — stała skala, kolejne strony. */
  mode: CanvasPdfMode;
}

export interface CanvasPdfPagePlan {
  /** Rozmiar strony (pt). */
  width: number;
  height: number;
  /** Wycinek planu rysowania (px przy 100 %). */
  crop: { x: number; y: number; w: number; h: number };
  /** Miejsce obrazu na stronie (pt, od lewego górnego rogu). */
  place: { x: number; y: number; w: number; h: number };
  /** Piksele obrazu na px planu. */
  rasterScale: number;
  /** Stopka (ASCII), np. „Strona 2 z 6 (wiersz 1, kolumna 2)”. */
  label?: { text: string; x: number; y: number; size: number };
}

/** Margines strony (1 cm) i skale. */
export const CANVAS_PDF = {
  margin: 28.35,
  /** Najwyżej tyle pt na px przy dopasowaniu (mała tablica nie rośnie ponad miarę). */
  fitMaxScale: 0.75,
  /** Skala trybu „Kilka stron” — karta 180 px ≈ 3,2 cm. */
  pagesScale: 0.5,
  /** Rozdzielczość obrazu na stronie. */
  dpi: 300,
} as const;

/**
 * Podział osi długości `total` na odcinki ≤ `avail`; koniec odcinka przesunięty wstecz na najbliższą
 * linię `origin + k·step` (między kartami), o ile odcinek nie zrobi się pusty.
 */
export function splitAxis(total: number, avail: number, origin: number, step: number): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  while (start < total - 0.5) {
    let end = start + avail;
    if (end >= total) end = total;
    else {
      const snapped = origin + Math.floor((end - origin) / step) * step;
      if (snapped > start + 0.5) end = snapped;
    }
    out.push([start, end]);
    start = end;
  }
  return out.length ? out : [[0, total]];
}

const pixelScale = (ptPerPx: number) => Math.min(2, (ptPerPx * CANVAS_PDF.dpi) / 72);

/** Strony PDF dla planu rysowania. */
export function canvasPdfPages(scene: Pick<CanvasScene, 'width' | 'height' | 'grid'>, options: CanvasPdfOptions): CanvasPdfPagePlan[] {
  const page = pdfPageSize(options.paper, options.orientation);
  const m = CANVAS_PDF.margin;
  const availW = page.width - 2 * m;
  const availH = page.height - 2 * m;
  if (options.mode === 'fit') {
    const s = Math.min(availW / scene.width, availH / scene.height, CANVAS_PDF.fitMaxScale);
    const w = scene.width * s;
    const h = scene.height * s;
    return [
      {
        ...page,
        crop: { x: 0, y: 0, w: scene.width, h: scene.height },
        place: { x: (page.width - w) / 2, y: m, w, h },
        rasterScale: Math.min(pixelScale(s), canvasRasterScale(scene.width, scene.height)),
      },
    ];
  }
  const s = CANVAS_PDF.pagesScale;
  const footer = 14;
  const cols = splitAxis(scene.width, availW / s, scene.grid.x, scene.grid.stepX);
  const rows = splitAxis(scene.height, (availH - footer) / s, scene.grid.y, scene.grid.stepY);
  const total = cols.length * rows.length;
  const pages: CanvasPdfPagePlan[] = [];
  rows.forEach(([y0, y1], r) =>
    cols.forEach(([x0, x1], c) => {
      const crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      pages.push({
        ...page,
        crop,
        place: { x: m, y: m, w: crop.w * s, h: crop.h * s },
        rasterScale: Math.min(pixelScale(s), canvasRasterScale(crop.w, crop.h)),
        label: total > 1 ? { text: `Strona ${pages.length + 1} z ${total} (wiersz ${r + 1}, kolumna ${c + 1})`, x: m, y: page.height - m / 2, size: 8 } : undefined,
      });
    }),
  );
  return pages;
}
