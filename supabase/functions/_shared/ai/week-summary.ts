/**
 * „✨ Opisz tydzień” (v1.x) — część Edge Function `ai` bez zależności od Deno (testy w Node: `tools/edge-tests`).
 *
 * Polecenie i schemat są w core (`ai-week-summary.ts`). Model pisze zdania ze znacznikami zamiast liczb; tu odpadają
 * zdania z liczbą, a zmyślone numery zadań nie wracają. Podstawia fakty i sprawdza sugestie klient — funkcja niczego
 * nie zapisuje.
 */
import { askStructured } from '../../../../packages/ai/src/index.ts';
import { type AiWeekSummaryRequest, type AiWeekSummaryResult, WEEK_SUMMARY_SYSTEM, weekSummaryAnswer, weekSummaryPrompt, validWeekSentences } from '../../../../packages/core/src/ai-week-summary.ts';
import type { aiClient } from './accounts.ts';

/** Limity jak w `breakdown.ts`. */
const TIMEOUT_MS = 40_000;
const MAX_TOKENS = 8_192;

export async function runWeekSummary(client: ReturnType<typeof aiClient>, request: AiWeekSummaryRequest): Promise<AiWeekSummaryResult> {
  const answer = await askStructured(client, weekSummaryAnswer(request), weekSummaryPrompt(request), {
    label: 'podsumowanie tygodnia',
    system: WEEK_SUMMARY_SYSTEM,
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
  });
  const open = new Set(request.tasks.filter((t) => t.state !== 'done').map((t) => t.n));
  return {
    sentences: validWeekSentences(answer.data.sentences, request),
    suggestions: answer.data.suggestions.filter((s) => open.has(s.n)),
    model: answer.model,
  };
}
