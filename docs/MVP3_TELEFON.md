# MVP-3 — scenariusze na telefonie (wykonanie offline)

Część telefoniczna MVP-3 w `apps/mobile`: zakładki `src/app/(tabs)/`, szczegóły `src/app/task/[id].tsx`, szybkie dodawanie `src/components/quick-add-field.tsx` (okno `src/app/quick-add.tsx`), gesty `src/components/task-row.tsx`, przypomnienia M8 `src/lib/scheduler.ts` (akcje w `src/lib/reminders.ts`, operacje bez ekranu `src/lib/headless.ts`), synchronizacja w tle `src/lib/background-sync.ts`, skróty aplikacji `plugins/app-shortcuts.js`. Wyniki wpisywać w tabeli na końcu.

## Przygotowanie

- Jak w `docs/MVP1_TELEFON.md` (lokalny Supabase, `adb reverse tcp:54521 tcp:54521`, dev build). **Nowy APK obowiązkowy**: doszły `expo-background-task` (moduł natywny) i skróty aplikacji (`res/xml/shortcuts.xml` z prebuild) — `cd apps/mobile && npx expo run:android`.
- Dane: `npm run seed:dev -- --load` (2 000 zadań jako `dev@taskplanner.test`), na telefonie logowanie tym kontem.
- Pozwolenia: „Konto i synchronizacja” → „Przypomnienia i praca w tle” → „Włącz powiadomienia” i „Dokładne alarmy…”.

## T1. Pierwsza synchronizacja — pomiar

1. „Konto i synchronizacja” → wyloguj (czyści dane lokalne) → zaloguj `dev@taskplanner.test`.
2. Po zakończeniu pobierania odczytać „Ostatnie pobranie”: wiersze, strony, razem, `zapytanie pull_changes` kontra `zapis SQLite`, najwolniejsza strona.
3. Oczekiwane: zapis SQLite wyraźnie poniżej ~20 s z MVP-1 (hurtowy zapis strony); wpisać obie liczby.

## T2. Widoki

1. Zakładki Dziś (zaległe / dziś / w toku / nawyki / ukończone dziś), Inbox, Nadchodzące (14 dni, „+” na dzień, „Później”), Przeglądaj (przestrzenie → listy z licznikami, filtry, tagi, kosz).
2. Przełącznik przestrzeni w nagłówku: „Wszystkie” ↔ jedna przestrzeń — liczby i listy się zmieniają.
3. Lista / projekt: drzewo podzadań ze zwijaniem i postępem; zmiana sortowania / grupowania / ukończonych zostaje po powrocie (i na webie — `view_prefs`).
4. Szukaj (⌕): fragment tytułu bez polskich znaków, także słowo z opisu; ostatnio otwierane na górze pustego pola.

## T3. Szczegóły zadania

1. Zmiana statusu, priorytetu, listy, czasu, terminu, godziny, początku; powtarzanie „co tydzień w pon”; tagi (nowy i z podpowiedzi); przypomnienie „30 min przed” i „o wybranej porze”.
2. Opis: „Edytuj opis” → pogrubienie, lista, pole wyboru, nagłówek → „Gotowe”; w podglądzie dotknięcie pola wyboru je odhacza.
3. Podzadanie przez pole „Dodaj podzadanie”; 4. poziom nie pozwala dodać 5.
4. Oczekiwane: każda zmiana widoczna na webie po synchronizacji (< 5 s z siecią).

## T4. Szybkie dodawanie i skróty

1. „+” → `Zadzwonić do mamy jutro 18:00 !2 #dom przypomnij 30 min przed` → chipy: data, godzina, priorytet, tag, przypomnienie; dotknięcie chipu cofa rozpoznanie.
2. „Dodawaj kolejne” włączone — okno zostaje otwarte; wklejenie trzech linii pyta „Osobno / Jedno”.
3. Przytrzymanie ikony aplikacji: „Szybkie dodawanie”, „Dziś”, „Szukaj”. Każdy przy zamkniętej aplikacji (zimny start) i w tle; pod oknem szybkiego dodawania są zakładki.
4. Udostępnienie strony z Chrome: tytuł strony w polu (jeśli Chrome go podał), link w opisie, „Dodaj” bez tytułu = tytuł strony albo adres.

## T5. Gesty i akcje grupowe

1. Przesunięcie w prawo = ukończ, „Cofnij” w dymku przywraca; zadanie cykliczne dostaje następny termin.
2. Przesunięcie w lewo = menu terminu (dziś, jutro, za tydzień, data…, bez terminu).
3. Przytrzymanie = zaznaczanie; kolejne dotknięcia dodają; pasek: ukończ, dziś, jutro, data, priorytet, przenieś, kosz — każde z „Cofnij”.

## T6. Przypomnienia M8 (aplikacja zamknięta, bez sieci)

1. Tryb samolotowy. Zadanie z terminem dziś za 10 min i przypomnieniem „5 min przed”; drugie z przypomnieniem bezwzględnym za 3 min.
2. Zamknąć aplikację (z listy ostatnich). Oczekiwane: oba powiadomienia ±1 min, treść „Za 5 min (GG:MM)” / „Termin: …”.
3. „Odłóż 10 min” → powiadomienie wraca po 10 min; „Ukończ” → zadanie ukończone (sprawdzić po otwarciu i na widżecie); „Jutro” → termin jutro, licznik odłożeń +1.
4. Zmiana terminu zadania w aplikacji → przypomnienie przeplanowane (Ustawienia: „Zaplanowane: N, najbliższe …”); ukończenie zadania → przypomnienie i odłożone powiadomienie znikają.

## T7. Synchronizacja w tle

1. Ustawienia → „Synchronizacja w tle: co ≥ 15 min”. W dev buildzie „Wyzwól zadanie w tle (test)” → nowy przebieg z czasem.
2. Aplikacja zamknięta, sieć włączona: zmiana terminu i przypomnienia na webie. Po ≤ ~30 min (decyduje Android) przypomnienie przychodzi według nowego terminu, a widżet pokazuje zmianę bez otwierania aplikacji.

## T8. Cały dzień w trybie samolotowym (kryterium odbioru)

1. Rano tryb samolotowy; przez dzień dodawanie, edycja, odhaczanie (także z widżetu i z powiadomień).
2. Wieczorem sieć: wszystkie zmiany na webie, zmiany z webu na telefonie; żadnych odrzuconych operacji (Ustawienia).

## T9. Odłożone z PoC-4

1. Czas od „Ukończ” w powiadomieniu do zapisu na release APK (`adb logcat` / dziennik akcji na ekranie „Przypomnienia (PoC-4)”).
2. Zimny start release APK z linku logowania z maila.
3. 3 doby w Doze: seria 50 przypomnień (ekran PoC-4), wynik ≥ 95 % ±1 min — **tylko za zgodą użytkownika** (w PoC-4 pominięte).

## Wyniki

| Scenariusz | Data | Wynik | Uwagi |
| --- | --- | --- | --- |
| T1 | 19.11.2026 | OK | dev build, 5 767 wierszy / 6 stron: przed poprawką 22,9–23,5 s (zapis 4,9 s, **kolejka 15,9 s** — odświeżanie widoków po każdej stronie), po poprawce **3,4 s** (zapytanie 1,5 s, zapis 2,6 s, scalenie 0,2 s, kolejka 0,06 s); MVP-1: ~27 s |
| T2 | | | |
| T3 | | | |
| T4 | | | |
| T5 | 19.11.2026 | w toku | przesunięcie w prawo = ukończ + „Cofnij” (po poprawce kierunku), odświeżenie widoku 0,27 s (zapytania 0,22 s po zastąpieniu podzapytania tagów; wcześniej 0,9 s) |
| T6 | | | |
| T7 | | | |
| T8 | | | |
| T9 | | | |
