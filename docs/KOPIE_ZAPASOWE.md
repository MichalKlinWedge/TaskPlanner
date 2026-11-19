# Kopie zapasowe (Etap 13)

Dwie niezależne warstwy:

| | Nocny zrzut bazy | Eksport JSON |
|---|---|---|
| Co | cała baza chmury: wszystkie tabele `public` (także integracje, dziennik zmian) + konta (`auth.users`, `auth.identities`) | dane jednego użytkownika z lokalnej bazy przeglądarki |
| Kto i kiedy | GitHub Actions, co noc 02:17 UTC (`.github/workflows/db-backup.yml`) | użytkownik, Ustawienia → „Kopia zapasowa” |
| Gdzie | artefakt workflow, szyfrowany GPG (AES-256), retencja 30 dni | plik `taskplanner-RRRR-MM-DD.json` na dysku |
| Odtworzenie | `scripts/backup.mjs restore` na pustą bazę z tymi samymi migracjami | „Importuj z pliku…” — zwykła synchronizacja (`mutateMany` → `push_changes`) |

Supabase Free nie robi kopii (dzienne kopie i PITR są od planu Pro — `docs/USLUGI.md`), więc nocny zrzut jest jedyną kopią po stronie serwera.

## 1. Nocny zrzut — konfiguracja (jednorazowo, robi użytkownik)

Repozytorium jest **publiczne**: artefakty i logi workflow może obejrzeć każdy z dostępem do odczytu. Dlatego archiwum jest szyfrowane, a do logów nie trafia nic z danych (sumy kontrolne są w archiwum).

### Sekrety (GitHub → Settings → Secrets and variables → Actions → *New repository secret*)

| Sekret | Wartość |
|---|---|
| `SUPABASE_DB_URL` | adres bazy przez **Session pooler** (IPv4): panel Supabase → projekt `sakjrlpfbclcjlnpjcrt` → *Connect* → *Session pooler* → URI, np. `postgresql://postgres.sakjrlpfbclcjlnpjcrt:HASLO@aws-…-eu-west-1.pooler.supabase.com:5432/postgres`. Hasło bazy z *Project Settings → Database* (znaki specjalne zakodowane w URL, np. `@` → `%40`). Połączenie bezpośrednie (`db.<ref>.supabase.co`) jest tylko IPv6, a runnery GitHuba mają tylko IPv4. |
| `BACKUP_PASSPHRASE` | hasło szyfrowania archiwum, ≥ 20 znaków (workflow odrzuca krótsze), np. `openssl rand -base64 32`. **Zapisz je w menedżerze haseł** — bez niego kopia jest nie do odczytania. |

Z wiersza poleceń (`gh` pyta o wartość, nie zostaje w historii):

```powershell
gh secret set SUPABASE_DB_URL --repo MichalKlinWedge/TaskPlanner
```

```powershell
gh secret set BACKUP_PASSPHRASE --repo MichalKlinWedge/TaskPlanner
```

Opcjonalnie zmienna (*Variables*) `BACKUP_RETENTION_DAYS` — dni przechowywania artefaktu (domyślnie 30; publiczne repozytorium: 1–90).

Bez obu sekretów workflow kończy się ostrzeżeniem „Kopia nie jest skonfigurowana” (zielony, nic nie robi); z jednym — błędem.

### Pierwsze uruchomienie

Actions → **Kopia bazy** → *Run workflow* (gałąź `main`; harmonogram działa tylko z gałęzi domyślnej). Po kilku minutach w przebiegu jest artefakt `taskplanner-db-RRRRMMDD-GGMM`. W publicznym repozytorium GitHub wyłącza zaplanowane workflow po 60 dniach bez aktywności w repozytorium — wtedy włączyć je ponownie w zakładce Actions.

### Co jest w archiwum (`dump/`)

| Plik | Zawartość |
|---|---|
| `data.sql` | dane (`pg_dump --data-only`): tabele `public.*`, `auth.users`, `auth.identities` |
| `schema.sql` | schemat `public` do wglądu (odtworzenie stawia schemat z `supabase/migrations`) |
| `checksums.json` | liczba wierszy i md5 każdej tabeli — liczone przed i po zrzucie (różnica = ponowny zrzut) |
| `meta.json` | chwila zrzutu, wersja serwera, lista zastosowanych migracji |

**Poza zrzutem:** sekrety Vault (tokeny OAuth Google, `functions_url`, `cron_secret` — zaszyfrowane kluczem projektu), pliki w Storage, sesje i tokeny odświeżania (`auth.sessions`, `auth.refresh_tokens` — po odtworzeniu trzeba się zalogować), zadania `pg_cron` (tworzą je migracje).

## 2. Odtworzenie ze zrzutu

### Pobranie i odszyfrowanie (Git Bash — ma `gpg` i `tar`)

```bash
gh run download --repo MichalKlinWedge/TaskPlanner -n taskplanner-db-20261120-0217 -D kopia
cd kopia
gpg --decrypt taskplanner-db-20261120-0217.tar.gz.gpg | tar -xzf -   # pyta o BACKUP_PASSPHRASE
```

Powstaje katalog `dump/`.

### Na lokalny Supabase

`restore` przyjmuje tylko **pustą** bazę z **tymi samymi migracjami** co zrzut (sprawdza `meta.json`) — odtwarzać z checkoutu z tymi migracjami.

```powershell
npm run supabase -- start
```

```powershell
npm run supabase -- db reset
```

(`db reset` kasuje lokalne dane — wspólny stos `taskplanner` używają też inne sesje; do samej próby odtworzenia lepszy `verify` niżej.)

```powershell
node scripts/backup.mjs restore --in kopia/dump --container supabase_db_taskplanner
```

Skrypt wgrywa `data.sql` w jednej transakcji z wyłączonymi triggerami (`session_replication_role = replica` — `row_version`, `field_clock`, znaczniki czasu zostają jak w zrzucie), potem porównuje liczby wierszy i sumy md5 wszystkich tabel z `checksums.json`; różnica = kod wyjścia 1 i lista tabel. Na Windows `--container` używa `psql` z kontenera bazy (bez instalowania PostgreSQL); z natywnym klientem 17: `--db-url postgresql://postgres:postgres@127.0.0.1:54522/postgres`.

Po odtworzeniu: konta i dane są, logowanie od nowa (sesji nie ma). Kalendarze Google połączyć ponownie, Vault ustawić `npm run setup --workspace tools/edge-tests`.

### Na nowy projekt w chmurze (awaria projektu)

1. Nowy projekt Supabase, `npm run supabase -- link --project-ref <nowy>`, `npm run supabase -- db push` (migracje), sekrety i funkcje jak w `docs/POC6_KONFIGURACJA.md`.
2. `node scripts/backup.mjs restore --in dump --db-url "<Session pooler nowego projektu>"` — wymaga natywnego `psql` 17 (Linux / WSL / runner GitHuba).
3. Zmienne aplikacji (`NEXT_PUBLIC_SUPABASE_URL`, klucze) na Vercelu i w APK na nowy projekt; OAuth Google — nowy adres przekierowania.

Uwaga: jeśli wersja Auth (GoTrue) w docelowym projekcie ma inne kolumny `auth.users` niż źródło, `COPY` się nie powiedzie — lokalnie wtedy nowsza wersja CLI.

### Sprawdzenie bez ruszania danych: `verify`

```powershell
node scripts/backup.mjs verify
```

Zrzut z lokalnego `supabase_db_taskplanner` (tylko odczyt) → osobny tymczasowy stos `taskplanner-restore` (porty 546xx, tylko baza i Auth, migracje z tego checkoutu) → `restore` → porównanie sum kontrolnych → zatrzymanie stosu (`--no-backup`; `--keep` zostawia go do obejrzenia). Ten sam kod co nocny zrzut, tylko narzędzia z kontenera.

**Wynik 19.11.2026:** 29 tabel, 25 262 wiersze (m.in. 9 465 zadań, 224 konta) — liczby i sumy kontrolne po odtworzeniu zgodne ze zrzutem. Szyfrowanie i odszyfrowanie (`gpg` jak w workflow) sprawdzone w Git Bash. Workflow w GitHubie jeszcze nie uruchomiony (czeka na sekrety).

## 3. Eksport i import JSON (Ustawienia → „Kopia zapasowa”)

- **Eksport** — wszystkie wiersze tabel synchronizowanych z lokalnej bazy przeglądarki (także kosz), bez `devices` (urządzenia i subskrypcje push), tabel integracji (konta i wydarzenia kalendarzy, tokeny w Vault), plików załączników (w kopii tylko opis) i kolumn systemowych (`created_at`, `row_version`, `field_clock`). Działa offline. Pusta lokalnie kolumna `not null` (wiersz zapisany offline, jeszcze bez odpowiedzi serwera) dostaje wartość domyślną bazy (`BACKUP_DEFAULTS`; zgodność z migracjami pilnuje `supabase/tests/backup.test.sql`).
- **Format** (`packages/core/src/backup.ts`): `{ format: "taskplanner-backup", version: 1, exportedAt, userId, tables: { profiles, workspaces, lists, tasks, tags, task_tags, task_completions, reminders, task_dependencies, time_entries, attachments, saved_filters, review_sessions } }`; wiersz = `id` + kolumny ze schematu `MODEL` + `deleted_at`, `jsonb` jako obiekty (camelCase), kolumny snake_case. Walidacja: koperta (obcy plik, nowsza wersja → komunikat), każdy wiersz osobno schematem Zod (`MODEL` + `deleted_at`) — błędne i powtórzone pomijane i pokazane w podglądzie. Import bierze wartości z pliku, nie wynik `parse` (bez domyślnych i przycinania).
- **Import** — najpierw podgląd: na tabelę nowe / zmienione / bez zmian, błędne wiersze, ostrzeżenie o innym koncie. „Przywróć” zapisuje przez `mutateMany` (porcje po 500, w kolejności rodzic → dziecko, zadania od korzenia drzewa) — outbox → `push_changes`, te same id, tylko pola różniące się od lokalnych (chwile porównywane jako czas, `jsonb` bez kolejności kluczy). Ten sam plik drugi raz = 0 zmian; przerwany import wystarczy powtórzyć. Wiersze z kopii wracają do stanu z pliku (również zmienione lub usunięte później); wierszy spoza kopii import nie usuwa.
- **Inne konto** (np. po utracie konta na serwerze): zakres osobisty (`scope_id` = stare konto) i id profilu przechodzą na zalogowanego, `calendar_sync` odpada. Przestrzenie, które wciąż należą do starego konta, serwer odrzuci (`TP003`).
- Bez importu z innych narzędzi (D13).

**Testy:** `packages/core/src/__tests__/backup.test.ts` (koperta, walidacja, plan, porównanie), `packages/sync/src/__tests__/backup.test.ts` (eksport → pusta baza → import = te same dane przez outbox, drugi import 0 zmian, przywrócenie zmienionych/usuniętych, inne konto), `backup.integration.test.ts` w `npm run test:sync` (na lokalnym Supabase: wyczyszczona lokalna baza → import bez odrzuceń, trzecie urządzenie pobiera to samo; usunięte konto → kopia na nowe konto → nowe urządzenie pobiera te same dane).
