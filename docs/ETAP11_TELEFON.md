# Etap 11 — widżety Android (scenariusze na telefonie)

Widżety M20 w `apps/mobile/src/widget/`: „Dziś” (`today-widget.tsx`), „Szybkie dodawanie” (`quick-add-widget.tsx`), „Nawyki” (`habits-widget.tsx`), wspólny wygląd `ui.tsx`. Co pokazują i co zapisuje kliknięcie — `packages/core/src/widgets.ts` (`todayWidgetModel`, `habitsWidgetModel`, `inboxCount`, `sameHabitEntry`; testy `widgets.test.ts`). Dane i odświeżanie — `refresh.ts` (`refreshWidgets`: jeden odczyt bazy, tylko widżety położone na ekranie), obsługa bez ekranu — `task-handler.ts` (zapisy przez `lib/headless.ts`: `setTaskDoneById`, `setHabitEntryById`). Konfiguracja widżetów: plugin `react-native-android-widget` w `app.json` (`Today`, `QuickAdd`, `Habits`, `updatePeriodMillis` = 30 min). Wyniki wpisywać w tabeli na końcu.

**Zasady.** Kliknięcie niesie stan docelowy („ukończ”, „przywróć”, „wpis dnia = 4 szklanki”), nie „przełącz” — powtórzona obsługa nic nie zmienia (dziennik: „bez zmian”). Ukończenie serii idzie z wystąpieniem (`occurrence`), więc stuknięcie w widżet sprzed przesunięcia serii nie ukończy następnego terminu. Nawyk odhacza się tylko na dziś: widżet narysowany przed północą po stuknięciu tylko się odświeża. Odświeżenie: po każdej zmianie danych w aplikacji (`BackgroundWork` w `_layout.tsx`), po akcji z powiadomienia, po kliknięciu w widżet (także pozostałe widżety — licznik Inbox, „Dziś”), z synchronizacji w tle (≥ 15 min) i co 30 min (`WIDGET_UPDATE`).

## Przygotowanie

- Jak w `docs/MVP3_TELEFON.md` (lokalny Supabase, `adb reverse tcp:54521 tcp:54521`, konto `dev@taskplanner.test` z `npm run seed:dev -- --load`). **Nowy APK obowiązkowy** — nowe widżety to nowe odbiorniki w manifeście (prebuild): release lokalnie według `docs/ANDROID_BUILD.md` (`gradlew assembleRelease`, `adb install -r …/app-release.apk` — bez utraty danych na dev buildzie).
- Na webie (`npm run web:local`) to samo konto — do sprawdzania zmian z widżetów.
- Widżety: długie przytrzymanie ekranu głównego → Widżety → TaskPlanner → „Dziś”, „Szybkie dodawanie”, „Nawyki” (albo przyciski „Dodaj widżet na ekran główny”: Przeglądaj → Narzędzia PoC → „Dziś i widżety”). Dziennik kliknięć na tym samym ekranie.
- Co najmniej 2 nawyki na dziś, w tym jeden z celem ilościowym (np. „Woda”, cel 8 szklanek), i ≥ 12 zadań na dziś / zaległych.

## W1. „Dziś”: lista, limit, odhaczanie przy zamkniętej aplikacji

1. Aplikację zamknąć (z listy ostatnich). Widżet pokazuje „Dziś · N” (zaległe + dziś), najwyżej 10 wierszy: zaległe na czerwono, potem dziś (z godziną), na końcu ukończone dziś; przy > 10 — „+K więcej w aplikacji” (otwiera „Dziś”).
2. Stuknięcie ☐ → ☑ w ≤ ~2 s, licznik w nagłówku spada; stuknięcie ☑ → zadanie wraca. Na webie (z siecią) zmiana po ≤ 5 s.
3. Zadanie cykliczne: stuknięcie przesuwa termin (wiersz znika albo zostaje z następnym terminem dziś); szybkie drugie stuknięcie tego samego wiersza nie ukończy następnego wystąpienia (dziennik: „bez zmian”).
4. Zmiana przestrzeni w aplikacji → widżet pokazuje zadania tej przestrzeni.

## W2. „Nawyki”

1. Widżet: „Nawyki · N” (nawyki do załatwienia dziś), postęp „3 / 8 szklanek”, „1 / 3 w tym tygodniu”.
2. Stuknięcie nawyku → zrobione (☑, przyciemniony), ponowne → wyczyszczone; „+1” przy nawyku ilościowym → „4 / 8”, po osiągnięciu celu „+1” znika.
3. To samo w aplikacji (blok nawyków w „Dziś”) i na webie (`#/habits`) — ten sam dzień, ta sama wartość.
4. Po północy (albo zmiana daty w systemie): stuknięcie w widżet narysowany wczoraj tylko go odświeża, wczorajszy dzień się nie zmienia.

## W3. „Szybkie dodawanie”

1. „Dodaj zadanie” przy zamkniętej aplikacji → okno szybkiego dodawania z klawiaturą, pod spodem zakładki; dodanie zadania „Kupić mleko jutro #dom” — chipy jak z „+”.
2. 🎤 → to samo okno z podpowiedzią dyktowania; mikrofon na klawiaturze (Gboard / Samsung) → „zadzwonić do Ani jutro o 10” → chipy daty i godziny.
3. Licznik Inbox: dodanie zadania bez listy / ukończenie zadania z Inbox (w aplikacji albo w widżecie „Dziś”) zmienia liczbę; stuknięcie licznika otwiera Inbox.

## W4. Odświeżanie

1. Zmiana w aplikacji (ukończenie gestem, nowe zadanie na dziś, nawyk) → wszystkie widżety po ~1,5 s od zmiany (albo od razu przy wyjściu z aplikacji).
2. Zmiana na webie przy zamkniętej aplikacji → widżet po przebiegu w tle (wymuszenie: `adb shell cmd jobscheduler run -f pl.taskplanner.app <id>` jak w T7) albo najpóźniej po 30 min; godzina w nagłówku = ostatnie odświeżenie.
3. „Co 30 min”: zostawić telefon na ≥ 1 h — godzina w nagłówku zmienia się co ~30 min (Android może przesunąć aktualizację w uśpieniu).
4. Wylogowanie → widżety bez zadań starego konta.

## W5. Tryb samolotowy (kryterium odbioru Etapu 11)

1. Tryb samolotowy. Z widżetu „Dziś” odhaczyć 2 zadania (jedno cykliczne), z „Nawyki” odhaczyć nawyk i dać „+1”, z „Szybkie dodawanie” dodać zadanie. Aplikacji nie otwierać.
2. Wyłączyć tryb samolotowy; otworzyć aplikację (albo poczekać na przebieg w tle).
3. **Oczekiwane:** na webie zadania odhaczone z widżetu są ukończone (seria ma następny termin i wpis w historii), nawyk zaliczony z tą samą wartością, nowe zadanie jest; żadnych odrzuconych operacji (Ustawienia → Konto i synchronizacja).

## Wyniki

| Scenariusz | Data | Wynik | Uwagi |
| --- | --- | --- | --- |
| W1 | | | |
| W2 | | | |
| W3 | | | |
| W4 | | | |
| W5 | | | |
