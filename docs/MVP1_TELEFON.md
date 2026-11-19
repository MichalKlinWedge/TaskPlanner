# MVP-1 — scenariusze na telefonie (logowanie, onboarding, przestrzenie, synchronizacja)

Część telefoniczna MVP-1 w `apps/mobile`: ekran „Konto i serwer” (`src/app/settings.tsx`, logika w `src/lib/auth.ts`), powrót z linku `src/app/auth-callback.tsx`, kreator `src/app/onboarding.tsx` (bramka w `src/app/_layout.tsx`), „Przestrzenie i listy” (`src/app/workspaces.tsx`, `src/app/workspace/[id].tsx`, `src/lib/workspaces.ts`), wskaźnik synchronizacji `src/components/sync-indicator.tsx`. Wyniki wpisywać w tabeli na końcu.

## Przygotowanie

- Komputer: `npm run supabase -- start`. Maile logowania: Mailpit/Inbucket http://127.0.0.1:54524.
- Szablon maila z kodem (`supabase/templates/magic_link.html`, wpis `[auth.email.template.magic_link]` w `supabase/config.toml`) działa dopiero po ponownym uruchomieniu stosu (`npm run supabase -- stop` i `start`) z gałęzi, która go zawiera. Bez tego mail ma tylko link.
- **Dev build** (`cd apps/mobile && npx expo run:android`, `docs/ANDROID_BUILD.md`). Release nie łączy się z lokalnym Supabase po `http` (Android 9+ blokuje ruch bez TLS), więc scenariusze z lokalnym serwerem robić na dev buildzie. Po dodaniu `expo-web-browser` i `expo-network` trzeba przebudować APK (nowe moduły natywne).
- Telefon przez USB: `adb reverse tcp:54521 tcp:54521` i `adb reverse tcp:54524 tcp:54524`. Wtedy adres serwera w aplikacji to `http://127.0.0.1:54521`, a link z maila (wskazuje 127.0.0.1:54521) otwiera się w Chrome na telefonie. W Wi-Fi (`http://<IP komputera>:54521`) link z maila nie zadziała — logowanie kodem z maila.
- Po `npm run supabase -- db reset` konta mają nowe id: na telefonie najpierw „Wyloguj (czyści dane lokalne)”, potem logowanie od nowa (stara sesja kończy się błędem synchronizacji, np. `permission denied`).
- Gdy USB się sypie (Windows pokazuje „Galaxy S22 Ultra” ze statusem Error, `adb devices` puste albo `offline`), działa debugowanie bezprzewodowe: Opcje programisty → Debugowanie bezprzewodowe → „Sparuj … kodu parowania”, `adb pair <IP:port parowania> <kod>`, `adb connect <IP:port>`. Adres z ekranu telefonu może się różnić od widocznego z komputera — właściwy podaje `adb mdns services`. `adb reverse` działa też przez Wi-Fi.
- Dev build z `expo-dev-client`: link z maila otwierać, gdy aplikacja działa (jest w tle). Przy zimnym starcie deep link może trafić do ekranu launchera dev clienta zamiast do aplikacji.

## M1. Logowanie linkiem z maila (deep link)

1. Ekran główny → „Konto i serwer”: adres `http://127.0.0.1:54521`, klucz `PUBLISHABLE_KEY` z `npm run supabase -- status` → „Zapisz adres”.
2. E-mail (np. nowy `ja@test.local`) → „Wyślij link logowania”.
3. Na telefonie w Chrome: http://127.0.0.1:54524 → mail → „Zaloguj się” (Log In).
4. Oczekiwane: Chrome pyta o otwarcie TaskPlanner albo przełącza od razu, ekran „Logowanie…” (`taskplanner://auth-callback?code=…`), potem ekran startowy, a po pierwszej synchronizacji kreator „Witaj w TaskPlanner” (nowe konto).
5. Ponowne kliknięcie tego samego linku: komunikat o błędzie z przyciskiem „Konto i serwer” (link jest jednorazowy).

## M2. Logowanie kodem z maila

1. Jak M1, ale telefon w Wi-Fi (adres `http://<IP komputera>:54521`), albo bez otwierania linku.
2. Po „Wyślij link logowania” wpisać sześciocyfrowy kod z maila → „Zaloguj kodem”.
3. Oczekiwane: jak w M1 krok 4. (Wymaga szablonu z kodem — patrz Przygotowanie.)

## M3. Logowanie Google

Wymaga włączonego Google w Supabase (lokalnie: `[auth.external.google]` w `supabase/config.toml` + klucze w `supabase/.env`; w chmurze: panel Supabase → Providers → Google) i `taskplanner://**` w adresach powrotu (lokalnie jest w `additional_redirect_urls`; w chmurze dopisać w Authentication → URL Configuration).

1. „Zaloguj przez Google” → Chrome Custom Tab z kontem Google → zgoda.
2. Oczekiwane: karta się zamyka, ekran startowy, kreator przy pierwszym logowaniu. Zamknięcie karty bez logowania: komunikat „Logowanie Google przerwane”.
3. Przy wyłączonym Google: karta pokazuje błąd serwera („provider is not enabled”), po zamknięciu komunikat o przerwaniu.

## M4. Zmiana konta czyści dane lokalne

1. W trybie offline (bez konta) dodać zadanie (ekran „Dziś” → „Dodaj przykładowe zadania”).
2. Zalogować się (M1/M2). Oczekiwane: zadań z trybu offline nie ma, wskaźnik pokazuje „Pierwsza synchronizacja…”, potem „Zsynchronizowano o …”.
3. „Wyloguj (czyści dane lokalne)” → potwierdzenie → tryb offline, puste dane. Logowanie innym kontem → dane tylko tego konta.

## M5. Onboarding i drugie urządzenie

1. Nowe konto (M1). Kreator: imię, strefa (domyślnie strefa telefonu, np. `Europe/Warsaw`), pierwszy dzień tygodnia, dni i godziny pracy, godzina przypomnienia, czas bloku, przestrzenie „Osobiste” i „Praca” → „Zaczynamy”.
2. Błędne dane (np. koniec pracy przed początkiem, „25:00”, nieznana strefa) → komunikat z walidacji i brak zapisu.
3. Po zapisie: ekran „Przestrzenie i listy” z „Osobiste” i „Praca”, w każdej Inbox. Wskaźnik: „wszystko wysłane”.
4. Drugie urządzenie (web `npm run web:local` albo drugi telefon) zalogowane tym samym kontem: te same przestrzenie z Inboxami, bez kreatora.
5. Onboarding w trybie samolotowym na dwóch urządzeniach naraz, potem sieć: nadal dwie przestrzenie (id deterministyczne).

## M6. Przestrzenie i listy

1. „Nowa przestrzeń”: nazwa + kolor → pojawia się na końcu, z Inboxem.
2. „Edytuj” na przestrzeni: zmiana nazwy („Zapisz”), koloru, „↑ Wyżej” / „↓ Niżej”, „Archiwizuj” → znika z aktywnych, jest pod „Pokaż zarchiwizowane (1)”, „Przywróć z archiwum” wraca.
3. Przestrzeń → listy: „Nowa lista” jako Lista i jako Projekt (projekt dostaje status „Aktywny”); zmiana nazwy, koloru, rodzaju, statusu projektu, kolejności, archiwizacja; „Usuń pustą listę” tylko dla list bez zadań.
4. Inbox: zawsze na górze, bez zmiany nazwy, archiwizacji i usuwania (tylko kolor).
5. Każda zmiana widoczna na drugim urządzeniu po synchronizacji (Realtime < 3 s).

## M7. Kryterium MVP-1: zadanie z trybu samolotowego na serwerze < 5 s

1. Zalogowany telefon, ekran przestrzeni „Osobiste”. Włączyć tryb samolotowy.
2. „Szybkie zadanie do Inboxu” → tytuł → „Dodaj”. Wskaźnik: błąd synchronizacji i „1 zmiana do wysłania”.
3. Na webie (`/dev/sync` albo lista) otworzyć Inbox „Osobiste”.
4. Wyłączyć tryb samolotowy i włączyć stoper, gdy telefon pokaże połączenie (ikona Wi-Fi / LTE). Synchronizację budzi `expo-network` (powrót sieci), oprócz tego ponowienia po błędzie (2, 4, 8… s) i Realtime.
5. Oczekiwane: zadanie na webie < 5 s; na telefonie wskaźnik „Zsynchronizowano o …”, „wszystko wysłane”.

## M8. Pierwsza synchronizacja dużego konta

1. `npm run seed:dev -- --load` (2 000 zadań jako `dev@taskplanner.test`), zalogować się tym kontem na telefonie (M1, mail w Mailpit).
2. Oczekiwane: wskaźnik „Pierwsza synchronizacja: pobrano N stron…” (strona = 1 000 wierszy), potem „Zsynchronizowano o …”; zapisać czas.

## Wyniki

Sprawdzone bez telefonu (19.11.2026, lokalny Supabase, skrypt na Node z tym samym klientem Supabase w trybie PKCE, `SyncEngine` na `node:sqlite`, dwa „urządzenia”):

| Sprawdzenie | Wynik |
|---|---|
| `signInWithOtp` z `emailRedirectTo: taskplanner://auth-callback` | OK, link w mailu ma `redirect_to=taskplanner://auth-callback` |
| Link z maila (weryfikacja) | przekierowanie na `taskplanner://auth-callback?code=…` |
| `exchangeCodeForSession(code)` tym samym klientem | sesja; drugi raz tym samym kodem — błąd (stąd jedna wymiana na kod w `auth.ts`) |
| Kod z maila → `verifyOtp({ type: 'email' })` | OK (kod z `admin.generateLink`; domyślny lokalny szablon go nie pokazuje — stąd nowy szablon) |
| Profil po pierwszej synchronizacji | jest, `onboarded = false` → kreator |
| `onboardingOps` przez `mutate` → drugie urządzenie | „Osobiste”, „Praca”, 2 Inboxy, ustawienia i imię; powtórny onboarding nie dubluje |
| Nowa przestrzeń + Inbox + projekt, kolejność (`reorderPatches`), archiwizacja i nazwa listy | bez odrzuceń, widoczne na drugim urządzeniu |
| Zadanie offline → `sync()` po powrocie sieci | na serwerze po 43 ms od wywołania (sam silnik; czas od włączenia sieci na telefonie — M7) |
| `npm run check`, `npx expo-doctor`, `npx expo export --platform android` | zielone |

Na telefonie (do wykonania; telefon nie był podłączony w czasie implementacji):

| Scenariusz | Data | Wynik |
|---|---|---|
| M1 link z maila | 19.11.2026 | **OK** (Galaxy S22 Ultra, dev build, `adb reverse` przez Wi-Fi, aplikacja w tle). Link „Sign in” w Mailpit w Chrome → aplikacja; serwer: `/verify` 303 i w tej samej sekundzie `/token` (`grant_type=pkce`) 200, potem `pull_changes` 200; ekran „Witaj w TaskPlanner” ze strefą `Europe/Warsaw`. Drugie kliknięcie tego samego linku: ekran „Nie udało się zalogować” z przyciskiem „Konto i serwer” — po poprawce (`AUTH_ERROR` / `authErrorMessage` w core) komunikat po polsku: „Link albo kod z maila wygasł lub został już użyty — wyślij nowy.”. Zimny start z linku — nie sprawdzony. |
| M2 kod z maila | | |
| M3 Google | | |
| M4 zmiana konta | | |
| M5 onboarding + drugie urządzenie | | |
| M6 przestrzenie i listy | | |
| M7 tryb samolotowy → serwer (s) | | |
| M8 pierwsza synchronizacja 2 000 zadań (s) | | |
