/**
 * Przyciski formatowania pola Markdown (opis zadania): zmiana tekstu dla zaznaczenia `[start, end)`.
 * Wynik to jedna podmiana `from..to` → `insert` i nowe zaznaczenie — aplikacja wstawia ją tak, żeby
 * działało „Cofnij” przeglądarki. Składnia jak w `markdown.ts` (to, co rozumie podgląd na telefonie
 * i TipTap na webie): `**`, `*`, `~~`, `` ` ``, `[tekst](url)`, `#`, `>`, `-`, `1.`, `- [ ]`, `---`, tabele GFM.
 * Ponowne użycie na już sformatowanym fragmencie zdejmuje formatowanie.
 */

export type MarkdownAction =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'link'
  | 'heading'
  | 'quote'
  | 'bullet'
  | 'numbered'
  | 'task'
  | 'table'
  | 'rule';

export interface MarkdownTextEdit {
  from: number;
  to: number;
  insert: string;
  /** Zaznaczenie po zmianie (w nowym tekście). */
  selStart: number;
  selEnd: number;
}

const INLINE: Partial<Record<MarkdownAction, string>> = { bold: '**', italic: '*', strike: '~~', code: '`' };

/** Wzorce początku linii: rozpoznanie (do zdjęcia) i dodawany prefiks. */
const LINE: Partial<Record<MarkdownAction, { match: RegExp; prefix: (i: number) => string }>> = {
  heading: { match: /^#{1,6} /, prefix: () => '### ' },
  quote: { match: /^> ?/, prefix: () => '> ' },
  bullet: { match: /^[-*+] (?!\[[ xX]\] )/, prefix: () => '- ' },
  numbered: { match: /^\d{1,9}[.)] /, prefix: (i) => `${i + 1}. ` },
  task: { match: /^[-*+] \[[ xX]\] /, prefix: () => '- [ ] ' },
};

/** Inne znaczniki list/nagłówków/cytatów zastępowane przy zmianie rodzaju linii (lista → zadania itp.). */
const ANY_LINE_MARK = /^(?:#{1,6} |> ?|[-*+] \[[ xX]\] |[-*+] |\d{1,9}[.)] )/;

export const TABLE_TEMPLATE = '| Nagłówek | Nagłówek |\n| -------- | -------- |\n| Komórka  | Komórka  |';
const TABLE_HEADER = 'Nagłówek';
const LINK_URL = 'url';

/** Zmiana tekstu dla przycisku formatowania. `start`/`end` = zaznaczenie w polu (dowolna kolejność). */
export function markdownEdit(text: string, start: number, end: number, action: MarkdownAction): MarkdownTextEdit {
  const [s, e] = start <= end ? [start, end] : [end, start];
  const selected = text.slice(s, e);
  if (action === 'code' && selected.includes('\n')) return wrapBlock(text, s, e, '```\n', '\n```');
  const marker = INLINE[action];
  if (marker) return wrapInline(text, s, e, marker);
  if (action === 'link') return link(text, s, e);
  if (action === 'table') return insertBlock(text, s, e, TABLE_TEMPLATE, 2, 2 + TABLE_HEADER.length);
  if (action === 'rule') return insertBlock(text, s, e, '---', 3, 3);
  return toggleLines(text, s, e, LINE[action]!);
}

/** Długość ciągu znaku `ch` od `i` w kierunku `dir` (1 = w prawo, -1 = w lewo, zaczynając od `i - 1`). */
function run(text: string, i: number, ch: string, dir: 1 | -1): number {
  let n = 0;
  while (text[dir === 1 ? i + n : i - 1 - n] === ch) n++;
  return n;
}

/** Czy ciągi znaczników po obu stronach oznaczają ten styl (`*` kursywa = 1 lub 3 gwiazdki, `**` = co najmniej 2). */
function marked(before: number, after: number, marker: string): boolean {
  const both = Math.min(before, after);
  return marker === '*' ? both % 2 === 1 : both >= marker.length;
}

function wrapInline(text: string, s: number, e: number, marker: string): MarkdownTextEdit {
  const n = marker.length;
  const ch = marker[0]!;
  const inner = text.slice(s, e);
  // Zaznaczenie razem ze znacznikami → zdjęcie formatowania.
  if (inner.length > 2 * n && marked(run(inner, 0, ch, 1), run(inner, inner.length, ch, -1), marker)) {
    const body = inner.slice(n, inner.length - n);
    return { from: s, to: e, insert: body, selStart: s, selEnd: s + body.length };
  }
  // Znaczniki tuż obok zaznaczenia (albo kursora) → zdjęcie.
  if (marked(run(text, s, ch, -1), run(text, e, ch, 1), marker)) {
    return { from: s - n, to: e + n, insert: inner, selStart: s - n, selEnd: e - n };
  }
  // Spacje na brzegach zaznaczenia (dwuklik w słowo ze spacją) zostają poza znacznikami.
  const lead = inner.length - inner.trimStart().length;
  const trail = inner.length - inner.trimEnd().length;
  const core = inner.trim();
  if (!core) return { from: s, to: e, insert: `${inner}${marker}${marker}`, selStart: e + n, selEnd: e + n };
  const insert = `${inner.slice(0, lead)}${marker}${core}${marker}${inner.slice(inner.length - trail)}`;
  return { from: s, to: e, insert, selStart: s + lead + n, selEnd: s + lead + n + core.length };
}

function link(text: string, s: number, e: number): MarkdownTextEdit {
  const label = text.slice(s, e).trim();
  if (/^https?:\/\/\S+$/.test(label)) {
    // Zaznaczony adres → `[](adres)`, kursor w nawiasie na tekst linku.
    return { from: s, to: e, insert: `[](${label})`, selStart: s + 1, selEnd: s + 1 };
  }
  const insert = `[${label}](${LINK_URL})`;
  const urlAt = s + label.length + 3;
  return { from: s, to: e, insert, selStart: urlAt, selEnd: urlAt + LINK_URL.length };
}

function lineStart(text: string, i: number): number {
  return text.lastIndexOf('\n', i - 1) + 1;
}

function lineEnd(text: string, i: number): number {
  const at = text.indexOf('\n', i);
  return at === -1 ? text.length : at;
}

function toggleLines(text: string, s: number, e: number, rule: { match: RegExp; prefix: (i: number) => string }): MarkdownTextEdit {
  const from = lineStart(text, s);
  // Zaznaczenie kończące się na początku linii nie obejmuje tej linii.
  const to = lineEnd(text, e > s && text[e - 1] === '\n' ? e - 1 : e);
  const lines = text.slice(from, to).split('\n');
  const filled = lines.filter((l) => l.trim());
  const remove = filled.length > 0 && filled.every((l) => rule.match.test(l));
  let n = 0;
  const next = lines.map((l) => {
    if (remove) return l.replace(rule.match, '');
    if (!l.trim() && lines.length > 1) return l;
    return `${rule.prefix(n++)}${l.replace(ANY_LINE_MARK, '')}`;
  });
  const insert = next.join('\n');
  // Jedna linia bez zaznaczenia: kursor zostaje w tym samym miejscu tekstu; kilka — zaznaczony cały blok.
  if (s === e && lines.length === 1) {
    const at = Math.max(from, Math.min(from + insert.length, s + insert.length - (to - from)));
    return { from, to, insert, selStart: at, selEnd: at };
  }
  return { from, to, insert, selStart: from, selEnd: from + insert.length };
}

function wrapBlock(text: string, s: number, e: number, before: string, after: string): MarkdownTextEdit {
  const from = lineStart(text, s);
  const to = lineEnd(text, e > s && text[e - 1] === '\n' ? e - 1 : e);
  const body = text.slice(from, to);
  const fenced = /^```[^\n]*\n([\s\S]*)\n```$/.exec(body);
  if (fenced) return { from, to, insert: fenced[1]!, selStart: from, selEnd: from + fenced[1]!.length };
  const insert = `${before}${body}${after}`;
  return { from, to, insert, selStart: from + before.length, selEnd: from + before.length + body.length };
}

/** Blok w osobnych akapitach (pusta linia przed i po), wstawiony w miejsce zaznaczenia. */
function insertBlock(text: string, s: number, e: number, block: string, selFrom: number, selTo: number): MarkdownTextEdit {
  const before = text.slice(0, s);
  const after = text.slice(e);
  const lead = before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after === '' ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const insert = `${lead}${block}${trail}`;
  return { from: s, to: e, insert, selStart: s + lead.length + selFrom, selEnd: s + lead.length + selTo };
}

const LIST_LINE = /^(\s*)(?:([-*+]) \[[ xX]\] |([-*+]) |(\d{1,9})([.)]) |> ?)/;

/**
 * Enter w linii listy / cytatu (jak w GitLabie): nowa linia z kolejnym znacznikiem (`- `, `2. `, `- [ ] `,
 * `> `), a Enter w pustej pozycji kończy listę (zdejmuje znacznik). `null` = zwykły Enter.
 */
export function markdownContinueList(text: string, pos: number): MarkdownTextEdit | null {
  const from = lineStart(text, pos);
  const line = text.slice(from, lineEnd(text, pos));
  const m = LIST_LINE.exec(line);
  if (!m || pos < from + m[0].length) return null;
  if (!line.slice(m[0].length).trim()) {
    return { from, to: from + line.length, insert: '', selStart: from, selEnd: from };
  }
  const [, indent, taskMark, bullet, number, delim] = m;
  const mark = taskMark ? `${taskMark} [ ] ` : bullet ? `${bullet} ` : number ? `${Number(number) + 1}${delim} ` : '> ';
  const insert = `\n${indent}${mark}`;
  return { from: pos, to: pos, insert, selStart: pos + insert.length, selEnd: pos + insert.length };
}

/** Skrót klawiszowy (Ctrl/⌘ + litera) → przycisk formatowania. */
export const MARKDOWN_SHORTCUTS: Readonly<Record<string, MarkdownAction>> = { b: 'bold', i: 'italic', k: 'link' };
