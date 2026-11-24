/**
 * Konto AI (v1.x) — wspólny kod Edge Function `ai` (`_shared/ai/accounts.ts`) w Node, z podmienionym `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkAiKey, chooseModel, modelProblem, testPatch } from '../../../supabase/functions/_shared/ai/accounts.ts';

const KEY = `AQ.${'k'.repeat(50)}`;
const BASE = 'http://fake.test/gemini/v1beta';
const LIST = {
  models: [
    { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
  ],
};

let seen: { url: string; key: string | null }[] = [];
const respond = (status: number, body: unknown) => {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    seen.push({ url, key: new Headers(init?.headers).get('x-goog-api-key') });
    return Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) } as unknown as Response);
  }) as typeof fetch;
};

beforeEach(() => {
  seen = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('checkAiKey („Sprawdź”)', () => {
  it('modele tekstowe z listy i Flash-Lite jako domyślny; klucz tylko w nagłówku, adres z konfiguracji testów', async () => {
    respond(200, LIST);
    const result = await checkAiKey('gemini', KEY, null, { gemini: BASE });
    expect(result).toEqual({
      ok: true,
      models: [{ id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' }, { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }],
      model: 'gemini-3.5-flash-lite',
    });
    expect(seen).toEqual([{ url: `${BASE}/models?pageSize=200`, key: KEY }]);
  });

  it('zostawia wybrany model, jeśli klucz nadal go zwraca', async () => {
    respond(200, LIST);
    expect(await checkAiKey('gemini', KEY, 'gemini-3.8-flash', { gemini: BASE })).toMatchObject({ ok: true, model: 'gemini-3.8-flash' });
  });

  it('zły klucz (400 INVALID_ARGUMENT) → „Nieprawidłowy klucz”, badKey', async () => {
    respond(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
    expect(await checkAiKey('gemini', KEY, null)).toEqual({ ok: false, error: 'Nieprawidłowy klucz Gemini — skopiuj go jeszcze raz w całości z AI Studio.', badKey: true });
    expect(seen[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200');
  });

  it('limit u dostawcy to nie zły klucz', async () => {
    respond(429, { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } });
    expect(await checkAiKey('gemini', KEY, null)).toMatchObject({ ok: false, badKey: false });
  });
});

describe('testPatch', () => {
  const now = new Date('2026-11-23T12:00:00Z');

  it('udane „Sprawdź” → active, modele, model, verified_at', () => {
    expect(testPatch({ ok: true, models: [{ id: 'gemini-3.5-flash-lite', label: 'L' }], model: 'gemini-3.5-flash-lite' }, 'unverified', now)).toEqual({
      status: 'active',
      models: [{ id: 'gemini-3.5-flash-lite', label: 'L' }],
      model: 'gemini-3.5-flash-lite',
      verified_at: '2026-11-23T12:00:00.000Z',
      last_error: null,
    });
  });

  it('zły klucz → error; przejściowa awaria zostawia stan', () => {
    expect(testPatch({ ok: false, error: 'zły', badKey: true }, 'active', now)).toEqual({ status: 'error', last_error: 'zły' });
    expect(testPatch({ ok: false, error: 'limit', badKey: false }, 'active', now)).toEqual({ status: 'active', last_error: 'limit' });
  });
});

describe('wybór modelu', () => {
  const models = [{ id: 'gemini-3.5-flash-lite', label: 'L' }, { id: 'gemini-3.8-flash', label: 'F' }];

  it('chooseModel: obecny z listy albo domyślny', () => {
    expect(chooseModel('gemini-3.8-flash', models)).toBe('gemini-3.8-flash');
    expect(chooseModel('gemini-2.0-wycofany', models)).toBe('gemini-3.5-flash-lite');
    expect(chooseModel(null, [])).toBeNull();
  });

  it('modelProblem: tylko z listy ostatniego „Sprawdź”', () => {
    expect(modelProblem('gemini-3.8-flash', models)).toBeNull();
    expect(modelProblem('gemini-9-zmyslony', models)).toContain('Sprawdź');
    expect(modelProblem('gemini-9-zmyslony', [])).toBeNull();
  });
});
