import { describe, expect, it } from 'vitest';

import { markdownCheckboxLines, parseInline, parseMarkdown, spansText, toggleMarkdownCheckbox } from '../markdown.ts';

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

  it('linie pól list zadań w kolejności podglądu, bez bloków kodu', () => {
    const src = ['- [ ] a', 'tekst', '```', '- [ ] w kodzie', '```', '  * [x] b', '- [] nie pole', '- [x]bez spacji', '1. [ ] c', '~~~', '- [ ] też kod', '~~~'].join('\r\n');
    expect(markdownCheckboxLines(src)).toEqual([0, 5, 8]);
    expect(markdownCheckboxLines('')).toEqual([]);
  });
});

describe('Markdown: tabele GFM', () => {
  const cells = (row: ReturnType<typeof parseInline>[]) => row.map(spansText);
  const table = (source: string) => {
    const block = parseMarkdown(source).find((b) => b.kind === 'table');
    return block && { align: block.align, header: cells(block.header), rows: block.rows.map(cells) };
  };

  it('nagłówek, wyrównanie, komórki dopełnione i obcięte do nagłówka', () => {
    expect(table('| A | B | C |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n| 4 |\n| 5 | 6 | 7 | 8 |')).toEqual({
      align: ['left', 'center', 'right'],
      header: ['A', 'B', 'C'],
      rows: [['1', '2', '3'], ['4', '', ''], ['5', '6', '7']],
    });
  });

  it('bez skrajnych kresek, pusta komórka, kreska z ukośnikiem i formatowanie w komórce', () => {
    expect(table('A | B\n--- | ---\n| | x\\|y')).toEqual({ align: [null, null], header: ['A', 'B'], rows: [['', 'x|y']] });
    const block = parseMarkdown('| A |\n| - |\n| **b** |')[0];
    expect(block).toMatchObject({ kind: 'table', rows: [[[{ text: 'b', bold: true }]]] });
  });

  it('kończy się na pustej linii albo innym bloku; tekst obok zostaje', () => {
    expect(parseMarkdown('przed\n| A | B |\n|---|---|\n| 1 | 2 |\n# Dalej').map((b) => b.kind)).toEqual(['paragraph', 'table', 'heading']);
    expect(parseMarkdown('| A |\n|---|\n\npo').map((b) => b.kind)).toEqual(['table', 'paragraph']);
  });

  it('bez linii `---` albo z inną liczbą kolumn — zwykły tekst', () => {
    expect(parseMarkdown('a | b').map((b) => b.kind)).toEqual(['paragraph']);
    expect(table('| A | B |\n| --- |\n| 1 | 2 |')).toBeUndefined();
  });
});
