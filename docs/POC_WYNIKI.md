# Wyniki PoC

## PoC-6 — Integracje serwerowe (18.11.2026)

**Werdykt: GO dla Google Calendar (watch 3,9 s na prawdziwym Google w chmurze) i Web Push (zamknięta karta Chrome); `pg_cron`/`pg_net` działają na Free. ICS: GO (plik Google odświeża się ~25 s po zmianie). E-mail: GO lokalnie; prawdziwa droga przez Cloudflare razem z M19 w v1.x (D9)** (`docs/POC6_KONFIGURACJA.md`).
Cała droga każdej integracji działa na lokalnym Supabase. Usługi zewnętrzne zastępują w testach fałszywe Google,
serwer ICS i usługa push, zachowujące się jak w dokumentacji (stronicowanie, `syncToken`, 410, kanały, VAPID i aes128gcm).
Nic nie wskazuje na No-go. Google, ICS, Web Push i `pg_cron` na Free sprawdzone też na prawdziwych usługach (niżej).

| Kryterium Go (PLAN_ETAPOWY PoC-6) | Lokalnie | Prawdziwe usługi |
|---|---|---|
| Zmiana w Google widoczna < 1 min (watch) | ✅ powiadomienie → `calendar_events` **63 ms** (fałszywe Google, ten sam protokół) | ✅ **3,9 s** od `updated` wydarzenia w Google do zapisu w `calendar_events` w chmurze (zmiana tytułu, webhook — poza minutą crona); OAuth *In production* bez weryfikacji, kanał TTL 7 dni |
| … albo < 15 min (ICS) | ✅ `pg_cron` → `pg_net` → `cron/poll` → zapis **290 ms**, zadanie `*/10 * * * *` (było `*/15`); niezmieniony plik → 304 | ✅ tajny adres iCal własnego kalendarza: zmiana w Google → widoczna w pliku po **~25 s** (±30 s, 1 próba), `cron/poll` → `calendar_events` **1,2 s**. Razem przy cronie co 10 min (`20261118170000_poc6_ics_10min.sql`): najwyżej ~10,5 min, średnio ~5,5 min (przy 15 min najgorzej ~15,5 min) |
| Mail → zadanie < 1 min | ✅ `inbound-email` **237–336 ms** (MIME + zadanie), kod Workera → funkcja → zadanie **43 ms** | ⏳ v1.x razem z M19 (D9): domena w Cloudflare |
| Push dociera do zamkniętej karty | ✅ wpis w kolejce → dostarczenie przez `pg_cron` **37,7 s / 54,0 s** (≤ 60 s + wysyłka); podpis VAPID i treść sprawdzone kryptograficznie | ✅ **Chrome (FCM), karta zamknięta** (`openWindows: 0`): funkcja → service worker **205 ms**, wpis w kolejce → odbiór 14 s; przy otwartej karcie 156 ms / 39 s (`npm run push-page --workspace tools/edge-tests`) |
| Token odświeżania *In production* > 7 dni | — | ⏳ w trakcie MVP (z planu) |
| `pg_cron`, `pg_net` na planie Free | ✅ lokalnie (pg_cron 1.6.4, pg_net 0.20.4) | ✅ projekt „TaskPlanner” (eu-west-1): migracja z `create extension` przeszła, `taskplanner-reminders-push` co minutę → `pg_net` → funkcja odpowiada 200 (`{"items":0}`); `cron/poll`, `cron/renew`, `inbound-email` działają na bazie w chmurze |

**Testy:** 24 jednostkowe (`tools/edge-tests`: ICS, strefy, e-mail, Google), 3 Workera (`tools/email-worker`),
26 integracyjnych (`npm run test:integration --workspace tools/edge-tests`), 32 pgTAP (`supabase/tests/integrations.test.sql`),
`deno check` funkcji (`npm run typecheck:deno --workspace tools/edge-tests`). Rozwinięcie ICS: 1 000 wydarzeń i 50 serii
dziennych (11 500 wystąpień, 95 KiB) w **110–150 ms** w Node, przy limicie CPU funkcji 2 s.

**Co powstało:**
| Element | Miejsce |
|---|---|
| Tabele `calendar_accounts`, `calendars`, `calendar_events`, `oauth_states`, `inbound_addresses`, `inbound_messages`, `push_subscriptions`, `push_queue`; RLS i uprawnienia kolumn; Vault; `create_integration_task`; `claim_push_queue`; `pg_cron` → `call_edge_function` | `supabase/migrations/20261118140000_poc6_integrations.sql` |
| `calendar-sync`: OAuth Google (start, callback), webhook `watch`, ICS (dodanie), odświeżenie i odłączenie konta, `cron/poll` (co 10 min), `cron/renew` (codziennie) | `supabase/functions/calendar-sync` |
| `inbound-email`: sekret Workera, token z adresu, lista nadawców, DMARC, jedno zadanie na Message-ID, parser szybkiego dodawania w temacie | `supabase/functions/inbound-email` |
| `reminders-push`: `jsr:@negrel/webpush`, kolejka bez podwójnej wysyłki, 404/410 → usunięcie subskrypcji, ponowienia | `supabase/functions/reminders-push` |
| Czysta logika (też w Node): parser ICS + rozwinięcie przez `core/recurrence.ts`, strefy przez `Intl`, klient Google, mail → zadanie | `supabase/functions/_shared` |
| Cloudflare Email Worker (przekazuje surową wiadomość) | `tools/email-worker` |
| Sekrety lokalne, fałszywe usługi, testy, strona próbna push | `tools/edge-tests` |

**Prawdziwe Google (18.11.2026):** osobny projekt Google Cloud „TaskPlanner” w stanie *In production* (ekran „unverified app”, „Advanced → Go to TaskPlanner”). Lokalnie: OAuth → Vault → `calendarList` → pełna synchronizacja z `timeMin`/`timeMax` zwraca `nextSyncToken` → nowe wydarzenie przez przyrost (`full: false`, 1 wiersz, 513 ms dla dwóch kalendarzy). W chmurze: kanał `watch` dla kalendarza głównego, zmiana tytułu w Google → `calendar_events` w 3,9 s. Narzędzie: `npm run real --workspace tools/edge-tests -- <ics|poll|sync|google-start|status|watch> [--cloud]`.

**Prawdziwy ICS (19.11.2026):** `npm run real --workspace tools/edge-tests -- ics-watch <tytuł>` pobiera tajny adres co 30 s i po pojawieniu się zmiany wywołuje `cron/poll`. Google pokazał zmianę tytułu w pliku po ~25 s.

**Wdrożenie w chmurze (18.11.2026):** `db push` (migracje PoC-6), `secrets set --env-file supabase/functions/.env.cloud` (plik poza repozytorium: osobne `CRON_SECRET` i `INBOUND_SECRET`, klucze VAPID te same co lokalnie), `functions deploy` trzech funkcji (bundel 0,8–1,5 MB, `packages/core` spoza `supabase/` dołączony), Vault: `functions_url`, `cron_secret` (`db query --linked`, każda instrukcja osobno — API zapytań nie przyjmuje bloku `do $$`).

**Ustalenia i odstępstwa (do v0.2):**
- §5: tabele integracji mają `user_id` (= zakres osobisty) i `row_version`; każdy zapis podbija `sync_scopes.sync_version`, więc klient dostaje sygnał Realtime. W `pull_changes` dojdą w Etapie 5 jako tylko do odczytu. Wydarzenie całodniowe ma daty pływające `start_date`/`end_date` (koniec bez włączenia, jak w iCalendar), a `start_at`/`end_at` mają tylko wydarzenia z godziną. Usunięte wydarzenia dostają `deleted_at`, a `cron/renew` czyści wydarzenia starsze niż okno.
- §5: `inbound_addresses` (token, nadawcy, lista docelowa, strefa) i `push_subscriptions` są tymczasowe — w MVP-1 przechodzą do `profiles` / `devices`. `push_queue` zastąpi w MVP-4 wyliczanie z `core/reminders.ts` z dziennikiem wysyłek per urządzenie.
- Zadanie z integracji dostaje HLC serwera w `field_clock` każdego pola (`create_integration_task`). Klient scala je jak zmianę z innego urządzenia, a tagi zadania mają id z `taskTagId`.
- M19: Worker **nie parsuje** MIME (wniosek z `docs/USLUGI.md` o CPU na Free), tylko przekazuje surową wiadomość. Parsuje `inbound-email` (`postal-mime` 4.2.1). Worker leży w `tools/email-worker`, a nie w `workers/email` z §3. Odrzucenie (zły token, obcy nadawca, `dmarc=fail`) nie odbija maila do nadawcy, tylko trafia do dziennika (bez treści). Pusta lista nadawców odrzuca wszystko.
- Mail: najpierw wpis w dzienniku (unikalny Message-ID), potem zadanie. Trzy równoległe dostarczenia tego samego maila dają jedno zadanie. Temat bez „Fwd:/Re:/PD:/Odp:/[EXT]”, a w treści zostaje przekazana wiadomość. Cytat odpowiedzi, stopka `-- ` i „Wysłane z…” są odcinane.
- Google: zakres `calendar.readonly` + `openid email`, `access_type=offline`, `prompt=consent` (inaczej ponowne połączenie nie daje tokenu odświeżania). Callback sprawdza, czy użytkownik nie odznaczył kalendarza na ekranie zgody. Jednorazowy `state` ważny 15 min. Pierwsza synchronizacja to `singleEvents=true` z `timeMin`/`timeMax`, potem przyrost z `syncToken`, a 410 wymusza pełną synchronizację z usunięciem brakujących. Sekret w Vault to JSON z tokenem odświeżania i bieżącym tokenem dostępu (odświeżanym, gdy zostaje < 1 min). Kanał `watch` ma TTL 7 dni, a `cron/renew` wymienia go 2 dni przed końcem (nowy przed zatrzymaniem starego). Webhook bez HTTPS (lokalnie) — bez kanałów.
- ICS: DTSTART jest zawsze pierwszym wystąpieniem (RFC 5545, inaczej niż kotwica w `core`). `UNTIL` z godziną daje datę w strefie wydarzenia, a `WKST` jest pomijany przy `INTERVAL=1`. Reguła spoza podzbioru `core` daje tylko pierwsze wystąpienie i ostrzeżenie. Obsługiwane są strefy Windows z Outlooka i ETag / `If-None-Match`. Ten sam plik jest przeliczany najwyżej raz na dobę, bo okno się przesuwa.
- Push: `topic` = id wpisu (powtórka zastępuje powiadomienie w usłudze push), `urgency: high`, TTL 10 min. Ukończone albo usunięte zadanie jest sprawdzane w chwili wysyłki. Same błędy przejściowe → ponowienie w następnej minucie (najwyżej 5 prób).
- `pg_cron` woła funkcje przez `pg_net` z adresem i sekretem z Vault (`functions_url`, `cron_secret`). Bez nich zadanie nic nie robi, więc migracja jest bezpieczna w każdym środowisku. Funkcje mają `verify_jwt = false` i same sprawdzają JWT użytkownika, `x-cron-secret`, sekret Workera albo token kanału Google.

**Wnioski z prawdziwych usług:**
- Klient OAuth musi być w **osobnym projekcie Google Cloud** — ekran zgody (nazwa, stan *Testing*/*In production*) jest wspólny dla projektu; klient z projektu ExpeditionPlan pokazywał „ExpeditionPlan” i `403 access_denied` (stan *Testing*). Po utworzeniu projektu trzeba jawnie kliknąć **Audience → Publish app**. Adres powrotu dokładnie jak w `redirect_uri` (`http://127.0.0.1:54521/…` lokalnie, bez ukośnika na końcu).
- Kalendarze świąt Google (`…#holiday@group.v.calendar.google.com`) **nie obsługują `watch`** (400 „Push notifications are not supported by this resource”) — teraz zapisywane jako `noWatch` i odświeżane tylko przez cron; wcześniej błąd przerywał połączenie konta.
- Publiczny ICS świąt Google zmienia **UID wydarzeń przy każdym pobraniu** → każda pełna synchronizacja usuwa i wstawia wszystkie wiersze (`deleted_at`). Kalendarze użytkownika mają stałe UID; jeśli to przeszkadza, klucz zapasowy (tytuł + początek) dla plików z niestabilnymi UID (Etap 5).
- Połączenie konta Google domyślnie włącza wszystkie kalendarze zaznaczone w Google Calendar (także święta) — w Etapie 5 wybór w „Połączone kalendarze”.

**Wnioski techniczne:**
- Lokalny Edge Runtime (1.77.8, zgodny z Deno 2.1.4) widzi całe repozytorium, więc `../../../packages/core/src/*.ts` importuje się bez kopiowania. `zod` wymaga mapy importów (`supabase/functions/deno.json`, wspólna dla funkcji przez `import_map` w `config.toml`). `functions deploy` dołącza je do bundla (sprawdzone w chmurze).
- `jsr:@negrel/webpush` 0.5.0 działa w Edge Runtime (wyjście awaryjne `npm:web-push` niepotrzebne). Klucze VAPID w formacie JWK z WebCrypto (`setup.ts`) importują się bez biblioteki.
- `deno check` (Deno 2.9.6) odrzucił `@supabase/supabase-js` 2.119.1 opublikowany < 24 h wcześniej (domyślny minimalny wiek zależności), więc funkcje mają przypięte 2.118.0. `deno.lock` z Deno 2.9 nie jest zapisywany (`--no-lock`), bo runtime 2.1 może nie czytać nowszego formatu.
- **Nowy projekt w chmurze nie nadaje ról API do tabel z migracji** (lokalny stack nadaje, `auto_expose_new_tables`): funkcje dostały „permission denied for table calendar_accounts” mimo `service_role`. Poprawka: jawne granty w `20261118150000_poc6_grants.sql`. **To samo dotyczyło tabel PoC-1**: w chmurze `authenticated` nie miał `select` do `sync_scopes` i tabel zadań, więc sygnał Realtime nie doszedłby do klientów (`push_changes`/`pull_changes` działały jako SECURITY DEFINER) — poprawione w `20261118160000_poc1_grants.sql` (`select` dla `authenticated`, pełne dla `service_role`, zapis klienta dalej tylko przez `push_changes`). Lokalnie bez zmian (granty były), `test:db` i `test:sync` zielone; test Realtime w `test:sync` raz na 4 przebiegi nie zdążył (do obserwacji). **Każda nowa tabela potrzebuje jawnego `grant` dla `service_role`** (i `authenticated`, jeśli klient ma czytać wprost) — dotyczy też MVP-1; warto ustawić `auto_expose_new_tables = false` lokalnie, żeby błąd wychodził w testach.
- CLI 2.122: `import_map` w `[functions.*]` jest przestarzałe — `supabase/functions/deno.json` jest wykrywany sam (lokalnie i przy wdrożeniu).
- Uprawnienia kolumn (sekrety, `sync_state`) sprawiają, że `select('*')` z klienta kończy się błędem. Klient musi wymieniać kolumny — do pamiętania w Etapie 5.
- Chrome: odmowa powiadomień zapisana dla `localhost` blokuje też rejestrację service workera (Chrome nie pobiera `sw.js`) — strona próbna pokazuje stan zgody i pełny błąd. Do pomocy w ustawieniach (MVP-4).
- Docker Desktop na Windows: fałszywe usługi na `0.0.0.0:54590` są osiągalne z kontenera funkcji jako `host.docker.internal`, a z bazy funkcje widać jako `supabase_kong_taskplanner:8000`.

**Niesprawdzone:**
- Token odświeżania Google w stanie *In production* > 7 dni (w trakcie MVP).
- Cloudflare (v1.x, D9): czas Email Routing → Worker → funkcja, nagłówki `Authentication-Results` dodawane przez Cloudflare (od tego zależy reguła DMARC), limit CPU Workera na Free.
- Załączniki z maila (Etap 10), wybór kalendarzy w UI i ekran „Połączone kalendarze” (Etap 5), strefa z ustawień profilu zamiast `inbound_addresses.time_zone` (MVP-1).
## PoC-5 — Widoki webowe na lokalnych danych (18.11.2026)

**Werdykt: GO z warunkami.** Biblioteki: **FullCalendar 6.1.22** (MIT), **dnd-kit** (core 6.3, sortable 10), **SVAR React Gantt 2.8.3** (MIT, darmowa wersja wystarcza — własnego komponentu SVG nie budowałem), **TipTap 3.34 + @tiptap/markdown**. Strona prób: `/dev/views`. Dane: `npm run seed:dev -- --load` (5 746 operacji przez `push_changes` w 3,4 s, 0 odrzuceń) → 2 017 zadań w lokalnej bazie przeglądarki (OPFS).

Pomiary w panelu przeglądarki aplikacji Claude (Chromium); w spoczynku panel daje średnio **20,1 ms na klatkę**, więc to jest punkt odniesienia, a nie 16,7 ms. W schowanym panelu `requestAnimationFrame` nie działa wcale — pomiary tylko przy widocznym panelu.

| Kryterium | Kalendarz | Kanban | Oś czasu | Markdown |
|---|---|---|---|---|
| Działanie | ✅ tydzień/dzień/miesiąc, „cały dzień”, przeciąganie z panelu bocznego, zmiana długości; zapis do lokalnej bazy i na serwer sprawdzony | ✅ zmiana kolumny (status) i kolejności, klawiatura (KeyboardSensor) | ✅ przesuwanie, rozciąganie krawędzi (1 → 3 dni), zależności klikiem w uchwyty, czerwone naruszenie; zapis dat na serwer sprawdzony | ✅ |
| Przeciąganie | ✅ **60 kl./s**, 0 zgubionych z 90 | ✅ w ruchu 16–17 ms; ⚠️ **start przeciągania 150–184 ms** (jedna klatka: dnd-kit mierzy ~400 kart), upuszczenie 61 ms | ✅ śr. 19,1 ms (jak spoczynek), pojedyncze klatki 33–50 ms | — |
| Przełączenie widoku < 150 ms | ✅ 67–71 ms | ❌ 1 040 ms przy 1 800 kartach → ✅ **114–122 ms** przy 100 kartach na kolumnę („pokaż więcej”) | ⚠️ **165–190 ms** (pierwsze 533 ms z ładowaniem biblioteki) | ✅ 91 ms |
| Zapis i odczyt bez strat | — | — | — | ✅ **96/100** bez zmian, **100/100** stabilne, 0 utraconej treści |

**Warunki na MVP / Etap 6:**
- **Kanban:** nie rysować wszystkich kart naraz — porcje (jak w PoC) albo wirtualizacja; tylko widoczne karty jako `useSortable`. Pierwsza klatka przeciągania do zmierzenia ponownie po tej zmianie.
- **Kolejność kart przy kanbanie wielu list:** `sort_key` jest per lista/rodzic, więc na tablicy z kilku list klucze nie są uporządkowane między sobą (`keyBetween` rzuca wyjątek — w PoC obejście „za poprzednikiem”). Do decyzji w MVP-4: osobny klucz kolejności tablicy (`board_sort_key`) albo kanban zawsze w obrębie jednej listy.
- **Oś czasu:** trzymać widok zamontowany po pierwszym otwarciu (albo przedładować kod), żeby zejść poniżej 150 ms; polskie napisy z `@svar-ui/gantt-locales`; **SVAR przyjmuje cykle zależności** (A→B i B→A) — blokada w `core/dependencies.ts`; zależności w PoC tylko w pamięci, tabela `task_dependencies` w Etapie 6.
- **Markdown:** `descriptionMarkdown` (`apps/web/src/lib/editor.ts`) zapisuje goły adres URL goło — TipTap pisze `[url](url)`, a marki renderują się z zastępnikiem zamiast tekstu, więc poprawka jest na gotowym tekście. Pozostałe 4 różnice: dwie listy oddzielone pustą linią łączą się w jedną — w CommonMark to i tak jedna lista.
- **Pierwsza synchronizacja w przeglądarce:** 2 017 zadań pobrane i pierwsze zapytanie gotowe po ~4,2 s — stronicowanie migawki i wskaźnik postępu w MVP-1.

**Uwagi do testów E2E:** SVAR reaguje na zdarzenia `pointer*` (same `mouse*` nie ruszają paska), zależności tworzy kliknięcie w uchwyt końca, potem początku; dnd-kit — `pointer*` z odległością aktywacji 4 px; FullCalendar — `mouse*`.

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
- Korpus pisałem sam (przykłady + pułapki), więc 100 % mierzy zgodność z ustaloną gramatyką, a nie trafność na prawdziwych wpisach. Prawdziwy sprawdzian: prawdziwe zadania wpisane przez użytkownika (D13: brak narzędzia do importu) dopisane do korpusu przed MVP-2.
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
