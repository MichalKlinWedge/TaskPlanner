/**
 * Wycinek strony z zakładki (`/#share?…`, core `web-clip.ts`). Odczyt przy wczytaniu modułu i od razu usunięcie
 * z adresu (i z wpisu historii karty): treść obcej strony nie może trafić do dziennika błędów ani do innych
 * czytelników części `#` (logowanie Supabase, trasy). Czeka w pamięci karty, aż otworzy go okno szybkiego dodawania.
 */
import { isWebClipHash, parseWebClip, type WebClip } from "@taskplanner/core";

let pending: WebClip | null = null;

/** Adres bez wycinka; router Next przy hydratacji potrafi go przywrócić, więc `AppRoot` woła to jeszcze raz. */
export function clearClipHash() {
  if (isWebClipHash(window.location.hash)) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
}

if (typeof window !== "undefined" && isWebClipHash(window.location.hash)) {
  pending = parseWebClip(window.location.hash);
  clearClipHash();
}

/** Wycinek czekający na okno szybkiego dodawania. */
export const pendingClip = (): WebClip | null => pending;

/** Okno zamknięte (dodano albo anulowano) — wycinek już niepotrzebny. */
export const dropClip = () => {
  pending = null;
};
