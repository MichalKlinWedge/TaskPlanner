/**
 * „✨ Ułóż z AI” (v1.x) — część Edge Function `ai` bez zależności od Deno (testy w Node: `tools/edge-tests`).
 *
 * Polecenie i schemat są w core (`ai-day-plan.ts`). Funkcja niczego nie zapisuje i nie zna zadań poza numerami
 * z zapytania: propozycję godzin sprawdza klient (`validateDayPlan`), tu odpadają tylko zmyślone numery.
 */
import { askStructured } from '../../../../packages/ai/src/index.ts';
import { AiDayPlan, type AiDayPlanRequest, type AiDayPlanResult, DAY_PLAN_SYSTEM, dayPlanPrompt } from '../../../../packages/core/src/ai-day-plan.ts';
import type { aiClient } from './accounts.ts';

/** Limity jak w `breakdown.ts`. */
const TIMEOUT_MS = 40_000;
const MAX_TOKENS = 8_192;

export async function runDayPlan(client: ReturnType<typeof aiClient>, request: AiDayPlanRequest): Promise<AiDayPlanResult> {
  const answer = await askStructured(client, AiDayPlan, dayPlanPrompt(request), {
    label: 'ułożenie dnia',
    system: DAY_PLAN_SYSTEM,
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
  });
  const known = new Set(request.tasks.map((t) => t.n));
  return { blocks: answer.data.blocks.filter((b) => known.has(b.n)), model: answer.model };
}
