/**
 * Chip „Eksport XLSX” w nagłówku widoku (lista / projekt, tablica, tag, filtr, oś czasu): wiersze liczone
 * dopiero po dotknięciu (`rows`, w kolejności widoku), plik przez `lib/export.ts` (`useExport`). Widoki zbiorcze
 * mają eksport w arkuszu „⋯ Widok” (`useSmartView`). Oś czasu ma własne arkusze (`sheets`: siatka okresów +
 * szczegóły, jak na webie).
 */
import { OptionChip, useExport, type ExportSource } from './view-options';

export function ExportChip({ title, ...source }: { title: string } & ExportSource) {
  const { busy, run } = useExport(title, source as ExportSource);
  return <OptionChip label={busy ? 'Eksport…' : 'Eksport XLSX'} accessibilityLabel="Zapisz widoczne zadania do pliku Excel i udostępnij" onPress={run} />;
}
