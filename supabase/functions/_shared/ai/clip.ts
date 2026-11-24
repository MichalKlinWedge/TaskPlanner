/**
 * „✨ Streść” (v1.x) — część Edge Function `ai` bez zależności od Deno (testy w Node: `tools/edge-tests`).
 *
 * Polecenie i schemat odpowiedzi są w core (`ai-clip.ts`). Treść strony jest niezaufana: model dostaje ją jako dane,
 * nie ma narzędzi, a funkcja niczego nie zapisuje — tytuł i punkty wracają do klienta, który usuwa z nich linki
 * i HTML i wypełnia nimi pola do sprawdzenia.
 */
import { askStructured } from '../../../../packages/ai/src/index.ts';
import { AiClip, type AiClipRequest, type AiClipResult, CLIP_SYSTEM, clipPrompt } from '../../../../packages/core/src/ai-clip.ts';
import type { aiClient } from './accounts.ts';

/** Limity jak w `breakdown.ts`. */
const TIMEOUT_MS = 40_000;
const MAX_TOKENS = 8_192;

export async function runClip(client: ReturnType<typeof aiClient>, request: AiClipRequest): Promise<AiClipResult> {
  const answer = await askStructured(client, AiClip, clipPrompt(request), {
    label: 'streszczenie strony',
    system: CLIP_SYSTEM,
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
  });
  return { title: answer.data.title, points: answer.data.points, model: answer.model };
}
