/**
 * Widok „Karteczki” (v1.x, tylko web): zadania listy jako karteczki na siatce — burza mózgów zespołu.
 *
 * Karta zajmuje jedną komórkę siatki (`tasks.canvas_pos` = `{ col, row }`), więc „bez nachodzenia”
 * to po prostu jedna karta na komórkę. Upuszczenie na zajęte miejsce kładzie kartę w najbliższej
 * wolnej komórce (`nearestFreeCell`); dwie osoby, które jednocześnie położą karty w tej samej
 * komórce, widzą po synchronizacji to samo ułożenie (`canvasLayout` rozstrzyga po id, bez zapisu).
 * Grupy (`lists.canvas_groups`) są tylko graficzne: prostokąty na siatce, karta „w grupie” to karta,
 * której komórka leży w prostokącie. Strzałki: „blokuje” = zależność (`task_dependencies`), „wynika z”
 * = samo powiązanie (`tasks.derived_from` na zadaniu, które wynika).
 */
import { detectCycle, type Dependency } from './dependencies.ts';
import { CanvasGroups, DERIVED_FROM_MAX, type CanvasGroup, type CanvasPos, type CanvasTasks } from './schemas/model.ts';
import { uuidv7 } from './ids.ts';
import type { Priority } from './schemas/primitives.ts';
import type { TaskOp } from './tasks.ts';
import type { ViewTask } from './views.ts';

export type CanvasCell = CanvasPos;
type Cell = CanvasCell;

/** Wymiary karty i odstępu przy powiększeniu 100 % (px). */
export const CANVAS_CARD = { width: 180, height: 120, gap: 24 } as const;
/** Krok siatki (karta + odstęp). */
export const CANVAS_STEP = { x: CANVAS_CARD.width + CANVAS_CARD.gap, y: CANVAS_CARD.height + CANVAS_CARD.gap } as const;
/** Powiększenie: zakres i progi. */
export const CANVAS_ZOOM = { min: 0.25, max: 2, step: 1.2, /** poniżej — karty bez tekstu */ textMin: 0.5 } as const;
/** Widok tablicy: powiększenie i położenie (0, 0) siatki w px względem lewego górnego rogu obszaru. */
export interface CanvasViewport {
  zoom: number;
  x: number;
  y: number;
}

export const clampCanvasZoom = (zoom: number): number => Math.min(CANVAS_ZOOM.max, Math.max(CANVAS_ZOOM.min, zoom));

/**
 * Powiększenie `ratio` razy z przesunięciem: punkt tablicy, który był pod `from` (px w obszarze),
 * ląduje pod `to`. Kółko / przyciski: `from` = `to` (punkt pod kursorem stoi w miejscu); szczypanie
 * dwoma palcami: `from` = środek palców na starcie, `to` = środek teraz, `ratio` = odległość teraz /
 * na starcie (względem widoku ze startu gestu).
 */
export function zoomCanvasViewport(view: CanvasViewport, ratio: number, from: { x: number; y: number }, to: { x: number; y: number } = from): CanvasViewport {
  const zoom = clampCanvasZoom(view.zoom * ratio);
  const worldX = (from.x - view.x) / view.zoom;
  const worldY = (from.y - view.y) / view.zoom;
  return { zoom, x: to.x - worldX * zoom, y: to.y - worldY * zoom };
}

/** Kolor karteczki bez kolorowego tagu (żółta karteczka). */
export const CANVAS_DEFAULT_COLOR = '#FACC15';
/** Ile kart w rzędzie układa „Ułóż wszystkie”. */
export const CANVAS_ARRANGE_COLUMNS = 6;

export const cellKey = (cell: Cell): string => `${cell.col}:${cell.row}`;
const sameCell = (a: Cell, b: Cell) => a.col === b.col && a.row === b.row;

// ── Wolne komórki ───────────────────────────────────────────────────────────────────────────────

/**
 * Najbliższa wolna komórka od `target` (odległość euklidesowa w komórkach; remis — wyżej, potem
 * bardziej w lewo). `target` wolny → on sam.
 */
export function nearestFreeCell(occupied: ReadonlySet<string>, target: Cell): Cell {
  return nearestFreeOffset((d) => !occupied.has(cellKey({ col: target.col + d.col, row: target.row + d.row })), target);
}

/**
 * Najmniejsze przesunięcie `d` (od zera), dla którego `free(d)` — szukanie pierścieniami. Komórka
 * w pierścieniu `r` ma odległość ≥ r, a najdalsza w pierścieniu r — r·√2, więc po pierwszym trafieniu
 * w pierścieniu r wystarczy przejrzeć pierścienie do ⌈r·√2⌉.
 */
function nearestFreeOffset(free: (d: Cell) => boolean, origin: Cell = { col: 0, row: 0 }, maxRing = 500): Cell {
  let best: { d: Cell; dist: number } | null = null;
  let limit = maxRing;
  for (let r = 0; r <= limit; r++) {
    for (const d of ring(r)) {
      if (!free(d)) continue;
      const dist = d.col * d.col + d.row * d.row;
      if (!best || dist < best.dist || (dist === best.dist && (d.row < best.d.row || (d.row === best.d.row && d.col < best.d.col)))) best = { d, dist };
    }
    if (best && limit === maxRing) limit = Math.min(maxRing, Math.ceil(r * Math.SQRT2));
  }
  if (!best) throw new Error('Brak wolnego miejsca na tablicy.');
  return { col: origin.col + best.d.col, row: origin.row + best.d.row };
}

/** Komórki w odległości Czebyszewa dokładnie `r` od (0, 0). */
function* ring(r: number): Generator<Cell> {
  if (r === 0) {
    yield { col: 0, row: 0 };
    return;
  }
  for (let col = -r; col <= r; col++) {
    yield { col, row: -r };
    yield { col, row: r };
  }
  for (let row = -r + 1; row <= r - 1; row++) {
    yield { col: -r, row };
    yield { col: r, row };
  }
}

// ── Które zadania ───────────────────────────────────────────────────────────────────────────────

/**
 * Zadania listy pokazywane jako karteczki: `top` (domyślnie) — tylko główne, `all` — także podzadania
 * (każde na własnej karcie). Ukryte podzadania zachowują `canvas_pos` (bez zapisu) i nie zajmują
 * komórek w `canvasLayout` — po przełączeniu na `all` ewentualną kolizję rozstrzyga `canvasLayout`.
 */
export function canvasTasks<T extends Pick<ViewTask, 'listId' | 'parentId'>>(tasks: readonly T[], listId: string, show: CanvasTasks = 'top'): T[] {
  return tasks.filter((t) => t.listId === listId && (show === 'all' || !t.parentId));
}

/**
 * Postęp podzadań na karcie rodzica (jak `progress` w widoku listy): rodzic → ukończone / wszystkie
 * bezpośrednie podzadania, anulowane się nie liczą. `tasks` = wszystkie zadania (także ukończone
 * ukryte przez „Ukończone”), żeby licznik nie zależał od filtra.
 */
export function canvasSubtaskProgress(tasks: readonly Pick<ViewTask, 'parentId' | 'status'>[]): Map<string, { done: number; total: number }> {
  const out = new Map<string, { done: number; total: number }>();
  for (const t of tasks) {
    if (!t.parentId || t.status === 'cancelled') continue;
    const entry = out.get(t.parentId) ?? { done: 0, total: 0 };
    entry.total++;
    if (t.status === 'done') entry.done++;
    out.set(t.parentId, entry);
  }
  return out;
}

// ── Ułożenie ────────────────────────────────────────────────────────────────────────────────────

type CanvasTask = Pick<ViewTask, 'id' | 'canvasPos' | 'sortKey'>;

export interface PlacedCard<T> {
  task: T;
  cell: Cell;
  /** Karta pokazana obok zapisanej komórki (kolizja dwóch osób) — poprawka zapisze się przy jej ruchu. */
  displaced: boolean;
}

export interface CanvasLayout<T> {
  placed: PlacedCard<T>[];
  /** Pasek „Do ułożenia”: karty bez komórki, w kolejności ręcznej listy. */
  tray: T[];
  /** Zajęte komórki (`cellKey`). */
  occupied: ReadonlySet<string>;
}

/**
 * Ułożenie kart do wyświetlenia. Kilka kart w jednej komórce (dwie osoby położyły je jednocześnie)
 * → komórka zostaje dla najmniejszego id, pozostałe pokazują się w najbliższej wolnej (bez zapisu;
 * wynik jest ten sam na każdym urządzeniu).
 */
export function canvasLayout<T extends CanvasTask>(tasks: readonly T[]): CanvasLayout<T> {
  const withCell = tasks.filter((t) => t.canvasPos).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const occupied = new Set<string>();
  const placed: PlacedCard<T>[] = [];
  const losers: T[] = [];
  for (const task of withCell) {
    const key = cellKey(task.canvasPos!);
    if (occupied.has(key)) losers.push(task);
    else {
      occupied.add(key);
      placed.push({ task, cell: task.canvasPos!, displaced: false });
    }
  }
  for (const task of losers) {
    const cell = nearestFreeCell(occupied, task.canvasPos!);
    occupied.add(cellKey(cell));
    placed.push({ task, cell, displaced: true });
  }
  const tray = tasks.filter((t) => !t.canvasPos).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  return { placed, tray, occupied };
}

/** Prostokąt obejmujący komórki (włącznie); brak komórek → `null`. */
export function canvasBounds(cells: Iterable<Cell>): { col: number; row: number; w: number; h: number } | null {
  let minCol = Infinity;
  let minRow = Infinity;
  let maxCol = -Infinity;
  let maxRow = -Infinity;
  for (const c of cells) {
    minCol = Math.min(minCol, c.col);
    minRow = Math.min(minRow, c.row);
    maxCol = Math.max(maxCol, c.col);
    maxRow = Math.max(maxRow, c.row);
  }
  return minCol === Infinity ? null : { col: minCol, row: minRow, w: maxCol - minCol + 1, h: maxRow - minRow + 1 };
}

// ── Przesuwanie kart ────────────────────────────────────────────────────────────────────────────

export interface CanvasMove {
  ops: TaskOp[];
  undo: TaskOp[];
  /** Przesunięcie faktycznie użyte (po ominięciu zajętych komórek). */
  delta: Cell;
}

const posOp = (id: string, cell: Cell | null): TaskOp => ({ table: 'tasks', id, patch: { canvas_pos: cell ? { col: cell.col, row: cell.row } : null } });

/**
 * Przesunięcie kart o `delta` jako jednego bloku (jedna karta, zaznaczenie, zawartość grupy). Gdy
 * któraś komórka docelowa jest zajęta przez kartę spoza bloku — najbliższe przesunięcie, przy
 * którym cały blok się mieści. `cards` = aktualne komórki przesuwanych kart (z `canvasLayout`).
 */
export function canvasMoveOps(
  layout: Pick<CanvasLayout<CanvasTask>, 'occupied'>,
  cards: readonly { id: string; cell: Cell; saved: Cell | null }[],
  delta: Cell,
): CanvasMove {
  if (!cards.length) return { ops: [], undo: [], delta };
  const own = new Set(cards.map((c) => cellKey(c.cell)));
  const blocked = (key: string) => layout.occupied.has(key) && !own.has(key);
  const fits = (d: Cell) => cards.every((c) => !blocked(cellKey({ col: c.cell.col + d.col, row: c.cell.row + d.row })));
  const extra = nearestFreeOffset((e) => fits({ col: delta.col + e.col, row: delta.row + e.row }));
  const used = { col: delta.col + extra.col, row: delta.row + extra.row };
  const ops: TaskOp[] = [];
  const undo: TaskOp[] = [];
  for (const card of cards) {
    const to = { col: card.cell.col + used.col, row: card.cell.row + used.row };
    // Karta pokazana obok zapisanej komórki zapisuje swoją komórkę nawet bez ruchu (koniec kolizji).
    if (card.saved && sameCell(card.saved, to)) continue;
    ops.push(posOp(card.id, to));
    undo.push(posOp(card.id, card.saved));
  }
  return { ops, undo, delta: used };
}

/** Karta z paska „Do ułożenia” (albo nowa) w komórce `target` — albo najbliższej wolnej. */
export function canvasPlaceOps(layout: Pick<CanvasLayout<CanvasTask>, 'occupied'>, taskId: string, target: Cell): { ops: TaskOp[]; undo: TaskOp[]; cell: Cell } {
  const cell = nearestFreeCell(layout.occupied, target);
  return { ops: [posOp(taskId, cell)], undo: [posOp(taskId, null)], cell };
}

/** Karta z powrotem do paska „Do ułożenia”. */
export const canvasUnplaceOps = (cards: readonly { id: string; saved: Cell | null }[]): { ops: TaskOp[]; undo: TaskOp[] } => ({
  ops: cards.filter((c) => c.saved).map((c) => posOp(c.id, null)),
  undo: cards.filter((c) => c.saved).map((c) => posOp(c.id, c.saved)),
});

/**
 * „Ułóż wszystkie”: karty z paska w wolne komórki wierszami po `columns`, pod dotychczasowymi
 * kartami (od ich lewej krawędzi), a na pustej tablicy — od (0, 0).
 */
export function canvasArrangeOps<T extends CanvasTask>(layout: CanvasLayout<T>, columns = CANVAS_ARRANGE_COLUMNS): { ops: TaskOp[]; undo: TaskOp[] } {
  const bounds = canvasBounds(layout.placed.map((p) => p.cell));
  const start = bounds ? { col: bounds.col, row: bounds.row + bounds.h } : { col: 0, row: 0 };
  const occupied = new Set(layout.occupied);
  const ops: TaskOp[] = [];
  const undo: TaskOp[] = [];
  let i = 0;
  for (const task of layout.tray) {
    let cell: Cell;
    do {
      cell = { col: start.col + (i % columns), row: start.row + Math.floor(i / columns) };
      i++;
    } while (occupied.has(cellKey(cell)));
    occupied.add(cellKey(cell));
    ops.push(posOp(task.id, cell));
    undo.push(posOp(task.id, null));
  }
  return { ops, undo };
}

// ── Grupy ───────────────────────────────────────────────────────────────────────────────────────

/** Grupy z `lists.canvas_groups` (tekst JSON z lokalnej bazy albo tablica); uszkodzone → `[]`. */
export function canvasGroupsOf(raw: unknown): CanvasGroup[] {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const parsed = CanvasGroups.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

export const cellInGroup = (cell: Cell, group: Pick<CanvasGroup, 'col' | 'row' | 'w' | 'h'>): boolean =>
  cell.col >= group.col && cell.col < group.col + group.w && cell.row >= group.row && cell.row < group.row + group.h;

const groupsOp = (listId: string, next: readonly CanvasGroup[]): TaskOp => ({
  table: 'lists',
  id: listId,
  patch: { canvas_groups: next.length ? next.map((g) => ({ id: g.id, name: g.name, color: g.color, col: g.col, row: g.row, w: g.w, h: g.h })) : null },
});

/** Nazwa grupy: przycięta, maks. 60 znaków (pusta dozwolona — sama ramka). */
const groupName = (name: string) => name.trim().slice(0, 60);

/** Nowa grupa obejmująca prostokąt (np. zaznaczone karty z marginesem). */
export function addCanvasGroupOps(
  listId: string,
  current: readonly CanvasGroup[],
  rect: { col: number; row: number; w: number; h: number },
  { name = 'Grupa', color = null, newId = uuidv7 }: { name?: string; color?: string | null; newId?: () => string } = {},
): { ops: TaskOp[]; undo: TaskOp[]; id: string } {
  const id = newId();
  const group: CanvasGroup = { id, name: groupName(name), color, col: rect.col, row: rect.row, w: Math.max(1, rect.w), h: Math.max(1, rect.h) };
  return { ops: [groupsOp(listId, [...current, group])], undo: [groupsOp(listId, current)], id };
}

/** Zmiana nazwy, koloru albo rozmiaru grupy (bez przesuwania kart). */
export function updateCanvasGroupOps(
  listId: string,
  current: readonly CanvasGroup[],
  id: string,
  patch: Partial<Pick<CanvasGroup, 'name' | 'color' | 'col' | 'row' | 'w' | 'h'>>,
): { ops: TaskOp[]; undo: TaskOp[] } {
  if (!current.some((g) => g.id === id)) return { ops: [], undo: [] };
  const next = current.map((g) =>
    g.id === id
      ? {
          ...g,
          ...patch,
          name: patch.name === undefined ? g.name : groupName(patch.name),
          w: Math.max(1, patch.w ?? g.w),
          h: Math.max(1, patch.h ?? g.h),
        }
      : g,
  );
  return { ops: [groupsOp(listId, next)], undo: [groupsOp(listId, current)] };
}

/**
 * Przesunięcie grupy razem z kartami w jej prostokącie. Karty idą jednym blokiem (`canvasMoveOps`),
 * a ramka o to samo przesunięcie, które faktycznie dostały karty.
 */
export function moveCanvasGroupOps(
  listId: string,
  current: readonly CanvasGroup[],
  id: string,
  layout: CanvasLayout<CanvasTask>,
  delta: Cell,
): CanvasMove {
  const group = current.find((g) => g.id === id);
  if (!group) return { ops: [], undo: [], delta };
  const inside = layout.placed.filter((p) => cellInGroup(p.cell, group)).map((p) => ({ id: p.task.id, cell: p.cell, saved: p.task.canvasPos ?? null }));
  const cards = canvasMoveOps(layout, inside, delta);
  if (cards.delta.col === 0 && cards.delta.row === 0) return { ops: [], undo: [], delta: cards.delta };
  const frame = updateCanvasGroupOps(listId, current, id, { col: group.col + cards.delta.col, row: group.row + cards.delta.row });
  return { ops: [...cards.ops, ...frame.ops], undo: [...cards.undo, ...frame.undo], delta: cards.delta };
}

/** Usunięcie grupy (karty zostają na miejscu). */
export function removeCanvasGroupOps(listId: string, current: readonly CanvasGroup[], id: string): { ops: TaskOp[]; undo: TaskOp[] } {
  if (!current.some((g) => g.id === id)) return { ops: [], undo: [] };
  return { ops: [groupsOp(listId, current.filter((g) => g.id !== id))], undo: [groupsOp(listId, current)] };
}

// ── Strzałki ────────────────────────────────────────────────────────────────────────────────────

/** `blocks` — „A blokuje B” (zależność koniec→początek), `derived` — „B wynika z A” (samo powiązanie). */
export type CanvasArrowKind = 'blocks' | 'derived';

/** Etykiety rodzajów strzałek; `sentence(a, b)` — zdanie dla strzałki od `a` do `b`. */
export const CANVAS_ARROW: Record<CanvasArrowKind, { label: string; sentence: (a: string, b: string) => string }> = {
  blocks: { label: 'blokuje', sentence: (a, b) => `${a} blokuje ${b}` },
  derived: { label: 'wynika z', sentence: (a, b) => `${b} wynika z ${a}` },
};

/** Odstęp równoległych strzałek tej samej pary kart (px przy 100 %) i odstęp końców od kart. */
export const CANVAS_ARROW_GAP = { lane: 6, card: 4 } as const;

export interface CanvasArrow {
  /** Klucz stały między odświeżeniami: `b:<id zależności>` albo `d:<źródło>:<zadanie>`. */
  key: string;
  kind: CanvasArrowKind;
  /** Początek strzałki: poprzednik („blokuje”) albo źródło („wynika z”). */
  fromId: string;
  toId: string;
  /** Id zależności (`blocks`), inaczej `null`. */
  dependencyId: string | null;
  /** Naruszona kolejność (`violations` z `dependencies.ts`). */
  violated: boolean;
  /** Przesunięcie równoległe w px (prostopadle do kierunku od → do); 0 = środek. */
  offset: number;
}

export interface CanvasArrows {
  /** Strzałki między kartami leżącymi na tablicy. */
  arrows: CanvasArrow[];
  /** Karta na tablicy → id zadań po drugiej stronie połączeń, których nie widać (pasek, ukryte, inna lista). */
  offBoard: Map<string, string[]>;
}

type LinkTask = Pick<ViewTask, 'id' | 'derivedFrom'>;

/** Krawędzie „wynika z” jako pary źródło → zadanie (do `detectCycle`). */
const derivedEdges = (tasks: readonly LinkTask[]) => tasks.flatMap((t) => (t.derivedFrom ?? []).map((from) => ({ predecessorId: from, successorId: t.id })));

/**
 * Strzałki do narysowania: połączenia, których oba końce leżą na tablicy (`placed`). Połączenie z jednym
 * końcem poza tablicą (karta w pasku „Do ułożenia”, podzadanie ukryte w „Tylko główne”, ukończone ukryte
 * filtrem, zadanie z innej listy) nie jest rysowane — trafia do `offBoard` widocznej karty. Połączenia
 * z zadaniami, których nie ma (kosz, brak dostępu), są pomijane. Kilka strzałek między tą samą parą kart
 * (obie strony, oba rodzaje) dostaje równoległe tory.
 */
export function canvasArrows(placed: ReadonlySet<string>, tasks: readonly LinkTask[], deps: readonly Dependency[], violated: ReadonlySet<string> = new Set()): CanvasArrows {
  const known = new Set(tasks.map((t) => t.id));
  const arrows: CanvasArrow[] = [];
  const offBoard = new Map<string, string[]>();
  const add = (kind: CanvasArrowKind, fromId: string, toId: string, dependencyId: string | null) => {
    if (fromId === toId || !known.has(fromId) || !known.has(toId)) return;
    const a = placed.has(fromId);
    const b = placed.has(toId);
    if (a && b) {
      arrows.push({ key: dependencyId ? `b:${dependencyId}` : `d:${fromId}:${toId}`, kind, fromId, toId, dependencyId, violated: Boolean(dependencyId && violated.has(dependencyId)), offset: 0 });
    } else if (a || b) {
      const [mine, other] = a ? [fromId, toId] : [toId, fromId];
      const list = offBoard.get(mine);
      if (!list) offBoard.set(mine, [other]);
      else if (!list.includes(other)) list.push(other);
    }
  };
  for (const d of deps) add('blocks', d.predecessorId, d.successorId, d.id);
  for (const t of tasks) for (const from of new Set(t.derivedFrom ?? [])) add('derived', from, t.id, null);
  // Tory: para kart (bez kierunku) → strzałki w stałej kolejności, przesunięcia symetrycznie wokół środka.
  const pairs = new Map<string, CanvasArrow[]>();
  for (const arrow of arrows) {
    const pair = arrow.fromId < arrow.toId ? `${arrow.fromId}|${arrow.toId}` : `${arrow.toId}|${arrow.fromId}`;
    const list = pairs.get(pair);
    if (list) list.push(arrow);
    else pairs.set(pair, [arrow]);
  }
  for (const list of pairs.values()) {
    if (list.length < 2) continue;
    list.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    list.forEach((arrow, i) => {
      const lane = (i - (list.length - 1) / 2) * CANVAS_ARROW_GAP.lane;
      // Względem kierunku od mniejszego id do większego — strzałki w przeciwne strony się nie nakładają.
      arrow.offset = arrow.fromId < arrow.toId ? lane : -lane;
    });
  }
  return { arrows, offBoard };
}

export interface CanvasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Prostokąt karty w komórce (px przy 100 %), z opcjonalnym przesunięciem (przeciąganie). */
export const canvasCardRect = (cell: Cell, offset?: { x: number; y: number } | null): CanvasRect => ({
  x: cell.col * CANVAS_STEP.x + (offset?.x ?? 0),
  y: cell.row * CANVAS_STEP.y + (offset?.y ?? 0),
  w: CANVAS_CARD.width,
  h: CANVAS_CARD.height,
});

export interface CanvasSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Odcinek strzałki od krawędzi karty `from` do krawędzi karty `to`: prosta przez środki (przesunięta
 * równolegle o `offset`), przycięta do obwodów obu prostokątów i odsunięta od nich o `gap`. Karty
 * nachodzące na siebie albo za blisko (przy przeciąganiu) → `null` (nic do narysowania).
 */
export function canvasArrowSegment(from: CanvasRect, to: CanvasRect, offset = 0, gap: number = CANVAS_ARROW_GAP.card): CanvasSegment | null {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const ux = dx / len;
  const uy = dy / len;
  // Prostopadła do kierunku (w układzie ekranu, gdzie y rośnie w dół).
  const px = -uy * offset;
  const py = ux * offset;
  const exit = (r: CanvasRect) => Math.min(ux === 0 ? Infinity : r.w / 2 / Math.abs(ux), uy === 0 ? Infinity : r.h / 2 / Math.abs(uy));
  const start = exit(from) + gap;
  const end = len - exit(to) - gap;
  if (end - start < 8) return null;
  const x0 = from.x + from.w / 2 + px;
  const y0 = from.y + from.h / 2 + py;
  return { x1: x0 + ux * start, y1: y0 + uy * start, x2: x0 + ux * end, y2: y0 + uy * end };
}

/** Grot na końcu odcinka: trzy punkty (ramię, czubek, ramię). */
export function canvasArrowHead(seg: CanvasSegment, length = 10, width = 8): [number, number][] {
  const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1) || 1;
  const ux = (seg.x2 - seg.x1) / len;
  const uy = (seg.y2 - seg.y1) / len;
  const bx = seg.x2 - ux * length;
  const by = seg.y2 - uy * length;
  return [
    [bx - uy * (width / 2), by + ux * (width / 2)],
    [seg.x2, seg.y2],
    [bx + uy * (width / 2), by - ux * (width / 2)],
  ];
}

export type DerivedLinkError = { reason: 'self' } | { reason: 'duplicate' } | { reason: 'cycle'; cycle: string[] } | { reason: 'missing' } | { reason: 'limit' };

const derivedOp = (id: string, list: readonly string[] | null | undefined): TaskOp => ({ table: 'tasks', id, patch: { derived_from: list?.length ? [...list] : null } });

/**
 * „B wynika z A” (`toId` wynika z `fromId`): A dopisane do `tasks.derived_from` zadania B — jedno pole,
 * więc LWW zapisuje całą listę naraz. Odrzucone: to samo zadanie, duplikat, koło (B → … → A) i więcej niż
 * `DERIVED_FROM_MAX` źródeł.
 */
export function addDerivedLinkOps(tasks: readonly LinkTask[], next: { fromId: string; toId: string }): { ops: TaskOp[]; undo: TaskOp[] } | { error: DerivedLinkError } {
  if (next.fromId === next.toId) return { error: { reason: 'self' } };
  const to = tasks.find((t) => t.id === next.toId);
  if (!to || !tasks.some((t) => t.id === next.fromId)) return { error: { reason: 'missing' } };
  const current = to.derivedFrom ?? [];
  if (current.includes(next.fromId)) return { error: { reason: 'duplicate' } };
  const cycle = detectCycle(derivedEdges(tasks), { predecessorId: next.fromId, successorId: next.toId });
  if (cycle) return { error: { reason: 'cycle', cycle } };
  if (current.length >= DERIVED_FROM_MAX) return { error: { reason: 'limit' } };
  return { ops: [derivedOp(to.id, [...current, next.fromId])], undo: [derivedOp(to.id, current)] };
}

/** Usunięcie „B wynika z A” z „Cofnij” (poprzednia lista źródeł). */
export function removeDerivedLinkOps(task: LinkTask, fromId: string): { ops: TaskOp[]; undo: TaskOp[] } {
  const current = task.derivedFrom ?? [];
  if (!current.includes(fromId)) return { ops: [], undo: [] };
  return { ops: [derivedOp(task.id, current.filter((id) => id !== fromId))], undo: [derivedOp(task.id, current)] };
}

/** Komunikat błędu „wynika z” do pokazania użytkownikowi. */
export function derivedLinkErrorText(error: DerivedLinkError, titleOf: (id: string) => string): string {
  switch (error.reason) {
    case 'self':
      return 'Karteczka nie może wynikać z samej siebie.';
    case 'duplicate':
      return 'To powiązanie już istnieje.';
    case 'cycle':
      return `To powiązanie zamknęłoby koło: ${error.cycle.map(titleOf).join(' → ')}.`;
    case 'missing':
      return 'Nie ma takiego zadania.';
    case 'limit':
      return `Karteczka może wynikać najwyżej z ${DERIVED_FROM_MAX} innych.`;
  }
}

// ── Wygląd karty ────────────────────────────────────────────────────────────────────────────────

/** Ramka karty według priorytetu: styl (nie tylko kolor — czytelne też bez rozróżniania barw) i grubość. */
export const CANVAS_FRAME: Record<Priority, { style: 'double' | 'solid' | 'dashed'; width: number }> = {
  1: { style: 'double', width: 5 },
  2: { style: 'solid', width: 3 },
  3: { style: 'solid', width: 1 },
  4: { style: 'dashed', width: 1 },
};

/** Tag, który daje kolor karteczce: pierwszy tag zadania (kolejność z panelu zadania) z kolorem. */
export function canvasColorTag<T extends { id: string; color: string | null }>(task: Pick<ViewTask, 'tagIds'>, tags: ReadonlyMap<string, T>): T | null {
  for (const id of task.tagIds) {
    const tag = tags.get(id);
    if (tag?.color) return tag;
  }
  return null;
}

// ── Dopasowanie tytułu ──────────────────────────────────────────────────────────────────────────

export interface TitleFit {
  size: number;
  lines: string[];
  /** Tytuł ucięty „…” (nie zmieścił się nawet najmniejszą czcionką). */
  clipped: boolean;
}

/**
 * Największa czcionka (`min`…`max`, co 1 px), przy której tytuł zawinięty po słowach mieści się w polu
 * `width` × `height` (wysokość linii = `lineHeight` · rozmiar, najwyżej `maxLines` linii). Nie mieści
 * się nawet przy `min` → `min` i ostatnia linia ucięta „…”. `measure(text, size)` = szerokość w px.
 */
export function fitTitle(
  title: string,
  measure: (text: string, size: number) => number,
  { width, height, min = 11, max = 22, lineHeight = 1.2, maxLines = 5 }: { width: number; height: number; min?: number; max?: number; lineHeight?: number; maxLines?: number },
): TitleFit {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const linesAt = (size: number) => wrap(words, (t) => measure(t, size), width);
  const fits = (size: number, lines: string[]) => lines.length <= maxLines && lines.length * size * lineHeight <= height && lines.every((l) => measure(l, size) <= width);
  let lo = min;
  let hi = max;
  let best: { size: number; lines: string[] } | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const lines = linesAt(mid);
    if (fits(mid, lines)) {
      best = { size: mid, lines };
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best) return { ...best, clipped: false };
  const limit = Math.max(1, Math.min(maxLines, Math.floor(height / (min * lineHeight))));
  const lines = linesAt(min);
  const kept = lines.slice(0, limit).map((l) => clip(l, (t) => measure(t, min), width));
  if (lines.length > limit || kept.some((l, i) => l !== lines[i])) kept[kept.length - 1] = ellipsis(kept[kept.length - 1]!, (t) => measure(t, min), width);
  return { size: min, lines: kept, clipped: true };
}

/** Zawijanie po słowach; słowo dłuższe niż linia zostaje samo w linii (`fitTitle` je wtedy odrzuca albo tnie). */
function wrap(words: readonly string[], measure: (text: string) => number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (!line || measure(next) <= width) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function clip(text: string, measure: (text: string) => number, width: number): string {
  if (measure(text) <= width) return text;
  return ellipsis(text, measure, width);
}

function ellipsis(text: string, measure: (text: string) => number, width: number): string {
  let cut = text;
  while (cut && measure(`${cut}…`) > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}
