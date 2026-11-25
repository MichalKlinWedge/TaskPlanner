/**
 * Definitywne usunięcie zadań z kosza (M3): prosto na serwer (`purge_tasks`), bo tylko on wie, czy zadanie
 * nadal leży w koszu. Lokalną kopię usuwa pobranie — nagrobki przychodzą jako `_gone`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PurgeOptions {
  /** Synchronizacja aplikacji: przed — żeby przeniesienie do kosza było na serwerze, po — żeby zadanie zniknęło u siebie. */
  sync: () => Promise<unknown>;
  /** Błąd sprzątania po usunięciu (pliki, pobranie) — zadania na serwerze już nie ma. */
  onError?: (error: unknown) => void;
  bucket?: string;
}

/** Ile zadań zniknęło z serwera. Błąd serwera ma `code` (`TP003`, `TP007`) — tekst: core `purgeErrorText`. */
export async function purgeTasks(client: SupabaseClient, ids: readonly string[], { sync, onError, bucket = 'attachments' }: PurgeOptions): Promise<number> {
  await sync();
  const { data, error } = await client.rpc('purge_tasks', { p_ids: ids });
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  const { purged = [], files = [] } = (data ?? {}) as { purged?: string[]; files?: string[] };
  const cleanUp = async () => {
    // Nieskasowane pliki serwer zwróci przy następnym usunięciu.
    for (let i = 0; i < files.length; i += 100) {
      const { error: failed } = await client.storage.from(bucket).remove(files.slice(i, i + 100));
      if (failed) throw failed;
    }
  };
  await Promise.all([sync().catch((e) => onError?.(e)), cleanUp().catch((e) => onError?.(e))]);
  return purged.length;
}
