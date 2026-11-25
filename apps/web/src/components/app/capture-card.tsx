"use client";

/**
 * „Dodawanie z innych miejsc” (M19, Etap 10): zakładka (bookmarklet) otwierająca szybkie dodawanie
 * z adresem, tytułem i wycinkiem bieżącej strony (kod i format: core `web-clip.ts`) oraz opis udostępniania
 * z telefonu (Web Share Target z manifestu — działa w zainstalowanej aplikacji na Androidzie).
 */
import { bookmarkletCode } from "@taskplanner/core";

import { SettingsSection } from "./settings-section";

export function CaptureCard() {
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
          <strong>Telefon z Androidem:</strong> zainstaluj aplikację z menu Chrome („Dodaj do ekranu głównego”), potem „Udostępnij” → Task Planner.
        </li>
        <li>
          <strong>Wklejony adres</strong> w szybkim dodawaniu trafia do załączników zadania; tytuł strony uzupełni się sam (offline — po połączeniu).
        </li>
      </ul>
    </SettingsSection>
  );
}
