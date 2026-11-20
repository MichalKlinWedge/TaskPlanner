# Wydajność na 10 000 zadań (Etap 13, SPECYFIKACJA §9)

Pomiar 19.11.2026 na webie (build produkcyjny, lokalny Supabase); telefon 20.11.2026 — sekcja [Telefon](#telefon-20112026) na końcu.

## Jak powtórzyć

```bash
npm run supabase -- start
npm run seed:dev -- --tasks 10000 --load --email perf@taskplanner.test --out out/perf.json
npm run perf          # tools/e2e/perf/perf.spec.ts; serwer --prod na porcie 3020 (E2E_PORT), jak w test:e2e
```

- Konto `perf@taskplanner.test` jest osobne. Nie jest to `dev@…` ani `e2e@…`.
  - `seed:dev` z `--email` ustawia mu losowe hasło kluczem `service_role`.
  - Id wierszy są solone adresem (`idSalt`), żeby nie zderzały się z danymi dev.
- `perf-setup.ts` przerywa pomiar, gdy konto ma na serwerze mniej niż 10 000 zadań.
- Wyniki trafiają do `tools/e2e/out/perf.json` (ignorowany przez git) i do tabeli w logu.

### Zestaw danych

`generateDataset`, `seed 1`, „dziś” = dzień pomiaru:

- 5 przestrzeni, 40 list, 12 tagów
- 10 015 zadań:
  - 2 954 ukończone (`completed_at` rozłożone na 30 dni wstecz)
  - 2 060 podzadań
  - 15 nawyków
- 941 wpisów nawyków

Na serwer trafiło 25 436 operacji `push_changes`, bez odrzuceń.

### Środowisko

- Intel Core Ultra 7 165H, 64 GB RAM, Windows 11
- Chromium z Playwright 1.65.1
- Okno 1400×900, strefa Europe/Warsaw

### Metoda

- **Czas w stronie**: `performance.now()` od akcji (zmiana `location.hash`, klik, klawisz) do chwili, gdy w DOM jest to, czego szukamy (nagłówek `h1` widoku i jego wiersze, opcje palety, podgląd szybkiego dodawania), plus jedna klatka (rAF + `setTimeout`), czyli do narysowania.
- Każde przejście między widokami startuje z lekkiego widoku (Inbox, a dla samego Inboxu z „Dziś”). Do wyniku nie wlicza się więc zdejmowanie poprzedniego, ciężkiego widoku.
- Liczba prób:
  - Widoki: 5 rund. Podawana jest mediana i maksimum.
  - Start: 5 przeładowań.
  - Ukończenie i „Cofnij”: 5 razy, na zadaniu bez podzadań.
  - Paleta: 5 rund wpisywania znak po znaku.
- Przeciąganie liczy klatki z `requestAnimationFrame`:
  - Ruch jest powolny: 60 kroków tam i 60 z powrotem.
  - kl./s = liczba klatek ÷ czas.
  - Klatka „zgubiona” to klatka dłuższa niż 25 ms.

## Wyniki

Progi §9 dotyczą „Dziś” i listy projektu (< 100 ms z lokalnej bazy), parsera (< 5 ms) i przeciągania (60 kl./s przy 2 000 zadań). Pozostałe wiersze to pomiary bez progu.

| Pomiar | Przed | Po | Próg |
|---|---|---|---|
| „Dziś” (przełączenie widoku) | 506 ms | **54 ms** (max 67) | < 100 ms ✔ |
| Lista projektu („Raporty kwartalne”, 176 otwartych) | 101 ms | **58 ms** (max 75) | < 100 ms ✔ |
| Parser szybkiego dodawania | — | < 5 ms na wpis (test korpusu w `core`) | < 5 ms ✔ |
| Szybkie dodawanie: znak → podgląd na ekranie | — | 14 ms (max 17) | |
| Przeciąganie karty na tablicy | — | 54 kl./s, p95 klatki 16,8 ms, 1/126 zgubiona | 60 kl./s — patrz odstępstwa |
| Przeciąganie bloku w kalendarzu | — | 58 kl./s, p95 klatki 16,7 ms, 1/133 zgubiona | 60 kl./s — patrz odstępstwa |
| Start: przeładowanie → „Dziś” z zadaniami | 12,6 s | **1,17 s** (max 1,56) | |
| Pierwsza synchronizacja (pusta baza → „Zsynchronizowano”) | 21,6 s | 13,9 s | |
| „Nadchodzące” | 1 367 ms | 237 ms | |
| Inbox | 72 ms | 28 ms | |
| Tablica | 61 ms | 67 ms | |
| Kalendarz (tydzień) | 282 ms | 344 ms | |
| Oś czasu (pierwsze otwarcie; potem widok zostaje zamontowany) | 1 150 ms | 918 ms | |
| Ukończenie zadania → widok | — | 447 ms | |
| „Cofnij” → widok | — | 422 ms | |
| Paleta: otwarcie (Ctrl+K) | — | 61 ms | |
| Paleta: znak → wyniki | — | 15 ms (max 263 — pierwszy znak buduje indeks) | |

Przy wyniku „przed” pierwsze pomiary widoków szły jeszcze z poprzedniego widoku, a nie z Inboxu. Same liczby różnią się więc też metodą. Rzędu wielkości to nie zmienia: „Dziś” miało 258 ms już po samych indeksach, przy tej samej metodzie co „przed”.

## Poprawki

### 1. Indeksy lokalne

Plik: `packages/sync/src/specs.ts`, funkcja `localSchema`.

Dodane indeksy:
- `tasks (parent_id)`
- `task_id` w tabelach: `task_tags`, `reminders`, `attachments`, `time_entries` i `task_completions`

Przyczyna:
- Zapytanie zadań w `apps/web/src/lib/app-data.ts` dla każdego zadania zbiera tagi podzapytaniem.
- Bez indeksu każde z 10 000 zadań przeglądało całe `task_tags`.
- Start trwał przez to 12,6 s, z czego synchronizacja zajmowała 0,3 s. Resztę czasu wątek strony czekał na worker.

Indeksy powstają przez `create index if not exists`, więc istniejące bazy dostają je przy następnym otwarciu.

Efekt:
- start 12,6 s → 1,06 s
- pierwsza synchronizacja 21,6 s → 10,9 s
- „Dziś” 506 → 258 ms

### 2. Mniejszy odczyt `field_clock`

Plik: `app-data.ts`.

- Widoki potrzebują z zegarów pól tylko `status` (`statusChangedAt`).
- Zapytanie zwraca teraz `json_object('status', …)` zamiast całego JSON-a.
- Cały JSON przy 10 000 zadań to ok. 5 MB przy każdym odczycie, przesyłanych przez `postMessage` z workera.

### 3. `core/views.ts`: `completedToday`

- Rozpoznanie „ukończone dziś” wołało `localDateAt` (Intl) dla każdego ukończonego zadania. W przeglądarce dawało to 46 ms na każde przeliczenie „Dziś”.
- Teraz najpierw działa tani filtr tekstowy: data UTC w oknie dziś ± 2 dni.
- Strefę liczy się tylko dla kandydatów.

### 4. `core/tasks.ts`: `toViewTask`

- Funkcja nie woła już `safeParse` Zod dla pustych `recurrence` i `habit`.
- Przeliczenie 10 000 wierszy: 40 → 24 ms.
- W samym core `selectToday` spadło z 16 do 2–3 ms.

### 5. Stronicowanie list

Plik: `apps/web/src/components/app/views.tsx`, komponent `Paged`.

- Sekcje „Dziś”, Inbox i dni oraz tygodnie „Nadchodzących” rysują po 50 wierszy, a przycisk „Pokaż więcej (N)” dokłada kolejne 200.
- React nie rysuje już tysięcy wierszy naraz.
- „Nadchodzące” spadło z 1 367 do 237 ms.
- Tablica była stronicowana już w MVP-2 (40 kart na kolumnę).

### 6. Generator (`tools/seed-dev`)

- Nowe opcje: `--tasks N` i `--email`.
- Głębokość podzadań liczona jest mapą, a nie O(n²). Dla domyślnego `seed 1` strumień losowania jest ten sam: md5 wyniku bez nowych pól jest bez zmian.
- Ukończone zadania dostają realistyczne `completed_at` (do 30 dni wstecz) zamiast „teraz”. Dzięki temu „ukończone dziś” nie obejmuje wszystkich 3 000 ukończonych.

## Odstępstwa i uwagi

### Przeciąganie

Próg §9 to 60 kl./s przy 2 000 zadań. Pomiar szedł na 10 000 zadań, czyli trudniej.

- Klatki w trakcie ruchu mieszczą się w 16,7 ms: p95 to 16,8 ms na tablicy i 16,7 ms w kalendarzu.
- Średnią obniża jedna długa klatka na początku przeciągania. Wynosi ona 267 ms na tablicy i 83 ms w kalendarzu.
- Uznane za spełnione z uwagą: sam ruch idzie w 60 kl./s; zostaje jedna dłuższa klatka przy chwyceniu karty (na tablicy 267 ms — zauważalne, do poprawy, jeśli będzie przeszkadzać).

### Ukończenie i „Cofnij” (ok. 0,4–0,45 s)

Każda zmiana w `tasks` uruchamia ponownie zapytanie wszystkich zadań i przelicza wszystkie `ViewTask`. Według profilu składa się na to:

- odczyt SQL w workerze
- deserializacja wiadomości (ok. 30 ms)
- `toViewTask` (ok. 25 ms)
- przeliczenie widoku
- odśmiecanie pamięci

§9 nie stawia tu progu, a toast „Cofnij” pojawia się razem ze zmianą. Kolejny krok, jeśli będzie potrzebny, to przyrostowe odświeżanie, czyli odczyt tylko zmienionych wierszy z `watch` i ponowne użycie poprzednich `ViewTask`. To zmiana `useLocalQuery`, `connectTabs` i `app-data.ts`.

### Kalendarz, oś czasu, pierwsza synchronizacja

Nie mają progu w §9.

- **Kalendarz (344 ms)**: większość czasu to montowanie FullCalendar.
- **Oś czasu (918 ms)**: przy pierwszym otwarciu SVAR Gantt rysuje wszystkie zadania z datami. Widok zostaje zamontowany, więc kolejne wejścia go nie liczą (Etap 6).
- **Pierwsza synchronizacja (13,9 s)**: to głównie zapisy stron `pull_changes` do SQLite WASM. Zapis porcjami (`upsertMany`) przyszedł z MVP-3; przed indeksami dochodziły do tego przeliczenia widoków po każdej stronie.

### Start webu

1,17 s od przeładowania do „Dziś” z zadaniami (otwarcie SQLite WASM z OPFS, lokalne zapytania, synchronizacja w tle). §9 stawia próg 2 s tylko dla zimnego startu telefonu.

## Telefon (20.11.2026)

Galaxy S22 Ultra (Android 16), release APK (`arm64-v8a`, Hermes), lokalny Supabase przez `adb reverse`, konto `perf@taskplanner.test` z tym samym zestawem 10 015 zadań. Punkt odniesienia: konto `dev@…` z 2 025 zadaniami.

### Jak powtórzyć

- W aplikacji: Przeglądaj → Narzędzia PoC → „Pomiary czasu” (kv `perf.log`; w buildzie dev zawsze włączone). Wyniki idą do logcat: `adb logcat -s ReactNativeJS:I | grep '\[perf\]'`.
- `lib/perf.ts`: `perfStart` przy akcji (dotknięcie zakładki — `tabPress` w `(tabs)/_layout.tsx`, wiersza w „Przeglądaj”, „Ukończ”, „Cofnij”), `usePerfReady` / `perfEnd` na ekranie docelowym po wczytaniu danych, koniec po klatce (rAF + `setTimeout`), jak na webie. `perfMeasure` mierzy obliczenie (`kalendarz: pozycje`, `kalendarz: agenda`), `perfLog` — odczyt danych (`dane widoków`) i synchronizację (`pull`).
- **Zimny start**: `am force-stop`, `am start -W`, czas od wpisu `ActivityManager: Start proc …` do `[perf] start: Dziś` (oba w logcat z zegara telefonu).
- Dotknięcia przez `adb shell input` — skrypt przed każdym stuknięciem sprawdza, czy na wierzchu jest Task Planner (`dumpsys window` → `mCurrentFocus`), i przerywa, jeśli nie (ślepe stuknięcie po utracie połączenia trafiło raz w inną aplikację).

### Wyniki

| Pomiar | Przed | Po | Próg |
|---|---|---|---|
| Zimny start → „Dziś” z zadaniami (10 015) | 1,59 s | **1,10 s** (1,04–1,14) | < 2 s ✔ |
| Zimny start (dev@, 2 025 zadań) | 0,90–0,96 s | — | |
| Pierwsza synchronizacja (25 441 wierszy, 26 stron) | 12,6 s (pobieranie 6,8 s, zapis 6,3 s) | — | |
| Odczyt danych widoków (`loadAppData`) | 0,88 s przy starcie (3 odczyty naraz), 0,52 s po zmianie | **0,39 s** przy starcie, 0,41–0,46 s po zmianie | |
| Ukończenie zadania → widok | 0,96 s | **0,66 s** | |
| „Cofnij” → widok | 0,97 s | **0,67 s** | |
| Zakładka „Dziś” (już otwarta) | 179 ms ¹ | **103 ms** (max 116) | < 100 ms — patrz uwagi |
| Zakładki Inbox / Nadchodzące / Przeglądaj | 121 / 100 / 90 ms ¹ | 105 / 115 / 91 ms | |
| Pierwsze wejście w zakładkę (montowanie) | 200–312 ms | 99–231 ms | |
| Lista projektu („Raporty kwartalne”, 176 otwartych) | 190 ms (172–276) | 180–260 ms | < 100 ms — patrz uwagi |
| Kalendarz, miesiąc (2 964 pozycji w 6 tygodniach) | 5–10 s | **0,94 s** (940–943 ms) | |
| Kalendarz, tydzień / dzień | — | 0,30 s / 0,19 s | |

¹ Pierwsza wersja pomiaru (`useIsFocused`) sama przerysowywała ekran przy wejściu — stąd część różnicy.

### Poprawki

1. **Jeden odczyt danych przy starcie** (`apps/mobile/src/lib/app-data.ts` `sharedAppData`, `lib/headless.ts` `headlessData`). Przypomnienia i widżet czytały całą bazę równolegle z ekranami — trzy odczyty 10 000 zadań naraz (0,35 / 0,76 / 0,48 s). Teraz w procesie z ekranami biorą wynik magazynu; w tle (zadanie z `index.ts`, timery JS stoją) dalej czytają same. Start 1,59 → 1,10 s.
2. **Z `field_clock` tylko `status`** (`TASK_COLUMNS`, jak na webie): `json_object('status', json_extract(…))` zamiast całego JSON-a każdego zadania. Zapytania 0,35 → 0,30 s.
3. **Powrót własnej zmiany nie odświeża widoków** (`packages/sync` `rowChanged` w `merge.ts`, użyte w `pullPage`). Po każdym zapisie Realtime przynosi ten sam wiersz z nową `row_version`, `updated_at` i `completed_at` w zapisie `+00:00` zamiast `Z` — silnik zgłaszał zmianę i widoki czytały wszystko drugi raz (na telefonie ~0,5 s pracy po każdym dotknięciu, na webie tak samo). Teraz słuchacze dostają tabelę tylko, gdy coś poza `row_version`/`updated_at` naprawdę się zmieniło (JSON porównywany bez kolejności kluczy, `timestamptz` jako chwila). Test integracyjny „powrót własnej zmiany z serwera nie budzi słuchaczy”.
4. **Lista: 12 wierszy na start** (`TaskSections`, było 20 — ekran mieści ~10). Pierwsze narysowanie listy ~30 ms szybciej.
5. **Kalendarz** (`apps/mobile/src/app/calendar.tsx`, `packages/core` `format.ts`):
   - `EntryRow` szukał zadania przez `data.tasks.find` — dla każdego wiersza przegląd 10 000 zadań; teraz mapa po id.
   - Lista dnia w miesiącu (30) i dni tygodnia (po 10) stronicowane „Pokaż więcej (N)” — dzień ma tu ~100 pozycji, tydzień ~750.
   - `compareText` / `compareCode` w `core/format.ts` zamiast `localeCompare`: w Hermes na Androidzie `localeCompare(…, 'pl')` tworzy kolator przy każdym wywołaniu, a sortowanie agendy (`agendaDays`) i bloków (`blocksForDay`) porównywało napisy dziesiątki tysięcy razy. W Node te same obliczenia dla miesiąca trwają ~100 ms. Na telefonie miesiąc 5–10 s → 0,94 s (wejście z „Przeglądaj” do narysowania, perf@, 3 pomiary na tryb).

### Uwagi

- **Próg 100 ms dla „Dziś” i listy projektu** dotyczy danych z lokalnej bazy. Same dane i obliczenia mieszczą się w nim z zapasem (lista projektu: render ekranu zaczyna się ~32 ms po dotknięciu, obliczenia < 10 ms); resztę czasu zajmuje React Native: przejście nawigacji, pierwsze narysowanie wierszy (~60–90 ms) i zamontowanie widoków natywnych. Przełączenie najprostszej zakładki („Przeglądaj”, bez listy zadań) trwa tak samo ~90 ms, więc „Dziś” (103 ms) jest praktycznie na poziomie samej nawigacji.
- **Ukończenie i „Cofnij” (0,66 s)** to dalej pełny odczyt 10 015 zadań po każdej zmianie (0,41–0,46 s) + przeliczenie widoku. Następny krok to przyrostowe odświeżanie (tylko zmienione wiersze) — jak na webie.
- **Pierwsza synchronizacja (12,6 s)** — pobieranie i zapis po połowie; widoki odświeżają się raz, po ostatniej stronie.
- **Niezmierzone**: przeciąganie bloku na osi dnia (kl./s; `dumpsys gfxinfo`), wydajność przy 2 000 zadań poza startem.
