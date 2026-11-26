"use client";

/**
 * Ustawienia → „Wersja aplikacji”: wersja wczytanego kodu strony (skrót commita z Vercela — ta sama,
 * którą dostaje dziennik błędów, `APP_VERSION`) i informacja o nowej wersji, gdy nowy Service Worker
 * przejął stronę (`updated` w `lib/service-worker.ts`).
 */
import { APP_RELEASES_REPO } from "@taskplanner/core";
import { useSyncExternalStore } from "react";

import { APP_VERSION } from "@/lib/error-log";
import { offlineStatus, subscribeOffline } from "@/lib/service-worker";

import { SettingsSection } from "./settings-section";
import { Notice } from "./ui";

/** Pełny SHA commita wdrożenia (zmienna systemowa Vercela); lokalnie brak. */
const COMMIT = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? null;

const BUILD: Record<string, string> = { dev: "serwer deweloperski (next dev)", local: "build lokalny" };

/** Nowy Service Worker przejął już działającą stronę — jest nowsza wersja niż wczytany kod. */
export function useAppUpdated(): boolean {
  return useSyncExternalStore(subscribeOffline, () => offlineStatus().updated, () => false);
}

/** „Jest nowa wersja” z „Odśwież” (pasek pod nagłówkiem aplikacji i karta). */
export function UpdateNotice() {
  return (
    <Notice tone="ok">
      Jest nowa wersja aplikacji — ta karta działa jeszcze na poprzedniej.{" "}
      <button type="button" className="font-semibold underline" onClick={() => window.location.reload()} data-testid="app-reload">
        Odśwież
      </button>
    </Notice>
  );
}

export function VersionCard() {
  const updated = useAppUpdated();

  return (
    <SettingsSection title="Wersja aplikacji">
      <div className="flex flex-col gap-3 text-sm">
        <p>
          Wersja:{" "}
          {COMMIT ? (
            <a href={`https://github.com/${APP_RELEASES_REPO}/commit/${COMMIT}`} target="_blank" rel="noreferrer" className="font-mono text-[var(--accent)] underline" data-testid="app-version">
              {APP_VERSION}
            </a>
          ) : (
            <span className="font-mono" data-testid="app-version">
              {APP_VERSION}
            </span>
          )}
          {BUILD[APP_VERSION] ? <span className="text-[var(--muted)]"> · {BUILD[APP_VERSION]}</span> : null}
        </p>
        {updated ? <UpdateNotice /> : null}
        <p className="text-xs text-[var(--muted)]">
          Nowa wersja wczytuje się przy otwarciu albo odświeżeniu strony z dostępem do sieci. Ta karta pokazuje wersję wczytaną teraz — ta sama trafia do „Błędów aplikacji”.
        </p>
      </div>
    </SettingsSection>
  );
}
