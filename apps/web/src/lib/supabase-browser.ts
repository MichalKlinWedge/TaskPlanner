import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * Klucz sesji w localStorage — ten sam co domyślny w supabase-js (`sb-<host>-auth-token`), podany
 * jawnie, żeby start offline mógł odczytać zapisanego użytkownika (`storedUser`).
 */
export const authStorageKey = () => `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://local").hostname.split(".")[0]}-auth-token`;

/**
 * Użytkownik z zapisanej sesji — do startu bez sieci, gdy token wygasł, a odświeżenie nie ma jak
 * dojść do serwera. Lokalna baza jest per użytkownik, więc wystarczy id; token odświeży się
 * po powrocie sieci (albo wygaśnięcie sesji wyloguje, gdy serwer jej nie uzna).
 */
export function storedUser(): { id: string; email: string | null } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(authStorageKey()) ?? "null") as { user?: { id?: unknown; email?: unknown } } | null;
    return typeof raw?.user?.id === "string" ? { id: raw.user.id, email: typeof raw.user.email === "string" ? raw.user.email : null } : null;
  } catch {
    return null;
  }
}

/** Klient Supabase w przeglądarce (sesja w localStorage — wspólna dla kart). */
export function supabaseBrowser(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("Brak NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (npm run web:local).");
    // PKCE: magic link i Google wracają z `?code=`, który supabase-js sam wymienia na sesję.
    client = createClient(url, key, { auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, storageKey: authStorageKey() } });
  }
  return client;
}
