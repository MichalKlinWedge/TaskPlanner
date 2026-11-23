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

### Ukończenie i „Cofnij” — przyrostowe odświeżanie (20.11.2026)

Do 20.11.2026 każda zmiana w `tasks` czytała ponownie wszystkie zadania i liczyła od nowa wszystkie `ViewTask` (odczyt SQL w workerze, deserializacja wiadomości ~30 ms, `toViewTask` ~25 ms, przeliczenie widoku, odśmiecanie) — 0,42–0,45 s.

Teraz:

- `SyncEngine.watch` (i `TabStore.watch` między kartami) podaje id zmienionych wierszy (`packages/sync/src/changes.ts`; `null` — nieznane albo > 1 000).
- `createTaskCache` (`packages/sync/src/task-cache.ts`) czyta raz wszystko, potem tylko zmienione zadania i ich tagi (> 400 zmienionych — znów całość). Niezmienione wpisy zostają tymi samymi obiektami.
- Web i telefon trzymają gotowe `ViewTask` w `WeakMap` przy wpisie — liczone są tylko zmienione.
- Web: zapytanie wykonań nawyków jako `join` (było `in (select … from tasks)` — ~0,35 s przy 10 000 zadań, po każdej zmianie zadań i przy starcie przed „Dziś”).

Pomiar `npm run perf` (ten sam komputer i dzień, build produkcyjny):

| Pomiar | `main` przed zmianą | Po |
|---|---|---|
| Ukończenie zadania → widok | 300 ms (max 330) | **78 ms** (max 101) |
| „Cofnij” → widok | 268 ms (max 310) | **77 ms** (max 79) |
| Start: przeładowanie → „Dziś” | 876 ms (max 989) | 973 ms (max 1 003) |
| „Dziś” / lista projektu / tablica | — | 38 / 32 / 42 ms |

Start: pierwsza wersja bufora miała 1,23–1,36 s — pełny odczyt zadań stawał w kolejce bazy za zapytaniami nawyków i załączników; teraz idzie pierwszy. Różnica ~0,1 s wobec `main` to jeden pomiar na stronę (19.11.2026 `main` miał 1,17 s). Wyniki z 19.11.2026 (447 / 422 ms) były mierzone na innym obciążeniu komputera — porównuj kolumny tej tabeli.

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
- **Przeciąganie bloku na osi dnia**: `dumpsys gfxinfo pl.taskplanner.app reset`, potem w jednym `adb shell`: `input motionevent DOWN`, 0,6 s (przytrzymanie, gest startuje po 300 ms), 40 ruchów co 8 px w dół, `dumpsys gfxinfo` (tylko klatki ruchu), powrót na miejsce i `UP` — blok wraca na swoją godzinę, dane się nie zmieniają. Z upuszczeniem: `input draganddrop … 1500` i „Cofnij”. Ekran 120 Hz (budżet klatki 8,3 ms). Wstrzykiwany dotyk nie podkręca procesora jak prawdziwy palec (framestats: obsługa wejścia ~7 ms + GPU ~10 ms na klatkę), więc porównanie przed/po robione palcem: `gfxinfo reset`, ~5 s przesuwania bloku w górę i w dół bez przewijania osi, puszczenie na tej samej godzinie, `gfxinfo`.

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
| Przeciąganie bloku na osi dnia, palcem (perf@, dzień z 22 blokami) | 18 z 19 klatek spóźnionych, p50 12 ms, p95 16 ms, 12× `Slow UI thread` | **2 z 35**, p50 9 ms, p95 13 ms, 0× `Slow UI thread` (poprawka 6) | 60 kl./s |
| To samo przez `adb` (wstrzykiwany dotyk) | p50 17 ms, p95 22–27 ms (3 pomiary) | p50 17 ms, p95 21–26 ms (3 pomiary) | |
| Przeciąganie z upuszczeniem i zapisem (`adb`) | 22 klatki, p50 18 ms, p95 28 ms, p99 42 ms | — | |

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

6. **Przeciąganie bloku na osi dnia** (`apps/mobile/src/components/day-timeline.tsx`): przesunięcie idzie przez `shift` → `transform: translateY` (bez przeliczania układu; `top` stoi do zapisu), a godzinę na żywo rysuje osobny `BlockText` z `useAnimatedReaction`. Wcześniej `setLive` przy każdym przeskoku o 15 min renderował cały blok z gestami — nowe domknięcia workletów i przeliczenie `top` dawały spóźnioną klatkę prawie przy każdym przeskoku (palcem 18/19 → 2/35).
### Uwagi

- **Próg 100 ms dla „Dziś” i listy projektu** dotyczy danych z lokalnej bazy. Same dane i obliczenia mieszczą się w nim z zapasem (lista projektu: render ekranu zaczyna się ~32 ms po dotknięciu, obliczenia < 10 ms); resztę czasu zajmuje React Native: przejście nawigacji, pierwsze narysowanie wierszy (~60–90 ms) i zamontowanie widoków natywnych. Przełączenie najprostszej zakładki („Przeglądaj”, bez listy zadań) trwa tak samo ~90 ms, więc „Dziś” (103 ms) jest praktycznie na poziomie samej nawigacji.
- **Lżejsze otwarcie listy (20.11.2026, na urządzeniu jeszcze niezmierzone)**: wiersz zadania rysuje się najpierw bez gestu przesunięcia (`Swipeable` dochodzi w pierwszej wolnej chwili wątku JS — `RowsInteractive` w `task-row.tsx`, przełączany przez `TaskSections`), metadane to jeden `Text` z jednym zagnieżdżonym zamiast jednego na pozycję, a pierwsza porcja to 8 wierszy (było 12).
- **Ukończenie i „Cofnij” (0,66 s)** to był pełny odczyt 10 015 zadań po każdej zmianie (0,41–0,46 s) + przeliczenie widoku. Od 20.11.2026 zadania odświeżają się przyrostowo (`createTaskCache`, jak na webie — sekcja wyżej); **na urządzeniu jeszcze niezmierzone** (wymaga nowego APK).
- **Pierwsza synchronizacja (12,6 s)** — pobieranie i zapis po połowie; widoki odświeżają się raz, po ostatniej stronie.
- **Przeciąganie bloku na osi dnia** rysuje klatkę tylko przy przeskoku o 15 min, więc „kl./s” nic tu nie mówi — liczy się, czy klatka przeskoku zdąży w 8,3 ms (120 Hz). Po poprawce 6 palcem zdąża 33 z 35. Pomiar przez `adb` tego nie pokazuje: wstrzykiwane zdarzenia przychodzą rzadko i bez podbicia zegara procesora, więc każda klatka trwa ~17 ms niezależnie od kodu. Zmiana długości (uchwyt) dalej animuje `height` — rzadsza, niemierzona.
- **Niezmierzone**: wydajność przy 2 000 zadań poza startem.


## Karteczki — 500 kart (23.11.2026)

Widok „Karteczki” (v1.x, tylko web) na jednej liście z 500 ułożonymi kartami (25 kolumn × 20 wierszy, tytuły 1–14 słów, 4 priorytety, 5 kolorowych tagów, co trzecia z osobą odpowiedzialną). Konto `canvas-perf@taskplanner.test` zakładane od zera przez `tools/e2e/src/canvas-perf-setup.ts`; ten sam build produkcyjny co E2E, Chromium 1400×900, ten sam komputer co pomiary wyżej.

```bash
npm run perf:canvas          # wynik: tabela w konsoli i tools/e2e/out/perf-canvas.json
```

| Pomiar | Mediana | Max | Uwagi |
|---|---|---|---|
| Pierwsze otwarcie (pusta baza → 500 kart) | 1 235 ms | — | synchronizacja + pierwsze dopasowanie tytułów |
| Widok: Inbox → „Karteczki” | 74 ms | 92 ms | dopasowanie tytułów z pamięci podręcznej |
| Przeciąganie karty | 60 kl./s | — | p95 16,7 ms, najgorsza 17 ms, 0 zgubionych |
| Przesuwanie tablicy | 53 kl./s | — | p95 16,8 ms; jedna klatka ~200 ms na starcie ruchu |
| Powiększanie Ctrl+kółko | 59 kl./s | — | p95 16,8 ms, najgorsza 33 ms |
| „Dopasuj” (100 % → 25 %) | 37 ms | 41 ms | |
| Upuszczenie na zajętą komórkę → karta w wolnej | 124 ms | 127 ms | od puszczenia do narysowania (zapis lokalny, odczyt, układ) |

Uwagi:
- Karty nie są wirtualizowane — 500 kart to 500 elementów pod jednym `transform: scale`; przy 25 % tytuły są już tylko kolorami (poniżej 50 % bez tekstu), więc koszt nie rośnie z oddaleniem.
- Pierwsza klatka przesuwania (~200 ms) to przerysowanie wszystkich kart po zmianie stanu przeciągania; dalsze klatki mieszczą się w 16,7 ms. Do poprawy (`memo` kart), jeśli będzie przeszkadzać.
- Szczypanie dwoma palcami nie jest mierzone (brak urządzenia dotykowego w Playwright bez emulacji) — liczy to samo co Ctrl+kółko (`zoomCanvasViewport`).
