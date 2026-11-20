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

## Wyniki

| Scenariusz | Data | Wynik | Uwagi |
| --- | --- | --- | --- |
| E1 Edytor powtarzania | 20.11.2026 | OK | release APK (Galaxy S22 Ultra, lokalny Supabase przez `adb reverse`). Szablony zmieniają podgląd i opis od razu; „ostatni dzień miesiąca” → 30.11, 31.12, 31.01, 28.02, 31.03; reguła słowami „co 3 dni” rozpoznana i zapisana |
| E2 Pomiń / zakończ serię | 20.11.2026 | OK | „Pomiń to wystąpienie” → termin na ndz 22 lis, wpis `skipped` na serwerze; „Zakończ serię” po potwierdzeniu → `cancelled`, reguła zostaje. „Cofnij” nie sprawdzone (dymek zniknął przed stuknięciem) |
| E3 Tablica | 20.11.2026 | OK | „↓ Niżej”, „→ W trakcie” (karta na górze kolumny, liczniki 675/131, dymek z „Cofnij”); na serwerze `in_progress` + `board_sort_key`. Poprawione w trakcie: zakładki kolumn przycięte w pionie (`flexShrink: 0`) |
| E4 Tryb skupienia | 20.11.2026 | OK (po poprawce) | trwałe powiadomienie z Pauza / Pomiń / Stop; pauza z powiadomienia → `profiles.focus.paused` na serwerze; przerwa 1 min przy zabitej aplikacji → „Koniec przerwy — wróć do pracy” o czasie, stuknięcie otwiera `/focus` („Przerwa skończona”); `time_entries` — przerwa zamknięta dokładnie w chwili końca; wake lock aktywny; stoper działa. Poprawione: po końcu przerwy zostawało nieaktualne trwałe „Krótka przerwa — do …” (alarm podmienia je teraz tym samym id) |
| E5 Nawyki | 20.11.2026 | OK | lista, odhaczenie z dymkiem i passą, formularz, szczegóły. Poprawione: FAB „Nowy nawyk” pod paskiem nawigacji systemu (inset) |
| E6 Przypomnienie nawyku | 20.11.2026 | OK | przypomnienie o 06:17 przy zabitej aplikacji, „Zrobione” → wpis `done` na serwerze 06:17:34 bez otwierania aplikacji, powiadomienie znika |
| E7 Przegląd dnia | 20.11.2026 | OK (po poprawce) | 4 gesty + przyciski; podsumowanie „4 z 160” w 48 s; `review_sessions` ze `stats {done:1, someday:1, reviewed:4, rescheduled:2}`. Poprawione: dolne przyciski pod paskiem nawigacji systemu („Dalej” nie reagował) |
| E8 Przegląd tygodnia | 20.11.2026 | OK | 6 kroków, „Przenieś do…” (Inbox 147 → 146), nadchodzący tydzień, nawyki 7 dni, podsumowanie |
| E9 Offline | 20.11.2026 | OK z uwagą | zamiast trybu samolotowego odcięty serwer (`adb reverse --remove tcp:54521` + `am force-stop`, jak T8 w MVP-3). Offline: odhaczenie „Warzywa do obiadu”, karta → „W trakcie”, dwie decyzje przeglądu dnia (gest „jutro”, przycisk „Dziś”), Pomodoro z pauzą — na serwerze nic. Po `adb reverse tcp:54521 tcp:54521` synchronizacja **zawisła** (gniazdo otwarte, brak odpowiedzi — klient bez limitu czasu na `fetch`, por. uwaga niżej); po ponownym starcie aplikacji wszystko na serwerze w ~1,2 s: 3 zadania, wpis nawyku, odcinek `time_entries`, `profiles.focus` z pauzą, wiersz `review_sessions`; bez duplikatów (1 wpis nawyku na dzień, 1 odcinek) |

Uwaga do E9: zawieszenie po przywróceniu `adb reverse` to najpewniej artefakt przekierowania USB (połączenie otwarte w chwili jego dodania), ale pokazuje, że `fetch` w `lib/sync.ts` nie ma limitu czasu — jedno zawieszone żądanie blokuje synchronizację do restartu aplikacji. Do rozważenia: limit czasu (np. `AbortController`, 30 s) w `global.fetch` klienta Supabase.
