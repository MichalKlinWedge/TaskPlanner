import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { completionId, tagId, uuidv5, uuidv7 } from '../ids.ts';

const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('UUIDv5', () => {
  it('wektor wzorcowy (python: uuid5(NAMESPACE_DNS, "python.org"))', () => {
    expect(uuidv5('python.org', DNS)).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('SHA-1 zgodne z node:crypto dla długich i wielobajtowych nazw', () => {
    for (const name of ['', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(64), 'zażółć gęślą jaźń'.repeat(9)]) {
      const ns = Buffer.from(DNS.replace(/-/g, ''), 'hex');
      const digest = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
      digest[6] = (digest[6]! & 0x0f) | 0x50;
      digest[8] = (digest[8]! & 0x3f) | 0x80;
      const h = digest.subarray(0, 16).toString('hex');
      expect(uuidv5(name, DNS)).toBe(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`);
    }
  });

  it('ten sam wiersz z dwóch urządzeń ma ten sam id', () => {
    expect(completionId('t1', '2026-11-18')).toBe(completionId('t1', '2026-11-18'));
    expect(completionId('t1', '2026-11-18')).not.toBe(completionId('t1', '2026-11-19'));
    expect(tagId('u', 'Na Mieście')).toBe(tagId('u', 'na miescie'));
    expect(tagId('u', 'Łódź')).toBe(tagId('u', 'lodz'));
  });
});

describe('UUIDv7', () => {
  it('wersja, wariant i czas na początku', () => {
    const id = uuidv7(1_763_467_200_000);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(1_763_467_200_000);
  });
  it('sortowalne po czasie', () => {
    expect(uuidv7(1000) < uuidv7(2000)).toBe(true);
  });
});
