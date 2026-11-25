import { describe, expect, it } from 'vitest';

import { sharedText, withLinkOps } from '../attachments.ts';
import { parseMarkdown } from '../markdown.ts';
import { parseQuickAdd } from '../quick-add.ts';
import { quickAddTaskOps } from '../tasks.ts';
import { bookmarkletCode, clipQuote, clipSource, isWebClipHash, parseWebClip, plainText, WEB_CLIP_MAX } from '../web-clip.ts';

interface FakePage {
  title?: string;
  url?: string;
  selection?: string;
  articles?: string[];
  main?: string;
  body?: string;
}

/** Wykonuje kod zakładki na udawanej stronie; zwraca otwarty adres i argumenty `window.open`. */
function runBookmarklet({ title = 'Artykuł', url = 'https://blog.pl/wpis?a=1#s', selection = '', articles = [], main, body = '' }: FakePage) {
  const code = bookmarkletCode('https://app.test');
  // Przeglądarka parsuje adres, a potem dekoduje procenty — kod musi to przetrwać.
  const source = decodeURIComponent(new URL(code).href.slice('javascript:'.length));
  const opened: string[][] = [];
  const element = (text: string) => ({ innerText: text });
  const document = {
    title,
    body: element(body),
    querySelectorAll: () => articles.map(element),
    querySelector: () => (main === undefined ? null : element(main)),
  };
  const window = { getSelection: () => ({ toString: () => selection }), open: (...args: string[]) => opened.push(args) };
  new Function('window', 'document', 'location', source)(window, document, { href: url });
  expect(opened).toHaveLength(1);
  const opening = new URL(opened[0]![0]!);
  return { opening, args: opened[0]!.slice(1), clip: parseWebClip(opening.hash)! };
}

const long = (word: string) => `${word} `.repeat(120).trim();

describe('kod zakładki', () => {
  it('nie ma znaków, które psuje adres `javascript:`', () => {
    const code = bookmarkletCode('https://app.test').slice('javascript:'.length);
    expect(code).not.toMatch(/[%#\n\r\t]/);
  });

  it('zaznaczenie z polskimi znakami idzie tylko w części #, bez parametrów zapytania', () => {
    const { opening, args, clip } = runBookmarklet({ selection: 'Zażółć  gęślą\u00a0jaźń & 100% #1 + „x”', body: long('cała strona') });
    expect(opening.origin + opening.pathname + opening.search).toBe('https://app.test/');
    expect(args).toEqual(['_blank', 'noopener']);
    expect(clip).toEqual({ title: 'Artykuł', url: 'https://blog.pl/wpis?a=1#s', selection: 'Zażółć gęślą jaźń & 100% #1 + „x”', page: '' });
  });

  it('bez zaznaczenia: jedyny article, potem main, potem body; za krótkie pomija', () => {
    expect(runBookmarklet({ articles: [long('artykuł')], main: long('main'), body: 'x' }).clip.page).toBe(long('artykuł'));
    expect(runBookmarklet({ articles: [long('a'), long('b')], main: long('main'), body: 'x' }).clip.page).toBe(long('main'));
    expect(runBookmarklet({ articles: ['krótki'], main: 'krótki', body: long('body') }).clip.page).toBe(long('body'));
    expect(runBookmarklet({ body: 'krótko' }).clip).toMatchObject({ selection: '', page: 'krótko' });
  });

  it('przycina do limitu, także w połowie emoji (bez wyjątku)', () => {
    const { clip } = runBookmarklet({ selection: `${'a'.repeat(WEB_CLIP_MAX - 1)}😀😀` });
    expect(clip.selection.length).toBeLessThanOrEqual(WEB_CLIP_MAX);
    expect(clip.selection.startsWith('aaa')).toBe(true);
  });

  it('pusta strona: sam tytuł i adres', () => {
    expect(runBookmarklet({}).clip).toEqual({ title: 'Artykuł', url: 'https://blog.pl/wpis?a=1#s', selection: '', page: '' });
  });
});

describe('odczyt części #', () => {
  const hash = (params: Record<string, string>) => `#share?${new URLSearchParams(params)}`;

  it('trasy aplikacji i puste wycinki to nie wycinek', () => {
    for (const h of ['', '#/today', '#/list/share', '#share', '#/share?title=x']) {
      expect(parseWebClip(h)).toBeNull();
      expect(isWebClipHash(h)).toBe(false);
    }
    expect(parseWebClip('#share?')).toBeNull();
    expect(parseWebClip(hash({ page: 'sam tekst strony' }))).toBeNull();
    expect(isWebClipHash('#share?')).toBe(true);
  });

  it('sprawdza limity i adres ponownie — adres mógł zbudować ktokolwiek', () => {
    const clip = parseWebClip(hash({ title: `T\n${'t'.repeat(900)}`, url: 'javascript:alert(1)', selection: 's'.repeat(20_000) }))!;
    expect(clip.title).toHaveLength(500);
    expect(clip.title).not.toContain('\n');
    expect(clip.url).toBeNull();
    expect(clip.selection).toHaveLength(WEB_CLIP_MAX);
    expect(parseWebClip(hash({ title: 'x', url: `https://a.pl/${'x'.repeat(3000)}` }))!.url).toBeNull();
  });

  it('zaznaczenie wyklucza tekst strony; uszkodzone kodowanie nie rzuca', () => {
    expect(parseWebClip(hash({ title: 'x', selection: 'a', page: 'b' }))).toMatchObject({ selection: 'a', page: '' });
    expect(parseWebClip('#share?title=%E0%A4&selection=%')).toMatchObject({ selection: '%' });
  });

  it('znaki niewidoczne i sterujące odpadają', () => {
    expect(plainText('a\u200bb\u202ec\u0000d\ufeffe\u00adf\u{E0041}g', 100)).toBe('abcdefg');
    expect(plainText(' a \t b \r\n\r\n\r\n\r\n c ', 100)).toBe('a b\n\nc');
    expect(plainText('👨\u200d👩\u200d👧', 100)).toBe('👨\u200d👩\u200d👧');
    expect(plainText('ab😀', 3)).toBe('ab');
  });
});

describe('cytat w opisie', () => {
  const clip = { title: 'Tytuł', url: 'https://blog.pl/wpis', selection: 'Pierwszy akapit.\n\nDrugi\nw dwóch liniach.', page: '' };

  it('akapity i złamania linii w cytacie, pod spodem źródło', () => {
    expect(clipQuote(clip)).toBe('> Pierwszy akapit.\n>\n> Drugi  \n> w dwóch liniach.\n\nŹródło: [Tytuł](https://blog.pl/wpis)');
    expect(parseMarkdown(clipQuote(clip)).map((b) => b.kind)).toEqual(['quote', 'paragraph']);
  });

  it('bez zaznaczenia tekst strony nie trafia do opisu', () => {
    expect(clipQuote({ ...clip, selection: '', page: 'cała strona' })).toBe('');
  });

  it('HTML, linki i obrazki z obcej strony zostają tekstem', () => {
    const quote = clipQuote({ ...clip, selection: '<img src=x onerror=alert(1)> [Zaloguj](https://zly.pl) ![x](https://zly.pl/p.png) a < b i 2<3' });
    expect(quote).toContain('\\<img src=x');
    expect(quote).toContain('a < b i 2<3');
    const spans = parseMarkdown(quote).flatMap((b) => (b.kind === 'quote' ? b.spans : []));
    // Adres goły jest klikalny, ale widać, dokąd prowadzi — nie chowa się pod cudzym tekstem.
    expect(spans.filter((s) => s.href).every((s) => s.text === s.href)).toBe(true);
    expect(spans.map((s) => s.text).join('')).toContain('<img src=x onerror=alert(1)> [Zaloguj](');
  });

  it('źródło: nawiasy w tytule i adresie nie psują linku; bez adresu brak źródła', () => {
    const source = clipSource({ title: 'Kot [ujedn.] \\ <b>', url: 'https://pl.wikipedia.org/wiki/Kot_(x)' });
    expect(source).toBe('Źródło: [Kot \\[ujedn.\\] \\\\ \\<b>](https://pl.wikipedia.org/wiki/Kot_%28x%29)');
    expect(clipSource({ title: '', url: 'https://a.pl/' })).toBe('Źródło: https://a.pl/');
    expect(clipSource({ title: 'x', url: null })).toBe('');
    expect(clipQuote({ ...clip, url: null })).not.toContain('Źródło');
  });
});

describe('zadanie z wycinka', () => {
  const scope = { userId: 'u', workspaces: [], lists: [], tags: [], defaultListId: 'l', lastSortKey: () => undefined, newId: () => 't1' };
  const parse = (text: string) => parseQuickAdd(text, { now: '2026-11-24T12:00', workspaces: [], lists: [], tags: [] });

  it('opis i link zapisują się razem z zadaniem', () => {
    const shared = sharedText({ title: 'Artykuł', url: 'https://blog.pl/wpis' });
    const created = quickAddTaskOps(parse(shared.text), shared.text, { ...scope, description: ' > cytat \n' });
    const ops = withLinkOps(created, { title: 'Artykuł', url: shared.url, shared: true, newId: () => 'a1' });
    expect(ops.map((o) => o.table)).toEqual(['tasks', 'attachments']);
    expect(ops[0]!.patch).toMatchObject({ title: 'Artykuł', description_md: '> cytat', source: { kind: 'link', url: 'https://blog.pl/wpis' } });
  });

  it('bez opisu łatka zadania jest jak dotąd', () => {
    for (const description of [undefined, null, '  ']) expect(quickAddTaskOps(parse('Coś'), 'Coś', { ...scope, description }).ops[0]!.patch).not.toHaveProperty('description_md');
  });
});
