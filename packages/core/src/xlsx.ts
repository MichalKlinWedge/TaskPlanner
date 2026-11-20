/**
 * Minimalny zapis arkusza Excel (.xlsx, Office Open XML) bez zależności — eksport danych z widoków
 * (np. oś czasu). Plik ZIP bez kompresji (metoda „stored”), teksty jako `inlineStr`, daty jako
 * numery seryjne Excela z formatem daty, postęp jako procent, komórki z kolorowym tłem (`{ fill }` —
 * np. paski osi czasu). Wiersz nagłówków (pogrubiony, zamrożony, z autofiltrem) może mieć nad sobą
 * dodatkowe wiersze nagłówka (`headerRows`, np. miesiące nad dniami) ze scaleniami (`merges`).
 * Czysty TS — działa w przeglądarce, na telefonie i w Deno.
 */
import type { LocalDate } from './schemas/primitives.ts';

/**
 * Komórka: tekst, liczba, data (`{ date }`), procent 0–1 (`{ percent }`), kolorowe tło z opcjonalnym
 * tekstem (`{ fill: '#rrggbb' }`) albo pusta.
 */
export type XlsxCell = string | number | boolean | null | undefined | { date: LocalDate } | { percent: number } | { fill: string; text?: string | number };

export interface XlsxColumn {
  header: string;
  /** Szerokość w znakach. */
  width?: number;
  /** Tło nagłówka (`#rrggbb`) — np. dzisiejszy dzień na osi; nagłówek z tłem jest wyśrodkowany. */
  fill?: string;
  /** Nagłówek wyśrodkowany (np. kolumny okresów). */
  center?: boolean;
}

export interface XlsxSheet {
  /** Nazwa karty (≤ 31 znaków, bez `[]:*?/\`). */
  name: string;
  columns: readonly XlsxColumn[];
  rows: readonly (readonly XlsxCell[])[];
  /** Wcięcie pierwszej kolumny tekstowej wiersza (0–9) — np. poziom podzadania; indeks kolumny w `indentColumn`. */
  indents?: readonly number[];
  indentColumn?: number;
  /** Wiersze nagłówka nad wierszem `columns` (pogrubione, wyśrodkowane), np. miesiące nad dniami. */
  headerRows?: readonly (readonly XlsxCell[])[];
  /** Scalone zakresy, np. `A1:G1` (numeracja wierszy arkusza, z `headerRows`). */
  merges?: readonly string[];
  /** Ile pierwszych kolumn zamrozić przy przewijaniu w bok. */
  freezeColumns?: number;
  /** Autofiltr na wierszu nagłówków; domyślnie włączony. */
  autoFilter?: boolean;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Style (`cellXfs`): 0 zwykły, 1 nagłówek, 2 data, 3 procent, 4–12 wcięcie 1–9, 13 nagłówek
// wyśrodkowany, dalej po dwa na każdy kolor tła: komórka z tłem, nagłówek z tłem.
const STYLE_HEADER = 1;
const STYLE_DATE = 2;
const STYLE_PERCENT = 3;
const STYLE_INDENT = 3; // + poziom (1–9)
const MAX_INDENT = 9;
const STYLE_HEADER_CENTER = 4 + MAX_INDENT;
const STYLE_FILL = STYLE_HEADER_CENTER + 1; // + 2 × indeks koloru (+ 1 = nagłówek)

/** `#rrggbb` / `rrggbb` → `FFRRGGBB` (ARGB Excela); zły kolor = szary. */
export function argb(color: string): string {
  const hex = color.replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{6}$/.test(hex)) return `FF${hex}`;
  if (/^[0-9A-F]{3}$/.test(hex)) return `FF${[...hex].map((c) => c + c).join('')}`;
  return 'FFD1D5DB';
}

/** Kolory tła użyte w skoroszycie → indeks (style `STYLE_FILL + 2 × indeks`). */
type Fills = Map<string, number>;

const isFill = (value: XlsxCell): value is { fill: string; text?: string | number } => typeof value === 'object' && value !== null && 'fill' in value;

const escapeXml = (s: string) =>
  s
    // Znaki sterujące niedozwolone w XML 1.0 (poza tab / LF / CR).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Litery kolumny: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** Numer seryjny daty w Excelu (dni od 30.12.1899). */
export function excelSerial(date: LocalDate): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!) / 86_400_000 + 25_569;
}

/** Nazwa karty dozwolona w Excelu. */
export function sheetName(name: string): string {
  const clean = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  return clean || 'Arkusz';
}

const textXml = (ref: string, style: number, text: string) =>
  `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;

function cellXml(ref: string, value: XlsxCell, indent: number, fills: Fills, header = false): string {
  if (value === null || value === undefined || value === '') return '';
  if (isFill(value)) {
    const style = STYLE_FILL + 2 * fills.get(argb(value.fill))! + (header ? 1 : 0);
    if (typeof value.text === 'number') return `<c r="${ref}" s="${style}"><v>${value.text}</v></c>`;
    return value.text ? textXml(ref, style, value.text) : `<c r="${ref}" s="${style}"/>`;
  }
  if (header) return typeof value === 'string' || typeof value === 'number' ? textXml(ref, STYLE_HEADER_CENTER, String(value)) : '';
  if (typeof value === 'object') {
    if ('date' in value) return `<c r="${ref}" s="${STYLE_DATE}"><v>${excelSerial(value.date)}</v></c>`;
    return Number.isFinite(value.percent) ? `<c r="${ref}" s="${STYLE_PERCENT}"><v>${value.percent}</v></c>` : '';
  }
  if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : '';
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const style = indent > 0 ? ` s="${STYLE_INDENT + Math.min(indent, MAX_INDENT)}"` : '';
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/** Wiersz nagłówków `columns` (numer wiersza arkusza, od 1). */
const headerRow = (sheet: XlsxSheet) => (sheet.headerRows?.length ?? 0) + 1;
const hasAutoFilter = (sheet: XlsxSheet) => sheet.columns.length > 0 && sheet.autoFilter !== false;

function sheetXml(sheet: XlsxSheet, fills: Fills): string {
  const cols = sheet.columns.length;
  const last = columnName(Math.max(cols - 1, 0));
  const head = headerRow(sheet);
  const lastRow = head + sheet.rows.length;
  const top = (sheet.headerRows ?? []).map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cellXml(`${columnName(c)}${r + 1}`, v, 0, fills, true)).join('')}</row>`).join('');
  const header = `<row r="${head}">${sheet.columns
    .map((c, i) => (c.fill ? cellXml(`${columnName(i)}${head}`, { fill: c.fill, text: c.header }, 0, fills, true) : textXml(`${columnName(i)}${head}`, c.center ? STYLE_HEADER_CENTER : STYLE_HEADER, c.header)))
    .join('')}</row>`;
  const body = sheet.rows
    .map((row, r) => {
      const indent = sheet.indents?.[r] ?? 0;
      const cells = row.map((v, c) => cellXml(`${columnName(c)}${head + 1 + r}`, v, c === (sheet.indentColumn ?? -1) ? indent : 0, fills)).join('');
      return `<row r="${head + 1 + r}">${cells}</row>`;
    })
    .join('');
  const widths = sheet.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 12}" customWidth="1"/>`).join('');
  const x = Math.min(sheet.freezeColumns ?? 0, cols);
  const pane = x
    ? `<pane xSplit="${x}" ySplit="${head}" topLeftCell="${columnName(x)}${head + 1}" activePane="bottomRight" state="frozen"/>`
    : `<pane ySplit="${head}" topLeftCell="A${head + 1}" activePane="bottomLeft" state="frozen"/>`;
  const merges = sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="A1:${last}${lastRow}"/>` +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    `<cols>${widths}</cols>` +
    `<sheetData>${top}${header}${body}</sheetData>` +
    (hasAutoFilter(sheet) ? `<autoFilter ref="A${head}:${last}${lastRow}"/>` : '') +
    merges +
    '</worksheet>'
  );
}

/** Kolory tła ze wszystkich kart, w kolejności pierwszego użycia. */
function collectFills(sheets: readonly XlsxSheet[]): Fills {
  const fills: Fills = new Map();
  const add = (color: string) => fills.has(argb(color)) || fills.set(argb(color), fills.size);
  for (const s of sheets) {
    for (const c of s.columns) if (c.fill) add(c.fill);
    for (const row of [...(s.headerRows ?? []), ...s.rows]) for (const v of row) if (isFill(v)) add(v.fill);
  }
  return fills;
}

function stylesXml(fills: Fills): string {
  const indents = Array.from({ length: MAX_INDENT }, (_, i) => `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment indent="${i + 1}"/></xf>`).join('');
  // Komórka z tłem: cienka biała ramka (paski osi oddzielone jak w Gantcie); nagłówek z tłem pogrubiony.
  const colored = [...fills.keys()]
    .map((_, i) => `<xf numFmtId="0" fontId="0" fillId="${2 + i}" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf><xf numFmtId="0" fontId="1" fillId="${2 + i}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf>`)
    .join('');
  const fillXml = [...fills.keys()].map((c) => `<fill><patternFill patternType="solid"><fgColor rgb="${c}"/><bgColor indexed="64"/></patternFill></fill>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    `<fills count="${2 + fills.size}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fillXml}</fills>` +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left style="thin"><color rgb="FFFFFFFF"/></left><right style="thin"><color rgb="FFFFFFFF"/></right><top style="thin"><color rgb="FFFFFFFF"/></top><bottom style="thin"><color rgb="FFFFFFFF"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${STYLE_FILL + 2 * fills.size}">` +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    indents +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
    colored +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

/** Pliki pakietu .xlsx (ścieżka → XML). */
export function xlsxParts(sheets: readonly XlsxSheet[]): [string, string][] {
  const fills = collectFills(sheets);
  const used = new Set<string>();
  const names = sheets.map((s) => {
    const base = sheetName(s.name);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
    used.add(name.toLowerCase());
    return name;
  });
  return [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
        `<definedNames>${names
          .map((n, i) => {
            const s = sheets[i]!;
            const head = headerRow(s);
            return hasAutoFilter(s) ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${escapeXml(n.replace(/'/g, "''"))}'!$A$${head}:$${columnName(s.columns.length - 1)}$${head + s.rows.length}</definedName>` : '';
          })
          .join('')}</definedNames>` +
        '</workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ],
    ['xl/styles.xml', stylesXml(fills)],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s, fills)]),
  ];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Archiwum ZIP bez kompresji (metoda 0), nazwy w UTF-8. */
export function zipStored(files: readonly { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // Stała data 1.01.1980 — ten sam plik z tych samych danych.
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, file.data.length, true);
    lv.setUint32(22, file.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, file.data.length, true);
    cv.setUint32(24, file.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    entry.set(name, 46);
    chunks.push(local, file.data);
    central.push(entry);
    offset += local.length + file.data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const c of [...chunks, ...central, end]) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Skoroszyt .xlsx z podanych kart. */
export function xlsxWorkbook(sheets: readonly XlsxSheet[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  return zipStored(xlsxParts(sheets).map(([name, xml]) => ({ name, data: encoder.encode(xml) })));
}
