"use client";

/**
 * Ustawienia → „Zaproszenia” (v1.x): lista adresów i domen, z których można założyć konto
 * (`allowed_emails`, hook `hook_before_user_created`). Widoczna tylko dla administratora
 * (`is_app_admin()`, wiersz w `app_admins`); czyta i zmienia listę przez RPC na serwerze — wymaga sieci.
 */
import { invitePattern, isDomainInvite, plural } from "@taskplanner/core";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { supabaseBrowser } from "@/lib/supabase-browser";

import { SettingsSection } from "./settings-section";
import { Button, Input, Notice } from "./ui";

interface Invite {
  pattern: string;
  note: string | null;
  created_at: string;
  accounts: number;
}

const date = (iso: string) => new Date(iso).toLocaleDateString("pl-PL", { dateStyle: "medium" });

/** Czy konto jest administratorem (`is_app_admin`, z serwera); `null` — jeszcze nie wiadomo, bez sieci `false`. */
export function useAppAdmin(): boolean | null {
  const [admin, setAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void supabaseBrowser()
      .rpc("is_app_admin")
      .then(({ data }) => {
        if (alive) setAdmin(data === true);
      });
    return () => {
      alive = false;
    };
  }, []);
  return admin;
}

export function InvitesCard() {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabaseBrowser().rpc("list_invites");
    if (e) setError(navigator.onLine ? `Nie udało się wczytać listy: ${e.message}` : "Lista jest na serwerze — wczyta się po powrocie sieci.");
    else {
      setError(null);
      setInvites(data as Invite[]);
    }
  }, []);

  useEffect(() => {
    // Wczytanie przy pierwszym otwarciu sekcji (zapytanie do serwera, nie do lokalnej bazy).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const normalized = invitePattern(pattern);

  const act = async (work: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true);
    setError(null);
    const { error: e } = await work();
    if (e) setError(e.message);
    await load();
    setBusy(false);
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!normalized) return;
    void act(async () => {
      const result = await supabaseBrowser().rpc("add_invite", { p_pattern: normalized, p_note: note.trim() || null });
      if (!result.error) {
        setPattern("");
        setNote("");
      }
      return result;
    });
  };

  const remove = (invite: Invite) => {
    const extra = invite.accounts ? ` ${plural(invite.accounts, ["założone konto", "założone konta", "założonych kont"])} zostanie — usuwa się je osobno.` : "";
    if (!window.confirm(`Usunąć ${invite.pattern} z zaproszonych?${extra}`)) return;
    void act(() => supabaseBrowser().rpc("remove_invite", { p_pattern: invite.pattern }));
  };

  return (
    <SettingsSection title="Zaproszenia">
      <p className="mb-3 text-sm opacity-70">
        Konto może założyć tylko adres z tej listy albo dowolny adres z wpisanej domeny („@firma.pl”, bez subdomen). Usunięcie z listy nie usuwa konta,
        które już powstało. Widzisz tę kartę jako administrator.
      </p>
      <form onSubmit={add} className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Adres albo domena"
          placeholder="jan@example.com albo @firma.pl"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          autoComplete="off"
          className="min-w-0 flex-1"
        />
        <Input aria-label="Notatka" placeholder="Notatka (opcjonalnie)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className="min-w-0 flex-1" />
        <Button kind="primary" type="submit" disabled={busy || !normalized}>
          Zaproś
        </Button>
      </form>
      {pattern.trim() && !normalized ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">Wpisz adres e-mail albo domenę z „@” na początku.</p> : null}
      {invites === null ? null : invites.length === 0 ? (
        <p className="mt-3 text-sm opacity-60">Lista jest pusta — nikt nowy nie założy konta.</p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--line)] text-sm">
          {invites.map((invite) => (
            <li key={invite.pattern} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {invite.pattern}
                  {isDomainInvite(invite.pattern) ? <span className="ml-2 text-xs font-normal opacity-60">cała domena</span> : null}
                </div>
                <div className="truncate text-xs opacity-60">
                  {[invite.note, `od ${date(invite.created_at)}`, invite.accounts ? plural(invite.accounts, ["konto", "konta", "kont"]) : "bez konta"].filter(Boolean).join(" · ")}
                </div>
              </div>
              <Button kind="ghost" disabled={busy} onClick={() => remove(invite)} aria-label={`Usuń ${invite.pattern}`}>
                Usuń
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
    </SettingsSection>
  );
}
