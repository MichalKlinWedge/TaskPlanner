/**
 * Konto AI użytkownika (v1.x) — część Edge Function `ai` bez zależności od Deno (testy w Node: `tools/edge-tests`).
 *
 * „Sprawdź” = lista modeli na kluczu użytkownika (`packages/ai` `listModels`): udana daje modele tekstowe
 * do wyboru i stan `active`; zły klucz (Gemini: 400 `INVALID_ARGUMENT`) albo klucz bez uprawnień — stan `error`;
 * przejściowa awaria (sieć, limit, przeciążenie) zostawia stan bez zmian i zapisuje tylko `last_error`.
 */
import { AiError, createAiClient, defaultModel, type Provider } from '../../../../packages/ai/src/index.ts';
import type { AiAccountStatus, AiAccountTestResult, AiModelEntry, AiProvider } from '../../../../packages/core/src/ai.ts';

/** Adresy API zamiast prawdziwych — tylko testy integracyjne (`AI_TEST_GEMINI_BASE` w `.env.test`). */
export interface AiEndpoints {
  gemini?: string;
}

const PROVIDERS: Record<AiProvider, Provider> = { gemini: 'GEMINI' };

/** Najdłuższy zapisywany komunikat błędu (`ai_accounts.last_error`). */
const MAX_ERROR = 500;

/** Klient AI na kluczu użytkownika (do „Sprawdź” i do funkcji ✨). */
export function aiClient(provider: AiProvider, key: string, model: string | null, endpoints: AiEndpoints = {}) {
  const id = PROVIDERS[provider];
  return createAiClient({
    keys: { [id]: key },
    models: { [id]: model ?? undefined },
    defaultProvider: id,
    endpoints: { [id]: endpoints[provider] },
    failover: {},
  });
}

/** „Sprawdź”: lista modeli tekstowych na tym kluczu i model proponowany (obecny, jeśli nadal jest na liście). */
export async function checkAiKey(
  provider: AiProvider,
  key: string,
  current: string | null,
  endpoints: AiEndpoints = {},
): Promise<AiAccountTestResult> {
  try {
    const models: AiModelEntry[] = await aiClient(provider, key, current, endpoints).listModels(PROVIDERS[provider]);
    return { ok: true, models, model: chooseModel(current, models) };
  } catch (error) {
    if (error instanceof AiError) return { ok: false, error: error.message.slice(0, MAX_ERROR), badKey: error.badKey };
    throw error;
  }
}

/** Obecny model, jeśli klucz nadal go zwraca; inaczej domyślny z listy (`defaultModel` — nazw nie zgadujemy). */
export function chooseModel(current: string | null, models: readonly AiModelEntry[]): string | null {
  if (current && models.some((m) => m.id === current)) return current;
  return defaultModel([...models]);
}

/** Zmiana wiersza `ai_accounts` po „Sprawdź”. */
export function testPatch(result: AiAccountTestResult, status: AiAccountStatus, now: Date): Record<string, unknown> {
  if (result.ok) {
    return { status: 'active', models: result.models, model: result.model, verified_at: now.toISOString(), last_error: null };
  }
  // Przejściowa awaria nie unieważnia klucza, który działał — zostaje komunikat do pokazania.
  return { status: result.badKey ? 'error' : status, last_error: result.error };
}

/** Model z `ai/accounts/update`: tylko z listy ostatniego „Sprawdź” (gdy lista jest). `null` = w porządku. */
export function modelProblem(model: string, models: readonly AiModelEntry[]): string | null {
  if (models.length === 0 || models.some((m) => m.id === model)) return null;
  return 'Tego modelu nie ma na liście dla Twojego klucza — kliknij „Sprawdź” i wybierz model z listy.';
}
