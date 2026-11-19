/**
 * Eksport i import kopii JSON (Etap 13) nad lokalną bazą. Format, walidacja i plan zmian są
 * w `@taskplanner/core` (`backup.ts`); tu tylko odczyt wierszy i zapis przez `mutateMany` —
 * import idzie zwykłą drogą (outbox → `push_changes`), z tymi samymi id.
 * Działa z `SyncEngine` (`db.all`) i z `TabStore` (`query`) — oba mają `mutateMany`.
 */
import { BACKUP_TABLES, backupImportPlan, createBackup, type Backup, type BackupPlan, type BackupTable } from '@taskplanner/core';

import type { SqlRow, SqlValue } from './local-db.ts';
import { decodeRow } from './merge.ts';

export type BackupQuery = <Row extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]) => Promise<Row[]>;
export type BackupMutate = (ops: readonly { table: BackupTable; id: string; patch: Record<string, unknown> }[]) => Promise<unknown>;

/** Parametrów na zapytanie (jak w silniku — najniższy limit SQLite). */
const MAX_PARAMS = 999;
/** Zmian na jedną transakcję `mutateMany` (przerwany import da się po prostu powtórzyć). */
const IMPORT_CHUNK = 500;

/** Wszystkie dane użytkownika z lokalnej bazy (także kosz). */
export async function exportBackup(query: BackupQuery, userId: string, exportedAt = new Date().toISOString()): Promise<Backup> {
  const tables: Partial<Record<BackupTable, Record<string, unknown>[]>> = {};
  for (const table of BACKUP_TABLES) {
    const rows = table === 'profiles' ? await query('select * from profiles where id = ?', [userId]) : await query(`select * from ${table}`);
    tables[table] = rows.map((row) => decodeRow(table, row));
  }
  return createBackup({ userId, exportedAt, tables });
}

/** Plan importu względem lokalnej bazy (podgląd przed potwierdzeniem). */
export async function planBackupImport(query: BackupQuery, backup: Backup, userId: string): Promise<BackupPlan> {
  const local = new Map<string, Record<string, unknown>>();
  const ids = (table: BackupTable) => backup.tables[table].map((row) => (table === 'profiles' && row.id === backup.userId ? userId : row.id));
  for (const table of BACKUP_TABLES) {
    const all = ids(table);
    for (let i = 0; i < all.length; i += MAX_PARAMS) {
      const part = all.slice(i, i + MAX_PARAMS);
      for (const row of await query(`select * from ${table} where id in (${part.map(() => '?').join(', ')})`, part)) {
        local.set(`${table}:${row.id as string}`, decodeRow(table, row));
      }
    }
  }
  return backupImportPlan(backup, (table, id) => local.get(`${table}:${id}`), userId);
}

/** Zapis planu porcjami; `onProgress` — zapisane / wszystkie zmiany. */
export async function applyBackupPlan(mutateMany: BackupMutate, plan: BackupPlan, onProgress?: (done: number, total: number) => void): Promise<void> {
  for (let i = 0; i < plan.ops.length; i += IMPORT_CHUNK) {
    await mutateMany(plan.ops.slice(i, i + IMPORT_CHUNK));
    onProgress?.(Math.min(i + IMPORT_CHUNK, plan.ops.length), plan.ops.length);
  }
}
