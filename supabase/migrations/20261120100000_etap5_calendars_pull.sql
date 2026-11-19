-- Etap 5: kalendarze zewnętrzne w lokalnej bazie klientów (SPECYFIKACJA M11, M18).
--
-- `calendar_accounts`, `calendars` i `calendar_events` przychodzą w `pull_changes` jako tabele tylko do
-- odczytu w zakresie osobistym (`scope_id` = `user_id`; ich `row_version` już podbija licznik zakresu
-- osobistego — `stamp_integration_row`). Bez sekretów i stanu synchronizacji (tokeny kanałów,
-- `syncToken`, `etag`). Zapis nadal tylko `service_role` (Edge Function `calendar-sync`).
--
-- Konta i kalendarze usuwa się naprawdę (odłączenie konta: kaskada + Vault), więc klient dostaje
-- nagrobek (`integration_tombstones`) z nową wersją zakresu; wydarzenia usuniętego kalendarza klient
-- sprząta sam. Wydarzenia mają `deleted_at` (synchronizacja przyrostowa), a stare (poza oknem −30 dni)
-- usuwa `cron/renew` — klient też je odrzuca po dacie.

create table public.integration_tombstones (
  tbl text not null check (tbl in ('calendar_accounts', 'calendars')),
  id uuid not null,
  -- Bez klucza obcego: usunięcie użytkownika usuwa konta kaskadą (nagrobek wtedy nie powstaje).
  user_id uuid not null,
  row_version bigint not null,
  deleted_at timestamptz not null default now(),
  primary key (tbl, id)
);
create index integration_tombstones_user on public.integration_tombstones (user_id, row_version);
alter table public.integration_tombstones enable row level security;
revoke all on public.integration_tombstones from anon, authenticated;
grant select, delete on public.integration_tombstones to service_role;

create function public.tombstone_integration_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v bigint;
begin
  update public.sync_scopes set sync_version = sync_version + 1 where id = old.user_id returning sync_version into v;
  -- Zakres już usunięty (kaskada z `auth.users`) — nikt nie potrzebuje nagrobka.
  if v is not null then
    insert into public.integration_tombstones (tbl, id, user_id, row_version)
    values (tg_table_name, old.id, old.user_id, v)
    on conflict (tbl, id) do update set row_version = excluded.row_version, deleted_at = now();
  end if;
  return old;
end $$;
create trigger tombstone after delete on public.calendar_accounts for each row execute function public.tombstone_integration_row();
create trigger tombstone after delete on public.calendars for each row execute function public.tombstone_integration_row();

-- Tabele tylko do odczytu w `pull_changes` (kolejność: rodzice przed dziećmi).
create function public.pulled_readonly_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array['calendar_accounts', 'calendars', 'calendar_events']
$$;

create or replace function public.pull_changes(p_since jsonb default '{}', p_limit integer default 1000) returns jsonb
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
    into page using since, lim;
  more := page.more;
  foreach t in array public.synced_tables() || public.pulled_readonly_tables() loop
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
