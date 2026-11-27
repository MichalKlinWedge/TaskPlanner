/**
 * Ustawienia → „Kopia zapasowa” (Etap 13) na telefonie — jak karta na webie (`backup-card.tsx`): eksport
 * wszystkich danych z lokalnej bazy do pliku JSON (systemowe „Udostępnij”: Dysk, poczta, Pliki) i import takiego
 * pliku z podglądem zmian przed zapisem. Działa offline (import wychodzi na serwer synchronizacją).
 */
import { BACKUP_TABLE, BACKUP_TABLES, BackupError, backupRowCount, plural } from '@taskplanner/core';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { useView } from '@/lib/app-data';
import { applyBackupImport, pickBackupImport, shareBackupFile, writeBackupFile, type PendingImport } from '@/lib/backup';
import { reportError } from '@/lib/error-log';
import { sessionUser } from '@/lib/config';
import { syncNow } from '@/lib/sync';

import { Button, P, Row, Section, usePalette } from './ui';

type Message = { tone: 'ok' | 'bad'; text: string } | null;

const dateTime = (iso: string) => new Date(iso).toLocaleString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const rowsText = (n: number) => plural(n, ['wiersz', 'wiersze', 'wierszy']);

const errorText = (e: unknown) => (e instanceof BackupError ? e.message : e instanceof SyntaxError ? 'To nie jest plik JSON.' : e instanceof Error ? e.message : String(e));

export function BackupSection() {
  const { data } = useView();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setMessage(null);
    try {
      await work();
    } catch (e) {
      if (!(e instanceof BackupError) && !(e instanceof SyntaxError)) reportError('error', e, { area: 'backup' });
      setMessage({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const exportFile = () =>
    act('Eksport…', async () => {
      const { backup, file } = await writeBackupFile(data.settings.timeZone);
      setMessage({ tone: 'ok', text: `Kopia gotowa: ${rowsText(backupRowCount(backup))} (${file.name}).` });
      await shareBackupFile(file);
    });

  const choose = () =>
    act('Sprawdzanie pliku…', async () => {
      const picked = await pickBackupImport();
      if (picked) setPending(picked);
    });

  const restore = (p: PendingImport) =>
    act('Przywracanie…', async () => {
      await applyBackupImport(p.plan, (done, total) => setBusy(`Przywracanie… ${done}/${total}`));
      setPending(null);
      setMessage({ tone: 'ok', text: `Przywrócono ${plural(p.plan.ops.length, ['zmianę', 'zmiany', 'zmian'])} — wysyłka na serwer idzie w tle.` });
      if (sessionUser().online) void syncNow().catch(() => undefined);
    });

  return (
    <Section title="Kopia zapasowa">
      <P muted>
        Plik JSON z danymi z tego telefonu: przestrzenie, listy, zadania i nawyki z historią, tagi, przypomnienia, zależności, czas, filtry, przeglądy, profil (także kosz). Bez
        urządzeń, połączonych kalendarzy i plików załączników. Ten sam format co na webie — kopię z telefonu wczytasz w przeglądarce i odwrotnie.
      </P>
      <Row>
        <Button title="Eksportuj do pliku" disabled={!!busy} onPress={() => void exportFile()} />
        <Button kind="secondary" title="Importuj z pliku…" disabled={!!busy} onPress={() => void choose()} />
      </Row>
      {busy ? <P muted>{busy}</P> : null}
      {message ? <P tone={message.tone}>{message.text}</P> : null}
      {pending ? <ImportPreview pending={pending} busy={!!busy} onRestore={() => void restore(pending)} onCancel={() => setPending(null)} /> : null}
    </Section>
  );
}

function ImportPreview({ pending, busy, onRestore, onCancel }: { pending: PendingImport; busy: boolean; onRestore: () => void; onCancel: () => void }) {
  const p = usePalette();
  const { backup, plan, invalid } = pending;
  const n = plan.ops.length;
  const tables = BACKUP_TABLES.filter((t) => plan.stats[t].added + plan.stats[t].changed + plan.stats[t].same > 0);
  return (
    <View accessibilityLabel="Podgląd importu" style={{ gap: 6, borderTopWidth: 1, borderTopColor: p.border, paddingTop: 8 }}>
      <P>{`${pending.name} — kopia z ${dateTime(backup.exportedAt)}, ${rowsText(backupRowCount(backup))}.`}</P>
      {plan.otherAccount ? (
        <P muted>
          Kopia pochodzi z innego konta: dane osobiste (profil, tagi, filtry, przeglądy) trafią na to konto, połączenia kalendarzy trzeba skonfigurować od nowa. Przestrzenie należące wciąż do
          tamtego konta serwer odrzuci.
        </P>
      ) : null}
      <View style={{ flexDirection: 'row' }}>
        <Text style={{ flex: 1, color: p.muted, fontSize: 12 }}>Tabela</Text>
        {['Nowe', 'Zmienione', 'Bez zmian'].map((h) => (
          <Text key={h} style={{ width: 72, textAlign: 'right', color: p.muted, fontSize: 12 }}>
            {h}
          </Text>
        ))}
      </View>
      {tables.map((t) => (
        <View key={t} style={{ flexDirection: 'row' }}>
          <Text style={{ flex: 1, color: p.fg, fontSize: 13 }}>{BACKUP_TABLE[t]}</Text>
          {[plan.stats[t].added, plan.stats[t].changed, plan.stats[t].same].map((v, i) => (
            <Text key={i} style={{ width: 72, textAlign: 'right', color: p.fg, fontSize: 13, fontVariant: ['tabular-nums'] }}>
              {v}
            </Text>
          ))}
        </View>
      ))}
      {invalid.length ? (
        <P tone="bad">
          {`Pominięte błędne wiersze: ${invalid.length}`}
          {invalid
            .slice(0, 3)
            .map((row) => `\n${BACKUP_TABLE[row.table]} ${row.id ?? '?'}: ${row.message}`)
            .join('')}
        </P>
      ) : null}
      {n ? (
        <>
          <P muted>Wiersze z kopii wrócą do stanu z pliku (także te zmienione albo usunięte po eksporcie). Wierszy, których nie ma w kopii, import nie usuwa.</P>
          <Row>
            <Button title={`Przywróć (${plural(n, ['zmiana', 'zmiany', 'zmian'])})`} disabled={busy} onPress={onRestore} />
            <Button kind="secondary" title="Anuluj" disabled={busy} onPress={onCancel} />
          </Row>
        </>
      ) : (
        <>
          <P tone="ok">Nic do zmiany — dane z kopii już są w aplikacji.</P>
          <Row>
            <Button kind="secondary" title="Zamknij" onPress={onCancel} />
          </Row>
        </>
      )}
    </View>
  );
}
