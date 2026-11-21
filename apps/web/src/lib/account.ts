"use client";

/**
 * Usunięcie własnego konta (Edge Function `account-delete`, z JWT użytkownika). Wymaga sieci;
 * potwierdzeniem jest wpisany adres e-mail konta (sprawdza go serwer).
 */
import { supabaseBrowser } from "./supabase-browser";

export async function deleteAccount(email: string): Promise<void> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("Brak NEXT_PUBLIC_SUPABASE_URL.");
  if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("Bez sieci — konto usuwa się online.");
  const { data } = await supabaseBrowser().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sesja wygasła — zaloguj się ponownie.");
  const res = await fetch(`${base.replace(/\/$/, "")}/functions/v1/account-delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? `Serwer: ${res.status}`);
  }
}
