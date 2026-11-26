"use client";

/**
 * Centrum powiadomień (v1.x, N1): dzwonek w nagłówku z licznikiem nieprzeczytanych i listą, dymek przy nowym
 * powiadomieniu (karta widoczna) i Ustawienia → „Powiadomienia”. Logika (teksty, cel, filtr, dni) w core
 * `notifications.ts`; dane z lokalnej bazy (`lib/notifications.ts`).
 */
import {
  dismissOps,
  freshNotifications,
  markReadOps,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_GROUP_LABEL,
  notificationDays,
  notificationSeenKey,
  notificationTarget,
  notificationText,
  notificationTime,
  plural,
  unreadCount,
  visibleNotifications,
  type AppNotification,
  type NotificationChannel,
  type NotificationGroup,
  type NotificationPrefs,
} from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useEffect, useRef, useState } from "react";

import { parseSettings } from "@/lib/app-data";
import { useLocalQuery } from "@/lib/local-store";
import { requestOpenTask, useNotifications } from "@/lib/notifications";
import { routeHash } from "@/lib/route";

import { SettingsSection } from "./settings-section";
import { useTaskActions } from "./task-item";
import { Notice, Select } from "./ui";

const ICON: Record<AppNotification["kind"], string> = {
  assigned: "👤",
  comment: "💬",
  participant: "👥",
  completed: "✅",
  invite: "✉️",
  owner_offer: "🔑",
  member_joined: "➕",
  member_left: "➖",
  member_removed: "🚪",
  role_changed: "🎚️",
};

/** Licznik w tytule karty: „(3) Task Planner”. */
function useTitleCount(count: number) {
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = count ? `(${count}) ${base}` : base;
  }, [count]);
}

export function NotificationBell({ store, userId }: { store: TabStore; userId: string }) {
  const { list, prefs, timeZone } = useNotifications(store, userId);
  const [open, setOpen] = useState(false);
  const [only, setOnly] = useState<"unread" | "all">("unread");
  const [now, setNow] = useState(() => new Date());
  const box = useRef<HTMLDivElement>(null);
  const count = unreadCount(list, prefs, now);
  useTitleCount(count);

  // Czas względny („5 min temu”) i retencja liczone od „teraz” — odświeżane co minutę i przy otwarciu.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const shown = visibleNotifications(list, prefs, now, only);
  const unread = visibleNotifications(list, prefs, now, "unread");
  const apply = (ops: ReturnType<typeof markReadOps>) => (ops.length ? void store.mutateMany(ops).catch(() => undefined) : undefined);

  const activate = (n: AppNotification) => {
    apply(markReadOps([n], new Date()));
    const target = notificationTarget(n);
    setOpen(false);
    if (target.kind === "task") requestOpenTask(target.taskId);
    else if (target.kind === "workspace") window.location.assign(routeHash({ view: "manage" }));
    else if (target.kind === "invites") window.scrollTo({ top: 0 });
  };

  return (
    <div ref={box} className="relative" data-notifications>
      <button
        type="button"
        onClick={() => {
          setNow(new Date());
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={count ? `Powiadomienia: ${plural(count, ["nieprzeczytane", "nieprzeczytane", "nieprzeczytanych"])}` : "Powiadomienia"}
        title="Powiadomienia"
        className="relative px-1 text-base opacity-70 outline-none hover:opacity-100 focus-visible:opacity-100"
        data-testid="notifications-bell"
      >
        <span aria-hidden>🔔</span>
        {count ? (
          <span className="absolute -top-1 -right-1.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] leading-4 font-semibold text-white" data-testid="notifications-count">
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Powiadomienia"
          className="absolute top-full right-0 z-40 mt-2 flex max-h-[70vh] w-[min(24rem,calc(100vw-1rem))] flex-col rounded-lg border border-[var(--line)] bg-[var(--surface)] shadow-xl"
          data-testid="notifications-panel"
        >
          <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2">
            <span className="font-semibold">Powiadomienia</span>
            <span className="flex-1" />
            <div className="flex rounded-md border border-[var(--line)] text-xs" role="group" aria-label="Pokaż">
              {(["unread", "all"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={only === v}
                  onClick={() => setOnly(v)}
                  className={`px-2 py-0.5 ${only === v ? "bg-[var(--hover)] font-medium" : "text-[var(--muted)] hover:text-[var(--foreground)]"}`}
                >
                  {v === "unread" ? "Nieprzeczytane" : "Wszystkie"}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {shown.length ? (
              notificationDays(shown, now, timeZone).map((day) => (
                <section key={day.label}>
                  <h3 className="sticky top-0 bg-[var(--surface)] px-3 pt-2 pb-1 text-xs font-medium text-[var(--muted)]">{day.label}</h3>
                  <ul>
                    {day.items.map((n) => (
                      <NotificationItem key={n.id} n={n} now={now} timeZone={timeZone} onOpen={() => activate(n)} onDismiss={() => apply(dismissOps([n], new Date()))} />
                    ))}
                  </ul>
                </section>
              ))
            ) : (
              <p className="px-3 py-6 text-center text-sm text-[var(--muted)]">{only === "unread" ? "Wszystko przeczytane." : "Brak powiadomień."}</p>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-[var(--line)] px-3 py-2 text-xs">
            <button
              type="button"
              disabled={!unread.length}
              onClick={() => apply(markReadOps(unread, new Date()))}
              className="rounded px-1 text-[var(--accent)] hover:underline disabled:cursor-default disabled:text-[var(--muted)] disabled:no-underline"
            >
              Oznacz wszystkie jako przeczytane
            </button>
            <span className="flex-1" />
            <a href={routeHash({ view: "settings", id: "notifications" })} onClick={() => setOpen(false)} className="text-[var(--muted)] hover:text-[var(--foreground)]">
              Ustawienia
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NotificationItem({ n, now, timeZone, onOpen, onDismiss }: { n: AppNotification; now: Date; timeZone?: string; onOpen: () => void; onDismiss: () => void }) {
  const { text, detail } = notificationText(n);
  return (
    <li className="group relative flex items-start gap-2 px-3 py-2 hover:bg-[var(--hover)]" data-testid="notification" data-unread={n.readAt ? undefined : ""}>
      <span aria-hidden className="mt-0.5 w-5 shrink-0 text-center">
        {ICON[n.kind]}
      </span>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
        <span className={`block text-sm ${n.readAt ? "text-[var(--muted)]" : "font-medium"}`}>{text}</span>
        {detail ? <span className="block truncate text-xs text-[var(--muted)]">{detail}</span> : null}
        <span className="block text-[11px] text-[var(--muted)]">{notificationTime(n.at, now, timeZone)}</span>
      </button>
      {n.readAt ? null : <span aria-label="Nieprzeczytane" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Usuń z listy"
        title="Usuń z listy"
        className="shrink-0 rounded px-1 text-xs text-[var(--muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--foreground)] focus-visible:opacity-100"
      >
        ✕
      </button>
    </li>
  );
}

/** Dymek przy nowym powiadomieniu, gdy karta jest widoczna (w `Shell`, który ma dymki). Istniejące przy starcie — bez dymka. */
export function NotificationToasts({ store, userId }: { store: TabStore; userId: string }) {
  const { list, prefs } = useNotifications(store, userId);
  const { notify } = useTaskActions();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const now = new Date();
    if (seen.current === null) {
      // Pierwszy odczyt (także pusty — baza mogła jeszcze nie odpowiedzieć) zapamiętuje stan bez dymków.
      seen.current = new Set(list.map(notificationSeenKey));
      return;
    }
    const fresh = visibleNotifications(freshNotifications(list, seen.current, now), prefs, now, "unread");
    for (const n of list) seen.current.add(notificationSeenKey(n));
    if (!prefs.toast || document.visibilityState !== "visible" || !fresh.length) return;
    const first = notificationText(fresh[0]!).text;
    notify(fresh.length > 1 ? `🔔 ${first} (i ${fresh.length - 1} więcej)` : `🔔 ${first}`);
  }, [list, prefs, notify]);
  return null;
}

/** Ustawienia → „Powiadomienia”: kanał każdej grupy i dymek. */
export function NotificationsCard({ store, userId }: { store: TabStore; userId: string }) {
  const { rows } = useLocalQuery<{ settings: string | null }>(store, "select settings from profiles where id = ?", [userId], ["profiles"]);
  const [error, setError] = useState<string | null>(null);
  const raw = (() => {
    try {
      return rows[0]?.settings ? (JSON.parse(rows[0].settings) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })();
  const prefs = parseSettings(raw).notifications;
  const save = (patch: Partial<NotificationPrefs>) => {
    setError(null);
    // Pełne ustawienia z tej samej migawki — `settings` to jedno pole LWW.
    void store.mutate("profiles", userId, { settings: { ...parseSettings(raw), notifications: { ...prefs, ...patch } } }).catch((e: unknown) => setError(String(e)));
  };
  const channels: NotificationChannel[] = ["app", "off"];
  return (
    <SettingsSection title="Powiadomienia">
      <p className="mb-3 text-xs text-[var(--muted)]">
        Dzwonek 🔔 w nagłówku zbiera zdarzenia z udostępnionych przestrzeni — to, co zrobili inni, nigdy Twoje własne zmiany. Przypomnienia o zadaniach ustawiasz osobno w „Przypomnieniach”.
      </p>
      <div className="flex flex-col gap-3 text-sm">
        {(Object.keys(NOTIFICATION_GROUP_LABEL) as NotificationGroup[]).map((group) => (
          <label key={group} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{NOTIFICATION_GROUP_LABEL[group].title}</span>
              <span className="block text-xs text-[var(--muted)]">{NOTIFICATION_GROUP_LABEL[group].hint}</span>
            </span>
            <Select
              value={prefs[group] === "push" ? "app" : prefs[group]}
              onChange={(e) => save({ [group]: e.target.value as NotificationChannel })}
              className="w-40"
              data-testid={`notifications-${group}`}
            >
              {channels.map((c) => (
                <option key={c} value={c}>
                  {NOTIFICATION_CHANNEL[c]}
                </option>
              ))}
            </Select>
          </label>
        ))}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={prefs.toast} onChange={(e) => save({ toast: e.target.checked })} />
          Dymek przy nowym powiadomieniu, gdy aplikacja jest na wierzchu
        </label>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </SettingsSection>
  );
}
