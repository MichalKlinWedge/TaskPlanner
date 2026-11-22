-- Tagi widoczne w przestrzeni (v1.x): tag należy do zakresu osobistego osoby, która go dodała, więc
-- pozostali członkowie udostępnionej przestrzeni dostawali samo `task_tags.tag_id` bez tagu (zadanie
-- bez bąbelka), a gość z edycją nie mógł ani przypiąć tego tagu, ani go zdjąć (TP003).
--
--   * `scope_tags` — kopia (nazwa, kolor) tagu użytego w przestrzeni (`task_tags`) albo wskazanego
--     wprost w „Widoczny w” tagu (`tags.workspace_ids`, tylko przestrzenie, do których należy autor).
--     Pisana tylko przez wyzwalacze; wiersz w zakresie przestrzeni, więc przychodzi każdemu członkowi
--     w `pull_changes` jak tabele tylko do odczytu. Usunięty tag = kopia z `deleted_at`; przestrzeń
--     zdjęta z listy — kopia z `deleted_at`, chyba że tag jest tam nadal na zadaniu.
--   * Tag z kopii w przestrzeni zadania można przypiąć (`can_use_tag`); zdjęcie tagu z zadania
--     i przeniesienie zadania (kaskada `scope_id`) nie sprawdzają już właściciela tagu — wystarcza
--     prawo zapisu do zakresu (`stamp_row`).
--
-- Jak `*_v1x_scope_collaborators*.sql`. Tylko przestrzenie (`sync_scopes.kind = 'workspace'`).

create table public.scope_tags (
  id uuid primary key,
  scope_id uuid not null references public.sync_scopes (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  name text not null,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  row_version bigint not null default 0,
  unique (scope_id, tag_id)
);
create index scope_tags_sync on public.scope_tags (scope_id, row_version);
create index scope_tags_tag on public.scope_tags (tag_id);

alter table public.scope_tags enable row level security;
create policy scope_tags_select on public.scope_tags for select to authenticated using (public.has_scope_access(scope_id));
revoke all on public.scope_tags from anon;
revoke insert, update, delete, truncate on public.scope_tags from authenticated;
grant select on public.scope_tags to authenticated;
grant all on public.scope_tags to service_role;

-- Wersja wiersza z licznika zakresu (piszą tylko wyzwalacze).
create function public.stamp_scope_tag() returns trigger
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
create trigger z_stamp before insert or update on public.scope_tags for each row execute function public.stamp_scope_tag();

-- Kopia tagu w przestrzeni: nowa albo odświeżona (bez zmian — bez nowej wersji).
create function public.mirror_tag(p_scope uuid, p_tag uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_scope is null or p_tag is null
     or not exists (select 1 from public.sync_scopes s where s.id = p_scope and s.kind = 'workspace') then
    return;
  end if;
  insert into public.scope_tags as st (id, scope_id, tag_id, name, color, deleted_at)
  select md5(p_scope::text || ':tag:' || g.id::text)::uuid, p_scope, g.id, g.name, g.color, g.deleted_at
    from public.tags g
   where g.id = p_tag
  on conflict (scope_id, tag_id) do update
     set name = excluded.name, color = excluded.color, deleted_at = excluded.deleted_at
   where (st.name, st.color, st.deleted_at) is distinct from (excluded.name, excluded.color, excluded.deleted_at);
end $$;

-- Tag na zadaniu przestrzeni (nieusunięte przypięcie).
create function public.tag_used_in(p_scope uuid, p_tag uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.task_tags tt where tt.scope_id = p_scope and tt.tag_id = p_tag and tt.deleted_at is null);
$$;

-- Kopie wg `workspace_ids`: dodane w przestrzeniach z listy, zdjęte z pozostałych (gdy nieużywane).
create function public.sync_tag_spaces(p_tag uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  g public.tags;
  w uuid;
begin
  select * into g from public.tags where id = p_tag;
  if g.id is null then
    return;
  end if;
  if g.deleted_at is null and jsonb_typeof(g.workspace_ids) = 'array' then
    for w in
      select x::uuid from jsonb_array_elements_text(g.workspace_ids) x
       where exists (select 1 from public.scope_members m where m.scope_id = x::uuid and m.user_id = g.scope_id)
    loop
      perform public.mirror_tag(w, g.id);
    end loop;
  end if;
  update public.scope_tags st
     set deleted_at = now()
   where st.tag_id = g.id
     and st.deleted_at is null
     and not coalesce(jsonb_typeof(g.workspace_ids) = 'array' and g.workspace_ids ? st.scope_id::text, false)
     and not public.tag_used_in(st.scope_id, g.id);
end $$;

create function public.mirror_task_tag() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is null
     and (tg_op = 'INSERT' or new.tag_id is distinct from old.tag_id
          or new.scope_id is distinct from old.scope_id or old.deleted_at is not null) then
    perform public.mirror_tag(new.scope_id, new.tag_id);
  end if;
  return null;
end $$;
create trigger z_mirror after insert or update on public.task_tags for each row execute function public.mirror_task_tag();

-- Zmiana nazwy, koloru albo usunięcie tagu — we wszystkich kopiach; potem przestrzenie z `workspace_ids`.
create function public.mirror_tag_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.name, new.color, new.deleted_at) is distinct from (old.name, old.color, old.deleted_at) then
    update public.scope_tags st
       set name = new.name, color = new.color, deleted_at = new.deleted_at
     where st.tag_id = new.id;
  end if;
  if tg_op = 'INSERT' or new.workspace_ids is distinct from old.workspace_ids
     or (new.deleted_at is null and old.deleted_at is not null) then
    perform public.sync_tag_spaces(new.id);
  end if;
  return null;
end $$;
create trigger z_mirror after insert or update on public.tags for each row execute function public.mirror_tag_change();

revoke execute on function public.stamp_scope_tag(), public.mirror_tag(uuid, uuid), public.tag_used_in(uuid, uuid),
  public.sync_tag_spaces(uuid), public.mirror_task_tag(), public.mirror_tag_change() from anon, authenticated, public;

-- ── Przypięcie tagu z kopii w przestrzeni ────────────────────────────────────────────────────

-- Tag, który zalogowany może przypiąć w zakresie: własny (z zakresu, do którego pisze) albo z kopii w tej przestrzeni.
create function public.can_use_tag(p_tag uuid, p_scope uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tags g where g.id = p_tag and public.can_write_scope(g.scope_id))
      or exists (select 1 from public.scope_tags st
                  where st.tag_id = p_tag and st.scope_id = p_scope and st.deleted_at is null
                    and public.can_write_scope(p_scope));
$$;
revoke execute on function public.can_use_tag(uuid, uuid) from anon, public;

-- Sprawdzenie tylko przy przypięciu (nowe, inny tag, przywrócenie) — zdjęcie tagu i kaskada `scope_id`
-- po przeniesieniu zadania nie zależą od właściciela tagu.
create or replace function public.derive_task_tag() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select scope_id into new.scope_id from public.tasks where id = new.task_id;
  if new.scope_id is null then
    raise exception using errcode = '23503', message = 'Brak zadania';
  end if;
  if auth.uid() is not null and new.deleted_at is null
     and (tg_op = 'INSERT' or new.tag_id is distinct from old.tag_id or old.deleted_at is not null)
     and not public.can_use_tag(new.tag_id, new.scope_id) then
    raise exception using errcode = 'TP003', message = 'Brak dostępu do tagu';
  end if;
  return new;
end $$;

-- ── Kopie dla już użytych i przypisanych tagów ───────────────────────────────────────────────

do $$
declare
  r record;
begin
  for r in select distinct tt.scope_id, tt.tag_id from public.task_tags tt where tt.deleted_at is null loop
    perform public.mirror_tag(r.scope_id, r.tag_id);
  end loop;
  for r in select id from public.tags where deleted_at is null and jsonb_typeof(workspace_ids) = 'array' loop
    perform public.sync_tag_spaces(r.id);
  end loop;
end $$;

-- ── Odczyt ───────────────────────────────────────────────────────────────────────────────────

create or replace function public.pulled_readonly_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array['calendar_accounts', 'calendars', 'calendar_events', 'scope_collaborators', 'scope_tags']
$$;

-- `pull_changes` jak w `*_v1x_scope_collaborators.sql`, z kopiami tagów przestrzeni.

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
