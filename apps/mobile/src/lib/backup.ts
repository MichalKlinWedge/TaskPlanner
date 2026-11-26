/**
 * Kopia JSON (Etap 13) na telefonie — ten sam format i plan co web (`core/backup.ts`, `packages/sync/src/backup.ts`).
 * Eksport: wszystkie dane z lokalnej bazy (także kosz) → plik w `Paths.cache/backups` → systemowe „Udostępnij”
 * (Dysk, poczta, Pliki). Import: plik z wyboru dokumentu → walidacja i plan (podgląd) → `mutateMany` porcjami
 * z tymi samymi id i tylko polami, które się różnią (outbox → `push_changes`; ten sam plik drugi raz nic nie zmienia).
 */
import { backupFileName, localDateAt, readBackup, type Backup, type BackupPlan, type InvalidRow } from '@taskplanner/core';
import { applyBackupPlan, exportBackup, planBackupImport } from '@taskplanner/sync';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { localEngine, mutateMany } from './sync';

export interface BackupExport {
  backup: Backup;
  file: File;
}

const backupsDir = () => new Directory(Paths.cache, 'backups');

/** Zapis kopii do pamięci podręcznej (poprzednie kopie stamtąd znikają — plik żyje tylko do udostępnienia). */
export async function writeBackupFile(timeZone?: string): Promise<BackupExport> {
  const engine = await localEngine();
  const backup = await exportBackup((sql, params) => engine.db.all(sql, params), engine.userId);
  const dir = backupsDir();
  if (dir.exists) dir.delete();
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, backupFileName(localDateAt(new Date(), timeZone)));
  await file.write(JSON.stringify(backup));
  return { backup, file };
}

/** Systemowe „Udostępnij / zapisz…” dla pliku kopii. */
export async function shareBackupFile(file: File): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Udostępnianie plików nie działa na tym telefonie.');
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: file.name });
}

export interface PendingImport {
  name: string;
  backup: Backup;
  plan: BackupPlan;
  invalid: InvalidRow[];
}

/** Wybór pliku i plan importu względem lokalnej bazy (`null` = anulowano). Rzuca `BackupError` / `SyntaxError`. */
export async function pickBackupImport(): Promise<PendingImport | null> {
  // `*/*`: Dysk i Pliki podają JSON różnie (`application/json`, `application/octet-stream`, `text/plain`).
  const picked = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
  const asset = picked.canceled ? null : picked.assets[0];
  if (!asset) return null;
  const file = new File(asset.uri);
  try {
    const { backup, invalid } = readBackup(JSON.parse(await file.text()));
    const engine = await localEngine();
    const plan = await planBackupImport((sql, params) => engine.db.all(sql, params), backup, engine.userId);
    return { name: asset.name, backup, plan, invalid };
  } finally {
    // Kopia w pamięci podręcznej nie jest już potrzebna (dane są w planie).
    if (file.exists) file.delete();
  }
}

/** Zapis planu porcjami (przerwany import da się powtórzyć tym samym plikiem). */
export const applyBackupImport = (plan: Pick<BackupPlan, 'ops'>, onProgress?: (done: number, total: number) => void) =>
  applyBackupPlan((ops) => mutateMany(ops), plan, onProgress);
