# Plan etapowy realizacji — TaskPlanner

Na podstawie: [SPECYFIKACJA.md](SPECYFIKACJA.md) v0.1.

Założenia: jeden deweloper z Claude Code, Android + web, TypeScript w monorepo, Supabase — ten sam stos co ExpeditionPlan, więc Etap 0 jest głównie kopiowaniem szkieletu. Szacunki są w **dniach skupionej pracy**. Daty nie są obietnicą: obietnicą jest **kryterium odbioru** na urządzeniu.

Kolejność: **Etap 0 → PoC (6 eksperymentów) → bramka decyzyjna → MVP (4 etapy) → v1.0 (etapy 5–13) → v1.x**.

Pierwszy realny użytek (zadania codzienne na webie): po **MVP-2**. Na telefonie offline: po **MVP-3**.

---

## Etap 0 — Przygotowanie (≈ 1–2 dni)

- Potwierdzenie decyzji D1–D14 ze specyfikacji (brak uwag = rekomendacje), odpowiedzi na pytania D8, D9, D13 (18.11.2026: D8 Google, D9 e-mail w v1.x, D10 osobne konto Supabase, D13 brak importu).
- Repozytorium: `git init` w `D:\AI\PRIV\PRACA\Tasks`, remote `github.com/MichalKlinWedge/TaskPlanner`, `.gitattributes` i `.editorconfig` z EP (LF), `.gitignore`, `CLAUDE.md` (polecenia, zasady architektury z §0 i §2).
- Szkielet monorepo skopiowany z EP bez kodu domeny: główny `package.json` (workspaces, skrypty `check`/`typecheck`/`lint`/`test`/`web`/`web:local`/`mobile`/`supabase`/`test:db`/`test:sync`/`seed:dev`), `tsconfig.base.json`, `scripts/sync-env.mjs`.
  - `apps/web`: Next.js 16, React 19, Tailwind 4, ESLint, `AGENTS.md`.
  - `apps/mobile`: Expo SDK 58, Expo Router, dev build, `eas.json` (`development` / `preview` / `production`), skrypt `ota`, `AGENTS.md`.
  - `packages/core`, `packages/sync`, `packages/db` (puste, z Vitest), `sort-key.ts` i `format.ts` przeniesione z EP.
  - `supabase/` (`config.toml`, przypięte CLI 2.122.0), `supabase/functions/` (pusta funkcja testowa).
- Konta i klucze: nowy projekt Supabase, Vercel, projekt EAS, projekt Google Cloud (OAuth: logowanie, później Calendar), Cloudflare dopiero w v1.x (D9). Sekrety tylko w `.env.local` i sekretach usług.
- `docs/USLUGI.md`: warunki i limity z §10 sprawdzone z datą.
- Dane testowe:
  - `fixtures/quick-add.jsonl` — ≥ 150 wpisów z oczekiwanym wynikiem, **spisanych z prawdziwych zadań użytkownika** (D13: brak narzędzia do eksportu — zadania wpisane przez użytkownika) + pułapki,
  - `fixtures/recurrence.json` — przypadki z §7.2 z oczekiwanymi datami,
  - `tools/seed-dev` — generator: 5 przestrzeni, 40 list/projektów, 2 000 zadań, 15 nawyków z historią 90 dni.

**Rezultat:** `npm run check` zielony; web i aplikacja startują (pusty ekran z logowaniem w budowie); lokalny Supabase działa; korpusy testowe gotowe.

---

## PoC — Sześć eksperymentów technicznych (≈ 11–15 dni)

Cel: przed budową produktu sprawdzić rzeczy, które mogą zmienić architekturę. Każdy eksperyment ma kryterium **go / no-go** i wariant awaryjny. Kod z PoC-1, PoC-2 i PoC-3 przechodzi do produktu (`packages/sync`, `packages/core`), reszta może być wyrzucona. Wyniki w `docs/POC_WYNIKI.md`.

### PoC-1 — Synchronizacja local-first w obie strony (≈ 3–4 dni) — **pierwszy i najważniejszy**
- Migracja z tabelami `sync_scopes`, `workspaces`, `workspace_members`, `lists`, `tasks`, `task_tags`, `task_completions`; wspólne kolumny, triggery `row_version`, RLS.
- RPC `push_changes` (LWW per pole z `field_clock`, odrzucenia z powodem, obcinanie HLC) i `pull_changes` (mapa zakresów, jedna migawka).
- `core/hlc.ts`; `packages/sync`: interfejs `LocalDb` z `watch()`, schemat lokalny (`SPECS`), `mutate`, outbox, cykl push → pull, Realtime jako sygnał.
- Implementacje `LocalDb`: Node (testy), `expo-sqlite` (telefon), `sqlite-wasm` + `opfs-sahpool` w workerze z liderem kart (web).
- Scenariusze z §6 „Testy” na lokalnym Supabase: 2 klienty Node + przeglądarka (Playwright), 1 telefon ręcznie w trybie samolotowym.

**Stan (18.11.2026):** zrobione, werdykt **GO** — 31 testów pgTAP, 11 scenariuszy `test:sync` (500 operacji w 405 ms, Realtime 469 ms), dwie karty sprawdzone ręcznie, bundel Hermes się buduje; telefon w działaniu do sprawdzenia w MVP-3. Szczegóły i odstępstwa: `docs/POC_WYNIKI.md`.

**Go:** wszystkie scenariusze przechodzą; dwie karty przeglądarki działają na jednej bazie; zmiana z telefonu po włączeniu sieci na webie < 5 s. **No-go:** web online (zapisy optymistyczne przez ten sam `push_changes`, bez lokalnej bazy), telefon bez zmian; albo ocena PowerSync jako gotowego silnika.

### PoC-2 — Parser szybkiego dodawania (≈ 2 dni)
- `core/quick-add.ts` według §4: daty, godziny, zakresy, czas trwania, priorytet, `#`/`@`, cykliczność, przypomnienia, literały, zakresy znaków (`tokens`).
- Test na `fixtures/quick-add.jsonl`; prosty podgląd na webie (pole tekstowe + chipy), żeby ocenić podświetlanie na żywo.

**Stan (18.11.2026):** zrobione, werdykt **GO** — 100 % z 96 przypadków, 0 błędów w pułapkach, 0,012 ms na wpis; podgląd `/dev/quick-add`. Szczegóły: `docs/POC_WYNIKI.md`.

**Go:** ≥ 95 % przypadków zgodnych w całości, **0** przypadków, w których z tytułu zniknęło słowo, które do niego należy (zestaw pułapek), < 5 ms na wpis. **No-go:** zawężenie gramatyki (tylko formy z `!`, `#`, `@`, `^`, `~` + podstawowe daty) i rozszerzanie po MVP.

### PoC-3 — Cykliczność i nawyki (≈ 1–2 dni)
- `core/recurrence.ts`: `rrule` (rrule.js) na datach pływających kontra własny podzbiór RRULE; `describeRecurrence` po polsku z testem „tam i z powrotem” przez parser z PoC-2.
- `core/habits.ts`: passy i statystyki na historiach z `fixtures/habits/`.
- Uruchomienie tych samych testów w Node, w przeglądarce i w Hermes (ekran testowy w dev buildzie).

**Stan (18.11.2026):** zrobione, werdykt **GO — własny podzbiór RRULE** (zgodny z rrule.js na 500 losowych regułach); 15/15 przypadków §7.2, 5/5 historii nawyków, 1 000 wystąpień w 2,65 ms; przeglądarka 20/20, Hermes — tylko kompilacja (wykonanie na telefonie w PoC-4). Szczegóły: `docs/POC_WYNIKI.md`.

**Go:** wszystkie przypadki z §7.2 i z historii nawyków dają oczekiwane wyniki, identyczne na trzech środowiskach; 1 000 wystąpień na rok liczone < 20 ms. **No-go dla rrule.js:** własny podzbiór (FREQ, INTERVAL, BYDAY z pozycją, BYMONTHDAY, BYSETPOS, COUNT, UNTIL).

### PoC-4 — Android: przypomnienia, widżet, udostępnianie, kalendarz (≈ 2 dni)
- `expo-notifications`: 50 przypomnień na 3 dni, telefon na noc w Doze; pomiar opóźnień z pozwoleniem na dokładne alarmy i bez. Akcje „Ukończ” / „Odłóż” przy zamkniętej aplikacji → zapis w SQLite + outbox.
- `react-native-android-widget` na SDK 58 / New Architecture: lista „Dziś” z odhaczaniem z lokalnej bazy.
- `expo-share-intent`: link z Chrome → ekran szybkiego dodawania.
- `expo-calendar`: odczyt wydarzeń z kalendarzy telefonu; `@howljs/calendar-kit`: widok dnia z przeciąganiem bloku.

**Go:** ≥ 95 % przypomnień ±1 min z dokładnymi alarmami (≤ 10 min bez nich); akcje i widżet działają przy zamkniętej aplikacji i bez sieci; udostępnianie i kalendarz telefonu działają. **No-go:** widżet → skróty aplikacji; przypomnienia → dodatkowo push z serwera (FCM) jako zabezpieczenie; calendar-kit → własna oś dnia.

**Stan (19.11.2026):** zrobione, werdykt **GO** — na telefonie (Galaxy S22 Ultra, Android 16): samosprawdzenie 45/45 (PoC-1/2/3 w Hermes), akcje z powiadomień i widżet przy zamkniętej aplikacji bez sieci, udostępnianie, kalendarz telefonu; przypomnienia tylko z dokładnymi alarmami (`USE_EXACT_ALARM`; bez nich NO-GO). Bez 3-dobowego pomiaru Doze (decyzja użytkownika). Do MVP-3: Chrome (tytuł strony), płynność przeciągania palcem — domyślnie własna oś dnia. Build bez EAS: lokalnie i GitHub Actions (`docs/ANDROID_BUILD.md`). Szczegóły: `docs/POC_WYNIKI.md`.

### PoC-5 — Widoki webowe na lokalnych danych (≈ 2–3 dni)
- Na danych z `seed-dev` (2 000 zadań) w lokalnej bazie z PoC-1:
  - FullCalendar: tydzień, przeciąganie zadań z panelu bocznego (`Draggable`), zmiana długości, wiersz „cały dzień”,
  - kanban na dnd-kit: 4 kolumny × 500 kart, zmiana kolumny i kolejności, obsługa klawiaturą,
  - Gantt: SVAR React Gantt kontra własny SVG — przesuwanie, rozciąganie krawędzi, tworzenie zależności przeciągnięciem, czerwone naruszenia,
  - TipTap + `@tiptap/markdown`: 100 opisów (z fixtures) wczytanych i zapisanych bez zmian w Markdown.

**Stan (18.11.2026):** zrobione, werdykt **GO z warunkami** — FullCalendar, dnd-kit, SVAR React Gantt (bez własnego SVG), TipTap + Markdown (96/100 bez zmian, 0 strat); kalendarz 60 kl./s; kanban wymaga porcji/wirtualizacji (1 040 ms → 114 ms) i ma długą pierwszą klatkę przeciągania; oś czasu 165–190 ms przy przełączaniu. Szczegóły i warunki: `docs/POC_WYNIKI.md`.

**Go:** przeciąganie płynne (60 kl./s), przełączenie widoku < 150 ms, Markdown „tam i z powrotem” bez strat. Wybór biblioteki Gantta zapisany w `POC_WYNIKI.md`. **No-go:** własny komponent dla widoku, który nie spełnia kryterium.

### PoC-6 — Integracje serwerowe (≈ 1–2 dni)
- Google OAuth z zakresem Calendar: stan aplikacji *In production* bez weryfikacji — czy token odświeżania żyje > 7 dni (sprawdzane w trakcie MVP); `events.list` z `syncToken`; kanał `watch` → Edge Function; zapis do `calendar_events`.
- ICS: pobranie i parsowanie (Edge Function, `pg_cron` co 15 min).
- ~~Cloudflare Email Routing + Email Worker → `inbound-email`~~ — przesunięte do v1.x (D9).
- Web Push: biblioteka VAPID w Deno, wysyłka z `pg_cron` co minutę do przeglądarki.

**Stan (18.11.2026):** werdykt **GO** dla Google Calendar (prawdziwy `watch` w chmurze: 3,9 s; ICS: plik Google po ~25 s + cron co 10 min) i Web Push; e-mail **GO lokalnie** (prawdziwa droga przez Cloudflare razem z M19 w v1.x, D9) — `calendar-sync`, `inbound-email`, `reminders-push`, Email Worker; 26 testów integracyjnych na fałszywym Google/ICS/push, 32 pgTAP; watch → `calendar_events` 63 ms, ICS przez `pg_cron` 290 ms, mail → zadanie < 0,4 s, push z `pg_cron` ≤ 60 s; **Web Push do zamkniętej karty Chrome potwierdzony** (FCM, 205 ms od wysyłki). Funkcje i `pg_cron`/`pg_net` działają w projekcie w chmurze (Free). Pomiary na prawdziwym Google i Cloudflare czekają na klucze (`docs/POC6_KONFIGURACJA.md`). Szczegóły: `docs/POC_WYNIKI.md`.

**Go:** zmiana wydarzenia w Google widoczna < 1 min (watch) albo < 15 min (ICS); push dociera do zamkniętej karty (przeglądarka uruchomiona). **No-go:** Google tylko przez ICS (odczyt) do czasu decyzji.

### Bramka decyzyjna po PoC
Przegląd wyników z `docs/POC_WYNIKI.md`, decyzje (D2 — web local-first, biblioteka Gantta, rrule.js), specyfikacja v0.2 z poprawkami.

**Stan (19.11.2026):** zrobione — wszystkie sześć PoC z werdyktem GO (PoC-5 z warunkami), `SPECYFIKACJA.md` **v0.2** (zmiany w §13). Decyzje: D1–D7 i D14 zatwierdzone bez zmian; nowe D15 `board_sort_key` dla kanbanu z kilku list, D16 własna oś dnia na telefonie (bez calendar-kit), D17 build Androida bez EAS i OTA (APK poza Play, `USE_EXACT_ALARM`), D18 SVAR React Gantt, D19 własny podzbiór RRULE. Warunki z PoC rozpisane niżej w MVP-1…4 i Etapie 6.

---

## MVP — „Zarządzam dniem na laptopie i telefonie” (≈ 18–25 dni)

### MVP-1 — Fundament danych i konto (≈ 4–5 dni)
- Pełny schemat §5 (bez tabel integracji), triggery (`row_version`, `field_clock`, `activity_log`, głębokość podzadań, cykle), RLS + testy pgTAP z macierzy uprawnień, `push_changes`/`pull_changes` z PoC-1 dla wszystkich tabel.
- Typy → `packages/db`; schematy Zod całego modelu → `packages/core/src/schemas`.
- `packages/sync` produkcyjnie: wszystkie tabele w `SPECS`, odrzucone operacje, kolejka plików (pod Etap 10), wskaźnik stanu synchronizacji.
- Logowanie Google + magic link na webie i w aplikacji (deep link); onboarding: przestrzenie „Osobiste” i „Praca” z Inbox, ustawienia (strefa, tydzień, godziny pracy, domyślne godziny i czasy).
- Prosty ekran przestrzeni i list (tworzenie, zmiana nazwy, kolor, kolejność, archiwizacja) [W+A].
- `seed:dev` ładuje dane z `tools/seed-dev` do lokalnej bazy.
- Z bramki po PoC: `tasks.board_sort_key` (D15) w schemacie; stronicowana pierwsza migawka `pull_changes` ze wskaźnikiem postępu (PoC-5: 2 017 zadań = ~4,2 s); jawne granty w każdej migracji (PoC-6: projekt w chmurze ich nie nadaje).

**Stan (19.11.2026):** w toku na gałęzi `mvp-1`. Zrobione: migracja `20261119100000_mvp1_model.sql` (wszystkie tabele §5 poza integracjami, `board_sort_key`, `lists.archived_at`, `activity_log`, profil z kontem, stronicowane `pull_changes`), 26 testów pgTAP (`supabase/tests/model.test.sql`) i 2 integracyjne, `TABLES`/`MODEL` dla nowych tabel, onboarding w `core/onboarding.ts` (deterministyczne id przestrzeni), web: logowanie (Google, magic link), onboarding, ustawienia, przestrzenie i listy, wskaźnik synchronizacji, osobna lokalna baza na użytkownika. W chmurze (19.11.2026): migracja `mvp1_model` (`db push`), logowanie Google na webie sprawdzone (dostawca, adresy powrotu: produkcja, `localhost:3000`, `taskplanner://`). Telefon: logowanie, onboarding, przestrzenie i listy scalone; scenariusze M1–M8 w `docs/MVP1_TELEFON.md` (M1 przeszedł). Zostało: M2–M8 na telefonie (w tym kryterium odbioru), PR `mvp-1` → `main`. Tymczasowe tabele PoC-6 zostają do etapów, które ich używają (decyzja 19.11.2026): `push_subscriptions` → `devices.push_subscription` w MVP-4, `inbound_addresses` → `profiles` w v1.x (D9).

**Kryterium odbioru:** zadanie dodane na telefonie w trybie samolotowym pojawia się na webie < 5 s po włączeniu sieci; równoległe edycje offline różnych pól tego samego zadania zachowują obie zmiany; drugi użytkownik nie widzi niczego (test pgTAP i ręcznie). `npm run test:db` i `npm run test:sync` zielone.

### MVP-2 — Web: listy, zadania, szybkie dodawanie, paleta (≈ 5–7 dni)
- Powłoka aplikacji: pasek boczny (Inbox, Dziś, Nadchodzące, przestrzenie → listy i projekty, tagi, zapisane filtry z licznikami), przełącznik przestrzeni z trybem „Wszystkie”, tryb ciemny.
- Widoki listy M9: Inbox, Dziś, Nadchodzące (przeciąganie między dniami), projekt/lista z drzewem podzadań, grupowanie i sortowanie, ukończone.
- Panel zadania: tytuł, opis (TipTap/Markdown), status, priorytet, `start_date`/`due_date`/`due_time`/`duration_min`, tagi, podzadania (do 4 poziomów), historia zmian, kosz z przywracaniem.
- Szybkie dodawanie M13 z parserem z PoC-2 (chipy, cofanie, wiele linii).
- Tagi, filtry w chipach, zapisane filtry (M4).
- Paleta poleceń i wyszukiwarka FTS5 (M17), skróty klawiszowe, operacje grupowe.
- PWA: manifest, Service Worker z powłoką, `storage.persist()`, start offline.

**Kryterium odbioru:** tydzień codziennego używania webu: ≥ 80 % zadań dodanych szybkim dodawaniem bez poprawiania pól; każda akcja z listy M17 dostępna z klawiatury; po odłączeniu sieci aplikacja startuje i działa, zmiany wysyłają się po powrocie.

### MVP-3 — Android: wykonanie offline (≈ 5–7 dni)
- Ekrany: Inbox, Dziś, Nadchodzące, przestrzenie → listy/projekty, tag/filtr, wyszukiwarka (FTS5).
- Szczegóły zadania z edycją wszystkich pól, opis Markdown (edycja + podgląd), podzadania, tagi.
- Szybkie dodawanie (ten sam parser, chipy), przycisk „+”, skróty aplikacji.
- Gesty: przesunięcie = ukończ / menu terminu; długie przytrzymanie = zaznaczanie i operacje grupowe.
- Przypomnienia lokalne M8 (względne i bezwzględne, okno 7 dni, akcje w powiadomieniu), prośba o pozwolenie na dokładne alarmy.
- Synchronizacja w tle (`expo-background-task`), wskaźnik stanu; aktualizacje = nowy APK z GitHub Actions (`.github/workflows/android.yml`), bez EAS Update (decyzja z PoC-4).
- Odłożone z PoC-4: 3-dobowy pomiar przypomnień w Doze (≥ 95 % ±1 min z `USE_EXACT_ALARM`), tytuł strony przy udostępnianiu z prawdziwego Chrome (`EXTRA_SUBJECT`), czas od akcji w powiadomieniu do zapisu w release, płynność własnej osi dnia palcem (D16).

**Kryterium odbioru:** cały dzień w trybie samolotowym: dodawanie, edycja, odhaczanie, przypomnienia (także „Odłóż” z powiadomienia przy zamkniętej aplikacji) działają; po włączeniu sieci wszystkie zmiany są na webie, a zmiany z webu na telefonie. Pomiar 3 dób w Doze: ≥ 95 % przypomnień ±1 min.

### MVP-4 — Cykliczność, przypomnienia w przeglądarce, kanban (≈ 4–6 dni)
- Edytor reguł M7 [W+A]: szablony, tryb zaawansowany, opis po polsku na żywo, podgląd 5 dat. Ukończ / pomiń / przesuń wystąpienie / zakończ serię; reset podzadań; wirtualne wystąpienia w „Nadchodzące”.
- Przypomnienia Web Push (`reminders-push` + `pg_cron`), kanał przypomnień per urządzenie, brak duplikatów. Tymczasowe `push_subscriptions` i `push_queue` z PoC-6 → `devices.push_subscription` i wyliczanie z `core/reminders.ts` z dziennikiem wysyłek per urządzenie.
- Kanban M10 na webie (kryteria kolumn: status, priorytet, dzień tygodnia, tag, lista; przeciąganie zmienia atrybut) i uproszczony na telefonie. Warunki z PoC-5: tylko widoczne karty jako `useSortable` (porcje albo wirtualizacja), kolejność na tablicy z kilku list przez `board_sort_key` (D15), ponowny pomiar pierwszej klatki przeciągania.

**Kryterium odbioru:** każdy przykład z §7.2 działa od wpisania w szybkim dodawaniu do ukończenia na drugim urządzeniu; przypomnienie przychodzi tylko na wybrane urządzenie (±1 min); projekt przeprowadzony przez kanban od „Do zrobienia” do „Gotowe”.

---

## v1.0 — Kompletny produkt (≈ 31–41 dni)

### Etap 5 — Kalendarz, time-blocking, odczyt kalendarzy zewnętrznych (≈ 5–6 dni)
- Web: FullCalendar dzień/tydzień/miesiąc, panel zadań do przeciągania, zmiana długości, wiersz „cały dzień”, wolne okna, ostrzeżenia o nakładaniu się (`core/time-blocking.ts`).
- Telefon: oś dnia z przeciąganiem bloków, tydzień (agenda), miesiąc; wydarzenia z kalendarza telefonu (`expo-calendar`).
- Kalendarze zewnętrzne — odczyt: ICS, Google Calendar API (wybór kalendarzy, `syncToken`, `watch`), tabele `calendar_*`, ekran „Połączone kalendarze”.
- „Dziś” z planem dnia (wydarzenia + bloki) i listą konfliktów.

**Kryterium odbioru:** plan dnia ułożony przeciąganiem na webie, spotkania z kalendarza firmowego widoczne obok, konflikt oznaczony; telefon pokazuje ten sam plan offline.

### Etap 6 — Oś czasu i zależności (≈ 4–5 dni)
- Gantt (SVAR React Gantt, D18): projekty i zadania, przesuwanie, rozciąganie, skale, linia „dziś”. Warunki z PoC-5: widok zamontowany po pierwszym otwarciu (przełączenie < 150 ms), polskie napisy z `@svar-ui/gantt-locales`, zależność zapisywana dopiero po `detectCycle` (SVAR przyjmuje cykle).
- Zależności `finish_to_start` z `lag_days`: tworzenie przeciągnięciem, strzałki, naruszenia, „Przesuń zależne” (`core/dependencies.ts`), blokada cykli.
- Daty projektu i postęp na osi; zależności widoczne też w panelu zadania [W+A] (lista poprzedników/następników).

**Kryterium odbioru:** projekt „Remont kuchni” z 15 zadaniami i 8 zależnościami zaplanowany na osi i przesunięty o tydzień jednym ruchem bez naruszeń; próba utworzenia cyklu jest blokowana.

### Etap 7 — Tryb skupienia (≈ 2–3 dni)
- Widok pełnoekranowy [W+A], Pomodoro z ustawieniami, stoper, `time_entries`, czas spędzony kontra szacowany w zadaniu, statystyki tygodnia.
- Telefon: trwałe powiadomienie z timerem i akcjami, `expo-keep-awake`, powiadomienie końca etapu przy zamkniętej aplikacji.

**Kryterium odbioru:** timer po zamknięciu karty/aplikacji i ponownym otwarciu pokazuje poprawny czas; 4 cykle Pomodoro dają 4 wpisy pracy i przerwy; aktywny timer widoczny na drugim urządzeniu.

### Etap 8 — Nawyki (≈ 3–4 dni)
- Typ `habit`, sekcja „Nawyki”, blok w „Dziś”, odhaczanie (także wstecz 7 dni, dni wolne, cele ilościowe i „N razy w tygodniu”).
- Statystyki M15 (passy, regularność, mapa cieplna, wykres), przypomnienia nawyków, odhaczanie z powiadomienia.

**Kryterium odbioru:** statystyki zgodne z ręcznym wyliczeniem na 90-dniowych historiach testowych (Vitest) i na urządzeniu po miesiącu używania 3 nawyków.

### Etap 9 — Przegląd dnia i tygodnia (≈ 2–3 dni)
- Asystent przeglądu dnia [W+A] z akcjami (klawisze 1–6 / gesty), podsumowanie i plan jutra; przegląd tygodnia (kroki z M16); powiadomienia o porze przeglądu; `review_sessions`, oznaczanie zadań przenoszonych ≥ 3 razy.

**Kryterium odbioru:** przegląd 20 zaległych zadań w < 3 min klawiaturą na webie i gestami na telefonie; po przeglądzie tygodnia Inbox jest pusty, a każdy aktywny projekt ma następny krok.

### Etap 10 — Przechwytywanie i załączniki (≈ 4–5 dni)
- Załączniki M5: Storage, kolejka plików offline, podgląd obrazów i PDF, aparat na telefonie.
- Link → zadanie: `expo-share-intent`, Web Share Target, bookmarklet, `link-preview` (z ochroną SSRF), wklejenie URL.

**Kryterium odbioru:** zdjęcie z aparatu dodane offline staje się załącznikiem zadania po synchronizacji; link udostępniony z Chrome na Androidzie daje zadanie z tytułem strony (offline — po synchronizacji).

### Etap 11 — Widżety i PWA (≈ 3–4 dni)
- Widżety Android: „Dziś”, „Szybkie dodawanie”, „Nawyki”; odświeżanie po zmianach i co 30 min.
- PWA: skróty w manifeście, ikony, instalacja na pulpicie, przegląd kompletności offline (lista wyjątków M20 w UI).

**Kryterium odbioru:** zadanie odhaczone z widżetu w trybie samolotowym jest ukończone na webie po powrocie sieci; PWA zainstalowana na pulpicie uruchamia szybkie dodawanie ze skrótu.

### Etap 12 — Dwukierunkowa synchronizacja kalendarza (≈ 4–5 dni)
- Dostawca według D8 (domyślnie Google): osobny kalendarz „TaskPlanner”, zadania z godziną → wydarzenia, zmiany wydarzeń → operacje z HLC serwera, usunięcie wydarzenia → zadanie bez godziny, ochrona przed pętlami (`etag`, znacznik źródła), ustawienia (które przestrzenie wysyłać).

**Kryterium odbioru:** przesunięcie bloku w kalendarzu dostawcy zmienia godzinę zadania < 1 min i odwrotnie; po tygodniu używania 0 duplikatów i 0 zgubionych zmian.

### Etap 13 — Stabilizacja i wydanie (≈ 4–6 dni)
- Testy E2E: Playwright (szybkie dodawanie, kanban, kalendarz, oś czasu, paleta, offline), Maestro (Dziś, szybkie dodawanie, przypomnienie, widżet).
- Wydajność na 10 000 zadań (§9), poprawki indeksów lokalnych i zapytań.
- Kopie zapasowe: nocny `pg_dump` (GitHub Actions), eksport/import JSON w ustawieniach (bez importu z innych narzędzi — D13).
- Raportowanie błędów (do decyzji: Sentry albo własny dziennik w Supabase), APK `production`, dokumentacja w `CLAUDE.md` i `README.md`.

**Kryterium odbioru:** dwa tygodnie codziennego używania na obu urządzeniach bez utraty danych; `npm run check`, `test:db`, `test:sync` i E2E zielone; odtworzenie bazy z kopii sprawdzone.

---

## v1.x — Później (COULD)
- Microsoft 365 / Outlook (Graph API) dwukierunkowo (D8 = Google, więc nie wcześniej).
- E-mail → Inbox (M19: Cloudflare Email Routing + Email Worker + `inbound-email`, parser w temacie, załączniki, token i nadawcy, dziennik) — wymaga domeny z DNS w Cloudflare (D9). Tymczasowe `inbound_addresses` z PoC-6 → `profiles.inbox_token` / `inbound_senders`, strefa z ustawień profilu.
- Współdzielenie przestrzeni z innymi osobami (role `editor`/`viewer`, schemat już jest), przypisywanie zadań, komentarze.
- AI przez `packages/ai` z EP: rozbijanie zadania na podzadania, AI jako uzupełnienie parsera, podsumowanie tygodnia, automatyczne ułożenie dnia w wolnych oknach.
- Własne statusy i kolumny kanbanu, sekcje w projektach, limity WIP, tory (swimlanes).
- Szablony projektów, ścieżka krytyczna na osi czasu.
- Tekstowy język filtrów (`@telefon & dziś & !1`).
- Desktop: Tauri (zasobnik, globalny skrót szybkiego dodawania, widżet pulpitu).
- iOS, Wear OS (kafelek „Dziś”), przypomnienia według lokalizacji, dyktowanie zadań.

---

## Harmonogram zbiorczy
| Faza | Dni skupionej pracy | Wynik |
|---|---|---|
| Etap 0 | 1–2 | szkielet monorepo, konta, korpusy testowe |
| PoC-1…6 | 11–15 | decyzje architektury, kod synchronizacji, parsera i cykliczności |
| MVP-1…4 | 18–25 | codzienne używanie na webie i telefonie offline: listy, szybkie dodawanie, cykliczność, przypomnienia, kanban |
| Etapy 5–13 | 31–41 | kalendarz, oś czasu, skupienie, nawyki, przeglądy, przechwytywanie, widżety, kalendarz dwukierunkowy, wydanie |
| **Razem do v1.0** | **61–83** | |

Kolejność etapów 5–12 można zmieniać według potrzeb (są od siebie niezależne poza Etapem 12, który wymaga Etapu 5). Etap 13 zawsze na końcu.
