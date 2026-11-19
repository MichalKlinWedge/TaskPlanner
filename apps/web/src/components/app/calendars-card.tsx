"use client";

/**
 * Ustawienia → „Połączone kalendarze” (M18, Etap 5): konta Google i adresy ICS, wybór kalendarzy
 * widocznych obok zadań, odświeżenie i odłączenie. Lista z lokalnej bazy (tylko do odczytu — przychodzi
 * synchronizacją), działania przez `calendar-sync` (online). Wydarzenia są tylko do odczytu.
 */
import { relativeDay, localDateAt, localDateTimeAt } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useState } from "react";

import { addIcs, connectGoogle, disconnectCalendarAccount, setCalendarVisible, syncCalendarAccount } from "@/lib/calendars";
import { useLocalQuery } from "@/lib/local-store";

import { Button, Card, Input, Notice } from "./ui";

interface AccountRow extends Record<string, string | number | null> {
  id: string;
  provider: string;
  label: string;
  status: string;
  last_synced_at: string | null;
  last_error: string | null;
}

interface CalendarRow extends Record<string, string | number | null> {
  id: string;
  account_id: string;
  name: string;
  color: string | null;
  visible: number;
  events: number;
}

const STATUS: Record<string, string> = { active: "połączone", error: "błąd synchronizacji", revoked: "dostęp odwołany — połącz ponownie" };

export function CalendarsCard({ store, timeZone }: { store: TabStore; timeZone?: string }) {
  const accounts = useLocalQuery<AccountRow>(store, "select id, provider, label, status, last_synced_at, last_error from calendar_accounts order by created_at", [], ["calendar_accounts"]).rows;
  const calendars = useLocalQuery<CalendarRow>(
    store,
    "select c.id, c.account_id, c.name, c.color, c.visible, (select count(*) from calendar_events e where e.calendar_id = c.id) as events from calendars c order by c.name",
    [],
    ["calendars", "calendar_events"],
  ).rows;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const [icsUrl, setIcsUrl] = useState("");
  const [icsOpen, setIcsOpen] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (ok) setMessage({ tone: "ok", text: ok });
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const synced = (at: string | null) => {
    if (!at) return "jeszcze nie";
    const today = localDateAt(new Date(), timeZone);
    return `${relativeDay(localDateAt(at, timeZone), today)} ${localDateTimeAt(at, timeZone).slice(11)}`;
  };

  return (
    <Card className="mt-4">
      <h2 className="mb-1 text-sm font-semibold">Połączone kalendarze</h2>
      <p className="mb-3 text-xs text-[var(--muted)]">Spotkania z kalendarzy widać w kalendarzu obok zadań (tylko do odczytu). Odświeżają się same co kilka minut.</p>

      <div className="mb-3 flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => act(connectGoogle)}>
          Połącz Google Calendar
        </Button>
        <Button kind="ghost" disabled={busy} onClick={() => setIcsOpen((o) => !o)} aria-expanded={icsOpen}>
          Dodaj adres ICS
        </Button>
      </div>
      {icsOpen ? (
        <form
          className="mb-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await addIcs(icsUrl.trim());
              setIcsUrl("");
              setIcsOpen(false);
            }, "Kalendarz ICS dodany.");
          }}
        >
          <Input
            aria-label="Adres ICS"
            type="url"
            required
            placeholder="https://… albo webcal://…"
            value={icsUrl}
            onChange={(e) => setIcsUrl(e.target.value)}
            className="min-w-0 flex-1"
            autoComplete="off"
          />
          <Button type="submit" kind="primary" disabled={busy || !icsUrl.trim()}>
            Dodaj
          </Button>
          <p className="w-full text-xs text-[var(--muted)]">Prywatny adres ICS daje dostęp do kalendarza — trzymamy go po stronie serwera, nie w przeglądarce.</p>
        </form>
      ) : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {accounts.length ? (
        <ul className="mt-2 divide-y divide-[var(--line)] text-sm" aria-label="Konta kalendarzy">
          {accounts.map((a) => (
            <li key={a.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  {a.label}
                  <span className="block text-xs text-[var(--muted)]">
                    {a.provider === "google" ? "Google" : "ICS"} · {STATUS[a.status] ?? a.status} · synchronizacja: {synced(a.last_synced_at)}
                  </span>
                  {a.last_error && a.status !== "active" ? <span className="block text-xs text-[var(--danger)]">{a.last_error}</span> : null}
                </span>
                <Button kind="ghost" disabled={busy} onClick={() => act(() => syncCalendarAccount(a.id), "Odświeżono.")}>
                  Odśwież
                </Button>
                <Button kind="ghost" disabled={busy} onClick={() => window.confirm(`Odłączyć „${a.label}”? Wydarzenia z tego konta znikną z aplikacji.`) && act(() => disconnectCalendarAccount(a.id), "Odłączono.")}>
                  Odłącz
                </Button>
              </div>
              <ul className="mt-1 flex flex-col gap-1 pl-2" aria-label={`Kalendarze ${a.label}`}>
                {calendars
                  .filter((c) => c.account_id === a.id)
                  .map((c) => (
                    <li key={c.id}>
                      <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" checked={!!c.visible} disabled={busy} onChange={(e) => act(() => setCalendarVisible(c.id, e.target.checked))} />
                        <span className="inline-block size-2.5 rounded-full" style={{ background: c.color ?? "var(--muted)" }} aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        <span className="text-[var(--muted)]">{c.visible ? `${c.events} wyd.` : "ukryty"}</span>
                      </label>
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-[var(--muted)]">Brak połączonych kalendarzy.</p>
      )}
    </Card>
  );
}
