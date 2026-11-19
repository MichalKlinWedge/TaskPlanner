-- MVP-1: pełny model danych §5 (bez tabel integracji z PoC-6), dziennik zmian i stronicowane
-- `pull_changes` (SPECYFIKACJA v0.2 §5, §6).
--
-- Nowe tabele synchronizowane dostają te same kolumny systemowe, RLS i triggery co tabele PoC-1
-- (`stamp_row`, `a_derive`). Zakres:
--   * zakres osobisty (id użytkownika): `profiles` (id = id użytkownika), `devices`, `saved_filters`,
--     `review_sessions`; `time_entries` bez zadania,
--   * zakres zadania: `reminders`, `attachments`, `time_entries` z zadaniem, `task_dependencies`
--     (z poprzednika; następnik musi być w tym samym zakresie).

-- ── Zmiany w tabelach PoC-1 ──────────────────────────────────────────────────────────────────

-- D15: kolejność kart na tablicy z kilku list (pusty = kolejność automatyczna).
alter table public.tasks add column board_sort_key text check (board_sort_key ~ '^[0-9a-z]+$');

-- ── Nowe tabele synchronizowane ──────────────────────────────────────────────────────────────

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (length(btrim(display_name)) <= 100),
  settings jsonb not null default '{}'
);

create table public.devices (
  id uuid primary key,
  name text not null check (length(btrim(name)) between 1 and 100),
  platform text not null check (platform in ('web', 'android')),
  reminder_channel text not null default 'enabled' check (reminder_channel in ('enabled', 'disabled')),
  push_subscription jsonb,
  last_sync_at timestamptz
);

create table public.reminders (
  id uuid primary key,
  task_id uuid not null references public.tasks (id),
  kind text not null check (kind in ('relative', 'absolute')),
  offset_min integer check (offset_min between 0 and 40320),
  at_date date,
  at_time text check (at_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  check (case when kind = 'relative' then offset_min is not null else at_date is not null and at_time is not null end)
);
create index reminders_task on public.reminders (task_id);

create table public.task_dependencies (
  id uuid primary key,
  predecessor_id uuid not null references public.tasks (id),
  successor_id uuid not null references public.tasks (id),
  kind text not null default 'finish_to_start' check (kind = 'finish_to_start'),
  lag_days integer not null default 0 check (lag_days between -365 and 365),
  check (predecessor_id <> successor_id)
);
create index task_dependencies_predecessor on public.task_dependencies (predecessor_id);
create index task_dependencies_successor on public.task_dependencies (successor_id);

create table public.time_entries (
  id uuid primary key,
  task_id uuid references public.tasks (id),
  kind text not null check (kind in ('focus', 'break', 'manual')),
  started_at timestamptz not null,
  ended_at timestamptz,
  pomodoro_index integer check (pomodoro_index >= 0),
  check (ended_at is null or ended_at >= started_at)
);
create index time_entries_task on public.time_entries (task_id);

create table public.attachments (
  id uuid primary key,
  task_id uuid not null references public.tasks (id),
  kind text not null check (kind in ('file', 'link')),
  storage_path text,
  name text not null check (length(btrim(name)) between 1 and 255),
  mime text check (length(mime) <= 200),
  size_bytes bigint check (size_bytes between 0 and 26214400),
  url text,
  preview jsonb,
  check (case when kind = 'file' then storage_path is not null else url is not null end)
);
create index attachments_task on public.attachments (task_id);

create table public.saved_filters (
  id uuid primary key,
  name text not null check (length(btrim(name)) between 1 and 60),
  icon text,
  query jsonb not null default '{}',
  sort_key text not null default 'n' check (sort_key ~ '^[0-9a-z]+$')
);

create table public.review_sessions (
  id uuid primary key,
  kind text not null check (kind in ('daily', 'weekly')),
  started_at timestamptz not null,
  finished_at timestamptz,
  stats jsonb
);

-- Kolejność = kolejność stosowania u klienta (rodzice przed dziećmi).
create or replace function public.synced_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array['workspaces', 'lists', 'tasks', 'tags', 'task_tags', 'task_completions', 'profiles', 'devices',
               'reminders', 'task_dependencies', 'time_entries', 'attachments', 'saved_filters', 'review_sessions']
$$;

do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'devices', 'reminders', 'task_dependencies', 'time_entries', 'attachments',
                           'saved_filters', 'review_sessions'] loop
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

-- Profil: id = id użytkownika = jego zakres osobisty.
create function public.derive_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.scope_id := new.id;
  if not exists (select 1 from public.sync_scopes where id = new.scope_id and kind = 'personal') then
    raise exception using errcode = 'TP004', message = 'Profil musi należeć do zakresu osobistego';
  end if;
  return new;
end $$;
create trigger a_derive before insert or update on public.profiles for each row execute function public.derive_profile();

-- Wiersze osobiste (jak tagi): zakres podany przez klienta albo zakres osobisty zalogowanego.
create function public.derive_personal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.scope_id := coalesce(new.scope_id, auth.uid());
  if not exists (select 1 from public.sync_scopes where id = new.scope_id and kind = 'personal') then
    raise exception using errcode = 'TP004', message = 'Wiersz musi należeć do zakresu osobistego';
  end if;
  return new;
end $$;
create trigger a_derive before insert or update on public.devices for each row execute function public.derive_personal();
create trigger a_derive before insert or update on public.saved_filters for each row execute function public.derive_personal();
create trigger a_derive before insert or update on public.review_sessions for each row execute function public.derive_personal();

-- Przypomnienia i załączniki: zakres zadania (funkcja z PoC-1).
create trigger a_derive before insert or update on public.reminders for each row execute function public.derive_task_child();
create trigger a_derive before insert or update on public.attachments for each row execute function public.derive_task_child();

-- Wpis czasu: zakres zadania, a bez zadania — zakres osobisty.
create function public.derive_time_entry() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.task_id is not null then
    select scope_id into new.scope_id from public.tasks where id = new.task_id;
    if new.scope_id is null then
      raise exception using errcode = '23503', message = 'Brak zadania';
    end if;
  else
    new.scope_id := coalesce(case when tg_op = 'UPDATE' and old.task_id is null then old.scope_id end, auth.uid(), new.created_by);
    if not exists (select 1 from public.sync_scopes where id = new.scope_id and kind = 'personal') then
      raise exception using errcode = 'TP004', message = 'Wpis czasu bez zadania należy do zakresu osobistego';
    end if;
  end if;
  return new;
end $$;
create trigger a_derive before insert or update on public.time_entries for each row execute function public.derive_time_entry();

-- Zależność: zakres poprzednika, następnik w tym samym zakresie, bez cyklu wśród nieusuniętych.
create function public.derive_dependency() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  successor_scope uuid;
begin
  select scope_id into new.scope_id from public.tasks where id = new.predecessor_id;
  select scope_id into successor_scope from public.tasks where id = new.successor_id;
  if new.scope_id is null or successor_scope is null then
    raise exception using errcode = '23503', message = 'Brak zadania';
  end if;
  -- Usunięta zależność może łączyć przestrzenie (kaskada po przeniesieniu zadania).
  if new.deleted_at is null and new.scope_id <> successor_scope then
    raise exception using errcode = 'TP004', message = 'Zależność między zadaniami z różnych przestrzeni';
  end if;
  if new.deleted_at is null and exists (
    with recursive path (task_id) as (
      select new.successor_id
      union
      select d.successor_id
        from public.task_dependencies d
        join path p on d.predecessor_id = p.task_id
       where d.deleted_at is null and d.id <> new.id
    )
    select 1 from path where task_id = new.predecessor_id
  ) then
    raise exception using errcode = 'TP002', message = 'Cykl zależności';
  end if;
  return new;
end $$;
create trigger a_derive before insert or update on public.task_dependencies for each row execute function public.derive_dependency();

-- Przeniesienie zadania do innej przestrzeni zabiera jego wiersze podrzędne; zależności z
-- zadaniami, które zostały w starej przestrzeni, są usuwane (inaczej łączyłyby dwie przestrzenie).
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

-- Pola, które klient może ustawić. `scope_id` tylko tam, gdzie wybiera go użytkownik (lista →
-- przestrzeń, wiersze osobiste → zakres osobisty); w pozostałych tabelach jest wyliczany.
create or replace function public.writable_columns(p_table text) returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(column_name::text order by ordinal_position), '{}')
    from information_schema.columns
   where table_schema = 'public' and table_name = p_table
     and column_name not in ('id', 'created_at', 'updated_at', 'created_by', 'row_version', 'field_clock')
     and (column_name <> 'scope_id' or p_table in ('lists', 'tags', 'devices', 'saved_filters', 'review_sessions'));
$$;

-- ── Dziennik zmian (M3) ──────────────────────────────────────────────────────────────────────

-- Historia zmian zadań: zmienione pola z nowymi wartościami i urządzeniem (węzeł HLC zmiany).
-- Tylko do odczytu dla klientów, poza strumieniem synchronizacji (panel zadania czyta go online).
create table public.activity_log (
  id bigint generated always as identity primary key,
  scope_id uuid not null references public.sync_scopes (id) on delete cascade,
  table_name text not null,
  row_id uuid not null,
  changes jsonb not null,
  device_id text,
  actor_id uuid,
  at timestamptz not null default now()
);
create index activity_log_row on public.activity_log (row_id, at desc);
create index activity_log_at on public.activity_log (at);
alter table public.activity_log enable row level security;
create policy activity_log_select on public.activity_log for select to authenticated using (public.has_scope_access(scope_id));
revoke all on public.activity_log from anon;
revoke insert, update, delete, truncate on public.activity_log from authenticated;
grant select on public.activity_log to authenticated;
grant all on public.activity_log to service_role;

create function public.log_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  changes jsonb;
  node text;
begin
  select coalesce(jsonb_object_agg(n.key, n.value), '{}') into changes
    from jsonb_each(to_jsonb(new)) n
   where n.key not in ('id', 'created_at', 'updated_at', 'created_by', 'row_version', 'field_clock', 'scope_id')
     and (tg_op = 'INSERT' or n.value is distinct from to_jsonb(old) -> n.key);
  if changes = '{}' then
    return null;
  end if;
  select split_part(max(c.value #>> '{}'), ':', 3) into node
    from jsonb_each(new.field_clock) c
   where changes ? c.key;
  insert into public.activity_log (scope_id, table_name, row_id, changes, device_id, actor_id)
  values (new.scope_id, tg_table_name, new.id, changes, node, auth.uid());
  return null;
end $$;
create trigger log_activity after insert or update on public.tasks for each row execute function public.log_activity();

-- ── Odczyt: stronicowane pull_changes ────────────────────────────────────────────────────────

-- `p_since`: {scope_id: ostatnia wersja}, `p_limit`: najwięcej wierszy w odpowiedzi. Wiersze idą po
-- zakresie i `row_version` (jeden licznik na zakres we wszystkich tabelach), więc kursor zakresu
-- to po prostu `row_version` ostatniego zwróconego wiersza. `scopes[id].version` to wartość, którą
-- klient zapisuje: pełna wersja zakresu, jeśli zakres przyszedł w całości, a kursor — jeśli nie.
-- `more = true` → klient pyta dalej z nowymi wersjami. Pełna migawka (wersja 0) pomija usunięte.
drop function public.pull_changes(jsonb);
create function public.pull_changes(p_since jsonb default '{}', p_limit integer default 1000) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  since jsonb := coalesce(p_since, '{}');
  lim integer := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  scopes jsonb;
  tables jsonb := '{}';
  page_sql text;
  page record;
  more boolean;
  t text;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Wymagane logowanie';
  end if;

  select string_agg(format(
           'select %L as tbl, r.scope_id, r.row_version, to_jsonb(r) as data
              from public.%I r
              join public.scope_members m on m.scope_id = r.scope_id and m.user_id = auth.uid()
             where r.row_version > coalesce(($1 ->> r.scope_id::text)::bigint, 0)
               and (coalesce(($1 ->> r.scope_id::text)::bigint, 0) > 0 or r.deleted_at is null)', s.tbl_name, s.tbl_name),
         ' union all ')
    into page_sql
    from unnest(public.synced_tables()) as s(tbl_name);

  -- Jedna strona o `lim + 1` wierszach: nadmiarowy mówi tylko, że jest dalszy ciąg.
  execute format(
    'with page as (
       select u.*, row_number() over (order by u.scope_id, u.row_version) as rn
         from (%s) u
        order by u.scope_id, u.row_version
        limit $2 + 1)
     select (select count(*) from page) > $2 as more,
            (select coalesce(jsonb_object_agg(tbl, rows), ''{}'')
               from (select tbl, jsonb_agg(data order by rn) as rows from page where rn <= $2 group by tbl) x) as tables,
            (select scope_id from page where rn = $2) as last_scope,
            (select row_version from page where rn = $2) as last_version', page_sql)
    into page using since, lim;
  more := page.more;
  foreach t in array public.synced_tables() loop
    tables := tables || jsonb_build_object(t, coalesce(page.tables -> t, '[]'::jsonb));
  end loop;

  -- Bez `more` każdy zakres przyszedł w całości. Z `more`: zakresy przed ostatnim — w całości,
  -- ostatni — do kursora, dalsze — bez zmian.
  select coalesce(jsonb_object_agg(s.id, jsonb_build_object(
           'kind', s.kind,
           'role', m.role,
           'version', case
             when not more or s.id < page.last_scope then s.sync_version
             when s.id = page.last_scope then page.last_version
             else coalesce((since ->> s.id::text)::bigint, 0)
           end)), '{}')
    into scopes
    from public.sync_scopes s
    join public.scope_members m on m.scope_id = s.id and m.user_id = auth.uid();

  return jsonb_build_object('scopes', scopes, 'tables', tables, 'more', more, 'serverHlc', public.server_hlc());
end $$;

revoke execute on function public.pull_changes(jsonb, integer) from anon, public;
grant execute on function public.pull_changes(jsonb, integer) to authenticated;

-- ── Profil razem z kontem ────────────────────────────────────────────────────────────────────

-- Profil powstaje z zakresem osobistym (pusty `field_clock` — pierwsza zmiana z urządzenia wygrywa).
create or replace function public.create_personal_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.sync_scopes (id, kind, owner_id) values (new.id, 'personal', new.id) on conflict do nothing;
  insert into public.scope_members (scope_id, user_id, role) values (new.id, new.id, 'owner') on conflict do nothing;
  insert into public.profiles (id, scope_id) values (new.id, new.id) on conflict do nothing;
  return new;
end $$;

insert into public.profiles (id, scope_id)
select u.id, u.id from auth.users u join public.sync_scopes s on s.id = u.id and s.kind = 'personal'
on conflict do nothing;
