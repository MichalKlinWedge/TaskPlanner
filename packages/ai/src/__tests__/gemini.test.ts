import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { askGemini, geminiModels, isInvalidKey } from '../gemini.ts';
import { defaultModel } from '../models.ts';
import { AiError, InvalidKeyError } from '../transport.ts';

/**
 * Różnice względem ExpeditionPlan sprawdzone na prawdziwym Gemini 23.11.2026 (`docs/USLUGI.md`):
 * klucz w nagłówku, nie w adresie; zły klucz = HTTP 400 `INVALID_ARGUMENT`; nowe „auth keys” `AQ.`.
 */

type Seen = { url: string; headers: Record<string, string> };
let seen: Seen[] = [];

const respond = (status: number, body: unknown) => {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response);
  }) as typeof globalThis.fetch;
};

/** Tak Google odrzuca zły klucz (także nowy auth key z literówką). */
const BAD_KEY = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
  },
};

/** Klucz w formacie nowych auth keys: `AQ.` + 50 znaków (razem 53) — zmyślony. */
const KEY = `AQ.${'x'.repeat(50)}`;

beforeEach(() => {
  seen = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('klucz w nagłówku', () => {
  it('lista modeli: `x-goog-api-key`, w adresie ani śladu klucza', async () => {
    respond(200, { models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] });

    await geminiModels(KEY);

    expect(seen[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200');
    expect(seen[0]?.headers['x-goog-api-key']).toBe(KEY);
    expect(seen[0]?.url).not.toContain('key=');
  });

  it('zapytanie do modelu: tak samo', async () => {
    respond(200, { candidates: [{ content: { parts: [{ text: '{}' }] } }] });

    await askGemini(KEY, 'gemini-3.5-flash-lite', 'Rozbij');

    expect(seen[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(seen[0]?.headers['x-goog-api-key']).toBe(KEY);
    expect(seen[0]?.headers['content-type']).toBe('application/json');
  });
});

describe('zły klucz', () => {
  it('lista modeli: 400 INVALID_ARGUMENT → `InvalidKeyError`, nie „nieprawidłowe zapytanie”', async () => {
    respond(400, BAD_KEY);

    const error = await geminiModels(KEY).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidKeyError);
    expect((error as AiError).badKey).toBe(true);
    expect((error as AiError).retryable).toBe(false);
    expect((error as Error).message).toBe('Nieprawidłowy klucz Gemini — skopiuj go jeszcze raz w całości z AI Studio.');
  });

  it('zapytanie do modelu: to samo, i model nie trafia na listę odrzuconych', async () => {
    respond(400, BAD_KEY);

    const error = await askGemini(KEY, 'gemini-3.5-flash-lite', 'Rozbij').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidKeyError);
    expect((error as AiError).modelGone).toBe(false);
  });

  it('403 (klucz bez uprawnień do Gemini API) to też odmowa z klucza', async () => {
    respond(403, { error: { code: 403, message: 'Method doesn\'t allow unregistered callers.', status: 'PERMISSION_DENIED' } });

    const error = await geminiModels(KEY).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(InvalidKeyError);
    expect((error as AiError).badKey).toBe(true);
  });

  it('isInvalidKey: po powodzie albo treści, tylko przy 400', () => {
    expect(isInvalidKey(400, BAD_KEY.error)).toBe(true);
    expect(isInvalidKey(400, { message: 'API key not valid. Please pass a valid API key.' })).toBe(true);
    expect(isInvalidKey(400, { message: 'Invalid JSON payload received.' })).toBe(false);
    expect(isInvalidKey(403, BAD_KEY.error)).toBe(false);
    expect(isInvalidKey(400, null)).toBe(false);
  });
});

describe('defaultModel', () => {
  const names = (...ids: string[]) => ids.map((id) => ({ id, label: id }));

  it('najnowszy stabilny Flash-Lite z listy', () => {
    expect(defaultModel(names('gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite-preview', 'gemini-3.8-flash', 'gemini-2.5-pro'))).toBe('gemini-3.5-flash-lite');
  });

  it('bez Flash-Lite najnowszy Flash, bez obu pierwszy z listy, z pustej nic', () => {
    expect(defaultModel(names('gemini-2.5-pro', 'gemini-3.5-flash', 'gemini-3.8-flash'))).toBe('gemini-3.8-flash');
    expect(defaultModel(names('gemini-2.5-pro', 'gemini-pro-latest'))).toBe('gemini-2.5-pro');
    expect(defaultModel([])).toBeNull();
  });
});
