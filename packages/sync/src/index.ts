/**
 * Synchronizacja local-first (SPECYFIKACJA §6). Na razie tylko interfejs lokalnej bazy —
 * implementacje (Node do testów, expo-sqlite, sqlite-wasm w przeglądarce), outbox, HLC
 * i `push_changes`/`pull_changes` powstają w PoC-1.
 */

export type SqlValue = string | number | null | Uint8Array;

/** Wspólny interfejs lokalnej bazy SQLite na telefonie, w przeglądarce i w testach. */
export interface LocalDb {
  /** Zapytanie zwracające wiersze. */
  all<Row extends Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  /** Zapytanie bez wyniku (insert, update, DDL). */
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  /** Kilka zapisów w jednej transakcji (wiersz lokalny + wpis w outboxie). */
  transaction<T>(work: (db: LocalDb) => Promise<T>): Promise<T>;
  /** Powiadomienie o zmianie danych w podanych tabelach (reaktywne widoki). */
  watch(tables: readonly string[], onChange: () => void): () => void;
}
