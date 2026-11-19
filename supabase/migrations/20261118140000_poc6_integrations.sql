-- PoC-6: integracje serwerowe (SPECYFIKACJA §5 „Tabele — integracje”, M18, M19, M8 web).
--
-- Kalendarze zewnętrzne (Google, ICS), dziennik maili przychodzących, subskrypcje Web Push i kolejka
-- powiadomień. Tabele integracji pisze tylko `service_role` (Edge Functions); klient czyta swoje wiersze
-- (RLS), bez kolumn z sekretami i stanem synchronizacji. Tokeny OAuth i adresy ICS leżą w Supabase Vault.
-- Każda zmiana podbija licznik zakresu osobistego (`sync_scopes`), więc klient dostaje sygnał Realtime
-- (te tabele dojdą do `pull_changes` jako tylko do odczytu w Etapie 5).
--
-- Tymczasowe na PoC (w MVP-1 przechodzą do `profiles` / `devices`): `inbound_addresses`
-- (`profiles.inbox_token`, `inbound_senders`) i `push_subscriptions` (`devices.push_subscription`).
-- `push_queue` zastąpi w MVP-4 wyliczanie przypomnień (`core/reminders.ts`) z dziennikiem wysyłek.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ── Wspólne: znacznik wersji w zakresie osobistym ────────────────────────────────────────────

create function public.stamp_integration_row() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.sync_scopes set sync_version = sync_version + 1 where id = new.user_id
  returning sync_version into new.row_version;
  if new.row_version is null then
    raise exception using errcode = 'TP004', message = 'Brak zakresu osobistego ' || coalesce(new.user_id::text, 'null');
  end if;
  new.updated_at := now();
  return new;
end $$;

-- ── Kalendarze ───────────────────────────────────────────────────────────────────────────────

create table public.calendar_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('google', 'ics')),
  label text not null check (length(btrim(label)) between 1 and 200),
  -- Google: adres konta; ICS: skrót adresu (sam adres jest sekretem). Pozwala połączyć to samo konto ponownie.
  external_id text not null,
  secret_id uuid,
  sync_state jsonb not null default '{}',
  status text not null default 'active' check (status in ('active', 'error', 'revoked')),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 0,
  unique (user_id, provider, external_id)
);

create table public.calendars (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.calendar_accounts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  external_id text not null,
  name text not null,
  color text,
  visible boolean not null default true,
  is_task_target boolean not null default false,
  -- Google: {syncToken, channel: {id, resourceId, token, expiration}}; ICS: {etag, lastModified, hash}.
  sync_state jsonb not null default '{}',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 0,
  unique (account_id, external_id)
);
create index calendars_user on public.calendars (user_id);
create unique index calendars_channel on public.calendars ((sync_state #>> '{channel,id}')) where sync_state ? 'channel';

-- Odstępstwo od §5: wydarzenie całodniowe ma daty pływające (`start_date`, `end_date` bez włączenia,
-- jak w iCalendar), a `start_at`/`end_at` tylko wydarzenie z godziną — „cały dzień” to dzień tam, gdzie jestem.
create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references public.calendars (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  external_id text not null,
  title text not null default '',
  all_day boolean not null default false,
  start_at timestamptz,
  end_at timestamptz,
  start_date date,
  end_date date,
  location text,
  etag text,
  task_id uuid,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 0,
  unique (calendar_id, external_id),
  check (case when all_day then start_date is not null and end_date is not null
              else start_at is not null and end_at is not null end)
);
create index calendar_events_user on public.calendar_events (user_id, row_version);

-- Jednorazowy stan logowania OAuth (ważny 15 min).
create table public.oauth_states (
  state text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  redirect_to text,
  created_at timestamptz not null default now()
);

-- ── Poczta przychodząca ──────────────────────────────────────────────────────────────────────

create table public.inbound_addresses (
  user_id uuid primary key references auth.users (id) on delete cascade,
  token text not null unique check (token ~ '^[a-z0-9]{16,64}$'),
  senders text[] not null default '{}',
  -- Lista docelowa; brak = Inbox pierwszej przestrzeni użytkownika.
  list_id uuid references public.lists (id) on delete set null,
  time_zone text not null default 'Europe/Warsaw',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  received_at timestamptz not null default now(),
  from_addr text,
  to_addr text,
  subject text,
  message_id text,
  status text not null check (status in ('created', 'rejected')),
  task_id uuid references public.tasks (id) on delete set null,
  reason text,
  updated_at timestamptz not null default now(),
  row_version bigint not null default 0
);
create index inbound_messages_user on public.inbound_messages (user_id, received_at desc);
-- Ten sam mail dostarczony drugi raz (ponowienie po stronie Cloudflare) nie tworzy drugiego zadania.
create unique index inbound_messages_once on public.inbound_messages (user_id, message_id) where status = 'created';

-- ── Web Push ─────────────────────────────────────────────────────────────────────────────────

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- http tylko dla fałszywej usługi push w testach; `reminders-push` wysyła na http wyłącznie z `PUSH_ALLOW_HTTP=1`.
  endpoint text not null unique check (endpoint ~ '^https?://'),
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failures integer not null default 0
);
create index push_subscriptions_user on public.push_subscriptions (user_id);

create table public.push_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete cascade,
  title text not null,
  body text,
  url text,
  send_at timestamptz not null default now(),
  claimed_at timestamptz,
  attempts integer not null default 0,
  sent_at timestamptz,
  delivered integer,
  error text,
  created_at timestamptz not null default now()
);
create index push_queue_due on public.push_queue (send_at) where sent_at is null;

-- ── Wyzwalacze, RLS, uprawnienia ─────────────────────────────────────────────────────────────

create trigger z_stamp before insert or update on public.calendar_accounts for each row execute function public.stamp_integration_row();
create trigger z_stamp before insert or update on public.calendars for each row execute function public.stamp_integration_row();
create trigger z_stamp before insert or update on public.calendar_events for each row execute function public.stamp_integration_row();
create trigger z_stamp before insert or update on public.inbound_messages for each row execute function public.stamp_integration_row();

-- Kalendarz i wydarzenie należą do tego samego użytkownika co konto.
create function public.derive_calendar_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'calendars' then
    select user_id into new.user_id from public.calendar_accounts where id = new.account_id;
  else
    select user_id into new.user_id from public.calendars where id = new.calendar_id;
  end if;
  return new;
end $$;
create trigger a_derive before insert or update on public.calendars for each row execute function public.derive_calendar_owner();
create trigger a_derive before insert or update on public.calendar_events for each row execute function public.derive_calendar_owner();

-- Odłączenie konta usuwa sekret z Vault (wydarzenia i kalendarze idą kaskadą).
create function public.drop_account_secret() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.secret_id is not null then
    delete from vault.secrets where id = old.secret_id;
  end if;
  return old;
end $$;
create trigger drop_secret after delete on public.calendar_accounts for each row execute function public.drop_account_secret();

do $$
declare
  t text;
begin
  foreach t in array array['calendar_accounts', 'calendars', 'calendar_events', 'oauth_states', 'inbound_addresses',
                           'inbound_messages', 'push_subscriptions', 'push_queue'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Klient widzi swoje wiersze bez sekretów i stanu synchronizacji (tokeny kanałów, syncToken).
create policy own on public.calendar_accounts for select to authenticated using (user_id = auth.uid());
grant select (id, user_id, provider, label, status, last_synced_at, last_error, created_at, updated_at, row_version)
  on public.calendar_accounts to authenticated;
create policy own on public.calendars for select to authenticated using (user_id = auth.uid());
grant select (id, account_id, user_id, external_id, name, color, visible, is_task_target, last_synced_at, created_at, updated_at, row_version)
  on public.calendars to authenticated;
create policy own on public.calendar_events for select to authenticated using (user_id = auth.uid());
grant select on public.calendar_events to authenticated;
create policy own on public.inbound_messages for select to authenticated using (user_id = auth.uid());
grant select on public.inbound_messages to authenticated;
create policy own on public.inbound_addresses for select to authenticated using (user_id = auth.uid());
grant select on public.inbound_addresses to authenticated;
create policy own on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
grant select (id, user_id, endpoint, user_agent, created_at, last_success_at, failures) on public.push_subscriptions to authenticated;

-- ── Vault: sekrety kont kalendarzy (tylko service_role) ──────────────────────────────────────

create function public.account_secret_set(p_account uuid, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
begin
  select secret_id into sid from public.calendar_accounts where id = p_account for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Brak konta kalendarza';
  end if;
  if sid is null then
    sid := vault.create_secret(p_secret, 'calendar_account:' || p_account, 'Sekret konta kalendarza (PoC-6)');
    update public.calendar_accounts set secret_id = sid where id = p_account;
  else
    perform vault.update_secret(sid, p_secret);
  end if;
end $$;

create function public.account_secret_get(p_account uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret
    from public.calendar_accounts a
    join vault.decrypted_secrets s on s.id = a.secret_id
   where a.id = p_account;
$$;

-- ── Poczta: adres przechwytywania i zadanie z maila ──────────────────────────────────────────

create function public.random_token() returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + (get_byte(b, i) % 36), 1), '')
    from extensions.gen_random_bytes(24) b, generate_series(0, 23) i;
$$;

-- Nowy token unieważnia stary adres. Zwraca token (adres = `zadania+<token>@<domena>`).
create function public.rotate_inbound_token() returns text
language plpgsql security definer set search_path = '' as $$
declare
  tok text := public.random_token();
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Wymagane logowanie';
  end if;
  insert into public.inbound_addresses (user_id, token) values (auth.uid(), tok)
  on conflict (user_id) do update set token = excluded.token, updated_at = now();
  return tok;
end $$;

create function public.set_inbound_senders(p_senders text[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Wymagane logowanie';
  end if;
  update public.inbound_addresses
     set senders = (select coalesce(array_agg(distinct lower(btrim(s))), '{}') from unnest(p_senders) s where btrim(s) <> ''),
         updated_at = now()
   where user_id = auth.uid();
  if not found then
    raise exception using errcode = 'P0002', message = 'Najpierw wygeneruj adres';
  end if;
end $$;

-- Kontekst szybkiego dodawania dla tematu maila: przestrzenie, listy (z Inboxami) i tagi użytkownika.
create function public.inbound_context(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'workspaces', coalesce((
      select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name) order by w.sort_key, w.created_at)
        from public.workspaces w join public.scope_members m on m.scope_id = w.id and m.user_id = p_user
       where w.deleted_at is null and w.archived_at is null and m.role in ('owner', 'editor')), '[]'),
    'lists', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'kind', l.kind, 'workspaceId', l.scope_id) order by l.sort_key)
        from public.lists l join public.scope_members m on m.scope_id = l.scope_id and m.user_id = p_user
       where l.deleted_at is null and m.role in ('owner', 'editor')), '[]'),
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name))
        from public.tags g where g.scope_id = p_user and g.deleted_at is null), '[]'));
$$;

-- Zadanie z integracji: wiersz jak z `push_changes`, z HLC serwera dla każdego pola (klienci scalają go
-- tak samo jak zmianę z innego urządzenia). `p_tags`: [{id, tagId}] z id z `core/ids.ts` (`taskTagId`),
-- tylko istniejące tagi użytkownika. Sprawdza prawo zapisu do listy.
create function public.create_integration_task(p_user uuid, p_task jsonb, p_tags jsonb default '[]') returns uuid
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
     or not exists (select 1 from public.scope_members m where m.scope_id = list_scope and m.user_id = p_user and m.role in ('owner', 'editor')) then
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

-- ── Web Push: subskrypcje i kolejka ──────────────────────────────────────────────────────────

create function public.save_push_subscription(p_subscription jsonb, p_user_agent text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Wymagane logowanie';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_subscription ->> 'endpoint', p_subscription #>> '{keys,p256dh}', p_subscription #>> '{keys,auth}', p_user_agent)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, failures = 0
  returning id into sid;
  return sid;
end $$;

create function public.delete_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

-- Pobranie należnych powiadomień przez `reminders-push`. `skip locked` + `claimed_at`: dwa równoległe
-- uruchomienia nie wyślą tego samego, a przerwane (np. limit czasu funkcji) wróci po 5 minutach.
create function public.claim_push_queue(p_limit int default 100) returns setof public.push_queue
language sql volatile security definer set search_path = '' as $$
  update public.push_queue q
     set claimed_at = now(), attempts = q.attempts + 1
   where q.id in (
     select id from public.push_queue
      where sent_at is null and send_at <= now() and attempts < 5
        and (claimed_at is null or claimed_at < now() - interval '5 minutes')
      order by send_at
      limit p_limit
      for update skip locked)
  returning q.*;
$$;

-- ── pg_cron → Edge Functions ─────────────────────────────────────────────────────────────────

-- Adres funkcji i sekret wywołań z crona są w Vault (`functions_url`, `cron_secret`), ustawiane raz na
-- środowisko (lokalnie: `npm run setup --workspace tools/edge-tests`). Bez nich zadanie nic nie robi.
create function public.call_edge_function(p_path text, p_body jsonb default '{}') returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  base text;
  secret text;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'functions_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'cron_secret';
  if base is null or secret is null then
    return null;
  end if;
  return net.http_post(
    url := rtrim(base, '/') || '/' || ltrim(p_path, '/'),
    body := p_body,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 60000);
end $$;

select cron.schedule('taskplanner-reminders-push', '* * * * *', $$select public.call_edge_function('reminders-push')$$);
select cron.schedule('taskplanner-calendar-poll', '*/15 * * * *', $$select public.call_edge_function('calendar-sync/cron/poll')$$);
select cron.schedule('taskplanner-calendar-renew', '17 3 * * *', $$select public.call_edge_function('calendar-sync/cron/renew')$$);
select cron.schedule('taskplanner-oauth-states-cleanup', '23 * * * *', $$delete from public.oauth_states where created_at < now() - interval '1 hour'$$);

-- Funkcje serwerowe tylko dla service_role; klient ma tylko swoje RPC.
revoke execute on function
  public.account_secret_set(uuid, text), public.account_secret_get(uuid), public.inbound_context(uuid),
  public.create_integration_task(uuid, jsonb, jsonb), public.claim_push_queue(int), public.call_edge_function(text, jsonb),
  public.random_token(), public.stamp_integration_row(), public.derive_calendar_owner(), public.drop_account_secret()
  from public, anon, authenticated;
grant execute on function
  public.account_secret_set(uuid, text), public.account_secret_get(uuid), public.inbound_context(uuid),
  public.create_integration_task(uuid, jsonb, jsonb), public.claim_push_queue(int)
  to service_role;
revoke execute on function public.rotate_inbound_token(), public.set_inbound_senders(text[]),
  public.save_push_subscription(jsonb, text), public.delete_push_subscription(text) from public, anon;
grant execute on function public.rotate_inbound_token(), public.set_inbound_senders(text[]),
  public.save_push_subscription(jsonb, text), public.delete_push_subscription(text) to authenticated;
