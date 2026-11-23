/**
 * Minimalny zapis PDF 1.4 bez zależności (w duchu `xlsx.ts`) — eksport obrazów, np. tablicy
 * „Karteczki”. Strona = obrazy JPEG wstawione bez przekodowania (`DCTDecode`, bajty prosto z
 * `canvas.toBlob('image/jpeg')`) i opcjonalne krótkie teksty Helvetica (tylko ASCII — np. numer
 * strony; polskie litery są w obrazie). Tytuł dokumentu w `/Info` jako UTF-16 (polskie znaki).
 * Współrzędne w punktach (1/72 cala) od lewego górnego rogu strony. Czysty TS.
 */

export const PDF_MIME = 'application/pdf';

/** Rozmiary papieru w punktach, pionowo. */
export const PDF_PAPER = {
  a4: { width: 595.28, height: 841.89 },
  a3: { width: 841.89, height: 1190.55 },
} as const;
export type PdfPaper = keyof typeof PDF_PAPER;
export type PdfOrientation = 'landscape' | 'portrait';

/** Rozmiar strony (pt) dla papieru i orientacji. */
export function pdfPageSize(paper: PdfPaper, orientation: PdfOrientation): { width: number; height: number } {
  const { width, height } = PDF_PAPER[paper];
  return orientation === 'landscape' ? { width: height, height: width } : { width, height };
}

export interface PdfImage {
  /** Plik JPEG (RGB). */
  jpeg: Uint8Array;
  /** Wymiary obrazu w pikselach. */
  pixelWidth: number;
  pixelHeight: number;
  /** Miejsce na stronie (pt, od lewego górnego rogu). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfText {
  text: string;
  /** Lewy koniec linii bazowej (pt, od lewego górnego rogu). */
  x: number;
  y: number;
  size: number;
  /** Szary 0 (czarny) – 1 (biały); domyślnie 0,45. */
  gray?: number;
}

export interface PdfPage {
  width: number;
  height: number;
  images?: readonly PdfImage[];
  texts?: readonly PdfText[];
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();

/** Tekst do Helvetica: tylko drukowalne ASCII (polskie litery bez ogonków, reszta → „?”), nawiasy i `\` z ucieczką. */
function pdfString(text: string): string {
  const ascii = text
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
  return `(${ascii.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/** Tekst UTF-16BE z BOM jako ciąg szesnastkowy (`/Title` z polskimi znakami). */
function pdfUnicode(text: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

/** Data PDF `D:RRRRMMDDGGmmSSZ` (UTC). */
function pdfDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

/** Tekst ASCII → bajty (wszystko poza strumieniami obrazów jest ASCII). */
function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Dokument PDF ze stron. Obiekty: 1 katalog, 2 drzewo stron, 3 informacje, 4 czcionka, potem dla
 * każdej strony: strona, treść, obrazy.
 */
export function pdfDocument(pages: readonly PdfPage[], { title, created = new Date() }: { title?: string; created?: Date } = {}): Uint8Array {
  if (!pages.length) throw new Error('PDF bez stron.');
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: string, stream?: Uint8Array) => {
    offsets[id] = length;
    if (!stream) return push(ascii(`${id} 0 obj\n${body}\nendobj\n`));
    push(ascii(`${id} 0 obj\n${body}\nstream\n`));
    push(stream);
    push(ascii('\nendstream\nendobj\n'));
  };

  // Nagłówek z bajtami > 127 w komentarzu — znak dla narzędzi, że plik jest binarny.
  push(ascii('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'));

  const FIRST_PAGE = 5;
  const pageIds: number[] = [];
  let next = FIRST_PAGE;
  const plan = pages.map((page) => {
    const id = next;
    const images = (page.images ?? []).map((_, i) => id + 2 + i);
    next = id + 2 + images.length;
    pageIds.push(id);
    return { page, id, content: id + 1, images };
  });

  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  object(3, `<< ${title ? `/Title ${pdfUnicode(title)} ` : ''}/Producer (Task Planner) /CreationDate (${pdfDate(created)}) >>`);
  object(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  for (const { page, id, content, images } of plan) {
    const xobjects = images.map((ref, i) => `/Im${i} ${ref} 0 R`).join(' ');
    const resources = `<< /Font << /F1 4 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >>`;
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Resources ${resources} /Contents ${content} 0 R >>`);
    const ops: string[] = [];
    (page.images ?? []).forEach((img, i) => {
      ops.push(`q ${num(img.width)} 0 0 ${num(img.height)} ${num(img.x)} ${num(page.height - img.y - img.height)} cm /Im${i} Do Q`);
    });
    for (const t of page.texts ?? []) {
      ops.push(`BT ${num(t.gray ?? 0.45)} g /F1 ${num(t.size)} Tf ${num(t.x)} ${num(page.height - t.y)} Td ${pdfString(t.text)} Tj ET`);
    }
    const stream = ascii(ops.join('\n'));
    object(content, `<< /Length ${stream.length} >>`, stream);
    (page.images ?? []).forEach((img, i) => {
      object(
        images[i]!,
        `<< /Type /XObject /Subtype /Image /Width ${Math.round(img.pixelWidth)} /Height ${Math.round(img.pixelHeight)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>`,
        img.jpeg,
      );
    });
  }

  const xref = length;
  const count = next;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(ascii(`${table}trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
