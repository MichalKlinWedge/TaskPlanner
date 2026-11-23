"use client";

/**
 * Integracje wychodzące (M21, etap I1). Połączenia (z sekretami) zakłada i zmienia Edge Function `plugins`
 * (online, JWT użytkownika) — wracają zwykłą synchronizacją (`plugin_connections`, tylko do odczytu).
 * Reguły i prośby „Wyślij do…” to zwykłe wiersze synchronizowane (`plugin_rules`, `plugin_requests`) —
 * zapis lokalny działa offline, wysyłka wychodzi z serwera po synchronizacji.
 */
import { parsePluginConnection, parsePluginRule, sendableRules, type PluginConnection, type PluginRule } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useMemo } from "react";

import { useLocalQuery } from "./local-store";
import { supabaseBrowser } from "./supabase-browser";

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("Brak NEXT_PUBLIC_SUPABASE_URL.");
  if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("Bez sieci — połączenia zmienia się online.");
  const { data } = await supabaseBrowser().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sesja wygasła — zaloguj się ponownie.");
  const res = await fetch(`${base.replace(/\/$/, "")}/functions/v1/plugins/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Serwer integracji: ${res.status}`);
  return json;
}

export const createPluginConnection = (input: { plugin: string; label: string; config: Record<string, unknown>; secrets: Record<string, string> }) =>
  call<{ connectionId: string }>("connections/create", input);
export const updatePluginConnection = (connectionId: string, patch: { label?: string; config?: Record<string, unknown>; secrets?: Record<string, string>; enabled?: boolean }) =>
  call<{ ok: true }>("connections/update", { connectionId, ...patch });
export const deletePluginConnection = (connectionId: string) => call<{ ok: true }>("connections/delete", { connectionId });
export const testPluginConnection = (connectionId: string) =>
  call<{ ok: boolean; error?: string; httpStatus?: number | null }>("test", { connectionId });

/** „Ponów” w historii wysyłek (RPC — tylko własne wysyłki). */
export async function retryPluginDelivery(id: string): Promise<void> {
  const { error } = await supabaseBrowser().rpc("retry_plugin_delivery", { p_delivery: id });
  if (error) throw new Error(navigator.onLine ? error.message : "Bez sieci — ponowienie po powrocie sieci.");
}

type Row = Record<string, string | number | null>;

/** Połączenia i reguły z lokalnej bazy (działa offline); `sendable` = reguły do „Wyślij do…”. */
export function usePlugins(store: TabStore | null): { connections: PluginConnection[]; rules: PluginRule[]; sendable: PluginRule[] } {
  const connectionRows = useLocalQuery<Row>(
    store,
    "select id, plugin, label, config, status, last_error, last_used_at from plugin_connections order by created_at, id",
    [],
    ["plugin_connections"],
  ).rows;
  const ruleRows = useLocalQuery<Row>(
    store,
    "select id, name, connection_id, enabled, trigger, action, options, sort_key from plugin_rules where deleted_at is null order by sort_key, id",
    [],
    ["plugin_rules"],
  ).rows;
  return useMemo(() => {
    const connections = connectionRows.map(parsePluginConnection).filter((c): c is PluginConnection => c !== null);
    const rules = ruleRows.map(parsePluginRule).filter((r): r is PluginRule => r !== null);
    return { connections, rules, sendable: sendableRules(rules, connections) };
  }, [connectionRows, ruleRows]);
}
