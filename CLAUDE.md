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
npm run supabase -- start   # local Supabase via pinned CLI 2.122.0 (needs Docker); ports 544xx so it runs next to ExpeditionPlan's 543xx
npm run test:db             # pgTAP tests in supabase/tests — needs local Supabase
npm run test:sync           # packages/sync integration tests against local Supabase; not part of `check`
npm run seed:dev -- [--today 2026-11-18] [--seed 1]   # deterministic dataset (5 workspaces, 40 lists, 2000 tasks, 15 habits) → tools/seed-dev/out/dataset.json
npm run gen --workspace packages/db                   # regenerate Supabase types after a migration
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
- **Sync (SPECYFIKACJA §6)**: every synced row has `scope_id` (workspace or personal scope), `row_version` (trigger bumps `sync_scopes.sync_version` under the scope row lock), `field_clock jsonb` (HLC per field) and `deleted_at` (no hard deletes). Clients write through `mutate` → local row + outbox in one transaction; server RPC `push_changes` applies a field only if the op's HLC is newer (idempotent, order-independent) and rejects ops that break rules (subtask depth > 4, parent cycles, cross-workspace refs). `pull_changes` returns rows with `row_version` above the client's per-scope versions in one snapshot. Realtime on `sync_scopes` is only a signal to pull. Completions/time entries are append-only with deterministic UUIDv5 ids where two devices may write „the same” row.
- Synced tables are written **only via `push_changes`** (RLS still on every table); integration tables (`calendar_*`, `inbound_messages`) only by `service_role` in Edge Functions. OAuth tokens in Supabase Vault — never in the browser or APK.

## Status

Etap 0 done: skeleton monorepo, empty web/mobile apps, Supabase config (no migrations yet), `packages/core` with `sort-key`, `format`, `labels`, primitive schemas; fixtures `fixtures/quick-add.jsonl` (+ `quick-add.context.json`, now = Wed 2026-11-18 12:00) and `fixtures/recurrence.json` are the acceptance corpora for PoC-2 and PoC-3. Next: PoC-1 (sync).
