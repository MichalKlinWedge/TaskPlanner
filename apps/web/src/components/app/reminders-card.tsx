"use client";

/**
 * Ustawienia → „Przypomnienia” (M8): na których urządzeniach przychodzą przypomnienia. Ta przeglądarka
 * włącza Web Push (zgoda + subskrypcja), inne urządzenia (telefon, inne przeglądarki) można tu wyłączyć
 * albo usunąć z listy — przypomnienie przychodzi tylko na urządzenia z włączonym kanałem.
 */
import type { TabStore } from "@taskplanner/sync";
import { useState } from "react";

import { useLocalQuery } from "@/lib/local-store";
import { browserDeviceId, enableBrowserReminders, forgetDevice, pushSupport, setDeviceReminders } from "@/lib/push";

import { CollapsibleCard } from "./collapsible-card";
import { Button, Notice } from "./ui";

interface DeviceRow extends Record<string, string | number | null> {
  id: string;
  name: string;
  platform: string;
  reminder_channel: string;
  push_subscription: string | null;
  last_sync_at: string | null;
}

const PLATFORM: Record<string, string> = { web: "przeglądarka", android: "telefon" };

export function RemindersCard({ store, userId }: { store: TabStore; userId: string }) {
  const { rows } = useLocalQuery<DeviceRow>(
    store,
    "select id, name, platform, reminder_channel, push_subscription, last_sync_at from devices where deleted_at is null order by created_at",
    [],
    ["devices"],
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const thisId = browserDeviceId(userId);
  const self = rows.find((d) => d.id === thisId);
  const selfOn = !!self && self.reminder_channel === "enabled" && !!self.push_subscription;
  const support = pushSupport();

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

  return (
    <CollapsibleCard id="reminders" title="Przypomnienia">
      <p className="mb-3 text-xs text-[var(--muted)]">Przypomnienie (i koniec etapu skupienia przy zamkniętej karcie) przychodzi tylko na urządzenia z włączonymi przypomnieniami.</p>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span>Ta przeglądarka:</span>
        <strong data-testid="browser-reminders">{selfOn ? "włączone" : "wyłączone"}</strong>
        {selfOn ? (
          <Button kind="ghost" disabled={busy} onClick={() => act(() => setDeviceReminders(store, thisId, false))}>
            Wyłącz
          </Button>
        ) : (
          <Button disabled={busy || support === "unsupported" || support === "denied"} onClick={() => act(() => enableBrowserReminders(store, userId), "Przypomnienia w tej przeglądarce włączone.")}>
            Włącz powiadomienia
          </Button>
        )}
      </div>
      {support === "dev" ? <p className="mb-2 text-xs text-[var(--muted)]">W trybie deweloperskim nie ma Service Workera — push działa w buildzie produkcyjnym.</p> : null}
      {support === "denied" ? <p className="mb-2 text-xs text-[var(--danger)]">Powiadomienia są zablokowane w ustawieniach przeglądarki dla tej strony.</p> : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {rows.length ? (
        <ul className="mt-2 divide-y divide-[var(--line)] text-sm" aria-label="Urządzenia">
          {rows.map((d) => {
            const on = d.reminder_channel === "enabled";
            const noPush = d.platform === "web" && !d.push_subscription;
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1">
                  {d.name}
                  {d.id === thisId ? <span className="text-[var(--muted)]"> (ta przeglądarka)</span> : null}
                  <span className="block text-xs text-[var(--muted)]">
                    {PLATFORM[d.platform] ?? d.platform}
                    {noPush && on ? " · brak zgody na powiadomienia" : ""}
                  </span>
                </span>
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={on} disabled={busy} onChange={(e) => act(() => setDeviceReminders(store, d.id, e.target.checked))} />
                  przypomnienia
                </label>
                {d.id !== thisId ? (
                  <Button kind="ghost" disabled={busy} onClick={() => window.confirm(`Usunąć „${d.name}” z listy urządzeń?`) && act(() => forgetDevice(store, d.id))}>
                    Usuń
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </CollapsibleCard>
  );
}
