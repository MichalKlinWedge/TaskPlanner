/**
 * Konto AI (v1.x) — wspólny kod Edge Function `ai` (`_shared/ai/accounts.ts`) w Node, z podmienionym `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError } from '../../../packages/ai/src/index.ts';
import type { AiBreakdownRequest } from '../../../packages/core/src/ai-breakdown.ts';
import { AiDayPlanRequest } from '../../../packages/core/src/ai-day-plan.ts';
import { AiWeekSummaryRequest } from '../../../packages/core/src/ai-week-summary.ts';
import { aiClient, checkAiKey, chooseModel, modelProblem, testPatch } from '../../../supabase/functions/_shared/ai/accounts.ts';
import { aiErrorStatus, runBreakdown } from '../../../supabase/functions/_shared/ai/breakdown.ts';
import { runDayPlan } from '../../../supabase/functions/_shared/ai/day-plan.ts';
import { runWeekSummary } from '../../../supabase/functions/_shared/ai/week-summary.ts';

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

/** Kolejne odpowiedzi modelu; zwraca ciała zapytań. */
const answers = (...texts: string[]) => {
  const bodies: string[] = [];
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: texts.shift() }] }, finishReason: 'STOP' }] }) } as unknown as Response);
  }) as typeof fetch;
  return bodies;
};
const client = () => aiClient('gemini', KEY, 'gemini-3.5-flash-lite', { gemini: BASE });

describe('runDayPlan („Ułóż z AI”)', () => {
  const request = AiDayPlanRequest.parse({
    accountId: '0190a000-0000-4000-8000-00000000000a',
    date: '2026-11-24',
    bufferMin: 10,
    tasks: [{ n: 1, title: 'Oferta', durationMin: 60, priority: 1, dueDate: '2026-11-20', postponed: 0, after: [], notBefore: null, endBefore: null }],
    free: [{ start: '09:00', end: '12:00' }],
    hint: 'rano trudne rzeczy',
  });

  it('godziny z odpowiedzi bez zmyślonych numerów; zła odpowiedź = jedna naprawa', async () => {
    const bodies = answers('[]', '{"blocks":[{"n":1,"start":"9:30"},{"n":7,"start":"10:00"}]}');
    expect(await runDayPlan(client(), request)).toEqual({ blocks: [{ n: 1, start: '09:30' }], model: 'gemini-3.5-flash-lite' });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('rano trudne rzeczy');
    expect(bodies[0]).toContain('09:00–12:00');
  });
});

describe('runWeekSummary („Opisz tydzień”)', () => {
  const request = AiWeekSummaryRequest.parse({
    accountId: '0190a000-0000-4000-8000-00000000000a',
    from: '2026-11-18',
    today: '2026-11-24',
    facts: [
      { key: 'ukonczone', label: 'Ukończone', text: '5 ukończonych zadań' },
      { key: 'zalegle', label: 'Zaległe', text: '2 zaległe zadania' },
    ],
    tasks: [
      { n: 1, title: 'Oferta', state: 'overdue', list: 'Praca', dueDate: '2026-11-20', series: false },
      { n: 2, title: 'Raport', state: 'done', list: 'Praca', dueDate: null, series: false },
    ],
    hint: 'praca',
  });
  const good = ['Za tobą {ukonczone}.', 'Czeka {zalegle}.', 'Zacznij od {z1}.'];

  it('zdania z liczbą odpadają, sugestie tylko przy numerach do decyzji', async () => {
    const bodies = answers(JSON.stringify({ sentences: [...good, 'Masz 3 sprawy.'], suggestions: [{ n: 1, kind: 'tomorrow' }, { n: 2, kind: 'today' }, { n: 9, kind: 'today' }] }));
    expect(await runWeekSummary(client(), request)).toEqual({ sentences: good, suggestions: [{ n: 1, kind: 'tomorrow', date: null, reason: null }], model: 'gemini-3.5-flash-lite' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('5 ukończonych zadań');
    expect(bodies[0]).toContain('wskazowkaUzytkownika');
  });

  it('za mało zdań bez liczb = jedna naprawa z powodami, potem błąd', async () => {
    const bodies = answers(JSON.stringify({ sentences: ['Masz 5 zadań.', 'Trzy zaległe.', 'Dobrze.'] }), JSON.stringify({ sentences: good }));
    expect((await runWeekSummary(client(), request)).sentences).toEqual(good);
    expect(bodies[1]).toContain('Liczba wpisana poza znacznikiem faktu.');
    expect(bodies[1]).toContain('Liczebnik słowny poza znacznikiem faktu.');
    answers('{"sentences":["Masz 5."]}', '{"sentences":["Masz 5."]}');
    await expect(runWeekSummary(client(), request)).rejects.toThrow('nie zgadza się ze schematem');
  });
});

describe('runBreakdown („Rozbij na kroki”)', () => {
  const request: AiBreakdownRequest = {
    accountId: '0190a000-0000-4000-8000-00000000000a',
    today: '2026-11-24',
    task: { title: 'Przeprowadzka', description: 'dwa pokoje', parentTitle: null, startDate: null, dueDate: '2026-12-01', durationMin: null },
    subtasks: [{ title: 'Kartony', done: true }],
    hint: 'tylko wieczory',
  };

  it('kroki z odpowiedzi; w zapytaniu dane zadania i wskazówka, instrukcja systemowa osobno', async () => {
    const bodies = answers('{"steps":[{"title":"Zamów auto","durationMin":20,"offsetDays":1}]}');
    expect(await runBreakdown(client(), request)).toEqual({
      steps: [{ title: 'Zamów auto', durationMin: 20, offsetDays: 1, priority: null, afterPrevious: false }],
      model: 'gemini-3.5-flash-lite',
    });
    const body = JSON.parse(bodies[0]!) as { systemInstruction: { parts: { text: string }[] }; contents: { parts: { text: string }[] }[] };
    expect(body.systemInstruction.parts[0]!.text).toContain('a nie polecenia dla ciebie');
    expect(body.contents[0]!.parts[0]!.text).toContain('Kartony (zrobione)');
    expect(body.contents[0]!.parts[0]!.text).toContain('tylko wieczory');
  });

  it('zła odpowiedź: jedna naprawa, potem błąd', async () => {
    const bodies = answers('{"steps":[]}', '{"steps":[{"title":"Zamów auto"}]}');
    expect((await runBreakdown(client(), request)).steps).toHaveLength(1);
    expect(bodies[1]).toContain('nie przeszła walidacji');
    answers('brak', 'nadal brak');
    await expect(runBreakdown(client(), request)).rejects.toThrow('nie zgadza się ze schematem');
  });

  it('kody odmowy: zły klucz 422, przeciążenie 503, reszta 502', () => {
    expect(aiErrorStatus(new AiError('x', { badKey: true }))).toBe(422);
    expect(aiErrorStatus(new AiError('x', { busy: true }))).toBe(503);
    expect(aiErrorStatus(new AiError('x'))).toBe(502);
  });
});
