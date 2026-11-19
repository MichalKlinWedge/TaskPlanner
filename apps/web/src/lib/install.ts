"use client";

/**
 * Instalacja PWA na pulpicie (M20): Chrome/Edge wysyłają `beforeinstallprompt`, gdy aplikację da się
 * zainstalować — zdarzenie przychodzi zaraz po wczytaniu strony, więc łapiemy je przy imporcie modułu
 * (`app-root.tsx`), a przycisk w Ustawieniach wywołuje je później. Firefox i Safari go nie mają.
 */

/** `BeforeInstallPromptEvent` — poza standardowymi typami DOM. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallState =
  /** Strona działa jako zainstalowana aplikacja albo właśnie ją zainstalowano. */
  | "installed"
  /** Przeglądarka pozwala zainstalować — przycisk wywoła jej okno. */
  | "available"
  /** Brak zdarzenia: przeglądarka bez instalacji, aplikacja już zainstalowana albo tryb deweloperski. */
  | "unknown";

let deferred: InstallPromptEvent | null = null;
let state: InstallState = "unknown";
const listeners = new Set<() => void>();
const set = (next: InstallState) => {
  state = next;
  listeners.forEach((l) => l());
};

const standalone = () => window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: window-controls-overlay)").matches;

if (typeof window !== "undefined") {
  if (standalone()) state = "installed";
  window.addEventListener("beforeinstallprompt", (event) => {
    // Bez paska Chrome'a „Zainstaluj” — instalacja z Ustawień albo z ikony w pasku adresu.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    set("available");
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    set("installed");
  });
}

export const installState = () => state;
export const subscribeInstall = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Okno instalacji przeglądarki; `false`, gdy użytkownik je zamknął albo nie ma czego pokazać. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  // Zdarzenia można użyć tylko raz; po odmowie przeglądarka może wysłać nowe.
  deferred = null;
  set("unknown");
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === "accepted") set("installed");
  return outcome === "accepted";
}
