"use client";

/**
 * „Dodawanie z innych miejsc” (M19, Etap 10): zakładka (bookmarklet) otwierająca szybkie dodawanie
 * z adresem i tytułem bieżącej strony oraz opis udostępniania z telefonu (Web Share Target z
 * manifestu — działa w zainstalowanej aplikacji na Androidzie).
 */
import { CollapsibleCard } from "./collapsible-card";

/** Kod zakładki: nowa karta z `/?share_url=…&share_title=…` (parametry jak w `share_target`). */
export const bookmarkletCode = (origin: string) =>
  `javascript:(()=>{window.open('${origin}/?share_url='+encodeURIComponent(location.href)+'&share_title='+encodeURIComponent(document.title),'_blank','noopener')})()`;

export function CaptureCard() {
  // React blokuje `javascript:` w `href` — adres ustawiony bezpośrednio na elemencie (powstaje po rozwinięciu karty).
  const link = (el: HTMLAnchorElement | null) => el?.setAttribute("href", bookmarkletCode(window.location.origin));
  return (
    <CollapsibleCard id="capture" title="Dodawanie z innych miejsc">
      <ul className="flex flex-col gap-2 text-sm">
        <li>
          <strong>Zakładka w przeglądarce:</strong> przeciągnij{" "}
          <a ref={link} className="rounded-md border border-[var(--line)] bg-[var(--hover)] px-2 py-0.5 font-medium" onClick={(e) => e.preventDefault()} draggable data-testid="bookmarklet">
            + Task Planner
          </a>{" "}
          na pasek zakładek. Kliknięta na dowolnej stronie otwiera szybkie dodawanie z jej tytułem i adresem.
        </li>
        <li>
          <strong>Telefon z Androidem:</strong> zainstaluj aplikację z menu Chrome („Dodaj do ekranu głównego”), potem „Udostępnij” → Task Planner.
        </li>
        <li>
          <strong>Wklejony adres</strong> w szybkim dodawaniu trafia do załączników zadania; tytuł strony uzupełni się sam (offline — po połączeniu).
        </li>
      </ul>
    </CollapsibleCard>
  );
}
