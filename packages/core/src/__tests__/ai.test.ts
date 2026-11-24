import { describe, expect, it } from 'vitest';

import { AI_BILLING_REQUIRED, AiAccountCreate, AiAccountUpdate, aiAccountReady, aiKeyHint, aiModelLabel, parseAiAccount } from '../ai.ts';

/** Konto AI (v1.x): wejście tras `ai/accounts/*` i wiersz `ai_accounts` u klienta (bez klucza). */

const AUTH_KEY = `AQ.${'A1b2'.repeat(12)}xy`; // 53 znaki, format nowych auth keys — zmyślony
const OLD_KEY = `AIza${'x'.repeat(35)}`;
const ID = '019a0000-0000-7000-8000-000000000001';

describe('AiAccountCreate', () => {
  it('przyjmuje stare i nowe klucze bez sprawdzania prefiksu', () => {
    expect(AUTH_KEY).toHaveLength(53);
    expect(AiAccountCreate.parse({ provider: 'gemini', key: ` ${AUTH_KEY}\n`, billingConfirmed: true }).key).toBe(AUTH_KEY);
    expect(AiAccountCreate.safeParse({ provider: 'gemini', key: OLD_KEY, billingConfirmed: true }).success).toBe(true);
    expect(AiAccountCreate.safeParse({ provider: 'gemini', key: `sk-${'z'.repeat(30)}`, billingConfirmed: true }).success).toBe(true);
  });

  it('bez oświadczenia o rozliczeniu nie przechodzi', () => {
    const result = AiAccountCreate.safeParse({ provider: 'gemini', key: AUTH_KEY, billingConfirmed: false });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(AI_BILLING_REQUIRED);
  });

  it('odrzuca za krótki klucz, spacje w środku i nieznanego dostawcę', () => {
    expect(AiAccountCreate.safeParse({ provider: 'gemini', key: 'AQ.krotki', billingConfirmed: true }).success).toBe(false);
    expect(AiAccountCreate.safeParse({ provider: 'gemini', key: 'AQ.abc def ghi jkl mno pqr', billingConfirmed: true }).success).toBe(false);
    expect(AiAccountCreate.safeParse({ provider: 'openai', key: AUTH_KEY, billingConfirmed: true }).success).toBe(false);
  });
});

describe('AiAccountUpdate', () => {
  it('nowy klucz tylko z ponownym oświadczeniem; sam model bez', () => {
    expect(AiAccountUpdate.safeParse({ accountId: ID, key: AUTH_KEY }).success).toBe(false);
    expect(AiAccountUpdate.safeParse({ accountId: ID, key: AUTH_KEY, billingConfirmed: true }).success).toBe(true);
    expect(AiAccountUpdate.safeParse({ accountId: ID, model: 'gemini-3.5-flash-lite' }).success).toBe(true);
    expect(AiAccountUpdate.safeParse({ accountId: ID, model: 'Gemini 3.5 Flash-Lite' }).success).toBe(false);
  });
});

describe('parseAiAccount', () => {
  const row = {
    id: ID,
    scope_id: 'u',
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
    models: JSON.stringify([{ id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' }, { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }]),
    key_hint: '…1b2x',
    status: 'active',
    last_error: null,
    verified_at: '2026-11-23T10:00:00Z',
    billing_confirmed_at: '2026-11-23T09:59:00Z',
    deleted_at: null,
  };

  it('wiersz lokalnej bazy (jsonb jako tekst) → konto gotowe do funkcji ✨', () => {
    const account = parseAiAccount(row);
    expect(account).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash-lite', keyHint: '…1b2x', status: 'active' });
    expect(account?.models).toHaveLength(2);
    expect(aiAccountReady(account)).toBe(true);
    expect(aiModelLabel(account!)).toBe('Gemini 3.5 Flash-Lite');
    expect(aiModelLabel(account!, 'gemini-9-nieznany')).toBe('gemini-9-nieznany');
  });

  it('usunięte, nieznany dostawca → null; zepsuta lista modeli → pusta; bez modelu nie gotowe', () => {
    expect(parseAiAccount({ ...row, deleted_at: '2026-11-23T11:00:00Z' })).toBeNull();
    expect(parseAiAccount({ ...row, provider: 'claude' })).toBeNull();
    expect(parseAiAccount({ ...row, models: '{zepsute' })?.models).toEqual([]);
    expect(aiAccountReady(parseAiAccount({ ...row, model: null }))).toBe(false);
    expect(aiAccountReady(parseAiAccount({ ...row, status: 'error' }))).toBe(false);
  });

  it('klient widzi tylko końcówkę klucza', () => {
    expect(aiKeyHint(` ${AUTH_KEY} `)).toBe('…b2xy');
  });
});
