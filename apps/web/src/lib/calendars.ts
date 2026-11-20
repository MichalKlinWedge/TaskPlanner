"use client";

/**
 * Kalendarze zewnętrzne (M18, Etap 5): działania na koncie idą do Edge Function `calendar-sync`
 * (z JWT użytkownika), a wynik wraca zwykłą synchronizacją (`calendar_accounts`, `calendars`,
 * `calendar_events` w `pull_changes`, tylko do odczytu). Wymaga sieci.
 */
import { supabaseBrowser } from "./supabase-browser";

/** Powrót z ekranu zgody Google: `/?calendars=1&account=<id>` → ustawienia. */
export const GOOGLE_RETURN_PARAM = "calendars";

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("Brak NEXT_PUBLIC_SUPABASE_URL.");
  if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("Bez sieci — kalendarze łączy się online.");
  const { data } = await supabaseBrowser().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sesja wygasła — zaloguj się ponownie.");
  const res = await fetch(`${base.replace(/\/$/, "")}/functions/v1/calendar-sync/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Serwer kalendarzy: ${res.status}`);
  return json;
}

/** Ekran zgody Google (odczyt kalendarzy + zapis w kalendarzu „Task Planner”); po zgodzie Google wraca do aplikacji. */
export async function connectGoogle(): Promise<void> {
  const redirectTo = `${window.location.origin}/?${GOOGLE_RETURN_PARAM}=1`;
  const { url } = await call<{ url: string }>("google/start", { redirectTo });
  window.location.assign(url);
}

export const addIcs = (url: string, label?: string) => call<{ accountId: string }>("ics/add", { url, ...(label ? { label } : {}) });
export const syncCalendarAccount = (accountId: string) => call("accounts/sync", { accountId });
export const disconnectCalendarAccount = (accountId: string) => call("accounts/delete", { accountId });
export const setCalendarVisible = (calendarId: string, visible: boolean) => call("calendars/update", { calendarId, visible });
