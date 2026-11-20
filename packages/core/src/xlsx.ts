/**
 * Minimalny zapis arkusza Excel (.xlsx, Office Open XML) bez zależności — eksport danych z widoków
 * (np. oś czasu). Plik ZIP bez kompresji (metoda „stored”), teksty jako `inlineStr`, daty jako
 * numery seryjne Excela z formatem daty, postęp jako procent. Pierwszy wiersz = nagłówki
 * (pogrubione, zamrożone, z autofiltrem). Czysty TS — działa w przeglądarce, na telefonie i w Deno.
 */
import type { LocalDate } from './schemas/primitives.ts';

/** Komórka: tekst, liczba, data (`{ date }`), procent 0–1 (`{ percent }`) albo pusta. */
export type XlsxCell = string | number | boolean | null | undefined | { date: LocalDate } | { percent: number };

export interface XlsxColumn {
  header: string;
  /** Szerokość w znakach. */
  width?: number;
}

export interface XlsxSheet {
  /** Nazwa karty (≤ 31 znaków, bez `[]:*?/\`). */
  name: string;
  columns: readonly XlsxColumn[];
  rows: readonly (readonly XlsxCell[])[];
  /** Wcięcie pierwszej kolumny tekstowej wiersza (0–9) — np. poziom podzadania; indeks kolumny w `indentColumn`. */
  indents?: readonly number[];
  indentColumn?: number;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Style (`cellXfs`): 0 zwykły, 1 nagłówek, 2 data, 3 procent, 4… wcięcie 1–9.
const STYLE_HEADER = 1;
const STYLE_DATE = 2;
const STYLE_PERCENT = 3;
const STYLE_INDENT = 3; // + poziom (1–9)
const MAX_INDENT = 9;

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

function cellXml(ref: string, value: XlsxCell, indent: number): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'object') {
    if ('date' in value) return `<c r="${ref}" s="${STYLE_DATE}"><v>${excelSerial(value.date)}</v></c>`;
    return Number.isFinite(value.percent) ? `<c r="${ref}" s="${STYLE_PERCENT}"><v>${value.percent}</v></c>` : '';
  }
  if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : '';
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const style = indent > 0 ? ` s="${STYLE_INDENT + Math.min(indent, MAX_INDENT)}"` : '';
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const cols = sheet.columns.length;
  const last = columnName(Math.max(cols - 1, 0));
  const header = `<row r="1">${sheet.columns.map((c, i) => `<c r="${columnName(i)}1" s="${STYLE_HEADER}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(c.header)}</t></is></c>`).join('')}</row>`;
  const body = sheet.rows
    .map((row, r) => {
      const indent = sheet.indents?.[r] ?? 0;
      const cells = row.map((v, c) => cellXml(`${columnName(c)}${r + 2}`, v, c === (sheet.indentColumn ?? -1) ? indent : 0)).join('');
      return `<row r="${r + 2}">${cells}</row>`;
    })
    .join('');
  const widths = sheet.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 12}" customWidth="1"/>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="A1:${last}${sheet.rows.length + 1}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${widths}</cols>` +
    `<sheetData>${header}${body}</sheetData>` +
    (cols ? `<autoFilter ref="A1:${last}${sheet.rows.length + 1}"/>` : '') +
    '</worksheet>'
  );
}

function stylesXml(): string {
  const indents = Array.from({ length: MAX_INDENT }, (_, i) => `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment indent="${i + 1}"/></xf>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${4 + MAX_INDENT}">` +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    indents +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

/** Pliki pakietu .xlsx (ścieżka → XML). */
export function xlsxParts(sheets: readonly XlsxSheet[]): [string, string][] {
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
          .map((n, i) => (sheets[i]!.columns.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${escapeXml(n.replace(/'/g, "''"))}'!$A$1:$${columnName(sheets[i]!.columns.length - 1)}$${sheets[i]!.rows.length + 1}</definedName>` : ''))
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
    ['xl/styles.xml', stylesXml()],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
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
