/**
 * Chip „Eksport XLSX” w nagłówku widoku (Inbox, Dziś, Nadchodzące, lista / projekt, tablica, tag, filtr):
 * wiersze liczone dopiero po dotknięciu (`rows`, w kolejności widoku), plik przez `lib/export.ts`.
 * Oś czasu ma własne arkusze (`sheets`: siatka okresów + szczegóły, jak na webie).
 */
import { plural, type TaskExportRow, type XlsxSheet } from '@taskplanner/core';
import { useState } from 'react';

import { useAppData } from '@/lib/app-data';
import { shareTasksXlsx, shareXlsx } from '@/lib/export';

import { useTaskActions } from './actions';
import { OptionChip } from './view-options';

const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

type ExportSource = { rows: () => TaskExportRow[]; sheets?: never } | { sheets: () => { sheets: XlsxSheet[]; count: number }; rows?: never };

export function ExportChip({ title, ...source }: { title: string } & ExportSource) {
  const data = useAppData();
  const { notify } = useTaskActions();
  const [busy, setBusy] = useState(false);
  const run = () => {
    if (busy) return;
    const list = source.rows?.();
    const own = source.sheets?.();
    const count = list ? list.length : (own?.count ?? 0);
    if (!count) return notify('Brak zadań do eksportu.');
    setBusy(true);
    (list ? shareTasksXlsx(title, list, data) : shareXlsx(title, own?.sheets ?? [], data.settings.timeZone))
      .then((fileName) => notify(`Zapisano ${fileName}: ${plural(count, TASKS)}.`))
      .catch((e: unknown) => notify(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return <OptionChip label={busy ? 'Eksport…' : 'Eksport XLSX'} accessibilityLabel="Zapisz widoczne zadania do pliku Excel i udostępnij" onPress={run} />;
}
