# MVP-4 i Etapy 7–9 — scenariusze na telefonie

Części „telefon — z MVP-3” z `PLAN_ETAPOWY.md` w `apps/mobile`: edytor powtarzania `src/components/recurrence-editor.tsx` i akcje serii w `src/app/task/[id].tsx` (MVP-4), uproszczona tablica `src/app/board.tsx` (MVP-4), tryb skupienia `src/app/focus.tsx` + `src/lib/focus.ts` (Etap 7), nawyki `src/app/habits.tsx`, `src/app/habit/[id].tsx`, `src/app/habit-form.tsx`, `src/components/habits.tsx` (Etap 8), przeglądy `src/app/review/daily.tsx`, `src/app/review/weekly.tsx`, `src/components/review.tsx` (Etap 9). Logika — wyłącznie `packages/core` (`recurrence-editor.ts`, `tasks.ts`, `kanban.ts`, `focus.ts`, `habits.ts`, `review.ts`); operacje bez ekranu (akcje powiadomień) przez `src/lib/headless.ts`. Wyniki wpisywać w tabeli na końcu.

## Przygotowanie

- Jak w `docs/MVP3_TELEFON.md` (lokalny Supabase, `adb reverse tcp:54521 tcp:54521`, dane `dev@taskplanner.test`).
- **Nowy APK obowiązkowy**: doszedł `expo-keep-awake` (moduł natywny). Release lokalnie: `docs/ANDROID_BUILD.md` (prebuild → `cmake.dir` w `android/local.properties` → `gradlew assembleRelease`), `adb install -r …/app-release.apk`.
- Pozwolenia: powiadomienia i dokładne alarmy (jak w MVP-3).

## E1. Edytor powtarzania (MVP-4)

1. Zadanie → „Powtarzanie” → szablony (codziennie, w dni robocze, co tydzień, co miesiąc, co rok) — podgląd 5 najbliższych dat i opis słowny zmieniają się od razu.
2. „Więcej opcji…”: co 2 tygodnie w pon i czw; co miesiąc „ostatni dzień roboczy”; koniec „po 5 razach” i „do daty” — podgląd się kończy.
3. Pole „reguła słowami”: `co 3 dni` → rozpoznane; „Zapisz” — na webie ta sama reguła po synchronizacji.

## E2. Pomiń wystąpienie / Zakończ serię (MVP-4)

1. Zadanie cykliczne z podzadaniami → „Pomiń to wystąpienie”: termin przechodzi na następne wystąpienie bez zaliczenia (wpis `skipped`); „Cofnij” przywraca.
2. „Zakończ serię” → potwierdzenie → seria anulowana bez zaliczenia bieżącego wystąpienia (reguła zostaje); „Cofnij” przywraca.

## E3. Tablica (MVP-4, uproszczona)

1. Przeglądaj → „Tablica” (bieżąca przestrzeń) i lista → „▦ Tablica” (kanban listy).
2. „Kolumny: …” → Status / Priorytet / Dzień tygodnia / Tag / Lista; zakładki kolumn z licznikami, „Gotowe” z 7 dni.
3. „⇄” na karcie → „→ W trakcie”: karta na początku nowej kolumny, dymek z „Cofnij”; „↑ Wyżej” / „↓ Niżej” zmienia kolejność (zostaje po powrocie i na webie — `board_sort_key`).
4. Kryterium tablicy listy zapisane w `view_prefs.boardBy` (to samo na webie); tablica przestrzeni — pamiętane na telefonie.

## E4. Tryb skupienia (Etap 7)

1. Zadanie → „▶ Skup się” → Pomodoro: tarcza liczy, ekran nie gaśnie (`expo-keep-awake`), w nagłówku zakładek „⏱ mm:ss”.
2. Trwałe powiadomienie „Praca · Pomodoro 1 — do HH:MM” z „Pauza / Pomiń / Stop”; „Pauza” z powiadomienia zatrzymuje timer (też na webie), „Wznów” wznawia.
3. Krótka przerwa 1 min (ustawienia na ekranie skupienia; praca ma minimum 10 min) → Pomodoro → „Pomiń” (przerwa) → zamknąć aplikację (`adb shell am kill pl.taskplanner.app` albo usunąć z ostatnich) → po minucie „Koniec przerwy — wróć do pracy” z wibracją, w miejscu trwałego powiadomienia. Koniec pracy działa tak samo (alarm „Koniec pracy · Krótka przerwa — do …”; `adb shell dumpsys alarm` pokazuje oba alarmy `RTC_WAKEUP` z `exactAllowReason=policy_permission`). Po otwarciu aplikacji etap doliczony w chwili końca (web pokazuje ten sam stan).
4. Stoper: start → stop → „Czas pracy” w zadaniu rośnie; „+ Dodaj czas” 15 min z „Cofnij”; „Ten tydzień” — słupki dni i zadania.

## E5. Nawyki (Etap 8)

1. Przeglądaj → „Nawyki” → „+”: „Woda”, cel 8 szklanek, codziennie, pora 09:00, przypomnienie.
2. „Dziś”: blok nawyków — odhaczenie, „−/+” przy celu ilościowym (mniej niż cel = częściowo), „Wolne”, „Cofnij”; po wszystkich „· wszystko zrobione”.
3. Szczegóły nawyku: passa, regularność 7/30/90, pasek 8 dni (dotknięcie: zrobione → wolne → wyczyść, do 7 dni wstecz), wykres 12 tygodni, mapa roku; „Zakończ” / „Wznów” / „Usuń” z „Cofnij”.
4. Te same wpisy na webie (`#/habit/<id>`) — jeden wpis na dzień (id deterministyczne).

## E6. Przypomnienie nawyku i „Zrobione” (Etap 8)

1. Pora nawyku za 2 min → powiadomienie z przyciskiem „Zrobione” (aplikacja zamknięta).
2. „Zrobione” → wpis dnia zapisany bez otwierania aplikacji; drugie dotknięcie (albo odhaczenie wcześniej na webie) nie dubluje wpisu.
3. Nawyk odhaczony przed porą → powiadomienie tego dnia nie przychodzi (`reminderFireTimes` z `habitCompletions`).

## E7. Przegląd dnia — gesty (Etap 9)

1. „Dziś” o porze przeglądu (Ustawienia → „Przeglądy” na webie) → „🌙 Pora na przegląd dnia →”; albo Przeglądaj → „Przegląd dnia”.
2. Karta: w prawo = ukończ, w lewo = jutro, w górę = dziś, w dół = kiedyś (seria — karta wraca); krótkie przesunięcie wraca na miejsce; przyciski 6 decyzji, „Wybierz datę”, „Wstecz” / „Pomiń”.
3. Koniec: liczby decyzji, czas, ukończone dziś, plan na jutro; na serwerze wiersz `review_sessions` ze statystykami.

## E8. Przegląd tygodnia (Etap 9)

1. Przeglądaj → „Przegląd tygodnia”: 6 kroków z licznikami; Inbox — decyzje przy każdym zadaniu i „Przenieś do…”; zaległe; projekty bez następnego kroku — „Dziś / Jutro / +7 dni” i pole „Następny krok”; „oczekuje > 7 dni” — „Już nie czeka”; nadchodzący tydzień; nawyki z 7 dni.
2. „Zakończ przegląd” → podsumowanie; „Inbox pusty, każdy aktywny projekt ma następny krok.” gdy tak jest.

## E9. Offline

1. Tryb samolotowy: E3 (przeniesienie karty), E4 (Pomodoro z pauzą), E5 (odhaczenie), E7 (dwie decyzje) → wyłączyć tryb samolotowy → po < 10 s wszystko na webie, bez duplikatów.

## E10. Kalendarz — dzień (Etap 5)

1. Przeglądaj → „Kalendarz” → „Dzień”: oś 0–24 przewinięta do bieżącej godziny, linia „teraz”, wolne okna w godzinach pracy (zielone), bloki zadań z godziną, nawyki z porą, wydarzenia kalendarzy połączonych na serwerze.
2. Przytrzymanie bloku zadania i przeciągnięcie → nowa godzina co 15 min, dymek „→ dziś GG:MM” z „Cofnij”; uchwyt na dole bloku → nowa długość. Na serwerze `due_time` / `duration_min`.
3. Dotknięcie bloku → menu „Otwórz / Zmień godzinę… / Czas trwania… / Bez godziny”; „+ Zaplanuj…” → zadanie bez godziny → godzina.
4. Dwa zadania na tę samą godzinę → obok siebie, czerwone obramowanie, „⚠ 1 konflikt” nad osią.

## E11. Kalendarz — tydzień i miesiąc (Etap 5)

1. „Tydzień”: 7 dni od pierwszego dnia tygodnia z ustawień, w każdym całodniowe, potem od najwcześniejszej godziny; wydarzenie wielodniowe w każdym dniu; dotknięcie dnia → oś dnia.
2. „Miesiąc”: siatka z kropkami (zadania, nawyki, wydarzenia, konflikt na czerwono), dotknięcie dnia → agenda pod siatką, drugie dotknięcie / „Oś dnia ›” → widok dnia. ‹ › i „Dziś” przełączają zakres.

## E12. Kalendarze telefonu (Etap 5)

1. „📱” w nagłówku kalendarza → zgoda na kalendarz → lista kalendarzy telefonu (konto pod nazwą) → wybrać jeden → jego wydarzenia na osi dnia, w tygodniu i miesiącu (kolor kalendarza). Całodniowe — w swoim dniu (bez przesunięcia o strefę). Wydarzenie „wolny” bez konfliktu.

## E13. „Plan dnia” w „Dziś” (Etap 5)

1. Na górze „Dziś” zwijany „Plan dnia”: oś godzin pracy (poszerzona o bloki spoza nich), bloki, konflikty, „Ułóż w kalendarzu ›” → widok dnia. Stan zwinięcia zostaje po ponownym uruchomieniu.
2. Offline (serwer odcięty): przesunięcie bloku w kalendarzu → widać od razu w „Planie dnia”; po przywróceniu serwera zmiana na webie.

## E14. Alarm na cały ekran (M8)

Przed testem: Konto i synchronizacja → „Przypomnienia i praca w tle” → „Alarm na cały ekran”; nie powinno być ostrzeżenia o pełnym ekranie.

1. „Wypróbuj (za 10 s)” i zablokowanie telefonu → ekran się zapala, plansza nad blokadą z zegarem, tytułem, opisem i trzema przyciskami; dźwięk budzika i wibracja. Klawisz głośności wycisza, plansza zostaje.
2. Zadanie z opisem i przypomnieniem za 2 min, aplikacja zamknięta, telefon zablokowany → plansza o czasie. „Zakończ” → zadanie ukończone na serwerze bez otwierania aplikacji (także offline — po powrocie sieci).
3. „Czekaj 5 min” (zmienić w ustawieniach) → plansza znika i wraca po 5 min z „Odłożone · termin …”; drugie „Czekaj” działa tak samo. Ukończenie zadania na webie w trakcie czekania → po synchronizacji alarm nie przychodzi.
4. „Edytuj” na zablokowanym telefonie → cisza, odblokowanie, ekran zadania. Anulowany PIN → alarm zostaje.
5. Telefon w użyciu (inna aplikacja) → plakietka z tymi samymi przyciskami; otwarty Task Planner → plansza od razu.
6. Bez odpowiedzi 2 min → cisza, ciche powiadomienie z przyciskami. Restart telefonu → zaplanowane alarmy dalej przychodzą.
7. Cykliczne: „Zakończ” → wpis `done`; powrót na „Powiadomienie na belce” → kolejne przypomnienie zwykłym powiadomieniem, bez duplikatu.

## E15. Centrum powiadomień

Przed testem: drugie konto we wspólnej przestrzeni (web), na telefonie Konto i synchronizacja → „Powiadomienia” → „Zadania we wspólnych przestrzeniach” = „W aplikacji i w zasobniku”; zgoda na powiadomienia.

1. Aplikacja otwarta; drugie konto przypisuje zadanie i dodaje komentarz → w ≤ 5 s dymek „🔔 …”, licznik na dzwonku w nagłówku zakładek; brak powiadomienia w zasobniku.
2. Dzwonek → ekran „Powiadomienia”: dni, filtry „Nieprzeczytane” / rodzaj / przestrzeń; dotknięcie → zadanie i znika kropka; ✕ usuwa wpis (też na webie po synchronizacji).
3. Aplikacja w tle (Home); drugie konto zmienia termin zadania → powiadomienie w zasobniku po synchronizacji (od razu, póki proces żyje, inaczej przy synchronizacji w tle ~15 min). „Oznacz jako przeczytane” → znika, licznik na webie maleje bez otwierania aplikacji.
4. Dotknięcie powiadomienia w zasobniku → otwiera się zadanie, wpis przeczytany. Przeczytanie na webie → powiadomienie znika z zasobnika przy następnej synchronizacji.
5. Cisza nocna obejmująca teraz → w zasobniku nic, dzwonek dalej liczy. Pierwsze uruchomienie nowej wersji → starsze nieprzeczytane bez zalewu powiadomień.

## Wyniki

| Scenariusz | Data | Wynik | Uwagi |
| --- | --- | --- | --- |
| E1 Edytor powtarzania | 20.11.2026 | OK | release APK (Galaxy S22 Ultra, lokalny Supabase przez `adb reverse`). Szablony zmieniają podgląd i opis od razu; „ostatni dzień miesiąca” → 30.11, 31.12, 31.01, 28.02, 31.03; reguła słowami „co 3 dni” rozpoznana i zapisana |
| E2 Pomiń / zakończ serię | 20.11.2026 | OK | „Pomiń to wystąpienie” → termin na ndz 22 lis, wpis `skipped` na serwerze; „Zakończ serię” po potwierdzeniu → `cancelled`, reguła zostaje. „Cofnij” (sprawdzone osobno, zadanie „codziennie” z szybkiego dodawania): po pominięciu termin wraca na dziś, a wpis `skipped` zostaje usunięty (`deleted_at`); po zakończeniu serii wraca `todo` z tą samą regułą. Dymek znika po 10 s |
| E3 Tablica | 20.11.2026 | OK | „↓ Niżej”, „→ W trakcie” (karta na górze kolumny, liczniki 675/131, dymek z „Cofnij”); na serwerze `in_progress` + `board_sort_key`. Poprawione w trakcie: zakładki kolumn przycięte w pionie (`flexShrink: 0`) |
| E4 Tryb skupienia | 20.11.2026 | OK (po poprawce) | trwałe powiadomienie z Pauza / Pomiń / Stop; pauza z powiadomienia → `profiles.focus.paused` na serwerze; przerwa 1 min przy zabitej aplikacji → „Koniec przerwy — wróć do pracy” o czasie, stuknięcie otwiera `/focus` („Przerwa skończona”); `time_entries` — przerwa zamknięta dokładnie w chwili końca; wake lock aktywny; stoper działa. Poprawione: po końcu przerwy zostawało nieaktualne trwałe „Krótka przerwa — do …” (alarm podmienia je teraz tym samym id) |
| E5 Nawyki | 20.11.2026 | OK | lista, odhaczenie z dymkiem i passą, formularz, szczegóły. Poprawione: FAB „Nowy nawyk” pod paskiem nawigacji systemu (inset). Formularz „Co miesiąc” (sprawdzony osobno, release APK z `main` po 65244fa i cf85ebc): podgląd od razu — „20.” dnia miesiąca → 20.11, 20.12, 20.01; trzeci piątek → 20.11, 18.12, 15.01; ostatni piątek → 27.11, 25.12, 29.01; zapis `FREQ=MONTHLY;BYDAY=-1FR`, w szczegółach „ostatni piątek miesiąca”; „Edytuj” odtwarza regułę, zmiana na ostatni dzień roboczy → 30.11, 31.12, 29.01 i `BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1` |
| E6 Przypomnienie nawyku | 20.11.2026 | OK | przypomnienie o 06:17 przy zabitej aplikacji, „Zrobione” → wpis `done` na serwerze 06:17:34 bez otwierania aplikacji, powiadomienie znika |
| E7 Przegląd dnia | 20.11.2026 | OK (po poprawce) | 4 gesty + przyciski; podsumowanie „4 z 160” w 48 s; `review_sessions` ze `stats {done:1, someday:1, reviewed:4, rescheduled:2}`. Poprawione: dolne przyciski pod paskiem nawigacji systemu („Dalej” nie reagował) |
| E8 Przegląd tygodnia | 20.11.2026 | OK | 6 kroków, „Przenieś do…” (Inbox 147 → 146), nadchodzący tydzień, nawyki 7 dni, podsumowanie |
| E9 Offline | 20.11.2026 | OK z uwagą | zamiast trybu samolotowego odcięty serwer (`adb reverse --remove tcp:54521` + `am force-stop`, jak T8 w MVP-3). Offline: odhaczenie „Warzywa do obiadu”, karta → „W trakcie”, dwie decyzje przeglądu dnia (gest „jutro”, przycisk „Dziś”), Pomodoro z pauzą — na serwerze nic. Po `adb reverse tcp:54521 tcp:54521` synchronizacja **zawisła** (gniazdo otwarte, brak odpowiedzi — klient bez limitu czasu na `fetch`, por. uwaga niżej); po ponownym starcie aplikacji wszystko na serwerze w ~1,2 s: 3 zadania, wpis nawyku, odcinek `time_entries`, `profiles.focus` z pauzą, wiersz `review_sessions`; bez duplikatów (1 wpis nawyku na dzień, 1 odcinek) |
| E10 Kalendarz — dzień | 20.11.2026 | OK (po poprawkach) | release APK. Przytrzymanie i przeciągnięcie bloku „Kupić zamówienie” 08:00 → 08:45 (dymek „→ dziś 08:45”, na serwerze `due_time` 08:45 w ~1 s); menu bloku: „Czas trwania…” → 30 min, uchwyt → 45 min, kolejny ruch uchwytu → 60 min i „Cofnij” → z powrotem 45 min na serwerze; „Zmień godzinę…” → 08:00. Konflikt 19:30 (dwa zadania obok siebie, czerwone obramowanie, „⚠ 1 konflikt”). Poprawione: przewinięcie na start (zimny start — wyrównanie do „teraz” po każdej zmianie treści, dopóki nie przewinie się palcem), tekst krótkich bloków (uchwyt nad krawędzią), „cały dzień” zwinięty do 8 pozycji z „+N”. „+ Zaplanuj…” niesprawdzone osobno (ten sam wybór godziny co w menu) |
| E11 Tydzień i miesiąc | 20.11.2026 | OK | tydzień 16–22 lis z dniami jako kartami; miesiąc listopad 2026 (6 tygodni od poniedziałku), dotknięcie dnia → agenda pod siatką. Poprawione: „bez godziny” zamiast „cały dzień” przy zadaniach, kropki także pozycji ukończonych / „wolny” (przygaszone), całodniowe wydarzenia przed zadaniami |
| E12 Kalendarze telefonu | 20.11.2026 | OK | lista 21 kalendarzy z kontem; „Dzień Niepodległości” z „Święta w Polsce” 11.11 (bez przesunięcia o strefę), przygaszone — status „wolny”, bez konfliktu. Jeden z kalendarzy świąt ma w telefonie wyłączoną synchronizację (0 wydarzeń) — to stan telefonu. Po teście wybór kalendarzy wyczyszczony |
| E13 „Plan dnia” w „Dziś” | 20.11.2026 | OK z uwagą | rozwinięty: oś 06:00–20:00 (godziny pracy poszerzone o bloki), konflikt, wolne okna, linia „teraz”; zajmował cały ekran, więc domyślnie zwinięty z „Następny: 13:15 Napisać wizytę”, „⚠ 1”, „Kalendarz ›”. Krok 2 (offline) niesprawdzony |

Uwaga do E9: zawieszenie po przywróceniu `adb reverse` to najpewniej artefakt przekierowania USB (połączenie otwarte w chwili jego dodania), ale pokazuje, że `fetch` w `lib/sync.ts` nie ma limitu czasu — jedno zawieszone żądanie blokuje synchronizację do restartu aplikacji. Poprawione 20.11.2026: `fetchWithTimeout` w `lib/sync.ts` (30 s, poza Storage). Próba na release APK: `adb reverse tcp:54521 tcp:54599` na serwer TCP, który przyjmuje połączenie i milczy; ukończenie zadania → po 30 s baner „Serwer nie odpowiedział w 30 s (timeout)” i ponowienie; po przywróceniu `adb reverse tcp:54521 tcp:54521` zmiana na serwerze po ~5 s, bez restartu aplikacji.
