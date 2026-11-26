"use client";

/**
 * Ustawienia → „Wersja aplikacji”: numer wersji wczytanego kodu strony (`x.y.w.z` z `apps/web/version.json`,
 * liczony przez `scripts/web-version.mjs`), pod nim data zbudowania i skrót commita z Vercela (ten sam,
 * który dostaje dziennik błędów, `APP_VERSION`) oraz informacja o nowej wersji, gdy nowy Service Worker
 * przejął stronę (`updated` w `lib/service-worker.ts`).
 */
import { APP_RELEASES_REPO } from "@taskplanner/core";
import { useSyncExternalStore } from "react";

import { APP_VERSION } from "@/lib/error-log";
import { offlineStatus, subscribeOffline } from "@/lib/service-worker";
import { APP_NUMBER as NUMBER, BUILD_TIME } from "@/lib/version";

import { SettingsSection } from "./settings-section";
import { Notice } from "./ui";

/** Pełny SHA commita wdrożenia (zmienna systemowa Vercela); lokalnie brak. */
const COMMIT = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? null;


function buildDate(iso: string | null): string | null {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("pl-PL", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

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
  const date = buildDate(BUILD_TIME);

  return (
    <SettingsSection title="Wersja aplikacji">
      <div className="flex flex-col gap-3 text-sm">
        <p>
          Wersja{" "}
          <span className="font-mono font-semibold" data-testid="app-version-number">
            {NUMBER ?? APP_VERSION}
          </span>{" "}
          · <a href="#/changelog" className="text-[var(--accent)] underline">Historia zmian</a>
        </p>
        <p className="text-xs text-[var(--muted)]">
          {date ? <>Zbudowano {date} · </> : null}
          commit{" "}
          {COMMIT ? (
            <a href={`https://github.com/${APP_RELEASES_REPO}/commit/${COMMIT}`} target="_blank" rel="noreferrer" className="font-mono text-[var(--accent)] underline" data-testid="app-version">
              {APP_VERSION}
            </a>
          ) : (
            <span className="font-mono" data-testid="app-version">
              {APP_VERSION}
            </span>
          )}
          {BUILD[APP_VERSION] ? <> · {BUILD[APP_VERSION]}</> : null}
        </p>
        {updated ? <UpdateNotice /> : null}
        <p className="text-xs text-[var(--muted)]">
          Numer: całkowita zmiana . duża zmiana . mała zmiana . kosmetyka. Nowa wersja wczytuje się przy otwarciu albo odświeżeniu strony z dostępem do sieci. Ta karta pokazuje wersję wczytaną teraz — jej commit trafia do „Błędów aplikacji”.
        </p>
      </div>
    </SettingsSection>
  );
}
