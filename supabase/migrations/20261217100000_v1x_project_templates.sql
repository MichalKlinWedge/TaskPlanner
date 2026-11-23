-- Szablony projektów (v1.x, PLAN_ETAPOWY.md → „Szablony projektów”). Migracja addytywna (w chmurze są
-- prawdziwe dane): nowa tabela synchronizowana `project_templates` w zakresie osobistym, jak `saved_filters`.
--
-- Szablon = migawka projektu: zadania z podzadaniami, tagi (po nazwie), przypomnienia, zależności i daty
-- względne (`ProjectTemplateContent` w `packages/core/src/templates.ts`). Cała treść w jednym polu
-- `content` — LWW zastępuje szablon w całości, nigdy nie skleja dwóch wersji. Nowy projekt z szablonu
-- powstaje u klienta (zwykłe wiersze `lists` / `tasks` / … przez `push_changes`), więc serwer nie zagląda
-- do treści poza sprawdzeniem, że to obiekt z wersją formatu.

create table public.project_templates (
  id uuid primary key,
  name text not null check (length(btrim(name)) between 1 and 100),
  content jsonb not null check (jsonb_typeof(content) = 'object' and jsonb_typeof(content -> 'version') = 'number'),
  sort_key text not null check (sort_key ~ '^[0-9a-z]+$')
);

-- Kolejność = kolejność stosowania u klienta (rodzice przed dziećmi; lokalnie bez kluczy obcych).
create or replace function public.synced_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array['workspaces', 'lists', 'tasks', 'tags', 'task_tags', 'task_completions', 'profiles', 'devices',
               'reminders', 'task_dependencies', 'time_entries', 'attachments', 'saved_filters', 'review_sessions',
               'collaborators', 'task_participants', 'task_comments', 'plugin_rules', 'plugin_requests',
               'project_templates']
$$;

alter table public.project_templates
  add column scope_id uuid not null references public.sync_scopes (id) on delete cascade,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add column created_by uuid,
  add column deleted_at timestamptz,
  add column row_version bigint not null default 0,
  add column field_clock jsonb not null default '{}';
create index project_templates_sync on public.project_templates (scope_id, row_version);
alter table public.project_templates enable row level security;
create policy project_templates_select on public.project_templates for select to authenticated using (public.has_scope_access(scope_id));
revoke all on public.project_templates from anon;
revoke insert, update, delete, truncate on public.project_templates from authenticated;
-- Projekt w chmurze nie nadaje ról API do tabel z migracji (wniosek z PoC-6).
grant select on public.project_templates to authenticated;
grant all on public.project_templates to service_role;
create trigger z_stamp before insert or update on public.project_templates for each row execute function public.stamp_row();
create trigger a_derive before insert or update on public.project_templates for each row execute function public.derive_personal();

-- Pola, które klient może ustawić: `scope_id` szablonu jak innych wierszy osobistych.
create or replace function public.writable_columns(p_table text) returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(column_name::text order by ordinal_position), '{}')
    from information_schema.columns
   where table_schema = 'public' and table_name = p_table
     and column_name not in ('id', 'created_at', 'updated_at', 'created_by', 'row_version', 'field_clock')
     and (column_name <> 'scope_id'
          or p_table in ('lists', 'tags', 'devices', 'saved_filters', 'review_sessions', 'collaborators', 'plugin_rules', 'plugin_requests',
                         'project_templates'));
$$;
