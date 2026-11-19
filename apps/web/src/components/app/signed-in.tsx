"use client";

import { DEFAULT_WORKSPACES, isOnboarded, onboardingOps, type DefaultWorkspace } from "@taskplanner/core";
import { SYNCED_TABLES, type TabStore } from "@taskplanner/sync";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { parseSettings } from "@/lib/app-data";
import { closeStore, storeFor, useLocalQuery, useStoreStatus } from "@/lib/local-store";
import { offlineStatus, subscribeOffline } from "@/lib/service-worker";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { useTheme } from "@/lib/theme";

import { ProfileForm, type ProfileValues } from "./profile-form";
import { RemindersCard } from "./reminders-card";
import { Shell } from "./shell";
import { Button, Card, Notice, Splash } from "./ui";
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

  const header = <AppHeader store={store} email={email} />;
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
        <Onboarding store={store} userId={userId} initial={{ displayName: profile?.display_name ?? null, settings }} />
      </>
    );
  }

  // Na wysokość okna: pasek boczny i treść przewijają się osobno, nagłówek zostaje na miejscu.
  return (
    <div className="flex h-dvh flex-col">
      {header}
      <Shell
        store={store}
        userId={userId}
        settings={parseSettings(settings)}
        manage={<WorkspacesScreen store={store} />}
        settingsView={
          <>
            <h1 className="mb-4 text-xl font-semibold">Ustawienia</h1>
            <Card>
              <ProfileForm
                key={profile?.settings ?? ""}
                initial={{ displayName: profile?.display_name ?? null, settings }}
                submitLabel="Zapisz ustawienia"
                onSubmit={async ({ displayName, settings: next }: ProfileValues) => {
                  await store.mutate("profiles", userId, { display_name: displayName || null, settings: { ...next, onboarded: true } });
                }}
              />
            </Card>
            <RemindersCard store={store} userId={userId} />
            <OfflineCard />
          </>
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
        <h2 className="text-xl font-semibold">Witaj w TaskPlannerze</h2>
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

/** Pasek: stan synchronizacji (sieć, zmiany w kolejce, błąd) i wylogowanie. */
function AppHeader({ store, email }: { store: TabStore; email: string | null }) {
  const status = useStoreStatus();
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

  const signOut = async () => {
    let left = await store.pendingCount();
    if (left > 0) {
      await store.sync().catch(() => undefined);
      left = await store.pendingCount();
    }
    if (left > 0 && !window.confirm(`${left} zmian nie zostało jeszcze wysłanych na serwer. Wylogować mimo to? Zostaną w tej przeglądarce do następnego logowania.`)) return;
    closeStore();
    await supabaseBrowser().auth.signOut();
  };

  const label = !online
    ? pending
      ? `Offline — ${pending} zmian czeka`
      : "Offline"
    : status.pullPage
      ? `Pobieranie… (${status.pullPage})`
      : status.syncing || pending
        ? pending
          ? `Wysyłanie ${pending} zmian…`
          : "Synchronizacja…"
        : status.error
          ? "Błąd synchronizacji"
          : "Zsynchronizowano";
  const dot = !online ? "bg-zinc-400" : status.error ? "bg-red-500" : status.syncing || pending ? "bg-amber-500" : "bg-green-500";

  return (
    <header className="flex items-center gap-3 border-b border-[var(--line)] bg-[var(--surface)] px-4 py-2 text-sm">
      <span className="font-semibold">TaskPlanner</span>
      <span className="flex items-center gap-1.5 text-xs opacity-80" role="status" title={status.error ?? (status.lastSyncAt ? `Ostatnio: ${new Date(status.lastSyncAt).toLocaleTimeString("pl-PL")}` : undefined)} data-testid="sync-status">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        {label}
      </span>
      <span className="flex-1" />
      {email ? <span className="hidden text-xs opacity-60 sm:inline">{email}</span> : null}
      <Button kind="ghost" onClick={() => void signOut()}>
        Wyloguj
      </Button>
    </header>
  );
}

/** Stan pracy bez sieci w tej przeglądarce (M20): baza, trwała pamięć, Service Worker. */
function OfflineCard() {
  const store = useStoreStatus();
  const offline = useSyncExternalStore(subscribeOffline, offlineStatus, offlineStatus);
  const sw = { active: "gotowa — aplikacja wystartuje bez sieci", installing: "w trakcie przygotowania (odśwież stronę)", unsupported: "niedostępna w tej przeglądarce", dev: "wyłączona w trybie deweloperskim" }[offline.serviceWorker];
  return (
    <Card className="mt-4">
      <h2 className="mb-2 text-sm font-semibold">Praca bez sieci w tej przeglądarce</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-[var(--muted)]">Lokalna baza</dt>
        <dd>{store.storage}</dd>
        <dt className="text-[var(--muted)]">Trwała pamięć</dt>
        <dd>{offline.persisted === null ? "—" : offline.persisted ? "tak — przeglądarka nie usunie danych" : "nie — przeglądarka może usunąć dane przy braku miejsca (zainstaluj aplikację albo dodaj do zakładek)"}</dd>
        <dt className="text-[var(--muted)]">Wersja offline</dt>
        <dd data-testid="offline-sw">{sw}</dd>
      </dl>
    </Card>
  );
}
