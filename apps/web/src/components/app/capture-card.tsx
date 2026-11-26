"use client";

/**
 * „Dodawanie z innych miejsc” (M19, Etap 10): zakładka (bookmarklet) otwierająca szybkie dodawanie
 * z adresem, tytułem i wycinkiem bieżącej strony (kod i format: core `web-clip.ts`) oraz opis udostępniania
 * z telefonu: aplikacja na Androida (APK z wydań `android-v…`, core `app-update.ts`) albo Web Share
 * Target z manifestu (zainstalowana strona).
 */
import { APP_RELEASES_API_URL, APP_RELEASES_PAGE_URL, bookmarkletCode, latestAppRelease, type AppRelease } from "@taskplanner/core";
import { useEffect, useState } from "react";

import { SettingsSection } from "./settings-section";

/** Najnowsze wydanie APK z GitHub Releases (`android-v…`); `null` = nie wiadomo (offline, limit API). */
function useLatestApk(): AppRelease | null {
  const [release, setRelease] = useState<AppRelease | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(APP_RELEASES_API_URL, { headers: { Accept: "application/vnd.github+json" }, signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: unknown) => setRelease(json ? latestAppRelease(json) : null))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return release;
}

export function CaptureCard() {
  const apk = useLatestApk();
  // React blokuje `javascript:` w `href` — adres ustawiony bezpośrednio na elemencie.
  const link = (el: HTMLAnchorElement | null) => el?.setAttribute("href", bookmarkletCode(window.location.origin));
  return (
    <SettingsSection title="Dodawanie z innych miejsc">
      <ul className="flex flex-col gap-2 text-sm">
        <li>
          <strong>Zakładka w przeglądarce:</strong> przeciągnij{" "}
          <a ref={link} className="rounded-md border border-[var(--line)] bg-[var(--hover)] px-2 py-0.5 font-medium" onClick={(e) => e.preventDefault()} draggable data-testid="bookmarklet">
            + Task Planner
          </a>{" "}
          na pasek zakładek. Kliknięta na dowolnej stronie otwiera szybkie dodawanie z jej tytułem i adresem;
          zaznaczony fragment trafia do opisu jako cytat (do sprawdzenia przed dodaniem), a bez zaznaczenia tekst strony służy tylko do „✨ Streść”.
          <span className="mt-1 block text-xs text-[var(--muted)]">
            Masz zakładkę dodaną wcześniej? Nadal działa, ale przekazuje sam tytuł i adres — usuń ją i przeciągnij tę ponownie.
          </span>
        </li>
        <li>
          <strong>Telefon z Androidem:</strong> najlepiej aplikacja Task Planner na Androida (APK spoza Google Play — przypomnienia, widżety, „Udostępnij” → Task Planner):{" "}
          {apk ? (
            <a href={apk.apk.url} className="text-[var(--accent)] underline" data-testid="apk-download">
              pobierz wersję {apk.version}
            </a>
          ) : (
            <a href={APP_RELEASES_PAGE_URL} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline" data-testid="apk-download">
              wydania na GitHubie
            </a>
          )}
          . Telefon zapyta o zgodę na instalację z przeglądarki; później aplikacja sama znajduje nowe wersje.
          <span className="mt-1 block text-xs text-[var(--muted)]">
            Bez APK: zainstaluj tę stronę z menu Chrome („Dodaj do ekranu głównego”), potem „Udostępnij” → Task Planner. Wystarczy jedna z dróg — obie naraz dadzą dwa „Task Planner” w menu „Udostępnij”.
          </span>
        </li>
        <li>
          <strong>Wklejony adres</strong> w szybkim dodawaniu trafia do załączników zadania; tytuł strony uzupełni się sam (offline — po połączeniu).
        </li>
      </ul>
    </SettingsSection>
  );
}
