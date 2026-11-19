/**
 * Kolejka plików załączników (SPECYFIKACJA §6 „Telefon — dodatkowo”, M5): plik dodany offline
 * czeka w magazynie lokalnym (przeglądarka — IndexedDB, telefon — pliki aplikacji), wysyłka idzie do
 * Storage, a wiersz `attachments` trafia do outboxu (`commit` → `mutate`) **dopiero po udanej
 * wysyłce** — inne urządzenia nigdy nie dostaną załącznika bez pliku.
 *
 * Kolejność: wysyłka → zapis wiersza → usunięcie z kolejki. Przerwanie w środku jest bezpieczne:
 * plik jest niezmienny, a ścieżka zawiera id załącznika, więc ponowna wysyłka kończy się „już
 * istnieje” (traktowane jak sukces) i zapis wiersza się powtarza (idempotentny — LWW).
 *
 * Wysyłka zależy od zadania na serwerze (reguły Storage sprawdzają zadanie), więc odmowa dostępu
 * jest ponawiana: zadanie z tego samego offline'u dociera z najbliższą synchronizacją.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type FileData = Blob | Uint8Array;

export interface PendingFile {
  /** Id przyszłego wiersza `attachments`. */
  id: string;
  taskId: string;
  storagePath: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  attempts: number;
  /** Ostatni błąd wysyłki. */
  error: string | null;
  /** Nie ponawiać (plik odrzucony na stałe albo wyczerpane próby) — do decyzji użytkownika. */
  failed: boolean;
  /** Najbliższa próba (ms od epoki). */
  nextAt: number;
}

/** Magazyn oczekujących plików (metadane + zawartość). */
export interface FileStore {
  list(): Promise<PendingFile[]>;
  /** Zapis metadanych; z `data` — także zawartości (pierwsze dodanie). */
  put(file: PendingFile, data?: FileData): Promise<void>;
  data(id: string): Promise<FileData | null>;
  remove(id: string): Promise<void>;
}

/** Błąd wysyłki; `permanent` — ponowienie nic nie da (za duży plik, zły typ). */
export class FileUploadError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent = false) {
    super(message);
    this.permanent = permanent;
  }
}

export interface FileQueueOptions {
  store: FileStore;
  /** Wysyłka do Storage; „już istnieje” = sukces. Błąd: `FileUploadError` (inny = przejściowy). */
  upload: (path: string, data: FileData, mime: string) => Promise<void>;
  /** Zapis wiersza `attachments` (outbox) po udanej wysyłce. */
  commit: (file: PendingFile) => Promise<void>;
  /** Zmiana kolejki (widoki „Wysyłanie…”). */
  onChange?: () => void;
  /** Wyłączny dostęp do kolejki (np. Web Locks — jedna karta wysyła naraz). */
  exclusive?: <T>(work: () => Promise<T>) => Promise<T>;
  now?: () => number;
  /** Ile prób przed oznaczeniem jako nieudany (domyślnie 10). */
  maxAttempts?: number;
}

export interface FileQueue {
  enqueue(file: Pick<PendingFile, 'id' | 'taskId' | 'storagePath' | 'name' | 'mime' | 'size'>, data: FileData): Promise<void>;
  /** Wysyła należne pliki; zwraca liczbę zatwierdzonych. */
  flush(): Promise<number>;
  list(): Promise<PendingFile[]>;
  /** Ponów nieudany od razu. */
  retry(id: string): Promise<void>;
  /** Porzuć plik (bez wiersza `attachments`). */
  discard(id: string): Promise<void>;
  data(id: string): Promise<FileData | null>;
}

/** Odstęp przed kolejną próbą: 5 s, 10 s, 20 s … najwyżej 10 min. */
export const retryDelayMs = (attempts: number) => Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 600_000);

export function createFileQueue({ store, upload, commit, onChange, exclusive = (work) => work(), now = Date.now, maxAttempts = 10 }: FileQueueOptions): FileQueue {
  let running: Promise<number> | null = null;

  const flushOnce = () =>
    exclusive(async () => {
      let committed = 0;
      const due = (await store.list()).filter((f) => !f.failed && f.nextAt <= now()).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      for (const file of due) {
        const data = await store.data(file.id);
        if (!data) {
          await store.remove(file.id);
          onChange?.();
          continue;
        }
        try {
          await upload(file.storagePath, data, file.mime);
          await commit(file);
          await store.remove(file.id);
          committed++;
        } catch (error) {
          const attempts = file.attempts + 1;
          const permanent = error instanceof FileUploadError && error.permanent;
          await store.put({ ...file, attempts, error: (error as Error).message ?? String(error), failed: permanent || attempts >= maxAttempts, nextAt: now() + retryDelayMs(attempts) });
        }
        onChange?.();
      }
      return committed;
    });

  return {
    async enqueue(file, data) {
      await store.put({ ...file, createdAt: new Date(now()).toISOString(), attempts: 0, error: null, failed: false, nextAt: 0 }, data);
      onChange?.();
    },
    flush() {
      // Wywołania w trakcie wysyłki czekają na nią (bez równoległych przebiegów w jednej karcie).
      running ??= flushOnce().finally(() => (running = null));
      return running;
    },
    list: () => store.list(),
    async retry(id) {
      const file = (await store.list()).find((f) => f.id === id);
      if (!file) return;
      await store.put({ ...file, failed: false, attempts: 0, nextAt: 0 });
      onChange?.();
    },
    async discard(id) {
      await store.remove(id);
      onChange?.();
    },
    data: (id) => store.data(id),
  };
}

/** Wysyłka do bucketu Supabase Storage (bez nadpisywania: plik jest niezmienny). */
export function supabaseUploader(client: SupabaseClient, bucket = 'attachments'): FileQueueOptions['upload'] {
  return async (path, data, mime) => {
    const { error } = await client.storage.from(bucket).upload(path, data, { contentType: mime || 'application/octet-stream', upsert: false });
    if (!error) return;
    const status = Number((error as { statusCode?: string | number; status?: number }).statusCode ?? (error as { status?: number }).status);
    if (status === 409 || /already exists|duplicate/i.test(error.message)) return;
    // 413 za duży, 415 / 400 zły typ — bez ponawiania; 403 (zadania jeszcze nie ma na serwerze) i sieć — ponowienie.
    throw new FileUploadError(error.message, status === 413 || status === 415 || (status === 400 && !/row-level security/i.test(error.message)));
  };
}

/** Magazyn w pamięci (testy, tryb bez trwałej bazy). */
export function memoryFileStore(): FileStore {
  const files = new Map<string, { file: PendingFile; data: FileData }>();
  return {
    list: async () => [...files.values()].map((f) => ({ ...f.file })),
    async put(file, data) {
      const current = files.get(file.id);
      if (!current && !data) return;
      files.set(file.id, { file: { ...file }, data: data ?? current!.data });
    },
    data: async (id) => files.get(id)?.data ?? null,
    remove: async (id) => void files.delete(id),
  };
}
