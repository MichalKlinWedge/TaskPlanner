-- Uczestnicy zadań (tylko informacyjnie), odpowiedzialny i komentarze (v1.x, PLAN_ETAPOWY
-- „Uczestnicy zadań i współdzielenie”, pierwsza część — bez udostępniania).
--
--   * `collaborators` — współpracownicy użytkownika (zakres osobisty, jak tagi): nazwa i opcjonalny
--     e-mail. Nie dają nikomu dostępu — to książka adresowa do opisu zadań.
--   * `task_participants` — uczestnicy zadania; id = UUIDv5(task_id + collaborator_id) z klienta
--     (jak `task_tags`), więc dodanie tej samej osoby na dwóch urządzeniach to jeden wiersz.
--   * `tasks.assignee_id` — odpowiedzialny ze współpracowników; `null` = twórca zadania (`created_by`).
--   * `task_comments` — komentarze zadania; autor = `created_by`, chwila napisania z urządzenia
--     (`posted_at` — komentarz dodany offline ma czas napisania, nie wysłania).
--
-- Klienci sprzed tej migracji pomijają nowe tabele i kolumnę w `pull_changes`; nowy klient raz
-- pobiera zakresy od zera, gdy zmienia się zestaw tabel (`packages/sync/src/engine.ts`).

-- ── Tabele ───────────────────────────────────────────────────────────────────────────────────

create table public.collaborators (
  id uuid primary key,
  name text not null check (length(btrim(name)) between 1 and 100),
  email text check (email is null or (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+$'))
);

create table public.task_participants (
  id uuid primary key,
  task_id uuid not null references public.tasks (id),
  collaborator_id uuid not null references public.collaborators (id),
  unique (task_id, collaborator_id)
);
create index task_participants_collaborator on public.task_participants (collaborator_id);

create table public.task_comments (
  id uuid primary key,
  task_id uuid not null references public.tasks (id),
  body text not null check (length(btrim(body)) between 1 and 10000),
  posted_at timestamptz not null,
  edited_at timestamptz
);
create index task_comments_task on public.task_comments (task_id);

alter table public.tasks add column assignee_id uuid references public.collaborators (id);
create index tasks_assignee on public.tasks (assignee_id) where assignee_id is not null;

-- Kolejność = kolejność stosowania u klienta (rodzice przed dziećmi; lokalnie bez kluczy obcych).
create or replace function public.synced_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array['workspaces', 'lists', 'tasks', 'tags', 'task_tags', 'task_completions', 'profiles', 'devices',
               'reminders', 'task_dependencies', 'time_entries', 'attachments', 'saved_filters', 'review_sessions',
               'collaborators', 'task_participants', 'task_comments']
$$;

do $$
declare
  t text;
begin
  foreach t in array array['collaborators', 'task_participants', 'task_comments'] loop
    execute format(
      'alter table public.%I
         add column scope_id uuid not null references public.sync_scopes (id) on delete cascade,
         add column created_at timestamptz not null default now(),
         add column updated_at timestamptz not null default now(),
         add column created_by uuid,
         add column deleted_at timestamptz,
         add column row_version bigint not null default 0,
         add column field_clock jsonb not null default ''{}''', t);
    execute format('create index %I on public.%I (scope_id, row_version)', t || '_sync', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.has_scope_access(scope_id))', t || '_select', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    -- Projekt w chmurze nie nadaje ról API do tabel z migracji (wniosek z PoC-6).
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create trigger z_stamp before insert or update on public.%I for each row execute function public.stamp_row()', t);
  end loop;
end $$;

-- ── Pola wyliczane i reguły ──────────────────────────────────────────────────────────────────

create trigger a_derive before insert or update on public.collaborators for each row execute function public.derive_personal();
create trigger a_derive before insert or update on public.task_comments for each row execute function public.derive_task_child();

-- Uczestnik: zakres zadania; współpracownik z zakresu, do którego zalogowany może pisać (jak tag).
create function public.derive_task_participant() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select scope_id into new.scope_id from public.tasks where id = new.task_id;
  if new.scope_id is null then
    raise exception using errcode = '23503', message = 'Brak zadania';
  end if;
  if auth.uid() is not null
     and not exists (select 1 from public.collaborators c where c.id = new.collaborator_id and public.can_write_scope(c.scope_id)) then
    raise exception using errcode = 'TP003', message = 'Brak dostępu do współpracownika';
  end if;
  return new;
end $$;
create trigger a_derive before insert or update on public.task_participants for each row execute function public.derive_task_participant();

-- Odpowiedzialny: współpracownik z zakresu, do którego zalogowany może pisać.
create function public.check_task_assignee() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.assignee_id is not null and auth.uid() is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not exists (select 1 from public.collaborators c where c.id = new.assignee_id and public.can_write_scope(c.scope_id)) then
    raise exception using errcode = 'TP003', message = 'Brak dostępu do współpracownika';
  end if;
  return new;
end $$;
create trigger a_assignee before insert or update on public.tasks for each row execute function public.check_task_assignee();

-- Przeniesienie zadania do innej przestrzeni zabiera także uczestników i komentarze (reszta jak w MVP-1).
create or replace function public.cascade_task() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  stamp text;
begin
  if new.list_id is distinct from old.list_id then
    update public.tasks set list_id = new.list_id where parent_id = new.id and list_id is distinct from new.list_id;
  end if;
  if new.scope_id is distinct from old.scope_id then
    update public.task_tags set scope_id = new.scope_id where task_id = new.id;
    update public.task_completions set scope_id = new.scope_id where task_id = new.id;
    update public.reminders set scope_id = new.scope_id where task_id = new.id;
    update public.attachments set scope_id = new.scope_id where task_id = new.id;
    update public.time_entries set scope_id = new.scope_id where task_id = new.id;
    update public.task_participants set scope_id = new.scope_id where task_id = new.id;
    update public.task_comments set scope_id = new.scope_id where task_id = new.id;
    stamp := public.server_hlc();
    update public.task_dependencies d
       set deleted_at = now(), field_clock = d.field_clock || jsonb_build_object('deleted_at', stamp)
     where d.deleted_at is null
       and (d.predecessor_id = new.id or d.successor_id = new.id)
       and exists (
         select 1 from public.tasks o
          where o.id = case when d.predecessor_id = new.id then d.successor_id else d.predecessor_id end
            and o.scope_id <> new.scope_id);
    update public.task_dependencies d set scope_id = new.scope_id
     where d.deleted_at is null and d.predecessor_id = new.id and d.scope_id <> new.scope_id;
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    update public.tasks
       set deleted_at = new.deleted_at,
           field_clock = field_clock || jsonb_build_object('deleted_at', new.field_clock -> 'deleted_at')
     where parent_id = new.id and deleted_at is null;
  elsif new.deleted_at is null and old.deleted_at is not null then
    update public.tasks
       set deleted_at = null,
           field_clock = field_clock || jsonb_build_object('deleted_at', new.field_clock -> 'deleted_at')
     where parent_id = new.id and deleted_at = old.deleted_at;
  end if;
  return null;
end $$;

-- Pola, które klient może ustawić: `scope_id` współpracownika jak innych wierszy osobistych.
create or replace function public.writable_columns(p_table text) returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(column_name::text order by ordinal_position), '{}')
    from information_schema.columns
   where table_schema = 'public' and table_name = p_table
     and column_name not in ('id', 'created_at', 'updated_at', 'created_by', 'row_version', 'field_clock')
     and (column_name <> 'scope_id' or p_table in ('lists', 'tags', 'devices', 'saved_filters', 'review_sessions', 'collaborators'));
$$;
