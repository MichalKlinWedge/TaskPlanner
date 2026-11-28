/**
 * Systemowy pasek nawigacji Androida: ustawienie tego telefonu (kv-store `ui.navBar`). Domyślnie schowany
 * (jak od 0.1.15 — przesunięcie od dolnej krawędzi pokazuje go na chwilę); „widoczny” zostawia stałe
 * przyciski Wstecz / Home (nawigacja 3-przyciskowa, TalkBack).
 */
import Storage from 'expo-sqlite/kv-store';
import { useSyncExternalStore } from 'react';

const KEY = 'ui.navBar';
const listeners = new Set<() => void>();
let hidden = Storage.getItemSync(KEY) !== 'visible';

export function navBarHidden(): boolean {
  return hidden;
}

export function setNavBarHidden(value: boolean) {
  if (value === hidden) return;
  hidden = value;
  Storage.setItemSync(KEY, value ? 'hidden' : 'visible');
  for (const l of listeners) l();
}

export function useNavBarHidden(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    navBarHidden,
  );
}
