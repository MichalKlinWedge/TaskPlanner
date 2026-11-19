"use client";

import { useEffect, useState, type FormEvent } from "react";

import { supabaseBrowser } from "@/lib/supabase-browser";

import { Button, Card, Field, Input, Notice } from "./ui";

/** Komunikat błędu Supabase Auth po polsku (najczęstsze przypadki). */
function authError(message: string): string {
  if (/provider is not enabled|Unsupported provider/i.test(message)) return "Logowanie Google nie jest włączone na tym serwerze.";
  if (/rate limit|too many/i.test(message)) return "Za dużo prób — odczekaj chwilę i spróbuj ponownie.";
  if (/invalid.*email|Unable to validate email/i.test(message)) return "Niepoprawny adres e-mail.";
  if (/fetch|network/i.test(message)) return "Brak połączenia z serwerem.";
  return message;
}

/** Ustawienia Supabase Auth (`/auth/v1/settings`): włączeni dostawcy. Brak odpowiedzi = nie wiadomo (null). */
async function googleAvailable(): Promise<boolean | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    const response = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
    if (!response.ok) return null;
    const settings = (await response.json()) as { external?: Record<string, boolean> };
    return settings.external?.google === true;
  } catch {
    return null;
  }
}

/** Logowanie (M1): Google albo link na e-mail. Konto powstaje przy pierwszym logowaniu. */
export function LoginScreen() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Czy serwer ma włączone logowanie Google (inaczej `signInWithOAuth` prowadzi na stronę błędu).
  const [googleEnabled, setGoogleEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void googleAvailable().then((enabled) => alive && setGoogleEnabled(enabled));
    return () => {
      alive = false;
    };
  }, []);
  // Ze znakiem „/” na końcu: pasuje do `additional_redirect_urls` („…:3000/**”) w Supabase Auth.
  const redirectTo = typeof window === "undefined" ? undefined : `${window.location.origin}/`;

  const google = async () => {
    setBusy(true);
    setError(null);
    const { error: e } = await supabaseBrowser().auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
    // Przy powodzeniu przeglądarka przechodzi do Google; tu wracamy tylko z błędem.
    if (e) {
      setError(authError(e.message));
      setBusy(false);
    }
  };

  const magicLink = async (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    const { error: e } = await supabaseBrowser().auth.signInWithOtp({ email: address, options: { emailRedirectTo: redirectTo } });
    setBusy(false);
    if (e) setError(authError(e.message));
    else setSentTo(address);
  };

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">TaskPlanner</h1>
        <p className="text-sm opacity-70">Zaloguj się, żeby zadania były na laptopie i telefonie. Działa też bez sieci.</p>
      </header>
      <Card className="flex flex-col gap-4">
        <Button kind="secondary" onClick={() => void google()} disabled={busy || googleEnabled === false} className="py-2">
          <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4">
            <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.9-5.5 3.9-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.3 14.6 2.4 12 2.4 6.7 2.4 2.4 6.7 2.4 12s4.3 9.6 9.6 9.6c5.5 0 9.2-3.9 9.2-9.4 0-.6-.1-1.1-.2-1.6H12z" />
          </svg>
          Zaloguj przez Google
        </Button>
        {googleEnabled === false ? <p className="-mt-2 text-xs opacity-60">Logowanie Google nie jest włączone na tym serwerze.</p> : null}
        <div className="flex items-center gap-2 text-xs opacity-60">
          <span className="h-px flex-1 bg-[var(--line)]" />
          albo
          <span className="h-px flex-1 bg-[var(--line)]" />
        </div>
        {sentTo ? (
          <Notice tone="ok">
            Wysłano link na <strong>{sentTo}</strong>. Otwórz go w tej przeglądarce.{" "}
            <button type="button" className="underline" onClick={() => setSentTo(null)}>
              Inny adres
            </button>
          </Notice>
        ) : (
          <form onSubmit={(e) => void magicLink(e)} className="flex flex-col gap-3">
            <Field label="E-mail">
              <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ty@example.com" />
            </Field>
            <Button kind="primary" type="submit" disabled={busy || !email.trim()}>
              Wyślij link do logowania
            </Button>
          </form>
        )}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </Card>
    </main>
  );
}
