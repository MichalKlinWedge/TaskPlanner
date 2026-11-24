-- v1.x: definitywne usunięcie zadania z kosza (M3).
--
-- `purge_tasks(ids)` usuwa z bazy zadania leżące w koszu razem z podzadaniami usuniętymi naraz
-- i wszystkim, co do nich należy (tagi, przypomnienia, komentarze, załączniki, czas, wykonania,
-- zależności, historia zmian). Wymaga edycji listy (`list_access` = `edit`); zadanie, którego nie ma
-- już w koszu (przywrócone na innym urządzeniu), jest odrzucane w całości (TP007) — dlatego operacja
-- idzie wprost do serwera, a nie przez outbox. Podzadania usunięte osobno (wcześniej) zostają w koszu
-- jako zadania główne.
--
--   * `purged_tasks` — nagrobek w zakresie zadania; `pull_changes` wysyła go w przyroście jako `_gone`
--     (`{table: 'tasks', id}`), więc także starsze wersje aplikacji usuwają swoją kopię. Wiersz wraca
--     do bazy tylko z kopii zapasowej (te same id) — wtedy nagrobek znika.
--   * `purged_files` — pliki załączników usuniętych zadań: SQL nie kasuje plików w Storage, więc robi to
--     klient, który usunął zadanie (polityka `attachments_purge`). Niedokończone wracają przy następnym
--     usunięciu.
--   * `calendar_task_links.task_id` bez klucza obcego: powiązanie zostaje, dopóki `calendar-sync` nie
--     usunie wydarzenia w Google (zadanie bez wiersza = wydarzenie do usunięcia).

create table public.purged_tasks (
  id uuid primary key,
  scope_id uuid not null references public.sync_scopes (id) on delete cascade,
  row_version bigint not null,
  purged_by uuid,
  purged_at timestamptz not null default now()
);
create index purged_tasks_sync on public.purged_tasks (scope_id, row_version);

create table public.purged_files (
  path text primary key,
  purged_by uuid not null references auth.users (id) on delete cascade,
  purged_at timestamptz not null default now()
);
create index purged_files_user on public.purged_files (purged_by);

alter table public.purged_tasks enable row level security;
alter table public.purged_files enable row level security;
revoke all on public.purged_tasks, public.purged_files from anon, authenticated;
grant select, insert, update, delete on public.purged_tasks, public.purged_files to service_role;

alter table public.calendar_task_links drop constraint calendar_task_links_task_id_fkey;

-- Zadanie wczytane z kopii zapasowej pod tym samym id: nagrobek już nie obowiązuje.
create function public.clear_purged_task() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.purged_tasks where id = new.id;
  return null;
end $$;
create trigger z_clear_purged after insert on public.tasks for each row execute function public.clear_purged_task();

-- ── Usunięcie ────────────────────────────────────────────────────────────────────────────────

create function public.purge_tasks(p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  ids uuid[];
  files text[];
  r record;
  version bigint;
begin
  if me is null then
    raise exception using errcode = '42501', message = 'Wymagane logowanie';
  end if;
  if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 500 then
    raise exception using errcode = '22023', message = 'Niepoprawna liczba zadań';
  end if;

  -- Blokada wierszy: równoległe przywrócenie albo nowe dziecko czeka i dostaje odmowę.
  perform 1 from public.tasks t where t.id = any(p_ids) order by t.id for update;
  -- Zadania, których już nie ma (usunięte z innego urządzenia), są pomijane.
  if exists (select 1 from public.tasks t where t.id = any(p_ids) and public.list_access(t.list_id, me) is distinct from 'edit') then
    raise exception using errcode = 'TP003', message = 'Brak dostępu do zadania';
  end if;
  if exists (select 1 from public.tasks t where t.id = any(p_ids) and t.deleted_at is null) then
    raise exception using errcode = 'TP007', message = 'Zadanie nie jest w koszu';
  end if;

  -- Z podzadaniami usuniętymi naraz (ten sam `deleted_at`, jak w `cascade_task`).
  with recursive sub (id, deleted_at) as (
    select t.id, t.deleted_at from public.tasks t where t.id = any(p_ids)
    union
    select t.id, t.deleted_at from public.tasks t join sub s on t.parent_id = s.id and t.deleted_at = s.deleted_at
  )
  select coalesce(array_agg(distinct s.id), '{}') into ids from sub s;
  perform 1 from public.tasks t where t.id = any(ids) order by t.id for update;

  -- Podzadania spoza tej grupy zostają jako zadania główne — przed nagrobkami, żeby klient najpierw
  -- dostał odpięte podzadanie, a dopiero potem usunął drzewo rodzica.
  update public.tasks t
     set parent_id = null,
         field_clock = t.field_clock || jsonb_build_object('parent_id', public.server_hlc())
   where t.parent_id = any(ids) and not (t.id = any(ids));

  select coalesce(array_agg(distinct a.storage_path), '{}') into files
    from public.attachments a where a.task_id = any(ids) and a.storage_path is not null;

  -- Wydarzenia tych zadań w Google (jeśli jeszcze są) usuwa najbliższy przebieg.
  for r in
    select distinct c.user_id from public.calendar_task_links l
      join public.calendars c on c.id = l.calendar_id where l.task_id = any(ids)
  loop
    perform public.calendar_kick(r.user_id);
  end loop;

  for r in select t.id, t.scope_id from public.tasks t where t.id = any(ids) order by t.scope_id, t.id loop
    update public.sync_scopes set sync_version = sync_version + 1 where id = r.scope_id returning sync_version into version;
    insert into public.purged_tasks (id, scope_id, row_version, purged_by) values (r.id, r.scope_id, version, me)
    on conflict (id) do update
       set scope_id = excluded.scope_id, row_version = excluded.row_version, purged_by = excluded.purged_by, purged_at = now();
  end loop;

  delete from public.task_tags where task_id = any(ids);
  delete from public.task_completions where task_id = any(ids);
  delete from public.reminders where task_id = any(ids);
  delete from public.task_dependencies where predecessor_id = any(ids) or successor_id = any(ids);
  delete from public.time_entries where task_id = any(ids);
  delete from public.attachments where task_id = any(ids);
  delete from public.task_participants where task_id = any(ids);
  delete from public.task_comments where task_id = any(ids);
  delete from public.plugin_requests where task_id = any(ids);
  delete from public.activity_log where row_id = any(ids);
  delete from public.tasks where id = any(ids);

  -- Pliki: nowe do skasowania (bez tych, których używa inny załącznik); skasowane wcześniej — z listy.
  insert into public.purged_files (path, purged_by)
  select f, me from unnest(files) f
   where not exists (select 1 from public.attachments a where a.storage_path = f)
  on conflict (path) do update set purged_by = excluded.purged_by, purged_at = now();
  delete from public.purged_files p
   where p.purged_by = me
     and not exists (select 1 from storage.objects o where o.bucket_id = 'attachments' and o.name = p.path);

  return jsonb_build_object(
    'purged', to_jsonb(ids),
    'files', (select coalesce(jsonb_agg(p.path order by p.path), '[]') from public.purged_files p where p.purged_by = me));
end $$;

-- ── Pliki usuniętych zadań ───────────────────────────────────────────────────────────────────

create function public.can_purge_file(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.purged_files p where p.path = p_name and p.purged_by = auth.uid())
     and not exists (select 1 from public.attachments a where a.storage_path = p_name)
$$;

revoke execute on function public.purge_tasks(uuid[]), public.can_purge_file(text), public.clear_purged_task() from public, anon;
grant execute on function public.purge_tasks(uuid[]), public.can_purge_file(text) to authenticated;

create policy attachments_purge on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and public.can_purge_file(name));
-- Storage kasuje tylko to, co wolno też odczytać.
create policy attachments_purge_select on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and public.can_purge_file(name));

-- ── pull_changes: jak w `*_v1x_ai.sql`, z nagrobkami usuniętych zadań w `_gone` ──────────────

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
       and (coalesce(($1 ->> r.scope_id::text)::bigint, 0) > 0 or r.deleted_at is null)
    union all
    select 'scope_tags', r.scope_id, r.row_version,
           jsonb_build_object('id', r.id, 'scope_id', r.scope_id, 'tag_id', r.tag_id, 'name', r.name, 'color', r.color,
                              'created_at', r.created_at, 'updated_at', r.updated_at, 'row_version', r.row_version,
                              'deleted_at', r.deleted_at)
      from public.scope_tags r
      join public.scope_members m on m.scope_id = r.scope_id and m.user_id = auth.uid()
     where r.row_version > coalesce(($1 ->> r.scope_id::text)::bigint, 0)
       and (coalesce(($1 ->> r.scope_id::text)::bigint, 0) > 0 or r.deleted_at is null)
    union all
    select 'plugin_connections', r.user_id, r.row_version,
           jsonb_build_object('id', r.id, 'scope_id', r.user_id, 'plugin', r.plugin, 'label', r.label, 'config', r.config,
                              'status', r.status, 'last_error', r.last_error, 'last_used_at', r.last_used_at,
                              'created_at', r.created_at, 'updated_at', r.updated_at, 'row_version', r.row_version,
                              'deleted_at', r.deleted_at)
      from public.plugin_connections r
     where r.user_id = auth.uid() and r.row_version > coalesce(($1 ->> r.user_id::text)::bigint, 0)
       and (coalesce(($1 ->> r.user_id::text)::bigint, 0) > 0 or r.deleted_at is null)
    union all
    select 'ai_accounts', r.user_id, r.row_version,
           jsonb_build_object('id', r.id, 'scope_id', r.user_id, 'provider', r.provider, 'model', r.model, 'models', r.models,
                              'key_hint', r.key_hint, 'status', r.status, 'last_error', r.last_error,
                              'verified_at', r.verified_at, 'billing_confirmed_at', r.billing_confirmed_at,
                              'created_at', r.created_at, 'updated_at', r.updated_at, 'row_version', r.row_version,
                              'deleted_at', r.deleted_at)
      from public.ai_accounts r
     where r.user_id = auth.uid() and r.row_version > coalesce(($1 ->> r.user_id::text)::bigint, 0)
       and (coalesce(($1 ->> r.user_id::text)::bigint, 0) > 0 or r.deleted_at is null)
    union all
    select '_gone', r.scope_id, r.row_version, jsonb_build_object('table', 'tasks', 'id', r.id)
      from public.purged_tasks r
      join public.scope_members m on m.scope_id = r.scope_id and m.user_id = auth.uid()
     where r.row_version > coalesce(($1 ->> r.scope_id::text)::bigint, 0)
       and coalesce(($1 ->> r.scope_id::text)::bigint, 0) > 0$q$;

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
