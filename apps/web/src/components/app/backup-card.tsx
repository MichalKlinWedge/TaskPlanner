"use client";

/**
 * Ustawienia → „Kopia zapasowa” (Etap 13): eksport wszystkich danych z lokalnej bazy do pliku
 * JSON i import takiego pliku (bez importu z innych narzędzi — D13). Format i plan zmian są
 * w `core/backup.ts`; import idzie przez `mutateMany` (outbox → `push_changes`) z tymi samymi id,
 * tylko z polami, które się różnią — ten sam plik drugi raz nie zmienia niczego.
 */
import { BACKUP_TABLE, BACKUP_TABLES, BackupError, backupFileName, backupRowCount, localDateAt, plural, readBackup, type Backup, type BackupPlan, type InvalidRow } from "@taskplanner/core";
import { applyBackupPlan, exportBackup, planBackupImport, type TabStore } from "@taskplanner/sync";
import { useRef, useState } from "react";

import { Button, Card, Notice } from "./ui";

interface Pending {
  name: string;
  backup: Backup;
  plan: BackupPlan;
  invalid: InvalidRow[];
}

const dateTime = (iso: string) => new Date(iso).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" });

export function BackupCard({ store, userId, timeZone }: { store: TabStore; userId: string; timeZone?: string }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setMessage(null);
    try {
      await work();
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof BackupError ? e.message : e instanceof SyntaxError ? "To nie jest plik JSON." : e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const download = () =>
    act("Eksport…", async () => {
      const backup = await exportBackup(store.query, userId);
      const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement("a"), { href: url, download: backupFileName(localDateAt(new Date(), timeZone)) });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const rows = backupRowCount(backup);
      setMessage({ tone: "ok", text: `Zapisano kopię: ${plural(rows, ["wiersz", "wiersze", "wierszy"])}.` });
    });

  const choose = (picked: File) =>
    act("Sprawdzanie pliku…", async () => {
      const { backup, invalid } = readBackup(JSON.parse(await picked.text()));
      const plan = await planBackupImport(store.query, backup, userId);
      setPending({ name: picked.name, backup, plan, invalid });
    });

  const restore = (p: Pending) =>
    act("Przywracanie…", async () => {
      await applyBackupPlan(store.mutateMany, p.plan, (done, total) => setBusy(`Przywracanie… ${done}/${total}`));
      setPending(null);
      const n = p.plan.ops.length;
      setMessage({ tone: "ok", text: `Przywrócono ${plural(n, ["zmianę", "zmiany", "zmian"])} — wysyłka na serwer idzie w tle (pasek u góry).` });
      void store.sync().catch(() => undefined);
    });

  return (
    <Card className="mt-4">
      <h2 className="mb-1 text-sm font-semibold">Kopia zapasowa</h2>
      <p className="mb-3 text-xs text-[var(--muted)]">
        Plik JSON z danymi z tej przeglądarki: przestrzenie, listy, zadania i cykliczne z historią, tagi, przypomnienia, zależności, czas, filtry, przeglądy, profil (także kosz). Bez urządzeń, połączonych kalendarzy i plików załączników (jedną przestrzeń z załącznikami, osobami i rolami zapiszesz w „Przestrzenie i listy” → „Eksportuj”).
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!!busy} onClick={() => void download()} data-testid="backup-export">
          Eksportuj do pliku
        </Button>
        <Button kind="ghost" disabled={!!busy} onClick={() => file.current?.click()} data-testid="backup-import">
          Importuj z pliku…
        </Button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          className="hidden"
          data-testid="backup-file"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = "";
            if (picked) void choose(picked);
          }}
        />
        {busy ? <span className="text-xs text-[var(--muted)]">{busy}</span> : null}
      </div>
      {message ? (
        <div className="mt-3">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      ) : null}
      {pending ? <ImportPreview pending={pending} busy={!!busy} onRestore={() => void restore(pending)} onCancel={() => setPending(null)} /> : null}
    </Card>
  );
}

function ImportPreview({ pending, busy, onRestore, onCancel }: { pending: Pending; busy: boolean; onRestore: () => void; onCancel: () => void }) {
  const { backup, plan, invalid } = pending;
  const n = plan.ops.length;
  const tables = BACKUP_TABLES.filter((t) => plan.stats[t].added + plan.stats[t].changed + plan.stats[t].same > 0);
  return (
    <section className="mt-4 rounded-md border border-[var(--line)] p-3 text-sm" aria-label="Podgląd importu" data-testid="backup-preview">
      <p className="mb-2">
        <strong>{pending.name}</strong> — kopia z {dateTime(backup.exportedAt)}, {plural(backupRowCount(backup), ["wiersz", "wiersze", "wierszy"])}.
      </p>
      {plan.otherAccount ? (
        <Notice tone="info">Kopia pochodzi z innego konta: dane osobiste (profil, tagi, filtry, przeglądy) trafią na to konto, połączenia kalendarzy trzeba skonfigurować od nowa. Przestrzenie należące wciąż do tamtego konta serwer odrzuci.</Notice>
      ) : null}
      <table className="my-2 w-full text-xs">
        <thead className="text-left text-[var(--muted)]">
          <tr>
            <th className="font-normal">Tabela</th>
            <th className="text-right font-normal">Nowe</th>
            <th className="text-right font-normal">Zmienione</th>
            <th className="text-right font-normal">Bez zmian</th>
          </tr>
        </thead>
        <tbody>
          {tables.map((t) => (
            <tr key={t}>
              <td>{BACKUP_TABLE[t]}</td>
              <td className="text-right">{plan.stats[t].added}</td>
              <td className="text-right">{plan.stats[t].changed}</td>
              <td className="text-right">{plan.stats[t].same}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {invalid.length ? (
        <Notice tone="error">
          Pominięte błędne wiersze: {invalid.length}
          {invalid.slice(0, 3).map((row) => (
            <span key={`${row.table}:${row.id}`} className="block text-xs">
              {BACKUP_TABLE[row.table]} {row.id ?? "?"}: {row.message}
            </span>
          ))}
        </Notice>
      ) : null}
      {n ? (
        <>
          <p className="my-2 text-xs text-[var(--muted)]">Wiersze z kopii wrócą do stanu z pliku (także te zmienione albo usunięte po eksporcie). Wierszy, których nie ma w kopii, import nie usuwa.</p>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={onRestore} data-testid="backup-restore">
              Przywróć ({plural(n, ["zmiana", "zmiany", "zmian"])})
            </Button>
            <Button kind="ghost" disabled={busy} onClick={onCancel}>
              Anuluj
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <Notice tone="ok">Nic do zmiany — dane z kopii już są w aplikacji.</Notice>
          <Button kind="ghost" onClick={onCancel}>
            Zamknij
          </Button>
        </div>
      )}
    </section>
  );
}
