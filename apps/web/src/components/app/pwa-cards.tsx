"use client";

/**
 * Ustawienia → instalacja PWA i praca bez sieci (M20, Etap 11): przycisk „Zainstaluj aplikację”,
 * stan Service Workera / trwałej pamięci / plików offline i lista funkcji, które bez sieci nie działają.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { installState, promptInstall, subscribeInstall } from "@/lib/install";
import { useStoreStatus } from "@/lib/local-store";
import { checkOfflineCache, offlineStatus, subscribeOffline, type OfflineCheck } from "@/lib/service-worker";

import { Button, Card } from "./ui";

const SHORTCUTS = "Szybkie dodawanie, Dziś, Kalendarz";

export function InstallCard() {
  const state = useSyncExternalStore(subscribeInstall, installState, () => "unknown" as const);
  const [dismissed, setDismissed] = useState(false);
  const install = async () => setDismissed(!(await promptInstall()));

  return (
    <Card className="mt-4">
      <h2 className="mb-2 text-sm font-semibold">Aplikacja na pulpicie</h2>
      {state === "installed" ? (
        <p className="text-sm" data-testid="install-state">
          Zainstalowana. Skróty z ikony aplikacji (prawy przycisk na pasku zadań lub w menu Start, przytrzymanie ikony na telefonie): {SHORTCUTS}.
        </p>
      ) : state === "available" ? (
        <div className="flex flex-col items-start gap-2 text-sm">
          <p>Własne okno, ikona na pulpicie i skróty ({SHORTCUTS}); działa także bez sieci.</p>
          <Button kind="primary" onClick={() => void install()} data-testid="install-button">
            Zainstaluj aplikację
          </Button>
        </div>
      ) : (
        <p className="text-sm text-[var(--muted)]" data-testid="install-state">
          {dismissed ? "Instalacja anulowana. " : ""}
          Chrome i Edge: ikona instalacji w pasku adresu albo menu ⋮ → „Zainstaluj Task Planner”. Jeśli jej nie ma, aplikacja jest już zainstalowana — otwórz ją z
          pulpitu lub menu Start. Firefox nie instaluje aplikacji internetowych; Safari na macOS: Plik → Dodaj do Docka.
        </p>
      )}
    </Card>
  );
}

/** Wyjątki od pracy bez sieci (SPECYFIKACJA M20) — reszta aplikacji działa na lokalnej bazie. */
const NEEDS_NETWORK: { what: string; detail: string }[] = [
  { what: "Logowanie", detail: "pierwsze na tym urządzeniu i ponowne po wylogowaniu; później aplikacja startuje bez sieci." },
  { what: "Synchronizacja z innymi urządzeniami", detail: "zmiany czekają w kolejce („Offline — N zmian czeka”) i wysyłają się po powrocie sieci." },
  {
    what: "Kalendarze zewnętrzne",
    detail: "łączenie i odłączanie Google / ICS, wybór kalendarzy i odświeżenie wydarzeń (widać ostatnio pobrane); zadania trafiają do kalendarza „Task Planner” po synchronizacji.",
  },
  {
    what: "Przypomnienia push",
    detail: "włączenie w tej przeglądarce i dostarczanie (wysyła je serwer); przypomnienie ustawione bez sieci zadziała po synchronizacji. Koniec fazy skupienia i przypomnienie o przeglądzie działają bez sieci.",
  },
  { what: "Karteczki", detail: "układanie, dodawanie i grupowanie karteczek listy (bez sieci widok jest tylko do odczytu); karteczki ułożone na innych urządzeniach widać po synchronizacji." },
  {
    what: "Integracje",
    detail: "dodawanie i zmiana połączeń, „Wyślij próbne” i historia wysyłek; „Wyślij do…” bez sieci czeka i wychodzi z serwera po synchronizacji, reguły zapisują się lokalnie.",
  },
  { what: "Asystent AI", detail: "podpinanie i zmiana konta AI, „Sprawdź” i wybór modelu oraz funkcje ✨ (zapytania idą do dostawcy przez serwer); konto podpięte na innym urządzeniu widać po synchronizacji." },
  { what: "Podgląd linków", detail: "tytuł strony z adresu — bez sieci adres zostaje tytułem zadania." },
  { what: "Nowa wersja aplikacji", detail: "wczytuje się przy pierwszym starcie z siecią." },
];

/** Stan pracy bez sieci w tej przeglądarce (M20): baza, trwała pamięć, Service Worker, pliki. */
export function OfflineCard() {
  const store = useStoreStatus();
  const offline = useSyncExternalStore(subscribeOffline, offlineStatus, offlineStatus);
  const sw = { active: "gotowa — aplikacja wystartuje bez sieci", installing: "w trakcie przygotowania (odśwież stronę)", unsupported: "niedostępna w tej przeglądarce", dev: "wyłączona w trybie deweloperskim" }[offline.serviceWorker];
  const [check, setCheck] = useState<OfflineCheck | null>(null);
  const runCheck = useCallback(() => void checkOfflineCache().then(setCheck), []);
  useEffect(() => {
    if (offline.serviceWorker !== "active") return;
    // SW zapisuje listę plików po starcie w tle — sprawdzenie chwilę później.
    const timer = setTimeout(runCheck, 1500);
    return () => clearTimeout(timer);
  }, [offline.serviceWorker, runCheck]);

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
        {offline.serviceWorker === "active" ? (
          <>
            <dt className="text-[var(--muted)]">Pliki aplikacji</dt>
            <dd data-testid="offline-files" className="flex flex-wrap items-center gap-2">
              {check === null
                ? "sprawdzanie…"
                : check.missing.length === 0
                  ? `wszystkie w pamięci (${check.total})`
                  : `brakuje ${check.missing.length} z ${check.total} — odśwież stronę przy włączonej sieci`}
              <Button kind="ghost" className="px-2 py-0.5 text-xs" onClick={runCheck}>
                Sprawdź
              </Button>
            </dd>
          </>
        ) : null}
      </dl>
      <h3 className="mt-4 mb-1 text-sm font-medium">Bez sieci działa wszystko poza:</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="offline-exceptions">
        {NEEDS_NETWORK.map((item) => (
          <li key={item.what}>
            <span className="font-medium">{item.what}</span> — {item.detail}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Widoki (Dziś, Nadchodzące, listy, tablica, kalendarz, oś czasu, nawyki, skupienie, przeglądy), szybkie dodawanie, edycja, kosz i ustawienia pracują na lokalnej bazie.
      </p>
    </Card>
  );
}
