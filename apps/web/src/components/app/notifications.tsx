"use client";

/**
 * Centrum powiadomień (v1.x, N1–N3): dzwonek w nagłówku z licznikiem nieprzeczytanych i listą, widok
 * `#/notifications` z filtrami, dymek przy nowym powiadomieniu (karta widoczna) i Ustawienia → „Powiadomienia”. Logika (teksty, cel, filtr, dni) w core
 * `notifications.ts`; dane z lokalnej bazy (`lib/notifications.ts`).
 */
import {
  filterNotifications,
  freshNotifications,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_GROUP_LABEL,
  NOTIFICATION_GROUP_SHORT,
  NOTIFICATION_GROUPS,
  notificationDays,
  notificationSeenKey,
  notificationTarget,
  notificationText,
  notificationTime,
  notificationWorkspaces,
  plural,
  REMINDER_DISPLAY,
  REMINDER_SNOOZE_OPTIONS,
  reminderSnoozeLabel,
  unreadCount,
  visibleNotifications,
  type AppNotification,
  type NotificationChannel,
  type NotificationFilter,
  type NotificationPrefs,
  type ReminderDisplay,
} from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useEffect, useRef, useState } from "react";

import { parseSettings } from "@/lib/app-data";
import { useLocalQuery } from "@/lib/local-store";
import { dismissNotifications, markNotificationsRead, requestOpenTask, snoozeReminderNotification, useNotifications } from "@/lib/notifications";
import { browserDeviceId } from "@/lib/push";
import { routeHash } from "@/lib/route";

import { useAppEnv } from "./app-env";
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
  due_changed: "📅",
  delivery_failed: "📤",
  connection_error: "🔌",
  calendar_error: "📆",
  ai_error: "✨",
  storage_quota: "📦",
  reminder: "⏰",
};

/** Kliknięcie powiadomienia: zadanie w panelu, ekran przestrzeni, dziennik wysyłek, sekcja ustawień albo pasek zaproszeń. */
function openTarget(n: AppNotification) {
  const target = notificationTarget(n);
  if (target.kind === "task") requestOpenTask(target.taskId);
  else if (target.kind === "workspace") window.location.assign(routeHash({ view: "manage" }));
  else if (target.kind === "deliveries") window.location.assign(routeHash({ view: "deliveries" }));
  else if (target.kind === "settings") window.location.assign(routeHash({ view: "settings", id: target.section }));
  else if (target.kind === "invites") window.scrollTo({ top: 0 });
}


/** Lista podzielona na dni (dzwonek i widok `#/notifications`). */
function NotificationDays({
  shown,
  now,
  timeZone,
  store,
  userId,
  empty,
  onOpen,
}: {
  shown: AppNotification[];
  now: Date;
  timeZone?: string;
  store: TabStore;
  userId: string;
  empty: string;
  onOpen?: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const snooze = (n: AppNotification, minutes: number) => {
    const title = typeof n.data.title === "string" ? n.data.title : "zadanie";
    snoozeReminderNotification(store, n, userId, minutes, timeZone).then(
      (time) => setNote(time ? `„${title}” — przypomnę o ${time}.` : `„${title}” jest już zamknięte albo usunięte.`),
      (e: unknown) => setNote(e instanceof Error ? e.message : String(e)),
    );
  };
  const status = note ? (
    <p role="status" className="px-3 pt-2 text-xs text-[var(--muted)]" data-testid="notification-snoozed">
      {note}
    </p>
  ) : null;
  if (!shown.length)
    return (
      <>
        {status}
        <p className="px-3 py-6 text-center text-sm text-[var(--muted)]">{empty}</p>
      </>
    );
  return [status, ...notificationDays(shown, now, timeZone).map((day) => (
    <section key={day.label}>
      <h3 className="sticky top-0 bg-[var(--surface)] px-3 pt-2 pb-1 text-xs font-medium text-[var(--muted)]">{day.label}</h3>
      <ul>
        {day.items.map((n) => (
          <NotificationItem
            key={n.id}
            n={n}
            now={now}
            timeZone={timeZone}
            onOpen={() => {
              markNotificationsRead(store, [n]);
              onOpen?.();
              openTarget(n);
            }}
            onDismiss={() => dismissNotifications(store, [n])}
            onSnooze={n.kind === "reminder" ? (minutes) => snooze(n, minutes) : undefined}
          />
        ))}
      </ul>
    </section>
  ))];
}

/** „Teraz” odświeżane co minutę (czas względny i retencja). */
function useNow(): [Date, (d: Date) => void] {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return [now, setNow];
}

/** Licznik w tytule karty: „(3) Task Planner”, a w zainstalowanej aplikacji — znaczek na ikonie (Badging API). */
function useTitleCount(count: number) {
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = count ? `(${count}) ${base}` : base;
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    void (count ? nav.setAppBadge?.(count) : nav.clearAppBadge?.())?.catch(() => undefined);
  }, [count]);
}

export function NotificationBell({ store, userId }: { store: TabStore; userId: string }) {
  const { list, prefs, timeZone } = useNotifications(store, userId);
  const [open, setOpen] = useState(false);
  const [only, setOnly] = useState<"unread" | "all">("unread");
  const [now, setNow] = useNow();
  const box = useRef<HTMLDivElement>(null);
  const count = unreadCount(list, prefs, now);
  useTitleCount(count);

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
            <NotificationDays
              shown={shown}
              now={now}
              timeZone={timeZone}
              store={store}
              userId={userId}
              empty={only === "unread" ? "Wszystko przeczytane." : "Brak powiadomień."}
              onOpen={() => setOpen(false)}
            />
          </div>
          <div className="flex items-center gap-2 border-t border-[var(--line)] px-3 py-2 text-xs">
            <button
              type="button"
              disabled={!unread.length}
              onClick={() => markNotificationsRead(store, unread)}
              className="rounded px-1 text-[var(--accent)] hover:underline disabled:cursor-default disabled:text-[var(--muted)] disabled:no-underline"
            >
              Oznacz wszystkie jako przeczytane
            </button>
            <span className="flex-1" />
            <a href={routeHash({ view: "notifications" })} onClick={() => setOpen(false)} className="text-[var(--muted)] hover:text-[var(--foreground)]" data-testid="notifications-all">
              Wszystkie
            </a>
            <a href={routeHash({ view: "settings", id: "notifications" })} onClick={() => setOpen(false)} className="text-[var(--muted)] hover:text-[var(--foreground)]">
              Ustawienia
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Widok `#/notifications`: pełna lista z filtrami (stan, grupa, przestrzeń). */
export function NotificationsScreen() {
  const { store, userId, data } = useAppEnv();
  const { list, prefs, timeZone } = useNotifications(store, userId);
  const [now] = useNow();
  const [filter, setFilter] = useState<NotificationFilter>({ only: "all", group: null, workspaceId: null });
  const shown = filterNotifications(list, prefs, now, filter);
  const unread = filterNotifications(list, prefs, now, { ...filter, only: "unread" });
  // Nazwa przestrzeni: bieżąca, gdy jeszcze ją widzę, inaczej z migawki powiadomienia.
  const spaces = notificationWorkspaces(list).map((w) => ({ id: w.id, name: data.workspaces.find((x) => x.id === w.id)?.name ?? (w.name || "Przestrzeń") }));
  const groups = [...NOTIFICATION_GROUPS, "reminders" as const].filter((g) => prefs[g] !== "off");
  const chip = (active: boolean) => `rounded-full border px-3 py-0.5 text-sm ${active ? "border-[var(--accent)] bg-[var(--hover)] font-medium" : "border-[var(--line)] text-[var(--muted)] hover:text-[var(--foreground)]"}`;
  return (
    <div className="mx-auto max-w-3xl" data-testid="notifications-screen">
      <h1 className="mb-3 text-xl font-semibold">Powiadomienia</h1>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(["all", "unread"] as const).map((v) => (
          <button key={v} type="button" aria-pressed={filter.only === v} onClick={() => setFilter({ ...filter, only: v })} className={chip(filter.only === v)}>
            {v === "unread" ? "Nieprzeczytane" : "Wszystkie"}
          </button>
        ))}
        <span className="mx-1 h-5 border-l border-[var(--line)]" aria-hidden />
        <button type="button" aria-pressed={!filter.group} onClick={() => setFilter({ ...filter, group: null })} className={chip(!filter.group)}>
          Każdy rodzaj
        </button>
        {groups.map((g) => (
          <button key={g} type="button" aria-pressed={filter.group === g} onClick={() => setFilter({ ...filter, group: g })} className={chip(filter.group === g)} data-testid={`notifications-group-${g}`}>
            {NOTIFICATION_GROUP_SHORT[g]}
          </button>
        ))}
        {spaces.length ? (
          <Select value={filter.workspaceId ?? ""} onChange={(e) => setFilter({ ...filter, workspaceId: e.target.value || null })} aria-label="Przestrzeń" className="w-auto">
            <option value="">Wszystkie przestrzenie</option>
            {spaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          disabled={!unread.length}
          onClick={() => markNotificationsRead(store, unread)}
          className="text-sm text-[var(--accent)] hover:underline disabled:cursor-default disabled:text-[var(--muted)] disabled:no-underline"
        >
          Oznacz jako przeczytane{unread.length ? ` (${unread.length})` : ""}
        </button>
      </div>
      <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)]">
        <NotificationDays shown={shown} now={now} timeZone={timeZone} store={store} userId={userId} empty={filter.only === "unread" ? "Wszystko przeczytane." : "Brak powiadomień."} />
      </div>
      <p className="mt-3 text-xs text-[var(--muted)]">
        Powiadomienia starsze niż 90 dni znikają same. Które zdarzenia trafiają tutaj i jako push —{" "}
        <a href={routeHash({ view: "settings", id: "notifications" })} className="underline">
          Ustawienia → Powiadomienia
        </a>
        .
      </p>
    </div>
  );
}

function NotificationItem({
  n,
  now,
  timeZone,
  onOpen,
  onDismiss,
  onSnooze,
}: {
  n: AppNotification;
  now: Date;
  timeZone?: string;
  onOpen: () => void;
  onDismiss: () => void;
  onSnooze?: (minutes: number) => void;
}) {
  const { text, detail } = notificationText(n);
  return (
    <li className="group relative flex items-start gap-2 px-3 py-2 hover:bg-[var(--hover)]" data-testid="notification" data-unread={n.readAt ? undefined : ""}>
      <span aria-hidden className="mt-0.5 w-5 shrink-0 text-center">
        {ICON[n.kind]}
      </span>
      <div className="min-w-0 flex-1">
        <button type="button" onClick={onOpen} className="block w-full text-left outline-none focus-visible:underline">
          <span className={`block text-sm ${n.readAt ? "text-[var(--muted)]" : "font-medium"}`}>{text}</span>
          {detail ? <span className="block truncate text-xs text-[var(--muted)]">{detail}</span> : null}
          <span className="block text-[11px] text-[var(--muted)]">{notificationTime(n.at, now, timeZone)}</span>
        </button>
        {onSnooze ? (
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]" role="group" aria-label="Przypomnij ponownie">
            <span className="text-[var(--muted)]">Przypomnij za</span>
            {REMINDER_SNOOZE_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onSnooze(m)}
                className="rounded border border-[var(--border)] px-1.5 py-0.5 hover:bg-[var(--surface)] hover:text-[var(--accent)]"
              >
                {reminderSnoozeLabel(m)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
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
    // Przypomnienia mają własny dymek (wiadomość Service Workera przy push) — tu tylko zdarzenia z serwera.
    const fresh = visibleNotifications(freshNotifications(list, seen.current, now), prefs, now, "unread").filter((n) => n.kind !== "reminder");
    for (const n of list) seen.current.add(notificationSeenKey(n));
    if (!prefs.toast || document.visibilityState !== "visible" || !fresh.length) return;
    const first = notificationText(fresh[0]!).text;
    notify(fresh.length > 1 ? `🔔 ${first} (i ${fresh.length - 1} więcej)` : `🔔 ${first}`);
  }, [list, prefs, notify]);
  return null;
}

/** Ustawienia → „Powiadomienia”: kanał każdej grupy, dymek i cisza nocna dla push. */
export function NotificationsCard({ store, userId }: { store: TabStore; userId: string }) {
  const { rows } = useLocalQuery<{ settings: string | null }>(store, "select settings from profiles where id = ?", [userId], ["profiles"]);
  // Push idzie na urządzenia z włączonymi przypomnieniami (ta sama zgoda i subskrypcja) — stan tej przeglądarki.
  const { rows: device } = useLocalQuery<{ id: string }>(
    store,
    "select id from devices where id = ? and deleted_at is null and reminder_channel = 'enabled' and push_subscription is not null",
    [browserDeviceId(userId)],
    ["devices"],
  );
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
  const channels: NotificationChannel[] = ["push", "app", "off"];
  const wantsPush = NOTIFICATION_GROUPS.some((g) => prefs[g] === "push");
  return (
    <SettingsSection title="Powiadomienia">
      <p className="mb-3 text-xs text-[var(--muted)]">
        Dzwonek 🔔 w nagłówku zbiera zdarzenia z udostępnionych przestrzeni — to, co zrobili inni, nigdy Twoje własne zmiany — i problemy z integracjami, kalendarzem, kluczem AI
        czy miejscem na załączniki. Przypomnienia o zadaniach ustawiasz osobno w „Przypomnieniach”.
      </p>
      <div className="flex flex-col gap-3 text-sm">
        {NOTIFICATION_GROUPS.map((group) => (
          <label key={group} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{NOTIFICATION_GROUP_LABEL[group].title}</span>
              <span className="block text-xs text-[var(--muted)]">{NOTIFICATION_GROUP_LABEL[group].hint}</span>
            </span>
            <Select
              value={prefs[group]}
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
        <label className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{NOTIFICATION_GROUP_LABEL.reminders.title}</span>
            <span className="block text-xs text-[var(--muted)]">{NOTIFICATION_GROUP_LABEL.reminders.hint}</span>
          </span>
          <Select value={prefs.reminders} onChange={(e) => save({ reminders: e.target.value as ReminderDisplay })} className="w-64" data-testid="notifications-reminders">
            {(["app", "popup", "off"] as const).map((v) => (
              <option key={v} value={v}>
                {REMINDER_DISPLAY[v]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={prefs.toast} onChange={(e) => save({ toast: e.target.checked })} />
          Dymek przy nowym powiadomieniu, gdy aplikacja jest na wierzchu
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={prefs.quiet.enabled} onChange={(e) => save({ quiet: { ...prefs.quiet, enabled: e.target.checked } })} data-testid="notifications-quiet" />
            Cisza nocna (bez push) od
          </label>
          <TimeInput value={prefs.quiet.from} label="Początek ciszy nocnej" disabled={!prefs.quiet.enabled} onChange={(from) => save({ quiet: { ...prefs.quiet, from } })} />
          do
          <TimeInput value={prefs.quiet.to} label="Koniec ciszy nocnej" disabled={!prefs.quiet.enabled} onChange={(to) => save({ quiet: { ...prefs.quiet, to } })} />
        </div>
      </div>
      <p className="mt-3 text-xs text-[var(--muted)]">
        „{NOTIFICATION_CHANNEL.push}” — powiadomienie systemowe minutę po zdarzeniu (seria komentarzy = jedno), także przy zamkniętej karcie, na urządzenia z włączonymi
        przypomnieniami. Gdy karta aplikacji jest na wierzchu, wystarcza dzwonek.
      </p>
      {wantsPush && !device.length ? (
        <Notice>
          Ta przeglądarka nie dostanie push, dopóki nie włączysz w niej przypomnień:{" "}
          <a href={routeHash({ view: "settings", id: "reminders" })} className="underline">
            Ustawienia → Przypomnienia
          </a>
          .
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </SettingsSection>
  );
}

/** Pole godziny zapisywane po zmianie (puste / niepełne — bez zapisu). */
function TimeInput({ value, label, disabled, onChange }: { value: string; label: string; disabled: boolean; onChange: (value: string) => void }) {
  return (
    <input
      type="time"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (/^\d{2}:\d{2}$/.test(e.target.value)) onChange(e.target.value);
      }}
      className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-sm disabled:opacity-50"
    />
  );
}
