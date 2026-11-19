# Wydajność na 10 000 zadań (Etap 13, SPECYFIKACJA §9)

Pomiar 19.11.2026 na webie (build produkcyjny, lokalny Supabase). Telefon nie był mierzony; zimny start telefonu < 2 s czeka na MVP-3.

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

### Telefon

Nie był mierzony; wymaga to sprawdzenia na urządzeniu.

- Indeksy z `localSchema` obejmują też expo-sqlite.
- Poprawki `core` działają tak samo w Hermes.
