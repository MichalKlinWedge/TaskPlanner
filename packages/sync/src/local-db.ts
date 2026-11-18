/**
 * Wspólny interfejs lokalnej bazy SQLite na telefonie (expo-sqlite), w przeglądarce (sqlite-wasm
 * w workerze) i w testach (node:sqlite). Silnik synchronizacji zna tylko ten interfejs.
 */

export type SqlValue = string | number | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface LocalDb {
  /** Zapytanie zwracające wiersze. */
  all<Row extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  /** Zapytanie bez wyniku (insert, update, DDL). */
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  /** Kilka zapisów w jednej transakcji (wiersz lokalny + wpis w outboxie). Bez zagnieżdżania. */
  transaction<T>(work: (tx: LocalDb) => Promise<T>): Promise<T>;
}

/** Minimalny sterownik: jedno połączenie, wywołania synchroniczne albo asynchroniczne. */
export interface SqlDriver {
  all(sql: string, params: readonly SqlValue[]): SqlRow[] | Promise<SqlRow[]>;
  run(sql: string, params: readonly SqlValue[]): unknown;
}

/**
 * `LocalDb` nad sterownikiem z jednym połączeniem: wszystkie wywołania idą po kolei (kolejka),
 * a transakcja trzyma kolejkę do końca — zapytanie spoza transakcji nie wejdzie w jej środek.
 */
export function createLocalDb(driver: SqlDriver): LocalDb {
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const inner: LocalDb = {
    all: async <Row extends SqlRow>(sql: string, params: readonly SqlValue[] = []) => (await driver.all(sql, params)) as Row[],
    run: async (sql, params = []) => {
      await driver.run(sql, params);
    },
    transaction: () => Promise.reject(new Error('Zagnieżdżona transakcja lokalnej bazy.')),
  };
  return {
    all: (sql, params) => exclusive(() => inner.all(sql, params)),
    run: (sql, params) => exclusive(() => inner.run(sql, params)),
    transaction: (work) =>
      exclusive(async () => {
        await driver.run('begin immediate', []);
        try {
          const result = await work(inner);
          await driver.run('commit', []);
          return result;
        } catch (error) {
          await driver.run('rollback', []);
          throw error;
        }
      }),
  };
}
