-- Jawne uprawnienia ról API do tabel PoC-1 (`*_poc1_sync.sql`).
--
-- Nowe projekty Supabase w chmurze nie nadają `authenticated` / `service_role` do tabel z migracji
-- (lokalny stack nadaje — dlatego testy tego nie wykryły). Bez `select` klient nie dostaje sygnałów
-- Realtime z `sync_scopes` (Realtime sprawdza uprawnienia i RLS subskrybenta) i nie czyta tabel wprost;
-- `push_changes` / `pull_changes` działały, bo są SECURITY DEFINER. Zapis klienta nadal tylko przez
-- `push_changes` — `insert/update/delete` zostają odebrane (`poc1_sync.sql`). Odczyt ogranicza RLS.

grant select on
  public.sync_scopes, public.scope_members,
  public.workspaces, public.lists, public.tasks, public.tags, public.task_tags, public.task_completions
  to authenticated;

-- Narzędzia z kluczem `service_role` (seed-dev, testy, Edge Functions) — RLS ich nie dotyczy.
grant select, insert, update, delete on
  public.sync_scopes, public.scope_members,
  public.workspaces, public.lists, public.tasks, public.tags, public.task_tags, public.task_completions
  to service_role;
