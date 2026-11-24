import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Polityka prywatności — Task Planner",
  description: "Jakie dane zbiera Task Planner, do czego ich używa i jak je usunąć.",
};

// Data ostatniej zmiany treści — zmieniaj razem z treścią.
const UPDATED = "21 listopada 2026";

/**
 * Polityka prywatności (publiczna, bez logowania) — wymagana przy weryfikacji aplikacji OAuth
 * w Google. Treść ma odpowiadać temu, co aplikacja naprawdę robi (SPECYFIKACJA §5, §8, M18).
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6 text-sm leading-relaxed">
      <header className="flex flex-col gap-1">
        <Link href="/" className="text-xs opacity-60 hover:opacity-100">
          ← Task Planner
        </Link>
        <h1 className="text-2xl font-semibold">Polityka prywatności</h1>
        <p className="opacity-60">Ostatnia zmiana: {UPDATED}</p>
      </header>

      <Section title="Czym jest Task Planner">
        <p>
          Task Planner to osobisty menedżer zadań: aplikacja webowa i aplikacja na Androida. Działa także bez sieci — dane są zapisywane na urządzeniu i
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
            <strong>Treści, które wpisujesz:</strong> przestrzenie, listy, zadania i ich opisy, tagi, przypomnienia, zadania cykliczne, wpisy czasu pracy, zapisane
            filtry i ustawienia (strefa czasowa, godziny pracy), komentarze i nazwy osób wskazanych w zadaniach, a także pliki dodane jako załączniki
            (do 250 MB na konto).
          </li>
          <li>
            <strong>Urządzenia:</strong> nazwa i rodzaj urządzenia oraz — jeśli włączysz powiadomienia w przeglądarce — dane subskrypcji Web Push potrzebne
            do wysłania przypomnienia.
          </li>
          <li>
            <strong>Kalendarz Google (tylko jeśli go połączysz):</strong> lista kalendarzy oraz wydarzenia (tytuł, czas, miejsce) z okna od 30 dni wstecz do
            180 dni naprzód (<code>calendar.readonly</code>), pokazywane obok zadań w planie dnia. Jeśli włączysz zapis zadań do kalendarza, aplikacja
            tworzy w Twoim Google osobny kalendarz „Task Planner” i zmienia wyłącznie jego wydarzenia (<code>calendar.app.created</code>).
          </li>
          <li>
            <strong>Dziennik techniczny:</strong> historia zmian zadań (co, kiedy i z którego urządzenia zmieniono) — do przywracania wcześniejszych wersji
            — oraz dziennik błędów aplikacji (treść błędu, miejsce w kodzie, wersja aplikacji), przechowywany 90 dni.
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
          Wykorzystanie i przekazywanie informacji otrzymanych z interfejsów API Google przez Task Planner jest zgodne z{" "}
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

      <Section title="Kto ma dostęp">
        <ul className="list-disc space-y-1 pl-5">
          <li>Konto można założyć tylko na zaproszenie. Konta są od siebie oddzielone: inni użytkownicy nie widzą Twoich danych ani tego, że masz konto.</li>
          <li>
            Właściciel aplikacji, jako administrator serwera, ma techniczny dostęp do bazy danych i kopii zapasowych. Nie przegląda Twoich danych — korzysta
            z tego dostępu tylko do utrzymania aplikacji, naprawy błędów albo na Twoją prośbę.
          </li>
          <li>
            Kopia zapasowa całej bazy powstaje co noc, jest zaszyfrowana i przechowywana do 30 dni (GitHub Actions); służy wyłącznie do odtworzenia
            serwera po awarii.
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
          <li>
            Usunięcie konta wraz ze wszystkimi danymi na serwerze (zadania, załączniki, połączone kalendarze) — samodzielnie w Ustawieniach → „Usuń konto”
            albo na prośbę wysłaną z adresu e-mail konta do właściciela aplikacji. Dane znikają z kopii zapasowych, gdy te wygasną (do 30 dni).
          </li>
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
