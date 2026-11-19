"use client";

import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

import { supabaseBrowser } from "@/lib/supabase-browser";

import { LoginScreen } from "./login-screen";
import { SignedIn } from "./signed-in";
import { Splash } from "./ui";

/**
 * Wejście aplikacji: sesja Supabase (także offline — zapisana w przeglądarce) → logowanie albo
 * aplikacja. Powrót z Google i z linku e-mail (`?code=`) wymienia supabase-js sam (PKCE).
 */
export function AppRoot() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    const supabase = supabaseBrowser();
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      // Kod z adresu powrotu już wymieniony — bez niego odświeżenie strony nie próbuje ponownie.
      const url = new URL(window.location.href);
      if (data.session && (url.searchParams.has("code") || url.hash.includes("access_token"))) {
        url.searchParams.delete("code");
        window.history.replaceState(null, "", url.pathname + url.search);
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <Splash text="Wczytywanie…" />;
  if (!session) return <LoginScreen />;
  return <SignedIn key={session.user.id} userId={session.user.id} email={session.user.email ?? null} />;
}
