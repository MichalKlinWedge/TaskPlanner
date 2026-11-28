# Task Planner

Osobisty system zadań codziennych. Na laptopie (web, PWA) służy do planowania: listy, kanban, kalendarz z time-blockingiem, oś czasu z zależnościami, przeglądy dnia i tygodnia. Na telefonie (Android) służy do wykonania: szybkie dodawanie, „Dziś”, przypomnienia, tryb skupienia, zadania cykliczne, widżety.

Oba klienty są **local-first**: czytają i piszą lokalną bazę SQLite, działają w pełni offline, a synchronizacja z Supabase idzie w tle. Konflikty rozstrzyga last-writer-wins per pole na zegarach HLC.

## Dokumentacja

| Plik | Co zawiera |
|---|---|
| [SPECYFIKACJA.md](SPECYFIKACJA.md) | funkcje (M1…M20), gramatyka szybkiego dodawania (§4), model danych (§5), synchronizacja (§6), silniki w `packages/core` (§7), decyzje D1–D20 (§12) |
| [PLAN_ETAPOWY.md](PLAN_ETAPOWY.md) | etapy PoC → MVP-1…4 → Etapy 5–13 z kryteriami odbioru i stanem każdego |
| [CLAUDE.md](CLAUDE.md) | zasady architektury i skrót stanu kodu (po angielsku, dla asystenta) |
| [docs/USLUGI.md](docs/USLUGI.md) | sprawdzone warunki i limity usług zewnętrznych |
| [docs/POC_WYNIKI.md](docs/POC_WYNIKI.md) | wyniki PoC i odstępstwa od §5 |
| [docs/ANDROID_BUILD.md](docs/ANDROID_BUILD.md) | build APK lokalnie i w GitHub Actions (bez EAS), podpisywanie |
| [docs/POC6_KONFIGURACJA.md](docs/POC6_KONFIGURACJA.md) | konfiguracja integracji: Google Calendar, ICS, Web Push, e-mail |
| [docs/KOPIE_ZAPASOWE.md](docs/KOPIE_ZAPASOWE.md) | nocny zrzut bazy, eksport/import JSON, odtworzenie |
| [docs/instrukcja/INSTRUKCJA.md](docs/instrukcja/INSTRUKCJA.md) | instrukcja użytkownika aplikacji web ze zrzutami; PDF: `npm run docs:pdf`, nowe zrzuty: `npm run docs:screens` |
| `docs/*_TELEFON.md` | scenariusze ręcznych prób na telefonie (PoC-4, MVP-1, MVP-3) |

## Stos

- **Web** (`apps/web`): Next.js 16, Tailwind, FullCalendar, dnd-kit, SVAR React Gantt, TipTap. SQLite WASM (`opfs-sahpool`) w workerze, jedna karta-lider (Web Locks). Service Worker do startu offline. Wdrożenie: Vercel.
- **Android** (`apps/mobile`): Expo SDK 58, expo-sqlite, przypomnienia dokładne (`USE_EXACT_ALARM`), widżety, udostępnianie. APK poza Google Play, bez EAS i OTA (D17).
- **Backend**: Supabase (Postgres z RLS, Realtime jako sygnał do pobrania, Storage na załączniki, Edge Functions w Deno, `pg_cron` + `pg_net`).
- **Wspólny kod**:
  - `packages/core` — logika domenowa w czystym TS (parser szybkiego dodawania, cykliczność, widoki, zależności, time-blocking, nawyki, przypomnienia, Pomodoro, przeglądy, kopie, dziennik błędów);
  - `packages/sync` — lokalna baza, kolejka zmian, `push_changes`/`pull_changes`, koordynacja kart;
  - `packages/db` — typy wygenerowane z bazy.

## Struktura

```
apps/web            Next.js (PWA)
apps/mobile         Expo (Android)
packages/core       logika domenowa (działa w przeglądarce, Hermes i Deno)
packages/sync       synchronizacja local-first
packages/db         typy Supabase (npm run gen --workspace packages/db)
supabase/           migracje, testy pgTAP (tests/), Edge Functions (functions/), config.toml
tools/edge-tests    testy funkcji (jednostkowe w Node + integracyjne z fałszywymi usługami)
tools/seed-dev      konto deweloperskie i deterministyczny zbiór danych
tools/email-worker  Cloudflare Email Worker (e-mail → zadanie, v1.x)
fixtures/           korpusy regresyjne (szybkie dodawanie, cykliczność, nawyki)
scripts/            synchronizacja zmiennych, drugi serwer dev, kopie zapasowe, grafika
```

## Start lokalnie

Wymagania:
- Node ≥ 22;
- Docker (lokalny Supabase);
- do telefonu: JDK i Android SDK (szczegóły w [docs/ANDROID_BUILD.md](docs/ANDROID_BUILD.md)).

```bash
npm install
cp .env.example .env.local        # uzupełnij klucze (opis w pliku)
npm run supabase -- start         # lokalny Supabase, porty 545xx
npm run dev:user                  # konto dev@taskplanner.test (hasło w .env.local: DEV_USER_PASSWORD)
npm run seed:dev -- --load        # opcjonalnie: 5 przestrzeni, 2 000 zadań, 15 nawyków
npm run web:local                 # http://localhost:3000 na lokalnym Supabase
```

Logowanie lokalnie idzie linkiem z e-maila: lokalna skrzynka Mailpit to http://127.0.0.1:54524. Logowanie Google działa tylko w chmurze.

Na tym samym komputerze działa kilka niezależnych stosów Supabase (porty 543xx, 544xx). Ten projekt ma porty 545xx.

| Polecenie | Co robi |
|---|---|
| `npm run web` | web na Supabase z `.env.local` (zwykle chmura) |
| `node scripts/dev-alt.mjs --local --port 3010` | drugi `next dev` obok pierwszego |
| `node scripts/dev-alt.mjs --local --port 3011 --prod` | build produkcyjny + `next start` — jedyny sposób na Service Worker, start offline i Web Push |
| `npm run mobile` | Metro dla development buildu (nie Expo Go); APK: `cd apps/mobile && npx expo run:android` |
| `npm run supabase -- db reset` | ponownie wszystkie migracje (kasuje lokalne dane) |
| `npm run setup --workspace tools/edge-tests` | sekrety funkcji do `supabase/functions/.env*` i Vault dla `pg_cron` |
| `npm run serve:test --workspace tools/edge-tests` | funkcje z fałszywymi Google, ICS i usługą push |

## Testy

| Polecenie | Zakres |
|---|---|
| `npm run check` | typy, lint i testy jednostkowe we wszystkich workspace'ach (bez sieci i bazy) |
| `npm run test:db` | pgTAP w `supabase/tests` (RLS, `push_changes`, integracje, załączniki, kopie, dziennik błędów) — lokalny Supabase |
| `npm run test:sync` | scenariusze synchronizacji: dwa urządzenia, offline, LWW, Realtime — lokalny Supabase |
| `npm run test:integration --workspace tools/edge-tests` | Edge Functions z fałszywymi usługami — lokalny Supabase + `serve:test` |
| `npm run typecheck:deno --workspace tools/edge-tests` | `deno check` funkcji |
| `npm run test:e2e` | Playwright na webie (szybkie dodawanie, kanban, kalendarz, oś czasu, paleta, start offline) — lokalny Supabase |
| `npm run test:mobile` | Maestro na telefonie przez USB: szybkie dodawanie i „Dziś”, przypomnienie, widżet — lokalny Supabase, APK zalogowany na `dev@taskplanner.test`, Maestro CLI i JDK ≥ 17 (`MAESTRO_JAVA_HOME`), widżet „Dziś” na ekranie głównym, odblokowany telefon (~5 min bez dotykania) |

Pojedynczy test: `npx vitest run src/__tests__/sort-key.test.ts` (albo `-t "nazwa"`) w danym pakiecie.

Korpusy w `fixtures/` (szybkie dodawanie, cykliczność, nawyki) muszą zostać na 100 %. Każda nowa forma albo pułapka parsera dostaje swój przypadek.

## Wdrożenie

- **Web**: projekt Vercel `task-planner` (Root Directory `apps/web`) wdraża się sam z `main`. Produkcja: https://task-planner-omega-indol.vercel.app. Strony `/dev/*` na produkcji zwracają 404.
- **Baza**: projekt Supabase `sakjrlpfbclcjlnpjcrt` (`npm run supabase -- link`).
  ```bash
  npm run supabase -- migration list --linked
  npm run supabase -- db push --linked
  ```
  W chmurze nowe tabele nie dostają automatycznie uprawnień ról API: każda migracja z nową tabelą ma jawne `grant`.
- **Edge Functions**:
  ```bash
  npm run supabase -- functions deploy <nazwa> --project-ref sakjrlpfbclcjlnpjcrt --import-map supabase/functions/deno.json --no-verify-jwt
  ```
  Sekrety ustawia `npm run supabase -- secrets set …`; lista jest w [supabase/functions/README.md](supabase/functions/README.md).
- **Android**: APK budowany lokalnie albo przez `.github/workflows/android.yml`. Aktualizacja to nowy APK (bez OTA).
- **Kopie zapasowe**: nocny `.github/workflows/db-backup.yml` (zaszyfrowany `pg_dump`) potrzebuje sekretów repozytorium `SUPABASE_DB_URL` i `BACKUP_PASSPHRASE`. Ręczny eksport i import JSON jest w Ustawieniach → „Kopia zapasowa”.
- **Błędy aplikacji**: własny dziennik w Supabase (D20, tabela `client_errors`, 90 dni), podgląd w Ustawieniach → „Błędy aplikacji”. Błędy Edge Functions są w logach Supabase.

## Zasady (skrót)

- UI czyta i pisze tylko lokalną bazę. Sieć to sprawa `packages/sync` w tle, bez osobnej „ścieżki offline” w widokach.
- Reguły domenowe są tylko w `packages/core`. Aplikacje ich nie powtarzają.
- Tabele synchronizowane zmienia tylko `push_changes`. Nowa kolumna wymaga kolejno:
  1. migracji;
  2. `npm run gen --workspace packages/db`;
  3. wpisu w `TABLES` w `packages/sync/src/specs.ts`;
  4. wpisu w `MODEL` w `packages/core/src/schemas/model.ts`.
- Czas zadań jest pływający (`due_date`, `due_time` według zegara ściennego). Prawdziwe zdarzenia są typu `timestamptz`.
- Dokumentacja, teksty UI i komentarze są po polsku, identyfikatory po angielsku.
- Sekrety są tylko w plikach ignorowanych przez git, sekretach Supabase, Vault i GitHub Secrets. Tokeny OAuth nigdy nie trafiają do przeglądarki ani do APK.
