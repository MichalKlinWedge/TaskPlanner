/**
 * Synchronizacja local-first (SPECYFIKACJA §6). Adaptery lokalnej bazy są w osobnych wejściach:
 * `@taskplanner/sync/node` (testy, narzędzia), `@taskplanner/sync/expo`, `@taskplanner/sync/wasm`.
 */
export { applyBackupPlan, exportBackup, planBackupImport, type BackupMutate, type BackupQuery } from './backup.ts';
export { SyncEngine, type PullProgress, type SyncEngineOptions } from './engine.ts';
export { createLocalDb, type LocalDb, type SqlDriver, type SqlRow, type SqlValue } from './local-db.ts';
export { decodeRow, encodeRow, mergeClocks, mergeRemote, parseClock, type FieldClock, type RemoteRow } from './merge.ts';
export { supabaseRemote, type PullResult, type PushOp, type PushResult, type RejectedOp, type Remote, type ScopeInfo } from './remote.ts';
export {
  isSyncedTable,
  localColumns,
  localSchema,
  READONLY,
  READONLY_TABLES,
  SYNCED_TABLES,
  TABLES,
  writableFields,
  type ReadonlyTable,
  type SyncedTable,
  type TableSpec,
} from './specs.ts';
export { connectTabs, STALE_LEADER_MESSAGE, TAB_PROTOCOL, type TabStore, type TabStoreOptions } from './tabs.ts';
