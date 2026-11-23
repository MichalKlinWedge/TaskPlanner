-- Integracje wychodzące — system pluginów, etap I1: fundament + Webhook (SPECYFIKACJA M21, D21;
-- PLAN_ETAPOWY.md → v1.x „Integracje wychodzące”).
--
-- Kierunek: zdarzenie w Task Plannerze → akcja w systemie zewnętrznym. Wyzwalacz działa tylko na serwerze:
-- zmiana dociera przez `push_changes`, wyzwalacz zapisuje ją w `plugin_outbox` i po zatwierdzeniu transakcji
-- `pg_net` woła Edge Function `plugins/flush` (raz na transakcję); `pg_cron` co minutę woła `plugins/cron/tick`
-- (ponowienia, zgubione sygnały) — tylko gdy jest co robić.
--
--   * `plugin_connections` — połączenia użytkownika (Webhook…): konfiguracja bez sekretów, sekret w Vault.
--     Pisze tylko Edge Function `plugins`; klient dostaje je w `pull_changes` jako tabelę tylko do odczytu
--     (zakres osobisty, jak `calendar_accounts`). Usunięcie = `deleted_at` + usunięcie sekretu.
--   * `plugin_rules` — reguły „Gdy … → akcja przez połączenie” (synchronizowane, zakres osobisty).
--     I1: wyzwalacz ręczny (`{kind:'manual'}`); zdarzeniowy (I2) i czasowy (I4) mają już miejsce w `trigger`.
--   * `plugin_requests` — „Wyślij do…” (synchronizowane, zakres osobisty, tylko dopisywane): klient zapisuje
--     wiersz przez `mutate` (działa offline), wysyłka po synchronizacji.
--   * `plugin_outbox` — kolejka zdarzeń do przetworzenia (tylko serwer; I1: prośby ręczne, I2: zmiany zadań).
--   * `plugin_deliveries` — wysyłki z deterministycznym id (UUIDv5, = `Idempotency-Key`), stanem i ponowieniami;
--     klient czyta własne wiersze (online), „Ponów” przez `retry_plugin_delivery`. Retencja 30 dni.
--   * `plugin_runs` — dzierżawa przebiegu wysyłki (flush, cron i „Ponów” nie pracują równolegle).
--
-- Bez kluczy obcych między wierszami różnych zakresów (prośba → zadanie w przestrzeni innej osoby): usunięcie
-- konta właściciela przestrzeni nie może się zatrzymać na prośbie innego użytkownika (jak `task_tags` → `tags`
-- w `*_v1x_account_delete_shared.sql`). Kolumny `not null` tabel synchronizowanych bez wartości domyślnych —
-- tabele nie należą do kopii zapasowej (`BACKUP_TABLES`), a `backup.test.sql` pilnuje domyślnych.

-- ── Połączenia ───────────────────────────────────────────────────────────────────────────────

create table public.plugin_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plugin text not null check (plugin in ('webhook', 'slack', 'gitlab', 'jira', 'email')),
  label text not null check (length(btrim(label)) between 1 and 100),
  -- Konfiguracja bez sekretów (schemat pluginu, `core/plugins/catalog.ts`), np. adres webhooka.
  config jsonb not null default '{}' check (jsonb_typeof(config) = 'object'),
  secret_id uuid,
  status text not null default 'active' check (status in ('active', 'disabled', 'error')),
  last_error text,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  row_version bigint not null default 0
);
create index plugin_connections_user on public.plugin_connections (user_id, row_version);
create trigger z_stamp before insert or update on public.plugin_connections for each row execute function public.stamp_integration_row();
-- Usunięcie konta (kaskada z `auth.users`) zabiera też sekret z Vault.
create trigger drop_secret after delete on public.plugin_connections for each row execute function public.drop_account_secret();

-- ── Reguły i prośby (tabele synchronizowane, zakres osobisty) ────────────────────────────────

create table public.plugin_rules (
  id uuid primary key,
  name text not null check (length(btrim(name)) between 1 and 100),
  connection_id uuid not null,
  enabled boolean not null,
  -- `PluginTrigger` z `core/plugins/rules.ts`: {kind:'manual'} / {kind:'event', events, filter?} / {kind:'schedule', …}.
  trigger jsonb not null check (jsonb_typeof(trigger) = 'object' and trigger ->> 'kind' in ('manual', 'event', 'schedule')),
  -- Akcja według `actionSchema` pluginu (szablony `{{…}}`).
  action jsonb not null check (jsonb_typeof(action) = 'object'),
  -- `PluginRuleOptions`: opóźnienie, zadania z integracji.
  options jsonb not null check (jsonb_typeof(options) = 'object'),
  sort_key text not null check (sort_key ~ '^[0-9a-z]+$')
);
create index plugin_rules_connection on public.plugin_rules (connection_id);

create table public.plugin_requests (
  id uuid primary key,
  rule_id uuid not null,
  task_id uuid not null,
  -- Chwila kliknięcia na urządzeniu (także offline).
  requested_at timestamptz not null
);
create index plugin_requests_task on public.plugin_requests (task_id);

-- Kolejność = kolejność stosowania u klienta (rodzice przed dziećmi; lokalnie bez kluczy obcych).
create or replace function public.synced_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array['workspaces', 'lists', 'tasks', 'tags', 'task_tags', 'task_completions', 'profiles', 'devices',
               'reminders', 'task_dependencies', 'time_entries', 'attachments', 'saved_filters', 'review_sessions',
               'collaborators', 'task_participants', 'task_comments', 'plugin_rules', 'plugin_requests']
$$;

do $$
declare
  t text;
begin
  foreach t in array array['plugin_rules', 'plugin_requests'] loop
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
    execute format('create trigger a_derive before insert or update on public.%I for each row execute function public.derive_personal()', t);
  end loop;
end $$;

-- Pola, które klient może ustawić: `scope_id` reguł i próśb jak innych wierszy osobistych.
create or replace function public.writable_columns(p_table text) returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(column_name::text order by ordinal_position), '{}')
    from information_schema.columns
   where table_schema = 'public' and table_name = p_table
     and column_name not in ('id', 'created_at', 'updated_at', 'created_by', 'row_version', 'field_clock')
     and (column_name <> 'scope_id'
          or p_table in ('lists', 'tags', 'devices', 'saved_filters', 'review_sessions', 'collaborators', 'plugin_rules', 'plugin_requests'));
$$;

-- Reguła: połączenie zalogowanego (nieusunięte) — przy wstawieniu i zmianie połączenia.
create function public.check_plugin_rule() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null
     and (tg_op = 'INSERT' or new.connection_id is distinct from old.connection_id)
     and not exists (select 1 from public.plugin_connections c
                      where c.id = new.connection_id and c.user_id = auth.uid() and c.deleted_at is null) then
    raise exception using errcode = 'TP003', message = 'Brak dostępu do połączenia';
  end if;
  return new;
end $$;
create trigger b_check before insert or update on public.plugin_rules for each row execute function public.check_plugin_rule();

-- Prośba: reguła z tego samego zakresu osobistego i zadanie, które zalogowany widzi; potem się nie zmienia.
create function public.check_plugin_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.rule_id, new.task_id, new.requested_at) is distinct from (old.rule_id, old.task_id, old.requested_at) then
    raise exception using errcode = 'TP003', message = 'Prośby o wysyłkę nie można zmienić';
  end if;
  if tg_op = 'INSERT' and auth.uid() is not null then
    if not exists (select 1 from public.plugin_rules r where r.id = new.rule_id and r.scope_id = new.scope_id and r.deleted_at is null) then
      raise exception using errcode = 'TP003', message = 'Brak reguły';
    end if;
    if not exists (select 1 from public.tasks t
                    where t.id = new.task_id and public.has_scope_access(t.scope_id) and public.list_visible(t.list_id)) then
      raise exception using errcode = 'TP003', message = 'Brak dostępu do zadania';
    end if;
  end if;
  return new;
end $$;
create trigger b_check before insert or update on public.plugin_requests for each row execute function public.check_plugin_request();

-- ── Kolejka zdarzeń, wysyłki, dzierżawa (tylko serwer) ───────────────────────────────────────

create table public.plugin_outbox (
  id bigint generated always as identity primary key,
  scope_id uuid not null,
  table_name text not null,
  row_id uuid not null,
  task_id uuid,
  -- Rzut wiersza przed i po zmianie (I1: tylko `after` prośby).
  before jsonb,
  after jsonb,
  -- Zmiana z integracji (`taskplanner.source`) — reguły domyślnie ją pomijają (pętle e-mail / kalendarz).
  origin text not null default 'client' check (origin in ('client', 'integration')),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index plugin_outbox_pending on public.plugin_outbox (id) where processed_at is null;

create table public.plugin_deliveries (
  -- UUIDv5 z reguły, zadania i zdarzenia / prośby — ta sama wysyłka zawsze ma ten sam id (`Idempotency-Key`).
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  rule_id uuid,
  connection_id uuid,
  task_id uuid,
  source text not null check (source in ('manual', 'event', 'schedule')),
  events text[] not null default '{}',
  -- Wysłany ładunek (obcięty), do historii.
  payload jsonb,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'skipped', 'failed', 'dead')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  external_id text,
  external_url text,
  http_status integer,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index plugin_deliveries_due on public.plugin_deliveries (next_attempt_at) where status in ('pending', 'sending');
create index plugin_deliveries_user on public.plugin_deliveries (user_id, created_at desc);
create index plugin_deliveries_sent on public.plugin_deliveries (connection_id, sent_at) where status = 'sent';

-- Dzierżawa przebiegu (`name` = 'deliver'); kto jej nie dostał, ustawia `rerun` — posiadacz powtórzy przebieg.
create table public.plugin_runs (
  name text primary key,
  holder text,
  expires_at timestamptz,
  rerun boolean not null default false
);

alter table public.plugin_connections enable row level security;
alter table public.plugin_outbox enable row level security;
alter table public.plugin_deliveries enable row level security;
alter table public.plugin_runs enable row level security;
revoke all on public.plugin_connections, public.plugin_outbox, public.plugin_deliveries, public.plugin_runs from anon, authenticated;
grant all on public.plugin_connections, public.plugin_outbox, public.plugin_deliveries, public.plugin_runs to service_role;
-- Klient widzi swoje połączenia bez identyfikatora sekretu i swoje wysyłki.
create policy own on public.plugin_connections for select to authenticated using (user_id = auth.uid());
grant select (id, user_id, plugin, label, config, status, last_error, last_used_at, created_at, updated_at, deleted_at, row_version)
  on public.plugin_connections to authenticated;
create policy own on public.plugin_deliveries for select to authenticated using (user_id = auth.uid());
grant select on public.plugin_deliveries to authenticated;

-- ── Sygnał do wysyłki ────────────────────────────────────────────────────────────────────────

-- Raz na transakcję: paczka operacji z `push_changes` to jedno wywołanie funkcji (po zatwierdzeniu — `pg_net`).
create function public.plugin_kick() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('taskplanner.plugins_kicked', true), '') = '1' then
    return;
  end if;
  perform set_config('taskplanner.plugins_kicked', '1', true);
  perform public.call_edge_function('plugins/flush');
end $$;

create function public.plugin_request_queued() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.plugin_outbox (scope_id, table_name, row_id, task_id, after, origin)
  values (new.scope_id, tg_table_name, new.id, new.task_id, to_jsonb(new),
          case when coalesce(current_setting('taskplanner.source', true), '') <> '' then 'integration' else 'client' end);
  perform public.plugin_kick();
  return null;
end $$;
create trigger plugin_outbox after insert on public.plugin_requests for each row execute function public.plugin_request_queued();

-- ── Funkcje Edge Function `plugins` (service_role) ───────────────────────────────────────────

create function public.plugin_lock(p_name text, p_holder text, p_ttl_seconds int default 120) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  got text;
begin
  insert into public.plugin_runs as r (name, holder, expires_at)
  values (p_name, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
     set holder = excluded.holder, expires_at = excluded.expires_at, rerun = false
   where r.holder is null or r.expires_at < now()
  returning holder into got;
  if got is null then
    update public.plugin_runs set rerun = true where name = p_name;
    return false;
  end if;
  return true;
end $$;

-- Oddanie dzierżawy. `true` = w międzyczasie ktoś prosił o przebieg: dzierżawa zostaje, powtórz.
create function public.plugin_unlock(p_name text, p_holder text, p_ttl_seconds int default 120) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  again boolean;
begin
  select rerun into again from public.plugin_runs where name = p_name and holder = p_holder for update;
  if again is null then
    return false;
  end if;
  update public.plugin_runs
     set rerun = false,
         holder = case when again then holder end,
         expires_at = case when again then now() + make_interval(secs => p_ttl_seconds) end
   where name = p_name;
  return again;
end $$;

create function public.plugin_secret_set(p_connection uuid, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
begin
  select secret_id into sid from public.plugin_connections where id = p_connection and deleted_at is null for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Brak połączenia';
  end if;
  if sid is null then
    sid := vault.create_secret(p_secret, 'plugin_connection:' || p_connection, 'Sekret połączenia pluginu (M21)');
    update public.plugin_connections set secret_id = sid where id = p_connection;
  else
    perform vault.update_secret(sid, p_secret);
  end if;
end $$;

create function public.plugin_secret_get(p_connection uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret
    from public.plugin_connections c
    join vault.decrypted_secrets s on s.id = c.secret_id
   where c.id = p_connection and c.deleted_at is null;
$$;

-- Usunięcie połączenia: sekret znika z Vault, wiersz zostaje z `deleted_at` (historia wysyłek ma etykietę,
-- klienci usuwają swoją kopię po `pull_changes`).
create function public.plugin_connection_remove(p_connection uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
begin
  select secret_id into sid from public.plugin_connections where id = p_connection for update;
  if sid is not null then
    delete from vault.secrets where id = sid;
  end if;
  update public.plugin_connections
     set secret_id = null, status = 'disabled', deleted_at = coalesce(deleted_at, now())
   where id = p_connection;
end $$;

-- Należne wysyłki (pod dzierżawą `plugin_runs`): wysyłki przerwane w połowie (limit czasu funkcji) wracają
-- po 5 minutach — „co najmniej raz”; najwyżej `p_per_minute` wysłanych na połączenie w ostatniej minucie
-- (nadmiar czeka do następnego przebiegu).
create function public.claim_plugin_deliveries(p_limit int default 50, p_per_minute int default 60)
returns setof public.plugin_deliveries
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.plugin_deliveries set status = 'pending', updated_at = now()
   where status = 'sending' and updated_at < now() - interval '5 minutes';
  return query
  with recent as (
    select d.connection_id, count(*) as n
      from public.plugin_deliveries d
     where d.status = 'sent' and d.sent_at > now() - interval '1 minute'
     group by d.connection_id),
  ranked as (
    select d.id, d.next_attempt_at,
           row_number() over (partition by d.connection_id order by d.next_attempt_at, d.id) + coalesce(x.n, 0) as place
      from public.plugin_deliveries d
      left join recent x on x.connection_id is not distinct from d.connection_id
     where d.status = 'pending' and d.next_attempt_at <= now()),
  chosen as (
    select r.id from ranked r where r.place <= p_per_minute order by r.next_attempt_at, r.id limit p_limit)
  update public.plugin_deliveries d
     set status = 'sending', attempts = d.attempts + 1, updated_at = now()
    from chosen c
   where d.id = c.id
  returning d.*;
end $$;

-- Rzut zadania do ładunku (`PluginTaskData` w `core/plugins/payload.ts`) albo `null`, gdy właściciel reguły
-- nie ma już dostępu (nie jest członkiem przestrzeni albo lista jest przed nim ukryta).
create function public.plugin_task_context(p_task uuid, p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
           'id', t.id, 'title', t.title, 'description', t.description_md, 'status', t.status, 'priority', t.priority,
           'startDate', t.start_date, 'dueDate', t.due_date, 'dueTime', t.due_time, 'durationMin', t.duration_min,
           'completedAt', t.completed_at, 'deletedAt', t.deleted_at, 'createdAt', t.created_at,
           'listId', t.list_id, 'list', l.name, 'listKind', l.kind, 'workspaceId', t.scope_id, 'workspace', w.name,
           'tags', coalesce((
             select jsonb_agg(g.name order by tt.sort_key nulls last, tt.created_at)
               from public.task_tags tt join public.tags g on g.id = tt.tag_id
              where tt.task_id = t.id and tt.deleted_at is null and g.deleted_at is null), '[]'),
           'assignee', (select c.name from public.collaborators c where c.id = t.assignee_id),
           'fromIntegration', t.source is not null and t.source ->> 'kind' in ('email', 'calendar'))
    from public.tasks t
    join public.lists l on l.id = t.list_id
    left join public.workspaces w on w.id = t.scope_id
   where t.id = p_task
     and exists (select 1 from public.scope_members m where m.scope_id = t.scope_id and m.user_id = p_user)
     and public.list_access(t.list_id, p_user) is distinct from 'hidden';
$$;

-- ── „Ponów” (klient) ─────────────────────────────────────────────────────────────────────────

create function public.retry_plugin_delivery(p_delivery uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Wymagane logowanie';
  end if;
  update public.plugin_deliveries
     set status = 'pending', attempts = 0, next_attempt_at = now(), error = null, http_status = null, updated_at = now()
   where id = p_delivery and user_id = auth.uid() and status in ('failed', 'dead', 'skipped');
  if not found then
    raise exception using errcode = 'P0002', message = 'Tej wysyłki nie można ponowić';
  end if;
  perform public.plugin_kick();
end $$;

-- ── pg_cron ──────────────────────────────────────────────────────────────────────────────────

-- Co minutę, ale funkcja dostaje wywołanie tylko wtedy, gdy jest co robić (limit wywołań Edge Functions na Free).
create function public.plugins_tick() returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.plugin_outbox where processed_at is null)
     or exists (select 1 from public.plugin_deliveries
                 where (status = 'pending' and next_attempt_at <= now())
                    or (status = 'sending' and updated_at < now() - interval '5 minutes')) then
    return public.call_edge_function('plugins/cron/tick');
  end if;
  return null;
end $$;

select cron.schedule('taskplanner-plugins-tick', '* * * * *', $$select public.plugins_tick()$$);
select cron.schedule('taskplanner-plugins-retention', '37 3 * * *', $$
  delete from public.plugin_deliveries where created_at < now() - interval '30 days' and status not in ('pending', 'sending');
  delete from public.plugin_outbox where processed_at < now() - interval '1 day';
$$);

revoke execute on function
  public.check_plugin_rule(), public.check_plugin_request(), public.plugin_kick(), public.plugin_request_queued(),
  public.plugin_lock(text, text, int), public.plugin_unlock(text, text, int),
  public.plugin_secret_set(uuid, text), public.plugin_secret_get(uuid), public.plugin_connection_remove(uuid),
  public.claim_plugin_deliveries(int, int), public.plugin_task_context(uuid, uuid), public.plugins_tick(),
  public.retry_plugin_delivery(uuid)
  from public, anon, authenticated;
grant execute on function
  public.plugin_lock(text, text, int), public.plugin_unlock(text, text, int),
  public.plugin_secret_set(uuid, text), public.plugin_secret_get(uuid), public.plugin_connection_remove(uuid),
  public.claim_plugin_deliveries(int, int), public.plugin_task_context(uuid, uuid)
  to service_role;
grant execute on function public.retry_plugin_delivery(uuid) to authenticated;

-- ── Odczyt: połączenia jako tabela tylko do odczytu ──────────────────────────────────────────

create or replace function public.pulled_readonly_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array['calendar_accounts', 'calendars', 'calendar_events', 'scope_collaborators', 'scope_tags', 'plugin_connections']
$$;

-- `pull_changes` jak w `*_v1x_scope_tags.sql`, z połączeniami pluginów (bez `secret_id`; usunięte tylko przyrostowo).

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
       and (coalesce(($1 ->> r.user_id::text)::bigint, 0) > 0 or r.deleted_at is null)$q$;

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

