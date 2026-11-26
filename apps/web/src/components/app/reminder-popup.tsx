"use client";

/**
 * Okno przypomnienia na środku ekranu (Ustawienia → „Powiadomienia” → „Przypomnienia w aplikacji” = „W dzwonku
 * i okno na środku ekranu”): wybite przypomnienie z dzwonka (core `reminderPopups`) z „Ukończ”, „Przypomnij za
 * 15 min / 30 min / 1 h”, „Otwórz zadanie” i „Zamknij” (Esc — wpis zostaje w dzwonku nieprzeczytany). Zapis jak
 * z powiadomienia systemowego (`useReminderAction`, z „Cofnij”). Stan zamkniętych okien — `localStorage`
 * `tp-reminder-bell`, wspólny dla kart, więc decyzja w jednej karcie zamyka okno w pozostałych.
 */
import { notificationText, notificationTime, REMINDER_SNOOZE_OPTIONS, reminderPopups, reminderSnoozeLabel, type AppNotification } from "@taskplanner/core";
import { useEffect, useRef, useState } from "react";

import { closeReminderPopups, dismissNotifications, markNotificationsRead, useNotifications, useReminderBell } from "@/lib/notifications";

import { useAppEnv } from "./app-env";
import { useReminderAction } from "./reminder-actions";
import { useTaskActions } from "./task-item";

const fireKey = (n: AppNotification) => n.id.slice(2);

export function ReminderPopup({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { store, userId, openTask } = useAppEnv();
  const { notify } = useTaskActions();
  const act = useReminderAction();
  const { list, prefs, timeZone } = useNotifications(store, userId);
  const bell = useReminderBell();
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Co 10 s: wpis dzwonka ma czas wybicia, więc okno pokaże się najwyżej tyle po nim.
    const timer = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const queue = reminderPopups(list, prefs, bell, now);
  const current = queue[0] ?? null;
  const shown = current !== null;
  useEffect(() => onOpenChange(shown), [shown, onOpenChange]);
  // Fokus na oknie, nie na przycisku: Enter pisany w innym polu nie ukończy zadania przez przypadek.
  useEffect(() => {
    if (current) box.current?.focus();
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeReminderPopups([current]);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [current]);

  if (!current) return null;
  const n = current;
  const { detail } = notificationText(n);
  const title = typeof n.data.title === "string" ? n.data.title : "Zadanie";
  const step = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
      closeReminderPopups([n]);
    } finally {
      setBusy(false);
    }
  };
  const done = () =>
    step(async () => {
      await act({ action: "done", taskId: n.taskId!, key: fireKey(n) });
      markNotificationsRead(store, [n]);
    });
  const snooze = (minutes: number) =>
    step(async () => {
      if (await act({ action: "snooze", taskId: n.taskId!, key: fireKey(n), minutes })) dismissNotifications(store, [n]);
      else closeReminderPopups([n]);
    });
  const button = "rounded-md border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-[var(--hover)] disabled:opacity-50";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={box}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tp-reminder-popup-title"
        aria-describedby="tp-reminder-popup-detail"
        className="w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-2xl outline-none"
        data-testid="reminder-popup"
      >
        <div className="mb-1 flex items-center gap-2 text-xs text-[var(--muted)]">
          <span aria-hidden className="text-base">
            ⏰
          </span>
          <span>Przypomnienie · {notificationTime(n.at, now, timeZone)}</span>
          {queue.length > 1 ? <span className="ml-auto">1 z {queue.length}</span> : null}
        </div>
        <h2 id="tp-reminder-popup-title" className="text-lg font-semibold break-words">
          {title}
        </h2>
        <p id="tp-reminder-popup-detail" className="mt-0.5 text-sm text-[var(--muted)]">
          {detail}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void done()} className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
            ✓ Ukończ
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              markNotificationsRead(store, [n]);
              openTask(n.taskId!);
            }}
            className={button}
          >
            Otwórz zadanie
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Przypomnij ponownie">
          <span className="text-[var(--muted)]">Przypomnij za</span>
          {REMINDER_SNOOZE_OPTIONS.map((m) => (
            <button key={m} type="button" disabled={busy} onClick={() => void snooze(m)} className={button}>
              {reminderSnoozeLabel(m)}
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t border-[var(--line)] pt-3 text-sm">
          {queue.length > 1 ? (
            <button type="button" onClick={() => closeReminderPopups(queue)} className="text-[var(--muted)] hover:text-[var(--foreground)]">
              Zamknij wszystkie ({queue.length})
            </button>
          ) : null}
          <button type="button" onClick={() => closeReminderPopups([n])} className="text-[var(--muted)] hover:text-[var(--foreground)]" title="Zostaje w dzwonku 🔔">
            Zamknij (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}
