import { describe, expect, it } from 'vitest';
import { pdfDocument, pdfPageSize, PDF_PAPER } from '../pdf.ts';

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');
/** Udawany JPEG: nagłówek SOI, bajty > 127, koniec EOI. */
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x80, 0x90, 0xa0, 0xff, 0xd9]);

describe('pdfDocument', () => {
  const doc = pdfDocument(
    [
      { ...pdfPageSize('a4', 'landscape'), images: [{ jpeg, pixelWidth: 300, pixelHeight: 200, x: 28, y: 28, width: 300, height: 200 }], texts: [{ text: 'Strona 1 z 2 (wiersz 1)', x: 28, y: 580, size: 8 }] },
      { ...pdfPageSize('a3', 'portrait'), images: [{ jpeg, pixelWidth: 10, pixelHeight: 10, x: 0, y: 0, width: 100, height: 100 }] },
    ],
    { title: 'Burza mózgów — Łódź', created: new Date(Date.UTC(2026, 10, 23, 12, 0, 0)) },
  );
  const text = latin1(doc);

  it('nagłówek, zakończenie i liczba stron', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Pages /Kids [5 0 R 8 0 R] /Count 2');
    expect(text).toContain(`/MediaBox [0 0 ${Math.round(PDF_PAPER.a4.height * 100) / 100} ${Math.round(PDF_PAPER.a4.width * 100) / 100}]`);
  });

  it('tablica xref wskazuje początki obiektów', () => {
    const start = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe('xref');
    const [, count] = /xref\n0 (\d+)\n/.exec(text.slice(start))!;
    const entries = text.slice(start).split('\n').slice(3, 2 + Number(count));
    entries.forEach((line, i) => {
      const offset = Number(line.slice(0, 10));
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(text).toContain(`/Size ${count} /Root 1 0 R /Info 3 0 R`);
  });

  it('obraz JPEG wstawiony bez zmian z poprawną długością i położeniem od góry strony', () => {
    expect(text).toContain(`/Width 300 /Height 200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length}`);
    expect(text).toContain(`stream\n${latin1(jpeg)}\nendstream`);
    // y od góry 28 → od dołu: 595.28 − 28 − 200.
    expect(text).toContain('q 300 0 0 200 28 367.28 cm /Im0 Do Q');
  });

  it('tekst stopki Helvetica i tytuł w UTF-16', () => {
    expect(text).toContain('/F1 8 Tf 28 15.28 Td (Strona 1 z 2 \\(wiersz 1\\)) Tj');
    expect(text).toContain('/Title <FEFF004200750072007A00610020006D00F3007A006700F30077002020140020014100F30064017A>');
    expect(text).toContain('/CreationDate (D:20261123120000Z)');
  });

  it('polskie litery w tekście strony bez ogonków', () => {
    const pl = latin1(pdfDocument([{ width: 100, height: 100, texts: [{ text: 'Łąka – żółw', x: 0, y: 50, size: 8 }] }]));
    expect(pl).toContain('(Laka ? zolw) Tj');
  });

  it('bez stron — błąd', () => {
    expect(() => pdfDocument([])).toThrow();
  });
});
