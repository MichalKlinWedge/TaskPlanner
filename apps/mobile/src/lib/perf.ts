/**
 * Pomiary czasu na telefonie (Etap 13, `docs/WYDAJNOSC.md`). Włączane w „Narzędziach PoC”
 * (kv `perf.log`, domyślnie wyłączone; w buildzie dev zawsze). Wyniki idą do logcat jako
 * `[perf] nazwa N ms …` (`adb logcat -s ReactNativeJS`). Para `perfStart` → `perfEnd` liczy od akcji
 * (dotknięcie zakładki, wiersza, „Ukończ”) do narysowania: koniec czeka na klatkę (rAF) i kolejkę
 * zadań (`setTimeout`), jak pomiar webu.
 */
import { useFocusEffect } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { useCallback } from 'react';

const KEY = 'perf.log';
let enabled = __DEV__ || Storage.getItemSync(KEY) === '1';
const marks = new Map<string, number>();
/** Starszy znacznik to porzucona akcja (np. dotknięcie zakładki bez wczytanych danych) — pomijany. */
const STALE_MS = 10_000;
const once = new Set<string>();

export const perfEnabled = () => enabled;

export function setPerfEnabled(on: boolean) {
  Storage.setItemSync(KEY, on ? '1' : '0');
  enabled = __DEV__ || on;
}

export function perfLog(name: string, ms: number, extra = '') {
  if (enabled) console.log(`[perf] ${name} ${Math.round(ms)} ms${extra ? ` ${extra}` : ''}`);
}

/** Czas obliczenia `fn` (np. w `useMemo`) do logu; wynik bez zmian. */
export function perfMeasure<T>(name: string, fn: () => T, extra?: (result: T) => string): T {
  if (!enabled) return fn();
  const start = performance.now();
  const result = fn();
  perfLog(name, performance.now() - start, extra?.(result));
  return result;
}

export function perfStart(name: string) {
  if (enabled) marks.set(name, performance.now());
}

/** Koniec pomiaru po narysowaniu klatki; bez wcześniejszego `perfStart` — nic. */
export function perfEnd(name: string, extra = '') {
  const start = marks.get(name);
  if (start == null) return;
  marks.delete(name);
  if (performance.now() - start > STALE_MS) return;
  requestAnimationFrame(() => setTimeout(() => perfLog(name, performance.now() - start, extra), 0));
}

/** Zimny start: czas od uruchomienia procesu (`rnStartupTiming`, jeśli jest) do narysowania; raz na proces. */
export function perfOnce(name: string, extra = '') {
  if (!enabled || once.has(name)) return;
  once.add(name);
  requestAnimationFrame(() =>
    setTimeout(() => {
      const timing = (performance as { rnStartupTiming?: { startTime?: number } }).rnStartupTiming;
      const since = timing?.startTime != null ? ` od startu ${Math.round(performance.now() - timing.startTime)} ms` : '';
      perfLog(name, performance.now(), `${extra}${since} epoch=${Date.now()}`);
    }, 0),
  );
}

/**
 * Ekran gotowy (dane wczytane, ekran na wierzchu) — kończy pomiar `name`. Przez `useFocusEffect`,
 * nie `useIsFocused`: ten drugi przerysowuje ekran przy każdym wejściu i wyjściu, czyli sam
 * dokładałby pracy do mierzonego przełączenia zakładki.
 */
export function usePerfReady(name: string, ready: boolean, extra = '') {
  useFocusEffect(
    useCallback(() => {
      if (ready) perfEnd(name, extra);
    }, [name, ready, extra]),
  );
}
