import { describe, expect, it } from 'vitest';

import { parseInline, parseMarkdown, spansText, toggleMarkdownCheckbox } from '../markdown.ts';

describe('Markdown: tekst w linii', () => {
  it('pogrubienie, kursywa, przekreślenie, kod, link', () => {
    expect(parseInline('a **b** *c* ~~d~~ `e` [f](https://x.pl)')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'c', italic: true },
      { text: ' ' },
      { text: 'd', strike: true },
      { text: ' ' },
      { text: 'e', code: true },
      { text: ' ' },
      { text: 'f', href: 'https://x.pl' },
    ]);
  });

  it('zagnieżdżenie stylów i goły adres', () => {
    expect(parseInline('**pół *i* pół** https://ex.pl/a.')).toEqual([
      { text: 'pół ', bold: true },
      { text: 'i', bold: true, italic: true },
      { text: ' pół', bold: true },
      { text: ' ' },
      { text: 'https://ex.pl/a', href: 'https://ex.pl/a' },
      { text: '.' },
    ]);
  });

  it('bez dopasowania tekst zostaje dosłownie', () => {
    expect(spansText(parseInline('2 * 3 = 6, snake_case_name, \\*gwiazdka\\*, **otwarte'))).toBe('2 * 3 = 6, snake_case_name, *gwiazdka*, **otwarte');
  });
});

describe('Markdown: bloki', () => {
  it('nagłówki, akapity, cytat, kod, linia', () => {
    const blocks = parseMarkdown('# Tytuł\n\nPierwsza\nlinia\n\n> cytat\n> dalej\n\n```\nkod  1\n```\n\n---\nkoniec');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'quote', 'code', 'rule', 'paragraph']);
    expect(blocks[1]).toEqual({ kind: 'paragraph', spans: [{ text: 'Pierwsza linia' }] });
    expect(blocks[2]).toEqual({ kind: 'quote', spans: [{ text: 'cytat dalej' }] });
    expect(blocks[3]).toEqual({ kind: 'code', text: 'kod  1' });
  });

  it('listy zagnieżdżone, numerowane i z polami wyboru', () => {
    const [list] = parseMarkdown('- [ ] mleko\n- [x] chleb\n  - masło\n1. raz\n2. dwa');
    expect(list).toMatchObject({
      kind: 'list',
      items: [
        { spans: [{ text: 'mleko' }], depth: 0, checked: false, line: 0, ordered: false },
        { spans: [{ text: 'chleb' }], depth: 0, checked: true, line: 1 },
        { spans: [{ text: 'masło' }], depth: 1, line: 2 },
        { spans: [{ text: 'raz' }], depth: 0, ordered: true, number: 1 },
        { spans: [{ text: 'dwa' }], ordered: true, number: 2 },
      ],
    });
    expect((list as { items: { checked?: boolean }[] }).items[2]!.checked).toBeUndefined();
  });

  it('pusty opis = brak bloków', () => {
    expect(parseMarkdown(null)).toEqual([]);
    expect(parseMarkdown('\n\n')).toEqual([]);
  });

  it('odhaczenie pola w źródle', () => {
    const src = 'Lista:\n- [ ] mleko\n- [x] chleb';
    expect(toggleMarkdownCheckbox(src, 1)).toBe('Lista:\n- [x] mleko\n- [x] chleb');
    expect(toggleMarkdownCheckbox(src, 2)).toBe('Lista:\n- [ ] mleko\n- [ ] chleb');
    expect(toggleMarkdownCheckbox(src, 0)).toBe(src);
  });
});
