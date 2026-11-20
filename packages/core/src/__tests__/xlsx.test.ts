/** Zapis .xlsx: ZIP bez kompresji (CRC, katalog centralny), arkusz z tekstem, datami i procentami. */
import { describe, expect, it } from 'vitest';

import { argb, columnName, crc32, excelSerial, sheetName, xlsxWorkbook, zipStored } from '../xlsx.ts';

/** Odczyt ZIP-a „stored” z katalogu centralnego (tylko do testu). */
function unzip(zip: Uint8Array): Map<string, string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map<string, string>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    const start = offset + 30 + view.getUint16(offset + 26, true);
    const data = zip.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    files.set(name, decoder.decode(data));
    at += 46 + nameLength;
  }
  return files;
}

describe('xlsx', () => {
  it('pomocnicze: CRC32, litery kolumn, numer seryjny daty, nazwa karty', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect([0, 25, 26, 51, 52, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
    expect(excelSerial('1900-03-01')).toBe(61);
    expect(excelSerial('2026-11-20')).toBe(46346);
    expect(sheetName('Plan: Q1/Q2 [kopia]')).toBe('Plan  Q1 Q2  kopia');
    expect(sheetName('  ')).toBe('Arkusz');
  });

  it('ZIP: pliki z polskimi nazwami wracają bez zmian', () => {
    const files = unzip(zipStored([{ name: 'a.txt', data: new TextEncoder().encode('ąę') }, { name: 'ż/ó.xml', data: new Uint8Array() }]));
    expect([...files]).toEqual([
      ['a.txt', 'ąę'],
      ['ż/ó.xml', ''],
    ]);
  });

  it('skoroszyt: nagłówki, tekst z XML-em, data, procent, liczba, wcięcie, puste komórki', () => {
    const files = unzip(
      xlsxWorkbook([
        {
          name: 'Oś czasu',
          columns: [{ header: 'Zadanie', width: 30 }, { header: 'Początek' }, { header: 'Postęp' }, { header: 'Dni' }],
          rows: [
            ['A & <B> "C"', { date: '2026-11-20' }, { percent: 0.5 }, 3],
            ['Podzadanie\u0007', null, { percent: 1 }, undefined],
          ],
          indents: [0, 2],
          indentColumn: 0,
        },
      ]),
    );
    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Oś czasu" sheetId="1" r:id="rId1"/>');
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Zadanie</t></is></c>');
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">A &amp; &lt;B&gt; &quot;C&quot;</t></is></c>');
    expect(sheet).toContain('<c r="B2" s="2"><v>46346</v></c><c r="C2" s="3"><v>0.5</v></c><c r="D2"><v>3</v></c>');
    expect(sheet).toContain('<row r="3"><c r="A3" s="5" t="inlineStr"><is><t xml:space="preserve">Podzadanie</t></is></c><c r="C3" s="3"><v>1</v></c></row>');
    expect(sheet).toContain('<autoFilter ref="A1:D3"/>');
    expect(sheet).toContain('<col min="1" max="1" width="30" customWidth="1"/>');
    expect(files.get('xl/styles.xml')).toContain('<alignment indent="2"/>');
  });

  it('kolorowe komórki, wiersz nagłówka nad kolumnami, scalenia, zamrożone kolumny, bez autofiltra', () => {
    expect([argb('#a1b2c3'), argb('fff'), argb('zły')]).toEqual(['FFA1B2C3', 'FFFFFFFF', 'FFD1D5DB']);
    const files = unzip(
      xlsxWorkbook([
        {
          name: 'Oś',
          columns: [{ header: 'Zadanie' }, { header: '20', center: true }, { header: '21', fill: '#fde68a' }],
          headerRows: [[null, 'listopad 2026', null]],
          merges: ['B1:C1'],
          freezeColumns: 1,
          autoFilter: false,
          rows: [['A', { fill: '#ff0000' }, { fill: '#FF0000', text: 'x' }]],
        },
      ]),
    );
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    // Style: 13 nagłówek wyśrodkowany, kolory w kolejności użycia (żółty = 14/15, czerwony = 16/17).
    expect(sheet).toContain('<row r="1"><c r="B1" s="13" t="inlineStr"><is><t xml:space="preserve">listopad 2026</t></is></c></row>');
    expect(sheet).toContain('<c r="B2" s="13" t="inlineStr">');
    expect(sheet).toContain('<c r="C2" s="15" t="inlineStr"><is><t xml:space="preserve">21</t></is></c>');
    expect(sheet).toContain('<row r="3"><c r="A3" t="inlineStr"><is><t xml:space="preserve">A</t></is></c><c r="B3" s="16"/><c r="C3" s="16" t="inlineStr"><is><t xml:space="preserve">x</t></is></c></row>');
    expect(sheet).toContain('<pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/>');
    expect(sheet).toContain('<mergeCells count="1"><mergeCell ref="B1:C1"/></mergeCells>');
    expect(sheet).not.toContain('autoFilter');
    expect(files.get('xl/workbook.xml')).not.toContain('_FilterDatabase');
    const styles = files.get('xl/styles.xml')!;
    expect(styles).toContain('<fills count="4">');
    expect(styles).toContain('<fgColor rgb="FFFDE68A"/>');
    expect(styles).toContain('<cellXfs count="18">');
  });

  it('powtórzone nazwy kart dostają numer', () => {
    const files = unzip(xlsxWorkbook([{ name: 'Plan', columns: [], rows: [] }, { name: 'plan', columns: [], rows: [] }]));
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Plan" sheetId="1" r:id="rId1"/><sheet name="plan 2" sheetId="2" r:id="rId2"/>');
  });
});
