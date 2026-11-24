# Instalacja na serwerze klienta (self-hosted, Docker)

Task Planner w całości na serwerze klienta: bez Vercela i bez chmury Supabase. Na zewnątrz zostają tylko Google, AI (Gemini) i Web Push przeglądarek (§2).

> **Stan na 24.11.2026 — projekt wdrożenia, nie gotowy pakiet.** Pliki z tego dokumentu (Dockerfile, override compose) nie są w repozytorium i nie były uruchomione jako całość. Co sprawdzono, a czego nie: §14. Zmiany w kodzie potrzebne przed wdrożeniem: §12.

W przykładach: `tasks.klient.pl` = aplikacja webowa, `api.klient.pl` = Supabase.

## 1. Architektura

```
przeglądarka / telefon
        │ HTTPS 443
        ▼
   Caddy (TLS) ── tasks.klient.pl ──► web (Next.js, port 3000)
        │
        └──────── api.klient.pl ───► api-gw (Envoy, 8000)
                                        ├─► auth      (GoTrue)
                                        ├─► rest      (PostgREST)
                                        ├─► realtime
                                        ├─► storage   (pliki: volumes/storage)
                                        └─► functions (Edge Runtime, 7 funkcji)
                                                │
   db (Postgres 17 + pg_cron, pg_net, Vault) ◄──┘
     └─ pg_cron → pg_net → http://api-gw:8000/functions/v1/…
```

| Dziś | U klienta |
|---|---|
| Vercel | kontener `web` |
| Supabase w chmurze | oficjalny stos `docker/` z repozytorium Supabase |
| maile Supabase Auth | SMTP klienta |
| GitHub Actions (nocna kopia) | zadanie cron na serwerze (§10) |
| GitHub Releases (APK) | własny APK i własny serwer wydań (§9) |
| `npm run supabase -- secrets set` | plik `.env.functions` |
| ustawienia w panelu (hook, szablon maila, adresy) | zmienne `GOTRUE_*` (§6) |

Web nie ma własnego backendu (żadnych tras API ani middleware): przeglądarka łączy się wprost z Supabase.

## 2. Ruch na zewnątrz

| Usługa | Kiedy | Wyłączenie |
|---|---|---|
| Google Calendar | użytkownik połączy kalendarz | nie ustawiać `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |
| Gemini | użytkownik doda własny klucz | nie dodawać kluczy |
| Web Push (FCM, Mozilla, Microsoft, Apple) | powiadomienia w przeglądarce; treść jest szyfrowana | nie ustawiać `VAPID_*` |
| kalendarze ICS, podglądy linków, webhooki, GitLab | adresy podane przez użytkowników | zapora wychodząca |
| Let's Encrypt | certyfikat | własny certyfikat (§9 — ograniczenie APK) |
| rejestry Docker, npm, JSR, Google Fonts | budowanie obrazów i pierwszy start funkcji | instalacja bez internetu (§11) |

Do działania **nie** są potrzebne: Vercel, Supabase w chmurze, Firebase, Expo/EAS, CDN. Czcionki z `next/font/google` są pobierane przy `next build` i serwowane z własnej domeny. Przypomnienia na Androidzie planuje sam telefon.

Ruch przychodzący z internetu wymagany jest tylko przez kalendarz Google (webhook `https://api.klient.pl/functions/v1/calendar-sync/google/webhook`). Bez niego zmiany z Google przychodzą z `cron/poll` co 10 minut.

## 3. Wymagania

| | Minimum | Zalecane |
|---|---|---|
| RAM | 4 GB | 8 GB+ |
| CPU | 2 rdzenie | 4+ |
| Dysk | 40 GB SSD | 80 GB+ SSD |

(Liczby Supabase dla całego stosu. Budowanie obrazu `web` najlepiej robić poza serwerem klienta.)

- Linux z Docker Engine i Docker Compose, `git`, `jq`, `openssl`; Node.js ≥ 22 do migracji (albo uruchomić je z innego komputera).
- Dwie nazwy DNS i **HTTPS z certyfikatem publicznie zaufanym**, także w intranecie (np. Let's Encrypt z weryfikacją DNS-01). Service Worker, OPFS (lokalna baza w przeglądarce) i Web Push działają tylko w bezpiecznym kontekście, a wydany APK nie łączy się po HTTP.
- **SMTP.** Logowanie to link lub kod z maila, nie ma haseł. Logowanie Google jest opcjonalne.
- Otwarte z zewnątrz tylko 80 i 443.

## 4. Instalacja Supabase

Instrukcja źródłowa: <https://supabase.com/docs/guides/self-hosting/docker>. Skrypt instalacyjny przejrzeć przed uruchomieniem; można go zastąpić instalacją ręczną z tej samej strony.

```sh
curl -fsSL https://supabase.link/setup.sh -o setup.sh
less setup.sh
sh setup.sh
cd supabase-project
sh run.sh config add caddy
```

Skrypt generuje sekrety i pary kluczy do `.env`. Zapisać je w sejfie haseł klienta.

W `.env`:

```sh
SUPABASE_PUBLIC_URL=https://api.klient.pl
API_EXTERNAL_URL=https://api.klient.pl/auth/v1
SITE_URL=https://tasks.klient.pl
ADDITIONAL_REDIRECT_URLS=https://tasks.klient.pl/**,taskplanner://**
PROXY_DOMAIN=api.klient.pl

DISABLE_SIGNUP=false            # zakładanie kont ogranicza hook zaproszeń (§6)
ENABLE_EMAIL_SIGNUP=true
ENABLE_EMAIL_AUTOCONFIRM=true   # jak `enable_confirmations = false` w supabase/config.toml
ENABLE_PHONE_SIGNUP=false
ENABLE_ANONYMOUS_USERS=false
FUNCTIONS_VERIFY_JWT=false      # funkcje same sprawdzają wywołującego

SMTP_ADMIN_EMAIL=tasks@klient.pl
SMTP_HOST=smtp.klient.pl
SMTP_PORT=587
SMTP_USER=…
SMTP_PASS=…
SMTP_SENDER_NAME=Task Planner

POOLER_TENANT_ID=taskplanner
TASKPLANNER_VERSION=0.1.0       # tag obrazu web (§5)
```

`API_EXTERNAL_URL` musi kończyć się na `/auth/v1` (tak liczą go obecne wydania stosu).

Wersję stosu **przypiąć** (`.supabase-version` i tagi obrazów), a każdą nową najpierw sprawdzić na instancji testowej.

## 5. Obrazy i pliki aplikacji

Układ na serwerze:

```
/opt/taskplanner/
  app/                     # checkout wydania (tag z repozytorium)
  supabase-project/        # stos z §4
    .env  .env.functions
    docker-compose.taskplanner.yml
    mail/magic_link.html
    volumes/functions/…    # funkcje aplikacji
    volumes/packages/…     # packages/core i packages/ai
```

### Obraz `web`

`apps/web/Dockerfile` (do dodania; kontekst = katalog główny repozytorium):

```dockerfile
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY . .
RUN npm ci --workspace apps/web --include-workspace-root
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace apps/web

FROM node:24-bookworm-slim
WORKDIR /src
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /src ./
USER node
EXPOSE 3000
WORKDIR /src/apps/web
CMD ["npm", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"]
```

`.dockerignore` (bez niego do obrazu trafią `.env.local` i zależności z komputera):

```
.git
**/node_modules
**/.next*
**/.env*
apps/mobile/android
**/out
```

```sh
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://api.klient.pl \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<SUPABASE_PUBLISHABLE_KEY z .env> \
  -t taskplanner-web:0.1.0 .
```

`NEXT_PUBLIC_*` są **wbudowywane przy budowaniu**: zmiana domeny albo klucza = nowy obraz. Klucz „publishable” jest publiczny z założenia. `SUPABASE_SECRET_KEY` i `SERVICE_ROLE_KEY` nigdy nie trafiają do obrazu `web`.

### Edge Functions

Funkcje importują `packages/core` i `packages/ai` ścieżką względną (`../../../packages/…`). W kontenerze katalog funkcji to `/home/deno/functions`, więc pakiety muszą być w **`/home/packages`**. Router `main` ze stosu zostaje.

```sh
cd /opt/taskplanner
P=supabase-project/volumes
cp -r app/supabase/functions/{_shared,account-delete,ai,calendar-sync,inbound-email,link-preview,plugins,reminders-push} $P/functions/
mkdir -p $P/packages
cp -r app/packages/core app/packages/ai $P/packages/
```

Router czyta mapę importów z `volumes/functions/deno.jsonc`. Dopisać do niej wpisy z `app/supabase/functions/deno.json`, dziś:

```jsonc
{
  "imports": {
    "@supabase/functions-js": "jsr:@supabase/functions-js@^2",
    "@supabase/server": "npm:@supabase/server@^1",
    "@negrel/webpush": "jsr:@negrel/webpush@0.5.0",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.118.0",
    "postal-mime": "npm:postal-mime@4.2.1",
    "zod": "npm:zod@4.6.7"
  }
}
```

### Override compose

`docker-compose.taskplanner.yml`:

```yaml
services:
  web:
    image: taskplanner-web:${TASKPLANNER_VERSION}
    container_name: taskplanner-web
    restart: unless-stopped

  # Szablon maila: GoTrue pobiera go po HTTP z sieci Dockera.
  mail-templates:
    image: caddy:2
    container_name: taskplanner-mail-templates
    restart: unless-stopped
    command: caddy file-server --root /srv --listen :8080
    volumes:
      - ./mail:/srv:ro,z

  auth:
    environment:
      GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED: "true"
      GOTRUE_HOOK_BEFORE_USER_CREATED_URI: pg-functions://postgres/public/hook_before_user_created
      GOTRUE_MAILER_SUBJECTS_MAGIC_LINK: Logowanie do Task Planner
      GOTRUE_MAILER_TEMPLATES_MAGIC_LINK: http://mail-templates:8080/magic_link.html
      GOTRUE_MAILER_SUBJECTS_CONFIRMATION: Logowanie do Task Planner
      GOTRUE_MAILER_TEMPLATES_CONFIRMATION: http://mail-templates:8080/magic_link.html
      GOTRUE_MAILER_OTP_EXP: "3600"
      GOTRUE_MAILER_OTP_LENGTH: "6"
      GOTRUE_RATE_LIMIT_EMAIL_SENT: "100"

  functions:
    env_file:
      - .env.functions
    volumes:
      - ./volumes/packages:/home/packages:ro,z

  # Porty bazy tylko lokalnie: porty Dockera omijają reguły ufw.
  supavisor:
    ports: !override
      - 127.0.0.1:${POSTGRES_PORT}:5432
      - 127.0.0.1:${POOLER_PROXY_PORT_TRANSACTION}:6543
```

`.env` (kolejność ma znaczenie, plik na końcu):

```sh
COMPOSE_FILE=docker-compose.yml:docker-compose.caddy.yml:docker-compose.taskplanner.yml
```

Szablon maila (link i 6-cyfrowy kod — kod jest potrzebny na telefonie):

```sh
mkdir -p supabase-project/mail
cp app/supabase/templates/magic_link.html supabase-project/mail/
```

### Caddy

W `volumes/proxy/caddy/Caddyfile` dopisać blok aplikacji i ograniczyć Studio (domyślnie jest pod `api.klient.pl`, chronione tylko hasłem) do sieci wewnętrznej:

```caddyfile
tasks.klient.pl {
    reverse_proxy web:3000
    header -server
}
```

```caddyfile
# w bloku {$PROXY_DOMAIN}: zamiast ostatniego `handle { basic_auth … }`
handle {
    @outside not remote_ip private_ranges
    route {
        respond @outside 404
        basic_auth {
            import /config/dashboard-auth
        }
        reverse_proxy studio:3000
    }
}
```

`route` zachowuje kolejność, więc adres z zewnątrz dostaje 404 przed pytaniem o hasło, a ścieżki API (`@supabase_api`) działają bez zmian.

Jeśli przed Caddy stoi inne proxy, `remote_ip` widzi jego adres — wtedy Studio odciąć na tamtym proxy albo wystawić je tylko przez VPN.

## 6. Konfiguracja

### Sekrety funkcji — `.env.functions`

Nigdy w repozytorium, prawa `600`. Generowanie (raz na instalację — zmiana kluczy VAPID unieważnia subskrypcje przeglądarek):

```sh
umask 077
node --input-type=module -e '
import { randomBytes } from "node:crypto";
const p = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = (k) => crypto.subtle.exportKey("jwk", k);
const keys = { publicKey: await jwk(p.publicKey), privateKey: await jwk(p.privateKey) };
const pub = Buffer.from(await crypto.subtle.exportKey("raw", p.publicKey)).toString("base64url");
console.log("CRON_SECRET=" + randomBytes(32).toString("base64url"));
console.log("INBOUND_SECRET=" + randomBytes(32).toString("base64url"));
console.log("VAPID_PUBLIC_KEY=" + pub);
console.log("VAPID_KEYS=\x27" + JSON.stringify(keys) + "\x27");
' > .env.functions
```

Dopisać:

| Zmienna | Wartość |
|---|---|
| `VAPID_SUBJECT` | `mailto:admin@klient.pl` |
| `FUNCTIONS_PUBLIC_URL` | `https://api.klient.pl/functions/v1` (bez niej adresy Google wskażą wnętrze Dockera) |
| `APP_URL` | `https://tasks.klient.pl` (bez niej link do zadania w pluginach wskazuje produkcję autora) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | opcjonalnie (niżej) |

Nie ustawiać: `LINK_PREVIEW_TEST_HOSTS`, `PLUGIN_TEST_HOSTS`, `AI_TEST_GEMINI_BASE`, `PUSH_ALLOW_HTTP`, `GOOGLE_ALLOW_HTTP_WEBHOOK` — to obejścia zabezpieczeń dla testów.

### Google (opcjonalnie)

Klient zakłada własny projekt Google Cloud; kroki jak w `docs/POC6_KONFIGURACJA.md`, z adresami:

- kalendarz: `https://api.klient.pl/functions/v1/calendar-sync/google/callback`,
- logowanie: `https://api.klient.pl/auth/v1/callback` oraz w override usługi `auth`: `GOTRUE_EXTERNAL_GOOGLE_ENABLED: "true"`, `GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID`, `GOTRUE_EXTERNAL_GOOGLE_SECRET`, `GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI: ${API_EXTERNAL_URL}/callback`.

## 7. Pierwsze uruchomienie

**1. Start stosu** — migracje wymagają gotowych schematów `auth` i `storage`. Do kroku 4 trzymać port 443 zamknięty dla użytkowników: funkcja hooka zaproszeń powstaje dopiero w migracjach.

```sh
sh run.sh start
docker compose ps
```

**2. Migracje** z katalogu `app`, na serwerze (port bazy jest tylko lokalny):

```sh
npx --yes supabase@2.122.0 db push --db-url "postgresql://postgres.taskplanner:<POSTGRES_PASSWORD>@127.0.0.1:5432/postgres"
```

Użytkownik to `postgres.<POOLER_TENANT_ID>`; znaki specjalne hasła zakodować w URL. Polecenie zostaje w historii powłoki — hasło podać ze zmiennej. Nigdy nie uruchamiać `db reset` ani `sh reset.sh`: kasują dane.

**3. Vault** — adres i sekret dla `pg_cron` (bez nich przypomnienia push, kalendarze i pluginy po cichu nie działają):

```sql
select vault.create_secret('http://api-gw:8000/functions/v1', 'functions_url', 'pg_cron → Edge Functions');
select vault.create_secret('<CRON_SECRET z .env.functions>', 'cron_secret', 'pg_cron → Edge Functions');
```

**4. Pierwsze zaproszenie** (hook wpuszcza tylko adresy z tej listy; `@klient.pl` = cała domena):

```sql
insert into public.allowed_emails (pattern, note) values ('admin@klient.pl', 'administrator');
```

**5. Logowanie** na `https://tasks.klient.pl`, potem nadanie administratora (dalej zaproszenia przez Ustawienia → „Zaproszenia”):

```sql
insert into public.app_admins (user_id) select id from auth.users where email = 'admin@klient.pl';
```

SQL: Studio → SQL Editor albo `docker compose exec db psql -U postgres`.

## 8. Odbiór instalacji

| # | Sprawdzenie | Oczekiwane |
|---|---|---|
| 1 | `docker compose ps` | wszystkie usługi `healthy` / `running` |
| 2 | adres spoza listy zaproszeń próbuje się zalogować | odmowa, komunikat po polsku |
| 3 | adres zaproszony | mail z linkiem i kodem; działają oba |
| 4 | zadanie w dwóch przeglądarkach | zmiana widoczna w kilka sekund (Realtime) |
| 5 | praca offline i powrót sieci | zmiany dochodzą na serwer |
| 6 | załącznik | wysłany, otwiera się na drugim urządzeniu |
| 7 | `curl https://api.klient.pl/functions/v1/reminders-push/key` | `{"publicKey":"…"}` |
| 8 | `select status, count(*) from cron.job_run_details group by 1` | `succeeded` |
| 9 | `select status_code, count(*) from net._http_response group by 1` | `200`, bez `401` |
| 10 | przypomnienie przy zamkniętej karcie | powiadomienie Web Push |
| 11 | udostępnienie przestrzeni drugiemu kontu | zaproszenie, edycja, podgląd |
| 12 | kopia i odtworzenie na instancji testowej | sumy kontrolne zgodne (§10) |
| 13 | porty z zewnątrz | tylko 80 i 443; `5432`, `6543`, `8000` zamknięte |

`401` w punkcie 9 = `cron_secret` w Vault różni się od `CRON_SECRET`.

## 9. Android

Bez zmian w kodzie działa wpisanie serwera w APK: Ustawienia → „Serwer Supabase” → adres i klucz publiczny (przed zalogowaniem). Ma to dwie wady: linki zaproszeń z telefonu są niedostępne, a aplikacja proponuje aktualizacje z GitHuba autora.

Osobny APK dla klienta (`docs/ANDROID_BUILD.md`):

- `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` — serwer domyślny,
- **własny identyfikator pakietu i keystore.** Przy wspólnym `pl.taskplanner.app` i wspólnym podpisie aktualizacja z GitHuba autora zastąpi APK klienta i domyślnie połączy się z chmurą autora,
- zmiany w kodzie: `CLOUD_SERVER`, `CLOUD_WEB_URL` (`apps/mobile/src/lib/config.ts`), `RELEASES_URL` (`apps/mobile/src/lib/app-update.ts`).

Własne CA: wydany APK ufa tylko certyfikatom systemowym (`plugins/local-cleartext.js` nie dodaje certyfikatów użytkownika), więc certyfikat wewnętrzny wymaga dopisania go do `network_security_config.xml`.

## 10. Kopie zapasowe

Trzy rzeczy, **wszystkie** potrzebne do odtworzenia:

| Co | Gdzie | Uwagi |
|---|---|---|
| baza | `scripts/backup.mjs dump` | tabele `public` + konta; format jak w `docs/KOPIE_ZAPASOWE.md` |
| pliki załączników | `volumes/storage` | nie ma ich w zrzucie |
| sekrety | `.env`, `.env.functions`, wolumen `db-config` | `db-config` ma klucz główny Vault — bez niego tokeny Google, sekrety pluginów i klucze AI są nie do odczytania |

```sh
cd /opt/taskplanner/app
DATABASE_URL="postgresql://postgres.taskplanner:<hasło>@127.0.0.1:5432/postgres" \
  node scripts/backup.mjs dump --out /opt/taskplanner/backup/$(date +%F)/dump
tar -czf /opt/taskplanner/backup/$(date +%F)/storage.tar.gz -C /opt/taskplanner/supabase-project/volumes storage
```

`dump` wymaga natywnych `pg_dump` / `psql` 17. Archiwa szyfrować i trzymać poza serwerem. Zrzut i pliki robić w jednym oknie czasowym.

Skrypt `dump` pomija sekrety Vault (`docs/KOPIE_ZAPASOWE.md`). Pełną kopię z sekretami daje tylko zatrzymanie stosu i skopiowanie `volumes/db/data`, `volumes/storage` oraz wolumenu `db-config` razem.

Odtworzenie: pusta instancja z **tymi samymi migracjami** → `node scripts/backup.mjs restore --in <dump> --db-url …` → pliki do `volumes/storage` → Vault (§7, krok 3). Użytkownicy logują się od nowa i ponownie podłączają Google, pluginy i AI.

## 11. Instalacja bez internetu

1. Na maszynie z internetem: pobrać obrazy stosu, zbudować `web`, uruchomić stos i wywołać **każdą** z 7 funkcji raz (zapełnia wolumen `deno-cache`, ok. 26 MB).
2. Przenieść: `docker save` / `docker load` obrazów, wolumen `deno-cache`, katalog `/opt/taskplanner`, paczkę CLI Supabase.
3. Certyfikat i SMTP z sieci wewnętrznej.

Nie działają wtedy: Google, AI, Web Push, podglądy linków z internetu.

## 12. Zmiany w kodzie przed wdrożeniem

| # | Zmiana | Miejsce | Bez niej |
|---|---|---|---|
| 1 | `Dockerfile`, `.dockerignore`, override compose, skrypt aktualizacji | nowe pliki | ręczna instalacja według tego dokumentu |
| 2 | konfiguracja weba przy starcie zamiast przy budowaniu | `lib/supabase-browser.ts` i 7 plików z `NEXT_PUBLIC_SUPABASE_URL` | osobny obraz na klienta |
| 3 | lista dozwolonych hostów wewnętrznych (osobna zmienna, np. `PLUGIN_ALLOWED_HOSTS`) | `_shared/plugins/*`, `functions/plugins` | GitLab i webhooki w sieci prywatnej odrzucane („Adres prywatny”) |
| 4 | treść polityki prywatności | `apps/web/src/app/prywatnosc/page.tsx` | strona mówi o Vercelu i Supabase w Irlandii |
| 5 | wersja aplikacji spoza Vercela | `apps/web/src/lib/error-log.ts` | dziennik błędów pokazuje wersję `local` |
| 6 | adres weba i wydań w APK | `config.ts`, `app-update.ts` (mobile) | §9 |
| 7 | brak domyślnego adresu autora w `plugins` | `DEFAULT_APP_URL` | konieczne `APP_URL` |

Punkty 1 i 4 są konieczne; 3 tylko, gdy klient integruje systemy w swojej sieci; 2 — przy kilku klientach.

## 13. Przeniesienie danych i utrzymanie

### Nowa instancja czy dane z chmury

- **Nowa instancja** — domyślnie. Tylko migracje, żadnych danych autora.
- **Pojedynczy użytkownik** — eksport i import JSON (Ustawienia → „Kopia zapasowa”). Bez plików załączników; przy innym koncie przestrzenie należące wciąż do starego konta serwer odrzuci (`docs/KOPIE_ZAPASOWE.md` §3).
- **Cała baza** — `backup.mjs dump` / `restore`. Zrzut obejmuje **wszystkie konta**, więc nie wolno go przekazać klientowi, jeśli zawiera dane innych osób. Wersja GoTrue musi mieć zgodne kolumny `auth.users`.

### Aktualizacja aplikacji

1. Kopia (§10).
2. Nowy tag w `app/`, obraz `web` z nowym `TASKPLANNER_VERSION`.
3. `db push` — migracje są addytywne, idą **przed** nowym webem i funkcjami.
4. Podmiana funkcji i pakietów (§5) oraz wpisów `deno.jsonc`.
5. `docker compose up -d web`, `sh run.sh restart functions`.
6. Odbiór: §8 punkty 1, 4, 7–9.

Cofnięcie: poprzedni obraz i poprzednie funkcje. Migracji się nie cofa.

### Aktualizacja Supabase

`sh update.sh --dry-run`, potem `sh update.sh`, `sh run.sh pull`, `sh run.sh recreate` — najpierw kopia (`update.sh` nie kopiuje bazy ani plików) i instancja testowa. Własne zmiany trzymać w `docker-compose.taskplanner.yml`, nie w plikach stosu; `Caddyfile` i `deno.jsonc` sprawdzić po każdej aktualizacji.

### Bezpieczeństwo

- Studio tylko z sieci wewnętrznej lub VPN, `.env*` z prawami `600`, kopie zaszyfrowane.
- Administrator serwera ma techniczny dostęp do wszystkich danych — uwzględnić w polityce prywatności klienta.
- Zablokować dostęp kontenera `functions` do zbędnych hostów w sieci klienta: funkcje pobierają adresy podane przez użytkowników (mają ochronę SSRF, zapora to druga warstwa).

### Do ustalenia z klientem

- Licencja: repozytorium nie ma pliku `LICENSE`.
- Kto aktualizuje system, Dockera, Supabase i aplikację; kto testuje kopie.
- Self-hosted Supabase ma wsparcie społecznościowe, bez SLA.
- Czy potrzebne są: Google, AI, Web Push, APK, integracje w sieci wewnętrznej.

## 14. Co sprawdzono

**Sprawdzone 24.11.2026:**

- wszystkie 7 funkcji startuje w samodzielnym Edge Runtime z układem z §5 (`/home/deno/functions` + `/home/packages`, mapa importów aplikacji) i odpowiada własnymi błędami; test na obrazie `v1.77.8` z uproszczonym routerem (bez kontroli pamięci), a stos ma `v1.79.2`,
- te same funkcje startują bez sieci z wcześniej zapełnionym `deno-cache`,
- generator sekretów z §6 działa,
- override z §5 łączy się z plikami stosu (`docker compose config`),
- nazwy zmiennych i zachowanie bramy — z plików `docker/` i dokumentacji Supabase z tego dnia.

**Niesprawdzone — zakres pilotażu na czystym serwerze:**

1. migracje na obrazie `supabase/postgres` ze stosu self-hosted (rola `postgres`, `pg_cron`, `pg_net`, Vault), w tym `db push` przez Supavisor bez TLS,
2. `pg_cron` → `pg_net` → `api-gw` → funkcje,
3. hook zaproszeń i szablon maila przez `GOTRUE_*`,
4. Realtime na `sync_scopes`, RLS plików w Storage,
5. budowanie i start obrazu `web`,
6. fragmenty Caddy (blok aplikacji, odcięcie Studia),
7. kalendarz Google i Web Push z domeny klienta,
8. `backup.mjs dump` / `restore` przez Supavisor oraz odtworzenie z kopii całych wolumenów,
9. telefon z serwerem klienta.

Szacunek: pakiet z pilotażem 3–5 dni, osobny APK z własnymi aktualizacjami ok. 1 dnia.

## Źródła

- <https://supabase.com/docs/guides/self-hosting/docker>
- <https://supabase.com/docs/guides/self-hosting/self-hosted-functions>
- <https://supabase.com/docs/guides/self-hosting/self-hosted-envoy>
- <https://supabase.com/docs/guides/self-hosting/self-hosted-proxy-https>
- <https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys>
- <https://supabase.com/docs/guides/self-hosting/accessing-postgres>
- <https://supabase.com/docs/guides/self-hosting/updating>
- <https://github.com/supabase/supabase/tree/master/docker> (`docker-compose.yml`, `CONFIG.md`)
