import { describe, expect, it } from 'vitest';

import {
  ClientErrorReport,
  describeError,
  errorFingerprint,
  errorReport,
  isTransientError,
  normalizeMessage,
  parseErrorQueue,
  queueError,
  settleQueue,
  topFrame,
} from '../errors.ts';

const now = new Date('2026-11-19T18:00:00Z');
const later = new Date('2026-11-19T18:05:00Z');

const V8 = `TypeError: Cannot read properties of undefined (reading 'title')
    at TaskRow (https://app.test/_next/static/chunks/0a1b2c3d4e5f.js:1:2345)
    at renderWithHooks (https://app.test/_next/static/chunks/framework-9f8e7d6c.js:1:99)`;
const V8_NEXT_DEPLOY = V8.replace('0a1b2c3d4e5f', 'ffeeddccbbaa').replace(':1:2345', ':1:2400');
const GECKO = `TaskRow@https://app.test/_next/static/chunks/0a1b2c3d4e5f.js:1:2345
renderWithHooks@https://app.test/_next/static/chunks/framework.js:1:99`;
const ANON = `Error: x
    at https://app.test/_next/static/chunks/page-1a2b3c4d5e.js:1:200`;

describe('treść błędu', () => {
  it('Error, napis, obiekt z message (błąd PostgREST), inne wartości', () => {
    expect(describeError(new TypeError('x is null'))).toMatchObject({ message: 'TypeError: x is null' });
    expect(describeError(new Error('zwykły')).message).toBe('zwykły');
    expect(describeError('napis')).toEqual({ message: 'napis' });
    expect(describeError({ code: '42501', message: 'permission denied' })).toEqual({ message: '42501: permission denied' });
    expect(describeError({ a: 1 })).toEqual({ message: '{"a":1}' });
    expect(describeError(undefined)).toEqual({ message: 'undefined' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeError(cyclic).message).toBe('[object Object]');
  });

  it('błędy sieci nie są błędami aplikacji', () => {
    expect(isTransientError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true);
    expect(isTransientError(new TypeError('Load failed'))).toBe(true);
    expect(isTransientError(Object.assign(new Error('przerwane'), { name: 'AbortError' }))).toBe(true);
    expect(isTransientError({ name: 'AuthRetryableFetchError', message: '' })).toBe(true);
    expect(isTransientError(new TypeError("Cannot read properties of undefined (reading 'title')"))).toBe(false);
    expect(isTransientError({ code: 'TP002', message: 'cykl rodziców' })).toBe(false);
  });
});

describe('odcisk', () => {
  it('bez id, liczb i skrótów paczek', () => {
    expect(normalizeMessage('Zadanie 0193a3c4-7b1e-7cc0-9a2b-1234567890ab nie istnieje (3 próby)')).toBe('Zadanie <id> nie istnieje (<n> próby)');
    expect(normalizeMessage('hash deadbeefcafe1234 zły')).toBe('hash <hex> zły');
  });

  it('pierwsza ramka: V8, Gecko, anonimowa', () => {
    expect(topFrame(V8)).toBe('TaskRow');
    expect(topFrame(GECKO)).toBe('TaskRow');
    expect(topFrame(ANON)).toBe('page-*.js');
    expect(topFrame(undefined)).toBe('');
  });

  it('ten sam błąd po nowym wdrożeniu i z innym id → ten sam odcisk; inny rodzaj lub miejsce → inny', () => {
    const a = errorFingerprint('render', "Cannot read properties of undefined (reading 'title')", V8);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(errorFingerprint('render', "Cannot read properties of undefined (reading 'title')", V8_NEXT_DEPLOY)).toBe(a);
    expect(errorFingerprint('error', "Cannot read properties of undefined (reading 'title')", V8)).not.toBe(a);
    expect(errorFingerprint('render', "Cannot read properties of undefined (reading 'title')", V8.replace('at TaskRow', 'at Board'))).not.toBe(a);
    expect(errorFingerprint('sync', 'Wiersz 0193a3c4-7b1e-7cc0-9a2b-1234567890ab')).toBe(errorFingerprint('sync', 'Wiersz 0193a3c4-0000-7cc0-9a2b-1234567890ff'));
  });
});

describe('raport i kolejka', () => {
  it('raport zgodny ze schematem RPC, obcięte długie pola', () => {
    const r = errorReport('error', new Error('x'.repeat(2000)), { platform: 'web', now, appVersion: 'abc1234', url: '/#/today', context: { view: 'today' } });
    expect(ClientErrorReport.safeParse(r).success).toBe(true);
    expect(r.message).toHaveLength(1000);
    expect(r).toMatchObject({ kind: 'error', platform: 'web', count: 1, firstAt: now.toISOString(), lastAt: now.toISOString(), appVersion: 'abc1234', context: { view: 'today' } });
    const long = new Error('długi stos');
    long.stack = Array.from({ length: 100 }, (_, i) => `    at f${i} (a.js:${i}:1)`).join('\n');
    expect(errorReport('error', long, { platform: 'web', now }).stack!.split('\n')).toHaveLength(30);
    expect(errorReport('error', 'napis', { platform: 'web', now, context: {} })).not.toHaveProperty('context');
  });

  it('ten sam odcisk → licznik, inne → nowe pozycje, najwyżej max', () => {
    const a = errorReport('error', new Error('A'), { platform: 'web', now });
    const a2 = errorReport('error', new Error('A'), { platform: 'web', now: later });
    let q = queueError([], a);
    q = queueError(q, a2);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ count: 2, firstAt: now.toISOString(), lastAt: later.toISOString() });
    for (let i = 0; i < 60; i++) q = queueError(q, errorReport('error', new Error(`B${'x'.repeat(i)}`), { platform: 'web', now }), 50);
    expect(q).toHaveLength(50);
    expect(q.some((x) => x.fingerprint === a.fingerprint)).toBe(false);
  });

  it('po wysyłce zostaje tylko to, co doszło w trakcie', () => {
    const a = errorReport('error', new Error('A'), { platform: 'web', now });
    const b = errorReport('error', new Error('B'), { platform: 'web', now });
    const sent = queueError(queueError([], a), b);
    const during = queueError(sent, errorReport('error', new Error('A'), { platform: 'web', now: later }));
    const left = settleQueue(during, sent);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ fingerprint: a.fingerprint, count: 1 });
    expect(settleQueue(sent, sent)).toEqual([]);
  });

  it('uszkodzona kolejka z pamięci', () => {
    const a = errorReport('error', new Error('A'), { platform: 'web', now });
    expect(parseErrorQueue([a, { fingerprint: 'x' }, null, 'zły'])).toEqual([a]);
    expect(parseErrorQueue('nie lista')).toEqual([]);
  });
});
