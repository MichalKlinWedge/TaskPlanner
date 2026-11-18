# Edge Functions

Funkcje Deno (SPECYFIKACJA §2). Od PoC-6: `calendar-sync`, `inbound-email`, `reminders-push`. Dalej: `link-preview` (Etap 10).

- `_shared/` — wspólny kod. Wszystko poza `runtime.ts` działa bez Deno i ma testy w Node (`tools/edge-tests`).
  Logika z `packages/core` przez import względny (`../../../packages/core/src/….ts`).
- `deno.json` — mapa importów dla wszystkich funkcji (`import_map` w `config.toml`); wersje przypięte.
- Każda funkcja ma `verify_jwt = false` i sama sprawdza wywołującego (JWT użytkownika, `x-cron-secret`, sekret Workera, token kanału Google).
- Sekrety lokalnie: `npm run setup --workspace tools/edge-tests` (pliki `.env`, `.env.test` są w `.gitignore`).
  W chmurze: `npm run supabase -- secrets set NAZWA=wartość` (nigdy w repozytorium):
  `CRON_SECRET`, `INBOUND_SECRET`, `VAPID_KEYS`, `VAPID_SUBJECT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`;
  w Vault bazy: `functions_url`, `cron_secret` (dla `pg_cron`).
- Lokalnie: `npm run serve --workspace tools/edge-tests` (prawdziwe usługi) albo `serve:test` (fałszywe, do testów integracyjnych).
