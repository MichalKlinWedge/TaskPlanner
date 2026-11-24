/**
 * Podgląd opisu zadania (`description_md`) na telefonie: Markdown → bloki do narysowania
 * natywnymi komponentami. Podzbiór, który zapisuje edytor webu (TipTap + `@tiptap/markdown`):
 * nagłówki, akapity, listy (także zagnieżdżone i z polami `[ ]`/`[x]`), cytaty, bloki kodu, tabele GFM,
 * linia pozioma; w tekście pogrubienie, kursywa, przekreślenie, kod i linki. Tekst, którego
 * składnia nie obejmuje, zostaje dosłownie — nic nie znika z podglądu.
 */

export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
}

export interface MdListItem {
  spans: MdSpan[];
  /** Poziom zagnieżdżenia (0 = najwyżej). */
  depth: number;
  ordered: boolean;
  /** Numer pozycji listy numerowanej. */
  number?: number;
  /** Pole wyboru `- [ ]` / `- [x]`; brak = zwykła pozycja. */
  checked?: boolean;
  /** Numer linii źródła (odhaczanie pola w podglądzie zmienia tę linię). */
  line: number;
}

export type MdAlign = 'left' | 'center' | 'right';

export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; spans: MdSpan[] }
  | { kind: 'paragraph'; spans: MdSpan[] }
  | { kind: 'list'; items: MdListItem[] }
  | { kind: 'quote'; spans: MdSpan[] }
  | { kind: 'code'; text: string }
  /** Wiersze mają tyle komórek, ile nagłówek (brakujące puste, nadmiarowe odcięte — jak GFM). */
  | { kind: 'table'; align: (MdAlign | null)[]; header: MdSpan[][]; rows: MdSpan[][][] }
  | { kind: 'rule' };

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** Tekst w linii → fragmenty z formatowaniem (bez zagnieżdżania stylów w kodzie). */
export function parseInline(text: string): MdSpan[] {
  const out: MdSpan[] = [];
  const push = (span: MdSpan) => {
    if (!span.text) return;
    const last = out[out.length - 1];
    const plain = (s: MdSpan) => !s.bold && !s.italic && !s.strike && !s.code && !s.href;
    if (last && plain(last) && plain(span)) last.text += span.text;
    else out.push(span);
  };
  const walk = (src: string, style: Omit<MdSpan, 'text'>) => {
    let i = 0;
    let plain = '';
    const flush = () => {
      push({ ...style, text: plain });
      plain = '';
    };
    while (i < src.length) {
      const rest = src.slice(i);
      if (rest[0] === '\\' && rest.length > 1 && /[\\`*_~[\]()#!+\-.<>]/.test(rest[1]!)) {
        plain += rest[1];
        i += 2;
        continue;
      }
      let m: RegExpMatchArray | null;
      if ((m = rest.match(/^`([^`]+)`/))) {
        flush();
        push({ ...style, code: true, text: m[1]! });
      } else if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/))) {
        flush();
        walk(m[1]!, { ...style, href: m[2]! });
      } else if ((m = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/))) {
        flush();
        walk(m[2]!, { ...style, bold: true });
      } else if ((m = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/))) {
        flush();
        walk(m[1]!, { ...style, strike: true });
      } else if ((m = rest.match(/^(\*|_)(?=\S)([\s\S]*?\S)\1(?![*_])/)) && !(m[1] === '_' && /\w$/.test(plain))) {
        flush();
        walk(m[2]!, { ...style, italic: true });
      } else if ((m = rest.match(/^https?:\/\/[^\s<>()]+[^\s<>().,;:!?]/))) {
        flush();
        push({ ...style, href: m[0], text: m[0] });
      } else {
        plain += rest[0];
        i++;
        continue;
      }
      i += m[0].length;
    }
    flush();
  };
  walk(text, {});
  return out;
}

const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Komórki wiersza tabeli: podział na `|` (bez `\|`), skrajne kreski opcjonalne. */
function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  const text = line.trim().replace(/^\|/, '');
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (text[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += text[i];
  }
  if (cell.trim()) cells.push(cell.trim());
  return cells;
}

const cellAlign = (cell: string): MdAlign | null =>
  cell.startsWith(':') ? (cell.endsWith(':') && cell.length > 1 ? 'center' : 'left') : cell.endsWith(':') ? 'right' : null;

/** Tabela zaczynająca się w linii `n` (nagłówek + linia `---`) albo `null`; `next` — pierwsza linia za tabelą. */
function tableAt(lines: readonly string[], n: number): { block: MdBlock; next: number } | null {
  const head = lines[n]!;
  const delimiter = lines[n + 1];
  if (!head.includes('|') || !delimiter || !TABLE_DELIMITER.test(delimiter)) return null;
  const header = tableCells(head);
  const align = tableCells(delimiter).map(cellAlign);
  if (!header.length || header.length !== align.length) return null;
  const rows: MdSpan[][][] = [];
  let next = n + 2;
  for (; next < lines.length; next++) {
    const line = lines[next]!;
    if (!line.trim() || FENCE.test(line) || HEADING.test(line) || RULE.test(line) || LIST_ITEM.test(line) || /^\s*>/.test(line)) break;
    const cells = tableCells(line);
    rows.push(header.map((_, i) => parseInline(cells[i] ?? '')));
  }
  return { block: { kind: 'table', align, header: header.map(parseInline), rows }, next };
}

/** Markdown → bloki. Puste linie rozdzielają akapity; kolejne linie akapitu łączą się spacją. */
export function parseMarkdown(source: string | null | undefined): MdBlock[] {
  const lines = (source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let list: MdListItem[] | null = null;
  const indents: number[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join(' ')) });
    if (quote.length) blocks.push({ kind: 'quote', spans: parseInline(quote.join(' ')) });
    if (list) blocks.push({ kind: 'list', items: list });
    paragraph = [];
    quote = [];
    list = null;
    indents.length = 0;
  };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (FENCE.test(line)) {
      flush();
      const fence = line.trim().slice(0, 3);
      const code: string[] = [];
      while (++n < lines.length && !lines[n]!.trim().startsWith(fence)) code.push(lines[n]!);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1]!.length as 1, spans: parseInline(heading[2]!) });
      continue;
    }
    const table = tableAt(lines, n);
    if (table && !LIST_ITEM.test(line) && !/^\s*>/.test(line)) {
      flush();
      blocks.push(table.block);
      n = table.next - 1;
      continue;
    }
    if (RULE.test(line) && !paragraph.length) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }
    const item = line.match(LIST_ITEM);
    if (item) {
      if (!list) {
        flush();
        list = [];
      }
      const indent = item[1]!.replace(/\t/g, '    ').length;
      while (indents.length && indents[indents.length - 1]! > indent) indents.pop();
      if (!indents.length || indents[indents.length - 1]! < indent) indents.push(indent);
      const marker = item[2]!;
      const ordered = /\d/.test(marker);
      (list as MdListItem[]).push({
        spans: parseInline(item[4]!),
        depth: indents.length - 1,
        ordered,
        ...(ordered && { number: Number.parseInt(marker, 10) }),
        ...(item[3] !== undefined && { checked: item[3] !== ' ' }),
        line: n,
      });
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      // Dalszy ciąg pozycji listy (wcięta linia).
      const last = (list as MdListItem[])[(list as MdListItem[]).length - 1]!;
      last.spans = parseInline(`${spansText(last.spans)} ${line.trim()}`);
      continue;
    }
    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) {
      if (!quote.length) flush();
      quote.push(quoted[1]!);
      continue;
    }
    if (list || quote.length) flush();
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** Tekst bez formatowania (np. pierwsza linia opisu pod tytułem). */
export const spansText = (spans: readonly MdSpan[]): string => spans.map((s) => s.text).join('');

/** Odhaczenie pola `[ ]` w linii `line` źródła (podgląd opisu); inna linia — bez zmian. */
export function toggleMarkdownCheckbox(source: string, line: number): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const current = lines[line];
  if (current === undefined) return source;
  lines[line] = current.replace(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/, (_, head: string, mark: string) => `${head}[${mark === ' ' ? 'x' : ' '}]`);
  return lines.join('\n');
}
