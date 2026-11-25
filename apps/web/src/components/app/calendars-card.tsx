"use client";

/**
 * Ustawienia → „Połączone kalendarze” (M18, Etap 5, Etap 12): konta Google i adresy ICS, wybór kalendarzy
 * widocznych obok zadań, odświeżenie i odłączenie. Lista z lokalnej bazy (tylko do odczytu — przychodzi
 * synchronizacją), działania przez `calendar-sync` (online). Wydarzenia są tylko do odczytu.
 *
 * Etap 12: przestrzenie, których zadania z godziną idą do kalendarza „Task Planner” na wybranym koncie
 * Google — `profiles.calendar_sync`, zapis lokalny (działa offline); serwer tworzy kalendarz i synchronizuje.
 */
import { CalendarSync, relativeDay, localDateAt, localDateTimeAt } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useState } from "react";

import { addIcs, connectGoogle, disconnectCalendarAccount, setCalendarVisible, syncCalendarAccount } from "@/lib/calendars";
import { useLocalQuery } from "@/lib/local-store";

import { CollapsibleCard } from "./collapsible-card";
import { Button, Input, Notice } from "./ui";

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
  is_task_target: number;
  events: number;
}

interface WorkspaceRow extends Record<string, string | number | null> {
  id: string;
  name: string;
}

function parseCalendarSync(value: string | number | null | undefined): CalendarSync | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = CalendarSync.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const STATUS: Record<string, string> = { active: "połączone", error: "błąd synchronizacji", revoked: "dostęp odwołany — połącz ponownie" };

export function CalendarsCard({ store, timeZone }: { store: TabStore; timeZone?: string }) {
  const accounts = useLocalQuery<AccountRow>(store, "select id, provider, label, status, last_synced_at, last_error from calendar_accounts order by created_at", [], ["calendar_accounts"]).rows;
  const calendars = useLocalQuery<CalendarRow>(
    store,
    "select c.id, c.account_id, c.name, c.color, c.visible, c.is_task_target, (select count(*) from calendar_events e where e.calendar_id = c.id) as events from calendars c order by c.name",
    [],
    ["calendars", "calendar_events"],
  ).rows;
  // Lokalna baza jest jednego użytkownika — jedyny profil to jego.
  const profile = useLocalQuery<{ id: string; calendar_sync: string | null }>(store, "select id, calendar_sync from profiles limit 1", [], ["profiles"]).rows[0];
  const workspaces = useLocalQuery<WorkspaceRow>(
    store,
    "select id, name from workspaces where deleted_at is null and archived_at is null order by sort_key, id",
    [],
    ["workspaces"],
  ).rows;
  const sync = parseCalendarSync(profile?.calendar_sync);
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

  /** Zaznaczenie przestrzeni na koncie; wybór innego konta przenosi wysyłanie (jeden kalendarz zadań). */
  const toggleWorkspace = (account: AccountRow, workspaceId: string, on: boolean) => {
    if (!profile) return;
    const current = sync?.accountId === account.id ? sync.workspaceIds : [];
    if (on && sync && sync.accountId !== account.id && sync.workspaceIds.length) {
      const other = accounts.find((a) => a.id === sync.accountId)?.label ?? "innym koncie";
      if (!window.confirm(`Zadania przestaną trafiać do kalendarza „Task Planner” na ${other}. Wysyłać je na ${account.label}?`)) return;
    }
    const workspaceIds = on ? [...new Set([...current, workspaceId])] : current.filter((id) => id !== workspaceId);
    setMessage(null);
    void store.mutate("profiles", profile.id, { calendar_sync: { accountId: account.id, workspaceIds } }).catch((e: unknown) => {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    });
  };

  const synced = (at: string | null) => {
    if (!at) return "jeszcze nie";
    const today = localDateAt(new Date(), timeZone);
    return `${relativeDay(localDateAt(at, timeZone), today)} ${localDateTimeAt(at, timeZone).slice(11)}`;
  };

  return (
    <CollapsibleCard id="calendars" title="Połączone kalendarze" alert={accounts.some((a) => a.status !== "active")}>
      <p className="mb-3 text-xs text-[var(--muted)]">
        Spotkania z kalendarzy widać w kalendarzu obok zadań (tylko do odczytu). Odświeżają się same co kilka minut. Zadania z godziną z wybranych przestrzeni mogą też trafiać do
        osobnego kalendarza „Task Planner” w Google — przesunięcie tam zmienia zadanie.
      </p>

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
                  {a.last_error ? <span className="block text-xs text-[var(--danger)]">{a.last_error}</span> : null}
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
                  .filter((c) => c.account_id === a.id && !c.is_task_target)
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
              {a.provider === "google" ? (
                <TaskTarget
                  account={a}
                  target={calendars.find((c) => c.account_id === a.id && c.is_task_target)}
                  selected={sync?.accountId === a.id ? sync.workspaceIds : []}
                  workspaces={workspaces}
                  disabled={!profile || a.status === "revoked"}
                  onToggle={(id, on) => toggleWorkspace(a, id, on)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-[var(--muted)]">Brak połączonych kalendarzy.</p>
      )}
    </CollapsibleCard>
  );
}

function TaskTarget({
  account,
  target,
  selected,
  workspaces,
  disabled,
  onToggle,
}: {
  account: AccountRow;
  target: CalendarRow | undefined;
  selected: readonly string[];
  workspaces: WorkspaceRow[];
  disabled: boolean;
  onToggle: (workspaceId: string, on: boolean) => void;
}) {
  const status = !selected.length
    ? "wyłączone"
    : target
      ? `wysyłane do „${target.name}”`
      : account.last_error
        ? "czeka na zgodę na zapis"
        : "kalendarz „Task Planner” powstanie przy synchronizacji";
  return (
    <fieldset className="mt-2 pl-2">
      <legend className="text-xs font-medium">Zadania z godziną → Google ({status})</legend>
      {workspaces.length ? (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {workspaces.map((w) => (
            <label key={w.id} className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={selected.includes(w.id)} disabled={disabled} onChange={(e) => onToggle(w.id, e.target.checked)} />
              <span>{w.name}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className="text-xs text-[var(--muted)]">Brak przestrzeni.</p>
      )}
      <p className="mt-1 text-xs text-[var(--muted)]">
        Przesunięcie, zmiana długości albo tytułu wydarzenia w Google zmienia zadanie; usunięcie wydarzenia zostawia zadanie bez godziny. Odznaczenie przestrzeni usuwa jej
        wydarzenia z Google (zadania zostają).
      </p>
    </fieldset>
  );
}
