-- Etap 13: własny dziennik błędów aplikacji (decyzja D20 — bez Sentry, dane zostają w Supabase).
--
-- Klient (web, później telefon) zbiera błędy (`core/errors.ts`: treść, stos, odcisk), trzyma je w
-- kolejce i wysyła paczkami przez `report_client_errors` — jeden wiersz na użytkownika, odcisk i dzień
-- (UTC) z licznikiem, więc błąd w pętli nie zapcha tabeli. Tabela nie jest synchronizowana: klient tylko
-- dopisuje (RPC) i czyta własne wiersze (Ustawienia → „Błędy aplikacji”). Limity w funkcji: 20 pozycji
-- na wywołanie, 200 nowych odcisków na użytkownika dziennie, obcięte długie pola. Retencja 90 dni.
create table public.client_errors (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- `errorFingerprint` z core: rodzaj + znormalizowana treść + pierwsza ramka stosu.
  fingerprint text not null,
  day date not null,
  kind text not null check (kind in ('error', 'unhandled', 'render', 'sync', 'rejected')),
  platform text not null check (platform in ('web', 'android')),
  app_version text,
  message text not null,
  stack text,
  url text,
  user_agent text,
  context jsonb not null default '{}',
  count integer not null default 1,
  first_at timestamptz not null,
  last_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (user_id, fingerprint, day)
);
create index client_errors_user on public.client_errors (user_id, last_at desc);
create index client_errors_last on public.client_errors (last_at);
alter table public.client_errors enable row level security;
create policy own on public.client_errors for select to authenticated using (user_id = auth.uid());
revoke all on public.client_errors from anon, authenticated;
grant select on public.client_errors to authenticated;
-- Projekt w chmurze nie nadaje ról API do nowych tabel (PoC-6) — jawnie.
grant select, insert, update, delete on public.client_errors to service_role;

-- `p_items`: [{fingerprint, kind, platform, appVersion?, message, stack?, url?, userAgent?, context?,
-- count?, firstAt, lastAt}] (`ClientErrorReport` w core). Zwraca liczbę przyjętych pozycji; błędne
-- pozycje są pomijane (cała paczka nie przepada przez jedną).
create function public.report_client_errors(p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_new integer;
  v_taken integer := 0;
  v_item jsonb;
  v_fingerprint text;
  v_first timestamptz;
  v_last timestamptz;
  v_context jsonb;
begin
  if v_user is null then
    raise exception 'TP003: dziennik błędów wymaga zalogowania' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'TP005: oczekiwana lista błędów' using errcode = '22023';
  end if;
  select count(*) into v_new from public.client_errors where user_id = v_user and day = current_date;

  for v_item in select value from jsonb_array_elements(p_items) limit 20 loop
    v_fingerprint := left(v_item ->> 'fingerprint', 64);
    continue when coalesce(v_fingerprint, '') = ''
      or coalesce(v_item ->> 'message', '') = ''
      or (v_item ->> 'kind') is null or (v_item ->> 'kind') not in ('error', 'unhandled', 'render', 'sync', 'rejected')
      or (v_item ->> 'platform') is null or (v_item ->> 'platform') not in ('web', 'android');
    begin
      v_first := (v_item ->> 'firstAt')::timestamptz;
      v_last := (v_item ->> 'lastAt')::timestamptz;
    exception when others then
      continue;
    end;
    -- Zegar klienta bywa zły: chwile tylko z ostatnich 30 dni i nie z przyszłości.
    v_last := least(greatest(coalesce(v_last, now()), now() - interval '30 days'), now());
    v_first := least(greatest(coalesce(v_first, v_last), now() - interval '30 days'), v_last);
    v_context := case when jsonb_typeof(v_item -> 'context') = 'object' and pg_column_size(v_item -> 'context') <= 4000
                      then v_item -> 'context' else '{}'::jsonb end;

    if not exists (select 1 from public.client_errors
                    where user_id = v_user and fingerprint = v_fingerprint and day = current_date) then
      continue when v_new >= 200;
      v_new := v_new + 1;
    end if;

    insert into public.client_errors as e
      (user_id, fingerprint, day, kind, platform, app_version, message, stack, url, user_agent, context, count, first_at, last_at)
    values (
      v_user, v_fingerprint, current_date, v_item ->> 'kind', v_item ->> 'platform',
      left(v_item ->> 'appVersion', 40), left(v_item ->> 'message', 1000), left(v_item ->> 'stack', 8000),
      left(v_item ->> 'url', 500), left(v_item ->> 'userAgent', 300), v_context,
      least(greatest(coalesce((v_item ->> 'count')::integer, 1), 1), 10000), v_first, v_last)
    on conflict (user_id, fingerprint, day) do update
       set count = least(e.count + excluded.count, 1000000),
           first_at = least(e.first_at, excluded.first_at),
           last_at = greatest(e.last_at, excluded.last_at),
           message = excluded.message,
           stack = coalesce(excluded.stack, e.stack),
           url = coalesce(excluded.url, e.url),
           user_agent = coalesce(excluded.user_agent, e.user_agent),
           app_version = coalesce(excluded.app_version, e.app_version),
           context = excluded.context,
           received_at = now();
    v_taken := v_taken + 1;
  end loop;
  return v_taken;
end;
$$;
revoke all on function public.report_client_errors(jsonb) from public, anon;
grant execute on function public.report_client_errors(jsonb) to authenticated, service_role;

-- Retencja: wpisy starsze niż 90 dni znikają co noc.
select cron.schedule('taskplanner-client-errors-retention', '43 3 * * *',
  $$delete from public.client_errors where last_at < now() - interval '90 days'$$);
