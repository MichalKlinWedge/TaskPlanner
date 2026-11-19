# Wyniki PoC

## PoC-4 — Android: przypomnienia, widżet, udostępnianie, kalendarz (18.11.2026)

**Werdykt (19.11.2026): GO** — wszystkie biblioteki zostają (`expo-notifications`, `react-native-android-widget`, `expo-share-intent`, `expo-calendar`), przypomnienia **tylko z dokładnymi alarmami** (`USE_EXACT_ALARM`). Telefon: Galaxy S22 Ultra, Android 16, One UI; dev build z Metro i release. Scenariusze: `docs/POC4_TELEFON.md` (S1–S9).

**Bez 3-dobowego pomiaru (decyzja użytkownika: „nie mam czasu na takie długie testy, jedzmy dalej”).** Dokładność przypomnień oparta na tym, że system przyjął wszystkie 50 alarmów jako dokładne (`window=0`, `setExactAndAllowWhileIdle`) — nie na zmierzonym ≥ 95 % ±1 min w Doze. Seria S4 (do 22.11 08:39) zostaje na telefonie; jej raport, jeśli powstanie, dopisać tutaj. Do sprawdzenia przy okazji w MVP-3: tytuł strony z prawdziwego Chrome (S7) i płynność przeciągania palcem (S8 vs S9 — wybór widoku dnia odłożony do MVP-3; domyślnie własna oś, bo calendar-kit nie przesunął bloku gestem).

| Kryterium | Wynik | Jak sprawdzone |
|---|---|---|
| Biblioteki na SDK 58 / New Architecture | ✅ `expo-doctor` 20/20; bundel Hermes (`expo export --platform android`, 2 039 modułów) | lokalnie |
| PoC-1 na telefonie: SQLite + silnik (outbox, odrzucenie, scalanie per pole, UUIDv5, 500 zapisów < 10 s) | ✅ `node:sqlite` i ✅ expo-sqlite na telefonie: 9/9; 500 zapisów offline **5,6 s** w release (11,1 ms/zapis; dev build 9,8 s), wysłanie 500 op. 0,30 s (dev 0,94 s) | `src/selftest/local-sync.ts`, S1 |
| PoC-1/2/3 w Hermes (id, HLC, cykliczność 15 + 1 000 wystąpień < 20 ms, nawyki 5, korpus szybkiego dodawania 100 %) | ✅ **45/45** (Hermes 260318099.0.5): id/HLC 6/6, cykliczność 15/15 + 1 000 wystąpień **7,7–15 ms** (dev / release, rozrzut między przebiegami), nawyki 5/5, korpus 99/99, pułapki 0/17, **0,09 ms/wpis**; release 45/45; Intl po polsku, polyfille | ekran „Samosprawdzenie” (S1) |
| Przypomnienia ≥ 95 % ±1 min z dokładnymi alarmami / ≤ 10 min bez nich (50 na 72 h, noc w Doze) | ⏳ S3, S4 (3 doby). Szybki test bez dokładnych alarmów (3 w 6 min, ekran wygaszony): opóźnienia **+90 s, +180 s, +60 s** (2. i 3. zgrupowane w jednym wybudzeniu), ±1 min 1/3. `dumpsys alarm`: `setAndAllowWhileIdle` dostaje okno ≈ 75 % czasu do terminu (+2 min → okno 1 min 30 s, +10 min → 7 min 30 s). Doze przez adb na One UI nie do wymuszenia (`force-idle` zostaje w INACTIVE) — tylko noc. **Bez dokładnych alarmów: NO-GO** (okno rośnie z wyprzedzeniem) → decyzja: `USE_EXACT_ALARM` w `app.json` (APK poza Google Play, przyznane przy instalacji); 3-dobowy pomiar tylko z dokładnymi alarmami (S4). **S4 wystartował 19.11 08:37** (release z `USE_EXACT_ALARM`): 50 alarmów `window=0 exactAllowReason=policy_permission`, 19.11 08:39:47 → 22.11 08:39:47 | ekran „Przypomnienia”, `dumpsys alarm` / `notification` |
| „Ukończ” / „Jutro” / „Odłóż 10 min” przy zamkniętej aplikacji, bez sieci → SQLite + outbox | ✅ dev build, aplikacja usunięta z ostatnich (brak procesu), tryb samolotowy: „Ukończ” → `done`, „Jutro” → termin +1 dzień, „Odłóż 10 min” → nowy alarm; 3/3 `[background-task] OK`, powiadomienie znika, aplikacja się nie otwiera, outbox +8. Czas od stuknięcia do zapisu 7–15 s (start procesu + bundel z Metro) — ⏳ zmierzyć w release | dziennik akcji, baza z telefonu |
| Widżet „Dziś” z odhaczaniem przy zamkniętej aplikacji, bez sieci | ✅ dev build, aplikacja zatrzymana (`am force-stop`), tryb samolotowy: klik → `WIDGET_CLICK` → Headless JS → zapis + przerysowanie ≈ 2 s (obsługa w JS 274 ms); cykliczny „Trening” → `task_completions` (UUIDv5) i termin na jutro; outbox rośnie. Pierwszy klik tuż po `force-stop` zgubiony (launcher przebudowywał widżet) — ⏳ powtórzyć w release po usunięciu z ostatnich, restart telefonu | dziennik widżetu, baza z telefonu (`run-as`) |
| Link z Chrome → szybkie dodawanie | ✅ intencja `SEND text/plain` (jak z Chrome) przy zamkniętej aplikacji → „Szybkie dodawanie” z linkiem; „jutro o 20 !2” → termin, godzina, priorytet, `source.kind = link`. Tytuł strony nie dochodzi: `expo-share-intent` czyta `EXTRA_TITLE`, a nie `EXTRA_SUBJECT`. ⏳ prawdziwy Chrome | `adb shell am start -a android.intent.action.SEND` |
| Kalendarz telefonu + calendar-kit (przeciąganie, zmiana długości) | ⚠️ wydarzenia z 18 kalendarzy widoczne obok zadań, 81 wydarzeń z 8 dni (pierwszy pomiar 16,2 s obejmował okno zgody — poprawione). calendar-kit: przytrzymanie zaznacza blok (uchwyty), przeciągnięcie syntetycznym gestem przewija widok zamiast przesuwać blok. Własna oś (S9): przytrzymanie i przesunięcie → „Zapisano 09:45” w 46 ms. ⏳ płynność palcem, release | `adb shell input motionevent` |

**Co powstało (`apps/mobile`):**
- Wejście `index.ts`: polyfille → rejestracja zadań w tle (`src/background/register.ts`: `TaskManager.defineTask` dla odpowiedzi na powiadomienia, `registerWidgetTaskHandler`) → `expo-router/entry`. Zadania w tle muszą być zarejestrowane przed routerem, bo Headless JS startuje bez ekranu.
- `src/lib/sync.ts`: jeden `SyncEngine` (expo-sqlite, `autoSync: false`, ręczne `requestSync` po zapisie, gdy jest konto) — wspólny dla ekranów, widżetu i akcji z powiadomień. Bez konta zapis lokalny w zakresie `OFFLINE_USER_ID`.
- `src/lib/tasks.ts`: operacje na zadaniach przez `mutate` (ukończenie cyklicznego = wiersz `task_completions` z UUIDv5 + `nextDue`, „jutro”, przesunięcie bloku), szybkie dodawanie z linkiem (`source.kind = 'link'`).
- `src/lib/reminders.ts`: kanał HIGH, kategoria z 3 akcjami `opensAppToForeground: false`, seria N przypomnień z pomiarem (czas pokazania = `postTime` z `getPresentedNotificationsAsync`), raport; obsługa akcji idempotentna (ta sama odpowiedź może przyjść z zadania w tle i z listenera).
- `src/widget/*`: widżet „Today” (`react-native-android-widget`, jasny/ciemny), klik → przełączenie zadania w lokalnej bazie i przerysowanie.
- Ekrany: menu ze stanem outboxa, „Dziś i widżet”, „Przypomnienia”, „Szybkie dodawanie” (share intent), „Kalendarz” (calendar-kit + `expo-calendar`), „Oś dnia (własna)” (Gesture Handler 3), „Samosprawdzenie”, „Serwer i konto”.
- Metro: korpus `fixtures/quick-add.jsonl` importowany jako moduł (`metro/jsonl-transformer.js`).

**Ustalenia techniczne:**
- expo-notifications: akcja inna niż domyślna przy aplikacji poza pierwszym planem uruchamia zadanie `registerTaskAsync` (Headless JS); przy żywym procesie przychodzi też listener — stąd obsługa idempotentna (`poc4.handled`).
- Dokładne alarmy: bez `SCHEDULE_EXACT_ALARM` biblioteka używa `setAndAllowWhileIdle` (okno systemowe), z pozwoleniem — `setExactAndAllowWhileIdle`; typ wyzwalacza `alarmClock` → `setAlarmClock`. Na Androidzie 14+ pozwolenie domyślnie odebrane — użytkownik włącza je w „Alarmy i przypomnienia”.
- Pliki widżetu muszą mieć `'use no memo'` (React Compiler psuje drzewo widżetu, które nie jest renderowane przez React Native).
- calendar-kit: `hourFormat` jest propem `CalendarBody`, nie `CalendarContainer`.

**Dokładne alarmy — decyzja: `USE_EXACT_ALARM`.** Bez pozwolenia Android planuje przypomnienie przez `setAndAllowWhileIdle` z oknem ≈ 75 % czasu do terminu (zmierzone: +2 min → okno 1,5 min, +10 min → 7,5 min; górnej granicy okna dla terminów za wiele godzin nie zmierzono), więc „przypomnienie o 9:00” może przyjść dużo później. `SCHEDULE_EXACT_ALARM` na Androidzie 14+ jest domyślnie odebrane i wymaga ręcznego włączenia w ustawieniach. `USE_EXACT_ALARM` (API 33+) system przyznaje przy instalacji; w Google Play wolno go używać tylko aplikacjom budzika/kalendarza — dystrybuujemy APK poza Play, więc ograniczenie nas nie dotyczy (przy ewentualnej publikacji w Play wrócić do `SCHEDULE_EXACT_ALARM` + prośba w aplikacji). `SCHEDULE_EXACT_ALARM` zostaje dla Androida 12–12L.

**Build i aktualizacje — decyzja: bez EAS.** Darmowy limit EAS Build (15 buildów Androida/mies.) wyczerpał się w trakcie PoC-4, więc APK budujemy sami: lokalnie przez USB (`npx expo run:android`) i w GitHub Actions (`.github/workflows/android.yml`: prebuild → `assembleRelease` → podpis kluczem z sekretów → artefakt, opcjonalnie Release). EAS Update (OTA) odpada: **na razie nowy APK zamiast OTA, ewentualnie później własny serwer zgodny z protokołem Expo Updates**. `expo-updates` zostaje w zależnościach (bez `updates.url` nic nie pobiera), skrypt `ota` usunięty. Instrukcja: `docs/ANDROID_BUILD.md`, limity Actions: `docs/USLUGI.md`.

**Build na Windows:** CMake/ninja z katalogu worktree (`…\.claude\worktrees\…`) przekracza 260 znaków; `subst` psuje codegen (Node rozwiązuje prawdziwą ścieżkę). Ninja 1.10 z CMake 3.22.1 nie obsługuje długich ścieżek nawet w kopii `C:\tp` przy `LongPathsEnabled = 1` (ścieżki obiektów codegenu ~275 znaków). Działa CMake 3.31.6 z SDK (ninja 1.12.1): `cmake.dir` w `android/local.properties`. Na runnerze Linux problemu nie ma.

## PoC-3 — Cykliczność i nawyki (18.11.2026)

**Werdykt: GO, własny podzbiór RRULE** (bez rrule.js w produkcie). rrule.js zostaje tylko jako wyrocznia w testach (`devDependencies` `packages/core`).

| Kryterium | Wynik | Jak sprawdzone |
|---|---|---|
| Przypadki z §7.2 (`fixtures/recurrence.json`) | ✅ 15/15 (wystąpienia, COUNT/UNTIL, ukończenie zaległego, „po ukończeniu” z opóźnieniem i przed terminem, 31. i 29 lutego) | Vitest |
| Zgodność z rrule.js | ✅ 500 losowych reguł × 40 wystąpień — te same daty | Vitest |
| Historie nawyków policzone ręcznie (`fixtures/habits.json`) | ✅ 5/5: passa, najdłuższa passa, regularność (dni wolne, weekend przy dniach roboczych, cel 3×/tydzień, cel ilościowy) | Vitest |
| Opis po polsku „tam i z powrotem” przez szybkie dodawanie | ✅ 12 opisów i tekstów wraca do reguły o tych samych datach | Vitest |
| Te same wyniki w Node, przeglądarce i Hermes | ✅ Node, ✅ przeglądarka (20/20, `/dev/recurrence`), ⚠️ Hermes: bundel się kompiluje, wykonanie na telefonie w MVP-3 | |
| 1 000 wystąpień < 20 ms | ✅ **2,65 ms** | Vitest |

**Co powstało:** `packages/core/src/recurrence.ts` (`parseRrule`, `formatRrule`, `occurrences`, `nextOccurrence`, `nextDue`, `describeRecurrence`, schemat `Recurrence`), `habits.ts` (`habitPeriods`, `habitStreak`, `habitRate`, `habitDays`, schemat `HabitSettings`), `fixtures/habits.json`, strona `apps/web/src/app/dev/recurrence`.

**Dlaczego własny, a nie rrule.js:** wynik jest identyczny na obsługiwanym podzbiorze, a własny kod liczy na datach pływających bez obiektów `Date` w strefie (rrule.js trzeba „oszukiwać” UTC), nie ma zależności z 2023 r. i odrzuca reguły spoza podzbioru zamiast liczyć je inaczej niż Google Calendar.

**Ustalenia (dopisać do §7.2 / §7.5 w v0.2):**
- Podzbiór: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY (z pozycją tylko w MONTHLY/YEARLY), BYMONTHDAY (także ujemne), BYMONTH, BYSETPOS, COUNT, UNTIL (data), WKST=MO. Odrzucane: HOURLY i mniejsze, BYHOUR/BYWEEKNO/BYYEARDAY, YEARLY+BYDAY bez BYMONTH, COUNT razem z UNTIL.
- Kotwica, która nie pasuje do reguły, nie jest wystąpieniem (jak rrule.js / dateutil, inaczej niż dosłowne RFC dla DTSTART). Szybkie dodawanie i tak ustawia kotwicę na pierwszym pasującym dniu.
- „Po ukończeniu” co miesiąc z 31. → ostatni dzień krótszego miesiąca (kalendarzowo), a „według harmonogramu” 31. dnia pomija krótsze miesiące (RFC).
- Nawyk z celem „N razy w tygodniu/miesiącu”: okres z dniami wolnymi, w którym zrobione + wolne ≥ N, nie przerywa passy i nie zalicza. Dzień z wartością poniżej celu ilościowego to „częściowo” (mapa cieplna), a w passie — niezaliczony.
- Nowe formy szybkiego dodawania (korpus 99 przypadków, 100 %): „każdego 10. dnia miesiąca”, „15. i ostatniego dnia miesiąca”, „co 3 miesiące, 30. dnia”.

**Niesprawdzone:** wykonanie w Hermes na telefonie — dodać ekran samosprawdzenia (te same przypadki co `/dev/recurrence`) przy pierwszym dev buildzie (PoC-4).

## PoC-2 — Parser szybkiego dodawania (18.11.2026)

**Werdykt: GO.** Gramatyka z SPECYFIKACJA §4 w całości, bez zawężania.

| Kryterium | Wynik |
|---|---|
| ≥ 95 % przypadków korpusu zgodnych w całości | ✅ **100 %** (96 przypadków `fixtures/quick-add.jsonl`) |
| 0 przypadków, w których z tytułu znika słowo (pułapki) | ✅ 0 z 19 pułapek |
| < 5 ms na wpis | ✅ **0,012 ms** (Node) |
| Podświetlanie na żywo i cofanie rozpoznania | ✅ `/dev/quick-add`, sprawdzone w przeglądarce |

**Co powstało:** `packages/core/src/quick-add.ts` (`parseQuickAdd`, `suppressToken`, `normalizeWord`), `dates.ts` (daty pływające: `addDays`, `addMonths`, `isoWeekday`, `lastDayOfMonth`), test korpusu `__tests__/quick-add.test.ts`, strona prób `apps/web/src/app/dev/quick-add`.

**Ustalenia gramatyki (dopisać do §4 w v0.2):**
- Seria z godziną zaczyna się od pierwszego wystąpienia, którego godzina jeszcze nie minęła („Trening codziennie o 7 rano” o 12:00 → jutro). Poprawiony przypadek korpusu, który przeczył przypadkowi „w dni robocze o 9:30”.
- `o N` przed słowem w miejscowniku liczby mnogiej (`-ach`, `-ych`, `-ich`) to nie godzina („Ankieta o 15 pytaniach”).
- Data `D.M` wymaga dwucyfrowego miesiąca albo roku: „5.01” i „2.3.2027” są datami, „wersja 2.3” nie.
- Pełna nazwa dnia tylko z „w/we” albo „w przyszły/przyszłą”; bez przyimka rozpoznawane są tylko skróty (`pon`, `wt`, `śr`, `czw`, `pt`, `sob`, `nd`).
- Dodane formy: „do końca tygodnia/miesiąca”, „na koniec …”, „ostatni piątek miesiąca” (`BYDAY=-1FR`), „co 3 miesiące” (`INTERVAL`), jednoznaczny prefiks nazwy listy (`#remont` → „Remont kuchni”).
- „co miesiąc” bez daty → dzień miesiąca z dzisiejszej daty (`BYMONTHDAY=18`), „co tydzień” bez dnia → dzisiejszy dzień tygodnia.
- Przyimek („w”, „we”, „o”, „na”) i myślnik na końcu albo początku tytułu są usuwane.

**Uwagi:**
- Korpus pisałem sam (przykłady + pułapki), więc 100 % mierzy zgodność z ustaloną gramatyką, a nie trafność na prawdziwych wpisach. Prawdziwy sprawdzian: zadania z obecnego narzędzia użytkownika (D13) dopisane do korpusu przed MVP-2.
- Cofnięcie rozpoznania wstawia `\` w tekst pola (widać to w polu). W MVP-2 cofnięte zakresy trzymać w stanie komponentu, a nie w tekście.
- Chip cyklu pokazuje surowe RRULE — opis po polsku (`describeRecurrence`) to PoC-3.

## PoC-1 — Synchronizacja local-first w obie strony (18.11.2026)

**Werdykt: GO.** Decyzja D2 (web local-first) potwierdzona. Do sprawdzenia na telefonie po pierwszym dev buildzie (MVP-3): `expo-sqlite` w działaniu i synchronizacja w tle.

### Co powstało
| Element | Miejsce |
|---|---|
| Zakresy, tabele (przestrzenie, listy, zadania, tagi, tagi zadań, ukończenia), triggery, RLS, `push_changes`, `pull_changes` | `supabase/migrations/20261118120000_poc1_sync.sql` |
| Testy pgTAP: RLS, LWW per pole, idempotencja, drzewo (4 poziomy, cykle), kaskady usunięcia i przeniesienia, obcinanie zegara, deterministyczne id | `supabase/tests/sync.test.sql` (31 testów) |
| HLC, UUIDv7, UUIDv5 (czysty TS, własne SHA-1) | `packages/core/src/hlc.ts`, `ids.ts` |
| Silnik: `mutate` + outbox w jednej transakcji, push/pull, scalanie per pole, Realtime jako sygnał | `packages/sync/src/engine.ts`, `merge.ts`, `remote.ts`, `specs.ts` |
| Lokalna baza: Node (`node:sqlite`), telefon (`expo-sqlite`), przeglądarka (SQLite WASM + `opfs-sahpool` w workerze) | `packages/sync/src/adapters/*` |
| Kilka kart: lider przez Web Locks, reszta przez BroadcastChannel, przejęcie po zamknięciu lidera | `packages/sync/src/tabs.ts` |
| Strona prób w przeglądarce (tylko dev) | `apps/web/src/app/dev/sync`, `components/sync-lab.tsx` |
| Podłączenie na telefonie (bez ekranów) | `apps/mobile/src/lib/sync.ts`, `polyfills.ts` |

### Kryteria i wyniki
| Kryterium (PLAN_ETAPOWY PoC-1, SPECYFIKACJA §6) | Wynik | Jak sprawdzone |
|---|---|---|
| Różne pola offline na dwóch urządzeniach → obie zmiany | ✅ | `npm run test:sync` |
| To samo pole → wygrywa późniejszy HLC niezależnie od kolejności wysyłki | ✅ (oba warianty kolejności) | `test:sync`, pgTAP |
| Usunięcie kontra późniejsza edycja → usunięte, edycja zachowana na przywrócenie | ✅ | `test:sync`, pgTAP (kaskada i przywrócenie poddrzewa) |
| Przeniesienie w cykl na dwóch urządzeniach → drugie odrzucone, cofnięte do wersji serwera | ✅ `TP002`, wiersz serwera nadpisuje lokalny | `test:sync`, pgTAP |
| Podwójne ukończenie wystąpienia → jeden wiersz | ✅ (UUIDv5) | `test:sync`, pgTAP |
| 500 operacji offline wysłane < 10 s | ✅ **405 ms** (lokalny Supabase) | `test:sync` |
| Zmiana z telefonu na webie < 5 s po włączeniu sieci | ✅ ~0,4 s (push + pull) | `test:sync` |
| Zmiana na drugim urządzeniu online < 3 s (Realtime) | ✅ **469 ms** od wysłania; sygnał zmiany, nie pobranie po `SUBSCRIBED` | `test:sync` (licznik pobrań) |
| Zgubiony sygnał Realtime → nadrobiony | ✅ pobranie po ponownym `SUBSCRIBED` | `test:sync` |
| Zegar urządzenia +1 dzień nie wygrywa z późniejszą edycją | ✅ HLC z przyszłości obcinany do czasu serwera, klient dostaje wiersz serwera | `test:sync`, pgTAP |
| Obcy użytkownik: brak odczytu i zapisu | ✅ RLS + `TP003` (także gdy zmiana i tak przegrałaby LWW) | `test:sync`, pgTAP |
| Dwie karty przeglądarki na jednej bazie | ✅ lider trzyma bazę (OPFS, trwała), druga karta czyta i pisze przez lidera, po zamknięciu lidera przejmuje bazę z tymi samymi danymi | ręcznie w przeglądarce aplikacji (Chromium), `/dev/sync` |
| Bundel telefonu (Hermes) z silnikiem | ✅ `expo export --platform android` | ręcznie |

### Odstępstwa od SPECYFIKACJA §5 (do wpisania w v0.2)
- **Członkostwo per zakres** (`scope_members`) zamiast `workspace_members` — zakres osobisty też potrzebuje członka. Zakres osobisty ma id = id użytkownika i powstaje triggerem przy zakładaniu konta.
- **Brak kolumny `workspace_id`**: dla tabel przestrzeni `scope_id` = id przestrzeni. `scope_id` zadań, tagów zadań i ukończeń jest **wyliczany** (z listy / zadania) i klient go nie wysyła; listę podzadania wylicza się z rodzica.
- `due_time` jako tekst `GG:MM` (jak w EP: `time` w JSON daje `GG:MM:SS`).
- Unikalność nazwy tagu: `lower(name)` bez `unaccent`; tag o tej samej nazwie z dwóch urządzeń daje ten sam id (`tagId` = UUIDv5 z nazwy bez polskich znaków), więc konflikt nie powstaje.
- Kody odrzuceń: `TP001` głębokość, `TP002` cykl, `TP003` brak dostępu, `TP004` zły zakres, `TP005` nieznana tabela/pole, `TP006` zły HLC.

### Wnioski techniczne
- **Turbopack nie bundluje `@sqlite.org/sqlite-wasm`** (dynamiczny `new Worker(new URL(...))` w proxy VFS „opfs”). Rozwiązanie: pliki biblioteki kopiowane do `apps/web/public/sqlite-wasm` (`scripts/copy-sqlite-wasm.mjs`, `predev`/`prebuild`) i ładowane w workerze przez `import(/* turbopackIgnore */)`. `packages/sync` dostaje moduł SQLite z zewnątrz (`startSqliteWorker(load)`).
- **Kolejność w karcie-liderze**: rola i odświeżenie widoków dopiero po utworzeniu silnika — wcześniej UI pokazywało „zwykła” mimo trzymanej blokady.
- **Strict Mode** w dev uruchamia efekty dwa razy: koordynacja kart jest jedna na stronę i użytkownika (zamykana przy wylogowaniu), nie per efekt.
- `push_changes` sprawdza dostęp jawnie, a nie tylko w triggerze — inaczej obca operacja, która przegrałaby LWW, wracała jako „przyjęta bez zmian”.
- Funkcje STABLE w Postgresie widzą migawkę zapytania wywołującego → wersje zakresów i wiersze w `pull_changes` są ze sobą zgodne (ta sama obserwacja co w EP).

### Niesprawdzone / na później
- **Telefon w działaniu** (expo-sqlite, Realtime w tle, `expo-background-task`) — MVP-3 na dev buildzie; PoC-4 i tak wymaga dev buildu.
- **Automatyczny test dwóch kart (Playwright)** — sprawdzone ręcznie; Playwright dochodzi w MVP-2 razem z E2E webu.
- Firefox w trybie prywatnym (brak OPFS → baza w pamięci, ścieżka jest w kodzie, nieprzetestowana), Safari.
- **Kaskady lokalnie**: usunięcie rodzica i przeniesienie listy liczy serwer; lokalnie dzieci znikają / zmieniają przestrzeń dopiero po synchronizacji. Widoki (MVP-2) muszą ukrywać dzieci usuniętego rodzica albo `mutate` powtórzy kaskady lokalnie.
- Stronicowanie pierwszej pełnej migawki (`pull_changes` zwraca wszystko naraz; 2 000 zadań to ~1 MB) — przy MVP-1.
- Utrata dostępu do zakresu przy współdzieleniu (wiersz przeniesiony do zakresu, którego ktoś nie widzi, zostaje u niego) — v1.x.
