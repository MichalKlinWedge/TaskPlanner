/**
 * Eksport instrukcji do PDF: `docs/instrukcja/INSTRUKCJA.md` → HTML (`marked`) → druk w Chromie (Playwright).
 * Uruchomienie: `npm run docs:pdf`; inny plik: `npm run docs:pdf -- ścieżka.md [wynik.pdf]`.
 * Obrazy czyta z dysku (nic nie wychodzi do sieci), linki spisu treści działają także w PDF.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from '@playwright/test';
import { Marked } from 'marked';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// `npm run … --workspace` zmienia katalog; ścieżki z wiersza poleceń liczymy od miejsca wywołania.
const from = process.env.INIT_CWD ?? process.cwd();
const [input, output] = process.argv.slice(2);
const source = input ? resolve(from, input) : join(ROOT, 'docs/instrukcja/INSTRUKCJA.md');
const target = output ? resolve(from, output) : source.replace(/\.md$/i, '.pdf');

/** Pikseli obrazu na piksel druku: zrzuty mają 1,5 piksela na piksel CSS, w druku są trochę mniejsze. */
const DENSITY = 2;
/** Szerokość i wysokość obszaru druku A4 w pikselach CSS (marginesy niżej). */
const PAGE = { width: 680, height: 900 };

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Kotwica nagłówka jak w podglądzie Markdown na GitHubie. */
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');

/** Wymiary obrazów — znane przed renderowaniem, żeby podział na strony nie zależał od kolejności wczytania. */
async function imageSizes(markdown: string, dir: string) {
  const sizes = new Map<string, { width: number; height: number }>();
  for (const [, href] of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (!href || sizes.has(href)) continue;
    const { width, height } = await sharp(join(dir, href)).metadata();
    // Wąskie, wysokie kadry (panele) dostają więcej miejsca, żeby tekst był czytelny.
    const tall = height > 1.5 * width ? 0.65 : 0.45;
    const scale = Math.min(1, PAGE.width / (width / DENSITY), (PAGE.height * tall) / (height / DENSITY));
    sizes.set(href, { width: Math.round((width / DENSITY) * scale), height: Math.round((height / DENSITY) * scale) });
  }
  return sizes;
}

const CSS = `
  @page { size: A4; margin: 18mm 15mm 18mm; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.5 "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: #1f2328; margin: 0; }
  h1 { font-size: 27pt; line-height: 1.2; margin: 0 0 4mm; color: #4f46e5; }
  h2 { font-size: 17pt; margin: 13mm 0 4mm; padding-bottom: 2mm; border-bottom: 1.5pt solid #4f46e5; }
  h2#spis-treści + ol { break-after: page; }
  h3 { font-size: 13pt; margin: 7mm 0 2mm; }
  h2, h3 { break-after: avoid; line-height: 1.25; }
  p:has(+ figure), p:has(+ table) { break-after: avoid; }
  hr { display: none; }
  p, ul, ol { margin: 0 0 3mm; orphans: 3; widows: 3; }
  ul, ol { padding-left: 6mm; }
  li { margin-bottom: 0.8mm; }
  a { color: #4f46e5; text-decoration: none; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 4mm; font-size: 9.5pt; }
  th, td { border: 0.5pt solid #d0d7de; padding: 1.3mm 2.2mm; text-align: left; vertical-align: top; }
  th { background: #f3f4f8; }
  table, tr { break-inside: avoid; }
  thead { display: table-header-group; }
  code { font: 9pt Consolas, Menlo, monospace; background: #f3f4f8; border-radius: 2pt; padding: 0.2mm 1mm; }
  kbd { font: 8.5pt Consolas, Menlo, monospace; border: 0.5pt solid #b6bcc6; border-bottom-width: 1pt; border-radius: 2.5pt; padding: 0.1mm 1.2mm; background: #fafbfc; }
  blockquote { margin: 0 0 4mm; padding: 2mm 4mm; border-left: 2.5pt solid #4f46e5; background: #f5f5fd; break-inside: avoid; }
  blockquote p { margin: 0; }
  figure { margin: 3mm 0 5mm; break-inside: avoid; text-align: center; }
  figure img { max-width: 100%; margin: 0 1mm; border: 0.5pt solid #d0d7de; border-radius: 3pt; display: inline-block; }
  figcaption { font-size: 9pt; color: #59636e; margin-top: 1.2mm; }
`;

const markdown = readFileSync(source, 'utf8');
const dir = dirname(source);
const sizes = await imageSizes(markdown, dir);
const used = new Map<string, number>();

const marked = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth, text }) {
      const base = slug(text);
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      return `<h${depth} id="${escapeHtml(n ? `${base}-${n}` : base)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    image({ href, text }) {
      const size = sizes.get(href);
      const box = size ? ` width="${size.width}" height="${size.height}"` : '';
      return `<img src="${escapeHtml(pathToFileURL(join(dir, href)).href)}" alt="${escapeHtml(text)}"${box}>`;
    },
    // Akapit „obraz + podpis kursywą” → <figure>.
    paragraph({ tokens }) {
      if (tokens[0]?.type !== 'image') return `<p>${this.parser.parseInline(tokens)}</p>\n`;
      const caption = tokens.find((t) => t.type === 'em');
      return `<figure>${this.parser.parseInline(tokens.filter((t) => t.type === 'image'))}${caption ? `<figcaption>${this.parser.parseInline('tokens' in caption ? (caption.tokens ?? []) : [])}</figcaption>` : ''}</figure>\n`;
    },
  },
});

const title = /^#\s+(.+)$/m.exec(markdown)?.[1] ?? 'Instrukcja';
const body = marked.parse(markdown, { async: false });
const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;

// Plik (nie `setContent`), bo strona `about:blank` nie może czytać obrazów `file://`.
const temp = mkdtempSync(join(tmpdir(), 'tp-docs-'));
// Przeglądarka Playwrighta, a bez niej zainstalowany Chrome albo Edge.
const launch = async () => {
  for (const channel of [undefined, 'chrome', 'msedge']) {
    try {
      return await chromium.launch(channel ? { channel } : {});
    } catch (error) {
      if (channel === 'msedge') throw error;
    }
  }
  throw new Error('Brak przeglądarki.');
};

const browser = await launch();
try {
  const page = await browser.newPage();
  const file = join(temp, 'instrukcja.html');
  writeFileSync(file, html);
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  const problems = await page.evaluate(() => [
    ...[...document.images].filter((img) => !img.naturalWidth).map((img) => `brak obrazu: ${img.src}`),
    ...[...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')].filter((a) => !document.getElementById(decodeURIComponent(a.hash.slice(1)))).map((a) => `brak kotwicy: ${a.hash}`),
  ]);
  if (problems.length) throw new Error(problems.join('\n'));
  await page.pdf({
    path: target,
    preferCSSPageSize: true,
    printBackground: true,
    outline: true,
    tagged: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `<div style="width:100%;padding:0 15mm;font:8pt 'Segoe UI',Arial,sans-serif;color:#59636e;display:flex;justify-content:space-between"><span>${escapeHtml(title)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
  });
} finally {
  await browser.close();
  rmSync(temp, { recursive: true, force: true });
}
console.log(`Zapisano ${target}`);
