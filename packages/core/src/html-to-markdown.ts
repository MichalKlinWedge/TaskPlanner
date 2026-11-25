/**
 * Wklejanie z formatowaniem do opisu zadania: HTML ze schowka (przeglądarka, Word, Google Docs, Excel, poczta)
 * → Markdown w składni z `markdown.ts`. Próba, nie wierne odwzorowanie: zostają nagłówki, pogrubienie, kursywa,
 * przekreślenie, kod, linki, listy (też zagnieżdżone, z polami wyboru i z Worda), cytaty, tabele i linie;
 * kolory, czcionki i obrazy bez opisu odpadają. Własny mały parser HTML (bez DOM) — działa tak samo wszędzie.
 */

export interface PastedMarkdown {
  markdown: string;
  /** Jest co zachować: cokolwiek poza zwykłymi akapitami tekstu. */
  formatted: boolean;
  /** Jedna linia bez bloków — do wstawienia w środku zdania. */
  inline: boolean;
}

/** Większego HTML nie próbujemy zamieniać (np. cały arkusz). */
export const PASTE_HTML_MAX = 2_000_000;

// ---------------------------------------------------------------- parser HTML

interface El {
  tag: string;
  attrs: Record<string, string>;
  css: Record<string, string>;
  children: HtmlNode[];
}
type HtmlNode = string | El;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Treść tych znaczników nie jest HTML — pomijana w całości. */
const RAW = new Set(['script', 'style', 'title', 'textarea', 'noscript', 'iframe', 'template', 'xml']);
const SKIP = new Set(['head', 'svg', 'math', 'button', 'select', 'object', 'audio', 'video', 'canvas']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'ul',
]);
/** Otwarcie znacznika zamyka otwarty wcześniej (`<li>` bez `</li>` itd.); drugi element = granica szukania. */
const IMPLIED_END: Readonly<Record<string, { close: readonly string[]; until: readonly string[] }>> = {
  li: { close: ['li'], until: ['ul', 'ol'] },
  dt: { close: ['dt', 'dd'], until: ['dl'] },
  dd: { close: ['dt', 'dd'], until: ['dl'] },
  tr: { close: ['tr'], until: ['table'] },
  td: { close: ['td', 'th'], until: ['tr', 'table'] },
  th: { close: ['td', 'th'], until: ['tr', 'table'] },
  tbody: { close: ['thead', 'tbody', 'tfoot'], until: ['table'] },
  tfoot: { close: ['thead', 'tbody', 'tfoot'], until: ['table'] },
};
const TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '', zwnj: '', zwj: '‍',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“',
  rdquo: '”', bdquo: '„', copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½', frac14: '¼',
  frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', para: '¶', sect: '§', euro: '€', pound: '£', cent: '¢', yen: '¥', larr: '←', rarr: '→',
  uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', le: '≤', ge: '≥', ne: '≠', asymp: '≈', oacute: 'ó', Oacute: 'Ó', eacute: 'é', Eacute: 'É',
  aacute: 'á', iacute: 'í', uacute: 'ú', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', egrave: 'è',
  agrave: 'à', ccedil: 'ç', ntilde: 'ñ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([a-zA-Z][a-zA-Z\d]{1,9}));?/g, (whole, dec?: string, hex?: string, name?: string) => {
    if (name) return (whole.endsWith(';') || name === 'nbsp' || name === 'amp' ? ENTITIES[name] : undefined) ?? whole;
    const code = dec ? Number(dec) : Number.parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function parseAttrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g)) {
    out[m[1]!.toLowerCase()] ??= decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

function parseCss(source: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of source?.split(';') ?? []) {
    const at = rule.indexOf(':');
    if (at > 0) out[rule.slice(0, at).trim().toLowerCase()] = rule.slice(at + 1).trim().toLowerCase();
  }
  return out;
}

const OPEN_TAG = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/y;
const CLOSE_TAG = /<\/([a-zA-Z][^\s>]*)[^>]*>/y;

function parseHtml(html: string): El {
  const root: El = { tag: '#root', attrs: {}, css: {}, children: [] };
  const stack: El[] = [root];
  const top = () => stack[stack.length - 1]!;
  /** Zamyka najbliższy otwarty `tags`, nie przechodząc przez `until`. */
  const close = (tags: (tag: string) => boolean, until: (tag: string) => boolean) => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (tags(stack[k]!.tag)) {
        stack.length = k;
        return;
      }
      if (until(stack[k]!.tag)) return;
    }
  };
  let i = 0;
  while (i < html.length) {
    if (html[i] !== '<') {
      const next = html.indexOf('<', i);
      const end = next === -1 ? html.length : next;
      top().children.push(decodeEntities(html.slice(i, end)));
      i = end;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    CLOSE_TAG.lastIndex = i;
    const closing = CLOSE_TAG.exec(html);
    if (closing) {
      const tag = closing[1]!.toLowerCase();
      close((t) => t === tag, (t) => !TABLE_TAGS.has(tag) && TABLE_TAGS.has(t));
      i += closing[0].length;
      continue;
    }
    OPEN_TAG.lastIndex = i;
    const opening = OPEN_TAG.exec(html);
    if (!opening) {
      top().children.push('<');
      i++;
      continue;
    }
    i += opening[0].length;
    const tag = opening[1]!.toLowerCase();
    if (RAW.has(tag)) {
      const end = html.slice(i).search(new RegExp(`</${tag}\\s*>`, 'i'));
      if (end === -1) break;
      i = html.indexOf('>', i + end) + 1;
      continue;
    }
    if (tag === 'body') close((t) => t === 'head', () => false);
    if (BLOCK.has(tag)) close((t) => t === 'p', (t) => BLOCK.has(t) || TABLE_TAGS.has(t));
    const implied = IMPLIED_END[tag];
    if (implied) close((t) => implied.close.includes(t), (t) => implied.until.includes(t));
    const attrs = parseAttrs(opening[2]!);
    const el: El = { tag, attrs, css: parseCss(attrs.style), children: [] };
    top().children.push(el);
    if (!VOID.has(tag) && !opening[2]!.endsWith('/')) stack.push(el);
  }
  return root;
}

// ---------------------------------------------------------------- drzewo → bloki

interface Style {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
  /** Zachowane łamanie wierszy (`white-space: pre…`). */
  pre?: boolean;
}

interface Span extends Style {
  text: string;
  br?: boolean;
}

interface Item {
  ordered: boolean;
  number?: number;
  checked?: boolean;
  blocks: Block[];
}

type Block =
  /** `soft` — linia z `<div>` (poczta): sąsiednie łączy złamanie wiersza, nie pusta linia. */
  | { kind: 'para'; spans: Span[]; soft: boolean }
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'code'; text: string; lang: string }
  | { kind: 'list'; items: Item[] }
  /** Pozycja listy zapisana jako akapit (Word, „• tekst”) — sąsiednie składa `nestFlat`. */
  | { kind: 'flat'; level: number; item: Item }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'table'; rows: Span[][][] }
  | { kind: 'rule' }
  | { kind: 'gap' };

const SAFE_HREF = /^(?:https?:\/\/|mailto:|tel:)/i;
const MONO = /mono|consolas|courier|menlo/;
const BULLET = /^\s*([•●▪■◦○‣·☐☑☒])\s+/;
const CHECKBOX: Readonly<Record<string, boolean>> = { '☐': false, '☑': true, '☒': true };

const isBlock = (el: El) => BLOCK.has(el.tag) || TABLE_TAGS.has(el.tag);
const hidden = (el: El) => SKIP.has(el.tag) || el.css.display === 'none' || el.css['mso-hide'] === 'all' || /ignore/.test(el.css['mso-list'] ?? '');

function elements(node: El, match: (el: El) => boolean, into: El[] = []): El[] {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (match(child)) into.push(child);
    elements(child, match, into);
  }
  return into;
}

const plainText = (node: HtmlNode): string => (typeof node === 'string' ? node : node.children.map(plainText).join(''));

/** Tekst bloku kodu: wiersze z `<br>` i z bloków w środku (VS Code = `<div>` na linię). */
function codeText(node: El): string {
  let out = '';
  const walk = (n: HtmlNode) => {
    if (typeof n === 'string') {
      out += n.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
      return;
    }
    if (SKIP.has(n.tag)) return;
    if (n.tag === 'br') {
      out += '\n';
      return;
    }
    const block = isBlock(n);
    if (block && out && !out.endsWith('\n')) out += '\n';
    n.children.forEach(walk);
    // Pusta linia kodu (`<div></div>` albo `<div><br></div>`) zostaje pusta, a treść bloku kończy wiersz.
    if (block && n !== node && !out.endsWith('\n')) out += '\n';
  };
  walk(node);
  return out.replace(/^\n/, '').replace(/\s+$/, '');
}

function styleOf(el: El, parent: Style): Style {
  const style = { ...parent };
  const { tag, css, attrs } = el;
  if (tag === 'b' || tag === 'strong') style.bold = true;
  else if (tag === 'i' || tag === 'em') style.italic = true;
  else if (tag === 's' || tag === 'del' || tag === 'strike') style.strike = true;
  else if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') style.code = true;
  else if (tag === 'a' && SAFE_HREF.test(attrs.href?.trim() ?? '')) style.href = attrs.href!.trim();
  const weight = css['font-weight'];
  if (weight && /^(?:bold|bolder|[6-9]00)/.test(weight)) style.bold = true;
  // Google Docs owija całość w `<b style="font-weight:normal">`.
  else if (weight && /^(?:normal|lighter|[1-5]00)/.test(weight)) style.bold = false;
  const slant = css['font-style'];
  if (slant) style.italic = /^(?:italic|oblique)/.test(slant);
  if (/line-through/.test(`${css['text-decoration'] ?? ''} ${css['text-decoration-line'] ?? ''}`)) style.strike = true;
  const space = css['white-space'];
  if (space) style.pre = space.startsWith('pre') || space === 'break-spaces';
  return style;
}

/** Przycina spacje i puste wiersze na końcach. */
function trimSpans(spans: readonly Span[]): Span[] {
  const out = spans.map((s) => ({ ...s }));
  while (out.length && (out[0]!.br || !out[0]!.text.trim())) out.shift();
  while (out.length && (out[out.length - 1]!.br || !out[out.length - 1]!.text.trim())) out.pop();
  if (out.length) {
    out[0]!.text = out[0]!.text.trimStart();
    out[out.length - 1]!.text = out[out.length - 1]!.text.trimEnd();
  }
  return out;
}

const splitLines = (spans: readonly Span[]): Span[][] => {
  const lines: Span[][] = [[]];
  for (const s of spans) {
    if (s.br) lines.push([]);
    else lines[lines.length - 1]!.push(s);
  }
  return lines;
};

const spansText = (spans: readonly Span[]) => spans.map((s) => (s.br ? ' ' : s.text)).join('');
const joinLines = (lines: readonly Span[][]): Span[] => lines.flatMap((line, i) => (i ? [{ text: '', br: true }, ...line] : line));

/** Akapity z fragmentów: pusty wiersz (`<br><br>`) dzieli, wiersz „• tekst” jest pozycją listy. */
function paragraphs(spans: readonly Span[], soft: boolean): Block[] {
  const out: Block[] = [];
  let lines: Span[][] = [];
  const flush = () => {
    const trimmed = trimSpans(joinLines(lines));
    if (trimmed.length) out.push({ kind: 'para', spans: trimmed, soft });
    lines = [];
  };
  for (const raw of splitLines(trimSpans(spans))) {
    const line = trimSpans(raw);
    const bullet = BULLET.exec(spansText(line));
    if (!line.length) {
      flush();
      if (out.length) out.push({ kind: 'gap' });
    } else if (bullet) {
      flush();
      out.push({ kind: 'flat', level: 1, item: { ordered: false, checked: CHECKBOX[bullet[1]!], blocks: [{ kind: 'para', spans: cut(line, bullet[0].length), soft: false }] } });
    } else lines.push(line);
  }
  flush();
  return out;
}

/** Fragmenty bez pierwszych `count` znaków. */
function cut(spans: readonly Span[], count: number): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const drop = Math.min(count, s.text.length);
    count -= drop;
    if (s.br || drop < s.text.length) out.push({ ...s, text: s.text.slice(drop) });
  }
  return trimSpans(out);
}

function collect(nodes: readonly HtmlNode[], base: Style, softRoot = false): Block[] {
  const blocks: Block[] = [];
  let spans: Span[] = [];
  const flush = (soft: boolean) => {
    blocks.push(...paragraphs(spans, soft));
    spans = [];
  };
  const text = (value: string, style: Style) => {
    const clean = value.replace(/[​﻿­]/g, '');
    if (style.pre) {
      clean.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
        if (i) spans.push({ text: '', br: true });
        if (line) spans.push({ ...style, text: line.replace(/[\t ]/g, ' ') });
      });
      return;
    }
    const collapsed = clean.replace(/[\s ]+/g, ' ');
    const last = spans[spans.length - 1];
    const value2 = !last || last.br || last.text.endsWith(' ') ? collapsed.trimStart() : collapsed;
    if (value2) spans.push({ ...style, text: value2 });
  };
  const walk = (node: HtmlNode, style: Style, soft: boolean): void => {
    if (typeof node === 'string') return text(node, style);
    if (hidden(node)) return;
    const { tag, attrs, css } = node;
    if (tag === 'br') {
      spans.push({ text: '', br: true });
      return;
    }
    if (tag === 'img') return image(node, style);
    if (tag === 'input') return;
    const own = styleOf(node, style);
    if (!isBlock(node) && css.display !== 'block') {
      const level = attrs.role === 'heading' ? Number(attrs['aria-level'] ?? 2) : 0;
      if (level) return heading(node, style, level, soft);
      node.children.forEach((c) => walk(c, own, soft));
      return;
    }

    flush(soft);
    if (tag === 'hr') blocks.push({ kind: 'rule' });
    else if (/^h[1-6]$/.test(tag)) heading(node, style, Number(tag[1]), soft);
    else if (attrs.role === 'heading') heading(node, style, Number(attrs['aria-level'] ?? 2), soft);
    else if (/\bMsoTitle\b/.test(attrs.class ?? '')) heading(node, style, 1, soft);
    else if (tag === 'pre' || (css['white-space'] === 'pre' && MONO.test(css['font-family'] ?? ''))) {
      const code = codeText(node);
      const lang = /\blang(?:uage)?-([\w+#-]+)/.exec([node, ...elements(node, (e) => e.tag === 'code')].map((e) => e.attrs.class ?? '').join(' '));
      if (code && tag !== 'pre' && !code.includes('\n')) blocks.push({ kind: 'para', spans: [{ text: code.trim(), code: true }], soft: false });
      else if (code) blocks.push({ kind: 'code', text: code, lang: lang?.[1] ?? '' });
    } else if (tag === 'ul' || tag === 'ol') {
      const items = listItems(node, own);
      if (items.length) blocks.push({ kind: 'list', items });
    } else if (tag === 'li') {
      // Pozycja bez listy (zaznaczony kawałek).
      blocks.push({ kind: 'flat', level: 1, item: listItem(node, own, false) });
    } else if (tag === 'blockquote') {
      const inner = collect(node.children, own);
      if (inner.length) blocks.push({ kind: 'quote', blocks: inner });
    } else if (tag === 'table') table(node, own);
    else {
      const word = /\blevel(\d)/.exec(css['mso-list'] ?? '');
      if (word) {
        const marker = elements(node, (e) => /ignore/.test(e.css['mso-list'] ?? '')).map(plainText).join('').trim();
        const ordered = /^\(?(?:\d+|[a-zA-Z]{1,4})[.)]/.test(marker);
        const inner = trimSpans(collect(node.children, own).flatMap(blockSpans));
        const number = Number.parseInt(marker, 10);
        if (inner.length) blocks.push({ kind: 'flat', level: Number(word[1]), item: { ordered, ...(number > 0 && { number }), blocks: [{ kind: 'para', spans: inner, soft: false }] } });
        return;
      }
      const isSoft = tag === 'div' || tag === 'span';
      const before = blocks.length;
      node.children.forEach((c) => walk(c, own, isSoft));
      flush(isSoft);
      if (blocks.length === before && before && isSoft && !node.children.some((c) => typeof c !== 'string' && isBlock(c))) blocks.push({ kind: 'gap' });
    }
  };
  const heading = (node: El, style: Style, level: number, soft: boolean) => {
    flush(soft);
    const inner = trimSpans(collect(node.children, { ...style }).flatMap(blockSpans)).map((s): Span => ({ ...s, bold: false, text: s.br ? ' ' : s.text, br: false }));
    if (inner.length) blocks.push({ kind: 'heading', level: Math.min(6, Math.max(1, level || 2)), spans: inner });
  };
  const image = (node: El, style: Style) => {
    const alt = (node.attrs.alt ?? '').replace(/\s+/g, ' ').trim();
    if (!alt) return;
    // Emotikona jako obrazek (Slack, Teams) albo obrazek w linku → sam tekst; zwykły obrazek → link do niego.
    const src = node.attrs.src?.trim() ?? '';
    if (style.href || [...alt].length <= 2) spans.push({ ...style, text: alt });
    else if (/^https?:\/\//i.test(src)) spans.push({ ...style, text: alt, href: src });
  };
  const listItems = (node: El, style: Style): Item[] => {
    const items: Item[] = [];
    const ordered = node.tag === 'ol';
    for (const child of node.children) {
      if (typeof child === 'string') {
        if (child.trim()) items.push({ ordered, blocks: paragraphs([{ ...style, text: child.replace(/[\s ]+/g, ' ') }], false) });
        continue;
      }
      if (hidden(child)) continue;
      if (child.tag === 'ul' || child.tag === 'ol') {
        // Lista wprost w liście (Google Docs) = zagnieżdżenie pod poprzednią pozycją.
        const nested = listItems(child, styleOf(child, style));
        const last = items[items.length - 1];
        if (last && nested.length) last.blocks.push({ kind: 'list', items: nested });
        else items.push(...nested);
        continue;
      }
      const item = listItem(child, styleOf(child, style), ordered);
      // Sama lista w pustej pozycji (zaznaczenie od środka) — bez zbędnego poziomu.
      if (item.blocks.length && item.blocks.every((b) => b.kind === 'list')) items.push(...item.blocks.flatMap((b) => (b.kind === 'list' ? b.items : [])));
      else if (item.blocks.some((b) => b.kind !== 'gap')) items.push(item);
    }
    const start = Number.parseInt(node.attrs.start ?? '', 10);
    if (ordered && start > 0 && items[0]) items[0].number = start;
    return items;
  };
  const listItem = (node: El, style: Style, ordered: boolean): Item => {
    const item: Item = { ordered, blocks: collect(node.children, style).filter((b) => b.kind !== 'gap') };
    const box = elements(node, (e) => e.tag === 'li' || (e.tag === 'input' && e.attrs.type === 'checkbox')).find((e, _i, all) => all[0] === e && e.tag === 'input');
    if (box) item.checked = 'checked' in box.attrs || box.attrs['aria-checked'] === 'true';
    else if (node.attrs.role === 'checkbox') item.checked = node.attrs['aria-checked'] === 'true';
    else if (node.attrs['data-checked'] !== undefined) item.checked = node.attrs['data-checked'] === 'true';
    const first = item.blocks[0];
    // „☐ tekst” w pozycji listy — znak stał się osobną pozycją `flat`.
    if (first?.kind === 'flat') {
      item.checked ??= first.item.checked;
      item.blocks.splice(0, 1, ...first.item.blocks);
    }
    return item;
  };
  const table = (node: El, style: Style) => {
    const ownRows = elements(node, (e) => e.tag === 'tr').filter((tr) => !elements(node, (e) => e.tag === 'table').some((t) => elements(t, (e) => e === tr).length));
    const cellsOf = (tr: El) => tr.children.filter((c): c is El => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th') && !hidden(c));
    const single = ownRows.every((tr) => cellsOf(tr).length <= 1);
    if (single || elements(node, (e) => e.tag === 'table').length) {
      // Tabela dla układu strony (jedna kolumna, tabela w tabeli) — same bloki.
      for (const tr of ownRows) for (const cell of cellsOf(tr)) blocks.push(...collect(cell.children, style));
      return;
    }
    const rows: Span[][][] = [];
    const busy: number[] = [];
    for (const tr of ownRows) {
      const row: Span[][] = [];
      const fill = () => {
        while ((busy[row.length] ?? 0) > 0) {
          busy[row.length]!--;
          row.push([]);
        }
      };
      for (const cell of cellsOf(tr)) {
        fill();
        const cols = Math.min(50, Math.max(1, Number.parseInt(cell.attrs.colspan ?? '1', 10) || 1));
        const down = Math.max(1, Number.parseInt(cell.attrs.rowspan ?? '1', 10) || 1);
        const content = trimSpans(collect(cell.children, styleOf(cell, styleOf(tr, style))).flatMap(blockSpans));
        for (let c = 0; c < cols; c++) {
          busy[row.length] = down - 1;
          row.push(c === 0 ? content : []);
        }
      }
      fill();
      if (row.some((c) => c.length)) rows.push(row);
    }
    if (rows.length) blocks.push({ kind: 'table', rows });
  };

  nodes.forEach((n) => walk(n, base, softRoot));
  flush(softRoot);
  return nestFlat(blocks);
}

/** Zawartość bloku jako jeden ciąg (komórka tabeli, nagłówek): bloki rozdziela spacja. */
function blockSpans(block: Block): Span[] {
  const space: Span = { text: ' ' };
  const spaced = (list: Span[][]): Span[] => list.flatMap((s, i) => (i ? [space, ...s] : s));
  switch (block.kind) {
    case 'para':
    case 'heading':
      return [...block.spans, space];
    case 'code':
      return [{ text: block.text.replace(/\s+/g, ' '), code: true }, space];
    case 'list':
      return spaced(block.items.flatMap((i) => i.blocks.map(blockSpans)));
    case 'flat':
      return spaced(block.item.blocks.map(blockSpans));
    case 'quote':
      return spaced(block.blocks.map(blockSpans));
    case 'table':
      return spaced(block.rows.flat());
    default:
      return [];
  }
}

/** Sąsiednie pozycje `flat` → lista zagnieżdżona według poziomu. */
function nestFlat(blocks: readonly Block[]): Block[] {
  const out: Block[] = [];
  let path: { level: number; items: Item[] }[] = [];
  blocks.forEach((block, i) => {
    if (block.kind === 'gap' && path.length && blocks[i + 1]?.kind === 'flat') return;
    if (block.kind !== 'flat') {
      path = [];
      out.push(block);
      return;
    }
    while (path.length > 1 && path[path.length - 1]!.level > block.level) path.pop();
    const here = path[path.length - 1];
    if (here && block.level > here.level && here.items.length) {
      const items = [block.item];
      here.items[here.items.length - 1]!.blocks.push({ kind: 'list', items });
      path.push({ level: block.level, items });
    } else if (here) here.items.push(block.item);
    else {
      const items = [block.item];
      out.push({ kind: 'list', items });
      path = [{ level: block.level, items }];
    }
  });
  return out;
}

// ---------------------------------------------------------------- bloki → Markdown

const URL_SPLIT = /(https?:\/\/[^\s<>()]+)/;

/** Znaki, które w Markdown zmieniłyby zwykły tekst w formatowanie (adresy zostają bez zmian). */
function escapeText(text: string): string {
  return text
    .split(URL_SPLIT)
    .map((part, i) => {
      if (i % 2) return part;
      const word = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
      const blank = (c: string | undefined) => c !== undefined && /\s/.test(c);
      const tildes = part.split('~').length > 2;
      return part.replace(/[\\`*_~<&[]/g, (c, at: number) => {
        const prev = part[at - 1];
        const next = part[at + 1];
        const rest = part.slice(at);
        const escape =
          c === '\\' ? next !== undefined && /[!-/:-@[-`{-~]/.test(next)
          : c === '`' ? true
          : c === '*' ? !(blank(prev) && blank(next))
          : c === '_' ? !(word(prev) && word(next)) && !(blank(prev) && blank(next))
          : c === '~' ? tildes
          : c === '<' ? /^<[a-zA-Z/!?]/.test(rest)
          : c === '&' ? /^&(?:#\w+|[a-zA-Z]\w*);/.test(rest)
          : /^\[[^\]]*\]\(/.test(rest);
        return escape ? `\\${c}` : c;
      });
    })
    .join('');
}

/** Początek linii, który Markdown wziąłby za nagłówek, listę, cytat albo linię. */
const escapeLineStart = (line: string): string =>
  line
    .replace(/^(#{1,6})(?=\s|$)/, '\\$1')
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^([-+*])(?=\s|$)/, '\\$1')
    .replace(/^(-{3,})$/, '\\$1')
    .replace(/^>/, '\\>');

type Mark = 'href' | 'bold' | 'italic' | 'strike' | 'code';
const MARKS: readonly Mark[] = ['href', 'bold', 'italic', 'strike', 'code'];
const MARKER: Readonly<Partial<Record<Mark, string>>> = { bold: '**', italic: '*', strike: '~~' };

interface Output {
  formatted: boolean;
}

/** Fragmenty jednej linii → tekst; kolejne style od zewnątrz, spacje i interpunkcja z brzegów poza znacznikami. */
function renderSpans(spans: readonly Span[], out: Output, marks: readonly Mark[] = MARKS): string {
  const mark = marks[0];
  if (!mark) return escapeText(spans.map((s) => s.text).join(''));
  const rest = marks.slice(1);
  let text = '';
  for (let i = 0; i < spans.length; ) {
    const value = spans[i]![mark] || undefined;
    let j = i + 1;
    while (j < spans.length && ((spans[j]![mark] || undefined) === value || (value && mark !== 'href' && !spans[j]!.text.trim() && spans[j + 1]?.[mark] === value))) j++;
    const group = spans.slice(i, j);
    i = j;
    if (!value) {
      text += renderSpans(group, out, rest);
      continue;
    }
    const raw = group.map((s) => s.text).join('');
    const lead = raw.slice(0, raw.length - raw.trimStart().length);
    const trail = raw.trim() ? raw.slice(raw.trimEnd().length) : '';
    const inner = raw.trim();
    if (!inner) {
      text += raw;
      continue;
    }
    if (mark === 'code') {
      out.formatted = true;
      text += inner.includes('`') ? `${lead}\`\` ${inner} \`\`${trail}` : `${lead}\`${inner}\`${trail}`;
    } else if (mark === 'href') {
      text += lead + renderLink(trimSpans(group), inner, value as string, rest, out) + trail;
    } else {
      out.formatted = true;
      // `**tekst:**dalej` nie zamyka się w CommonMark — interpunkcja przed znakiem słowa wychodzi za znacznik.
      const after = spans[j]?.text[0];
      const punct = after && /[\p{L}\p{N}]/u.test(after) && !trail ? (/[.,:;!?…]+$/.exec(inner)?.[0] ?? '') : '';
      const kept = punct.length < inner.length ? punct.length : 0;
      const body = kept ? trimEndSpans(trimSpans(group), kept) : trimSpans(group);
      text += `${lead}${MARKER[mark]}${renderSpans(body, out, rest)}${MARKER[mark]}${kept ? punct : ''}${trail}`;
    }
  }
  return text;
}

function trimEndSpans(spans: Span[], count: number): Span[] {
  const out = [...spans];
  while (count > 0 && out.length) {
    const last = out.pop()!;
    const keep = Math.max(0, last.text.length - count);
    count -= last.text.length - keep;
    if (keep) out.push({ ...last, text: last.text.slice(0, keep) });
  }
  return out;
}

function renderLink(group: Span[], text: string, href: string, rest: readonly Mark[], out: Output): string {
  const url = href.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  const bare = (s: string) => s.replace(/^(?:https?:\/\/|mailto:|tel:)/i, '').replace(/\/$/, '');
  // Goły adres i tak jest linkiem (jak `descriptionMarkdown` w edytorze webu).
  if (bare(text) === bare(href)) return /^https?:/i.test(href) ? url : escapeText(text);
  out.formatted = true;
  const label = group.map((s) => ({ ...s, text: s.text.replace(/\[/g, '(').replace(/\]/g, ')') }));
  return `[${renderSpans(label, out, rest)}](${url})`;
}

const renderLines = (spans: readonly Span[], out: Output): string =>
  splitLines(spans)
    .map((line) => escapeLineStart(renderSpans(trimSpans(line), out)))
    .join('  \n');

function renderList(items: readonly Item[], out: Output): string {
  let number = 0;
  return items
    .map((item) => {
      number = item.ordered ? (number === 0 && item.number ? item.number : number + 1) : 0;
      const bullet = item.ordered ? `${number}. ` : '- ';
      const mark = item.checked === undefined ? bullet : `${bullet}[${item.checked ? 'x' : ' '}] `;
      const pad = ' '.repeat(bullet.length);
      const body = renderBlocks(item.blocks, out, true).split('\n');
      return body.map((line, i) => (i === 0 ? mark + line : line && pad + line)).join('\n');
    })
    .join('\n');
}

function renderTable(rows: readonly Span[][][], out: Output): string {
  const width = Math.max(...rows.map((r) => r.length));
  const line = (row: readonly Span[][], header: boolean) =>
    `| ${Array.from({ length: width }, (_, c) => {
      const spans = (row[c] ?? []).map((s): Span => (s.br ? { text: ' ' } : header ? { ...s, bold: false } : s));
      return renderSpans(spans, out).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
    }).join(' | ')} |`;
  const [head, ...body] = rows;
  return [line(head!, true), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map((r) => line(r, false))].join('\n');
}

function renderBlock(block: Block, out: Output, tight: boolean): string {
  if (block.kind !== 'para') out.formatted = true;
  switch (block.kind) {
    case 'para':
      return renderLines(block.spans, out);
    case 'heading':
      // Nagłówek w pozycji listy zostaje pogrubieniem.
      return tight ? renderLines(block.spans.map((s) => ({ ...s, bold: true })), out) : `${'#'.repeat(block.level)} ${renderSpans(block.spans, out)}`;
    case 'code': {
      const longest = Math.max(2, ...(block.text.match(/`+/g) ?? []).map((m) => m.length));
      const fence = '`'.repeat(longest >= 3 ? longest + 1 : 3);
      return `${fence}${block.lang}\n${block.text}\n${fence}`;
    }
    case 'list':
      return renderList(block.items, out);
    case 'quote':
      return renderBlocks(block.blocks, out, false)
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'table':
      return renderTable(block.rows, out);
    case 'rule':
      return '---';
    default:
      return '';
  }
}

function renderBlocks(blocks: readonly Block[], out: Output, tight: boolean): string {
  let text = '';
  let prev: Block | null = null;
  let gap = false;
  for (const block of blocks) {
    if (block.kind === 'gap') {
      gap = true;
      continue;
    }
    const value = renderBlock(block, out, tight);
    if (!value.trim()) continue;
    if (prev) {
      const lines = block.kind === 'para' && prev.kind === 'para' && (tight || (prev.soft && block.soft && !gap));
      text += lines ? '  \n' : tight ? '\n' : '\n\n';
    }
    text += value;
    prev = block;
    gap = false;
  }
  return text;
}

/** HTML ze schowka → Markdown; `null`, gdy nie ma treści (np. sam obraz) albo HTML jest za duży. */
export function htmlToMarkdown(html: string): PastedMarkdown | null {
  if (html.length > PASTE_HTML_MAX) return null;
  const blocks = collect(parseHtml(html).children, {});
  const out: Output = { formatted: false };
  const markdown = renderBlocks(blocks, out, false).trim();
  if (!markdown) return null;
  const inline = !markdown.includes('\n') && blocks.filter((b) => b.kind !== 'gap').every((b) => b.kind === 'para');
  return { markdown, formatted: out.formatted, inline };
}
