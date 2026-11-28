"use client";

/**
 * Ustawienia (`#/settings`, `#/settings/<sekcja>`): podpanel z menu sekcji obok paska bocznego, zawsze jedna
 * sekcja aktywna. Adres bez sekcji otwiera ostatnio oglądaną przez użytkownika (per przeglądarka). Sekcja montuje
 * się przy pierwszym otwarciu (nieotwarta nic nie pobiera) i potem tylko się chowa — niezapisane pola zostają
 * (po wyjściu z „Ustawień” formularz „Ogólne” odtwarza szkic: `ProfileForm` `draftKey`).
 */
import type { TabStore } from "@taskplanner/sync";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useAiAccount } from "@/lib/ai";
import { useLocalQuery } from "@/lib/local-store";
import { usePlugins } from "@/lib/plugins";
import { routeHash, useRoute } from "@/lib/route";

import { AccountCard } from "./account-card";
import { AiCard } from "./ai-card";
import { BackupCard } from "./backup-card";
import { CalendarsCard } from "./calendars-card";
import { CaptureCard } from "./capture-card";
import { ErrorsCard } from "./errors-card";
import { InvitesCard, useAppAdmin } from "./invites-card";
import { PluginsCard } from "./plugins-card";
import { InstallCard, OfflineCard } from "./pwa-cards";
import { NotificationsCard } from "./notifications";
import { RemindersCard } from "./reminders-card";
import { SettingsSection } from "./settings-section";
import { VersionCard } from "./version-card";

interface Section {
  id: string;
  icon: string;
  label: string;
  /** Sekcja wymaga działania (np. odwołany dostęp) — kropka w menu. */
  alert?: boolean;
  body: ReactNode;
}

const storageKey = (userId: string) => `tp-settings-section-${userId}`;

const readSection = (userId: string): string | null => {
  try {
    return localStorage.getItem(storageKey(userId));
  } catch {
    return null;
  }
};

export function SettingsScreen({ store, userId, email, timeZone, general, onSignOut }: { store: TabStore; userId: string; email: string | null; timeZone?: string; general: ReactNode; onSignOut: () => void }) {
  const [route, navigate] = useRoute();
  const admin = useAppAdmin();
  const ai = useAiAccount(store);
  const { connections } = usePlugins(store);
  const calendarProblems = useLocalQuery<{ n: number }>(store, "select count(*) as n from calendar_accounts where status <> 'active'", [], ["calendar_accounts"]).rows[0]?.n ?? 0;

  const sections: Section[] = [
    { id: "general", icon: "⚙️", label: "Ogólne", body: <SettingsSection title="Ogólne">{general}</SettingsSection> },
    { id: "reminders", icon: "⏰", label: "Przypomnienia", body: <RemindersCard store={store} userId={userId} /> },
    { id: "notifications", icon: "🔔", label: "Powiadomienia", body: <NotificationsCard store={store} userId={userId} /> },
    { id: "calendars", icon: "📆", label: "Kalendarze", alert: calendarProblems > 0, body: <CalendarsCard store={store} timeZone={timeZone} /> },
    { id: "plugins", icon: "🔌", label: "Integracje", alert: connections.some((c) => c.status === "error"), body: <PluginsCard store={store} userId={userId} /> },
    { id: "ai", icon: "✨", label: "Asystent AI", alert: ai?.status === "error", body: <AiCard store={store} /> },
    { id: "backup", icon: "💾", label: "Kopia zapasowa", body: <BackupCard store={store} userId={userId} timeZone={timeZone} /> },
    { id: "capture", icon: "📎", label: "Dodawanie z innych miejsc", body: <CaptureCard /> },
    { id: "install", icon: "🖥️", label: "Aplikacja na pulpicie", body: <InstallCard /> },
    { id: "errors", icon: "🐞", label: "Błędy aplikacji", body: <ErrorsCard /> },
    { id: "offline", icon: "📴", label: "Praca bez sieci", body: <OfflineCard /> },
    { id: "version", icon: "ℹ️", label: "Wersja aplikacji", body: <VersionCard /> },
    // Tylko dla administratora.
    ...(admin ? [{ id: "invites", icon: "✉️", label: "Zaproszenia", body: <InvitesCard /> }] : []),
    { id: "account", icon: "👤", label: "Konto", body: <AccountCard email={email} onSignOut={onSignOut} /> },
  ];

  const [last, setLast] = useState(() => readSection(userId));
  const wanted = (route.view === "settings" ? route.id : undefined) ?? last;
  // Dopóki nie wiadomo, czy to administrator, „Zaproszenia” nie przeskakują na inną sekcję.
  const waiting = wanted === "invites" && admin === null;
  const active = waiting ? "invites" : (sections.find((s) => s.id === wanted)?.id ?? "general");

  const [opened, setOpened] = useState<readonly string[]>([]);
  if (!opened.includes(active)) setOpened([...opened, active]);
  // Adres bez sekcji (⚙️ w nagłówku) wraca do ostatnio oglądanej.
  if (!waiting && last !== active) setLast(active);
  useEffect(() => {
    if (waiting) return;
    try {
      localStorage.setItem(storageKey(userId), active);
    } catch {
      // Bez pamięci przeglądarki — sekcja pamiętana do przeładowania.
    }
  }, [userId, active, waiting]);

  const panel = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.scrollTo({ top: 0 });
    menu.current?.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <div className="flex h-full flex-col @2xl:flex-row">
      <aside aria-label="Ustawienia" className="shrink-0 border-b border-[var(--line)] bg-[var(--surface)] p-3 text-sm @2xl:w-64 @2xl:overflow-y-auto @2xl:border-r @2xl:border-b-0">
        <h1 className="mb-2 px-2 text-base font-semibold">Ustawienia</h1>
        <nav ref={menu} aria-label="Sekcje ustawień" className="flex gap-0.5 overflow-x-auto @2xl:flex-col">
          {sections.map((s) => (
            <a
              key={s.id}
              href={routeHash({ view: "settings", id: s.id })}
              onClick={(e) => {
                e.preventDefault();
                navigate({ view: "settings", id: s.id });
              }}
              aria-current={s.id === active ? "page" : undefined}
              className={`flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 whitespace-nowrap ${s.id === active ? "bg-[var(--hover)] font-medium" : "hover:bg-[var(--hover)]"}`}
            >
              <span aria-hidden className="w-5 text-center">
                {s.icon}
              </span>
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              {s.alert ? <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--danger)]" role="img" aria-label="wymaga uwagi" title="Wymaga uwagi" /> : null}
            </a>
          ))}
        </nav>
      </aside>
      <div ref={panel} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 pb-20 sm:p-6 sm:pb-20">
        {sections
          .filter((s) => opened.includes(s.id))
          .map((s) => (
            <div key={s.id} hidden={s.id !== active} className="max-w-3xl" data-settings-section={s.id}>
              {s.body}
            </div>
          ))}
      </div>
    </div>
  );
}
