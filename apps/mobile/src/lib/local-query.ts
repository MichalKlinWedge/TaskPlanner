/**
 * Hooki ekranów: zapytanie do lokalnej bazy odświeżane po zmianie podanych tabel, zmianie konta
 * i powrocie na ekran; stan synchronizacji ze wskaźnikiem.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SyncEngine } from '@taskplanner/sync';

import { localEngine, onSessionChange, onSyncStatus, syncStatus } from './sync';

export function useLocalQuery<T>(tables: readonly string[], query: (engine: SyncEngine) => Promise<T>, deps: readonly unknown[] = []): T | undefined {
  const [value, setValue] = useState<T>();
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  });
  const [version, setVersion] = useState(0);
  const key = tables.join(',');
  // Zależności zapytania jako jeden klucz (lista literalna dla reguł hooków).
  const depsKey = JSON.stringify(deps);

  useEffect(() => onSessionChange(() => setVersion((v) => v + 1)), []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      let unwatch: (() => void) | undefined;
      const run = (engine: SyncEngine) =>
        queryRef
          .current(engine)
          .then((result) => alive && setValue(result))
          .catch((error) => console.warn('zapytanie lokalne', error));
      localEngine()
        .then((engine) => {
          if (!alive) return;
          unwatch = engine.watch(key.split(','), () => void run(engine));
          void run(engine);
        })
        .catch((error) => console.warn('lokalna baza', error));
      return () => {
        alive = false;
        unwatch?.();
      };
      // `version` i `depsKey` celowo: nowe zapytanie po zmianie konta albo parametrów.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, version, depsKey]),
  );
  return value;
}

export const useSyncStatus = () => useSyncExternalStore(onSyncStatus, syncStatus);
