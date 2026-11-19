import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/** Klient Supabase w przeglądarce (sesja w localStorage — wspólna dla kart). */
export function supabaseBrowser(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("Brak NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (npm run web:local).");
    // PKCE: magic link i Google wracają z `?code=`, który supabase-js sam wymienia na sesję.
    client = createClient(url, key, { auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true } });
  }
  return client;
}
