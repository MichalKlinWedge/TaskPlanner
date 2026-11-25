/**
 * Wycinek strony z zakładki „+ Task Planner” (v1.x): kod zakładki, format części `#` adresu i cytat w opisie.
 *
 * Zakładka otwiera `/#share?title=…&url=…&selection=…` (zaznaczenie) albo `…&page=…` (bez zaznaczenia: widoczny
 * tekst strony). Część `#` nie idzie do serwera ani do jego logów. Zaznaczenie trafia do opisu jako cytat ze źródłem;
 * tekst całej strony służy tylko do streszczenia i sam nie jest nigdzie zapisywany. Treść pochodzi z obcej strony:
 * to zwykły tekst, a znaki, które w Markdown dałyby HTML, link albo obrazek, są zasłonięte.
 */
import { parseHttpUrl } from './attachments.ts';

/** Najwięcej znaków zaznaczenia / tekstu strony (zakładka przycina, aplikacja sprawdza ponownie). */
export const WEB_CLIP_MAX = 8_000;
/** Najdłuższy opis z okna szybkiego dodawania (znaki). */
export const CLIP_DESCRIPTION_MAX = 20_000;
const MAX_TITLE = 500;
const MAX_URL = 2_000;
/** Krótszy `article` / `main` to nie treść strony, tylko np. nagłówek albo okienko. */
const MIN_MAIN = 200;
const PREFIX = '#share?';

export interface WebClip {
  title: string;
  /** Adres `http(s)` strony albo `null`. */
  url: string | null;
  /** Zaznaczony tekst; puste = nic nie zaznaczono. */
  selection: string;
  /** Widoczny tekst strony — tylko bez zaznaczenia. */
  page: string;
}

/**
 * Kod zakładki. Bez `%` i `#` (przeglądarka dekoduje adres `javascript:`), bez wywołań sieciowych; treść idzie tylko
 * w części `#`. `URLSearchParams` zamiast `encodeURIComponent` — ten rzuca wyjątek na uciętej połówce emoji.
 */
export const bookmarkletCode = (origin: string): string =>
  [
    'javascript:(()=>{',
    `const c=t=>(t||'').replace(/[ \\t\\xa0]+/g,' ').replace(/ ?\\r?\\n ?/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim().slice(0,${WEB_CLIP_MAX});`,
    `const d=document,s=c(String(window.getSelection()||''));let p='';`,
    `if(!s){const a=d.querySelectorAll('article');`,
    `for(const e of [a.length===1?a[0]:null,d.querySelector('main'),d.body]){if(e){p=c(e.innerText);if(p.length>=${MIN_MAIN})break}}}`,
    `const q=new URLSearchParams({title:d.title,url:location.href});`,
    `if(s)q.set('selection',s);else if(p)q.set('page',p);`,
    `window.open('${origin}/\\x23share?'+q,'_blank','noopener')})()`,
  ].join('');

/** Czy część `#` adresu niesie wycinek (także uszkodzony) — do usunięcia z adresu i z dziennika błędów. */
export const isWebClipHash = (hash: string): boolean => hash.startsWith(PREFIX);

/** Część `#` adresu → wycinek; inna trasa albo pusty wycinek = `null`. */
export function parseWebClip(hash: string): WebClip | null {
  if (!isWebClipHash(hash)) return null;
  const params = new URLSearchParams(hash.slice(PREFIX.length));
  const address = (params.get('url') ?? '').trim();
  const selection = plainText(params.get('selection'), WEB_CLIP_MAX);
  const result: WebClip = {
    title: oneLine(params.get('title'), MAX_TITLE),
    url: address.length <= MAX_URL && parseHttpUrl(address) ? address : null,
    selection,
    page: selection ? '' : plainText(params.get('page'), WEB_CLIP_MAX),
  };
  return result.title || result.url || result.selection ? result : null;
}

/** Przycięcie bez rozcinania znaku spoza BMP (pół emoji). */
const cut = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, ''));

/**
 * Znaki sterujące i niewidoczne (zerowej szerokości, kierunku pisma, „tagi” Unicode) — nie mają treści, a potrafią
 * ukryć tekst przed użytkownikiem. Zostają nowe linie i łączniki emoji (U+200C, U+200D).
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u00AD\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]|\uDB40[\uDC00-\uDC7F]/g;

/** Zwykły tekst: bez znaków niewidocznych, pojedyncze spacje, najwyżej jedna pusta linia z rzędu. */
export function plainText(text: string | null | undefined, max: number): string {
  const normalized = (text ?? '')
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/[\t\u00A0]/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/ {2,}/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cut(normalized, max).trim();
}

/** Zwykły tekst w jednej linii (tytuł, punkt streszczenia). */
export const oneLine = (text: string | null | undefined, max: number): string => cut(plainText(text, Infinity).replace(/\s+/g, ' '), max).trim();

/**
 * Obcy tekst w Markdown: znacznik HTML, link `[tekst](adres)` i obrazek zostają widocznym tekstem. Nawiasy kwadratowe
 * zasłania wszystkie, ale tylko gdy w tekście jest coś, co wygląda na link — zwykłe „[1]” zostaje czytelne.
 */
export function escapeClipMarkdown(text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/<(?=[a-z/!?])/gi, '\\<');
  return /\][([:]/.test(escaped) ? escaped.replace(/[[\]]/g, '\\$&') : escaped;
}

/** „Źródło: [tytuł](adres)”; bez adresu `''`. */
export function clipSource({ title, url }: Pick<WebClip, 'title' | 'url'>): string {
  if (!url || !parseHttpUrl(url)) return '';
  // Nawiasy, spacje i `<>` w adresie zakończyłyby link Markdown przed czasem.
  const href = url.replace(/[()<>\s\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  const name = title.replace(/\\/g, '\\\\').replace(/[[\]]/g, '\\$&').replace(/<(?=[a-z/!?])/gi, '\\<');
  return name ? `Źródło: [${name}](${href})` : `Źródło: ${href}`;
}

/** Zaznaczenie jako cytat Markdown ze źródłem; bez zaznaczenia `''` (tekst strony sam nie trafia do opisu). */
export function clipQuote(source: WebClip): string {
  if (!source.selection) return '';
  const lines = escapeClipMarkdown(source.selection).split('\n');
  // Dwie spacje na końcu = złamanie linii wewnątrz akapitu (np. pozycje listy ze strony).
  const quote = lines.map((line, i) => (line ? `> ${line}${lines[i + 1] ? '  ' : ''}` : '>')).join('\n');
  return [quote, clipSource(source)].filter(Boolean).join('\n\n');
}
