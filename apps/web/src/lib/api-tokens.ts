"use client";

/**
 * Tokeny przychodzącego API (v1.x): inna aplikacja (Expedition Plan) zakłada i aktualizuje zadania tokenem.
 * Token tworzy i odwołuje Edge Function `inbound-api` (online, JWT użytkownika); jawny token przychodzi tylko
 * w odpowiedzi na utworzenie. Lista tokenów (bez skrótu) wraca zwykłą synchronizacją (`api_tokens`, tylko do odczytu).
 */
import { parseApiToken, type ApiToken } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useMemo } from "react";

import { useLocalQuery } from "./local-store";
import { supabaseBrowser } from "./supabase-browser";

/** Adres API zadań do wklejenia w drugiej aplikacji. */
export function inboundApiUrl(): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  return `${base.replace(/\/$/, "")}/functions/v1/inbound-api`;
}

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) throw new Error("Brak NEXT_PUBLIC_SUPABASE_URL.");
  if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("Bez sieci — tokeny zmienia się online.");
  const { data } = await supabaseBrowser().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sesja wygasła — zaloguj się ponownie.");
  const res = await fetch(`${inboundApiUrl()}/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Serwer API: ${res.status}`);
  return json;
}

export const createApiToken = (input: { label: string; listId: string }) => call<{ tokenId: string; token: string }>("tokens/create", input);
export const revokeApiToken = (tokenId: string) => call<{ ok: true }>("tokens/revoke", { tokenId });

type Row = Record<string, string | number | null>;

/** Aktywne tokeny z lokalnej bazy (działa offline). */
export function useApiTokens(store: TabStore | null): ApiToken[] {
  const rows = useLocalQuery<Row>(
    store,
    "select id, label, token_hint, list_id, created_at, last_used_at from api_tokens order by created_at, id",
    [],
    ["api_tokens"],
  ).rows;
  return useMemo(() => rows.map(parseApiToken).filter((t): t is ApiToken => t !== null), [rows]);
}
