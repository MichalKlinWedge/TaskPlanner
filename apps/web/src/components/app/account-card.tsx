"use client";

/**
 * Ustawienia → „Usuń konto” (v1.x): konto i wszystkie dane na serwerze znikają (`lib/account.ts`
 * → Edge Function `account-delete`), potem wylogowanie. Kopia w tej przeglądarce zostaje do
 * wyczyszczenia danych witryny (jak po zwykłym wylogowaniu).
 */
import { ACCOUNT_DELETE_NOTE } from "@taskplanner/core";
import { useState, type FormEvent } from "react";

import { deleteAccount } from "@/lib/account";
import { closeStore } from "@/lib/local-store";
import { supabaseBrowser } from "@/lib/supabase-browser";

import { SettingsSection } from "./settings-section";
import { Button, Input, Notice } from "./ui";

export function AccountCard({ email }: { email: string | null }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = !!email && typed.trim().toLowerCase() === email.toLowerCase();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches || !window.confirm("Usunąć konto i wszystkie dane na serwerze? Tego nie da się cofnąć.")) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(typed.trim());
      closeStore();
      await supabaseBrowser().auth.signOut({ scope: "local" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Usuń konto">
      <p className="mb-3 text-sm opacity-70">{ACCOUNT_DELETE_NOTE}</p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-center gap-2">
        <Input
          type="email"
          aria-label="Adres e-mail konta"
          placeholder={email ?? "adres e-mail konta"}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          className="min-w-0 flex-1"
        />
        <Button kind="danger" type="submit" disabled={busy || !matches}>
          {busy ? "Usuwanie…" : "Usuń konto"}
        </Button>
      </form>
      {error ? (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
    </SettingsSection>
  );
}
