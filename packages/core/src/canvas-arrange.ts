/**
 * Automatyczne układanie karteczek (menu „Ułóż” w widoku „Karteczki”, tylko web).
 *
 * Trzy sposoby: „Według …” (kolumny kategorii z opcjonalnymi ramkami grup), „Według strzałek” (warstwy
 * od lewej do prawej, karty bez połączeń z boku) i „Zagęść” (skraca puste kolumny i wiersze, zachowując
 * względny układ). Wynik to plan: operacje do jednej paczki `mutateMany` z „Cofnij” + podgląd (komórki
 * docelowe, ramki). Wynik zależy tylko od danych (pozycje, id, `sort_key`, tagi, zależności, data) —
 * dwie osoby dostają to samo — a karta już stojąca na swoim miejscu nie dostaje zapisu, więc ponowne
 * ułożenie tym samym sposobem nie zmienia nic.
 */
import {
  CANVAS_ARRANGE_COLUMNS,
  canvasBounds,
  canvasColorTag,
  canvasGroupsOp,
  canvasPosOp,
  cellInGroup,
  cellKey,
  nearestFreeOffset,
  type CanvasCell,
  type CanvasLayout,
} from './canvas.ts';
import { addDays, weekStart } from './dates.ts';
import type { Dependency } from './dependencies.ts';
import { compareText, plural } from './format.ts';
import { uuidv5 } from './ids.ts';
import { PRIORITY, TASK_STATUS, VIEW_SECTION } from './labels.ts';
import type { CanvasGroup } from './schemas/model.ts';
import { TaskStatus, type LocalDate, type Priority } from './schemas/primitives.ts';
import type { TaskOp } from './tasks.ts';
import type { ViewTask } from './views.ts';

type Cell = CanvasCell;
type Rect = { col: number; row: number; w: number; h: number };

/** Cecha do „Ułóż według …”. */
export type CanvasArrangeBy = 'color' | 'priority' | 'assignee' | 'status' | 'due';

export type CanvasArrange =
  | { kind: 'by'; by: CanvasArrangeBy; /** Ramka grupy z nazwą kategorii wokół każdej kolumny (domyślnie tak). */ frames?: boolean }
  | { kind: 'arrows' }
  | { kind: 'compact' };

export type CanvasArrangeTask = Pick<ViewTask, 'id' | 'canvasPos' | 'sortKey' | 'priority' | 'status' | 'dueDate' | 'tagIds'> & {
  assigneeId?: string | null;
  derivedFrom?: readonly string[] | null;
};

export interface CanvasArrangeContext {
  listId: string;
  groups: readonly CanvasGroup[];
  /** Zaznaczone karty (z tablicy i z paska); pusty / brak = cała tablica. „Zagęść” zawsze całą. */
  selection?: ReadonlySet<string> | null;
  /** Przy całej tablicy także karty z paska „Do ułożenia” (domyślnie tak). */
  withTray?: boolean;
  /** Tagi (kolor karty = pierwszy kolorowy tag). */
  tags?: ReadonlyMap<string, { id: string; name: string; color: string | null; sortKey: string }>;
  collaborators?: readonly { id: string; name: string }[];
  /** Dziś (kategorie terminu). */
  today?: LocalDate;
  /** Pierwszy dzień tygodnia (1 = poniedziałek … 7 = niedziela) — „Ten tydzień”. */
  firstDayOfWeek?: number;
  /** Zależności „blokuje” (aktywne). */
  dependencies?: readonly Dependency[];
}

export interface CanvasArrangeMove {
  id: string;
  /** Komórka wyświetlana teraz; `null` = z paska. */
  from: Cell | null;
  to: Cell;
}

export interface CanvasArrangePlan {
  ops: TaskOp[];
  undo: TaskOp[];
  /** Tylko karty, które dostają nową komórkę. */
  moves: CanvasArrangeMove[];
  /** Grupy po ułożeniu (podgląd ramek). */
  groups: CanvasGroup[];
  /** Ramki: nowe / przesunięte albo zmienione / usunięte (puste po ułożeniu). */
  added: number;
  changed: number;
  removed: number;
  /** Karty objęte ułożeniem. */
  count: number;
  /** Uwaga dla użytkownika (np. limit grup) albo `null`. */
  note: string | null;
}

/** Najwięcej grup na liście (jak `CanvasGroups`). */
const GROUP_LIMIT = 100;
/** Szerokość bloku kategorii: 1 kolumna do 8 kart w największej kategorii, potem co 8 kart jedna więcej, maks. 4. */
const BLOCK_ROWS = 8;
const BLOCK_MAX = 4;

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sameCell = (a: Cell | null | undefined, b: Cell) => Boolean(a && a.col === b.col && a.row === b.row);
const intersects = (a: Rect, b: Rect) => a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
const sameGroups = (a: readonly CanvasGroup[], b: readonly CanvasGroup[]) =>
  a.length === b.length &&
  a.every((g, i) => {
    const h = b[i]!;
    return g.id === h.id && g.name === h.name && g.color === h.color && g.col === h.col && g.row === h.row && g.w === h.w && g.h === h.h;
  });

const empty = (groups: readonly CanvasGroup[], count = 0, note: string | null = null): CanvasArrangePlan => ({
  ops: [],
  undo: [],
  moves: [],
  groups: [...groups],
  added: 0,
  changed: 0,
  removed: 0,
  count,
  note,
});

/** Karta do ułożenia: zadanie i komórka wyświetlana teraz (`null` = pasek). */
interface Item<T> {
  task: T;
  cell: Cell | null;
}

/**
 * Plan ułożenia (bez zapisu). `layout` = `canvasLayout` kart widocznych na tablicy (ukryte podzadania
 * i ukończone ukryte filtrem nie biorą udziału i nie zajmują komórek, jak wszędzie w widoku).
 */
export function canvasArrangePlan<T extends CanvasArrangeTask>(layout: CanvasLayout<T>, mode: CanvasArrange, ctx: CanvasArrangeContext): CanvasArrangePlan {
  if (mode.kind === 'compact') return compactPlan(layout, ctx);

  // Zakres: zaznaczenie albo cała tablica (+ pasek). Kolejność czytania: tablica wierszami, potem pasek.
  const sel = ctx.selection?.size ? ctx.selection : null;
  const placed = layout.placed.filter((p) => !sel || sel.has(p.task.id));
  const tray = sel ? layout.tray.filter((t) => sel.has(t.id)) : ctx.withTray === false ? [] : [...layout.tray];
  placed.sort((a, b) => a.cell.row - b.cell.row || a.cell.col - b.cell.col || byId(a.task, b.task));
  tray.sort((a, b) => cmp(a.sortKey, b.sortKey) || byId(a, b));
  const items: Item<T>[] = [...placed.map((p) => ({ task: p.task, cell: p.cell })), ...tray.map((task) => ({ task, cell: null }))];
  if (!items.length) return empty(ctx.groups);

  const pattern = mode.kind === 'by' ? columnsPattern(items, mode.by, ctx) : arrowsPattern(items, ctx);
  // Grupy: ramka kategorii przejmuje istniejącą grupę o tym samym id (wcześniejsze „Ułóż”) albo tej samej
  // nazwie — o ile nie ma w niej kart spoza zakresu. Grupy, z których wszystkie karty poszły do układu,
  // znikają; pozostałe zostają na miejscu i układ je omija.
  const arranged = new Set(items.map((i) => i.task.id));
  const others = layout.placed.filter((p) => !arranged.has(p.task.id)).map((p) => p.cell);
  const holdsOthers = (g: CanvasGroup) => others.some((c) => cellInGroup(c, g));
  const holdsArranged = (g: CanvasGroup) => placed.some((p) => cellInGroup(p.cell, g));
  const plan = (frames: readonly Frame[]) => {
    const sorted = [...ctx.groups].sort(byId);
    const taken = new Set<string>();
    const reuse = new Map<string, { group: CanvasGroup | null; id: string }>();
    for (const frame of frames) {
      const free = (g: CanvasGroup) => !taken.has(g.id) && !holdsOthers(g);
      const match = sorted.find((g) => g.id === frame.id && free(g)) ?? sorted.find((g) => g.name === frame.name && free(g));
      let id = match?.id ?? frame.id;
      // Id zajęte przez grupę, której nie można przejąć (karty spoza zakresu) — następne deterministyczne.
      for (let n = 2; !match && ctx.groups.some((g) => g.id === id); n++) id = uuidv5(`${frame.id}:${n}`);
      if (match) taken.add(match.id);
      reuse.set(frame.key, { group: match ?? null, id });
    }
    const removed = new Set(ctx.groups.filter((g) => !taken.has(g.id) && holdsArranged(g) && !holdsOthers(g)).map((g) => g.id));
    const kept = ctx.groups.filter((g) => !taken.has(g.id) && !removed.has(g.id));
    return { frames, reuse, removed, kept };
  };
  let groups = plan(mode.kind === 'by' && mode.frames !== false ? pattern.frames : []);
  let note: string | null = null;
  if (groups.kept.length + groups.frames.length > GROUP_LIMIT) {
    groups = plan([]);
    note = `Bez ramek: lista może mieć najwyżej ${GROUP_LIMIT} grup.`;
  }
  const { frames, reuse, removed: removedIds, kept } = groups;

  // Kotwica: lewy górny róg dotychczasowych komórek układanych kart; same karty z paska — pod tablicą.
  const own = canvasBounds(placed.map((p) => p.cell));
  const all = canvasBounds(layout.placed.map((p) => p.cell));
  const anchor = own ? { col: own.col, row: own.row } : all ? { col: all.col, row: all.row + all.h + 1 } : { col: 0, row: 0 };

  // Układ nie może zachodzić na karty spoza zakresu ani na pozostające grupy — wtedy najbliższe wolne przesunięcie całości.
  const blockedCells = new Set(others.map(cellKey));
  const keptRects: readonly Rect[] = kept;
  const obstacles = canvasBounds([...others, ...keptRects.flatMap((r) => [{ col: r.col, row: r.row }, { col: r.col + r.w - 1, row: r.row + r.h - 1 }])]);
  const patternBox = canvasBounds([...pattern.cells.values(), ...frames.flatMap((f) => [{ col: f.rect.col, row: f.rect.row }, { col: f.rect.col + f.rect.w - 1, row: f.rect.row + f.rect.h - 1 }])])!;
  const fits = (d: Cell) => {
    const at = { col: anchor.col + d.col, row: anchor.row + d.row };
    if (!obstacles || !intersects({ ...patternBox, col: patternBox.col + at.col, row: patternBox.row + at.row }, obstacles)) return true;
    for (const rel of pattern.cells.values()) {
      const cell = { col: at.col + rel.col, row: at.row + rel.row };
      if (blockedCells.has(cellKey(cell)) || keptRects.some((r) => cellInGroup(cell, r))) return false;
    }
    for (const f of frames) {
      const rect = { ...f.rect, col: at.col + f.rect.col, row: at.row + f.rect.row };
      if (keptRects.some((r) => intersects(r, rect)) || others.some((c) => cellInGroup(c, rect))) return false;
    }
    return true;
  };
  const origin = nearestFreeOffset(fits, anchor);

  const ops: TaskOp[] = [];
  const undo: TaskOp[] = [];
  const moves: CanvasArrangeMove[] = [];
  for (const item of items) {
    const rel = pattern.cells.get(item.task.id)!;
    const to = { col: origin.col + rel.col, row: origin.row + rel.row };
    // Karta pokazana obok zapisanej komórki (kolizja) zapisuje się nawet bez ruchu.
    if (sameCell(item.task.canvasPos, to)) continue;
    ops.push(canvasPosOp(item.task.id, to));
    undo.push(canvasPosOp(item.task.id, item.task.canvasPos ?? null));
    if (!sameCell(item.cell, to)) moves.push({ id: item.task.id, from: item.cell, to });
  }

  // Grupy po ułożeniu: dotychczasowe w swojej kolejności (przejęte z nowym prostokątem), nowe na końcu.
  const placedFrame = (f: Frame): CanvasGroup => {
    const r = reuse.get(f.key)!;
    return { id: r.id, name: r.group?.name ?? f.name, color: r.group ? r.group.color : f.color, col: origin.col + f.rect.col, row: origin.row + f.rect.row, w: f.rect.w, h: f.rect.h };
  };
  const moved = new Map(frames.filter((f) => reuse.get(f.key)!.group).map((f) => [reuse.get(f.key)!.id, placedFrame(f)]));
  const fresh = frames.filter((f) => !reuse.get(f.key)!.group).map(placedFrame);
  const next = [
    ...ctx.groups.filter((g) => !removedIds.has(g.id)).map((g) => moved.get(g.id) ?? g),
    ...fresh,
  ];
  const changed = [...moved.values()].filter((g) => !sameGroups([g], [ctx.groups.find((c) => c.id === g.id)!])).length;
  if (!sameGroups(next, ctx.groups)) {
    ops.push(canvasGroupsOp(ctx.listId, next));
    undo.push(canvasGroupsOp(ctx.listId, ctx.groups));
  }
  return { ops, undo, moves, groups: next, added: fresh.length, changed, removed: removedIds.size, count: items.length, note };
}

// ── Wzory układu (komórki względem (0, 0)) ──────────────────────────────────────────────────────

interface Frame {
  key: string;
  /** Deterministyczne id nowej grupy. */
  id: string;
  name: string;
  color: string | null;
  rect: Rect;
}

interface Pattern {
  cells: Map<string, Cell>;
  frames: Frame[];
}

interface Category {
  key: string;
  label: string;
  color: string | null;
  /** Kolejność: `rank`, potem `sub` (kolejność tagów albo nazwa osoby — `alpha`), potem `key`. */
  rank: number;
  sub?: string;
  alpha?: boolean;
}

const NO_ASSIGNEE = 'Bez odpowiedzialnego';
const NO_COLOR = 'Bez kolorowego tagu';
const DUE_ORDER = ['overdue', 'today', 'tomorrow', 'week', 'later', 'past', 'none'] as const;
type DueBucket = (typeof DUE_ORDER)[number];
const DUE_LABEL: Record<DueBucket, string> = {
  overdue: VIEW_SECTION.overdue,
  today: VIEW_SECTION.today,
  tomorrow: 'Jutro',
  week: 'Ten tydzień',
  later: VIEW_SECTION.later,
  past: 'Wcześniej',
  none: VIEW_SECTION.noDate,
};

/** Kategoria terminu: zaległe (otwarte przed dziś), dziś, jutro, do końca tygodnia, później, wcześniej (zamknięte), bez terminu. */
export function canvasDueBucket(task: Pick<ViewTask, 'dueDate' | 'status'>, today: LocalDate, firstDayOfWeek = 1): DueBucket {
  const due = task.dueDate;
  if (!due) return 'none';
  if (due < today) return task.status === 'done' || task.status === 'cancelled' ? 'past' : 'overdue';
  if (due === today) return 'today';
  if (due === addDays(today, 1)) return 'tomorrow';
  const weekEnd = addDays(weekStart(today, firstDayOfWeek), 6);
  return due <= weekEnd ? 'week' : 'later';
}

function categoryOf(task: CanvasArrangeTask, by: CanvasArrangeBy, ctx: CanvasArrangeContext): Category {
  switch (by) {
    case 'color': {
      const tag = canvasColorTag(task, ctx.tags ?? new Map());
      return tag ? { key: `tag:${tag.id}`, label: tag.name, color: tag.color, rank: 0, sub: tag.sortKey } : { key: 'none', label: NO_COLOR, color: null, rank: 1 };
    }
    case 'priority': {
      const p = PRIORITY[task.priority as Priority];
      return { key: String(task.priority), label: `${p.short} ${p.label}`, color: p.color, rank: task.priority };
    }
    case 'assignee': {
      const person = task.assigneeId ? ctx.collaborators?.find((c) => c.id === task.assigneeId) : undefined;
      return person ? { key: person.id, label: person.name, color: null, rank: 0, sub: person.name, alpha: true } : { key: 'none', label: NO_ASSIGNEE, color: null, rank: 1 };
    }
    case 'status':
      return { key: task.status, label: TASK_STATUS[task.status], color: null, rank: TaskStatus.options.indexOf(task.status) };
    case 'due': {
      const bucket = canvasDueBucket(task, ctx.today ?? '1970-01-01', ctx.firstDayOfWeek);
      return { key: bucket, label: DUE_LABEL[bucket], color: null, rank: DUE_ORDER.indexOf(bucket) };
    }
  }
}

/** Nazwy osób alfabetycznie po polsku (`Intl.Collator('pl')`, jak w całej aplikacji), reszta — dokładnie (kod znaków). */
const compareCategory = (a: Category, b: Category): number =>
  a.rank - b.rank || (a.alpha && b.alpha ? compareText(a.sub ?? '', b.sub ?? '') : 0) || cmp(a.sub ?? '', b.sub ?? '') || cmp(a.key, b.key);

/** „Według …”: kategorie w kolumnach (bloki o tej samej szerokości, jedna pusta kolumna między nimi). */
function columnsPattern(items: readonly Item<CanvasArrangeTask>[], by: CanvasArrangeBy, ctx: CanvasArrangeContext): Pattern {
  const cats = new Map<string, { cat: Category; ids: string[] }>();
  for (const item of items) {
    const cat = categoryOf(item.task, by, ctx);
    const entry = cats.get(cat.key);
    if (entry) entry.ids.push(item.task.id);
    else cats.set(cat.key, { cat, ids: [item.task.id] });
  }
  const list = [...cats.values()].sort((a, b) => compareCategory(a.cat, b.cat));
  const largest = Math.max(...list.map((c) => c.ids.length));
  const width = Math.min(BLOCK_MAX, Math.max(1, Math.ceil(largest / BLOCK_ROWS)));
  const cells = new Map<string, Cell>();
  const frames: Frame[] = [];
  list.forEach(({ cat, ids }, i) => {
    const col0 = i * (width + 1);
    ids.forEach((id, j) => cells.set(id, { col: col0 + (j % width), row: Math.floor(j / width) }));
    frames.push({
      key: cat.key,
      id: uuidv5(`canvas-arrange:${ctx.listId}:${by}:${cat.key}`),
      name: cat.label.trim().slice(0, 60),
      color: cat.color,
      rect: { col: col0, row: 0, w: width, h: Math.ceil(ids.length / width) },
    });
  });
  return { cells, frames };
}

/**
 * „Według strzałek”: warstwy najdłuższej ścieżki od lewej do prawej (co druga kolumna), spójne składowe
 * jedna pod drugą, karty bez połączeń w bloku z prawej strony.
 */
function arrowsPattern(items: readonly Item<CanvasArrangeTask>[], ctx: CanvasArrangeContext): Pattern {
  const order = new Map(items.map((item, i) => [item.task.id, i]));
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  const seen = new Set<string>();
  const edge = (from: string, to: string) => {
    if (from === to || !order.has(from) || !order.has(to) || seen.has(`${from}>${to}`)) return;
    seen.add(`${from}>${to}`);
    (succ.get(from) ?? succ.set(from, []).get(from)!).push(to);
    (pred.get(to) ?? pred.set(to, []).get(to)!).push(from);
  };
  for (const d of ctx.dependencies ?? []) edge(d.predecessorId, d.successorId);
  for (const item of items) for (const from of item.task.derivedFrom ?? []) edge(from, item.task.id);

  // Spójne składowe (bez kierunku), w kolejności pierwszej karty.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const linked = items.map((i) => i.task.id).filter((id) => succ.has(id) || pred.has(id));
  for (const id of linked) parent.set(id, id);
  for (const [from, tos] of succ) for (const to of tos) parent.set(find(from), find(to));
  const comps = new Map<string, string[]>();
  for (const id of linked) {
    const root = find(id);
    (comps.get(root) ?? comps.set(root, []).get(root)!).push(id);
  }

  const cells = new Map<string, Cell>();
  let row0 = 0;
  let widest = 0;
  for (const members of comps.values()) {
    const layers = layered(members, succ, pred, order);
    layers.forEach((layer, L) => layer.forEach((id, j) => cells.set(id, { col: 2 * L, row: row0 + j })));
    row0 += Math.max(...layers.map((l) => l.length)) + 1;
    widest = Math.max(widest, 2 * layers.length - 1);
  }

  const lonely = items.map((i) => i.task.id).filter((id) => !succ.has(id) && !pred.has(id));
  if (lonely.length) {
    const height = Math.max(1, row0 - 1);
    const width = comps.size ? Math.min(CANVAS_ARRANGE_COLUMNS, Math.max(1, Math.ceil(lonely.length / height))) : CANVAS_ARRANGE_COLUMNS;
    const col0 = comps.size ? widest + 1 : 0;
    lonely.forEach((id, j) => cells.set(id, { col: col0 + (j % width), row: Math.floor(j / width) }));
  }
  return { cells, frames: [] };
}

/**
 * Warstwy składowej: najdłuższa ścieżka (Kahn); koło (np. „A blokuje B” i „A wynika z B”) rozcinane na
 * karcie o najmniejszym id. Kolejność w warstwie: pierwsza — dotychczasowa pozycja, następne — średnia
 * pozycja poprzedników z wcześniejszych warstw (mniej skrzyżowań), remis — dotychczasowa pozycja.
 */
function layered(members: readonly string[], succ: ReadonlyMap<string, string[]>, pred: ReadonlyMap<string, string[]>, order: ReadonlyMap<string, number>): string[][] {
  const indeg = new Map(members.map((id) => [id, (pred.get(id) ?? []).length]));
  const layer = new Map<string, number>();
  const queue = members.filter((id) => indeg.get(id) === 0);
  let head = 0;
  const visit = (id: string) => {
    let L = 0;
    for (const p of pred.get(id) ?? []) if (layer.has(p)) L = Math.max(L, layer.get(p)! + 1);
    layer.set(id, L);
    for (const s of succ.get(id) ?? []) {
      indeg.set(s, indeg.get(s)! - 1);
      if (indeg.get(s) === 0 && !layer.has(s)) queue.push(s);
    }
  };
  while (layer.size < members.length) {
    if (head < queue.length) {
      const id = queue[head++]!;
      if (!layer.has(id)) visit(id);
      continue;
    }
    // Koło: karta o najmniejszym id spośród nieodwiedzonych.
    let cut: string | null = null;
    for (const id of members) if (!layer.has(id) && (cut === null || id < cut)) cut = id;
    visit(cut!);
  }
  const layers: string[][] = [];
  for (const id of members) (layers[layer.get(id)!] ??= []).push(id);
  const pos = new Map<string, number>();
  const at = (id: string) => order.get(id)!;
  layers.forEach((list, L) => {
    const bary = new Map(
      list.map((id) => {
        const ps = (pred.get(id) ?? []).filter((p) => (layer.get(p) ?? Infinity) < L);
        return [id, L === 0 || !ps.length ? Infinity : ps.reduce((s, p) => s + pos.get(p)!, 0) / ps.length];
      }),
    );
    list.sort((a, b) => {
      const x = bary.get(a)!;
      const y = bary.get(b)!;
      return x === y ? at(a) - at(b) : x === Infinity ? 1 : y === Infinity ? -1 : x - y;
    });
    list.forEach((id, j) => pos.set(id, j));
  });
  // Pusta warstwa możliwa tylko przy rozcięciu koła — pomijana (bez dziur w kolumnach).
  return layers.filter((l) => l?.length);
}

// ── Zagęszczanie ────────────────────────────────────────────────────────────────────────────────

/**
 * „Zagęść”: każdy ciąg pustych kolumn i wierszy między zawartością (karty i krawędzie grup) skraca się
 * do jednej pustej kolumny / wiersza; lewy górny róg stoi w miejscu, grupy przesuwają się i zmniejszają
 * razem z kartami. Względny układ zostaje (odwzorowanie rosnące na każdej osi).
 */
function compactPlan<T extends CanvasArrangeTask>(layout: CanvasLayout<T>, ctx: CanvasArrangeContext): CanvasArrangePlan {
  if (!layout.placed.length && !ctx.groups.length) return empty(ctx.groups);
  const axis = (values: number[]) => {
    const kept = [...new Set(values)].sort((a, b) => a - b);
    const map = new Map<number, number>();
    kept.forEach((v, i) => map.set(v, i === 0 ? v : map.get(kept[i - 1]!)! + Math.min(v - kept[i - 1]!, 2)));
    return (v: number) => map.get(v)!;
  };
  const col = axis([...layout.placed.map((p) => p.cell.col), ...ctx.groups.flatMap((g) => [g.col, g.col + g.w - 1])]);
  const row = axis([...layout.placed.map((p) => p.cell.row), ...ctx.groups.flatMap((g) => [g.row, g.row + g.h - 1])]);
  const ops: TaskOp[] = [];
  const undo: TaskOp[] = [];
  const moves: CanvasArrangeMove[] = [];
  const placed = [...layout.placed].sort((a, b) => byId(a.task, b.task));
  for (const p of placed) {
    const to = { col: col(p.cell.col), row: row(p.cell.row) };
    if (sameCell(p.task.canvasPos, to)) continue;
    ops.push(canvasPosOp(p.task.id, to));
    undo.push(canvasPosOp(p.task.id, p.task.canvasPos ?? null));
    if (!sameCell(p.cell, to)) moves.push({ id: p.task.id, from: p.cell, to });
  }
  const next = ctx.groups.map((g) => {
    const c = col(g.col);
    const r = row(g.row);
    return { ...g, col: c, row: r, w: col(g.col + g.w - 1) - c + 1, h: row(g.row + g.h - 1) - r + 1 };
  });
  const changed = next.filter((g, i) => !sameGroups([g], [ctx.groups[i]!])).length;
  if (changed) {
    ops.push(canvasGroupsOp(ctx.listId, next));
    undo.push(canvasGroupsOp(ctx.listId, ctx.groups));
  }
  return { ops, undo, moves, groups: next, added: 0, changed, removed: 0, count: layout.placed.length, note: null };
}

// ── Opis ────────────────────────────────────────────────────────────────────────────────────────

/** Podsumowanie planu do podglądu i dymka „Cofnij”, np. „przesunie 12 karteczek (3 z paska) · ramki: +4, −1”. */
export function canvasArrangeSummary(plan: CanvasArrangePlan): string {
  const fromTray = plan.moves.filter((m) => !m.from).length;
  const cards = plan.moves.length;
  const parts: string[] = [];
  if (cards) parts.push(`${plural(cards, ['karteczka', 'karteczki', 'karteczek'])}${fromTray ? ` (z paska ${fromTray})` : ''}`);
  const frames = [plan.added ? `+${plan.added}` : '', plan.changed ? `przesunięte ${plan.changed}` : '', plan.removed ? `−${plan.removed}` : ''].filter(Boolean);
  if (frames.length) parts.push(`ramki: ${frames.join(', ')}`);
  if (!parts.length) return plan.ops.length ? 'poprawka zapisanych komórek' : 'nic do zmiany — karteczki już tak leżą';
  return parts.join(' · ');
}
