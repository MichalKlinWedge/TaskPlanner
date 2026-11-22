-- Współpracownicy widoczni w przestrzeni (v1.x): współpracownik należy do zakresu osobistego osoby,
-- która go dodała, więc pozostali członkowie udostępnionej przestrzeni dostawali samo
-- `tasks.assignee_id` / `task_participants.collaborator_id` bez osoby (pokazywali „—”).
--
--   * `scope_collaborators` — kopia (nazwa, akronim, nieaktywny) współpracownika użytego w przestrzeni:
--     jako odpowiedzialny albo uczestnik zadania. Pisana tylko przez wyzwalacze (zadania, uczestnicy,
--     zmiana współpracownika); wiersz w zakresie przestrzeni, więc przychodzi każdemu członkowi
--     w `pull_changes` jak tabele tylko do odczytu (`pulled_readonly_tables`). Bez e-maila.
--     Usunięty współpracownik = kopia z `deleted_at`.
--   * Odpowiedzialnym / uczestnikiem można wskazać także osobę z kopii w przestrzeni zadania — gość
--     z edycją wybiera te same osoby co właściciel, nie tylko swoich współpracowników.
--
-- Tylko przestrzenie (`sync_scopes.kind = 'workspace'`): w zakresie osobistym zadania widzi tylko właściciel.

create table public.scope_collaborators (
  id uuid primary key,
  scope_id uuid not null references public.sync_scopes (id) on delete cascade,
  collaborator_id uuid not null references public.collaborators (id) on delete cascade,
  name text not null,
  acronym text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  row_version bigint not null default 0,
  unique (scope_id, collaborator_id)
);
create index scope_collaborators_sync on public.scope_collaborators (scope_id, row_version);
create index scope_collaborators_collaborator on public.scope_collaborators (collaborator_id);

alter table public.scope_collaborators enable row level security;
create policy scope_collaborators_select on public.scope_collaborators for select to authenticated using (public.has_scope_access(scope_id));
revoke all on public.scope_collaborators from anon;
revoke insert, update, delete, truncate on public.scope_collaborators from authenticated;
-- Projekt w chmurze nie nadaje ról API do tabel z migracji (wniosek z PoC-6).
grant select on public.scope_collaborators to authenticated;
grant all on public.scope_collaborators to service_role;

-- Wersja wiersza z licznika zakresu (jak `stamp_row`, bez reguł zapisu — piszą tylko wyzwalacze).
create function public.stamp_scope_collaborator() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.sync_scopes set sync_version = sync_version + 1 where id = new.scope_id
  returning sync_version into new.row_version;
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
  end if;
  return new;
end $$;
create trigger z_stamp before insert or update on public.scope_collaborators for each row execute function public.stamp_scope_collaborator();

-- Kopia współpracownika w przestrzeni: nowa albo odświeżona (bez zmian — bez nowej wersji).
create function public.mirror_collaborator(p_scope uuid, p_collaborator uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_scope is null or p_collaborator is null
     or not exists (select 1 from public.sync_scopes s where s.id = p_scope and s.kind = 'workspace') then
    return;
  end if;
  insert into public.scope_collaborators as sc (id, scope_id, collaborator_id, name, acronym, archived_at, deleted_at)
  select md5(p_scope::text || ':' || c.id::text)::uuid, p_scope, c.id, c.name, c.acronym, c.archived_at, c.deleted_at
    from public.collaborators c
   where c.id = p_collaborator
  on conflict (scope_id, collaborator_id) do update
     set name = excluded.name, acronym = excluded.acronym, archived_at = excluded.archived_at, deleted_at = excluded.deleted_at
   where (sc.name, sc.acronym, sc.archived_at, sc.deleted_at)
         is distinct from (excluded.name, excluded.acronym, excluded.archived_at, excluded.deleted_at);
end $$;

create function public.mirror_task_assignee() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id or new.scope_id is distinct from old.scope_id) then
    perform public.mirror_collaborator(new.scope_id, new.assignee_id);
  end if;
  return null;
end $$;
create trigger z_mirror_assignee after insert or update of assignee_id, scope_id on public.tasks
  for each row execute function public.mirror_task_assignee();

create function public.mirror_task_participant() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is null
     and (tg_op = 'INSERT' or new.collaborator_id is distinct from old.collaborator_id
          or new.scope_id is distinct from old.scope_id or old.deleted_at is not null) then
    perform public.mirror_collaborator(new.scope_id, new.collaborator_id);
  end if;
  return null;
end $$;
create trigger z_mirror_participant after insert or update on public.task_participants
  for each row execute function public.mirror_task_participant();

-- Zmiana nazwy, akronimu, statusu albo usunięcie współpracownika — we wszystkich jego kopiach.
create function public.mirror_collaborator_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.name, new.acronym, new.archived_at, new.deleted_at) is distinct from (old.name, old.acronym, old.archived_at, old.deleted_at) then
    update public.scope_collaborators sc
       set name = new.name, acronym = new.acronym, archived_at = new.archived_at, deleted_at = new.deleted_at
     where sc.collaborator_id = new.id;
  end if;
  return null;
end $$;
create trigger z_mirror after update on public.collaborators for each row execute function public.mirror_collaborator_change();

revoke execute on function public.stamp_scope_collaborator(), public.mirror_collaborator(uuid, uuid), public.mirror_task_assignee(),
  public.mirror_task_participant(), public.mirror_collaborator_change() from anon, authenticated, public;

-- ── Wskazanie osoby z kopii w przestrzeni ────────────────────────────────────────────────────

-- Współpracownik, którego zalogowany może wskazać w zakresie: własny (z zakresu, do którego pisze)
-- albo z kopii w tej przestrzeni.
create function public.can_use_collaborator(p_collaborator uuid, p_scope uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.collaborators c where c.id = p_collaborator and public.can_write_scope(c.scope_id))
      or exists (select 1 from public.scope_collaborators sc
                  where sc.collaborator_id = p_collaborator and sc.scope_id = p_scope and sc.deleted_at is null
                    and public.can_write_scope(p_scope));
$$;
revoke execute on function public.can_use_collaborator(uuid, uuid) from anon, public;

create or replace function public.derive_task_participant() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select scope_id into new.scope_id from public.tasks where id = new.task_id;
  if new.scope_id is null then
    raise exception using errcode = '23503', message = 'Brak zadania';
  end if;
  if auth.uid() is not null and not public.can_use_collaborator(new.collaborator_id, new.scope_id) then
    raise exception using errcode = 'TP003', message = 'Brak dostępu do współpracownika';
  end if;
  return new;
end $$;

-- `a_assignee` działa przed `a_derive` zadania — zakres z listy.
create or replace function public.check_task_assignee() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.assignee_id is not null and auth.uid() is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not public.can_use_collaborator(new.assignee_id, (select l.scope_id from public.lists l where l.id = new.list_id)) then
    raise exception using errcode = 'TP003', message = 'Brak dostępu do współpracownika';
  end if;
  return new;
end $$;

-- ── Kopie dla już wskazanych osób ────────────────────────────────────────────────────────────

do $$
declare
  r record;
begin
  for r in
    select t.scope_id, t.assignee_id as collaborator_id from public.tasks t where t.assignee_id is not null
    union
    select p.scope_id, p.collaborator_id from public.task_participants p where p.deleted_at is null
  loop
    perform public.mirror_collaborator(r.scope_id, r.collaborator_id);
  end loop;
end $$;

-- ── Odczyt ───────────────────────────────────────────────────────────────────────────────────

create or replace function public.pulled_readonly_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array['calendar_accounts', 'calendars', 'calendar_events', 'scope_collaborators']
$$;

-- `pull_changes` jak w `*_v1x_scope_members_count.sql`, z kopiami współpracowników przestrzeni.

create or replace function public.pull_changes(p_since jsonb default '{}', p_limit integer default 1000) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  since jsonb := coalesce(p_since, '{}');
  lim integer := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  hidden uuid[] := public.hidden_lists();
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

  -- Wyrażenie „listy wiersza” per tabela (jak `row_lists`, ale w zapytaniu zbiorczym).
  with lists_of as (
    select s.tbl_name, case
             when s.tbl_name = 'lists' then 'array[r.id]'
             when s.tbl_name = 'tasks' then 'array[r.list_id]'
             when s.tbl_name = 'task_dependencies' then 'array(select x.list_id from public.tasks x where x.id in (r.predecessor_id, r.successor_id))'
             when exists (select 1 from information_schema.columns c
                           where c.table_schema = 'public' and c.table_name = s.tbl_name and c.column_name = 'task_id')
               then 'array(select x.list_id from public.tasks x where x.id = r.task_id)'
           end as expr
      from unnest(public.synced_tables()) as s(tbl_name)
  )
  select string_agg(
           format(
             'select %1$L as tbl, r.scope_id, r.row_version, to_jsonb(r) as data
                from public.%1$I r
                join public.scope_members m on m.scope_id = r.scope_id and m.user_id = auth.uid()
               where r.row_version > coalesce(($1 ->> r.scope_id::text)::bigint, 0)
                 and (coalesce(($1 ->> r.scope_id::text)::bigint, 0) > 0 or r.deleted_at is null)%2$s',
             l.tbl_name,
             case when l.expr is null then '' else format(' and (cardinality($3) = 0 or not (%s && $3))', l.expr) end)
           || case when l.expr is null then '' else format(
             '
              union all
              select ''_gone'', r.scope_id, r.row_version, jsonb_build_object(''table'', %1$L, ''id'', r.id)
                from public.%1$I r
                join public.scope_members m on m.scope_id = r.scope_id and m.user_id = auth.uid()
               where cardinality($3) > 0
                 and r.row_version > coalesce(($1 ->> r.scope_id::text)::bigint, 0)
                 and coalesce(($1 ->> r.scope_id::text)::bigint, 0) > 0
                 and %2$s && $3', l.tbl_name, l.expr) end,
           ' union all ')
    into page_sql
    from lists_of l;

  -- Integracje (zakres osobisty = `user_id`): tylko kolumny widoczne dla klienta, nagrobki tylko przyrostowo.
  page_sql := page_sql || $q$
    union all
    select 'calendar_accounts', r.user_id, r.row_version,
           jsonb_build_object('id', r.id, 'scope_id', r.user_id, 'provider', r.provider, 'label', r.label, 'status', r.status,
                              'last_synced_at', r.last_synced_at, 'last_error', r.last_error, 'created_at', r.created_at,
                              'updated_at', r.updated_at, 'row_version', r.row_version, 'deleted_at', null)
      from public.calendar_accounts r
     where r.user_id = auth.uid() and r.row_version > coalesce(($1 ->> r.user_id::text)::bigint, 0)
    union all
    select 'calendars', r.user_id, r.row_version,
           jsonb_build_object('id', r.id, 'scope_id', r.user_id, 'account_id', r.account_id, 'name', r.name, 'color', r.color,
                              'visible', r.visible, 'is_task_target', r.is_task_target, 'last_synced_at', r.last_synced_at,
                              'created_at', r.created_at, 'updated_at', r.updated_at, 'row_version', r.row_version, 'deleted_at', null)
      from public.calendars r
     where r.user_id = auth.uid() and r.row_version > coalesce(($1 ->> r.user_id::text)::bigint, 0)
    union all
    select 'calendar_events', r.user_id, r.row_version, (to_jsonb(r) - 'user_id' - 'etag') || jsonb_build_object('scope_id', r.user_id)
      from public.calendar_events r
     where r.user_id = auth.uid() and r.row_version > coalesce(($1 ->> r.user_id::text)::bigint, 0)
       and (coalesce(($1 ->> r.user_id::text)::bigint, 0) > 0 or r.deleted_at is null)
    union all
    select x.tbl, x.user_id, x.row_version,
           jsonb_build_object('id', x.id, 'scope_id', x.user_id, 'row_version', x.row_version, 'deleted_at', x.deleted_at)
      from public.integration_tombstones x
     where x.user_id = auth.uid() and x.row_version > coalesce(($1 ->> x.user_id::text)::bigint, 0)
       and coalesce(($1 ->> x.user_id::text)::bigint, 0) > 0
    union all
    select 'scope_collaborators', r.scope_id, r.row_version,
           jsonb_build_object('id', r.id, 'scope_id', r.scope_id, 'collaborator_id', r.collaborator_id, 'name', r.name,
                              'acronym', r.acronym, 'archived_at', r.archived_at, 'created_at', r.created_at,
                              'updated_at', r.updated_at, 'row_version', r.row_version, 'deleted_at', r.deleted_at)
      from public.scope_collaborators r
      join public.scope_members m on m.scope_id = r.scope_id and m.user_id = auth.uid()
     where r.row_version > coalesce(($1 ->> r.scope_id::text)::bigint, 0)
       and (coalesce(($1 ->> r.scope_id::text)::bigint, 0) > 0 or r.deleted_at is null)$q$;

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
    into page using since, lim, hidden;
  more := page.more;
  foreach t in array public.synced_tables() || public.pulled_readonly_tables() || array['_gone'] loop
    tables := tables || jsonb_build_object(t, coalesce(page.tables -> t, '[]'::jsonb));
  end loop;

  -- Bez `more` każdy zakres przyszedł w całości. Z `more`: zakresy przed ostatnim — w całości,
  -- ostatni — do kursora, dalsze — bez zmian.
  select coalesce(jsonb_object_agg(s.id, jsonb_build_object(
           'kind', s.kind,
           'role', m.role,
           'hidden', (select coalesce(jsonb_agg(l.id order by l.id), '[]') from public.lists l
                       where l.scope_id = s.id and l.id = any(hidden)),
           'members', (select count(*) from public.scope_members x where x.scope_id = s.id),
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
