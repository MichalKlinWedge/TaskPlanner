import { describe, expect, it } from 'vitest';

import { htmlToMarkdown, PASTE_HTML_MAX } from '../html-to-markdown.ts';
import { applyMarkdownEdit, markdownPaste } from '../markdown-edit.ts';
import { parseMarkdown, spansText } from '../markdown.ts';

const md = (html: string) => htmlToMarkdown(html)?.markdown ?? null;

describe('HTML → Markdown: tekst w linii', () => {
  it('pogrubienie, kursywa, przekreślenie, kod, link', () => {
    expect(md('<p>a <b>b</b> <em>c</em> <del>d</del> <code>e</code> <a href="https://x.pl/q">f</a></p>')).toBe('a **b** *c* ~~d~~ `e` [f](https://x.pl/q)');
  });

  it('style CSS zamiast znaczników (Google Docs owija całość w <b> z font-weight:normal)', () => {
    expect(
      md(
        '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:400">Ala </span><span style="font-weight:700">ma</span><span style="font-style:italic"> kota</span></p></b>',
      ),
    ).toBe('Ala **ma** *kota*');
  });

  it('spacje i interpunkcja z brzegów poza znacznikami', () => {
    expect(md('<p>a<b> b </b>c</p>')).toBe('a **b** c');
    expect(md('<p><b>Uwaga:</b>dalej</p>')).toBe('**Uwaga**:dalej');
    expect(md('<p><b>Uwaga:</b> dalej</p>')).toBe('**Uwaga:** dalej');
    expect(md('<p>a<b> </b>b</p>')).toBe('a b');
  });

  it('zagnieżdżone style i pogrubienie rozbite na kilka znaczników', () => {
    expect(md('<p><b>a <i>b</i></b></p>')).toBe('**a *b***');
    expect(md('<p><b>a</b><span> </span><b>b</b></p>')).toBe('**a b**');
  });

  it('link: adres jako tekst goły, niebezpieczne i lokalne adresy odpadają, nawiasy zakodowane', () => {
    expect(md('<a href="https://x.pl/">x.pl</a>')).toBe('https://x.pl/');
    expect(md('<a href="mailto:a@x.pl">a@x.pl</a>')).toBe('a@x.pl');
    expect(md('<a href="javascript:alert(1)">klik</a>')).toBe('klik');
    expect(md('<a href="/a">klik</a>')).toBe('klik');
    expect(md('<a href="https://x.pl/a_(b)">[1] w</a>')).toBe('[(1) w](https://x.pl/a_%28b%29)');
    expect(md('<p>a<a href="https://x.pl"></a>b</p>')).toBe('ab');
  });

  it('znaki Markdown w zwykłym tekście dostają ukośnik, a podgląd pokazuje je dosłownie', () => {
    const text = '*a* _b_ snake_case `c` &lt;T&gt; [x](y) 2 * 3 C:\\temp ~~d~~ &amp;lt;';
    const out = md(`<p>${text}</p>`)!;
    expect(out).toBe('\\*a\\* \\_b\\_ snake_case \\`c\\` \\<T> \\[x](y) 2 * 3 C:\\temp \\~\\~d\\~\\~ \\&lt;');
    const [block] = parseMarkdown(out);
    expect(block?.kind === 'paragraph' && spansText(block.spans)).toBe('*a* _b_ snake_case `c` <T> [x](y) 2 * 3 C:\\temp ~~d~~ &lt;');
    expect(md('<p># nie nagłówek</p><p>1. nie lista</p><p>- nie lista</p><p>&gt; nie cytat</p>')).toBe('\\# nie nagłówek\n\n1\\. nie lista\n\n\\- nie lista\n\n\\> nie cytat');
    expect(md('<p>https://x.pl/_a_*b</p>')).toBe('https://x.pl/_a_*b');
  });

  it('białe znaki, encje i ukryta treść', () => {
    expect(md('<p>\n  a&nbsp;&nbsp;b\n  c&oacute;&#322;&#x144; &euro;&nieznana;</p>')).toBe('a b cółń €\\&nieznana;');
    expect(md('<style>p{color:red}</style><script>x("<p>")</script><!-- k --><p>a<span style="display:none">b</span></p>')).toBe('a');
    expect(md('<p>a < b i 3 <4</p>')).toBe('a < b i 3 <4');
  });
});

describe('HTML → Markdown: bloki', () => {
  it('nagłówki (bez pogrubienia w środku), akapity, linia, cytat', () => {
    expect(md('<h2><b>Plan</b> dnia</h2><p>a</p><p>b<br>c</p><hr><blockquote><p>x</p><p>y</p></blockquote>')).toBe('## Plan dnia\n\na\n\nb  \nc\n\n---\n\n> x\n>\n> y');
    expect(md('<div role="heading" aria-level="3">T</div>')).toBe('### T');
  });

  it('poczta: linie w <div>, pusty <div> i <br><br> dzielą akapity', () => {
    expect(md('<div>a</div><div>b</div><div><br></div><div>c</div>')).toBe('a  \nb\n\nc');
    expect(md('a<br>b<br><br>c')).toBe('a  \nb\n\nc');
  });

  it('listy zagnieżdżone, numerowane od podanej liczby, z polami wyboru', () => {
    expect(md('<ul><li>a<ul><li>b</li></ul></li><li><p>c</p><p>d</p></li></ul>')).toBe('- a\n  - b\n- c  \n  d');
    expect(md('<ol start="3"><li>a<ol><li>b</li></ol></li><li>c</li></ol>')).toBe('3. a\n   1. b\n4. c');
    expect(md('<ul><li><input type="checkbox" checked> a</li><li><label><input type="checkbox"></label>b</li><li>c</li></ul>')).toBe('- [x] a\n- [ ] b\n- c');
    expect(md('<ul><li role="checkbox" aria-checked="true"><p>a</p></li></ul>')).toBe('- [x] a');
    expect(md('<ul><li>☐ a</li><li>☑ b</li></ul>')).toBe('- [ ] a\n- [x] b');
    // Pole zagnieżdżonej pozycji nie robi pola z rodzica.
    expect(md('<ul><li>a<ul><li><input type="checkbox">b</li></ul></li></ul>')).toBe('- a\n  - [ ] b');
  });

  it('lista wprost w liście (Google Docs), <li> bez zamknięcia, pozycja bez listy', () => {
    expect(md('<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>')).toBe('- a\n  - b\n- c');
    expect(md('<ul><li>a<li>b</ul><p>c')).toBe('- a\n- b\n\nc');
    expect(md('<li>a</li><li>b</li>')).toBe('- a\n- b');
    expect(md('<ul><li><ul><li>a</li></ul></li></ul>')).toBe('- a');
  });

  it('listy Worda (akapity mso-list z poziomem) i punktory wpisane w tekst', () => {
    const p = (level: number, mark: string, text: string) =>
      `<p class=MsoListParagraph style='margin-left:36.0pt;text-indent:-18.0pt;mso-list:l0 level${level} lfo1'><![if !supportLists]><span style='font-family:Symbol;mso-list:Ignore'>${mark}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span><![endif]>${text}<o:p></o:p></p>`;
    expect(md(`<html><head><style>x</style></head><body><!--StartFragment-->${p(1, '·', 'a <b>b</b>')}${p(2, 'o', 'c')}${p(1, '·', 'd')}<p class=MsoNormal>e</p>${p(1, '1.', 'f')}${p(1, '2.', 'g')}<!--EndFragment--></body></html>`)).toBe(
      '- a **b**\n  - c\n- d\n\ne\n\n1. f\n2. g',
    );
    expect(md('<p>Lista:<br>• a<br>• b</p>')).toBe('Lista:\n\n- a\n- b');
  });

  it('kod: <pre>, język, VS Code (div na linię), kod z ```', () => {
    expect(md('<pre><code class="language-ts">const a = 1;\n  b(&lt;T&gt;);\n</code></pre>')).toBe('```ts\nconst a = 1;\n  b(<T>);\n```');
    expect(
      md('<div style="font-family: Consolas, monospace;white-space: pre;"><div><span>if (a) {</span></div><div><span>  b</span></div><br><div><span>}</span></div></div>'),
    ).toBe('```\nif (a) {\n  b\n\n}\n```');
    expect(md('<pre>a\n```\nb</pre>')).toBe('````\na\n```\nb\n````');
  });

  it('tabele: nagłówek z pierwszego wiersza, scalone komórki, kreska w treści, układ strony bez tabeli', () => {
    expect(md('<table><tr><th>A</th><th>B</th></tr><tr><td><p>1|2</p></td><td><b>x</b><br>y</td></tr></table>')).toBe('| A | B |\n| --- | --- |\n| 1\\|2 | **x** y |');
    expect(md('<table><tr><td>a<td>b<tr><td colspan=2>c</table>')).toBe('| a | b |\n| --- | --- |\n| c |  |');
    expect(md('<table><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></table>')).toBe('| a | b |\n| --- | --- |\n|  | c |');
    expect(md('<table><tr><td><h1>T</h1><table><tr><td>a</td><td>b</td></tr></table></td></tr></table>')).toBe('# T\n\n| a | b |\n| --- | --- |');
    const blocks = parseMarkdown(md('<table><tr><td>A</td><td>B</td></tr><tr><td>1|2</td><td></td></tr></table>'));
    expect(blocks.map((b) => b.kind)).toEqual(['table']);
  });

  it('obrazy: emotikona jako znak, obraz z opisem jako link, bez opisu nic', () => {
    expect(md('<p>a <img alt="😀" src="https://x.pl/e.png"> <img alt="Schemat sieci" src="https://x.pl/s.png"><img src="https://x.pl/p.gif"></p>')).toBe('a 😀 [Schemat sieci](https://x.pl/s.png)');
  });
});

describe('HTML → Markdown: wynik', () => {
  it('formatted — tylko gdy jest co zachować; inline — jedna linia', () => {
    expect(htmlToMarkdown('<meta charset="utf-8"><span style="color:red">zwykły tekst</span>')).toEqual({ markdown: 'zwykły tekst', formatted: false, inline: true });
    expect(htmlToMarkdown('<p>a</p><p>b</p>')).toMatchObject({ formatted: false, inline: false });
    expect(htmlToMarkdown('<b>a</b>')).toMatchObject({ formatted: true, inline: true });
    expect(htmlToMarkdown('<a href="https://x.pl">https://x.pl</a>')).toMatchObject({ formatted: false });
    expect(htmlToMarkdown('<h1>a</h1>')).toMatchObject({ formatted: true, inline: false });
  });

  it('brak treści i za duży HTML', () => {
    expect(htmlToMarkdown('<img src="data:image/png;base64,AAAA">')).toBeNull();
    expect(htmlToMarkdown('a'.repeat(PASTE_HTML_MAX + 1))).toBeNull();
  });

  it('uszkodzony HTML nie przerywa zamiany, duży idzie szybko', () => {
    expect(md('<p>a <b>b</p><p>c</i></div><x y="z>d')).toContain('a **b**');
    const rows = Array.from({ length: 2000 }, (_, i) => `<tr><td>${i}</td><td><b>x</b></td><td style="color:red">y</td></tr>`).join('');
    const at = performance.now();
    expect(md(`<table>${rows}</table>`)!.split('\n')).toHaveLength(2001);
    expect(performance.now() - at).toBeLessThan(1500);
  });
});

describe('markdownPaste', () => {
  const paste = (marked: string, markdown: string, inline = false) => {
    const s = marked.indexOf('‸');
    const text = marked.replace('‸', '');
    const edit = markdownPaste(text, s, s, { markdown, inline });
    const next = applyMarkdownEdit(text, edit);
    return `${next.slice(0, edit.selStart)}‸${next.slice(edit.selStart)}`;
  };

  it('jedna linia w zdaniu, bloki oddzielone pustą linią', () => {
    expect(paste('a ‸ b', '**x**', true)).toBe('a **x**‸ b');
    expect(paste('a‸b', '# x')).toBe('a\n\n# x‸\n\nb');
    expect(paste('a\n‸\nb', '# x')).toBe('a\n\n# x‸\n\nb');
    expect(paste('‸', '- a\n- b')).toBe('- a\n- b‸');
  });

  it('lista w pustej pozycji listy zastępuje jej znacznik', () => {
    expect(paste('- z\n- ‸', '- a\n- b')).toBe('- z\n- a\n- b‸');
    expect(paste('- z\n- t‸', '- a')).toBe('- z\n- t\n\n- a‸');
  });
});
