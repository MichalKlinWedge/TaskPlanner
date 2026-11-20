# PoC-4 — scenariusze na telefonie

Ekrany prób są w `apps/mobile` (ekran główny = menu PoC-4). Wyniki wpisywać do `docs/POC_WYNIKI.md` (sekcja PoC-4). Raporty z aplikacji („Udostępnij raport” / „Udostępnij wynik”) można wkleić w całości.

## Build

Bez EAS — szczegóły w `docs/ANDROID_BUILD.md`:

- iteracja z telefonem przez USB: `npx expo run:android` w `apps/mobile` (dev build, JS z Metro);
- build samodzielny (JS w APK — potrzebny do testów przy zamkniętej aplikacji, bez sieci i w Doze): `npx expo run:android --variant release` albo APK z GitHub Actions (`Android APK`).

Po instalacji: ekran główny → wszystkie uprawnienia nadawane na ekranach PoC (powiadomienia, dokładne alarmy, kalendarz).

## S1. Samosprawdzenie Hermes (PoC-1, PoC-2, PoC-3)

1. „Samosprawdzenie” → „Uruchom” (bez konta, może być tryb samolotowy).
2. Oczekiwane: wszystkie ✓ w grupach *Środowisko*, *PoC-1: id i zegar*, *PoC-3: cykliczność* (15 przypadków + 1 000 wystąpień < 20 ms), *PoC-3: nawyki* (5), *PoC-2: szybkie dodawanie* (korpus 100 %, pułapki 0, < 5 ms/wpis), *PoC-1: SQLite + silnik* (outbox, odrzucenie, scalanie per pole, UUIDv5, 500 zapisów < 10 s). Grupa *PoC-1: Supabase* — „Pominięte”.
3. „Udostępnij wynik” → wkleić do `POC_WYNIKI.md`.

## S2. Synchronizacja z serwerem (PoC-1 na telefonie)

Przygotowanie: na komputerze `npm run supabase -- start`, `npm run dev:user`. Dostęp telefonu do lokalnego Supabase: najprościej przez USB — `adb reverse tcp:54521 tcp:54521` i adres `http://127.0.0.1:54521`; albo Wi-Fi — `http://<IP komputera>:54521` (zapora Windows przepuszcza port w sieci prywatnej). Lokalny Supabase to `http` bez TLS: dev build na to pozwala (RN dodaje `usesCleartextTraffic` tylko w wariancie debug), build release — nie (Android 9+), więc S2 robić na dev buildzie.

1. „Konto i serwer”: adres jak wyżej, klucz = `PUBLISHABLE_KEY` z `npm run supabase -- status`, e-mail `dev@taskplanner.test` → „Wyślij link logowania” → link albo kod z maila w Mailpit (http://127.0.0.1:54524). Od MVP-1 nie ma logowania hasłem — szczegóły w `docs/MVP1_TELEFON.md` (M1, M2).
2. „Samosprawdzenie” → „Uruchom”: grupa *PoC-1: Supabase* — push + pull, wiersz na serwerze (zakres wyliczony), sygnał Realtime < 3 s, zmiana z drugiego węzła pobrana.
3. Dwa urządzenia: web `npm run web:local` → `/dev/sync` (to samo konto). Na telefonie tryb samolotowy → „Dziś” → „Dodaj przykładowe zadania” → wyłączyć tryb samolotowy, stoper: zadania na webie < 5 s (kryterium MVP-1). Edycja na webie → widać na telefonie po powrocie na ekran „Dziś” (Realtime < 3 s).

## S3. Przypomnienia bez dokładnych alarmów — rozstrzygnięte bez 3 dób

Od 19.11.2026 aplikacja deklaruje `USE_EXACT_ALARM` (APK poza Google Play — pozwolenie przyznane przy instalacji, nie da się go wyłączyć), więc wariantu „bez dokładnych alarmów” nie da się już zmierzyć na tym APK. Wynik wzięty z szybkiego testu i `dumpsys alarm` (`docs/POC_WYNIKI.md`): `setAndAllowWhileIdle` dostaje okno ≈ 75 % czasu do terminu → kryterium ≤ 10 min nie do spełnienia dla przypomnień ustawionych z wyprzedzeniem.

## S4. Przypomnienia z dokładnymi alarmami (3 doby)

1. „Przypomnienia” → „Poproś o powiadomienia”; „Dokładne alarmy”: **tak** (z `USE_EXACT_ALARM`, bez wchodzenia w ustawienia). Sprawdzenie: `adb shell dumpsys alarm` → alarmy `pl.taskplanner.app` bez okna (`window=0`).
2. „Zaplanuj (bestEffort)” 50 / 72 h (= `setExactAndAllowWhileIdle`). Opcjonalnie równolegle krótsza seria „alarmClock” (`setAlarmClock` — ikona budzika na pasku stanu; sprawdzić, czy nie przeszkadza).
3. Normalne używanie telefonu; **co najmniej jedna noc bez ładowarki, ekran wygaszony** (Doze — na One UI nie da się go wymusić przez adb). Powiadomień serii nie usuwać; raz dziennie wejść na „Przypomnienia” (zbiera czas pokazania i czyści zasobnik — Android trzyma ok. 50 powiadomień naraz).
4. Po 72 h: „Udostępnij raport”. Kryterium: ≥ 95 % ±1 min.

## S5. Akcje „Ukończ” / „Odłóż” przy zamkniętej aplikacji, bez sieci

1. Build samodzielny (release). „Przypomnienia” → „Szybki test: 3 w 4 min”.
2. Zamknąć aplikację (usunąć z ostatnich), włączyć tryb samolotowy.
3. Na 1. powiadomieniu „Ukończ”, na 2. „Jutro”, na 3. „Odłóż 10 min” (po 10 min nowe powiadomienie „Odłożone: …”).
4. Oczekiwane: powiadomienie znika po akcji, aplikacja się nie otwiera.
5. Otworzyć aplikację: „Przypomnienia” → „Akcje z powiadomień”: 3 wpisy `[background-task] OK`. Ekran główny: outbox + 3 (albo więcej) oczekujące. Po wyłączeniu trybu samolotowego (z kontem) — outbox 0, zmiany na webie.
6. To samo przy aplikacji w tle (nie zamkniętej) — wpisy bez duplikatów (obsługa idempotentna).

## S6. Widżet „Dziś” przy zamkniętej aplikacji, bez sieci

1. „Dziś i widżet” → „Dodaj przykładowe zadania” → „Dodaj widżet na ekran” (albo z listy widżetów launchera: „Task Planner — Dziś”).
2. Zamknąć aplikację, tryb samolotowy, kliknąć 2–3 zadania w widżecie: ☐ → ☑ (cykliczne „Trening” przesuwa się na jutro i znika z listy).
3. Oczekiwane: zmiana widoczna w widżecie ≤ 2 s; po otwarciu aplikacji „Dziś” w tym samym stanie; „Dziennik widżetu” — wpisy `CLICK TOGGLE_TASK` z czasem obsługi.
4. Odhaczenie w aplikacji → widżet odświeża się sam.
5. Restart telefonu → widżet rysuje się z lokalnej bazy (WIDGET_UPDATE).

## S7. Udostępnianie z Chrome

1. Aplikacja zamknięta. Chrome → dowolna strona → ⋮ → Udostępnij → Task Planner.
2. Oczekiwane: otwiera się „Szybkie dodawanie” z linkiem (i tytułem, jeśli Chrome go podał).
3. Dopisać „jutro o 20 !2” → podświetlenia (data, godzina, priorytet) → „Dodaj zadanie” → komunikat z czasem od odebrania.
4. Powtórzyć z aplikacją w tle (drugi link zastępuje pierwszy).
5. Udostępnić zwykły tekst (np. z notatek) — trafia do pola bez linku.

## S8. Kalendarz telefonu + calendar-kit

1. Na telefonie w kalendarzu Google dodać 2 wydarzenia na dziś (jedno całodniowe).
2. „Kalendarz” → zgoda → wydarzenia widoczne obok zadań (✓, niebieskie) z danymi przykładowymi.
3. Przytrzymać blok zadania, przeciągnąć na inną godzinę i rozciągnąć dół. Oczekiwane: płynnie (bez zacięć), „Zapisano …”, „Dziś” pokazuje nową godzinę; ekran nie zawiesza się (znane zgłoszenia #258 pętla renderów, #259 przeciąganie na Androidzie z Reanimated 4.7).
4. Przeciągnięcie wydarzenia z kalendarza → wraca na miejsce („tylko do odczytu”).

## S9. Własna oś dnia (wariant awaryjny)

„Oś dnia (własna)”: to samo co S8 p. 3 — przytrzymanie i przesunięcie bloku, uchwyt na dole zmienia długość co 5 min. Porównać płynność z calendar-kit.
