/**
 * Przychodzące API (v1.x): `_shared/inbound-api.ts` — treść z limitem rozmiaru (także gdy `Content-Length`
 * kłamie), typ treści, mapowanie błędów bazy na statusy HTTP.
 */
import { describe, expect, it } from 'vitest';

import { dbError, InboundError, readJsonObject, readLimitedText } from '../../../supabase/functions/_shared/inbound-api.ts';

const request = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('http://x/inbound-api/tasks/ep:a:b', { method: 'PUT', body, headers: { 'content-type': 'application/json', ...headers } });

/** Strumień bez `Content-Length` (fetch z `duplex: 'half'`). */
const streamed = (text: string) =>
  new Request('http://x', {
    method: 'PUT',
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
    headers: { 'content-type': 'application/json' },
    // @ts-expect-error — Node wymaga `duplex` dla treści strumieniowej
    duplex: 'half',
  });

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof InboundError ? `${e.status} ${e.message}` : String(e);
  }
};

describe('readLimitedText', () => {
  it('czyta treść w limicie', async () => {
    expect(await readLimitedText(request('{"title":"Zażółć"}'), 100)).toBe('{"title":"Zażółć"}');
  });

  it('za duży Content-Length = 413 bez czytania', async () => {
    expect(await status(readLimitedText(request('{}', { 'content-length': '999999' }), 1024))).toBe('413 Treść za duża — najwyżej 1 KB.');
  });

  it('strumień ponad limit = 413', async () => {
    expect(await status(readLimitedText(streamed('x'.repeat(2048)), 1024))).toMatch(/^413/);
  });
});

describe('readJsonObject', () => {
  it('obiekt JSON', async () => {
    expect(await readJsonObject(request('{"a":1}'), 100)).toEqual({ a: 1 });
    expect(await readJsonObject(request('{"a":1}', { 'content-type': 'application/json; charset=utf-8' }), 100)).toEqual({ a: 1 });
  });

  it('błędy treści', async () => {
    expect(await status(readJsonObject(request('nie json'), 100))).toBe('400 Nieczytelny JSON.');
    expect(await status(readJsonObject(request('[1]'), 100))).toBe('400 Oczekiwano obiektu JSON.');
    expect(await status(readJsonObject(request('a=1', { 'content-type': 'application/x-www-form-urlencoded' }), 100))).toMatch(/^415/);
  });
});

describe('InboundError', () => {
  it('niesie details (ścieżki walidacji) i nagłówki', () => {
    const e = new InboundError(400, 'priority: zły', {}, [{ path: 'priority', message: 'zły' }]);
    expect(e).toMatchObject({ status: 400, message: 'priority: zły', details: [{ path: 'priority', message: 'zły' }] });
    expect(new InboundError(429, 'limit', { 'retry-after': '5' })).toMatchObject({ details: undefined, headers: { 'retry-after': '5' } });
  });
});

describe('dbError', () => {
  it('kody bazy → statusy HTTP z komunikatem z bazy', () => {
    expect(dbError({ code: 'TP003', message: 'Token odwołany' })).toMatchObject({ status: 403, message: 'Token odwołany' });
    expect(dbError({ code: 'P0002', message: 'Nie ma takiego tokenu' })?.status).toBe(404);
    expect(dbError({ code: '22023', message: 'Najwyżej 10 tokenów' })?.status).toBe(400);
    expect(dbError({ code: '57014', message: 'timeout' })).toBeNull();
    expect(dbError(null)).toBeNull();
  });
});
