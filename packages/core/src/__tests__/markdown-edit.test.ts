import { describe, expect, it } from 'vitest';

import { markdownContinueList, markdownEdit, type MarkdownAction } from '../markdown-edit.ts';

/** Tekst ze znacznikami `«` `»` zaznaczenia (albo `‸` kursora) → wynik w tym samym zapisie. */
function apply(marked: string, action: MarkdownAction): string {
  const cursor = marked.indexOf('‸');
  const [text, s, e] =
    cursor >= 0 ? [marked.replace('‸', ''), cursor, cursor] : [marked.replace('«', '').replace('»', ''), marked.indexOf('«'), marked.indexOf('»') - 1];
  const edit = markdownEdit(text, s, e, action);
  const next = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return edit.selStart === edit.selEnd
    ? `${next.slice(0, edit.selStart)}‸${next.slice(edit.selStart)}`
    : `${next.slice(0, edit.selStart)}«${next.slice(edit.selStart, edit.selEnd)}»${next.slice(edit.selEnd)}`;
}

describe('Markdown: formatowanie w linii', () => {
  it('pogrubienie, kursywa, przekreślenie, kod', () => {
    expect(apply('a «słowo» b', 'bold')).toBe('a **«słowo»** b');
    expect(apply('a «słowo» b', 'italic')).toBe('a *«słowo»* b');
    expect(apply('a «słowo» b', 'strike')).toBe('a ~~«słowo»~~ b');
    expect(apply('a «słowo» b', 'code')).toBe('a `«słowo»` b');
  });

  it('spacje na brzegach zaznaczenia zostają poza znacznikami', () => {
    expect(apply('a« słowo »b', 'bold')).toBe('a **«słowo»** b');
  });

  it('bez zaznaczenia: znaczniki z kursorem w środku, drugi raz je zdejmuje', () => {
    expect(apply('a ‸', 'bold')).toBe('a **‸**');
    expect(apply('a **‸**', 'bold')).toBe('a ‸');
  });

  it('ponowne użycie zdejmuje formatowanie (zaznaczenie w środku albo ze znacznikami)', () => {
    expect(apply('a **«słowo»** b', 'bold')).toBe('a «słowo» b');
    expect(apply('a «**słowo**» b', 'bold')).toBe('a «słowo» b');
    expect(apply('a *«słowo»* b', 'italic')).toBe('a «słowo» b');
  });

  it('kursywa na pogrubionym tekście dodaje kursywę, nie zdejmuje gwiazdki', () => {
    expect(apply('a **«słowo»** b', 'italic')).toBe('a ***«słowo»*** b');
    expect(apply('a ***«słowo»*** b', 'italic')).toBe('a **«słowo»** b');
  });

  it('kod z kilku linii = blok kodu (i z powrotem)', () => {
    expect(apply('«x = 1\ny = 2»', 'code')).toBe('```\n«x = 1\ny = 2»\n```');
    expect(apply('«```\nx = 1\ny = 2\n```»', 'code')).toBe('«x = 1\ny = 2»');
  });

  it('link: tekst → zaznaczone „url”, adres → kursor na tekst linku', () => {
    expect(apply('zobacz «stronę»', 'link')).toBe('zobacz [stronę](«url»)');
    expect(apply('zobacz ‸', 'link')).toBe('zobacz [](«url»)');
    expect(apply('«https://ex.pl/a»', 'link')).toBe('[‸](https://ex.pl/a)');
  });
});

describe('Markdown: formatowanie linii', () => {
  it('lista, numeracja, zadania, cytat, nagłówek — kursor zostaje w tekście', () => {
    expect(apply('zakupy‸', 'bullet')).toBe('- zakupy‸');
    expect(apply('zak‸upy', 'task')).toBe('- [ ] zak‸upy');
    expect(apply('zakupy‸', 'quote')).toBe('> zakupy‸');
    expect(apply('Plan‸', 'heading')).toBe('### Plan‸');
  });

  it('kilka linii: każda dostaje znacznik, puste zostają, numeracja rośnie', () => {
    expect(apply('«a\nb\n\nc»', 'numbered')).toBe('«1. a\n2. b\n\n3. c»');
    expect(apply('x\n«a\nb»\ny', 'bullet')).toBe('x\n«- a\n- b»\ny');
  });

  it('linie ze znacznikiem → zdjęcie; inny rodzaj → zamiana', () => {
    expect(apply('«- a\n- b»', 'bullet')).toBe('«a\nb»');
    expect(apply('«- a\n- b»', 'task')).toBe('«- [ ] a\n- [ ] b»');
    expect(apply('«- [ ] a\n- [x] b»', 'task')).toBe('«a\nb»');
    expect(apply('«- [ ] a»', 'bullet')).toBe('«- a»');
    expect(apply('«1. a\n2. b»', 'numbered')).toBe('«a\nb»');
  });

  it('zaznaczenie kończące się na początku linii jej nie obejmuje', () => {
    expect(apply('«a\n»b', 'bullet')).toBe('«- a»\nb');
  });
});

describe('Markdown: bloki', () => {
  it('tabela w osobnym akapicie, zaznaczony pierwszy nagłówek', () => {
    expect(apply('tekst‸', 'table')).toBe('tekst\n\n| «Nagłówek» | Nagłówek |\n| -------- | -------- |\n| Komórka  | Komórka  |\n');
    expect(apply('‸', 'table')).toBe('| «Nagłówek» | Nagłówek |\n| -------- | -------- |\n| Komórka  | Komórka  |\n');
  });

  it('linia pozioma między akapitami', () => {
    expect(apply('a‸\nb', 'rule')).toBe('a\n\n---‸\n\nb');
  });
});

describe('Markdown: Enter w liście', () => {
  const enter = (marked: string): string => {
    const pos = marked.indexOf('‸');
    const text = marked.replace('‸', '');
    const edit = markdownContinueList(text, pos);
    if (!edit) return 'zwykły Enter';
    const next = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
    return `${next.slice(0, edit.selStart)}‸${next.slice(edit.selStart)}`;
  };

  it('kolejna pozycja z tym samym znacznikiem (z wcięciem), numer + 1, nowe pole niezaznaczone', () => {
    expect(enter('- a‸')).toBe('- a\n- ‸');
    expect(enter('  * a‸')).toBe('  * a\n  * ‸');
    expect(enter('9. a‸\n10. b')).toBe('9. a\n10. ‸\n10. b');
    expect(enter('- [x] zrobione‸')).toBe('- [x] zrobione\n- [ ] ‸');
    expect(enter('> cytat‸')).toBe('> cytat\n> ‸');
  });

  it('Enter w środku tekstu pozycji dzieli ją', () => {
    expect(enter('- ab‸cd')).toBe('- ab\n- ‸cd');
  });

  it('pusta pozycja kończy listę; poza listą i w znaczniku — zwykły Enter', () => {
    expect(enter('- a\n- ‸')).toBe('- a\n‸');
    expect(enter('- [ ] ‸')).toBe('‸');
    expect(enter('tekst‸')).toBe('zwykły Enter');
    expect(enter('-‸ a')).toBe('zwykły Enter');
  });
});
