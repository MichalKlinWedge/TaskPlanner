-- Automatyczne przypomnienie osoby odpowiedzialnej (v1.x). Przypomnienia (`reminders`) każdy ustawia sobie
-- sam; w udostępnionej przestrzeni odpowiedzialny dostaje dodatkowo przypomnienie w chwili terminu zadania
-- z datą i godziną (bez wiersza `reminders` — liczą je telefon i `reminders-push`).
--
--   * Odpowiedzialny to współpracownik (wpis w książce adresowej), nie konto: konto = członek przestrzeni
--     z tym samym e-mailem. `scope_collaborators.user_id` trzyma je przy kopii osoby w przestrzeni (e-mail
--     dalej nie trafia do członków); odświeżane przy zmianie osoby, składu przestrzeni i e-maila konta.
--   * Bez wskazanej osoby odpowiada twórca zadania (`created_by`).
--   * `assignee_reminder_tasks` — zadania do takich przypomnień dla `reminders-push`: tylko udostępnione
--     przestrzenie (więcej niż jeden członek), tylko członek, bez list ukrytych przed gościem.

alter table public.scope_collaborators add column user_id uuid;

-- Konto osoby w przestrzeni: członek z e-mailem współpracownika; `null` — brak.
create function public.collaborator_account(p_scope uuid, p_collaborator uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.user_id
    from public.collaborators c
    join auth.users u on lower(u.email) = lower(btrim(c.email))
    join public.scope_members m on m.user_id = u.id and m.scope_id = p_scope
   where c.id = p_collaborator and c.deleted_at is null
   limit 1
$$;

-- Jak w `*_v1x_scope_collaborators.sql`, z kontem osoby.
create or replace function public.mirror_collaborator(p_scope uuid, p_collaborator uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_scope is null or p_collaborator is null
     or not exists (select 1 from public.sync_scopes s where s.id = p_scope and s.kind = 'workspace') then
    return;
  end if;
  insert into public.scope_collaborators as sc (id, scope_id, collaborator_id, name, acronym, archived_at, deleted_at, user_id)
  select md5(p_scope::text || ':' || c.id::text)::uuid, p_scope, c.id, c.name, c.acronym, c.archived_at, c.deleted_at,
         public.collaborator_account(p_scope, c.id)
    from public.collaborators c
   where c.id = p_collaborator
  on conflict (scope_id, collaborator_id) do update
     set name = excluded.name, acronym = excluded.acronym, archived_at = excluded.archived_at, deleted_at = excluded.deleted_at,
         user_id = excluded.user_id
   where (sc.name, sc.acronym, sc.archived_at, sc.deleted_at, sc.user_id)
         is distinct from (excluded.name, excluded.acronym, excluded.archived_at, excluded.deleted_at, excluded.user_id);
end $$;

-- Jak w `*_v1x_scope_collaborators_spaces.sql`, z odświeżeniem konta po zmianie e-maila albo przywróceniu.
create or replace function public.mirror_collaborator_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
     and (new.name, new.acronym, new.archived_at, new.deleted_at, new.email)
         is distinct from (old.name, old.acronym, old.archived_at, old.deleted_at, old.email) then
    update public.scope_collaborators sc
       set name = new.name, acronym = new.acronym, archived_at = new.archived_at, deleted_at = new.deleted_at,
           user_id = public.collaborator_account(sc.scope_id, sc.collaborator_id)
     where sc.collaborator_id = new.id
       and (sc.name, sc.acronym, sc.archived_at, sc.deleted_at, sc.user_id)
           is distinct from (new.name, new.acronym, new.archived_at, new.deleted_at, public.collaborator_account(sc.scope_id, sc.collaborator_id));
  end if;
  if tg_op = 'INSERT' or new.workspace_ids is distinct from old.workspace_ids
     or (new.deleted_at is null and old.deleted_at is not null) then
    perform public.sync_collaborator_spaces(new.id);
  end if;
  return null;
end $$;

-- Konta wszystkich kopii w przestrzeni (zmiana składu albo e-maila). Zakres usuwany kaskadą — pomijany.
create function public.refresh_scope_accounts(p_scope uuid) returns void
language sql security definer set search_path = '' as $$
  update public.scope_collaborators sc
     set user_id = public.collaborator_account(sc.scope_id, sc.collaborator_id)
   where sc.scope_id = p_scope
     and sc.deleted_at is null
     and sc.user_id is distinct from public.collaborator_account(sc.scope_id, sc.collaborator_id)
     and exists (select 1 from public.sync_scopes s where s.id = p_scope)
$$;

create function public.scope_members_accounts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_scope_accounts(case when tg_op = 'DELETE' then old.scope_id else new.scope_id end);
  return null;
end $$;
create trigger z_accounts after insert or delete on public.scope_members
  for each row execute function public.scope_members_accounts();

create function public.user_email_accounts() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_scope uuid;
begin
  if new.email is distinct from old.email then
    for v_scope in select m.scope_id from public.scope_members m where m.user_id = new.id order by m.scope_id loop
      perform public.refresh_scope_accounts(v_scope);
    end loop;
  end if;
  return null;
end $$;
create trigger z_accounts after update of email on auth.users
  for each row execute function public.user_email_accounts();

-- Zadania z automatycznym przypomnieniem dla podanych kont; seria (`recurrence`) także z dawnym terminem —
-- kolejne wystąpienia liczy core. Dni z zapasem na strefy podaje wywołujący.
create function public.assignee_reminder_tasks(p_users uuid[], p_from date, p_to date)
returns table (user_id uuid, id uuid, kind text, status text, title text, due_date date, due_time text, recurrence jsonb, time_zone text)
language sql stable security definer set search_path = '' as $$
  select r.user_id, t.id, t.kind::text, t.status::text, t.title, t.due_date, t.due_time, t.recurrence, t.time_zone
    from public.tasks t
    join public.sync_scopes s on s.id = t.scope_id and s.kind = 'workspace'
    join public.lists l on l.id = t.list_id and l.deleted_at is null and l.archived_at is null
    cross join lateral (
      select case when t.assignee_id is null then t.created_by
                  else (select sc.user_id from public.scope_collaborators sc
                         where sc.scope_id = t.scope_id and sc.collaborator_id = t.assignee_id and sc.deleted_at is null)
             end as user_id) r
    join public.scope_members m on m.scope_id = t.scope_id and m.user_id = r.user_id
   where r.user_id = any(p_users)
     and t.deleted_at is null
     and t.kind::text = 'task'
     and t.status::text not in ('done', 'cancelled')
     and t.due_time is not null
     and t.due_date <= p_to
     and (t.due_date >= p_from or t.recurrence is not null)
     and (m.role = 'owner' or l.guest_access <> 'hidden')
     and exists (select 1 from public.scope_members o where o.scope_id = t.scope_id and o.user_id <> r.user_id)
   order by t.due_date desc, t.id
$$;

revoke execute on function public.collaborator_account(uuid, uuid), public.refresh_scope_accounts(uuid), public.scope_members_accounts(),
  public.user_email_accounts(), public.assignee_reminder_tasks(uuid[], date, date) from anon, authenticated, public;
grant execute on function public.assignee_reminder_tasks(uuid[], date, date) to service_role;

-- Konta dla istniejących kopii.
update public.scope_collaborators sc
   set user_id = public.collaborator_account(sc.scope_id, sc.collaborator_id)
 where sc.deleted_at is null and public.collaborator_account(sc.scope_id, sc.collaborator_id) is not null;

-- ── pull_changes: jak w `*_v1x_task_purge.sql`, z `scope_collaborators.user_id` ───────────────

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
                              'acronym', r.acronym, 'user_id', r.user_id, 'archived_at', r.archived_at, 'created_at', r.created_at,
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
