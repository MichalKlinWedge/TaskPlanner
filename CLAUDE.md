# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

TaskPlanner: personal daily task manager. Web app (`apps/web`, Next.js 16, PWA) for planning: kanban, calendar with time-blocking, timeline/Gantt, weekly review. Android app (`apps/mobile`, Expo SDK 58) for capture and execution: quick add, Today, reminders, focus mode, habits, widgets. **Both clients are local-first and edit everything offline.** Backend: Supabase (Postgres + RLS + Realtime + Storage + Edge Functions + `pg_cron`), web on Vercel. Same stack and conventions as ExpeditionPlan (`D:\AI\ExpeditionPlan`), which is the reference for patterns.

Read before larger work:
- `SPECYFIKACJA.md` — the spec. §4 quick-add grammar, §5 data model, §6 sync and conflicts, §7 engines in `packages/core`, §12 open decisions.
- `PLAN_ETAPOWY.md` — stages (Etap 0 → PoC-1…6 → MVP-1…4 → Etapy 5–13 → v1.x). Each stage has a „Kryterium odbioru”; work toward it.
- `docs/USLUGI.md` — verified terms/limits of external services (with dates). Don't introduce a service it doesn't cover.

All docs (except this file), UI strings and code comments are in **Polish**; identifiers in English.

## Commands

```bash
npm install                 # root; npm workspaces (apps/*, packages/*, tools/*)
npm run check               # typecheck + lint + test in every workspace
npm test                    # vitest in packages/*
npm run web                 # next dev (root .env.local → apps/*/.env.local via scripts/sync-env.mjs)
npm run web:local           # next dev against LOCAL Supabase
npm run mobile              # expo start (needs a development build, not Expo Go)
npm run supabase -- start   # local Supabase via pinned CLI 2.122.0 (needs Docker); ports 545xx (543xx = ExpeditionPlan, 544xx = LingoMemo local stacks)
npm run test:db             # pgTAP tests in supabase/tests — needs local Supabase
npm run test:sync           # packages/sync integration tests against local Supabase (PoC-1 scenarios: 2 devices, offline, LWW, Realtime); not part of `check`
npm run dev:user            # dev@taskplanner.test in LOCAL Supabase; password in root .env.local (DEV_USER_PASSWORD) — never print it
npm run supabase -- db reset   # reapply migrations to local DB (wipes data)
npm run seed:dev -- [--today 2026-11-18] [--seed 1]   # deterministic dataset (5 workspaces, 40 lists, 2000 tasks, 15 habits) → tools/seed-dev/out/dataset.json
npm run gen --workspace packages/db                   # regenerate Supabase types after a migration
npm run setup --workspace tools/edge-tests            # Edge Function secrets → supabase/functions/.env + .env.test (git-ignored), Vault `functions_url`/`cron_secret` for pg_cron
npm run serve:test --workspace tools/edge-tests       # functions serve with fake Google/ICS/push (host.docker.internal:54590); `serve` = real services
npm run test:integration --workspace tools/edge-tests # PoC-6 Edge Function tests — needs local Supabase + serve:test; not part of `check`
npm run typecheck:deno --workspace tools/edge-tests   # deno check of supabase/functions/*/index.ts
```

Single test: `npx vitest run src/__tests__/sort-key.test.ts` (or `-t "nazwa testu"`) inside a package.

Mobile: always `npx expo install <pkg>` inside `apps/mobile`, then `npx expo-doctor`. Follow `apps/mobile/AGENTS.md` — check Expo SDK 58 docs, don't trust memory. Web: `apps/web/AGENTS.md` — read `node_modules/next/dist/docs/` before using Next APIs. EAS project is not linked yet (`npx eas-cli@latest init` adds `projectId`/`updates.url` to `app.json`; needed before `ota`).

## Architecture rules

- **UI reads and writes only the local database** (expo-sqlite on the phone, `@sqlite.org/sqlite-wasm` with `opfs-sahpool` in a web worker, one leader tab). Network is `packages/sync`'s job in the background — no separate „offline path” in UI code.
- **Domain logic lives in `packages/core`**: pure TS that runs identically in the browser, on the phone (Hermes) and in Supabase Edge Functions (Deno). No Node/Expo/Next imports outside tests. Quick-add parser, recurrence, views (Today/Upcoming/grouping/filters), dependencies, time-blocking, habits, reminders, Pomodoro, review queue all go here.
- Packages are consumed as **TypeScript source** (`main: src/index.ts`) with **explicit `.ts` extensions in relative imports** (Deno). Next transpiles them via `transpilePackages`.
- **Zod schemas are the single source of truth** (`packages/core/src/schemas`) for forms, `jsonb` columns and RPC payloads. jsonb is camelCase, columns snake_case.
- **Labels and formatting** live in `packages/core/src/labels.ts` (`PRIORITY`, `TASK_STATUS`, `LIST_KIND`, `PROJECT_STATUS`) and `format.ts` (`plural`, `pluralForm`, `formatMinutes`, `dayLabel`, `dayChip`, `dayMonth`, `shortDate`, `capitalized`); apps never redefine them.
- **Task time is floating** (local wall clock): `due_date` (`RRRR-MM-DD`), `due_time` (`GG:MM`), `duration_min`, optional `start_date`; optional `time_zone` pins a task to a zone. Real events (completions, time entries, calendar events) are `timestamptz`.
- Manual order = fractional `sort_key` (`core/sort-key.ts`, from ExpeditionPlan).
- **Sync (SPECYFIKACJA §6, `supabase/migrations/*_poc1_sync.sql`, `docs/POC_WYNIKI.md`)**: scope = workspace (`scope_id` = workspace id, no `workspace_id` column) or the user's personal scope (id = user id, created by a trigger on `auth.users`); membership in `scope_members`. `scope_id` of tasks/task_tags/task_completions is **derived** server-side (from list/task) and never sent by clients; a subtask's `list_id` follows its parent. `packages/sync/src/specs.ts` (`TABLES`) is the only table ↔ local-row mapping — a new column goes into the migration, `npm run gen --workspace packages/db`, then `TABLES` (tsc fails on uncovered columns) and `synced_tables()`. Every synced row has `scope_id`, `row_version` (trigger bumps `sync_scopes.sync_version` under the scope row lock), `field_clock jsonb` (HLC per field) and `deleted_at` (no hard deletes). Clients write through `mutate` → local row + outbox in one transaction; server RPC `push_changes` applies a field only if the op's HLC is newer (idempotent, order-independent) and rejects ops that break rules (subtask depth > 4, parent cycles, cross-workspace refs). `pull_changes` returns rows with `row_version` above the client's per-scope versions in one snapshot. Realtime on `sync_scopes` is only a signal to pull. Completions/time entries are append-only with deterministic UUIDv5 ids where two devices may write „the same” row.
- Rejection codes from `push_changes`: `TP001` depth, `TP002` cycle, `TP003` no access, `TP004` wrong scope, `TP005` unknown table/field, `TP006` bad HLC. Rejected and clamped ops come back with the server's current row, which overwrites the local one.
- **Browser**: `connectTabs` (`packages/sync/src/tabs.ts`) — the leader tab (Web Locks) owns the SQLite worker and the `SyncEngine`; other tabs proxy queries/mutations over BroadcastChannel. SQLite WASM is **not bundled** (Turbopack can't resolve its dynamic worker URL): `scripts/copy-sqlite-wasm.mjs` (web `predev`/`prebuild`) copies it to `apps/web/public/sqlite-wasm/` (git-ignored), and `apps/web/src/lib/db.worker.ts` loads it with `import(/* turbopackIgnore: true */ …)`. `/dev/sync` is a dev-only test page.
- **Phone**: `apps/mobile/src/lib/polyfills.ts` must load first (Hermes lacks `crypto.getRandomValues` for UUIDv7 and a full `URL` for supabase-js).
- Synced tables are written **only via `push_changes`** (RLS still on every table); integration tables (`calendar_*`, `inbound_messages`) only by `service_role` in Edge Functions. OAuth tokens in Supabase Vault — never in the browser or APK.
- **Edge Functions (`supabase/functions`, `supabase/migrations/*_poc6_integrations.sql`)**: `calendar-sync` (Google OAuth/`watch` webhook/`syncToken`, ICS, `cron/poll` every 15 min, `cron/renew` daily), `inbound-email` (raw MIME from the Cloudflare Email Worker in `tools/email-worker`), `reminders-push` (`jsr:@negrel/webpush`, `push_queue`, every minute). Shared code in `_shared/`; everything except `runtime.ts` is Deno-free and unit-tested in Node (`tools/edge-tests`). Import `packages/core` by relative path (`../../../packages/core/src/x.ts`); bare specifiers go through `supabase/functions/deno.json` (pin versions ≥ 24 h old). All functions have `verify_jwt = false` and authenticate themselves (user JWT, `x-cron-secret`, Worker secret, Google channel token). pg_cron calls them via `call_edge_function()` using Vault secrets `functions_url` + `cron_secret`. Tasks created by integrations go through `create_integration_task` (server HLC in `field_clock`). Integration tables have `user_id` + `row_version` bumping the personal scope; clients can't `select('*')` on `calendar_accounts`/`calendars`/`push_subscriptions` (column grants hide secrets).

## Status

Etap 0 done. **PoC-1 (sync) done, GO** — results and deviations from §5 in `docs/POC_WYNIKI.md`; not yet verified on a real phone. **PoC-2 (quick-add parser) done, GO** — `packages/core/src/quick-add.ts`; grammar clarifications in `docs/POC_WYNIKI.md`. `fixtures/quick-add.jsonl` (+ `quick-add.context.json`, now = Wed 2026-11-18 12:00) is a regression corpus: a parser change must keep it at 100 %; add a case for every new form or trap. **PoC-3 (recurrence, habits) done, GO** — own RRULE subset in `packages/core/src/recurrence.ts` (no runtime dependency; `rrule` is a devDependency used only as a test oracle), habits in `habits.ts`; corpora `fixtures/recurrence.json` and `fixtures/habits.json` (hand-computed). **PoC-6 (server integrations) done locally, GO locally** — Web Push to a closed Chrome tab confirmed; real Google / Cloudflare measurements wait for the user's accounts (`docs/POC6_KONFIGURACJA.md`); results and deviations from §5 in `docs/POC_WYNIKI.md`. Next: PoC-4 (Android: reminders, widget, share intent, calendar) — needs a development build.
