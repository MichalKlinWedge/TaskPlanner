/**
 * „✨ Rozbij na kroki” (v1.x) — część Edge Function `ai` bez zależności od Deno (testy w Node: `tools/edge-tests`).
 *
 * Polecenie i schemat odpowiedzi są w core (`ai-breakdown.ts`); tu zapytanie do modelu na kluczu użytkownika
 * z jedną próbą naprawy (`askStructured`). Funkcja niczego nie zapisuje — kroki wracają do klienta jako szkic.
 */
import { AiError, askStructured } from '../../../../packages/ai/src/index.ts';
import { type AiBreakdownRequest, type AiBreakdownResult, AiTaskBreakdown, BREAKDOWN_SYSTEM, breakdownPrompt } from '../../../../packages/core/src/ai-breakdown.ts';
import type { aiClient } from './accounts.ts';

/** Limit jednego zapytania: z naprawą i modelem zastępczym całość ma się zmieścić w limicie funkcji (150 s). */
const TIMEOUT_MS = 40_000;
/** Odpowiedź razem z „myśleniem” modelu — za ciasno i JSON urwie się w połowie. */
const MAX_TOKENS = 8_192;

export async function runBreakdown(client: ReturnType<typeof aiClient>, request: AiBreakdownRequest): Promise<AiBreakdownResult> {
  const answer = await askStructured(client, AiTaskBreakdown, breakdownPrompt(request), {
    label: 'rozbicie zadania',
    system: BREAKDOWN_SYSTEM,
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
  });
  return { steps: answer.data.steps, model: answer.model };
}

/** Odmowa dostawcy jako kod HTTP funkcji: klucz do poprawienia, chwilowe przeciążenie / limit albo inna awaria. */
export const aiErrorStatus = (error: AiError): number => (error.badKey ? 422 : error.busy ? 503 : 502);
