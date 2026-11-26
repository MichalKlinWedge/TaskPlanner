/**
 * Szybkie dodawanie z językiem naturalnym (SPECYFIKACJA §4, M13): „Zapłacić rachunek za prąd
 * jutro o 10:00 #dom !wysoki” → tytuł + pola. Działa offline, w ułamku milisekundy, tak samo
 * na webie, telefonie i w Edge Function (temat maila).
 *
 * Zasady: rozpoznawane są tylko całe słowa w pełnej formie („za prąd” to nie data — po „za”
 * musi być liczba i jednostka); dla pól pojedynczych (data, godzina, priorytet, cykl…) wygrywa
 * ostatni fragment, wcześniejsze zostają w tytule; `tokens` podaje zakresy znaków rozpoznanych
 * fragmentów (podświetlanie i cofanie rozpoznania w UI — cofnięty fragment poprzedź `\`).
 */
import { addDays, addMonths, dayOfMonth, isoWeekday, lastDayOfMonth, parseLocalDateTime } from './dates.ts';
import type { LocalDate, LocalTime, Priority } from './schemas/primitives.ts';

export interface QuickAddContext {
  /** Teraz, czas lokalny `RRRR-MM-DDTGG:MM`. */
  now: string;
  /** Nazwa bieżącej przestrzeni (listy z niej mają pierwszeństwo przy `#`). */
  currentWorkspace?: string;
  workspaces: readonly string[];
  lists: readonly { workspace: string; name: string; kind?: string }[];
  tags: readonly string[];
  /**
   * Kliknięte miejsce kalendarza: dzień i godzina (bez `time` = „cały dzień”), gdy wpis ich nie podaje.
   * Każde pole osobno: sama godzina we wpisie zostaje w klikniętym dniu, sama data — o klikniętej godzinie.
   */
  slot?: QuickAddSlot;
  /**
   * Data / godzina wybrane przez użytkownika w polach okna szybkiego dodawania — mają pierwszeństwo
   * przed treścią. Fragment daty / godziny we wpisie i tak znika z tytułu, a jego token dostaje
   * `overridden` (chip pokazuje, że wygrało pole). Reszta liczy się od tych wartości (cykl, przypomnienia).
   */
  fixed?: QuickAddFixed;
}

export interface QuickAddSlot {
  date: LocalDate;
  time?: LocalTime;
}

export interface QuickAddFixed {
  date?: LocalDate;
  time?: LocalTime;
}

export type QuickAddRecurrence =
  | { mode: 'schedule'; rrule: string; anchor: LocalDate }
  | { mode: 'after_completion'; every: { unit: 'day' | 'week' | 'month' | 'year'; n: number } };

export type QuickAddReminder = { kind: 'relative'; offsetMin: number } | { kind: 'absolute'; atDate: LocalDate; atTime: LocalTime };

export interface QuickAddFields {
  dueDate?: LocalDate;
  dueTime?: LocalTime;
  durationMin?: number;
  priority?: Priority;
  target?: { kind: 'workspace' | 'list'; name: string; workspace: string };
  tags?: string[];
  recurrence?: QuickAddRecurrence;
  reminders?: QuickAddReminder[];
}

export type QuickAddTokenKind = 'date' | 'time' | 'duration' | 'priority' | 'target' | 'tag' | 'recurrence' | 'reminder';

export interface QuickAddToken {
  kind: QuickAddTokenKind;
  start: number;
  end: number;
  text: string;
  /** Fragment rozpoznany, ale wartość wzięta z pola okna (`QuickAddContext.fixed`). */
  overridden?: true;
}

export interface QuickAddResult {
  title: string;
  fields: QuickAddFields;
  tokens: QuickAddToken[];
}

// ── Słowniki (formy bez polskich znaków, małe litery) ───────────────────────────────────────

const WEEKDAYS: Record<string, number> = {
  poniedzialek: 1, pon: 1, pn: 1,
  wtorek: 2, wt: 2,
  sroda: 3, srode: 3, sr: 3,
  czwartek: 4, czw: 4,
  piatek: 5, pt: 5,
  sobota: 6, sobote: 6, sob: 6,
  niedziela: 7, niedziele: 7, nd: 7, ndz: 7, niedz: 7,
};
/** Skróty, które wolno rozpoznać bez „w” (pełna nazwa sama — „Wtorek — przegląd” — zostaje tytułem). */
const WEEKDAY_ABBREVIATIONS = new Set(['pon', 'pn', 'wt', 'sr', 'czw', 'pt', 'sob', 'nd', 'ndz']);
const RRULE_DAY = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

const MONTHS: Record<string, number> = {
  stycznia: 1, sty: 1, lutego: 2, lut: 2, marca: 3, mar: 3, kwietnia: 4, kwi: 4, maja: 5, maj: 5, czerwca: 6, cze: 6,
  lipca: 7, lip: 7, sierpnia: 8, sie: 8, wrzesnia: 9, wrz: 9, pazdziernika: 10, paz: 10, listopada: 11, lis: 11, grudnia: 12, gru: 12,
};

const ORDINALS: Record<string, number> = {
  pierwszy: 1, pierwsza: 1, pierwszego: 1,
  drugi: 2, druga: 2, drugiego: 2,
  trzeci: 3, trzecia: 3, trzeciego: 3,
  czwarty: 4, czwarta: 4, czwartego: 4,
  ostatni: -1, ostatnia: -1, ostatniego: -1,
};

type Unit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
const UNITS: Record<string, Unit> = {
  m: 'minute', min: 'minute', minut: 'minute', minuty: 'minute', minute: 'minute', minuta: 'minute',
  h: 'hour', godz: 'hour', godzina: 'hour', godzine: 'hour', godziny: 'hour', godzin: 'hour',
  dzien: 'day', dni: 'day', dnia: 'day',
  tydzien: 'week', tygodnie: 'week', tygodni: 'week', tyg: 'week',
  miesiac: 'month', miesiace: 'month', miesiecy: 'month', mies: 'month',
  rok: 'year', lata: 'year', lat: 'year',
};

const PRIORITIES: Record<string, Priority> = {
  '1': 1, '2': 2, '3': 3, '4': 4,
  krytyczny: 1, k: 1, wysoki: 2, w: 2, sredni: 3, s: 3, niski: 4, n: 4,
};

const WORKDAYS = 'MO,TU,WE,TH,FR';

/** Małe litery bez polskich znaków. */
export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// ── Słowa wejścia ────────────────────────────────────────────────────────────────────────────

interface Word {
  raw: string;
  /** Do dopasowania: znormalizowane, bez przecinka / kropki na końcu słowa. */
  norm: string;
  start: number;
  end: number;
  literal: boolean;
}

function splitWords(text: string): Word[] {
  const words: Word[] = [];
  for (const match of text.matchAll(/#"[^"]*"|\S+/g)) {
    const raw = match[0];
    const literal = raw.startsWith('\\') && raw.length > 1;
    let norm = normalizeWord(literal ? raw.slice(1) : raw);
    norm = norm.replace(/[,;]+$/, '');
    if (/[a-z]\.$/.test(norm)) norm = norm.slice(0, -1);
    words.push({ raw, norm, start: match.index, end: match.index + raw.length, literal });
  }
  return words;
}

// ── Wartości rozpoznanych fragmentów ─────────────────────────────────────────────────────────

type DateSpec = { type: 'date'; date: LocalDate } | { type: 'weekday'; day: number; nextWeek: boolean } | { type: 'weekend' };

type RecurrenceSpec =
  | { type: 'daily'; interval: number }
  | { type: 'weekly'; interval: number; days?: number[] | 'workdays' }
  | { type: 'monthly'; interval: number; monthDays?: number[]; nth?: { n: number; day: number }; lastWorkday?: boolean }
  | { type: 'yearly' }
  | { type: 'after'; unit: 'day' | 'week' | 'month' | 'year'; n: number };

type Value =
  | { kind: 'date'; spec: DateSpec }
  | { kind: 'time'; time: LocalTime; durationMin?: number }
  | { kind: 'duration'; minutes: number }
  | { kind: 'priority'; priority: Priority }
  | { kind: 'target'; target: NonNullable<QuickAddFields['target']> }
  | { kind: 'tag'; name: string }
  | { kind: 'recurrence'; spec: RecurrenceSpec }
  | { kind: 'reminder'; reminder: { kind: 'relative'; offsetMin: number } | { kind: 'absolute'; atTime: LocalTime } };

interface Match {
  length: number;
  value: Value;
}

type Matcher = (words: Word[], i: number, ctx: QuickAddContext) => Match | null;

const pad = (n: number) => String(n).padStart(2, '0');
const isNumber = (s: string | undefined): s is string => !!s && /^\d+$/.test(s);

function parseClock(text: string | undefined): { h: number; m: number } | null {
  const match = text ? /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(text) : null;
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2] ?? 0);
  return h <= 24 && m < 60 ? { h: h % 24, m } : null;
}

const clock = ({ h, m }: { h: number; m: number }): LocalTime => `${pad(h)}:${pad(m)}`;

/** „rano” / „wieczorem” / „po południu” po godzinie. */
function dayPart(words: Word[], i: number): { length: number; pm: boolean } | null {
  const w = words[i]?.norm;
  if (w === 'rano') return { length: 1, pm: false };
  if (w === 'wieczorem' || w === 'wieczor') return { length: 1, pm: true };
  if (w === 'po' && words[i + 1]?.norm === 'poludniu') return { length: 2, pm: true };
  return null;
}

function unitAt(words: Word[], i: number): Unit | undefined {
  const w = words[i]?.norm;
  return w ? UNITS[w] : undefined;
}

const durationMinutes = (n: number, unit: Unit) => (unit === 'hour' ? Math.round(n * 60) : unit === 'minute' ? n : null);

// ── Dopasowania ──────────────────────────────────────────────────────────────────────────────

const matchRelativeDay: Matcher = (words, i, ctx) => {
  const today = ctx.now.slice(0, 10);
  const w = words[i]!.norm;
  const offset = w === 'dzis' || w === 'dzisiaj' ? 0 : w === 'jutro' ? 1 : w === 'pojutrze' ? 2 : null;
  return offset === null ? null : { length: 1, value: { kind: 'date', spec: { type: 'date', date: addDays(today, offset) } } };
};

const matchIn: Matcher = (words, i, ctx) => {
  // „za 3 dni”, „za tydzień”, „za 2 tygodnie”, „za miesiąc”
  if (words[i]!.norm !== 'za') return null;
  const today = ctx.now.slice(0, 10);
  let n = 1;
  let j = i + 1;
  if (isNumber(words[j]?.norm)) {
    n = Number(words[j]!.norm);
    j++;
  }
  const unit = unitAt(words, j);
  const bare = j === i + 1; // „za tydzień” bez liczby — tylko liczba pojedyncza
  if (!unit || (bare && !['tydzien', 'miesiac', 'rok'].includes(words[j]!.norm))) return null;
  const date =
    unit === 'day' ? addDays(today, n) : unit === 'week' ? addDays(today, 7 * n) : unit === 'month' ? addMonths(today, n) : unit === 'year' ? addMonths(today, 12 * n) : null;
  return date ? { length: j - i + 1, value: { kind: 'date', spec: { type: 'date', date } } } : null;
};

const matchWeekday: Matcher = (words, i) => {
  const w = words[i]!.norm;
  let j = i;
  let nextWeek = false;
  if (w === 'w' || w === 'we') j++;
  const next = words[j]?.norm;
  if (next === 'przyszly' || next === 'przyszla' || next === 'przyszlą') {
    nextWeek = true;
    j++;
  }
  const day = WEEKDAYS[words[j]?.norm ?? ''];
  if (!day) return null;
  if (j === i && !WEEKDAY_ABBREVIATIONS.has(words[j]!.norm)) return null;
  if (nextWeek && j === i + 1) return null; // „przyszły piątek” bez „w” — zostaje tytułem
  return { length: j - i + 1, value: { kind: 'date', spec: { type: 'weekday', day, nextWeek } } };
};

const matchWeekend: Matcher = (words, i) =>
  words[i]!.norm === 'w' && words[i + 1]?.norm === 'weekend' ? { length: 2, value: { kind: 'date', spec: { type: 'weekend' } } } : null;

const matchEndOf: Matcher = (words, i, ctx) => {
  // „koniec tygodnia”, „na koniec miesiąca”, „do końca tygodnia”
  const w = words[i]!.norm;
  let j = i;
  if (w === 'na' || w === 'do') {
    if (words[i + 1]?.norm !== (w === 'na' ? 'koniec' : 'konca')) return null;
    j++;
  } else if (w !== 'koniec') {
    return null;
  }
  const what = words[j + 1]?.norm;
  const today = ctx.now.slice(0, 10);
  if (what === 'tygodnia') return { length: j - i + 2, value: { kind: 'date', spec: { type: 'date', date: addDays(today, 7 - isoWeekday(today)) } } };
  if (what === 'miesiaca') return { length: j - i + 2, value: { kind: 'date', spec: { type: 'date', date: lastDayOfMonth(today) } } };
  return null;
};

/** Najbliższa przyszła (albo dzisiejsza) data o tym dniu i miesiącu. */
function futureDate(today: LocalDate, day: number, month: number, year?: number): LocalDate | null {
  const valid = (y: number) => day >= 1 && month >= 1 && month <= 12 && day <= dayOfMonth(lastDayOfMonth(`${y}-${pad(month)}-01`));
  if (year !== undefined) return valid(year) ? `${year}-${pad(month)}-${pad(day)}` : null;
  let y = Number(today.slice(0, 4));
  for (let k = 0; k < 8; k++, y++) {
    if (!valid(y)) continue;
    const date = `${y}-${pad(month)}-${pad(day)}`;
    if (date >= today) return date;
  }
  return null;
}

const matchNumericDate: Matcher = (words, i, ctx) => {
  const match = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?$/.exec(words[i]!.norm);
  if (!match) return null;
  // Miesiąc jednocyfrowy tylko z rokiem: „wersja 2.3”, „iOS 17.4” to nie daty, „5.01” i „2.3.2027” tak.
  if (match[2]!.length === 1 && !match[3]) return null;
  const date = futureDate(ctx.now.slice(0, 10), Number(match[1]), Number(match[2]), match[3] ? Number(match[3]) : undefined);
  return date ? { length: 1, value: { kind: 'date', spec: { type: 'date', date } } } : null;
};

const matchNamedDate: Matcher = (words, i, ctx) => {
  if (!isNumber(words[i]!.norm)) return null;
  const month = MONTHS[words[i + 1]?.norm ?? ''];
  if (!month) return null;
  const yearWord = words[i + 2]?.norm;
  const year = yearWord && /^\d{4}$/.test(yearWord) ? Number(yearWord) : undefined;
  const date = futureDate(ctx.now.slice(0, 10), Number(words[i]!.norm), month, year);
  return date ? { length: year ? 3 : 2, value: { kind: 'date', spec: { type: 'date', date } } } : null;
};

const matchTime: Matcher = (words, i) => {
  const w = words[i]!.norm;
  if (w === 'w' && words[i + 1]?.norm === 'poludnie') return { length: 2, value: { kind: 'time', time: '12:00' } };
  // „od 14 do 16”
  if (w === 'od' && words[i + 2]?.norm === 'do') {
    const from = parseClock(words[i + 1]?.norm);
    const to = parseClock(words[i + 3]?.norm);
    if (from && to) {
      const minutes = to.h * 60 + to.m - (from.h * 60 + from.m);
      if (minutes > 0) return { length: 4, value: { kind: 'time', time: clock(from), durationMin: minutes } };
    }
  }
  // „10-11:30” (przynajmniej jeden dwukropek — „2-3 jabłka” to nie godziny)
  const range = /^(\d{1,2}(?::\d{2})?)-(\d{1,2}(?::\d{2})?)$/.exec(w);
  if (range && w.includes(':')) {
    const from = parseClock(range[1]);
    const to = parseClock(range[2]);
    if (from && to) {
      const minutes = to.h * 60 + to.m - (from.h * 60 + from.m);
      if (minutes > 0) return { length: 1, value: { kind: 'time', time: clock(from), durationMin: minutes } };
    }
  }
  // „o 10”, „o 10:00”, „o 10.30”, „o 7 rano”, „o 8 wieczorem”
  if (w === 'o') {
    const time = parseClock(words[i + 1]?.norm);
    if (!time) return null;
    const part = dayPart(words, i + 2);
    // „o 15 pytaniach”, „o 3 latach” — liczba przed rzeczownikiem w miejscowniku to nie godzina.
    if (!part && /(ach|ych|ich)$/.test(words[i + 2]?.norm ?? '')) return null;
    if (part?.pm && time.h < 12) time.h += 12;
    return { length: 2 + (part?.length ?? 0), value: { kind: 'time', time: clock(time) } };
  }
  // „14:45” sam (tylko z dwukropkiem)
  if (/^\d{1,2}:\d{2}$/.test(w)) {
    const time = parseClock(w);
    return time ? { length: 1, value: { kind: 'time', time: clock(time) } } : null;
  }
  return null;
};

const matchDuration: Matcher = (words, i) => {
  const w = words[i]!.norm;
  const tilde = /^~(\d+(?:[.,]\d+)?)(h|m|min)(\d{1,2})?$/.exec(w);
  if (tilde) {
    const n = Number(tilde[1]!.replace(',', '.'));
    const minutes = tilde[2] === 'h' ? Math.round(n * 60) + Number(tilde[3] ?? 0) : n;
    return minutes > 0 ? { length: 1, value: { kind: 'duration', minutes } } : null;
  }
  if (w === 'przez' && words[i + 1] && /^\d+(?:[.,]\d+)?$/.test(words[i + 1]!.norm)) {
    const unit = unitAt(words, i + 2);
    const minutes = unit ? durationMinutes(Number(words[i + 1]!.norm.replace(',', '.')), unit) : null;
    return minutes ? { length: 3, value: { kind: 'duration', minutes } } : null;
  }
  return null;
};

const matchPriority: Matcher = (words, i) => {
  const match = /^!(.+)$/.exec(words[i]!.norm);
  const priority = match ? PRIORITIES[match[1]!] : undefined;
  return priority ? { length: 1, value: { kind: 'priority', priority } } : null;
};

const nameKey = (name: string) => normalizeWord(name).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

function resolveTarget(key: string, ctx: QuickAddContext): NonNullable<QuickAddFields['target']> | 'ambiguous' | null {
  const lists = [...ctx.lists].filter((l) => l.kind !== 'inbox');
  const current = lists.filter((l) => l.workspace === ctx.currentWorkspace);
  const exactIn = (items: typeof lists) => items.filter((l) => nameKey(l.name) === key);
  for (const group of [current, lists]) {
    const found = exactIn(group);
    if (found.length === 1) return { kind: 'list', name: found[0]!.name, workspace: found[0]!.workspace };
    if (found.length > 1) return 'ambiguous';
  }
  const workspace = ctx.workspaces.filter((w) => nameKey(w) === key);
  if (workspace.length === 1) return { kind: 'workspace', name: workspace[0]!, workspace: workspace[0]! };
  // Jednoznaczny prefiks („#remont” → „Remont kuchni”).
  const prefix = [
    ...lists.filter((l) => nameKey(l.name).startsWith(key)).map((l) => ({ kind: 'list' as const, name: l.name, workspace: l.workspace })),
    ...ctx.workspaces.filter((w) => nameKey(w).startsWith(key)).map((w) => ({ kind: 'workspace' as const, name: w, workspace: w })),
  ];
  if (prefix.length === 1) return prefix[0]!;
  return prefix.length > 1 ? 'ambiguous' : null;
}

const matchHash: Matcher = (words, i, ctx) => {
  const raw = words[i]!.raw;
  const quoted = /^#"([^"]+)"$/.exec(raw);
  const plain = /^#([\p{L}\p{N}_-]+)[,;]?$/u.exec(raw);
  const name = quoted?.[1] ?? plain?.[1];
  if (!name || /^\d+$/.test(name)) return null; // „#123” to numer, nie lista ani tag
  const key = nameKey(name);
  const target = resolveTarget(key, ctx);
  if (target && target !== 'ambiguous') return { length: 1, value: { kind: 'target', target } };
  if (quoted) return null;
  const tag = ctx.tags.find((t) => nameKey(t) === key) ?? name;
  return { length: 1, value: { kind: 'tag', name: tag } };
};

const matchAt: Matcher = (words, i, ctx) => {
  const match = /^@([\p{L}\p{N}_-]+)[,;]?$/u.exec(words[i]!.raw);
  if (!match) return null;
  const key = nameKey(match[1]!);
  return { length: 1, value: { kind: 'tag', name: ctx.tags.find((t) => nameKey(t) === key) ?? match[1]! } };
};

const matchReminder: Matcher = (words, i) => {
  const w = words[i]!.norm;
  const caret = /^\^(?:(\d+)(m|min|h)|(\d{1,2}(?::\d{2})?))$/.exec(w);
  if (caret) {
    if (caret[1]) return { length: 1, value: { kind: 'reminder', reminder: { kind: 'relative', offsetMin: Number(caret[1]) * (caret[2] === 'h' ? 60 : 1) } } };
    const time = parseClock(caret[3]);
    return time ? { length: 1, value: { kind: 'reminder', reminder: { kind: 'absolute', atTime: clock(time) } } } : null;
  }
  if (w !== 'przypomnij' && w !== 'przyp') return null;
  // „przypomnij 15 min przed”, „przypomnij 1 godz przed”
  if (isNumber(words[i + 1]?.norm)) {
    const unit = unitAt(words, i + 2);
    const minutes = unit === 'day' ? Number(words[i + 1]!.norm) * 1440 : unit ? durationMinutes(Number(words[i + 1]!.norm), unit) : null;
    if (minutes && words[i + 3]?.norm === 'przed') return { length: 4, value: { kind: 'reminder', reminder: { kind: 'relative', offsetMin: minutes } } };
  }
  // „przypomnij o 9”
  if (words[i + 1]?.norm === 'o') {
    const time = parseClock(words[i + 2]?.norm);
    if (time) return { length: 3, value: { kind: 'reminder', reminder: { kind: 'absolute', atTime: clock(time) } } };
  }
  return null;
};

const matchRecurrence: Matcher = (words, i) => {
  const w = words[i]!.norm;
  const at = (k: number) => words[i + k]?.norm;
  const rec = (length: number, spec: RecurrenceSpec): Match => ({ length, value: { kind: 'recurrence', spec } });

  if (w === 'codziennie') return rec(1, { type: 'daily', interval: 1 });
  if (w === 'corocznie') return rec(1, { type: 'yearly' });
  if ((w === 'kazdego' && at(1) === 'dnia') || (w === 'co' && at(1) === 'dzien')) return rec(2, { type: 'daily', interval: 1 });
  if (w === 'w' && at(1) === 'dni' && (at(2) === 'robocze' || at(2) === 'powszednie')) return rec(3, { type: 'weekly', interval: 1, days: 'workdays' });

  // „ostatniego dnia (roboczego) miesiąca”, „ostatni dzień miesiąca”
  if ((w === 'ostatniego' && at(1) === 'dnia') || (w === 'ostatni' && at(1) === 'dzien')) {
    if (at(2) === 'miesiaca') return rec(3, { type: 'monthly', interval: 1, monthDays: [-1] });
    if (at(2) === 'roboczego' || at(2) === 'roboczy') {
      if (at(3) === 'miesiaca') return rec(4, { type: 'monthly', interval: 1, lastWorkday: true });
    }
  }
  // „15. dnia miesiąca”, „każdego 15. dnia miesiąca”, „15. i ostatniego dnia miesiąca”
  {
    const k = w === 'kazdego' ? 1 : 0;
    const day = /^(\d{1,2})\.$/.exec(at(k) ?? '');
    if (day && Number(day[1]) >= 1 && Number(day[1]) <= 31) {
      const n = Number(day[1]);
      if (at(k + 1) === 'dnia' && at(k + 2) === 'miesiaca') return rec(k + 3, { type: 'monthly', interval: 1, monthDays: [n] });
      if (at(k + 1) === 'i' && at(k + 2) === 'ostatniego' && at(k + 3) === 'dnia' && at(k + 4) === 'miesiaca') {
        return rec(k + 5, { type: 'monthly', interval: 1, monthDays: [n, -1] });
      }
    }
  }
  // „drugi wtorek miesiąca”, „ostatni piątek miesiąca”
  const nth = ORDINALS[w];
  if (nth !== undefined && WEEKDAYS[at(1) ?? ''] && at(2) === 'miesiaca') {
    return rec(3, { type: 'monthly', interval: 1, nth: { n: nth, day: WEEKDAYS[at(1)!]! } });
  }
  // „w każdy poniedziałek”, „w każdą środę”
  if ((w === 'w' || w === 'we') && (at(1) === 'kazdy' || at(1) === 'kazda') && WEEKDAYS[at(2) ?? '']) {
    return rec(3, { type: 'weekly', interval: 1, days: [WEEKDAYS[at(2)!]!] });
  }
  // „N dni po ukończeniu / wykonaniu”
  if (isNumber(w)) {
    const unit = unitAt(words, i + 1);
    if (unit && unit !== 'minute' && unit !== 'hour' && at(2) === 'po' && ['ukonczeniu', 'wykonaniu', 'zrobieniu'].includes(at(3) ?? '')) {
      return rec(4, { type: 'after', unit, n: Number(w) });
    }
  }
  if (w !== 'co') return null;
  // „co drugi wtorek”, „co drugą środę”
  const every = ORDINALS[at(1) ?? ''];
  if (every !== undefined && every > 1 && WEEKDAYS[at(2) ?? '']) return rec(3, { type: 'weekly', interval: every, days: [WEEKDAYS[at(2)!]!] });
  // „co wtorek”
  if (WEEKDAYS[at(1) ?? ''] && !WEEKDAY_ABBREVIATIONS.has(at(1)!)) return rec(2, { type: 'weekly', interval: 1, days: [WEEKDAYS[at(1)!]!] });
  // „co tydzień”, „co 2 tygodnie”, „co 3 dni (po ukończeniu)”, „co miesiąc”, „co roku”
  let n = 1;
  let k = 1;
  if (isNumber(at(1))) {
    n = Number(at(1));
    k = 2;
  }
  if (k === 1 && at(1) === 'roku') return rec(2, { type: 'yearly' });
  const unit = unitAt(words, i + k);
  if (!unit || unit === 'minute' || unit === 'hour') return null;
  if (k === 1 && !['tydzien', 'miesiac', 'rok', 'dzien'].includes(at(1)!)) return null;
  if (at(k + 1) === 'po' && ['ukonczeniu', 'wykonaniu', 'zrobieniu'].includes(at(k + 2) ?? '')) {
    return rec(k + 3, { type: 'after', unit, n });
  }
  if (unit === 'day') return rec(k + 1, { type: 'daily', interval: n });
  if (unit === 'week') return rec(k + 1, { type: 'weekly', interval: n });
  if (unit === 'month') {
    // „co 3 miesiące, 30. dnia”
    const day = /^(\d{1,2})\.$/.exec(at(k + 1) ?? '');
    if (day && at(k + 2) === 'dnia' && Number(day[1]) >= 1 && Number(day[1]) <= 31) {
      return rec(k + 3, { type: 'monthly', interval: n, monthDays: [Number(day[1])] });
    }
    return rec(k + 1, { type: 'monthly', interval: n });
  }
  return rec(k + 1, { type: 'yearly' });
};

/** Kolejność = pierwszeństwo przy tej samej długości dopasowania. */
const MATCHERS: Matcher[] = [
  matchRecurrence,
  matchReminder,
  matchTime,
  matchDuration,
  matchPriority,
  matchHash,
  matchAt,
  matchEndOf,
  matchWeekend,
  matchIn,
  matchNamedDate,
  matchNumericDate,
  matchWeekday,
  matchRelativeDay,
];

// ── Złożenie wyniku ─────────────────────────────────────────────────────────────────────────

interface Found extends Match {
  index: number;
}

const SINGLE: Value['kind'][] = ['date', 'time', 'duration', 'priority', 'target', 'recurrence'];

function resolveDate(spec: DateSpec, today: LocalDate, time: LocalTime | undefined, nowTime: LocalTime): LocalDate {
  if (spec.type === 'date') return spec.date;
  const weekday = isoWeekday(today);
  if (spec.type === 'weekend') return addDays(today, (6 - weekday + 7) % 7);
  if (spec.nextWeek) return addDays(today, 7 - weekday + spec.day);
  let delta = (spec.day - weekday + 7) % 7;
  if (delta === 0 && time && time <= nowTime) delta = 7;
  return addDays(today, delta);
}

function ruleFor(spec: Exclude<RecurrenceSpec, { type: 'after' }>, base: LocalDate): string {
  const interval = 'interval' in spec && spec.interval > 1 ? `;INTERVAL=${spec.interval}` : '';
  switch (spec.type) {
    case 'daily':
      return `FREQ=DAILY${interval}`;
    case 'weekly': {
      const days = spec.days === 'workdays' ? WORKDAYS : (spec.days ?? [isoWeekday(base)]).map((d) => RRULE_DAY[d]).join(',');
      return `FREQ=WEEKLY${interval};BYDAY=${days}`;
    }
    case 'monthly':
      if (spec.lastWorkday) return `FREQ=MONTHLY${interval};BYDAY=${WORKDAYS};BYSETPOS=-1`;
      if (spec.nth) return `FREQ=MONTHLY${interval};BYDAY=${spec.nth.n}${RRULE_DAY[spec.nth.day]}`;
      return `FREQ=MONTHLY${interval};BYMONTHDAY=${(spec.monthDays ?? [dayOfMonth(base)]).join(',')}`;
    case 'yearly':
      return `FREQ=YEARLY;BYMONTH=${Number(base.slice(5, 7))};BYMONTHDAY=${dayOfMonth(base)}`;
  }
}

/** Czy dzień pasuje do reguły (do wyznaczenia pierwszego wystąpienia — odstęp liczy się od niego). */
function matchesRule(spec: Exclude<RecurrenceSpec, { type: 'after' }>, date: LocalDate, base: LocalDate): boolean {
  const weekday = isoWeekday(date);
  switch (spec.type) {
    case 'daily':
      return true;
    case 'weekly':
      return spec.days === 'workdays' ? weekday <= 5 : (spec.days ?? [isoWeekday(base)]).includes(weekday);
    case 'monthly': {
      const last = dayOfMonth(lastDayOfMonth(date));
      const day = dayOfMonth(date);
      if (spec.lastWorkday) {
        let lastWork = last;
        while (isoWeekday(`${date.slice(0, 8)}${pad(lastWork)}`) > 5) lastWork--;
        return day === lastWork;
      }
      if (spec.nth) {
        if (weekday !== spec.nth.day) return false;
        return spec.nth.n > 0 ? Math.ceil(day / 7) === spec.nth.n : day + 7 > last;
      }
      return (spec.monthDays ?? [dayOfMonth(base)]).some((target) => (target === -1 ? day === last : day === target));
    }
    case 'yearly':
      return date.slice(5) === base.slice(5);
  }
}

/**
 * Cofnięcie rozpoznania fragmentu (klik w chip): każde słowo fragmentu dostaje `\`, więc przy
 * następnym parsowaniu zostaje w tytule.
 */
export function suppressToken(text: string, token: Pick<QuickAddToken, 'start' | 'end'>): string {
  const fragment = text.slice(token.start, token.end).replace(/(^|\s)(?=\S)/g, '$1\\');
  return text.slice(0, token.start) + fragment + text.slice(token.end);
}

export function parseQuickAdd(text: string, ctx: QuickAddContext): QuickAddResult {
  const words = splitWords(text);
  const { date: today, time: nowTime } = parseLocalDateTime(ctx.now);

  // Dopasowania od lewej, najdłuższe w danym miejscu.
  const found: Found[] = [];
  for (let i = 0; i < words.length; ) {
    if (words[i]!.literal) {
      i++;
      continue;
    }
    let best: Match | null = null;
    for (const matcher of MATCHERS) {
      const match = matcher(words, i, ctx);
      if (match && words.slice(i, i + match.length).every((w) => !w.literal) && (!best || match.length > best.length)) best = match;
    }
    if (best) {
      found.push({ ...best, index: i });
      i += best.length;
    } else {
      i++;
    }
  }

  // Pola pojedyncze: wygrywa ostatni fragment, wcześniejsze wracają do tytułu.
  const kept = found.filter((f, n) => !SINGLE.includes(f.value.kind) || !found.slice(n + 1).some((later) => later.value.kind === f.value.kind));
  const used = new Set<number>();
  for (const f of kept) for (let k = 0; k < f.length; k++) used.add(f.index + k);

  const value = <K extends Value['kind']>(kind: K) => kept.find((f) => f.value.kind === kind)?.value as Extract<Value, { kind: K }> | undefined;
  const fields: QuickAddFields = {};
  const time = value('time');
  if (time) {
    fields.dueTime = time.time;
    if (time.durationMin) fields.durationMin = time.durationMin;
  } else if (ctx.slot?.time) {
    fields.dueTime = ctx.slot.time;
  }
  // Godzina z pola okna wygrywa z wpisem (zakres „10-12” zostawia tylko czas trwania).
  if (ctx.fixed?.time) fields.dueTime = ctx.fixed.time;
  const duration = value('duration');
  if (duration) fields.durationMin = duration.minutes;
  const priority = value('priority');
  if (priority) fields.priority = priority.priority;
  const target = value('target');
  if (target) fields.target = target.target;
  const tags = kept.filter((f) => f.value.kind === 'tag').map((f) => (f.value as Extract<Value, { kind: 'tag' }>).name);
  if (tags.length) fields.tags = [...new Set(tags)];

  const date = value('date');
  const recurrence = value('recurrence');
  // Bez daty we wpisie liczy się od klikniętego dnia, inaczej od dziś.
  const day = ctx.slot?.date ?? today;
  // Data z pola okna wygrywa z wpisem; cykl i przypomnienia liczą się od niej jak od daty we wpisie.
  if (ctx.fixed?.date) fields.dueDate = ctx.fixed.date;
  else if (date) fields.dueDate = resolveDate(date.spec, today, fields.dueTime, nowTime);

  if (recurrence) {
    const spec = recurrence.spec;
    if (spec.type === 'after') {
      fields.recurrence = { mode: 'after_completion', every: { unit: spec.unit, n: spec.n } };
      fields.dueDate ??= day;
    } else {
      const base = fields.dueDate ?? day;
      if (!fields.dueDate) {
        // Pierwsze wystąpienie od dziś, którego godzina jeszcze nie minęła (od klikniętego dnia — bez względu na godzinę).
        for (let k = 0; k < 400; k++) {
          const candidate = addDays(day, k);
          if (k === 0 && !ctx.slot && fields.dueTime && fields.dueTime <= nowTime) continue;
          if (matchesRule(spec, candidate, base)) {
            fields.dueDate = candidate;
            break;
          }
        }
      }
      fields.recurrence = { mode: 'schedule', rrule: ruleFor(spec, fields.dueDate ?? base), anchor: fields.dueDate ?? base };
    }
  } else if (!fields.dueDate && ctx.slot) {
    fields.dueDate = ctx.slot.date;
  } else if (!fields.dueDate && fields.dueTime) {
    // Sama godzina: dziś, jeśli jeszcze nie minęła, inaczej jutro.
    fields.dueDate = fields.dueTime > nowTime ? today : addDays(today, 1);
  }

  const reminders = kept.filter((f) => f.value.kind === 'reminder').map((f) => (f.value as Extract<Value, { kind: 'reminder' }>).reminder);
  if (reminders.length) {
    fields.reminders = reminders.map((r) => (r.kind === 'relative' ? r : { kind: 'absolute', atDate: fields.dueDate ?? today, atTime: r.atTime }));
  }

  const tokens: QuickAddToken[] = kept.map((f) => {
    const first = words[f.index]!;
    const last = words[f.index + f.length - 1]!;
    const overridden = (f.value.kind === 'date' && ctx.fixed?.date) || (f.value.kind === 'time' && ctx.fixed?.time);
    return { kind: f.value.kind, start: first.start, end: last.end, text: text.slice(first.start, last.end), ...(overridden && { overridden: true as const }) };
  });

  const title = words
    .filter((_, i) => !used.has(i))
    .map((w) => (w.literal ? w.raw.slice(1) : w.raw))
    .join(' ')
    .replace(/\s+(w|we|o|na)$/i, '')
    .replace(/[\s,;:–—-]+$/, '')
    .replace(/^[\s,;:–—-]+/, '')
    .trim();

  return { title, fields, tokens };
}

/**
 * Pola „Termin” i „Godzina” okna szybkiego dodawania: pokazana wartość (`null` = puste) i czy
 * ustawił ją użytkownik (inaczej to tylko wartość domyślna widoku — `dueDate` z „Dziś”, `slot` z kalendarza).
 */
export interface QuickAddWhen {
  date: LocalDate | null;
  time: LocalTime | null;
  dateSet: boolean;
  timeSet: boolean;
}

/** Pola na start okna: wypełnione domyślnymi widoku, jeszcze nieustawione przez użytkownika. */
export function quickAddWhenInitial(defaults: { dueDate?: LocalDate | null; slot?: QuickAddSlot | null }): QuickAddWhen {
  return { date: defaults.slot?.date ?? defaults.dueDate ?? null, time: defaults.slot?.time ?? null, dateSet: false, timeSet: false };
}

/**
 * Pierwszeństwo daty i godziny z pól okna przed treścią wpisu — każde pole osobno:
 * - pole ustawione przez użytkownika (niepuste) wygrywa z datą / godziną we wpisie (`fixed`);
 * - pole wyczyszczone = bez wartości domyślnej, decyduje wpis;
 * - pole nietknięte = wartość domyślna widoku, wpis wygrywa (jak dotąd: `slot` / `defaultDueDate`).
 * Gdy użytkownik ruszył tylko jedno pole, pokazana wartość drugiego działa jak kliknięte miejsce
 * kalendarza (`slot`): „o 15” z nietkniętym dniem = ten dzień, nie „dziś albo jutro”.
 */
export function quickAddWhenContext(
  when: QuickAddWhen,
  defaults: { dueDate?: LocalDate | null; slot?: QuickAddSlot | null },
): { slot?: QuickAddSlot; fixed?: QuickAddFixed; defaultDueDate: LocalDate | null } {
  if (!when.dateSet && !when.timeSet) return { ...(defaults.slot && { slot: defaults.slot }), defaultDueDate: defaults.dueDate ?? null };
  const fixed: QuickAddFixed = {};
  if (when.dateSet && when.date) fixed.date = when.date;
  if (when.timeSet && when.time) fixed.time = when.time;
  const defaultTime = when.timeSet ? null : when.time;
  const slot = when.date ? { date: when.date, ...(defaultTime && { time: defaultTime }) } : undefined;
  return { ...(slot && { slot }), ...((fixed.date || fixed.time) && { fixed }), defaultDueDate: null };
}
