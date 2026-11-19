"use client";

/**
 * Magazyn plików czekających na wysyłkę (`FileStore` z `@taskplanner/sync`) w IndexedDB — wspólny
 * dla wszystkich kart, przetrwa zamknięcie przeglądarki i działa offline. Jedna baza na
 * użytkownika (`tp-files-<userId>`), jak lokalna baza SQLite (`tp-<userId>`).
 */
import type { FileData, FileStore, PendingFile } from "@taskplanner/sync";

const STORE = "files";

function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

interface Entry {
  file: PendingFile;
  data: FileData;
}

export function indexedDbFileStore(userId: string): FileStore {
  let db: Promise<IDBDatabase> | null = null;
  const tx = async (mode: IDBTransactionMode) => {
    db ??= open(`tp-files-${userId}`);
    return (await db).transaction(STORE, mode).objectStore(STORE);
  };
  return {
    async list() {
      const entries = (await done((await tx("readonly")).getAll())) as Entry[];
      return entries.map((e) => e.file);
    },
    async put(file, data) {
      const store = await tx("readwrite");
      const current = data ? null : ((await done(store.get(file.id))) as Entry | undefined);
      if (!data && !current) return;
      // Ten sam magazyn po `await` — transakcja IndexedDB kończy się bez oczekujących żądań.
      const again = current ? await tx("readwrite") : store;
      await done(again.put({ file, data: data ?? current!.data } satisfies Entry, file.id));
    },
    async data(id) {
      const entry = (await done((await tx("readonly")).get(id))) as Entry | undefined;
      return entry?.data ?? null;
    },
    async remove(id) {
      await done((await tx("readwrite")).delete(id));
    },
  };
}
