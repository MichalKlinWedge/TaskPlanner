/**
 * Eksport do Excela z widoków telefonu (jak „Eksport XLSX” na webie): skoroszyt z core
 * (`tasksSheet` + `xlsxWorkbook`) zapisany w pamięci podręcznej (`Paths.cache/export`) i oddany do
 * systemowego „Udostępnij” (`expo-sharing`, jak udostępnianie załączników) — zapis na Dysku, w poczcie itd.
 */
import { exportFileName, localDateAt, taskExportNames, tasksSheet, XLSX_MIME, xlsxWorkbook, type TaskExportRow, type XlsxSheet } from '@taskplanner/core';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import type { AppData } from './app-data';

/** Zapis skoroszytu zadań widoku i arkusz „Udostępnij”; zwraca nazwę pliku. Poprzednie eksporty są usuwane. */
export async function shareTasksXlsx(title: string, rows: readonly TaskExportRow[], data: AppData): Promise<string> {
  return shareXlsx(title, [tasksSheet(rows, taskExportNames(data), { name: title, timeZone: data.settings.timeZone })], data.settings.timeZone);
}

/** Dowolne arkusze (np. oś czasu: siatka + szczegóły) → plik `<tytuł> <data>.xlsx` i „Udostępnij”; zwraca nazwę pliku. */
export async function shareXlsx(title: string, sheets: readonly XlsxSheet[], timeZone?: string): Promise<string> {
  const fileName = exportFileName(title, localDateAt(new Date(), timeZone));
  const bytes = xlsxWorkbook(sheets);
  const dir = new Directory(Paths.cache, 'export');
  if (dir.exists) dir.delete();
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, fileName);
  await file.write(bytes);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Udostępnianie plików nie działa na tym urządzeniu.');
  await Sharing.shareAsync(file.uri, { mimeType: XLSX_MIME, dialogTitle: fileName });
  return fileName;
}
