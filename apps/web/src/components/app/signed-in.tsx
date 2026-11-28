"use client";

import { DEFAULT_WORKSPACES, isOnboarded, onboardingOps, plural, pluralForm, type DefaultWorkspace } from "@taskplanner/core";
import { STALE_LEADER_MESSAGE, SYNCED_TABLES, type TabStore } from "@taskplanner/sync";
import { useEffect, useMemo, useState } from "react";

import { parseSettings } from "@/lib/app-data";
import { routeHash, useRoute } from "@/lib/route";
import { closeStore, storeFor, useLocalQuery, useStaleLeader, useStoreStatus } from "@/lib/local-store";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { useTheme } from "@/lib/theme";
import { APP_NUMBER } from "@/lib/version";

import { NotificationBell } from "./notifications";
import { ProfileForm, type ProfileValues } from "./profile-form";
import { ScopeInvites } from "./sharing";
import { SettingsScreen } from "./settings-screen";
import { Shell } from "./shell";
import { Card, Notice, Splash } from "./ui";
import { UpdateNotice, useAppUpdated } from "./version-card";
import { WorkspacesScreen } from "./workspaces-screen";

interface ProfileRow extends Record<string, string | number | null> {
  id: string;
  display_name: string | null;
  settings: string | null;
}

const parseJson = (value: string | null): unknown => {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

/** Po zalogowaniu: lokalna baza użytkownika, onboarding przy pierwszym wejściu, potem aplikacja. */
export function SignedIn({ userId, email }: { userId: string; email: string | null }) {
  const store = useMemo(() => storeFor(userId), [userId]);
  const status = useStoreStatus();
  const { rows, ms } = useLocalQuery<ProfileRow>(store, "select id, display_name, settings from profiles where id = ?", [userId], ["profiles"]);
  const profile = rows[0];
  // Profil przychodzi z serwera przy pierwszej synchronizacji (powstaje razem z kontem). Bez
  // niego czekamy na pierwszą próbę synchronizacji; offline onboarding i tak jest bezpieczny
  // (te same id przestrzeni na każdym urządzeniu). Karta, która nie jest liderem, nie widzi stanu
  // synchronizacji — po kilku sekundach decyduje sama.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), 4000);
    return () => clearTimeout(timer);
  }, []);
  const syncTried = status.lastSyncAt !== null || status.error !== null || waited;

  const theme = parseSettings(parseJson(profile?.settings ?? null)).theme;
  useTheme(theme);

  const header = <AppHeader store={store} userId={userId} email={email} settingsLink={isOnboarded(parseJson(profile?.settings ?? null))} />;
  if (ms === null || (!profile && !syncTried)) {
    return (
      <>
        {header}
        <Splash text={status.pullPage ? `Pobieranie danych… (porcja ${status.pullPage})` : "Przygotowanie lokalnej bazy…"} />
      </>
    );
  }

  const settings = parseJson(profile?.settings ?? null);
  if (!isOnboarded(settings)) {
    return (
      <>
        {header}
        <ScopeInvites store={store} />
        <Onboarding store={store} userId={userId} initial={{ displayName: profile?.display_name ?? null, settings }} />
      </>
    );
  }

  // Na wysokość okna: pasek boczny i treść przewijają się osobno, nagłówek zostaje na miejscu.
  return (
    <div className="flex h-dvh flex-col">
      {header}
      <ScopeInvites store={store} />
      <Shell
        store={store}
        userId={userId}
        email={email}
        settings={parseSettings(settings)}
        manage={<WorkspacesScreen store={store} email={email} />}
        settingsView={
          <SettingsScreen
            store={store}
            userId={userId}
            email={email}
            timeZone={parseSettings(settings).timeZone}
            onSignOut={() => void signOutOf(store)}
            general={
              <ProfileForm
                draftKey={userId}
                initial={{ displayName: profile?.display_name ?? null, settings }}
                submitLabel="Zapisz ustawienia"
                onSubmit={async ({ displayName, settings: next }: ProfileValues) => {
                  await store.mutate("profiles", userId, { display_name: displayName || null, settings: { ...next, onboarded: true } });
                }}
              />
            }
          />
        }
      />
    </div>
  );
}

function Onboarding({ store, userId, initial }: { store: TabStore; userId: string; initial: { displayName: string | null; settings: unknown } }) {
  const [chosen, setChosen] = useState<DefaultWorkspace[]>(["personal", "work"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async ({ displayName, settings }: ProfileValues) => {
    setBusy(true);
    setError(null);
    try {
      for (const op of onboardingOps(userId, { displayName, settings, workspaces: chosen })) await store.mutate(op.table, op.id, op.patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4 sm:p-6">
      <header>
        <h2 className="text-xl font-semibold">Witaj w Task Plannerze</h2>
        <p className="text-sm opacity-70">Kilka ustawień na start — wszystko zmienisz później w „Ustawieniach”.</p>
      </header>
      <Card>
        <ProfileForm
          initial={initial}
          submitLabel="Zaczynamy"
          busy={busy}
          onSubmit={finish}
          extra={
            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="mb-1 font-medium">Przestrzenie na start (każda z własnym Inboxem)</legend>
              {DEFAULT_WORKSPACES.map((w) => (
                <label key={w.kind} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={chosen.includes(w.kind)}
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, w.kind] : c.filter((k) => k !== w.kind)))}
                  />
                  <span className="h-3 w-3 rounded-full" style={{ background: w.color }} />
                  {w.name}
                </label>
              ))}
            </fieldset>
          }
        />
        {error ? <Notice tone="error">{error}</Notice> : null}
      </Card>
    </main>
  );
}

/** Pasek: stan synchronizacji (sieć, zmiany w kolejce, błąd), powiadomienia i ustawienia (po onboardingu), wylogowanie. */
/** Wylogowanie z tej przeglądarki (nagłówek i Ustawienia → „Konto”): najpierw próba wysłania zmian, potem potwierdzenie. */
async function signOutOf(store: TabStore) {
  let left = await store.pendingCount();
  if (left > 0) {
    await store.sync().catch(() => undefined);
    left = await store.pendingCount();
  }
  if (left > 0 && !window.confirm(`${plural(left, ["zmiana nie została", "zmiany nie zostały", "zmian nie zostało"])} jeszcze ${pluralForm(left, ["wysłana", "wysłane", "wysłanych"])} na serwer. Wylogować mimo to? Zostaną w tej przeglądarce do następnego logowania.`)) return;
  // Chybiony klik obok ⚙️ nie wylogowuje — ponowne logowanie wymaga maila albo Google.
  if (left === 0 && !window.confirm("Wylogować z tej przeglądarki? Zalogujesz się ponownie linkiem z e-maila albo przez Google.")) return;
  closeStore();
  // Tylko ta przeglądarka: domyślny zakres (`global`) kończyłby też sesję na telefonie.
  await supabaseBrowser().auth.signOut({ scope: "local" });
}

function AppHeader({ store, userId, email, settingsLink }: { store: TabStore; userId: string; email: string | null; settingsLink: boolean }) {
  const status = useStoreStatus();
  const [route] = useRoute();
  const stale = useStaleLeader(store);
  const updated = useAppUpdated();
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void store
        .pendingCount()
        .then((n) => alive && setPending(n))
        .catch(() => undefined);
    void Promise.resolve().then(refresh);
    const off = store.watch(SYNCED_TABLES, refresh);
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
  }, [store, status.lastSyncAt]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    void Promise.resolve().then(update);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Po powrocie sieci — od razu wysyłka i pobranie (silnik nie wie o zdarzeniu `online`).
  useEffect(() => {
    if (online) void store.sync().catch(() => undefined);
  }, [online, store]);

  const [busy, setBusy] = useState(false);
  const syncNow = () => {
    if (busy) return;
    setBusy(true);
    void store
      .sync()
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const signOut = () => signOutOf(store);

  const label = !online
    ? pending
      ? `Offline — ${plural(pending, ["zmiana czeka", "zmiany czekają", "zmian czeka"])}`
      : "Offline"
    : status.pullPage
      ? `Pobieranie… (${status.pullPage})`
      : status.syncing || pending
        ? pending
          ? `Wysyłanie ${plural(pending, ["zmiany", "zmian", "zmian"])}…`
          : "Synchronizacja…"
        : status.error
          ? "Błąd synchronizacji"
          : "Zsynchronizowano";
  const dot = !online ? "bg-zinc-400" : status.error ? "bg-red-500" : status.syncing || pending ? "bg-amber-500" : "bg-green-500";

  return (
    <>
      <header className="flex min-w-0 items-center gap-2 border-b border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm sm:gap-3 sm:px-4">
        <span className="flex items-baseline gap-1.5">
          {settingsLink ? (
            <a href={routeHash({ view: "home" })} title="Strona startowa" className="-mx-1 rounded px-1 font-semibold outline-none hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]" data-testid="home-link">
              Task Planner
            </a>
          ) : (
            <span className="font-semibold">Task Planner</span>
          )}
          {APP_NUMBER && !settingsLink ? <span className="font-mono text-[11px] text-[var(--muted)]">{APP_NUMBER}</span> : null}
          {APP_NUMBER && settingsLink ? (
            <a href="#/changelog" title="Historia zmian" className="rounded px-0.5 font-mono text-[11px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--foreground)]" data-testid="app-version-link">
              {APP_NUMBER}
            </a>
          ) : null}
        </span>
        {/* Klik = „Synchronizuj teraz” (wysyłka i pobranie od razu, bez czekania na sygnał). */}
        <button
          type="button"
          onClick={syncNow}
          disabled={!online || busy}
          aria-busy={busy || status.syncing}
          title={[
            online ? "Synchronizuj teraz" : "Brak sieci",
            status.error ?? (status.lastSyncAt ? `Ostatnio: ${new Date(status.lastSyncAt).toLocaleTimeString("pl-PL")}` : null),
          ]
            .filter(Boolean)
            .join(" · ")}
          className="-mx-1 rounded px-1 outline-none hover:bg-[var(--line)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-default disabled:hover:bg-transparent"
          data-testid="sync-now"
        >
          <span className="flex items-center gap-1.5 text-xs opacity-80" role="status" data-testid="sync-status">
            <span className={`h-2 w-2 rounded-full ${dot} ${busy ? "animate-pulse" : ""}`} />
            {label}
            {/* Powód błędu widoczny (nie tylko w podpowiedzi po najechaniu) — na wąskim ekranie dla czytnika ekranu. */}
            {online && status.error ? (
              <span className="sr-only max-w-72 truncate sm:not-sr-only" title={status.error}>
                — {status.error}
              </span>
            ) : null}
          </span>
        </button>
        <span className="flex-1" />
        {email ? <span className="hidden text-xs text-[var(--muted)] sm:inline">{email}</span> : null}
        {settingsLink ? <NotificationBell store={store} userId={userId} /> : null}
        {settingsLink ? (
          <a
            href={routeHash({ view: "settings" })}
            aria-current={route.view === "settings" ? "page" : undefined}
            aria-label="Ustawienia"
            title="Ustawienia"
            className={`px-1 text-base outline-none rounded focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${route.view === "settings" ? "opacity-100" : "opacity-70 hover:opacity-100"}`}
          >
            <span aria-hidden>⚙️</span>
          </a>
        ) : null}
        <button type="button" onClick={() => void signOut()} aria-label="Wyloguj" title="Wyloguj" className="px-1 py-1 opacity-70 outline-none hover:opacity-100 rounded focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
          <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <path d="m16 17 5-5-5-5" />
            <path d="M21 12H9" />
          </svg>
        </button>
      </header>
      {stale ? (
        <p role="alert" className="border-b border-amber-400 bg-amber-100 px-4 py-2 text-sm text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" data-testid="stale-leader">
          {STALE_LEADER_MESSAGE}
        </p>
      ) : updated ? (
        <div className="border-b border-[var(--line)] [&>p]:rounded-none [&>p]:border-0" data-testid="app-updated">
          <UpdateNotice />
        </div>
      ) : null}
    </>
  );
}
