"use client";

/**
 * Ustawienia → „Błędy aplikacji” (Etap 13, D20): ostatnie wpisy własnego dziennika z serwera
 * (`client_errors`, tylko odczyt — wymaga sieci) i liczba niewysłanych z tej przeglądarki.
 */
import { ERROR_KIND, plural } from "@taskplanner/core";
import { useCallback, useEffect, useState } from "react";

import { APP_VERSION, flushErrors, queuedErrors, reportError } from "@/lib/error-log";
import { supabaseBrowser } from "@/lib/supabase-browser";

import { Button, Card, Notice } from "./ui";

interface ErrorRow {
  id: number;
  kind: string;
  platform: string;
  message: string;
  stack: string | null;
  url: string | null;
  app_version: string | null;
  count: number;
  last_at: string;
}

const dateTime = (iso: string) => new Date(iso).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });
const PLATFORM: Record<string, string> = { web: "przeglądarka", android: "telefon" };

export function ErrorsCard() {
  const [rows, setRows] = useState<ErrorRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [queued, setQueued] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setQueued(queuedErrors());
    const { data, error } = await supabaseBrowser()
      .from("client_errors")
      .select("id, kind, platform, message, stack, url, app_version, count, last_at")
      .order("last_at", { ascending: false })
      .limit(20);
    if (error) setProblem(navigator.onLine ? `Nie udało się wczytać dziennika: ${error.message}` : "Dziennik jest na serwerze — wczyta się po powrocie sieci.");
    else {
      setProblem(null);
      setRows(data);
    }
  }, []);

  useEffect(() => {
    // Wczytanie przy pokazaniu karty (zapytanie do serwera, nie do lokalnej bazy).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const sendNow = async (test: boolean) => {
    setBusy(true);
    if (test) reportError("error", new Error("Błąd testowy z Ustawień"), { test: true });
    await flushErrors();
    await load();
    setBusy(false);
  };

  return (
    <Card className="mt-4">
      <h2 className="mb-1 text-sm font-semibold">Błędy aplikacji</h2>
      <p className="mb-3 text-xs text-[var(--muted)]">
        Błędy z tej przeglądarki i telefonu trafiają do własnego dziennika na serwerze (90 dni, bez treści zadań). Wersja: {APP_VERSION}.
        {queued ? ` Czeka na wysłanie: ${plural(queued, ["wpis", "wpisy", "wpisów"])}.` : ""}
      </p>
      <div className="mb-3 flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => sendNow(false)}>
          Odśwież
        </Button>
        <Button kind="ghost" disabled={busy} onClick={() => sendNow(true)}>
          Zapisz błąd testowy
        </Button>
      </div>
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {rows && !rows.length ? <p className="text-sm text-[var(--muted)]">Brak błędów.</p> : null}
      {rows?.length ? (
        <ul className="divide-y divide-[var(--line)] text-sm" aria-label="Ostatnie błędy">
          {rows.map((r) => (
            <li key={r.id} className="py-2">
              <details>
                <summary className="cursor-pointer">
                  <span className="font-medium">{r.message}</span>
                  <span className="block text-xs text-[var(--muted)]">
                    {ERROR_KIND[r.kind as keyof typeof ERROR_KIND] ?? r.kind} · {PLATFORM[r.platform] ?? r.platform} · {dateTime(r.last_at)}
                    {r.count > 1 ? ` · ${r.count}×` : ""}
                    {r.app_version ? ` · ${r.app_version}` : ""}
                  </span>
                </summary>
                {r.url ? <p className="mt-1 text-xs text-[var(--muted)]">{r.url}</p> : null}
                {r.stack ? <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--hover)] p-2 text-xs">{r.stack}</pre> : null}
              </details>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
