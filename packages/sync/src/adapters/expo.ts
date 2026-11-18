/**
 * Lokalna baza na telefonie (expo-sqlite). Typ strukturalny zamiast importu, żeby pakiet nie
 * zależał od Expo: `openExpoDb(await SQLite.openDatabaseAsync('taskplanner.db'))`.
 */
import { createLocalDb, type LocalDb, type SqlRow, type SqlValue } from '../local-db.ts';

export interface ExpoSqliteDatabase {
  getAllAsync<T>(source: string, params: SqlValue[]): Promise<T[]>;
  runAsync(source: string, params: SqlValue[]): Promise<unknown>;
  execAsync(source: string): Promise<void>;
}

export async function openExpoDb(db: ExpoSqliteDatabase): Promise<LocalDb> {
  await db.execAsync('pragma journal_mode = wal');
  return createLocalDb({
    all: (sql, params) => db.getAllAsync<SqlRow>(sql, [...params]),
    run: (sql, params) => db.runAsync(sql, [...params]),
  });
}
