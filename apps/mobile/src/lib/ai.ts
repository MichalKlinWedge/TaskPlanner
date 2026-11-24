/**
 * Asystent AI na własnym koncie (v1.x) na telefonie. Konto (z kluczem) zakłada i zmienia Edge Function `ai`
 * (online, JWT użytkownika) — klucz idzie tylko w ciele zapytania do funkcji i zostaje w Vault, nigdy w APK
 * ani w lokalnej bazie; konto wraca synchronizacją (`ai_accounts`, tylko do odczytu). Konto podpięte na webie
 * widać tu bez ponownego wklejania klucza.
 */
import { AI_NEEDS_NETWORK, AI_OFFLINE_NOTE, parseAiAccount, type AiAccount, type AiAccountTestResult, type AiBreakdownRequest, type AiBreakdownResult, type AiDayPlanRequest, type AiDayPlanResult, type AiProvider } from '@taskplanner/core';
import type { SqlRow } from '@taskplanner/sync';

import { sessionUser } from './config';
import { useLocalQuery } from './local-query';
import { supabaseClient, syncNow } from './sync';

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const account = path.startsWith('accounts/');
  if (!sessionUser().online) throw new Error(account ? AI_OFFLINE_NOTE : AI_NEEDS_NETWORK);
  const { data, error } = await supabaseClient().functions.invoke(`ai/${path}`, { body });
  if (error) {
    const context = (error as { context?: Response }).context;
    const reply = context ? ((await context.json().catch(() => null)) as { error?: string } | null) : null;
    throw new Error(reply?.error ?? error.message);
  }
  // Zmieniony wiersz konta wraca do lokalnej bazy od razu, nie dopiero przy następnej synchronizacji.
  if (account) await syncNow().catch(() => undefined);
  return data as T;
}

export const createAiAccount = (input: { provider: AiProvider; key: string; billingConfirmed: boolean }) =>
  call<{ accountId: string }>('accounts/create', input);
export const updateAiAccount = (accountId: string, patch: { key?: string; billingConfirmed?: boolean; model?: string }) =>
  call<{ ok: true }>('accounts/update', { accountId, ...patch });
export const deleteAiAccount = (accountId: string) => call<{ ok: true }>('accounts/delete', { accountId });
export const testAiAccount = (accountId: string) => call<AiAccountTestResult>('accounts/test', { accountId });
/** „✨ Rozbij na kroki”: szkic kroków od modelu (nic nie zapisuje). */
export const askBreakdown = (request: AiBreakdownRequest) => call<AiBreakdownResult>('breakdown', request);
/** „✨ Ułóż z AI”: propozycja godzin od modelu (nic nie zapisuje; sprawdza ją `dayPlanFromAi`). */
export const askDayPlan = (request: AiDayPlanRequest) => call<AiDayPlanResult>('day-plan', request);

/** Konto AI z lokalnej bazy (działa offline; `null` = nie podpięte). */
export function useAiAccount(): AiAccount | null {
  return (
    useLocalQuery(['ai_accounts'], async (engine) => {
      const rows = await engine.db.all<SqlRow>(
        'select id, provider, model, models, key_hint, status, last_error, verified_at, billing_confirmed_at from ai_accounts order by created_at desc, id',
      );
      return rows.map(parseAiAccount).find((a): a is AiAccount => a !== null) ?? null;
    }) ?? null
  );
}
