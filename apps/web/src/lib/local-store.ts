"use client";

/**
 * Lokalna baza w przeglądarce dla widoków: jedna koordynacja kart (`connectTabs`) na użytkownika
 * i stronę oraz hook zapytania odświeżanego po zmianach w tabelach. UI czyta i pisze tylko tu.
 */
import { connectTabs, supabaseRemote, SyncEngine, type SqlRow, type SqlValue, type TabStore } from "@taskplanner/sync";
import { openWasmDb } from "@taskplanner/sync/wasm";
import { useEffect, useState } from "react";

import { supabaseBrowser } from "./supabase-browser";

export interface StoreStatus {
  storage: string;
  error: string | null;
}

let current: { userId: string; store: TabStore; status: StoreStatus; listeners: Set<() => void> } | null = null;

export function storeFor(userId: string): TabStore {
  if (current?.userId === userId) return current.store;
  closeStore();
  const supabase = supabaseBrowser();
  const status: StoreStatus = { storage: "—", error: null };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<StoreStatus>) => {
    Object.assign(status, patch);
    listeners.forEach((listener) => listener());
  };
  const store = connectTabs({
    createEngine: async () => {
      const worker = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" });
      const db = await openWasmDb(worker);
      update({ storage: db.persistent ? "OPFS (trwała)" : `pamięć (${db.reason ?? "brak OPFS"})` });
      const engine = await SyncEngine.open({
        db,
        remote: supabaseRemote(supabase),
        userId,
        onError: (e) => update({ error: String(e) }),
        onRejected: (ops) => update({ error: `Odrzucone: ${ops.map((o) => o.code).join(", ")}` }),
      });
      engine.start();
      await engine.sync().catch((e) => update({ error: String(e) }));
      return engine;
    },
  });
  current = { userId, store, status, listeners };
  return store;
}

export function closeStore() {
  current?.store.close();
  current = null;
}

/** Stan bazy (rodzaj pamięci, ostatni błąd) — odświeża komponent przy zmianie. */
export function useStoreStatus(): StoreStatus {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!current) return;
    const listener = () => setTick((n) => n + 1);
    current.listeners.add(listener);
    return () => void current?.listeners.delete(listener);
  }, []);
  return current?.status ?? { storage: "—", error: null };
}

/**
 * Wiersze zapytania do lokalnej bazy, ponownie po każdej zmianie w `tables`. `ms` — czas
 * ostatniego zapytania (pomiar w PoC-5).
 */
export function useLocalQuery<Row extends SqlRow>(
  store: TabStore | null,
  sql: string,
  params: readonly SqlValue[],
  tables: readonly string[],
): { rows: Row[]; ms: number | null } {
  const [state, setState] = useState<{ rows: Row[]; ms: number | null }>({ rows: [], ms: null });
  const key = JSON.stringify([sql, params, tables]);
  useEffect(() => {
    if (!store) return;
    let alive = true;
    const run = async () => {
      const start = performance.now();
      const rows = await store.query<Row>(sql, params);
      if (alive) setState({ rows, ms: performance.now() - start });
    };
    void Promise.resolve().then(run);
    const off = store.watch(tables, () => void run());
    return () => {
      alive = false;
      off();
    };
    // `key` zastępuje porównanie tablic `params` i `tables`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key]);
  return state;
}
