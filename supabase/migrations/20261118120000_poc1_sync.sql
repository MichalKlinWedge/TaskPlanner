-- PoC-1: synchronizacja local-first w obie strony (SPECYFIKACJA §5, §6).
--
-- Zakres synchronizacji (`sync_scopes`) = przestrzeń albo zakres osobisty użytkownika (id = id
-- użytkownika). Każdy synchronizowany wiersz ma `scope_id`, `row_version` (nadawany w triggerze
-- z licznika zakresu pod blokadą jego wiersza — kolejność wersji = kolejność zatwierdzania),
-- `field_clock` (HLC ostatniej zmiany każdego pola) i `deleted_at` (bez twardego usuwania).
-- Klienci piszą tylko przez `push_changes` (LWW per pole), czytają przez `pull_changes`.

-- ── Zakresy i członkowie ─────────────────────────────────────────────────────────────────────

create table public.sync_scopes (
  id uuid primary key,
  kind text not null check (kind in ('workspace', 'personal')),
  owner_id uuid not null references auth.users (id) on delete cascade,
  sync_version bigint not null default 0,
  created_at timestamptz not null default now()
);

-- Odstępstwo od §5: członkostwo per zakres (nie `workspace_members`), bo zakres osobisty też go potrzebuje.
create table public.scope_members (
  scope_id uuid not null references public.sync_scopes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'editor', 'viewer')),
  primary key (scope_id, user_id)
);
create index scope_members_user on public.scope_members (user_id);

create function public.has_scope_access(p_scope uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.scope_members m where m.scope_id = p_scope and m.user_id = auth.uid());
$$;

create function public.can_write_scope(p_scope uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.scope_members m
     where m.scope_id = p_scope and m.user_id = auth.uid() and m.role in ('owner', 'editor')
  );
$$;

-- Zakres osobisty powstaje razem z kontem.
create function public.create_personal_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.sync_scopes (id, kind, owner_id) values (new.id, 'personal', new.id) on conflict do nothing;
  insert into public.scope_members (scope_id, user_id, role) values (new.id, new.id, 'owner') on conflict do nothing;
  return new;
end $$;

create trigger create_personal_scope after insert on auth.users
  for each row execute function public.create_personal_scope();

-- Znacznik HLC serwera (operacje z integracji, obcinanie zegara z przyszłości). Format jak `core/hlc.ts`.
create function public.server_hlc() returns text
language sql volatile set search_path = '' as $$
  select lpad(floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text, 15, '0') || ':00000:server';
$$;

-- ── Tabele synchronizowane ───────────────────────────────────────────────────────────────────

create table public.workspaces (
  id uuid primary key,
  name text not null check (length(btrim(name)) between 1 and 100),
  color text,
  icon text,
  sort_key text not null default 'n' check (sort_key ~ '^[0-9a-z]+$'),
  archived_at timestamptz
);

create table public.lists (
  id uuid primary key,
  kind text not null default 'list' check (kind in ('inbox', 'project', 'list')),
  name text not null check (length(btrim(name)) between 1 and 200),
  color text,
  icon text,
  description_md text,
  start_date date,
  end_date date,
  project_status text check (project_status in ('active', 'on_hold', 'done')),
  sort_key text not null default 'n' check (sort_key ~ '^[0-9a-z]+$'),
  view_prefs jsonb not null default '{}'
);

create table public.tasks (
  id uuid primary key,
  list_id uuid not null references public.lists (id),
  parent_id uuid references public.tasks (id),
  kind text not null default 'task' check (kind in ('task', 'habit')),
  title text not null check (length(btrim(title)) between 1 and 500),
  description_md text,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'waiting', 'done', 'cancelled')),
  priority smallint not null default 4 check (priority between 1 and 4),
  start_date date,
  due_date date,
  due_time text check (due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  duration_min integer check (duration_min between 1 and 10080),
  time_zone text,
  recurrence jsonb,
  habit jsonb,
  completed_at timestamptz,
  sort_key text not null default 'n' check (sort_key ~ '^[0-9a-z]+$'),
  source jsonb,
  postpone_count integer not null default 0 check (postpone_count >= 0)
);
create index tasks_list on public.tasks (list_id);
create index tasks_parent on public.tasks (parent_id);

create table public.tags (
  id uuid primary key,
  name text not null check (length(btrim(name)) between 1 and 60),
  color text,
  sort_key text not null default 'n' check (sort_key ~ '^[0-9a-z]+$')
);

-- id = UUIDv5(task_id + tag_id) z klienta: dodanie tego samego tagu na dwóch urządzeniach to jeden wiersz.
create table public.task_tags (
  id uuid primary key,
  task_id uuid not null references public.tasks (id),
  tag_id uuid not null references public.tags (id),
  unique (task_id, tag_id)
);

-- id = UUIDv5(task_id + occurrence_date): podwójne ukończenie wystąpienia to jeden wiersz.
create table public.task_completions (
  id uuid primary key,
  task_id uuid not null references public.tasks (id),
  occurrence_date date not null,
  kind text not null default 'done' check (kind in ('done', 'skipped')),
  value numeric,
  completed_at timestamptz not null default now(),
  unique (task_id, occurrence_date)
);

-- Kolejność = kolejność stosowania u klienta (rodzice przed dziećmi).
create function public.synced_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array['workspaces', 'lists', 'tasks', 'tags', 'task_tags', 'task_completions']
$$;

-- ── Wspólne kolumny, RLS i znacznik wersji ───────────────────────────────────────────────────

create function public.stamp_row() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Zapis w imieniu użytkownika (nie `service_role`): tylko do zakresów, w których może pisać.
  if auth.uid() is not null then
    if not public.can_write_scope(new.scope_id)
       or (tg_op = 'UPDATE' and old.scope_id <> new.scope_id and not public.can_write_scope(old.scope_id)) then
      raise exception using errcode = 'TP003', message = 'Brak dostępu do zakresu';
    end if;
  end if;
  update public.sync_scopes set sync_version = sync_version + 1 where id = new.scope_id
  returning sync_version into new.row_version;
  if new.row_version is null then
    raise exception using errcode = 'TP004', message = 'Brak zakresu ' || coalesce(new.scope_id::text, 'null');
  end if;
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;
  return new;
end $$;

do $$
declare
  t text;
begin
  foreach t in array public.synced_tables() loop
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
    -- Wyzwalacze BEFORE odpalają się alfabetycznie: `a_derive` (pola wyliczane) przed `z_stamp`.
    execute format('create trigger z_stamp before insert or update on public.%I for each row execute function public.stamp_row()', t);
  end loop;
end $$;

create unique index tags_name_unique on public.tags (scope_id, lower(name)) where deleted_at is null;
create unique index lists_one_inbox on public.lists (scope_id) where kind = 'inbox' and deleted_at is null;

alter table public.sync_scopes enable row level security;
create policy sync_scopes_select on public.sync_scopes for select to authenticated using (public.has_scope_access(id));
alter table public.scope_members enable row level security;
create policy scope_members_select on public.scope_members for select to authenticated using (user_id = auth.uid());
revoke all on public.sync_scopes, public.scope_members from anon;
revoke insert, update, delete, truncate on public.sync_scopes, public.scope_members from authenticated;

-- ── Pola wyliczane i reguły ──────────────────────────────────────────────────────────────────

-- Przestrzeń jest swoim zakresem: nowa tworzy zakres i członkostwo właściciela.
create function public.derive_workspace() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := coalesce(auth.uid(), new.created_by);
begin
  new.scope_id := new.id;
  if tg_op = 'INSERT' then
    if owner is null then
      raise exception using errcode = 'TP004', message = 'Przestrzeń bez właściciela';
    end if;
    insert into public.sync_scopes (id, kind, owner_id) values (new.id, 'workspace', owner) on conflict do nothing;
    insert into public.scope_members (scope_id, user_id, role)
      select new.id, owner, 'owner' where exists (select 1 from public.sync_scopes where id = new.id and owner_id = owner)
      on conflict do nothing;
  end if;
  return new;
end $$;
create trigger a_derive before insert or update on public.workspaces for each row execute function public.derive_workspace();

create function public.derive_list() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.sync_scopes where id = new.scope_id and kind = 'workspace') then
    raise exception using errcode = 'TP004', message = 'Lista musi należeć do przestrzeni';
  end if;
  return new;
end $$;
create trigger a_derive before insert or update on public.lists for each row execute function public.derive_list();

create function public.derive_tag() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.scope_id := coalesce(new.scope_id, auth.uid());
  if not exists (select 1 from public.sync_scopes where id = new.scope_id and kind = 'personal') then
    raise exception using errcode = 'TP004', message = 'Tag musi należeć do zakresu osobistego';
  end if;
  return new;
end $$;
create trigger a_derive before insert or update on public.tags for each row execute function public.derive_tag();

-- Zadanie: lista podzadania = lista rodzica, zakres = zakres listy; maks. 4 poziomy, bez cykli.
create function public.derive_task() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  parent_list uuid;
  cur uuid;
  depth int := 1;
  height int := 0;
begin
  if new.parent_id is not null then
    select list_id into parent_list from public.tasks where id = new.parent_id;
    if parent_list is null then
      raise exception using errcode = '23503', message = 'Brak zadania nadrzędnego';
    end if;
    new.list_id := parent_list;
    cur := new.parent_id;
    while cur is not null loop
      if cur = new.id then
        raise exception using errcode = 'TP002', message = 'Cykl podzadań';
      end if;
      depth := depth + 1;
      exit when depth > 16;
      select parent_id into cur from public.tasks where id = cur;
    end loop;
  end if;
  if tg_op = 'UPDATE' then
    with recursive sub (id, h) as (
      select id, 1 from public.tasks where parent_id = new.id
      union all
      select t.id, s.h + 1 from public.tasks t join sub s on t.parent_id = s.id where s.h < 16
    )
    select coalesce(max(h), 0) into height from sub;
  end if;
  if depth + height > 4 then
    raise exception using errcode = 'TP001', message = 'Za głęboko: najwyżej 4 poziomy zadań';
  end if;
  select scope_id into new.scope_id from public.lists where id = new.list_id;
  if new.scope_id is null then
    raise exception using errcode = '23503', message = 'Brak listy';
  end if;
  return new;
end $$;
create trigger a_derive before insert or update on public.tasks for each row execute function public.derive_task();

create function public.derive_task_child() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select scope_id into new.scope_id from public.tasks where id = new.task_id;
  if new.scope_id is null then
    raise exception using errcode = '23503', message = 'Brak zadania';
  end if;
  return new;
end $$;
create trigger a_derive before insert or update on public.task_completions for each row execute function public.derive_task_child();

create function public.derive_task_tag() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select scope_id into new.scope_id from public.tasks where id = new.task_id;
  if new.scope_id is null then
    raise exception using errcode = '23503', message = 'Brak zadania';
  end if;
  if auth.uid() is not null
     and not exists (select 1 from public.tags g where g.id = new.tag_id and public.can_write_scope(g.scope_id)) then
    raise exception using errcode = 'TP003', message = 'Brak dostępu do tagu';
  end if;
  return new;
end $$;
create trigger a_derive before insert or update on public.task_tags for each row execute function public.derive_task_tag();

-- Kaskady po zapisie: przeniesienie i miękkie usunięcie idą w dół drzewa. Usunięcie dzieci ma ten
-- sam `deleted_at` co rodzic, więc przywrócenie rodzica przywraca tylko to, co usunęło się razem z nim.
create function public.cascade_task() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.list_id is distinct from old.list_id then
    update public.tasks set list_id = new.list_id where parent_id = new.id and list_id is distinct from new.list_id;
  end if;
  if new.scope_id is distinct from old.scope_id then
    update public.task_tags set scope_id = new.scope_id where task_id = new.id;
    update public.task_completions set scope_id = new.scope_id where task_id = new.id;
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
create trigger cascade after update on public.tasks for each row execute function public.cascade_task();

create function public.cascade_list() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.scope_id is distinct from old.scope_id then
    update public.tasks set scope_id = new.scope_id where list_id = new.id;
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    update public.tasks
       set deleted_at = new.deleted_at,
           field_clock = field_clock || jsonb_build_object('deleted_at', new.field_clock -> 'deleted_at')
     where list_id = new.id and parent_id is null and deleted_at is null;
  elsif new.deleted_at is null and old.deleted_at is not null then
    update public.tasks
       set deleted_at = null,
           field_clock = field_clock || jsonb_build_object('deleted_at', new.field_clock -> 'deleted_at')
     where list_id = new.id and parent_id is null and deleted_at = old.deleted_at;
  end if;
  return null;
end $$;
create trigger cascade after update on public.lists for each row execute function public.cascade_list();

-- ── Zapis: push_changes ──────────────────────────────────────────────────────────────────────

-- Pola, które klient może ustawić. `scope_id` tylko tam, gdzie wybiera go użytkownik (lista →
-- przestrzeń, tag → zakres osobisty); w pozostałych tabelach jest wyliczany.
create function public.writable_columns(p_table text) returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(column_name::text order by ordinal_position), '{}')
    from information_schema.columns
   where table_schema = 'public' and table_name = p_table
     and column_name not in ('id', 'created_at', 'updated_at', 'created_by', 'row_version', 'field_clock')
     and (column_name <> 'scope_id' or p_table in ('lists', 'tags'));
$$;

-- `p_ops`: [{op, table, id, set: {pole: wartość}, hlc}] w kolejności z outboxu. Pole zapisuje się
-- tylko, gdy HLC operacji jest nowszy niż `field_clock` tego pola — powtórka nic nie zmienia, a wynik
-- nie zależy od kolejności, w jakiej operacje z różnych urządzeń dotrą. Każda operacja w osobnym
-- punkcie zapisu: odrzucona (reguła, uprawnienia, typ) nie psuje reszty paczki. Dla odrzuconych
-- i obciętych (zegar z przyszłości) zwracany jest bieżący wiersz serwera, którym klient nadpisuje swój.
create function public.push_changes(p_ops jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  op jsonb;
  tbl text;
  rid uuid;
  data jsonb;
  hlc text;
  cols text[];
  win text[];
  clock jsonb;
  row_scope uuid;
  inserted int;
  writable jsonb := '{}';
  t text;
  max_wall bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint + 300000;
  applied int := 0;
  rejected jsonb := '[]';
  clamped jsonb := '[]';
  touched jsonb := '[]';
  current_rows jsonb := '[]';
  row_data jsonb;
  item jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Wymagane logowanie';
  end if;
  foreach t in array public.synced_tables() loop
    writable := writable || jsonb_build_object(t, to_jsonb(public.writable_columns(t)));
  end loop;

  for op in select value from jsonb_array_elements(p_ops) loop
    tbl := op ->> 'table';
    data := coalesce(op -> 'set', '{}');
    hlc := op ->> 'hlc';
    begin
      rid := (op ->> 'id')::uuid;
      if writable -> tbl is null then
        raise exception using errcode = 'TP005', message = 'Nieznana tabela ' || coalesce(tbl, 'null');
      end if;
      if hlc is null or hlc !~ '^[0-9]{15}:[0-9]{5}:[A-Za-z0-9_-]{1,64}$' then
        raise exception using errcode = 'TP006', message = 'Niepoprawny HLC';
      end if;
      if left(hlc, 15)::bigint > max_wall then
        hlc := public.server_hlc();
        clamped := clamped || jsonb_build_array(op -> 'op');
        touched := touched || jsonb_build_array(jsonb_build_object('table', tbl, 'id', rid));
      end if;
      select coalesce(array_agg(k), '{}') into cols from jsonb_object_keys(data) k;
      if exists (select 1 from unnest(cols) c where not (writable -> tbl) ? c) then
        raise exception using errcode = 'TP005', message = 'Niedozwolone pole w ' || tbl;
      end if;

      execute format('select field_clock, scope_id from public.%I where id = $1 for update', tbl) into clock, row_scope using rid;
      if clock is null then
        execute format(
          'insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I, $1) on conflict (id) do nothing',
          tbl, (select string_agg(quote_ident(c), ', ') from unnest(cols || array['id', 'field_clock']) c))
        using data || jsonb_build_object(
          'id', rid,
          'field_clock', (select coalesce(jsonb_object_agg(c, hlc), '{}') from unnest(cols) c));
        get diagnostics inserted = row_count;
        if inserted = 0 then
          -- Ktoś wstawił ten sam id równolegle: dalej jak zwykła zmiana.
          execute format('select field_clock, scope_id from public.%I where id = $1 for update', tbl) into clock, row_scope using rid;
        end if;
      end if;
      -- Także wtedy, gdy żadne pole nie wygra LWW: obcy zapis ma być odrzucony, a nie „przyjęty bez zmian”.
      if clock is not null and not public.can_write_scope(row_scope) then
        raise exception using errcode = 'TP003', message = 'Brak dostępu do zakresu';
      end if;
      if clock is not null then
        select array_agg(c) into win from unnest(cols) c
         where hlc collate "C" > coalesce(clock ->> c, '') collate "C";
        if win is not null then
          execute format(
            'update public.%1$I set (%2$s, field_clock) = (select %2$s, $2 from jsonb_populate_record(null::public.%1$I, $1)) where id = $3',
            tbl, (select string_agg(quote_ident(c), ', ') from unnest(win) c))
          using data, clock || (select jsonb_object_agg(c, hlc) from unnest(win) c), rid;
        end if;
      end if;
      applied := applied + 1;
    exception when others then
      rejected := rejected || jsonb_build_array(jsonb_build_object('op', op -> 'op', 'code', sqlstate, 'message', sqlerrm));
      if tbl = any(public.synced_tables()) and rid is not null then
        touched := touched || jsonb_build_array(jsonb_build_object('table', tbl, 'id', rid));
      end if;
    end;
  end loop;

  for item in select distinct value from jsonb_array_elements(touched) loop
    execute format('select to_jsonb(r) from public.%I r where r.id = $1 and public.has_scope_access(r.scope_id)', item ->> 'table')
      into row_data using (item ->> 'id')::uuid;
    current_rows := current_rows || jsonb_build_array(item || jsonb_build_object('row', row_data));
  end loop;

  return jsonb_build_object(
    'applied', applied,
    'rejected', rejected,
    'clamped', clamped,
    'rows', current_rows,
    'serverHlc', public.server_hlc());
end $$;

-- ── Odczyt: pull_changes ─────────────────────────────────────────────────────────────────────

-- `p_since`: {scope_id: ostatnia wersja}. Zwraca wersje wszystkich zakresów użytkownika i wiersze
-- z `row_version` większym niż znana wersja zakresu. Funkcja STABLE widzi jedną migawkę bazy
-- (migawka zapytania wywołującego), więc wersja zakresu i wiersze są ze sobą zgodne. Pełna
-- migawka (wersja 0) pomija usunięte wiersze.
create function public.pull_changes(p_since jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  scopes jsonb;
  tables jsonb := '{}';
  rows jsonb;
  t text;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Wymagane logowanie';
  end if;
  select coalesce(jsonb_object_agg(s.id, jsonb_build_object('kind', s.kind, 'version', s.sync_version, 'role', m.role)), '{}')
    into scopes
    from public.sync_scopes s
    join public.scope_members m on m.scope_id = s.id and m.user_id = auth.uid();
  foreach t in array public.synced_tables() loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(r) order by r.row_version), ''[]'')
         from public.%I r
         join public.scope_members m on m.scope_id = r.scope_id and m.user_id = auth.uid()
        where r.row_version > coalesce(($1 ->> r.scope_id::text)::bigint, 0)
          and (coalesce(($1 ->> r.scope_id::text)::bigint, 0) > 0 or r.deleted_at is null)', t)
      into rows using coalesce(p_since, '{}');
    tables := tables || jsonb_build_object(t, rows);
  end loop;
  return jsonb_build_object('scopes', scopes, 'tables', tables, 'serverHlc', public.server_hlc());
end $$;

revoke execute on function public.push_changes(jsonb), public.pull_changes(jsonb) from anon, public;
grant execute on function public.push_changes(jsonb), public.pull_changes(jsonb) to authenticated;
revoke execute on function public.has_scope_access(uuid), public.can_write_scope(uuid) from anon, public;
grant execute on function public.has_scope_access(uuid), public.can_write_scope(uuid) to authenticated;

-- Klient słucha zmian swoich wierszy `sync_scopes` (licznik rośnie przy każdym zapisie) i reaguje
-- pobraniem przyrostowym, zamiast stosować payloady Realtime (wniosek z ExpeditionPlan).
alter publication supabase_realtime add table public.sync_scopes;
