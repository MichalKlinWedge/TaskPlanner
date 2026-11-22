-- v1.x: dostęp gości do list współdzielonej przestrzeni.
--
-- `lists.guest_access` mówi, co z listą mogą zrobić członkowie przestrzeni inni niż właściciel:
-- `hidden` — nie widzą jej wcale (ani jej zadań i ich dzieci), `view` — tylko czytają, `edit` —
-- tyle, ile pozwala ich rola. Liczy się słabsze z dwóch: rola `viewer` nigdy nie edytuje, a lista
-- `view` ogranicza też edytora. Właściciel zawsze ma pełny dostęp i tylko on zmienia ustawienie
-- (nowa lista edytora ma zawsze `edit`).
--
-- Odczyt: `pull_changes` pomija wiersze ukrytych list (lista, zadania, ich dzieci, zależności),
-- w przyroście wysyła za to znaczniki `_gone` (`{table, id}`) — klient usuwa takie wiersze u siebie
-- (np. zadanie przeniesione na ukrytą listę). W `scopes[id].hidden` są ukryte listy zakresu: gdy
-- lista staje się ukryta, klient usuwa jej dane lokalnie; gdy przestaje — pobiera zakres od zera.
-- RLS i odczyt załączników też pomijają ukryte listy. Zapis: `stamp_row` odrzuca (TP003) zmianę
-- gościa w liście bez `edit`, także pośrednią (zadanie, jego dzieci, zależność, przeniesienie).

alter table public.lists
  add column guest_access text not null default 'edit' check (guest_access in ('hidden', 'view', 'edit'));

-- ── Dostęp ───────────────────────────────────────────────────────────────────────────────────

-- Dostęp użytkownika do listy: `edit` / `view` / `hidden`; `null` = nie jest członkiem jej przestrzeni.
create function public.list_access(p_list uuid, p_user uuid default auth.uid()) returns text
language sql stable security definer set search_path = '' as $$
  select case
           when m.role is null then null
           when m.role = 'owner' then 'edit'
           when l.guest_access = 'hidden' then 'hidden'
           when m.role = 'viewer' or l.guest_access = 'view' then 'view'
           else 'edit'
         end
    from public.lists l
    left join public.scope_members m on m.scope_id = l.scope_id and m.user_id = p_user
   where l.id = p_list
$$;

-- Ukryte przed użytkownikiem listy (we wszystkich jego przestrzeniach, w których nie jest właścicielem).
create function public.hidden_lists(p_user uuid default auth.uid()) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(l.id), '{}')
    from public.lists l
    join public.scope_members m on m.scope_id = l.scope_id and m.user_id = p_user
   where m.role <> 'owner' and l.guest_access = 'hidden'
$$;

-- Listy, do których należy wiersz synchronizowanej tabeli (zadanie — jego lista, dziecko zadania —
-- lista zadania, zależność — listy obu zadań); pusta tablica = wiersz poza listami.
create function public.row_lists(p_table text, p_row jsonb) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select case
           when p_table = 'lists' then array[(p_row ->> 'id')::uuid]
           when p_table = 'tasks' then array_remove(array[(p_row ->> 'list_id')::uuid], null)
           when p_table = 'task_dependencies' then array(
             select t.list_id from public.tasks t
              where t.id in ((p_row ->> 'predecessor_id')::uuid, (p_row ->> 'successor_id')::uuid))
           when p_row ->> 'task_id' is not null then array(select t.list_id from public.tasks t where t.id = (p_row ->> 'task_id')::uuid)
           else '{}'::uuid[]
         end
$$;

create function public.list_visible(p_list uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_list is null or not (p_list = any(public.hidden_lists()))
$$;

create function public.task_visible(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_task is null or coalesce((select public.list_visible(t.list_id) from public.tasks t where t.id = p_task), true)
$$;

create function public.row_visible(p_table text, p_row jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select not (public.row_lists(p_table, p_row) && public.hidden_lists())
$$;

revoke execute on function public.list_access(uuid, uuid), public.hidden_lists(uuid), public.row_lists(text, jsonb),
  public.list_visible(uuid), public.task_visible(uuid), public.row_visible(text, jsonb) from anon, public;
grant execute on function public.list_visible(uuid), public.task_visible(uuid) to authenticated;
grant execute on function public.list_access(uuid, uuid), public.hidden_lists(uuid) to service_role;

-- ── Zapis: reguła listy w `stamp_row` ────────────────────────────────────────────────────────

create or replace function public.stamp_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  role text;
begin
  -- Zapis w imieniu użytkownika (nie `service_role`): tylko do zakresów, w których może pisać.
  if auth.uid() is not null then
    if not public.can_write_scope(new.scope_id)
       or (tg_op = 'UPDATE' and old.scope_id <> new.scope_id and not public.can_write_scope(old.scope_id)) then
      raise exception using errcode = 'TP003', message = 'Brak dostępu do zakresu';
    end if;
    -- Gość (edytor) przestrzeni: tylko listy z `edit` — przed i po zmianie.
    role := public.scope_role(new.scope_id);
    if role is distinct from 'owner' then
      if tg_table_name = 'lists' then
        if new.guest_access <> 'edit' or (tg_op = 'UPDATE' and old.guest_access <> 'edit') then
          raise exception using errcode = 'TP003', message = 'Lista tylko do podglądu';
        end if;
      elsif exists (select 1 from unnest(public.row_lists(tg_table_name, to_jsonb(new))) x(id) where public.list_access(x.id) is distinct from 'edit')
         or (tg_op = 'UPDATE' and exists (
               select 1 from unnest(public.row_lists(tg_table_name, to_jsonb(old))) x(id)
                where public.list_access(x.id) is distinct from 'edit')) then
        raise exception using errcode = 'TP003', message = 'Lista tylko do podglądu';
      end if;
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

-- ── Odczyt: RLS, załączniki ──────────────────────────────────────────────────────────────────

drop policy lists_select on public.lists;
create policy lists_select on public.lists for select to authenticated
  using (public.has_scope_access(scope_id) and public.list_visible(id));
drop policy tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using (public.has_scope_access(scope_id) and public.list_visible(list_id));
drop policy task_dependencies_select on public.task_dependencies;
create policy task_dependencies_select on public.task_dependencies for select to authenticated
  using (public.has_scope_access(scope_id) and public.task_visible(predecessor_id) and public.task_visible(successor_id));
do $$
declare
  t text;
begin
  foreach t in array array['task_tags', 'task_completions', 'reminders', 'time_entries', 'attachments', 'task_participants', 'task_comments'] loop
    execute format('drop policy %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.has_scope_access(scope_id) and public.task_visible(task_id))', t || '_select', t);
  end loop;
end $$;
drop policy activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log for select to authenticated
  using (public.has_scope_access(scope_id) and (table_name <> 'tasks' or public.task_visible(row_id)));

create or replace function public.can_read_attachment(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.attachments a
     where a.storage_path = p_name and public.has_scope_access(a.scope_id) and public.task_visible(a.task_id));
$$;

create or replace function public.can_upload_attachment(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  parts text[] := string_to_array(p_name, '/');
  task uuid;
begin
  if auth.uid() is null or array_length(parts, 1) <> 3 or parts[1] <> auth.uid()::text or coalesce(parts[3], '') = '' then
    return false;
  end if;
  begin
    task := parts[2]::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  if (public.attachment_usage()->>'used')::bigint >= public.attachment_quota_bytes() then
    return false;
  end if;
  return exists (
    select 1 from public.tasks t
     where t.id = task and t.deleted_at is null and public.can_write_scope(t.scope_id) and public.list_access(t.list_id) = 'edit');
end $$;

-- ── Integracje: kalendarz Google pisze w imieniu właściciela kalendarza ──────────────────────

create or replace function public.calendar_task_apply(p_calendar uuid, p_task uuid, p_patch jsonb, p_link jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  owner uuid;
  hlc text := public.server_hlc();
  clock jsonb;
  cols text[];
  result jsonb;
begin
  select user_id into owner from public.calendars where id = p_calendar and is_task_target;
  if owner is null then
    raise exception using errcode = 'P0002', message = 'Brak kalendarza zadań';
  end if;
  select t.field_clock into clock from public.tasks t
   where t.id = p_task
     and exists (select 1 from public.scope_members m where m.scope_id = t.scope_id and m.user_id = owner and m.role in ('owner', 'editor'))
     and public.list_access(t.list_id, owner) = 'edit'
   for update;
  if clock is null then
    raise exception using errcode = 'TP003', message = 'Brak dostępu do zadania';
  end if;
  perform set_config('taskplanner.source', 'calendar', true);
  select array_agg(k) into cols from jsonb_object_keys(coalesce(p_patch, '{}')) k
   where k in ('title', 'due_date', 'due_time', 'duration_min')
     and hlc collate "C" > coalesce(clock ->> k, '') collate "C";
  if cols is not null then
    execute format(
      'update public.tasks set (%1$s, field_clock) = (select %1$s, $2 from jsonb_populate_record(null::public.tasks, $1)) where id = $3',
      (select string_agg(quote_ident(c), ', ') from unnest(cols) c))
    using p_patch, clock || (select jsonb_object_agg(c, hlc) from unnest(cols) c), p_task;
  end if;
  if p_link is null then
    delete from public.calendar_task_links where calendar_id = p_calendar and task_id = p_task;
  else
    insert into public.calendar_task_links (calendar_id, task_id, external_id, etag, pushed)
    values (p_calendar, p_task, p_link ->> 'external_id', p_link ->> 'etag', p_link -> 'pushed')
    on conflict (calendar_id, task_id) do update
       set external_id = excluded.external_id, etag = excluded.etag, pushed = excluded.pushed, updated_at = now();
  end if;
  perform set_config('taskplanner.source', '', true);
  select to_jsonb(r) into result from public.tasks r where r.id = p_task;
  return result;
end $$;

create or replace function public.create_integration_task(p_user uuid, p_task jsonb, p_tags jsonb default '[]') returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  tid uuid := coalesce((p_task ->> 'id')::uuid, gen_random_uuid());
  hlc text := public.server_hlc();
  cols text[];
  list_scope uuid;
  tg jsonb;
begin
  select l.scope_id into list_scope from public.lists l
   where l.id = (p_task ->> 'list_id')::uuid and l.deleted_at is null;
  if list_scope is null
     or not exists (select 1 from public.scope_members m where m.scope_id = list_scope and m.user_id = p_user and m.role in ('owner', 'editor'))
     or public.list_access((p_task ->> 'list_id')::uuid, p_user) is distinct from 'edit' then
    raise exception using errcode = 'TP003', message = 'Brak dostępu do listy';
  end if;
  select array_agg(k) into cols from jsonb_object_keys(p_task) k where k <> 'id';
  execute format(
    'insert into public.tasks (id, created_by, field_clock, %1$s) select $2, $3, $4, %1$s from jsonb_populate_record(null::public.tasks, $1)',
    (select string_agg(quote_ident(c), ', ') from unnest(cols) c))
  using p_task, tid, p_user, (select jsonb_object_agg(c, hlc) from unnest(cols) c);
  for tg in select value from jsonb_array_elements(coalesce(p_tags, '[]')) loop
    if exists (select 1 from public.tags where id = (tg ->> 'tagId')::uuid and scope_id = p_user and deleted_at is null) then
      insert into public.task_tags (id, task_id, tag_id, created_by, field_clock)
      values ((tg ->> 'id')::uuid, tid, (tg ->> 'tagId')::uuid, p_user, jsonb_build_object('task_id', hlc, 'tag_id', hlc))
      on conflict do nothing;
    end if;
  end loop;
  return tid;
end $$;

-- ── push_changes: bieżący wiersz odrzuconej zmiany tylko, gdy gość go widzi ──────────────────

create or replace function public.push_changes(p_ops jsonb) returns jsonb
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

  -- Wiersz z ukrytej listy wraca jako `null` — klient usuwa swoją kopię.
  for item in select distinct value from jsonb_array_elements(touched) loop
    execute format('select to_jsonb(r) from public.%I r where r.id = $1 and public.has_scope_access(r.scope_id)', item ->> 'table')
      into row_data using (item ->> 'id')::uuid;
    if row_data is not null and not public.row_visible(item ->> 'table', row_data) then
      row_data := null;
    end if;
    current_rows := current_rows || jsonb_build_array(item || jsonb_build_object('row', row_data));
  end loop;

  return jsonb_build_object(
    'applied', applied,
    'rejected', rejected,
    'clamped', clamped,
    'rows', current_rows,
    'serverHlc', public.server_hlc());
end $$;

-- ── pull_changes: bez ukrytych list, znaczniki `_gone`, `scopes[id].hidden` ──────────────────

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
       and coalesce(($1 ->> x.user_id::text)::bigint, 0) > 0$q$;

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
