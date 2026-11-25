"use client";

import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

// Przy imporcie: `beforeinstallprompt` przychodzi zaraz po wczytaniu strony (przycisk w Ustawieniach).
import "@/lib/install";
import { installErrorLog, setErrorUser } from "@/lib/error-log";
import { startOfflineSupport } from "@/lib/service-worker";
// Przy imporcie: token z linku zaproszenia do przestrzeni (`/?invite=`) — zapamiętany przed logowaniem.
import { clearInviteParam } from "@/lib/sharing";
import { storedUser, supabaseBrowser } from "@/lib/supabase-browser";
// Przy imporcie: wycinek strony z zakładki (`/#share?…`) — zdjęty z adresu, zanim odczyta go ktoś inny.
import { clearClipHash } from "@/lib/web-clip";

import { LoginScreen } from "./login-screen";
import { SignedIn } from "./signed-in";
import { Splash } from "./ui";

type User = { id: string; email: string | null };

/**
 * Wejście aplikacji: sesja Supabase (także offline — zapisana w przeglądarce) → logowanie albo
 * aplikacja. Powrót z Google i z linku e-mail (`?code=`) wymienia supabase-js sam (PKCE).
 * Start bez sieci z wygasłym tokenem: supabase-js nie odświeży sesji (błąd sieci), ale jej nie
 * usuwa — aplikacja otwiera wtedy lokalne dane zapisanego użytkownika (`storedUser`).
 */
export function AppRoot() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    installErrorLog();
    startOfflineSupport();
    // Po efektach routera Next (ten przy hydratacji przywraca adres z `?invite=`).
    const clearInvite = setTimeout(() => {
      clearInviteParam();
      clearClipHash();
    }, 0);
    const supabase = supabaseBrowser();
    void supabase.auth.getSession().then(({ data, error }) => {
      const offline = !data.session && error && isAuthRetryableFetchError(error) ? storedUser() : null;
      setUser(data.session ? { id: data.session.user.id, email: data.session.user.email ?? null } : offline);
      // Kod z adresu powrotu już wymieniony — bez niego odświeżenie strony nie próbuje ponownie.
      const url = new URL(window.location.href);
      if (data.session && (url.searchParams.has("code") || url.hash.includes("access_token"))) {
        url.searchParams.delete("code");
        window.history.replaceState(null, "", url.pathname + url.search);
      }
    });
    // Brak sesji liczy się tylko przy wylogowaniu — pierwszy stan (także offline) daje `getSession`.
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      if (next) setUser({ id: next.user.id, email: next.user.email ?? null });
      else if (event === "SIGNED_OUT") setUser(null);
    });
    return () => {
      clearTimeout(clearInvite);
      data.subscription.unsubscribe();
    };
  }, []);

  // Dziennik błędów wysyła tylko z kontem (RLS) — kolejka sprzed logowania idzie po nim.
  useEffect(() => setErrorUser(user?.id ?? null), [user?.id]);

  if (user === undefined) return <Splash text="Wczytywanie…" />;
  if (!user) return <LoginScreen />;
  return <SignedIn key={user.id} userId={user.id} email={user.email} />;
}
