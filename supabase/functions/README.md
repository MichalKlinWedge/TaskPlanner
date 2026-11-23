# Edge Functions

Funkcje Deno (SPECYFIKACJA §2). Od PoC-6: `calendar-sync`, `inbound-email`, `reminders-push`. Dalej: `link-preview` (Etap 10), `account-delete` (v1.x — usunięcie własnego konta z danymi, plikami i kalendarzami). `plugins` (v1.x, M21 — integracje wychodzące: połączenia z sekretami w Vault, wysyłki z ponowieniami; plugin Webhook; od I2 reguły zdarzeniowe z wyzwalaczy na zadaniach, przebieg w tle przez `EdgeRuntime.waitUntil`).

- `_shared/` — wspólny kod. Wszystko poza `runtime.ts` działa bez Deno i ma testy w Node (`tools/edge-tests`).
  Logika z `packages/core` przez import względny (`../../../packages/core/src/….ts`).
- `deno.json` — mapa importów dla wszystkich funkcji (`import_map` w `config.toml`); wersje przypięte.
- Każda funkcja ma `verify_jwt = false` i sama sprawdza wywołującego (JWT użytkownika, `x-cron-secret`, sekret Workera, token kanału Google).
- Sekrety lokalnie: `npm run setup --workspace tools/edge-tests` (pliki `.env`, `.env.test` są w `.gitignore`).
  W chmurze: `npm run supabase -- secrets set NAZWA=wartość` (nigdy w repozytorium):
  `CRON_SECRET`, `INBOUND_SECRET`, `VAPID_KEYS`, `VAPID_SUBJECT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`;
  opcjonalnie `APP_URL` (`plugins` — adres aplikacji w linku do zadania; domyślnie produkcja na Vercel);
  w Vault bazy: `functions_url`, `cron_secret` (dla `pg_cron`).
  Tylko `.env.test`: `LINK_PREVIEW_TEST_HOSTS`, `PLUGIN_TEST_HOSTS` (fałszywe usługi pod `host.docker.internal:54590` — nigdy w chmurze).
- Lokalnie: `npm run serve --workspace tools/edge-tests` (prawdziwe usługi) albo `serve:test` (fałszywe, do testów integracyjnych).
