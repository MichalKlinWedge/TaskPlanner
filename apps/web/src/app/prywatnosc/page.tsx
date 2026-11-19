import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Polityka prywatności — TaskPlanner",
  description: "Jakie dane zbiera TaskPlanner, do czego ich używa i jak je usunąć.",
};

// Data ostatniej zmiany treści — zmieniaj razem z treścią.
const UPDATED = "19 listopada 2026";

/**
 * Polityka prywatności (publiczna, bez logowania) — wymagana przy weryfikacji aplikacji OAuth
 * w Google. Treść ma odpowiadać temu, co aplikacja naprawdę robi (SPECYFIKACJA §5, §8, M18).
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6 text-sm leading-relaxed">
      <header className="flex flex-col gap-1">
        <Link href="/" className="text-xs opacity-60 hover:opacity-100">
          ← TaskPlanner
        </Link>
        <h1 className="text-2xl font-semibold">Polityka prywatności</h1>
        <p className="opacity-60">Ostatnia zmiana: {UPDATED}</p>
      </header>

      <Section title="Czym jest TaskPlanner">
        <p>
          TaskPlanner to osobisty menedżer zadań: aplikacja webowa i aplikacja na Androida. Działa także bez sieci — dane są zapisywane na urządzeniu i
          synchronizowane z serwerem, gdy jest połączenie. Aplikacja nie wyświetla reklam i nie sprzedaje ani nie udostępnia danych nikomu.
        </p>
      </Section>

      <Section title="Jakie dane zbieramy">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Konto:</strong> adres e-mail i identyfikator konta — z logowania linkiem e-mail albo przez Google (zakresy <code>email</code> i{" "}
            <code>profile</code>). Z profilu Google zapisujemy tylko adres e-mail i nazwę.
          </li>
          <li>
            <strong>Treści, które wpisujesz:</strong> przestrzenie, listy, zadania i ich opisy, tagi, przypomnienia, nawyki, wpisy czasu pracy, zapisane
            filtry i ustawienia (strefa czasowa, godziny pracy).
          </li>
          <li>
            <strong>Urządzenia:</strong> nazwa i rodzaj urządzenia oraz — jeśli włączysz powiadomienia w przeglądarce — dane subskrypcji Web Push potrzebne
            do wysłania przypomnienia.
          </li>
          <li>
            <strong>Kalendarz Google (tylko jeśli go połączysz):</strong> lista kalendarzy oraz wydarzenia (tytuł, czas, miejsce) z okna od 30 dni wstecz do
            180 dni naprzód, w trybie tylko do odczytu (<code>calendar.readonly</code>). Wydarzenia są pokazywane obok zadań w planie dnia.
          </li>
          <li>
            <strong>Dziennik techniczny:</strong> historia zmian zadań (co, kiedy i z którego urządzenia zmieniono) — do przywracania wcześniejszych wersji.
          </li>
        </ul>
        <p>Nie zbieramy danych o lokalizacji, kontaktów, danych analitycznych ani plików cookie służących do śledzenia.</p>
      </Section>

      <Section title="Do czego używamy danych">
        <p>
          Wyłącznie do działania aplikacji: przechowywania i synchronizacji Twoich zadań między urządzeniami, wysyłania przypomnień, które ustawisz, oraz
          pokazywania wydarzeń z połączonego kalendarza obok zadań. Dane nie są używane do reklam, profilowania ani trenowania modeli.
        </p>
      </Section>

      <Section title="Dane z Google (Limited Use)">
        <p>
          Wykorzystanie i przekazywanie informacji otrzymanych z interfejsów API Google przez TaskPlanner jest zgodne z{" "}
          <a className="underline" href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </a>
          , w tym z wymaganiami Limited Use. Dane z Kalendarza Google służą tylko do pokazania wydarzeń w aplikacji, nie są przekazywane osobom trzecim,
          nie są czytane przez ludzi i nie są używane do reklam. Tokeny dostępu są przechowywane zaszyfrowane po stronie serwera (Supabase Vault) — nigdy
          w przeglądarce ani w aplikacji na telefonie.
        </p>
      </Section>

      <Section title="Gdzie są przechowywane">
        <ul className="list-disc space-y-1 pl-5">
          <li>Na Twoim urządzeniu — w lokalnej bazie przeglądarki (OPFS) albo aplikacji, żeby wszystko działało offline.</li>
          <li>
            Na serwerze — w bazie <strong>Supabase</strong> (region UE, Irlandia), dostęp chroniony regułami bezpieczeństwa: każdy widzi wyłącznie własne
            dane.
          </li>
          <li>
            Aplikację webową hostuje <strong>Vercel</strong>; nie zapisuje on Twoich zadań (trafiają bezpośrednio do Supabase).
          </li>
        </ul>
      </Section>

      <Section title="Usunięcie danych">
        <ul className="list-disc space-y-1 pl-5">
          <li>Odłączenie Kalendarza Google w aplikacji usuwa tokeny dostępu i pobrane wydarzenia. Dostęp możesz też cofnąć w ustawieniach konta Google.</li>
          <li>Usunięte zadania trafiają do kosza, z którego można je przywrócić.</li>
          <li>
            Kopia danych na urządzeniu zostaje po wylogowaniu (osobna dla każdego konta) — usuniesz ją, czyszcząc dane witryny w przeglądarce albo dane
            aplikacji w ustawieniach Androida.
          </li>
          <li>Usunięcie konta wraz ze wszystkimi danymi na serwerze — na prośbę wysłaną z adresu e-mail konta do właściciela aplikacji.</li>
        </ul>
      </Section>

      <Section title="Kontakt">
        <p>Pytania o dane i prośby o ich usunięcie: adres kontaktowy podany na ekranie zgody Google podczas logowania.</p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}
