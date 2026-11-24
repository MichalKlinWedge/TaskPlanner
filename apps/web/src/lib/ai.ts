"use client";

/**
 * Asystent AI na własnym koncie (v1.x). Konto (z kluczem) zakłada i zmienia Edge Function `ai` (online, JWT
 * użytkownika) — klucz idzie tylko w ciele zapytania do funkcji i zostaje w Vault; konto wraca zwykłą
 * synchronizacją (`ai_accounts`, tylko do odczytu, bez klucza).
 */
import { AI_NEEDS_NETWORK, AI_OFFLINE_NOTE, parseAiAccount, type AiAccount, type AiAccountTestResult, type AiBreakdownRequest, type AiBreakdownResult, type AiProvider } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useMemo } from "react";

import { useLocalQuery } from "./local-store";
import { supabaseBrowser } from "./supabase-browser";

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("Brak NEXT_PUBLIC_SUPABASE_URL.");
  if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error(path.startsWith("accounts/") ? AI_OFFLINE_NOTE : AI_NEEDS_NETWORK);
  const { data } = await supabaseBrowser().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sesja wygasła — zaloguj się ponownie.");
  const res = await fetch(`${base.replace(/\/$/, "")}/functions/v1/ai/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Serwer AI: ${res.status}`);
  return json;
}

export const createAiAccount = (input: { provider: AiProvider; key: string; billingConfirmed: boolean }) =>
  call<{ accountId: string }>("accounts/create", input);
export const updateAiAccount = (accountId: string, patch: { key?: string; billingConfirmed?: boolean; model?: string }) =>
  call<{ ok: true }>("accounts/update", { accountId, ...patch });
export const deleteAiAccount = (accountId: string) => call<{ ok: true }>("accounts/delete", { accountId });
export const testAiAccount = (accountId: string) => call<AiAccountTestResult>("accounts/test", { accountId });
/** „✨ Rozbij na kroki”: szkic kroków od modelu (nic nie zapisuje). */
export const askBreakdown = (request: AiBreakdownRequest) => call<AiBreakdownResult>("breakdown", request);

type Row = Record<string, string | number | null>;

/** Konto AI z lokalnej bazy (działa offline; `null` = nie podpięte). */
export function useAiAccount(store: TabStore | null): AiAccount | null {
  const rows = useLocalQuery<Row>(
    store,
    "select id, provider, model, models, key_hint, status, last_error, verified_at, billing_confirmed_at from ai_accounts order by created_at desc, id",
    [],
    ["ai_accounts"],
  ).rows;
  return useMemo(() => rows.map(parseAiAccount).find((a): a is AiAccount => a !== null) ?? null, [rows]);
}
