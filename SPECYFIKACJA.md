# Task Planner — specyfikacja v0.2

Źródła: wstępna specyfikacja (18.11.2026) oraz architektura i doświadczenia z ExpeditionPlan (`D:\AI\ExpeditionPlan`: `CLAUDE.md`, `SPECYFIKACJA.md` §2 i §6, `PLAN_ETAPOWY.md`).
Plan realizacji: [PLAN_ETAPOWY.md](PLAN_ETAPOWY.md). Repozytorium: `github.com/MichalKlinWedge/TaskPlanner`.

Status: **v0.2 po bramce decyzyjnej (19.11.2026)** — wszystkie PoC zakończone (wyniki: `docs/POC_WYNIKI.md`), decyzje w §12, zmiany względem v0.1 w §13.

---

## 0. Wnioski z ExpeditionPlan

### 0.1. Co przenosimy bez zmian
- **Monorepo npm workspaces** (`apps/*`, `packages/*`, `tools/*`), Node ≥ 22, TypeScript. Pakiety konsumowane jako **źródła TS** (`main: src/index.ts`) z **jawnymi rozszerzeniami `.ts`** w importach względnych (wymóg Deno), `allowImportingTsExtensions`, Next transpiluje je przez `transpilePackages`.
- **Logika domenowa w `packages/core`**: czysty TS, bez importów z Node/Expo/Next poza testami. Ten sam kod liczy widok „Dziś”, cykliczność i przypomnienia w przeglądarce, na telefonie offline i w Edge Functions.
- **Zod jako jedyne źródło prawdy** dla formularzy, pól `jsonb` i API. Zawartość `jsonb` w camelCase, kolumny tabel w snake_case.
- **Supabase** (Postgres + RLS + Realtime + Storage), migracje SQL, testy RLS w pgTAP, przypięta wersja CLI (`npx --yes supabase@2.122.0`), typy w `packages/db`.
- **Wzorzec synchronizacji z PoC-4 ExpeditionPlan**: `row_version` nadawany w triggerze z licznika zakresu (blokada wiersza zakresu = kolejność zatwierdzania), pobieranie przyrostowe jednym RPC `pull_changes` (jedna migawka), outbox w SQLite, UUIDv7 z klienta, miękkie usunięcia (`deleted_at`), Realtime tylko jako sygnał do pobrania i dodatkowe pobranie po gotowości subskrypcji.
- **Expo**: dev build (nie Expo Go), `npx expo install` dla zależności, `AGENTS.md` w aplikacjach. Zmiana w v0.2: bez `eas.json` i OTA — APK budowany lokalnie i w GitHub Actions (D17).
- `scripts/sync-env.mjs` (główny `.env.local` → `apps/*/.env.local`), `.gitattributes` i `.editorconfig` z LF, etykiety i formatowanie w `packages/core` (`labels.ts`, `format.ts`, `sort-key.ts`).
- Dokumentacja, napisy w UI i komentarze po polsku, identyfikatory po angielsku.

### 0.2. Co zmieniamy i dlaczego
| ExpeditionPlan | Task Planner | Powód |
|---|---|---|
| Plan edytuje web, telefon głównie czyta; zapisy telefonu tylko dopisywane | **Oba klienty edytują wszystkie dane, także offline** | zadania dodaje się i zmienia tam, gdzie się o nich myśli |
| Konflikty: brak (dopisywanie) albo last-write-wins na wierszu | **Scalanie per pole (LWW z zegarem HLC)** + operacje tylko dopisywane tam, gdzie się da (ukończenia, czas pracy) | dwie edycje różnych pól tego samego zadania nie mogą się nadpisać (§6) |
| Web online (Server Components + Server Actions) | **Web local-first**: lokalna baza SQLite (WASM, OPFS) i ten sam `packages/sync` co na telefonie | kanban, kalendarz i paleta poleceń muszą reagować natychmiast; spec wymaga pracy offline |
| Zakres synchronizacji: wyjazd (`trips.sync_version`) | **Zakres: przestrzeń** (`sync_scopes`) + zakres osobisty (tagi, filtry, ustawienia) | przestrzeń jest jednostką izolacji i przyszłego współdzielenia |
| AI w rdzeniu produktu | AI poza v1.0 (v1.x, przez `packages/ai` z EP) | spec nie wymaga AI; szybkie dodawanie działa regułami, offline |
| Bez Edge Functions | **Edge Functions** do integracji (kalendarze, e-mail, Web Push) + `pg_cron` | zadania okresowe co minutę; Vercel Hobby ma cron tylko raz dziennie |

---

## 1. Cel, użytkownicy, zakres

**Cel:** osobisty system zadań codziennych, w którym listy, kanban, kalendarz i oś czasu są widokami tych samych danych; działa w przeglądarce i na Androidzie, w pełni offline.

**Użytkownik:** jedna osoba (właściciel) na kilku urządzeniach. Schemat od początku ma członków zakresów (`scope_members`), więc współdzielenie przestrzeni da się dodać bez migracji danych (v1.x).

**Role urządzeń** (oba mają pełną edycję):
- **Web (laptop)** — planowanie: kanban, oś czasu, kalendarz z time-blockingiem, przegląd tygodnia, paleta poleceń i skróty klawiszowe.
- **Android (telefon)** — przechwytywanie i wykonanie: szybkie dodawanie, „Dziś”, przypomnienia, tryb skupienia, nawyki, widżety, udostępnianie linków do aplikacji.

### Zakres i priorytety (MoSCoW)
| Funkcja ze specyfikacji wstępnej | Priorytet | Etap | Moduł |
|---|---|---|---|
| Przestrzenie, projekty, listy | MUST | MVP-1/2 | M2 |
| Zadania i podzadania (do 4 poziomów) | MUST | MVP-2 | M3 |
| Tagi i filtrowanie po kontekście | MUST | MVP-2 | M4 |
| Opis z formatowaniem | MUST | MVP-2 | M5 |
| Załączniki | SHOULD | Etap 10 | M5 |
| Priorytety (4 stopnie) | MUST | MVP-2 | M6 |
| Data, godzina, czas trwania | MUST | MVP-2 | M6 |
| Cykliczność (zaawansowane reguły, po ukończeniu) | MUST | MVP-4 | M7 |
| Przypomnienia względne i bezwzględne | MUST | MVP-3/4 | M8 |
| Lista: Inbox / Dziś / Nadchodzące, grupowanie | MUST | MVP-2/3 | M9 |
| Kanban z przeciąganiem | MUST | MVP-4 | M10 |
| Kalendarz D/T/M i time-blocking | MUST | Etap 5 | M11 |
| Oś czasu (Gantt) i zależności | SHOULD | Etap 6 | M12 |
| Szybkie dodawanie z językiem naturalnym (PL) | MUST | MVP-2 | M13 |
| Tryb skupienia + Pomodoro + licznik czasu | SHOULD | Etap 7 | M14 |
| Cykliczne — nawyki (passy, statystyki) | SHOULD | Etap 8 | M15 |
| Przegląd dnia / tygodnia | SHOULD | Etap 9 | M16 |
| Wyszukiwarka i paleta poleceń | MUST | MVP-2 | M17 |
| Kalendarze zewnętrzne — odczyt | MUST | Etap 5 | M18 |
| Kalendarze zewnętrzne — zapis (dwukierunkowo) | SHOULD | Etap 12 | M18 |
| Link → zadanie | SHOULD | Etap 10 | M19 |
| E-mail → zadanie | COULD | v1.x (D9) | M19 |
| Offline (pełna funkcjonalność) | MUST | od MVP-1 | M20, §6 |
| Widżety na telefonie | SHOULD | Etap 11 | M20 |
| Widżety na pulpicie | COULD (PWA + skróty; natywny widżet poza v1.0, D11) | Etap 11 / v1.x | M20 |

**Poza zakresem v1.0:** iOS, natywna aplikacja desktopowa, współpraca wielu osób, AI, własne statusy kanbanu, sekcje w projektach, przypomnienia według lokalizacji (wszystko w v1.x, PLAN_ETAPOWY.md).

---

## 2. Architektura

```
┌────────────────────────────┐      ┌────────────────────────────┐
│ Web (Next.js, PWA)          │      │ Android (Expo)              │
│ UI ← reaktywne zapytania    │      │ UI ← reaktywne zapytania    │
│ SQLite WASM (OPFS, worker)  │      │ expo-sqlite                 │
│ packages/sync: outbox, HLC  │      │ packages/sync: outbox, HLC  │
│ Service Worker (powłoka)    │      │ powiadomienia lokalne, widżety│
└─────────────┬──────────────┘      └─────────────┬──────────────┘
              │  supabase-js: Auth, RPC push_changes / pull_changes,
              │  Realtime (sygnał), Storage (załączniki)
              └──────────────────┬───────────────┘
                     ┌───────────▼────────────┐
                     │ Supabase                │
                     │ Postgres + RLS          │
                     │ RPC: push_changes,      │
                     │      pull_changes       │
                     │ pg_cron → Edge Functions│
                     └───────────┬────────────┘
   Edge Functions (Deno, packages/core):
     reminders-push   → Web Push (VAPID)
     calendar-sync    ↔ Google Calendar API (watch + syncToken), ICS
     inbound-email    ← Cloudflare Email Routing + Email Worker (v1.x, D9)
     link-preview     → pobranie tytułu strony (ochrona przed SSRF)
   Web hostowany na Vercel; APK budowany lokalnie i w GitHub Actions (bez EAS), aktualizacja = nowy APK.
```

Zasada: **UI czyta i pisze wyłącznie lokalną bazę**. Sieć to sprawa `packages/sync` w tle. Dzięki temu każdy widok działa tak samo online i offline, a UI nie ma osobnej ścieżki „bez sieci”.

### Stos i decyzje
| Obszar | Wybór | Dlaczego | Odrzucone |
|---|---|---|---|
| Mobile | **Expo SDK 58 + Expo Router + TS** (New Architecture), dev build; APK budowany lokalnie (`npx expo run:android`) i w GitHub Actions (`.github/workflows/android.yml`), poza Google Play (D17) | jak w ExpeditionPlan; bez EAS, bo darmowy limit EAS Build wyczerpał się w PoC-4 | Flutter, Kotlin: brak współdzielenia kodu; EAS Build/Update: limit buildów, OTA niepotrzebne przy jednym użytkowniku |
| Web | **Next.js 16 + React 19 + Tailwind 4**, PWA (Service Worker) | jak w ExpeditionPlan | Vite SPA: tracimy wspólne ustawienia z EP; zysk mały |
| Backend | **Supabase** (osobny projekt), Edge Functions + `pg_cron` + `pg_net` | RLS, Realtime, Storage, zadania okresowe bez własnego serwera | Firebase: NoSQL utrudnia zapytania i RLS |
| Lokalna baza — telefon | `expo-sqlite` (FTS5) | jak w EP | WatermelonDB: inny paradygmat |
| Lokalna baza — web | **`@sqlite.org/sqlite-wasm`** w Web Workerze, VFS `opfs-sahpool`, jedna karta-lider (Web Locks) + BroadcastChannel | ten sam SQL i FTS5 co na telefonie, jeden kod `packages/sync` | IndexedDB (Dexie): drugi model zapytań; PowerSync/ElectricSQL: zależność od usługi, EP wybrał wariant własny |
| Reaktywność UI | `LocalDb.watch(tabele, zapytanie)` w `packages/sync` + cienkie hooki React w aplikacjach; Zustand dla stanu UI (zaznaczenie, panel, timer) | jedno źródło danych, unieważnianie po tabeli | TanStack Query: dubluje lokalną bazę |
| Walidacja | **Zod 4** w `packages/core` | jak w EP | — |
| Opis zadania | **Markdown (podzbiór GFM)** w kolumnie `text`; web: **TipTap 3** + `@tiptap/markdown`; telefon: edytor Markdown z paskiem narzędzi i podglądem (albo TenTap — wybór w MVP-3); web sprawdzony w PoC-5: 100/100 opisów stabilnych, 0 strat (`apps/web/src/lib/editor.ts`) | tekst łatwo scalać, szukać (FTS5) i tworzyć z maila | JSON ProseMirror: trudny do wyszukiwania i edycji na telefonie |
| Daty | własne funkcje dat „pływających” w `packages/core` (`YYYY-MM-DD`, `HH:MM`), bez bibliotek stref | zadania osobiste są w czasie lokalnym (§5) | Temporal: brak w Hermes |
| Cykliczność | **własny podzbiór RRULE (RFC 5545)** w `core/recurrence.ts` + tryb „po ukończeniu” (D19, PoC-3); rrule.js tylko jako wyrocznia w testach | standard zgodny z Google Calendar, liczony na datach pływających bez zależności | rrule.js w produkcie: obiekty `Date` w strefie, liczy reguły spoza podzbioru inaczej niż Google; własny format reguł: brak zgodności z kalendarzami |
| Kalendarz — web | **FullCalendar 6** (daygrid, timegrid, interaction — licencja MIT) | widok D/T/M, przeciąganie z zewnątrz (`Draggable`), zmiana długości | wersja Premium: niepotrzebna (zasoby, oś czasu) |
| Oś czasu — web | **SVAR React Gantt 2.8** (MIT, D18, PoC-5); polskie napisy z `@svar-ui/gantt-locales`, cykle blokuje `core/dependencies.ts` (SVAR je przyjmuje) | przesuwanie, rozciąganie krawędzi, strzałki zależności | własny SVG: niepotrzebny; DHTMLX/Bryntum: licencje płatne lub GPL |
| Kanban i sortowanie — web | **dnd-kit**; tylko widoczne karty jako `useSortable` (porcje albo wirtualizacja — PoC-5: 1 800 kart naraz = 1 s przełączenia) | sprawdzony, dostępny z klawiatury | react-beautiful-dnd: porzucony |
| Paleta poleceń | **cmdk** | standard w React | — |
| Kalendarz — telefon | **własna oś dnia** na Reanimated + Gesture Handler 3 (D16, PoC-4: przesunięcie bloku zapisane w 46 ms) | pełna kontrola gestów, bez zależności | `@howljs/calendar-kit`: w PoC-4 przeciągnięcie przewijało widok zamiast przesuwać blok; react-native-calendars: tylko miesiąc/agenda |
| Kolejność ręczna | klucze ułamkowe (`sort_key` tekstowy, `core/sort-key.ts` z EP) | zmiana kolejności offline bez przenumerowania | liczby całkowite: konflikty |
| Powiadomienia | telefon: `expo-notifications` (lokalne, offline) z dokładnymi alarmami `USE_EXACT_ALARM` (D17); web: **Web Push (VAPID)** z Edge Function, `jsr:@negrel/webpush` 0.5.0 (PoC-6) | przypomnienie bez sieci na telefonie; bez dokładnych alarmów Android daje okno ≈ 75 % czasu do terminu (PoC-4) | FCM dla telefonu: nie działa offline |
| Widżety Android | `react-native-android-widget` (plugin Expo) — potwierdzone w PoC-4 (odhaczanie przy zamkniętej aplikacji i bez sieci, ≈ 2 s); pliki widżetu z `'use no memo'` | widżet w JSX, zadania w tle (headless JS) | natywny Kotlin: drugi język |
| Udostępnianie do aplikacji | `expo-share-intent` (Android), Web Share Target (PWA), bookmarklet | link → zadanie | — |
| Poczta przychodząca (v1.x, D9) | **Cloudflare Email Routing + Email Worker** → Edge Function | darmowe, własna domena | Postmark/Mailgun inbound: płatne |
| Testy | Vitest (pakiety, web), pgTAP (RLS, RPC), testy integracyjne `packages/sync` na lokalnym Supabase, Playwright (web), Maestro (Android) | jak w EP | — |
| Hosting | Supabase, Vercel (web), GitHub Actions (APK), Cloudflare (poczta, v1.x) | — | — |

### Struktura repozytorium (monorepo, npm workspaces)
```
apps/web/            Next.js — aplikacja webowa (PWA)
apps/mobile/         Expo — aplikacja Android, widżety
packages/core/       czysty TS: schematy Zod, parser szybkiego dodawania, cykliczność,
                     widoki (Dziś, Nadchodzące, grupowanie, filtry), zależności i oś czasu,
                     time-blocking, nawyki, przypomnienia, Pomodoro, przegląd, HLC,
                     etykiety i formatowanie PL
packages/sync/       LocalDb (interfejs) + implementacje (expo-sqlite, sqlite-wasm, node do testów),
                     schemat lokalny (SPECS), outbox, push/pull, scalanie per pole, watch()
packages/db/         typy wygenerowane z Supabase
supabase/
  migrations/        tabele, RLS, triggery (row_version, field_clock), RPC push/pull
  functions/         Edge Functions: reminders-push, calendar-sync, inbound-email, link-preview;
                     _shared/ (czysta logika, testowana też w Node), deno.json (mapa importów)
  tests/             pgTAP: RLS, push_changes, pull_changes, integracje
tools/email-worker/  Cloudflare Email Worker (przekazanie surowego maila do inbound-email; v1.x)
tools/edge-tests/    testy funkcji, fałszywe usługi (Google, ICS, push), sekrety lokalne
tools/seed-dev/      dane deweloperskie (5 przestrzeni, 2 000 zadań), `--load` do lokalnego Supabase
fixtures/            quick-add.jsonl (korpus parsera), recurrence.json, historie nawyków
scripts/             sync-env.mjs
docs/                USLUGI.md (zweryfikowane warunki usług), POC_WYNIKI.md, ANDROID_BUILD.md,
                     POC4_TELEFON.md, POC6_KONFIGURACJA.md
.github/workflows/   android.yml (APK)
```

---

## 3. Moduły funkcjonalne

Oznaczenia: **[W]** web, **[A]** Android, **[W+A]** oba.

### M1. Konto, urządzenia, ustawienia
- Logowanie Google i link z maila (magic link) [W+A]; w aplikacji deep link. Jak w EP.
- Przy pierwszym logowaniu: przestrzenie „Osobiste” i „Praca”, każda z listą Inbox.
- Ustawienia w `profiles.settings` (Zod): strefa czasowa (domyślnie z urządzenia), pierwszy dzień tygodnia (poniedziałek), godziny pracy (do wolnych okien i przeglądu), domyślna godzina przypomnienia dla zadań bez godziny (9:00), domyślny czas trwania bloku (30 min), długości Pomodoro, kanał przypomnień per urządzenie (telefon / przeglądarka / oba), godziny przeglądu dnia.
- Lista urządzeń (`devices`): nazwa, platforma, ostatnia synchronizacja, subskrypcja Web Push.

### M2. Przestrzenie, projekty, listy
- **Przestrzeń** (Praca, Dom, Studia, Hobby): nazwa, kolor, ikona, kolejność, archiwizacja. Przełącznik przestrzeni w nagłówku [W+A] z trybem „Wszystkie”. W trybie jednej przestrzeni widoki (Dziś, Nadchodzące, kalendarz, wyszukiwarka) pokazują tylko jej zadania — to jest „całkowite odizolowanie kontekstu”.
- **Lista** wewnątrz przestrzeni, rodzaj (`kind`):
  - `inbox` — jedna na przestrzeń, nieusuwalna; tu trafia szybkie dodawanie bez wskazania listy, e-mail i linki,
  - `project` — ma daty `start_date`/`end_date`, status (aktywny / zakończony / wstrzymany), postęp (ukończone / wszystkie zadania), pasek na osi czasu,
  - `list` — lista ciągła (Zakupy, Pomysły), bez dat i postępu.
- Ustawienia widoku listy (`view_prefs`): domyślny widok (lista / kanban / kalendarz / oś czasu), grupowanie, sortowanie, pokazywanie ukończonych.
- Przenoszenie listy między przestrzeniami przenosi jej zadania (jedna operacja, §6).

### M3. Zadania i podzadania
- Zadanie należy do jednej listy; podzadanie ma `parent_id`. **Maksymalnie 4 poziomy** (zadanie + 3 poziomy podzadań), pilnowane w `core` i w triggerze.
- Podzadania mają własne terminy, priorytety, statusy, przypomnienia i tagi. Postęp rodzica = ukończone / wszystkie bezpośrednie podzadania.
- Ukończenie rodzica z nieukończonymi podzadaniami → pytanie „Ukończyć też podzadania?” (domyślnie tak).
- Status: `todo` (Do zrobienia), `in_progress` (W trakcie), `waiting` (Oczekuje), `done` (Gotowe), `cancelled` (Anulowane). Lista statusów jest stała w v1.0 (D6).
- Operacje grupowe na zaznaczonych zadaniach [W] (Shift/Ctrl + klik, klawiatura) i [A] (długie przytrzymanie): przenieś, termin, priorytet, tag, ukończ, usuń.
- Usunięcie = kosz (`deleted_at`), przywracanie przez 30 dni; potem trwałe usunięcie (§6). Z kosza można też usunąć zadanie na stałe od razu (z potwierdzeniem, tylko z siecią, bez cofnięcia).
- Historia zmian zadania (z `activity_log`) [W].

### M4. Tagi, filtry, inteligentne listy
- Tagi są **wspólne dla wszystkich przestrzeni** (zakres osobisty): nazwa (unikalna bez rozróżniania wielkości liter i polskich znaków), kolor (jak dla przestrzeni, list i grup karteczek: domyślna paleta albo „Inny kolor” — szersza paleta, zapis #RRGGBB, na webie także próbnik). Zadanie ma dowolną liczbę tagów (`task_tags`).
  - v1.x (20.11.2026): tag można **przypisać do przestrzeni** (`tags.workspace_ids`, ekran tagu → „Widoczny w”); żadna = wszystkie. To tylko widoczność: w wybranej przestrzeni pasek boczny, chipy filtra, podpowiedzi w zadaniu i kolumny tablicy pokazują jej tagi + tagi już przypięte / zaznaczone; widok „Wszystkie przestrzenie” i paleta pokazują wszystkie. Tag nadal jest jeden na nazwę — `@nazwa` w innej przestrzeni trafia w ten sam tag (core `tagsForWorkspace`). Nowy tag (szybkie dodawanie, panel zadania) dostaje przestrzeń zadania, na którym powstał (`taskTagOps(…, workspaceId)`); istniejącego nie zmienia.
- Filtrowanie: chipy w każdym widoku — tagi (wszystkie / dowolny), priorytet, lista, status, zakres dat, „bez terminu”, „z godziną”.
- **Zapisane filtry** (`saved_filters`): nazwa, ikona, definicja (Zod: `FilterQuery`) — np. „Telefony na dziś” = tag `telefon` ∧ termin ≤ dziś. Widoczne w pasku bocznym jak listy, z licznikiem.
- Tekstowy język filtrów (`@telefon & dziś & !1`) — v1.x.

### M5. Opis i załączniki
- Opis w Markdown: pogrubienie, kursywa, listy punktowane i numerowane, listy zadań (checkboxy), linki, cytaty, bloki kodu, nagłówki. Linki są klikalne w podglądzie na obu platformach.
- Web: edytor WYSIWYG (TipTap), skróty Markdown w trakcie pisania. Telefon: edytor z paskiem narzędzi i przełącznikiem podgląd/edycja.
- **Załączniki** (Etap 10): pliki do 25 MB w prywatnym buckecie `attachments` (`{user_id}/{task_id}/{uuid}-{nazwa}`), podgląd obrazów i PDF, załączniki z maila. Telefon: zdjęcie z aparatu / plik; wysyłka w kolejce offline (jak `journal-photos.ts` w EP), pobieranie na żądanie i pamięć podręczna.
- Link jako załącznik: URL + tytuł + ikona strony (z `link-preview`).
- Zrobione (19.11.2026, Etap 10, web): `core/attachments.ts`, kolejka `sync/files.ts` (`createFileQueue` — wiersz po wysłaniu pliku), RLS Storage w `*_etap10_attachments.sql`, Edge Function `link-preview` (ochrona SSRF: tylko publiczne adresy, przekierowania sprawdzane co krok); web Share Target, bookmarklet, wklejony adres. Telefon — do zrobienia.

### M6. Priorytety, terminy, czas trwania
- Priorytet 1–4: **1 Krytyczny** (czerwony), **2 Wysoki** (pomarańczowy), **3 Średni** (niebieski), **4 Niski** (szary, domyślny). Flaga w kolorze na liście, pasek koloru na kanbanie i w kalendarzu. Etykiety w `core/labels.ts` (`PRIORITY`).
- Pola czasu (szczegóły w §5):
  - `due_date` — dzień wykonania (albo koniec zadania wielodniowego),
  - `due_time` — godzina rozpoczęcia (opcjonalna; bez niej zadanie jest „całodniowe”),
  - `duration_min` — szacowany czas (do kalendarza i osi czasu; domyślnie z ustawień przy przeciąganiu),
  - `start_date` — początek zadania wielodniowego (opcjonalny; oś czasu, widok „Dziś” w trakcie zakresu).
- Zaległe = `due_date < dziś` i status otwarty; oznaczane na czerwono, na górze „Dziś”.

### M7. Cykliczność (silnik w §7.2)
- Dwa tryby:
  - **według harmonogramu** — reguła RRULE, np. codziennie, w dni robocze, co drugi wtorek, drugi wtorek miesiąca, ostatni dzień miesiąca, ostatni dzień roboczy miesiąca, 15. i ostatni dzień miesiąca, co roku 1 marca, co 3 miesiące; z końcem po dacie albo po N wystąpieniach,
  - **po ukończeniu** — następne wystąpienie N dni / tygodni / miesięcy po faktycznym ukończeniu poprzedniego (np. „3 dni po ukończeniu”).
- Edytor reguły [W+A]: gotowe szablony + tryb zaawansowany + **opis po polsku na żywo** („co 2 tygodnie we wtorek, do 31.12.2026”) + podgląd 5 najbliższych dat.
- Jedno zadanie w bazie = cała seria. Ukończenie zapisuje wpis w `task_completions` i przesuwa `due_date` na następne wystąpienie; podzadania wracają do „Do zrobienia”.
- Akcje: „Ukończ”, „Pomiń to wystąpienie”, „Przesuń to wystąpienie” (zmienia tylko bieżący termin, reguła bez zmian), „Zakończ serię”.
- Przyszłe wystąpienia widać w „Nadchodzące”, kalendarzu i na osi czasu jako wpisy wirtualne (tylko do odczytu, z ikoną powtarzania); klik otwiera serię.

### M8. Przypomnienia i powiadomienia
- Rodzaje: **względne** (N minut/godzin/dni przed `due_date`+`due_time`; dla zadania bez godziny — przed domyślną godziną z ustawień) i **bezwzględne** (konkretna data i godzina lokalna). Kilka przypomnień na zadanie. Przy zadaniach cyklicznych przypomnienia względne dotyczą każdego wystąpienia.
- **Telefon**: powiadomienia lokalne planowane z lokalnej bazy w oknie 7 dni (limit 50 naraz), przeplanowanie po każdej zmianie, synchronizacji, starcie aplikacji i w zadaniu w tle (`expo-background-task`). Akcje w powiadomieniu: „Ukończ”, „Odłóż 10 min / 1 h / do jutra” — działają przy zamkniętej aplikacji (zapis do SQLite + outbox).
  - **Sposób przypominania** (ustawienie telefonu, „Konto i synchronizacja” → „Przypomnienia i praca w tle”): „Powiadomienie na belce” (domyślnie) albo „Alarm na cały ekran” — wybudza telefon, dzwoni do 2 min dźwiękiem budzika, pokazuje nad blokadą tytuł i opis oraz „Zakończ” / „Edytuj” / „Czekaj N min” (5 / 10 / 15 / 30 / 60, domyślnie 15; po tym czasie ta sama plansza). Bez odpowiedzi zostaje ciche powiadomienie z tymi przyciskami. Przy używanym telefonie Android pokazuje plakietkę zamiast planszy. Przeglądy i skupienie zostają na belce.
- **Web**: Web Push z Edge Function `reminders-push` (co minutę z `pg_cron`), dla urządzeń, które w ustawieniach mają kanał „przeglądarka”. Gdy karta jest otwarta — dodatkowo powiadomienie w aplikacji.
- **Wspólna przestrzeń**: przypomnienia każdy ustawia sobie — widzi i dostaje tylko własne. Dodatkowo osoba odpowiedzialna (wskazany współpracownik, którego e-mail = e-mail konta członka przestrzeni; bez wskazanej osoby — twórca zadania) dostaje automatyczne przypomnienie **w chwili terminu**, jeśli zadanie ma datę i godzinę; nie dubluje własnego na tę samą chwilę. Bez godziny, w nieudostępnionej przestrzeni i przy nawykach — nie. Z dostępem „Podgląd” (rola albo lista tylko do podglądu) własne przypomnienie ustawi uczestnik zadania albo odpowiedzialny; gdy przestanie nim być, może je tylko usunąć.
- Bez duplikatów: kanał przypomnień jest wybierany per urządzenie (M1); przypomnienie ukończonego zadania nie przychodzi (telefon przeplanowuje po synchronizacji, serwer sprawdza status w chwili wysyłki).
- Powiadomienia systemowe aplikacji: przegląd dnia (M16), koniec Pomodoro (M14), nawyki (M15).

### M9. Widok listy
Widoki stałe w pasku bocznym [W+A]:
- **Inbox** — zadania z list `inbox` (bieżącej przestrzeni lub wszystkich). Licznik w pasku bocznym i na widżecie.
- **Dziś** — sekcje: Zaległe, Dziś (z godziną: według godziny; bez godziny: kolejność ręczna), Trwające (zakres `start_date`–`due_date` obejmuje dziś), Cykliczne na dziś. Obok [W]: pasek „Plan dnia” z wydarzeniami kalendarza i blokami zadań.
- **Zaległe** [W+A] — otwarte zadania po terminie: dzisiejsze, których godzina minęła (z czasem trwania — od końca bloku), i z wcześniejszych dni; licznik w pasku bocznym (telefon: Przeglądaj → „Zaległe”). Dzisiejsze bez godziny nie są zaległe do końca dnia. Przycisk „→ Dziś” przy wierszu: termin na dziś, a godzina, która dziś już minęła, znika (seria ją zachowuje).
- **Nadchodzące** — kolejne 14 dni pogrupowane po dniu (z wirtualnymi wystąpieniami cyklicznych), przeciąganie między dniami zmienia `due_date`; dalej „Później” po tygodniach.
- Inbox, Dziś, Zaległe i Nadchodzące mają opcje widoku listy [W+A]: „Lista | Tablica” (telefon: „▦ Tablica”), „Kolumny” i — na webie — eksport XLSX; wybór w `profiles.settings.views`. Tablica pokazuje te same zadania co lista widoku (bez wirtualnych wystąpień serii i Cyklicznych); w kolumnach dni termin spoza zakresu stoi w „Wcześniej” / „Później”.
- **Projekt / lista** — drzewo zadań z podzadaniami (zwijanie), postęp, sortowanie ręczne / priorytet / termin / data dodania.
- **Tag, zapisany filtr** — wynik filtra.
- Grupowanie w każdym widoku: brak / priorytet / projekt / data / tag / status. Pokazywanie ukończonych: ukryte / dzisiejsze / wszystkie.
- Szybkie akcje: [A] przesunięcie w prawo = ukończ, w lewo = menu terminu (Dziś, Jutro, Weekend, Przyszły tydzień, Wybierz…); [W] klawisze (M17).

### M10. Kanban
- Tablica dla projektu, listy, przestrzeni lub dowolnego widoku/filtra. **Kryterium kolumn**: status (domyślnie), priorytet, dzień tygodnia (bieżący tydzień + „Bez terminu”), tag, lista.
- Przeciągnięcie karty do kolumny zmienia odpowiadający atrybut (status / priorytet / `due_date` / tag / lista); kolejność w kolumnie = `sort_key`.
- Karta: tytuł, priorytet (pasek koloru), termin, tagi, postęp podzadań, ikona cyklu i załącznika. Szybkie dodanie karty na dole kolumny (parser M13, z atrybutem kolumny).
- Zwijanie kolumn, ukrywanie „Gotowe” starszych niż 7 dni. Limity WIP i torów (swimlanes) — v1.x.
- [W] dnd-kit, obsługa klawiatury. [A] uproszczony: kolumny przewijane poziomo, przeniesienie przez długie przytrzymanie → menu „Przenieś do kolumny” (przeciąganie między kolumnami na telefonie — SHOULD, jeśli PoC-5 wykaże, że jest płynne).

### M11. Kalendarz i time-blocking
- **[W]** FullCalendar: dzień, tydzień, miesiąc. Wiersz „cały dzień” = zadania z datą bez godziny. Zadania z godziną = bloki o długości `duration_min`.
- **Time-blocking**: panel boczny z zadaniami bez godziny (Inbox, Dziś, zaległe, dowolny filtr) → przeciągnięcie na godzinę ustawia `due_date`, `due_time` i `duration_min` (szacunek albo domyślne 30 min). Rozciąganie bloku zmienia czas trwania; przeciągnięcie z powrotem do panelu usuwa godzinę.
- **Klik w puste miejsce** [W+A]: szybkie dodawanie z datą i godziną klikniętej pół godziny (wiersz „cały dzień” i miesiąc [W] — sama data); data albo godzina we wpisie zastępuje tylko swoje pole.
- Wydarzenia z kalendarzy zewnętrznych (M18) obok zadań, innym stylem, tylko do odczytu (do czasu Etapu 12). **Nakładanie się** bloku z wydarzeniem albo innym blokiem → ostrzeżenie (obramowanie + ikona) i lista konfliktów w „Dziś”.
- Wolne okna w godzinach pracy (`core/time-blocking.ts`) podświetlone w widoku dnia; „Zaplanuj automatycznie” — v1.x.
- **[A]** dzień (oś godzin, przeciąganie bloków po długim przytrzymaniu), tydzień (agenda), miesiąc (kropki + lista dnia). Wydarzenia z kalendarza telefonu (`expo-calendar`) widoczne bez serwera.

### M12. Oś czasu (Gantt) i zależności — [W]
- Wiersze: projekty (rozwijane do zadań i podzadań). Pasek zadania: `start_date` → `due_date` (bez `start_date` — jeden dzień). Pasek projektu: daty projektu albo zakres jego zadań.
- Przesuwanie paska (zmiana obu dat), **rozciąganie krawędzi** (zmiana `start_date` albo `due_date`), skala dzień / tydzień / miesiąc, linia „dziś”, przewijanie do dziś.
- **Zależności** koniec→początek (`finish_to_start`) z opóźnieniem w dniach (`lag_days`): przeciągnięcie z końca paska A na pasek B. Strzałki między paskami.
- **Naruszenie** (B zaczyna się przed końcem A + lag) → strzałka i pasek na czerwono, lista naruszeń. Przy przesuwaniu A wybór: „Przesuń zależne” (kaskadowo, zachowując odstępy) albo „Tylko to zadanie”.
- Cykl w zależnościach jest blokowany przy tworzeniu (`core/dependencies.ts`) i w triggerze.
- Ścieżka krytyczna (v1.x, zrobione 23.11.2026): przełącznik „Ścieżka krytyczna” na osi (web i telefon) wyróżnia zadania bez zapasu i zależności między nimi oraz podaje zapas pozostałych w dniach roboczych; liczona na bieżących datach (bez auto-planowania), koniec projektu = najpóźniejszy koniec jego otwartych zadań.

### M13. Szybkie dodawanie (gramatyka w §4)
- Wywołanie: [W] klawisz `Q` albo `Ctrl+Spacja` w dowolnym miejscu, przycisk „+”; [A] przycisk „+”, widżet, skrót aplikacji (long-press ikony), powiadomienie przeglądu.
- Rozpoznane fragmenty są **podświetlane na żywo** i pokazywane jako chipy (data, godzina, czas trwania, lista/przestrzeń, tagi, priorytet, cykliczność, przypomnienie). Klik w chip cofa rozpoznanie (fragment wraca do tytułu).
- Enter = dodaj i zamknij; `Ctrl+Enter` [W] = dodaj i pisz kolejne. Wklejenie wielu linii = wiele zadań (z pytaniem).
- Bez wskazanej listy zadanie trafia do Inbox bieżącej przestrzeni; w widoku listy/projektu/kolumny kanbanu — tam, skąd wywołano.
- Parser działa lokalnie (offline) w `core/quick-add.ts`; ten sam w temacie maila (M19).

### M14. Tryb skupienia
- Pełny ekran z jednym zadaniem: tytuł, opis, podzadania do odhaczania, timer. Wejście z menu zadania, palety poleceń albo klawisza `F` [W].
- **Pomodoro**: praca 25 min, przerwa 5 min, długa przerwa 15 min co 4 cykle (konfigurowalne); albo stoper bez limitu. Dźwięk i powiadomienie na koniec etapu.
- Każdy etap pracy zapisuje `time_entries` (początek, koniec, rodzaj). Zadanie pokazuje „spędzono 1 h 20 min / szac. 2 h”; statystyki tygodnia per przestrzeń/projekt.
- Stan timera = znaczniki czasu, nie odliczanie w pamięci: zamknięcie karty/aplikacji nie gubi czasu. [A] trwałe powiadomienie z pozostałym czasem i przyciskami Pauza/Stop, ekran nie gaśnie (`expo-keep-awake`).
- Jeden aktywny timer na użytkownika — widoczny na drugim urządzeniu po synchronizacji.

### M15. Cykliczne (nawyki)
- Nawyk = zadanie o `kind = 'habit'` z regułą cykliczności (codziennie, w wybrane dni, N razy w tygodniu/miesiącu) i opcjonalnym celem ilościowym (np. 8 szklanek). W aplikacji nazwa „Cykliczne” (od 24.11.2026; zwykła seria to „zadanie z powtarzaniem”). Sekcja „Cykliczne” [W+A] i blok w „Dziś”.
- Odhaczenie dnia = wpis `task_completions` (z wartością dla celu ilościowego); można uzupełnić wstecz (ostatnie 7 dni) i oznaczyć dzień wolny (`skipped` — nie przerywa passy).
- Statystyki: bieżąca i najdłuższa passa, regularność 7/30/90 dni, mapa cieplna roku, wykres tygodniowy. Liczone w `core/habits.ts` (§7.5).
- Przypomnienie o nawyku (godzina) i odhaczanie z powiadomienia i widżetu.

### M16. Przegląd dnia / tygodnia
- **Przegląd dnia** (wieczorem albo rano, godzina w ustawieniach, powiadomienie): asystent pokazuje po kolei zaległe i dzisiejsze nieukończone zadania. Na każde: Ukończ / Dziś / Jutro / Wybierz datę / Kiedyś (bez terminu) / Usuń. [W] klawisze 1–6, [A] przesunięcia i przyciski. Na końcu: podsumowanie (ukończone dziś, przeniesione) i podgląd planu na jutro (z kalendarzem).
- **Przegląd tygodnia** (dzień i godzina w ustawieniach): kroki — Inbox do zera, zaległe, projekty bez następnego kroku (brak otwartego zadania z terminem), zadania „Oczekuje” dłużej niż 7 dni, nadchodzący tydzień w kalendarzu, nawyki tygodnia.
- Kolejka liczona w `core/review.ts`; sesje zapisywane w `review_sessions` (statystyki: ile przeniesionych, ile razy przeniesiono to samo zadanie — zadania przenoszone ≥ 3 razy są oznaczane do decyzji).

### M17. Wyszukiwarka i paleta poleceń
- **Paleta** `Ctrl+K` [W] (na [A]: ikona szukania z tymi samymi wynikami): zadania (tytuł, opis, tagi, nazwa listy), listy, przestrzenie, tagi, filtry, widoki i **akcje** („Przenieś do…”, „Ustaw priorytet…”, „Zaplanuj na jutro”, „Tryb skupienia”, „Nowy projekt”, „Przełącz przestrzeń”, „Przegląd dnia”, „Motyw ciemny”). Akcje działają na zaznaczonych zadaniach.
- Wyszukiwanie lokalne: SQLite FTS5 (`unicode61 remove_diacritics 2` — „zolw” znajduje „żółw”), prefiksy, ranking (tytuł > tagi > opis), ostatnio używane na górze. Ten sam kod na webie i telefonie, działa offline.
  - Zrobione (19.11.2026) w `core/search.ts` bez FTS5: indeks w pamięci (`buildSearchIndex`, `search`) — normalizacja bez ogonków i „ł”, każde słowo zapytania pasuje do początku słowa (środek słowa od 3 znaków, słabiej), wagi tytuł 10 > tagi 6 > słowa kluczowe akcji 5 > lista 4 > opis 2, zamknięte niżej, premia za ostatnie użycie, podświetlenia w tytule; 5 000 pozycji < 15 ms. FTS5 tylko, jeśli zabraknie wydajności (zawężenie kandydatów). Polecenia palety i skróty: `core/commands.ts` (`COMMANDS`, `LIST_SHORTCUTS`, `commandSearchItems`).
- **Skróty [W]**: `Q` szybkie dodawanie, `Ctrl+K` paleta, `/` szukaj, `G` potem `I`/`T`/`Z`/`U`/`K`/`C`/`O` — Inbox/Dziś/Zaległe/Nadchodzące/Kanban/Kalendarz/Oś czasu, `J`/`K` następne/poprzednie zadanie, `E` ukończ, `1`–`4` priorytet, `T` dziś, `M` jutro, `D` wybór daty, `F` tryb skupienia, `Del` kosz, `?` lista skrótów. Lista skrótów w `core` (etykiety), obsługa w `apps/web`.

### M18. Kalendarze zewnętrzne
- **Odczyt** (Etap 5):
  - **ICS** (adres subskrypcji z Google/Outlook) — pobierany przez `calendar-sync` co 15 min,
  - **Google Calendar API** — OAuth (zakres tylko do odczytu na tym etapie), lista kalendarzy do wyboru, synchronizacja przyrostowa (`syncToken`), powiadomienia `watch` na webhook Edge Function, odnawianie kanałów codziennie,
  - **kalendarz telefonu** (`expo-calendar`) — tylko na telefonie, bez serwera (obejmuje każde konto zsynchronizowane z Androidem, także firmowe).
- Wydarzenia (`calendar_events`) w oknie −30…+180 dni, synchronizowane serwer → klient (tylko odczyt), widoczne w kalendarzu, w „Dziś” i w ostrzeżeniach o nakładaniu się.
- **Dwukierunkowo** (Etap 12, Google): w koncie Google powstaje osobny kalendarz „Task Planner”. Zadania z godziną → wydarzenia (`extendedProperties.private.taskId`); zmiana godziny/długości/tytułu w Google → zmiana zadania (jako operacja z HLC serwera, §6); usunięcie wydarzenia → zadanie traci godzinę (nie jest usuwane). Pętle zmian wykluczone przez porównanie `etag` i znacznik źródła zmiany.
- Microsoft 365 / Outlook przez Graph API — v1.x albo wcześniej, jeśli kalendarz firmowy jest w Microsoft 365 (D8).
- Tokeny OAuth tylko na serwerze (Supabase Vault), nigdy w przeglądarce ani w APK.

### M19. Przechwytywanie treści
- **E-mail → Inbox** (v1.x, D9): adres `zadania+<token>@<domena>`; Cloudflare Email Routing → Email Worker (parsowanie MIME) → Edge Function `inbound-email` (sekret współdzielony). Zadanie: tytuł = temat bez „Fwd:/Re:/PD:/Odp:” (z parserem M13 — „Faktura za prąd jutro #dom !2” działa), opis = treść tekstowa (Markdown, przycięte stopki i cytaty), załączniki → Storage, `source = {kind:'email', from, messageId, receivedAt}`.
  - Akceptowane tylko wiadomości z adresów z listy nadawców w ustawieniach + poprawny token; token można wygenerować na nowo. Odrzucone trafiają do dziennika `inbound_messages`.
- **Link → zadanie**: [A] udostępnianie z dowolnej aplikacji (`expo-share-intent`) otwiera szybkie dodawanie z URL; [W] PWA Web Share Target (Chrome na Androidzie), bookmarklet i wklejenie samego URL w szybkie dodawanie. Tytuł strony z `link-preview` (gdy offline — URL jako tytuł, uzupełnienie po synchronizacji).
- Zaznaczony tekst udostępniony do aplikacji → zadanie z tym tekstem w opisie.

### M20. Offline, PWA, widżety
- **Offline**: wszystkie funkcje poza: odświeżeniem kalendarzy zewnętrznych, przyjęciem maila (przychodzi po synchronizacji), podglądem linków, pobraniem niezbuforowanych załączników. Wskaźnik stanu: „Offline — N zmian czeka”.
- **PWA**: manifest z ikonami i skrótami (Szybkie dodawanie, Dziś, Kalendarz), Service Worker z powłoką aplikacji, `navigator.storage.persist()` (ochrona lokalnej bazy przed wyczyszczeniem), instalacja na pulpicie (Chrome/Edge).
- **Widżety Android** (Etap 11): „Dziś” (lista do 10 zadań, odhaczanie bez otwierania aplikacji), „Szybkie dodawanie” (przycisk + mikrofon klawiatury), „Cykliczne” (dzisiejsze nawyki do odhaczenia). Dane z lokalnej bazy; odświeżanie po zmianie danych i co 30 min. Skróty aplikacji (long-press ikony): Dodaj zadanie, Dziś, Tryb skupienia.
- **Pulpit**: zainstalowana PWA + skróty. Natywny widżet pulpitu i globalny skrót klawiszowy — v1.x (Tauri, D11).

### M21. Integracje wychodzące (pluginy) — v1.x [W], [A] tylko wyzwalacz ręczny
Projekt z 21.11.2026 (D21), etap w `PLAN_ETAPOWY.md` → v1.x. Kierunek jednokierunkowy: **zdarzenie w Task Plannerze → akcja w systemie zewnętrznym** (issue w GitLab/Jira, wiadomość na Slacku/Teams, e-mail, dowolny webhook). Dwukierunkowość później (niżej).

- **Wyzwalacz działa tylko na serwerze.** Klienci pracują offline, więc reguła odpalona na urządzeniu odpaliłaby się z opóźnieniem, na dwóch urządzeniach dwa razy, a tokeny systemów zewnętrznych musiałyby trafić do przeglądarki/APK. Zdarzenie powstaje, gdy zmiana dotrze do Postgresa przez `push_changes` (albo przez `create_integration_task` / `calendar_task_apply`) — ten sam wzorzec co wysyłka zadań do Google w Etapie 12 (trigger → `pg_net` raz na transakcję → Edge Function z dzierżawą, `pg_cron` jako zabezpieczenie).
- **Trzy rodzaje wyzwalaczy:**
  - **zmiana zadania** — zdarzenia semantyczne (niżej) + filtr,
  - **ręczny** — „Wyślij do…” w menu zadania, w palecie (`plugin.send`) i na telefonie; klient zapisuje wiersz `plugin_requests` przez `mutate` (działa offline jak każda zmiana, wysyłka po synchronizacji),
  - **czasowy** — reguła z godziną i dniami (podzbiór RRULE z `recurrence.ts`), np. „codziennie 8:00 lista Dziś na Slacka”; liczona przez `pg_cron` co minutę na widokach z `core/views.ts`.
- **Zdarzenia** (`core/plugins/events.ts`, `pluginEvents(before, after)` na rzucie zadania — czysty TS, testy Vitest): `task.created`, `task.completed`, `task.reopened`, `task.deleted`, `task.restored`, `task.moved` (lista / przestrzeń), `task.tagged`, `task.untagged`, `task.due_changed`, `task.assigned`, `task.commented`. Zdarzenie wynika z **przejścia stanu po scaleniu na serwerze**, nie z pojedynczej operacji — kolejność i liczba urządzeń nie mają znaczenia. Ukończenie wystąpienia serii nie zmienia `tasks.status` (dochodzi wiersz `task_completions`, termin się przesuwa), więc `task.completed` pochodzi też z wstawienia do `task_completions` (z `occurrence` w ładunku).
- **Reguła** = „Gdy [wyzwalacz] i [filtr] → [akcja przez połączenie]”. Filtr = istniejący `FilterQuery` (listy, przestrzenie, tagi, priorytet, odpowiedzialny…), dopasowanie tą samą funkcją co zapisane filtry. Opcje: opóźnienie (domyślnie 20 s), „także dla zadań z integracji” (domyślnie nie — ochrona przed pętlami z e-mailem / kalendarzem), „uruchom teraz dla pasujących” przy tworzeniu (bez tego reguła działa tylko na zmiany od chwili utworzenia).
- **Plugin** = moduł wkompilowany w Edge Function, nie kod ładowany w locie (bezpieczeństwo sekretów w Vault, bundlowanie Edge Functions). Opis w core (`core/plugins/catalog.ts`: `id`, nazwa, `configSchema`, `secretFields`, `actionSchema`, obsługiwane zdarzenia — z tego UI buduje formularze), wykonanie w `supabase/functions/_shared/plugins/<id>.ts`:
  ```ts
  interface PluginRuntime<Config, Action> {
    test(ctx): Promise<DeliveryResult>;                     // „Wyślij próbne”
    deliver(ctx, delivery, action): Promise<DeliveryResult>;
  }
  type DeliveryResult =
    | { ok: true; externalId?: string; externalUrl?: string }
    | { ok: false; retryable: boolean; retryAfterSec?: number; disable?: boolean; error: string };
  ```
  Pierwszy plugin to **Webhook** (podpisany JSON pod dowolny adres; obok `task` zawsze obiekt `fields` ze wszystkimi polami szablonów) — przez n8n / Make / Zapier pokrywa każdy system bez kodu. Natywne pluginy (Slack, GitLab, Jira, e-mail) tylko tam, gdzie daje to wygodę (wybór projektu z listy, link do utworzonego issue); kolejność do wyboru przy starcie etapu.
- **Szablony** (`core/plugins/template.ts`, `renderTemplate`): pola `{{title}}`, `{{description}}`, `{{due}}`, `{{time}}`, `{{priority}}`, `{{list}}`, `{{workspace}}`, `{{tags}}`, `{{assignee}}`, `{{url}}` (link do zadania w aplikacji webowej), `{{event}}`; bez logiki, ucieczka znaków według celu (JSON / Markdown / Slack). Podgląd reguły pokazuje dokładny ładunek dla wybranego zadania — treść zadania wychodzi poza system świadomie.
- **Dostarczanie** (Edge Function `plugins`): trigger na `tasks` / `task_tags` / `task_completions` / `task_comments` / `plugin_requests` zapisuje do `plugin_outbox` (rzut przed / po, pochodzenie zmiany) **tylko gdy któryś członek zakresu ma włączoną regułę zdarzeniową** — inaczej zero kosztu; `pg_net` woła `plugins/flush` raz na transakcję, `plugins/cron/tick` co minutę (ponowienia, reguły czasowe, zgubione wywołania). Przebieg: dopasuj reguły → utwórz `plugin_deliveries` z deterministycznym id (UUIDv5 z reguły, zadania, zdarzenia i `row_version` / id prośby) → po opóźnieniu **połącz zdarzenia tego samego zadania i reguły z okna** w jedną wysyłkę, **sprawdź warunek ponownie na bieżącym stanie** (ukończenie cofnięte „Cofnij” w ciągu kilku sekund → `skipped`), sprawdź, czy właściciel reguły nadal ma dostęp do zakresu zadania → `deliver()`.
  - Gwarancja „co najmniej raz”: id dostawy jako `Idempotency-Key`; webhook dostaje też `X-TaskPlanner-Timestamp` i `X-TaskPlanner-Signature: sha256=<HMAC(sekret, timestamp + "." + treść)>`.
  - 2xx = wysłane; 429 / 5xx / przekroczenie czasu (10 s) = ponowienie (1 min, 5 min, 30 min, 2 h, 12 h, potem `dead`); inne 4xx = `failed` bez ponowień; 401 / 403 / 410 = połączenie przechodzi w `error` (wyłączone) z komunikatem w Ustawieniach i Web Push „Integracja … wyłączona”.
  - Limit wysyłek na połączenie (domyślnie 60 / min, nadmiar czeka), przebieg pod dzierżawą jak `calendar_task_runs`.
- **Ustawienia → „Integracje”** [W]: połączenia (dodaj z formularza pluginu, sekret trafia od razu do Edge Function → Vault, „Wyślij próbne”, wyłącz, usuń = usunięcie sekretu), reguły (kreator „Gdy … i … → …” z podglądem ładunku, włącz / wyłącz), historia wysyłek z błędem, linkiem do utworzonego obiektu i „Ponów”. [A]: „Wyślij do…” i lista reguł do włączania / wyłączania; edycja reguł później. Historia wysyłek wymaga sieci (wyjątek M20).
- **Później — dwukierunkowo**: `external_id` / `external_url` zapisywane w `plugin_deliveries` od początku; kierunek zwrotny (zmiana issue → zadanie) = tabela powiązań zadanie ↔ obiekt zewnętrzny i operacje z HLC serwera, jak `calendar_task_links` w Etapie 12.

---

## 4. Szybkie dodawanie — gramatyka (`core/quick-add.ts`)

`parseQuickAdd(text, ctx) → { title, fields, tokens[] }`; `ctx` = teraz, strefa, pierwszy dzień tygodnia, listy i przestrzenie (nazwy), tagi. `tokens` to zakresy znaków z rodzajem (do podświetlania i cofania rozpoznania). Wielkość liter i polskie znaki bez znaczenia („sroda” = „środa”). Rozpoznawane tylko całe słowa.

| Rodzaj | Przykłady | Wynik |
|---|---|---|
| Data względna | `dziś`, `dzisiaj`, `jutro`, `pojutrze`, `za 3 dni`, `za tydzień`, `za 2 tygodnie`, `za miesiąc` | `due_date` |
| Dzień tygodnia | `pon`, `w poniedziałek`, `we wtorek`, `w środę`, `w przyszły piątek`, `w następną sobotę`, `w weekend` (sobota) | najbliższy taki dzień (dziś, jeśli dziś i godzina jeszcze nie minęła) |
| Data | `21.11`, `21.11.2026`, `21/11`, `21 lis`, `21 listopada`, `koniec tygodnia`, `koniec miesiąca` | `due_date` (bez roku: najbliższa przyszła) |
| Godzina | `o 10`, `o 10:00`, `o 10.30`, `10:30`, `o 7 rano`, `o 8 wieczorem`, `w południe` | `due_time` (`o 8 wieczorem` = 20:00) |
| Zakres godzin | `10-11:30`, `od 10 do 12` | `due_time` + `duration_min` |
| Czas trwania | `~30m`, `~1h`, `~1h30`, `~1,5h`, `przez 45 min`, `przez 2 godziny` | `duration_min` |
| Priorytet | `!1`–`!4`, `!krytyczny`, `!wysoki`, `!średni`, `!niski` | `priority` |
| Lista / przestrzeń | `#dom`, `#remont-kuchni`, `#"Remont kuchni"` | gdy nazwa pasuje do listy/projektu (najpierw w bieżącej przestrzeni) albo przestrzeni (→ jej Inbox) |
| Tag | `#telefon` (gdy brak listy/przestrzeni o tej nazwie), `@telefon` (zawsze tag) | `tags` (nowy tag tworzony po potwierdzeniu chipa) |
| Cykliczność | `codziennie`, `w dni robocze`, `co tydzień`, `co 2 tygodnie`, `co drugi wtorek`, `w każdy poniedziałek`, `co miesiąc`, `drugi wtorek miesiąca`, `ostatniego dnia miesiąca`, `co roku`, `co 3 dni po ukończeniu`, `3 dni po wykonaniu` | `recurrence` (§7.2) |
| Przypomnienie | `przypomnij 15 min przed`, `przypomnij o 9`, `^15m`, `^9:00` | `reminders` |
| Literał | `\jutro` | słowo zostaje w tytule |

Zasady:
- `#nazwa` — dopasowanie dokładne, potem bez polskich znaków, potem prefiks jednoznaczny; remis = chip z wyborem.
- Fragmenty muszą mieć pełną formę — `za prąd`, `za mało` nie są datą (po `za` musi być liczba lub jednostka), `2 jutrzenki` nie jest datą, `Mazda 6` nie jest godziną (godzina tylko po `o`/`od` albo w formacie `GG:MM`).
- Po usunięciu rozpoznanych fragmentów tytuł jest przycinany (podwójne spacje, przyimki na końcu: „w”, „we”, „o”).
- Przykład ze specyfikacji: `Zapłacić rachunek za prąd jutro o 10:00 #dom !wysoki` → tytuł „Zapłacić rachunek za prąd”, `due_date` = jutro, `due_time` = 10:00, przestrzeń/lista „Dom” (jej Inbox, jeśli „Dom” to przestrzeń), `priority` = 2.
- Korpus testowy `fixtures/quick-add.jsonl` (≥ 150 przypadków, w tym pułapki) jest testem regresji (Vitest) — kryterium PoC-2.
- Ten sam moduł opisuje reguły po polsku (`describeRecurrence`) — opis musi dać się z powrotem sparsować do tej samej reguły (test „tam i z powrotem”).

Ustalenia z PoC-2 i PoC-3 (v0.2):
- Seria z godziną zaczyna się od pierwszego wystąpienia, którego godzina jeszcze nie minęła („Trening codziennie o 7 rano” o 12:00 → jutro).
- `o N` przed słowem w miejscowniku liczby mnogiej (`-ach`, `-ych`, `-ich`) to nie godzina („Ankieta o 15 pytaniach”).
- Data `D.M` wymaga dwucyfrowego miesiąca albo roku: „5.01” i „2.3.2027” są datami, „wersja 2.3” nie.
- Pełna nazwa dnia tylko z „w/we” albo „w przyszły/przyszłą”; bez przyimka tylko skróty (`pon`, `wt`, `śr`, `czw`, `pt`, `sob`, `nd`).
- Dodatkowe formy: „do końca tygodnia/miesiąca”, „na koniec …”, „ostatni piątek miesiąca” (`BYDAY=-1FR`), „co 3 miesiące” (`INTERVAL`), „każdego 10. dnia miesiąca”, „15. i ostatniego dnia miesiąca”, „co 3 miesiące, 30. dnia”.
- „co miesiąc” bez daty → dzień miesiąca z dzisiejszej daty, „co tydzień” bez dnia → dzisiejszy dzień tygodnia.
- Przyimek („w”, „we”, „o”, „na”) i myślnik na początku albo końcu tytułu są usuwane.
- Cofnięte rozpoznania trzymane w stanie pola (MVP-2), a nie jako `\` w tekście.
- Korpus (99 przypadków, 100 %) pisany ręcznie; przed MVP-2 dopisać prawdziwe zadania użytkownika (D13).

---

## 5. Model danych (Postgres)

### Konwencje
- `id uuid` — UUIDv7 generowany przez klienta (zapis offline, idempotentny).
- Wspólne kolumny każdej synchronizowanej tabeli: `scope_id` (zakres synchronizacji), `created_at`, `updated_at` (serwer), `created_by`, `deleted_at` (miękkie usunięcie), `row_version bigint` (trigger), `field_clock jsonb` (HLC ostatniej zmiany każdego pola, §6). Dodawane pętlą w jednej migracji (jak `mvp1_access.sql` w EP); nowa tabela trafia do tablicy tabel synchronizowanych i do `synced_tables()`.
- **Czas zadań = data i godzina pływające** (`date`, `time` — czas ścienny użytkownika), bo „o 10:00” znaczy 10:00 tam, gdzie akurat jestem. Opcjonalna `time_zone` przy zadaniu przypina je do strefy (np. telekonferencja z innym krajem). Zdarzenia rzeczywiste (ukończenie, czas pracy, wydarzenia z kalendarzy) to `timestamptz`.
- Kolejność ręczna: `sort_key text` (klucze ułamkowe) w obrębie rodzica i listy; na tablicy kanbanu z kilku list `board_sort_key` (D15).
- `due_time` jako tekst `GG:MM` (typ `time` w JSON daje `GG:MM:SS`).
- **Zakres = przestrzeń albo zakres osobisty** (PoC-1): tabele przestrzeni nie mają kolumny `workspace_id` — `scope_id` = id przestrzeni. Zakres osobisty ma id = id użytkownika i powstaje triggerem na `auth.users`. `scope_id` zadań, tagów zadań i ukończeń jest **wyliczany** na serwerze (z listy / zadania) i klient go nie wysyła; lista podzadania wynika z rodzica.
- `jsonb` walidowane schematami Zod z `packages/core/src/schemas` (camelCase).
- Schematy wierszy i `jsonb` (19.11.2026): `packages/core/src/schemas/model.ts` — `MODEL` (wiersz po nazwie tabeli, kolumny snake_case z ograniczeniami migracji i regułami między polami), `ProfileSettings` (`parse({})` = domyślne), `ViewPrefs`, `TaskSource`, `AttachmentPreview`, `PushSubscriptionJson`. Test w `packages/sync` pilnuje, że wiersze tabel synchronizowanych mają dokładnie kolumny `TABLES` + `id`. `devices.reminder_channel` = `enabled`/`disabled` (czy urządzenie dostaje przypomnienia).

### Tabele — konto i struktura
| Tabela | Najważniejsze kolumny | Uwagi |
|---|---|---|
| `profiles` | `id` (= id użytkownika), `display_name`, `settings jsonb` (`ProfileSettings`, z flagą `onboarded`), `focus jsonb` (`FocusState` — aktywny timer skupienia, `null` = brak; Etap 7), `calendar_sync jsonb` (`CalendarSync` — konto Google z kalendarzem „Task Planner” i wysyłane przestrzenie, `null` = wyłączone; Etap 12); `inbox_token`, `inbound_senders text[]` dojdą razem z e-mailem (v1.x, D9) | zakres osobisty; powstaje triggerem razem z kontem (MVP-1) |
| `devices` | `id`, `user_id`, `name`, `platform` (`web`/`android`), `reminder_channel`, `push_subscription jsonb`, `last_sync_at` | |
| `sync_scopes` | `id`, `kind` (`workspace`/`personal`), `owner_id`, `sync_version bigint` | licznik zakresu; Realtime subskrybuje te wiersze |
| `workspaces` | `id` (= `scope_id`), `name`, `color`, `icon`, `sort_key`, `archived_at` | jedna przestrzeń = jeden zakres |
| `scope_members` | `scope_id`, `user_id`, `role` (`owner`; `editor`/`viewer` w v1.x) | podstawa RLS; także zakres osobisty |
| `lists` | `id`, `scope_id` (= przestrzeń), `kind` (`inbox`/`project`/`list`), `name`, `color`, `icon`, `description_md`, `start_date`, `end_date`, `project_status`, `sort_key`, `view_prefs jsonb`, `archived_at` | unikalny `inbox` na przestrzeń; zarchiwizowana lista znika z paska, zadania zostają (MVP-1) |

### Tabele — zadania
| Tabela | Najważniejsze kolumny | Uwagi |
|---|---|---|
| `tasks` | `id`, `scope_id` (wyliczany), `list_id`, `parent_id`, `kind` (`task`/`habit`), `title`, `description_md`, `status`, `priority smallint 1–4`, `start_date`, `due_date`, `due_time`, `duration_min`, `time_zone`, `recurrence jsonb` (`Recurrence`), `habit jsonb` (`HabitGoal`), `completed_at`, `sort_key`, `board_sort_key` (D15), `source jsonb` (`TaskSource`: ręcznie / szybkie dodawanie / e-mail / link / kalendarz), `postpone_count`, `assignee_id` → `collaborators` (v1.x; `null` = twórca) | trigger: głębokość ≤ 4, brak cyklu `parent_id`, zakres zgodny z listą i rodzicem |
| `tags` | `id`, `name`, `color`, `sort_key`, `workspace_ids` (jsonb, v1.x) | zakres osobisty; `workspace_ids` = przestrzenie, w których tag się pokazuje (`null` = wszystkie); unikalny `lower(name)`; id = UUIDv5 z nazwy bez polskich znaków (`tagId`), więc ten sam tag z dwóch urządzeń to jeden wiersz |
| `task_tags` | `id` (UUIDv5 z `task_id`+`tag_id`), `task_id`, `tag_id` | wiersz łączący z `deleted_at` — dodanie tagu na dwóch urządzeniach nie gubi żadnego |
| `reminders` | `id`, `task_id`, `kind` (`relative`/`absolute`), `offset_min`, `at_date`, `at_time` | |
| `task_dependencies` | `id`, `predecessor_id`, `successor_id`, `kind` (`finish_to_start`), `lag_days` | trigger: brak cyklu, ta sama przestrzeń |
| `task_completions` | `id` (UUIDv5 z `task_id`+`occurrence_date`), `task_id`, `occurrence_date`, `kind` (`done`/`skipped`), `value numeric`, `completed_at timestamptz` | **tylko dopisywane**; ten sam id z dwóch urządzeń = jeden wpis |
| `time_entries` | `id`, `task_id`, `kind` (`focus`/`break`/`manual`), `started_at`, `ended_at`, `pomodoro_index` | tylko dopisywane (zamknięcie wpisu = ustawienie `ended_at`) |
| `attachments` | `id`, `task_id`, `kind` (`file`/`link`), `storage_path`, `name`, `mime`, `size_bytes`, `url`, `preview jsonb` | pliki w Storage, poza strumieniem synchronizacji |
| `collaborators` | `id`, `name`, `email`, `acronym` (1–5 znaków, znaczek przy zadaniu; brak = inicjały), `archived_at` (status: `null` = aktywny), `workspace_ids` (jsonb) | v1.x; zakres osobisty (książka adresowa); id = UUIDv5 z nazwy (`collaboratorId`), jak tagi; tylko informacyjnie — bez dostępu; nieaktywni nie podpowiadają się przy zadaniach; `workspace_ids` = przestrzenie, w których osoba się podpowiada (`null` = wszystkie, jak `tags.workspace_ids`; core `collaboratorsForWorkspace`) |
| `task_participants` | `id` (UUIDv5 z `task_id`+`collaborator_id`), `task_id`, `collaborator_id` | v1.x; wiersz łączący jak `task_tags`; trigger: współpracownik z zakresu z prawem zapisu (TP003) |
| `task_comments` | `id`, `task_id`, `body` (1–10 000 znaków), `posted_at timestamptz` (z klienta — offline), `edited_at` | v1.x; autor = `created_by` |
| `saved_filters` | `id`, `name`, `icon`, `query jsonb` (`FilterQuery`), `sort_key` | zakres osobisty |
| `review_sessions` | `id`, `kind` (`daily`/`weekly`), `started_at`, `finished_at`, `stats jsonb` | |

### Tabele — integracje (tylko serwer → klient)
| Tabela | Najważniejsze kolumny | Uwagi |
|---|---|---|
| `calendar_accounts` | `id`, `user_id`, `provider` (`google`/`microsoft`/`ics`), `label`, `secret_id` (Vault), `sync_state jsonb`, `status` | tokeny i adres ICS w Vault; kolumny sekretów niewidoczne dla klientów |
| `calendars` | `id`, `account_id`, `external_id`, `name`, `color`, `visible`, `is_task_target` | |
| `calendar_events` | `id`, `calendar_id`, `external_id`, `title`, `start_at`, `end_at`, `all_day`, `location`, `etag`, `task_id` | okno −30…+180 dni; zakres osobisty; bez wydarzeń kalendarza „Task Planner” (`is_task_target` — to zadania) |
| `calendar_task_links` | `calendar_id`, `task_id`, `external_id`, `etag`, `pushed jsonb` (rzut zadania w chwili ostatniej zgodności) | tylko serwer (Etap 12): zadanie ↔ wydarzenie kalendarza „Task Planner”, podstawa scalania trójstronnego; `calendar_task_runs` — dzierżawa uzgadniania kalendarza |
| `inbound_messages` | `id`, `user_id`, `received_at`, `from_addr`, `subject`, `status` (`created`/`rejected`), `task_id`, `reason` | dziennik, bez treści; unikalny Message-ID |
| `oauth_states` | jednorazowy `state` OAuth (15 min) | PoC-6 |
| `inbound_addresses` | token i nadawcy adresu e-mail | **tymczasowa z PoC-6** — przechodzi do `profiles` w v1.x razem z e-mailem (D9; decyzja 2026-11-19) |
| `reminder_deliveries` | `id` (identity), `user_id`, `device_id`, `fire_key` (`<id przypomnienia>:<dzień wystąpienia>`), `task_id`, `fire_at`, `status` (`claimed`/`sent`/`failed`/`skipped`), `attempts`, `sent_at`, `error`; unikalne (`device_id`, `fire_key`) | dziennik wysyłek Web Push (MVP-4): `reminders-push` co minutę liczy należne przypomnienia z `core/reminders.ts` i zajmuje każdą wysyłkę wierszem (`claim_reminder_deliveries`) — bez duplikatów; subskrypcja przeglądarki w `devices.push_subscription`. Zastąpił tymczasowe `push_subscriptions` i `push_queue` z PoC-6 |
| `client_errors` | `id` (identity), `user_id`, `fingerprint`, `day`, `kind` (`error`/`unhandled`/`render`/`sync`/`rejected`), `platform`, `app_version`, `message`, `stack`, `url`, `user_agent`, `context`, `count`, `first_at`, `last_at`, `received_at`; unikalne (`user_id`, `fingerprint`, `day`) | Dziennik błędów aplikacji (D20, Etap 13), niesynchronizowany: klient pisze tylko przez `report_client_errors`, czyta własne wiersze |
| `activity_log` | `id` (identity), `scope_id`, `table_name`, `row_id`, `changes jsonb`, `device_id` (węzeł HLC zmiany), `actor_id`, `at` | historia zmian zadań (M3) z triggera; tylko odczyt, poza strumieniem synchronizacji (MVP-1) |
| `plugin_connections` | `id`, `user_id`, `plugin` (`webhook`/`slack`/`gitlab`/`jira`/`email`), `label`, `config jsonb` (bez sekretów, schemat pluginu), `secret_id` (Vault), `status` (`active`/`disabled`/`error`), `last_error`, `row_version` | M21 (v1.x); tylko do odczytu w `pull_changes` (jak `calendar_accounts`), pisze Edge Function `plugins` |
| `plugin_outbox` | `id` (identity), `scope_id`, `table_name`, `row_id`, `task_id`, `before jsonb`, `after jsonb`, `origin` (`client`/`integration`), `created_at`, `processed_at` | M21; tylko serwer, wypełniany triggerami w transakcji zmiany, czyszczony po przetworzeniu |
| `plugin_deliveries` | `id` (UUIDv5), `user_id`, `rule_id`, `connection_id`, `task_id`, `events text[]`, `payload jsonb` (obcięty), `status` (`pending`/`sending`/`sent`/`skipped`/`failed`/`dead`), `attempts`, `next_attempt_at`, `sent_at`, `external_id`, `external_url`, `error` | M21; niesynchronizowana — klient czyta własne wiersze (online), „Ponów” przez RPC `retry_plugin_delivery`; retencja 30 dni (`pg_cron`); dzierżawa w `plugin_runs` |

Ustalenia z PoC-6: tabele integracji mają `user_id` (= zakres osobisty) i `row_version`; każdy zapis podbija `sync_scopes.sync_version` (sygnał Realtime), a w `pull_changes` dochodzą w Etapie 5 jako tylko do odczytu. Wydarzenie całodniowe ma daty pływające `start_date`/`end_date` (koniec bez włączenia, jak w iCalendar); `start_at`/`end_at` tylko dla wydarzeń z godziną. Zadanie z integracji dostaje HLC serwera w `field_clock` każdego pola (`create_integration_task`).

Pluginy (M21) dodają też dwie zwykłe tabele synchronizowane w zakresie osobistym: `plugin_rules` (`id`, `name`, `connection_id`, `enabled`, `trigger jsonb` — `{kind:'event', events, filter: FilterQuery}` / `{kind:'schedule', rule, time, view}` / `{kind:'manual'}`, `action jsonb` — schemat pluginu z szablonami, `options jsonb` — opóźnienie, zadania z integracji, `sort_key`) i `plugin_requests` (tylko dopisywane: `id`, `rule_id`, `task_id`, `requested_at` — wyzwalacz ręczny offline). Nowe tabele zmieniają `SYNCED_SCHEMA` (jednorazowe pobranie od zera na każdym kliencie).

### Uprawnienia (RLS)
- Dostęp do wiersza: `scope_id` należy do zakresu, w którym użytkownik jest członkiem (`scope_members`, także zakres osobisty). Jedna funkcja `has_scope_access(scope_id)` (SECURITY DEFINER, stabilna) w politykach wszystkich tabel.
- Zapisy synchronizowanych tabel **tylko przez RPC `push_changes`** (bez bezpośrednich `insert/update` z klienta) — jedno miejsce walidacji i scalania. Odczyt przez `pull_changes`; bezpośredni `select` dozwolony (np. narzędzia), zgodny z RLS.
- Integracje (`calendar_*`, `inbound_messages`) pisze tylko `service_role` w Edge Functions.
- **Jawne granty w migracjach** (PoC-6): nowy projekt w chmurze nie nadaje ról API do tabel z migracji (lokalny stack nadaje), więc każda migracja z tabelą zawiera `grant` dla `authenticated` / `service_role`. Uprawnienia kolumn (sekrety, `sync_state`) sprawiają, że klient wymienia kolumny zamiast `select('*')`.
- Storage: bucket `attachments` prywatny, polityka po pierwszym segmencie ścieżki (`user_id`) i dostępie do zadania.
- Testy pgTAP: macierz (właściciel / obcy użytkownik / anonim) × (odczyt / `push_changes` / `pull_changes`) dla każdej tabeli + próby zapisu do cudzego `scope_id`.

---

## 6. Synchronizacja i offline (`packages/sync`)

| Klasa danych | Kierunek | Strategia konfliktów |
|---|---|---|
| Struktura i zadania (`workspaces`, `lists`, `tasks`, `tags`, `task_tags`, `reminders`, `task_dependencies`, `attachments`, `saved_filters`, `profiles`, `devices`) | klient ↔ serwer | **LWW per pole** z HLC; miękkie usunięcia jako pole `deleted_at` (też LWW) |
| Ukończenia cykli, wpisy czasu, sesje przeglądu (`task_completions`, `time_entries`, `review_sessions`) | klient ↔ serwer | tylko dopisywane, identyfikatory deterministyczne (UUIDv5) tam, gdzie dwa urządzenia mogą zapisać „to samo” |
| Kalendarze zewnętrzne, dziennik maili | serwer → klient | migawka + przyrosty |
| Pliki załączników | osobno (Storage) | plik niezmienny; usuwa się wiersz metadanych |

### Zapis lokalny
- `mutate(table, id, patch)` w jednej transakcji SQLite: zmiana wiersza lokalnego, `field_clock` zmienionych pól = nowy HLC urządzenia, wpis w `outbox` (`op_id`, tabela, `row_id`, zmienione pola z wartościami, HLC).
- **HLC** (hybrid logical clock): `czas_ms` + licznik + `device_id`, zapisany jako tekst sortowalny. Każde urządzenie i serwer (operacje z integracji) ma własny `device_id`. Odebranie zmian podnosi zegar lokalny (`max`), więc nowsza edycja zawsze ma większy HLC niż to, co urządzenie już widziało.
- Walidacja przed zapisem (Zod + reguły z `core`: głębokość podzadań, cykle, zgodność przestrzeni). Ta sama walidacja działa na serwerze.

### Wysyłka (`push_changes`)
- Outbox wysyłany w kolejności, paczkami do 200 operacji, jedno wywołanie RPC = jedna transakcja.
- Serwer dla każdego pola: zapis tylko wtedy, gdy `hlc_operacji > field_clock[pole]` (albo pola jeszcze nie ma). Wstawienie, gdy wiersza nie ma. To daje **idempotencję bez tabeli przetworzonych operacji** (powtórka tej samej operacji niczego nie zmienia) i wynik niezależny od kolejności dotarcia operacji z różnych urządzeń.
- Ochrona przed złym zegarem: HLC późniejszy niż czas serwera + 5 min jest obcinany do czasu serwera (urządzenie dostaje skorygowany zegar w odpowiedzi).
- Operacja naruszająca reguły (np. podzadanie przeniesione w cykl na dwóch urządzeniach, piąty poziom) jest **odrzucana** z kodem (`TP001` głębokość, `TP002` cykl, `TP003` brak dostępu, `TP004` zły zakres, `TP005` nieznana tabela/pole, `TP006` zły HLC); dostęp sprawdzany jawnie, także gdy zmiana i tak przegrałaby LWW; klient oznacza ją w outboxie jako odrzuconą, pobiera wersję serwera i pokazuje komunikat („Zmiana odrzucona: …”). Odrzucone operacje widoczne w ustawieniach synchronizacji.

### Pobieranie (`pull_changes`)
- Jak w EP: trigger podbija `sync_scopes.sync_version` (blokada wiersza zakresu do końca transakcji) i nadaje wierszowi `row_version`. Klient wysyła mapę `{scope_id: ostatnia_wersja}`, dostaje wiersze z `row_version` większym (z usuniętymi) w jednej migawce bazy.
- **Strony** (MVP-1): `pull_changes(p_since, p_limit = 1000)` zwraca wiersze po zakresie i `row_version` (jeden licznik zakresu we wszystkich tabelach), `more` i w `scopes[id].version` kursor — pełną wersję zakresu, który przyszedł w całości. Silnik pyta dalej, dopóki `more`, i raportuje postęp (`onPullProgress`).
- Pierwsza synchronizacja: pełna migawka **stronicowana** po tabelach ze wskaźnikiem postępu (MVP-1; w PoC 2 017 zadań bez stronicowania = ~4,2 s do pierwszego zapytania w przeglądarce, ~1 MB).
- Kolejność cyklu: wyślij outbox → pobierz zmiany → przelicz zależne stany (`due_date` serii, powiadomienia, widżety, liczniki).
- Online: Realtime na wierszach `sync_scopes` użytkownika = sygnał do pobrania; dodatkowe pobranie po gotowości subskrypcji (zimny start Realtime, wniosek z EP). Offline → online: natychmiastowy cykl. Telefon w tle: `expo-background-task` (co ok. 15 min, zależnie od systemu).
- Nowa tabela albo kolumna w strumieniu (v1.x): starszy klient pomijał nieznane pola, a kursory i tak szły dalej — silnik zapamiętuje podpis zestawu (`SYNCED_SCHEMA` w `engine.ts`) i po jego zmianie raz pobiera wszystko od 0.
- Usunięte wiersze (`deleted_at`) trwale usuwane po 90 dniach. Klient, którego ostatnia synchronizacja jest starsza niż ten horyzont, robi pełną migawkę.

- Kaskady (usunięcie rodzica, przeniesienie listy) liczy serwer; do synchronizacji widoki ukrywają dzieci usuniętego rodzica albo `mutate` powtarza kaskadę lokalnie (MVP-2).

### Seria cykliczna po synchronizacji
- Ukończenie wystąpienia na dwóch urządzeniach offline daje ten sam `task_completions.id` (UUIDv5 z `task_id` + `occurrence_date`) — jeden wpis.
- `due_date` serii liczy funkcja deterministyczna `core/recurrence.ts` z reguły i ukończeń; urządzenie, które po pobraniu widzi niezgodność, zapisuje poprawną wartość (każde urządzenie liczy to samo, więc konflikt jest pozorny).

### Web — lokalna baza w przeglądarce
- `sqlite-wasm` w Web Workerze, VFS `opfs-sahpool` (nie wymaga nagłówków COOP/COEP). VFS daje dostęp wyłączny, więc **jedna karta jest liderem** (Web Locks API) i trzyma bazę oraz synchronizację; pozostałe karty wysyłają zapytania i zmiany przez BroadcastChannel. Zamknięcie lidera → kolejna karta przejmuje blokadę.
- Wersja protokołu kart (Etap 9): żądania i odpowiedzi niosą `TAB_PROTOCOL` (podbijany przy nowej operacji kart albo kolumnie / tabeli lokalnej, której starszy lider nie ma). Lider odrzuca nieznane operacje; karta, której lider ma starszą wersję (np. otwarty przed wdrożeniem), dostaje `staleLeader` — UI prosi o odświeżenie tamtej karty, a `mutateMany` kończy się błędem zamiast zgubić zmiany.
- Brak OPFS (np. tryb prywatny) → tryb online: baza w pamięci, pełna migawka przy starcie, ostrzeżenie w UI.
- `navigator.storage.persist()` przy pierwszym uruchomieniu; eksport kopii bazy w ustawieniach.

### Telefon — dodatkowo
- Powiadomienia (M8) i widżety (M20) czytają tę samą bazę; zmiany z akcji powiadomień i widżetów idą przez `mutate` (outbox). Zadania w tle (Headless JS) rejestrowane przed `expo-router/entry`; obsługa akcji z powiadomień idempotentna, bo ta sama odpowiedź może przyjść z zadania w tle i z listenera (PoC-4).
- Załączniki do wysłania w osobnej kolejce plików; wiersz `attachments` trafia do outboxu dopiero po udanym wysłaniu pliku.

### Testy (kryterium PoC-1, potem `npm run test:sync`)
Scenariusze na lokalnym Supabase z trzema klientami (2 × Node, 1 × przeglądarka w Playwright): różne pola offline → oba zachowane; to samo pole → wygrywa późniejszy HLC niezależnie od kolejności wysyłki; usunięcie kontra edycja; przeniesienie w cykl → odrzucenie i powrót; podwójne ukończenie wystąpienia → jeden wpis; 500 operacji offline; zgubiony sygnał Realtime; dwie karty przeglądarki; zegar urządzenia przesunięty o +1 dzień.

---

## 7. Silniki w `packages/core`

### 7.1. Widoki
- Funkcje czyste na tablicach wierszy (`selectToday`, `selectUpcoming`, `groupTasks`, `applyFilter`, `buildTree`); `packages/sync` dostarcza wiersze kandydatów zapytaniem z indeksem, `core` stosuje reguły (wirtualne wystąpienia, kolejność, grupowanie). Te same funkcje liczą liczniki w pasku bocznym, widżety i przegląd.
- „Dziś” liczone według strefy urządzenia (dzień zmienia się o północy lokalnej; po północy widok odświeża się sam).
- Zrobione w `core/views.ts` (18.11.2026): `selectToday`, `selectUpcoming`, `selectInbox`, `FilterQuery` + `applyFilter`/`matchesFilter`, `sortTasks`, `groupTasks`, `buildTree`/`flattenTree`/`progress`, `withCompleted`; wejście = `ViewTask` (camelCase, z `tagIds`). Ustalenia:
  - w dniu najpierw zadania z godziną (według godziny), potem bez godziny (kolejność ręczna); zaległe od najstarszego terminu, potem priorytet,
  - „Nadchodzące” zaczyna się od dziś (zaległe w „Dziś” i „Zaległe”); wirtualne wystąpienia serii od dnia po późniejszej z dat: bieżący termin, dziś — zgodnie z `nextDue`; seria „po ukończeniu” nie ma wirtualnych wystąpień; nawyki są tylko w sekcji „Cykliczne na dziś”,
  - dzień ukończenia = data lokalna `completed_at` w strefie z ustawień (`localDateAt`),
  - postęp rodzica nie liczy anulowanych podzadań; podzadanie bez rodzica na wejściu jest korzeniem,
  - filtr zapisany ma daty względne (`{ offsetDays: 0 }` = dzień oglądania), więc „termin ≤ dziś” działa także jutro.
- `occurrences` z `from` przeskakuje do okresu zawierającego `from` (bez `COUNT`): seria codzienna sprzed 6 lat — 14 dni w < 0,1 ms zamiast ~7 ms.

### 7.2. Cykliczność (`recurrence.ts`)
```ts
Recurrence =
  | { mode: 'schedule'; rrule: string; anchor: LocalDate; until?: LocalDate; count?: number }
  | { mode: 'after_completion'; every: { unit: 'day' | 'week' | 'month' | 'year'; n: number } }
```
- API (PoC-3): `parseRrule`, `formatRrule`, `occurrences`, `nextOccurrence`, `nextDue`, `describeRecurrence` (PL), schemat `Recurrence`; rozpoznawanie z tekstu w `quick-add.ts`.
- Podzbiór (D19): `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`, `BYDAY` (z pozycją tylko w MONTHLY/YEARLY), `BYMONTHDAY` (także ujemne), `BYMONTH`, `BYSETPOS`, `COUNT`, `UNTIL` (data), `WKST=MO`. Odrzucane: HOURLY i mniejsze, `BYHOUR`/`BYWEEKNO`/`BYYEARDAY`, YEARLY+BYDAY bez BYMONTH, `COUNT` razem z `UNTIL`.
- Kotwica, która nie pasuje do reguły, nie jest wystąpieniem (jak rrule.js / dateutil; inaczej niż DTSTART w RFC — ICS w PoC-6 traktuje DTSTART zgodnie z RFC). Szybkie dodawanie ustawia kotwicę na pierwszym pasującym dniu.
- „Po ukończeniu” co miesiąc z 31. → ostatni dzień krótszego miesiąca; „według harmonogramu” 31. dnia pomija krótsze miesiące (RFC).
- Daty pływające — brak problemów ze zmianą czasu (DST); godzina wystąpienia = `due_time` serii.
- Przypadki testowe (kryterium PoC-3): co drugi wtorek (`FREQ=WEEKLY;INTERVAL=2;BYDAY=TU`), drugi wtorek miesiąca (`FREQ=MONTHLY;BYDAY=2TU`), ostatni dzień miesiąca (`BYMONTHDAY=-1`), ostatni dzień roboczy (`BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1`), 31. dzień (miesiące krótsze pomijane — zgodnie z RFC; opcja „ostatni dzień, jeśli brak” — v1.x), 29 lutego, `COUNT`/`UNTIL`, „3 dni po ukończeniu” ukończone z opóźnieniem i przed terminem, ukończenie zaległego wystąpienia (następne = pierwsze przyszłe, nie zaległe).
- Ukończenie serii „według harmonogramu” po terminie: następny termin = najbliższe wystąpienie **po dziś** (bez zalewu zaległych wystąpień).

### 7.3. Zależności i oś czasu (`dependencies.ts`)
- `detectCycle(deps, newDep)`, `violations(tasks, deps)` (B.start < A.end + lag), `shiftSuccessors(tasks, deps, taskId, deltaDays)` (kaskadowo, zachowując odstępy; opcja dni roboczych z ustawień), `projectSpan(list, tasks)`.
- Koniec zadania = `due_date` (+ `due_time` + `duration_min`, gdy jest godzina); początek = `start_date ?? due_date`.
- SVAR Gantt przyjmuje cykle zależności — zapis zależności z osi zawsze przez `detectCycle` (PoC-5).
- Zrobione (18.11.2026): `taskSpan`, `detectCycle` (zwraca ścieżkę cyklu), `violations`, `shiftSuccessors` (`cascade: false` = „Tylko to zadanie”, `workdays` = dni robocze), `projectSpan`; w `dates.ts` `daysBetween`, `addWorkdays`. Granulacja dni: przy `lag_days` = 0 następnik może zacząć się w dniu końca poprzednika.
- Oś czasu (`timeline.ts`, 19.11.2026): `timelineModel(projects, tasks, deps)` → wiersze (projekt → zadania → podzadania w kolejności ręcznej, pasek, postęp, `violated`), zależności z paskami po obu stronach, naruszenia, licznik bez terminu; `timelineChangeOps` (przesunięcie / rozciągnięcie paska, `cascade` = „Przesuń zależne”), `shiftProjectOps` (pasek projektu), `addDependencyOps` (cykl, duplikat, inna przestrzeń → błąd, `dependencyErrorText`), `removeDependencyOps`, `clampLag`, `taskLinks` (panel zadania). `shiftSuccessors` przyjmuje też listę zadań.

### 7.4. Time-blocking (`time-blocking.ts`)
- `blocksForDay(tasks, events, date)`, `conflicts(blocks)` (nakładanie bloków i wydarzeń, z pominięciem wydarzeń „wolny”), `freeSlots(blocks, workHours, minMinutes)`.
- Zrobione (19.11.2026): `blocksForDay(tasks, events, date, { timeZone, defaultDurationMin })` → `{ timed, allDay, dayMinutes }` (bloki w minutach od północy, przycięte wydarzenia, przyszłe wystąpienia serii jako `virtual`, doba 23/25 h przy zmianie czasu), `conflicts` (para z choć jednym zadaniem; bez ukończonych, „wolny” — `busy: false` — i wirtualnych) + `conflictIds`, `freeSlots(plan, workHours, { minMinutes })` (tylko dni robocze z ustawień), `scheduleBlockPatch` / `resizeBlockPatch` / `unscheduleBlockPatch`, `snapMinutes`, `minutesToTime`. `calendar_events` nie ma kolumny zajętości — wejście ma opcjonalne `busy` (domyślnie zajęty; kalendarz telefonu podaje dostępność). Do widoku kalendarza: `calendarEntries(tasks, events, from, to)` — pozycje dni `[from, to)` jako zegar ścienny (`start`/`end`), z `virtual`, `passive`, `conflict` (konflikty per dzień), wydarzenie wielodniowe raz; `freeSlotTimes` — wolne okna dnia jako zegar ścienny; `addWallMinutes`; `blockLanes(blocks)` — kolumny nakładających się bloków na osi dnia (plan dnia na webie, oś dnia na telefonie).

### 7.5. Nawyki (`habits.ts`)
- Okres nawyku: dzień (reguła dzienna/w wybrane dni) albo tydzień/miesiąc (cel „N razy”). Passa = liczba kolejnych zaliczonych okresów, w których nawyk był zaplanowany; `skipped` nie przerywa i nie zalicza; bieżący niezakończony okres nie przerywa passy.
- API (PoC-3): `habitPeriods`, `habitStreak` (passa i najdłuższa passa), `habitRate`, `habitDays` (mapa cieplna), schemat `HabitSettings`.
- Cel „N razy w tygodniu/miesiącu”: okres z dniami wolnymi, w którym zrobione + wolne ≥ N, nie przerywa passy i nie zalicza. Dzień z wartością poniżej celu ilościowego to „częściowo” (mapa cieplna), a w passie — niezaliczony.
- Test na historiach w `fixtures/habits.json` (wartości policzone ręcznie).
- Zrobione (19.11.2026, Etap 8): `habitStats` (passy, regularność ostatnich 7/30/90 dni, sumy), `habitWeeks` (tygodnie ISO: dni zrobione, cel tygodnia, suma wartości), `habitYear` (mapa 53 tygodni), `habitDayStatus`, `habitEntryOps` (uzupełnianie do 7 dni wstecz), `habitsForDay`, `habitNeedsReminder`, formularz `habitDraft` / `habitFields` / `habitSaveOps`; `HabitSettings.time` — pora nawyku (przypomnienia względne). `habitRate` liczy okresy względem prawdziwego „dziś” (dzień `to` sprzed dziś bez wpisu = opuszczony). Historie 90-dniowe w `fixtures/habits-90.json`.

### 7.6. Przypomnienia (`reminders.ts`)
- `reminderFireTimes(tasks, reminders, window, settings, zone)` → lista `{taskId, reminderId, occurrenceDate, fireAt (instant)}` — z czasu pływającego i bieżącej strefy urządzenia. Używają jej telefon (planowanie lokalne) i `reminders-push` (serwer, strefa z ustawień profilu).
- Zrobione (19.11.2026): `reminderFireTimes(tasks, rules, { from, to?, timeZone, defaultTime, limit })` → `{ key, taskId, reminderId, occurrenceDate, fireAt, dueAt }` od najwcześniejszego (klucz `reminderId:dzień` — przeplanowanie bez duplikatów); względne przed `due_time` albo domyślną godziną, seria według harmonogramu — każde wystąpienie w oknie (także zaległa seria), „po ukończeniu” — tylko bieżące, bezwzględne raz; strefa przypięta do zadania (`time_zone`) wygrywa; zamknięte bez przypomnień. W `dates.ts` `zonedInstant` (czas pływający → chwila; luka wiosną → godzinę później, podwójna godzina jesienią → pierwsza). Też `reminderBody` (treść: „Za 30 min (10:00)”, „Termin: jutro 10:00”), `toReminderRule`, `snoozeUntil`, `REMINDER_WINDOW_DAYS` = 7, `MAX_SCHEDULED_REMINDERS` = 50.

### 7.7. Pomodoro (`focus.ts`)
- Maszyna stanów: `idle → focus → short_break/long_break → focus …`, stan = etap + `started_at` + pauzy; `remaining(state, now)`; przejście etapu zamyka i otwiera `time_entries`.
- Zrobione (18.11.2026): `FocusSettings`, `FocusState` (Zod), `startFocus`/`pauseFocus`/`resumeFocus`/`stopFocus`/`skipPhase`/`advanceFocus` → `{ state, entries }` (operacje open/close na `time_entries`), `focusRemaining`, `phaseEndsAt` (do powiadomienia), `focusMinutes`. Pauza zamyka wpis, wznowienie otwiera nowy. Koniec pracy sam zaczyna przerwę, koniec przerwy przechodzi w `ready` (czeka na użytkownika) — uśpione urządzenie nie dopisuje fikcyjnych cykli; etap zamyka się w chwili swojego końca, nie przy następnym otwarciu aplikacji.
- Etap 7 (19.11.2026): stan w `profiles.focus` (osobne pole — timer nie nadpisuje ustawień), `focusStepOps` (przejście → wpisy + stan, jedna transakcja), `focusEntryId` (UUIDv5 z użytkownika, etapu i początku — równoległe doliczenie końca etapu na dwóch urządzeniach daje ten sam wpis), `parseFocusState`, `orphanEntryOps` (wpis porzucony przez równoległą zmianę timera zamyka się po 2 min: w chwili startu wygrywającego odcinka albo po długości etapu), `manualEntryOps` (ręczny wpis `manual`), `focusWeek` (statystyki tygodnia: dni w strefie użytkownika, przestrzeń, lista / projekt, zadanie, ukończone Pomodoro).

### 7.8. Przegląd (`review.ts`)
- `dailyReviewQueue(tasks, today)`, `weeklyReviewSteps(…)` (Inbox, zaległe, projekty bez następnego kroku, „Oczekuje” > 7 dni), `reviewStats`.
- Zrobione (18.11.2026): `dailyReviewQueue`, `ReviewAction` (Zod), `reschedulePatch` (godzina zostaje, zakres przesuwa się w całości, na później i „Kiedyś” → `postpone_count` + 1; „Kiedyś” niedostępne dla serii), `weeklyReview` (Inbox, zaległe, aktywne projekty bez otwartego zadania z terminem, „Oczekuje” > 7 dni według `statusChangedAt` — z `field_clock.status`, inaczej `created_at` — 7 dni naprzód, nawyki z ostatnich 7 dni, przesuwane ≥ 3 razy), `ReviewStats` + `reviewStats`. `ViewTask` ma `postponeCount` i opcjonalne `statusChangedAt`.
- Etap 9 (19.11.2026): `reviewBulkAction` (decyzja → `bulkTaskOps`, akcja zbiorcza `someday` = bez terminu i godziny), `reviewStartOp` / `reviewFinishOp` (wiersz `review_sessions` przy wejściu, `finished_at` + `stats` przy końcu), `reviewsDue` (które przeglądy już „na czasie” według `dailyReview` / `weeklyReview` w ustawieniach i ostatniego zakończonego), `dailySummary` (ukończone dziś, plan jutra); `REVIEW_ACTION` (klawisze 1–6) w `labels.ts`.

### 7.9. Etykiety i formatowanie
- `labels.ts`: `PRIORITY`, `TASK_STATUS`, `LIST_KIND`, `PROJECT_STATUS`, `REMINDER_KIND`, `WEEKDAY`; `format.ts` (z EP: `plural`, `pluralForm`, `formatMinutes`, `shortDate`) + `relativeDay` („dziś”, „jutro”, „pt 21 lis”, „za 3 dni”, „2 dni temu”). Aplikacje nie definiują własnych etykiet.
- Zrobione (19.11.2026): `REMINDER_KIND`, `WEEKDAY`, `MONTH_SHORT`, `VIEW_SECTION`; `relativeDay(date, today, 'date' | 'distance')`.

---

## 8. Bezpieczeństwo i prywatność
- RLS na wszystkich tabelach, zapisy przez RPC z walidacją; testy pgTAP (§5).
- Sekrety (klucze Supabase `service_role`, OAuth Google, VAPID, sekret Email Workera) tylko w sekretach Supabase / Vercel / Cloudflare i w `.env.local`, nigdy w repo, przeglądarce ani APK.
- Tokeny kalendarzy w Supabase Vault; odłączenie konta usuwa tokeny i wydarzenia.
- Adres e-mail do przechwytywania = sekret (token) + lista dozwolonych nadawców; możliwość wygenerowania nowego tokenu.
- `link-preview`: tylko `http(s)`, blokada adresów prywatnych i lokalnych (SSRF), limit rozmiaru i czasu.
- Pluginy (M21): sekrety połączeń tylko w Vault (klient ich nie widzi ani nie odczyta z powrotem); adres webhooka tylko `https`, te same blokady SSRF co `link-preview` (także po przekierowaniu), limit rozmiaru ładunku i czasu odpowiedzi; podpis HMAC i `Idempotency-Key`; wysyłka sprawdza bieżący dostęp właściciela reguły do zakresu zadania; brak wykonywania kodu dostarczonego przez użytkownika.
- Lokalna baza na telefonie w katalogu aplikacji; w przeglądarce w OPFS danego pochodzenia. Wylogowanie czyści lokalną bazę (po wysłaniu outboxu albo z ostrzeżeniem o niewysłanych zmianach).
- Kopia zapasowa: plan Free Supabase nie ma kopii — nocny `pg_dump` (GitHub Actions, prywatny artefakt) + eksport JSON w ustawieniach (§10).

---

## 9. Wymagania niefunkcjonalne
| Obszar | Wymaganie |
|---|---|
| Wydajność | 10 000 zadań: „Dziś” i lista projektu < 100 ms z lokalnej bazy; parser < 5 ms; przeciąganie w kanbanie/kalendarzu 60 kl./s przy 2 000 zadań; zimny start telefonu do „Dziś” < 2 s |
| Synchronizacja | zmiana widoczna na drugim urządzeniu online < 3 s; 500 operacji offline wysłane < 10 s |
| Offline | wszystko poza wyjątkami z M20 |
| Przypomnienia | telefon: ±1 min z `USE_EXACT_ALARM` (50 alarmów przyjętych jako dokładne w PoC-4; 3-dobowy pomiar w Doze w MVP-3), web: ±1 min (cron co minutę; w PoC-6 dostarczenie 14–54 s) |
| Dostępność | pełna obsługa klawiaturą na webie, etykiety ARIA, kontrast WCAG AA, tryb ciemny, skalowanie czcionki na Androidzie |
| Język i format | UI po polsku, tydzień od poniedziałku, format dat `pt 21 lis`, 24 h |
| Przeglądarki | Chrome i Edge (desktop i Android) — pełne wsparcie; Firefox — bez OPFS w trybie prywatnym (tryb online); Safari — najlepszy wysiłek |
| Android | minimum Android 10 (API 29) — do potwierdzenia z wymaganiami Expo SDK 58 |
| Testy | `npm run check` (typecheck + lint + Vitest) zielony przed każdym commitem; pgTAP i `test:sync` przed zmianą schematu; Playwright i Maestro przed wydaniem |

---

## 10. Usługi zewnętrzne i koszty
Do zweryfikowania w Etapie 0 i zapisania z datą w `docs/USLUGI.md` (jak w EP — nie wprowadzamy usługi bez sprawdzonych warunków).

| Usługa | Plan | Na co uważać |
|---|---|---|
| Supabase | Free (osobny projekt na osobnym koncie, D10) | wstrzymanie po 7 dniach niskiej aktywności (codzienne użycie temu zapobiega); brak kopii zapasowych → własny `pg_dump`; 500 MB bazy, 1 GB Storage; `pg_cron`/`pg_net` na Free działają (PoC-6); nowy projekt nie nadaje ról API do tabel z migracji → jawne granty |
| Vercel | Hobby | tylko użytek niekomercyjny; Cron Jobs raz dziennie, Vercel Schedules (beta) co 15 min → zadania co minutę w `pg_cron` |
| GitHub Actions | Free | build APK (`.github/workflows/android.yml`); limit minut dla prywatnego repozytorium w `docs/USLUGI.md`. EAS nieużywany (D17) |
| Google Cloud (OAuth, Calendar API) | bezpłatny | zakres kalendarza jest „wrażliwy”: w stanie *Testing* tokeny odświeżania wygasają po 7 dniach → aplikacja w stanie *In production* bez weryfikacji (ekran ostrzeżenia, limit 100 użytkowników) — działa (PoC-6), klient OAuth w osobnym projekcie Google Cloud; token odświeżania > 7 dni do sprawdzenia w trakcie MVP |
| Cloudflare Email Routing + Workers | Free | wymaga domeny z DNS w Cloudflare (D9) |
| Web Push | bezpłatny | klucze VAPID; `jsr:@negrel/webpush` 0.5.0 działa w Edge Runtime (PoC-6) |
| Microsoft Graph (v1.x) | bezpłatny | rejestracja aplikacji w Entra ID; dla konta firmowego może być potrzebna zgoda administratora |

Szacowany koszt v1.0: 0 zł miesięcznie (+ domena, jeśli trzeba kupić). Supabase Pro (25 USD/mies.) tylko wtedy, gdy limity Free okażą się za małe albo będą potrzebne kopie PITR.

---

## 11. Ryzyka
| # | Ryzyko | Skutek | Zabezpieczenie |
|---|---|---|---|
| R1 | Błąd w scalaniu per pole albo w drzewie podzadań | utrata lub zdublowanie danych | PoC-1 jako pierwszy, scenariusze z §6 w `test:sync`, `activity_log` do przywracania |
| R2 | sqlite-wasm/OPFS: wiele kart, wyczyszczenie danych przez przeglądarkę | web nie działa offline albo traci niewysłane zmiany | lider kart (Web Locks), `storage.persist()`, tryb online jako wyjście awaryjne, outbox wysyłany od razu po zapisie |
| R3 | Android 14+: `SCHEDULE_EXACT_ALARM` domyślnie odmówione, `USE_EXACT_ALARM` tylko dla budzików/kalendarzy (polityka Play); Doze | spóźnione przypomnienia | PoC-4: bez dokładnych alarmów NO-GO → `USE_EXACT_ALARM` (APK poza Play, D17); 3-dobowy pomiar w Doze w MVP-3; przy publikacji w Play powrót do `SCHEDULE_EXACT_ALARM` + prośba w aplikacji; awaryjnie push z serwera (FCM) |
| R4 | Parser PL rozpoznaje fragment tytułu jako datę | zepsute tytuły | pełne formy fragmentów, chipy z cofaniem, korpus pułapek w testach |
| R5 | rrule.js — błędy stref i wydajność | złe terminy serii | **zamknięte w PoC-3**: własny podzbiór RRULE na datach pływających (D19), zgodny z rrule.js na 500 losowych regułach |
| R6 | Google OAuth: wygasanie tokenów, weryfikacja zakresów | zerwana synchronizacja kalendarza | PoC-6; ICS i kalendarz telefonu jako odczyt bez OAuth |
| R7 | Widżety i calendar-kit na Expo SDK 58 / New Architecture | brak widżetu / kalendarza na telefonie | **zamknięte w PoC-4**: widżet działa; calendar-kit odrzucony → własna oś dnia (D16) |
| R8 | Biblioteka Gantta nie daje rozciągania/zależności tak, jak trzeba | Etap 6 dłuższy | **zamknięte w PoC-5**: SVAR wystarcza (D18); cykle blokuje `core`, widok trzymany zamontowany (< 150 ms) |
| R9 | Zakres (20 modułów) dla jednej osoby | brak używalnej aplikacji przez długi czas | MVP-2 = pierwszy realny użytek na webie; reszta przyrostowo, każdy etap z kryterium odbioru |
| R10 | Limity Supabase Free, wstrzymanie projektu | przerwa w synchronizacji | aplikacja działa offline; monitor w `docs/USLUGI.md`; Pro w razie potrzeby |
| R11 | Podszyte maile do adresu przechwytywania | śmieci w Inbox | token w adresie + lista nadawców + DMARC + dziennik odrzuceń |
| R12 | Brak OTA (D17) | każda poprawka na telefonie = nowy APK | GitHub Actions buduje APK; ewentualnie własny serwer zgodny z protokołem Expo Updates |
| R13 | Kanban z wieloma kartami (PoC-5: start przeciągania 150–184 ms) | szarpnięcie przy podniesieniu karty | porcje albo wirtualizacja, pomiar ponownie w MVP-4 |
| R14 | Pluginy (M21): zduplikowane lub lawinowe wysyłki (paczka offline, „Cofnij”, pętla z integracją), limity Edge Functions na Free | spam w systemie zewnętrznym, wyczerpany limit | deterministyczne id dostaw + `Idempotency-Key`, opóźnienie z łączeniem i ponownym sprawdzeniem, domyślnie bez zadań z integracji, limit na połączenie, trigger nic nie robi bez aktywnych reguł; limity do sprawdzenia w `docs/USLUGI.md` przed etapem |

---

## 12. Decyzje
Stan po bramce decyzyjnej (19.11.2026): wszystkie zatwierdzone.

| # | Decyzja | Rozstrzygnięcie |
|---|---|---|
| D1 | Platformy | **Android + web (PWA)**; iOS i desktop natywny w v1.x (decyzja 2026-11-19) |
| D2 | Web local-first czy online | **Local-first** (sqlite-wasm + wspólny `packages/sync`); potwierdzone w PoC-1 i PoC-5 (decyzja 2026-11-19) |
| D3 | Konflikty | **LWW per pole z HLC**, ukończenia i czas pracy tylko dopisywane (decyzja 2026-11-19) |
| D4 | Format opisu | **Markdown** (TipTap 3 + `@tiptap/markdown` na webie, potwierdzone w PoC-5; decyzja 2026-11-19) |
| D5 | Składnia szybkiego dodawania | **`#` = lista/projekt/przestrzeń, w razie braku — tag; `@` = zawsze tag**; `!1–!4` priorytet; `~` czas trwania; `^` przypomnienie (decyzja 2026-11-19) |
| D6 | Statusy kanbanu | **Stałe 5 statusów** w v1.0; własne kolumny statusów w v1.x (decyzja 2026-11-19) |
| D7 | Zakres telefonu | **Pełna edycja + kalendarz dnia/tygodnia**; oś czasu (Gantt) do edycji tylko na webie, na telefonie podgląd osi bez przeciągania (zmiana 2026-11-22); kanban na telefonie uproszczony (decyzja 2026-11-19) |
| D8 | Kalendarz firmowy (spotkania) | **Google** (decyzja 2026-11-18): dwukierunkowa synchronizacja z Google Calendar; ICS i kalendarz telefonu jako odczyt dla pozostałych; Microsoft 365 dopiero w v1.x |
| D9 | Domena dla adresu e-mail | **E-mail → Inbox przesunięte do v1.x** (decyzja 2026-11-18) — wymaga domeny z DNS w Cloudflare; do tego czasu przechwytywanie przez udostępnianie z telefonu i Web Share Target (M19) |
| D10 | Projekt Supabase | **Osobny projekt na osobnym koncie** Supabase (Free, decyzja 2026-11-18) — limit 2 aktywnych projektów konta ExpeditionPlan nie dotyczy Task Plannera |
| D11 | Widżety pulpitu | **PWA + skróty** w v1.0; natywny widżet / zasobnik / globalny skrót przez Tauri w v1.x |
| D12 | Integracje na serwerze | **Supabase Edge Functions + `pg_cron`** (nie trasy API Vercela) |
| D13 | Import z obecnego narzędzia | **Brak** (decyzja 2026-11-18): start od zera, bez `tools/import`; zostaje eksport/import JSON własnych danych (Etap 13). Korpus parsera uzupełnią przykładowe zadania wpisane przez użytkownika |
| D15 | Kolejność kart na tablicy z kilku list | **Osobny `tasks.board_sort_key`** (decyzja 2026-11-19): `sort_key` jest per lista/rodzic, więc karty z różnych list nie mają wspólnej kolejności. Kolumna w schemacie MVP-1, użycie w kanbanie MVP-4; pusty klucz = kolejność automatyczna (priorytet, termin) |
| D16 | Widok dnia na telefonie | **Własna oś dnia** na Reanimated + Gesture Handler 3 (decyzja 2026-11-19, PoC-4); bez `@howljs/calendar-kit`. Płynność palcem do sprawdzenia w MVP-3 |
| D17 | Build i dystrybucja Androida | **Bez EAS** (decyzja 2026-11-18/19, PoC-4): APK lokalnie i z GitHub Actions, podpis kluczem z sekretów repozytorium, poza Google Play; aktualizacja = nowy APK (bez OTA); dokładne alarmy przez `USE_EXACT_ALARM` |
| D18 | Biblioteka osi czasu | **SVAR React Gantt** (decyzja 2026-11-19, PoC-5); własny SVG niepotrzebny |
| D19 | Silnik cykliczności | **Własny podzbiór RRULE** (decyzja 2026-11-19, PoC-3); rrule.js tylko w testach |
| D14 | Język i nazwa | UI po polsku, nazwa aplikacji „Task Planner”, pakiety `@taskplanner/*` (decyzja 2026-11-19) |
| D20 | Raportowanie błędów | **Własny dziennik w Supabase** (decyzja 2026-11-19, Etap 13), bez Sentry: tabela `client_errors` (wiersz na użytkownika, odcisk i dzień, licznik), zapis tylko przez `report_client_errors` (limity), retencja 90 dni (`pg_cron`), podgląd w Ustawieniach; błędy Edge Functions — w logach Supabase |
| D21 | Integracje wychodzące | **System pluginów na serwerze** (projekt 21.11.2026, M21; szczegóły do potwierdzenia przy starcie etapu): wyzwalacze tylko po stronie Postgresa / Edge Function `plugins` (nigdy w kliencie offline), pluginy wkompilowane (bez kodu ładowanego w locie), pierwszy plugin = Webhook z podpisem HMAC; dostarczanie „co najmniej raz” z deterministycznym id, opóźnieniem i ponownym sprawdzeniem warunku. Wybór pierwszego pluginu natywnego otwarty |

---

## 13. Zmiany w v0.2 (bramka decyzyjna 19.11.2026)
- §2: build Androida bez EAS i OTA (D17); własny podzbiór RRULE (D19), SVAR Gantt (D18), własna oś dnia na telefonie (D16); kanban rysuje tylko widoczne karty; struktura repozytorium zgodna ze stanem po PoC (`tools/email-worker`, `tools/edge-tests`, `.github/workflows`).
- §4: ustalenia gramatyki z PoC-2 i PoC-3.
- §5: zakres = przestrzeń albo zakres osobisty, `scope_members` zamiast `workspace_members`, brak `workspace_id`, `scope_id` wyliczany, `due_time` jako `GG:MM`, unikalność i id tagów, `board_sort_key` (D15), tabele tymczasowe z PoC-6, jawne granty.
- §6: kody odrzuceń, stronicowanie pierwszej migawki ze wskaźnikiem postępu, kaskady lokalnie, zadania w tle na telefonie.
- §7: API i podzbiór cykliczności, reguły nawyków, blokada cykli przy SVAR.
- §9–§11: przypomnienia z `USE_EXACT_ALARM`, GitHub Actions zamiast EAS, wyniki PoC-6 dla usług; ryzyka R5, R7, R8 zamknięte, nowe R12 (brak OTA) i R13 (kanban).
- §12: D1–D7 i D14 zatwierdzone, nowe D15–D19.
- Odłożone do etapów: 3-dobowy pomiar przypomnień w Doze, tytuł strony z prawdziwego Chrome i płynność osi dnia palcem (MVP-3); token Google > 7 dni (w trakcie MVP); droga e-mail przez Cloudflare (v1.x, D9).
