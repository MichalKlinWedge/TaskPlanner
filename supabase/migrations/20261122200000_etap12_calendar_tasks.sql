-- Etap 12: dwukierunkowa synchronizacja zadań z kalendarzem Google (SPECYFIKACJA M18, D8).
--
-- Użytkownik wybiera konto Google i przestrzenie (`profiles.calendar_sync`, wiersz synchronizowany —
-- zapis lokalny jak każda zmiana ustawień). W tym koncie powstaje osobny kalendarz „TaskPlanner”
-- (`calendars.is_task_target`), a zadania z godziną z wybranych przestrzeni stają się jego wydarzeniami.
-- Pracę robi `calendar-sync` (Edge Function): pobiera zmiany kalendarza (`syncToken`) i zapisuje je
-- w zadaniach z HLC serwera, potem uzgadnia zadania → wydarzenia. Wydarzenia tego kalendarza NIE trafiają
-- do `calendar_events` (klient widziałby zadanie dwa razy).
--
-- `calendar_task_links` (tylko serwer): zadanie ↔ wydarzenie, `etag` ostatnio widzianej wersji wydarzenia
-- i `pushed` — stan, w którym obie strony były zgodne (podstawa scalania trójstronnego: zmienione w Google
-- pola idą do zadania, zmienione w zadaniu — do Google). Ochrona przed pętlami: własny zapis wraca
-- w `syncToken` z tym samym `etag` (pomijany), wydarzenie ma znacznik źródła
-- (`extendedProperties.private.tpRev`), a zmiana zadania z kalendarza (`taskplanner.source = 'calendar'`)
-- nie wywołuje ponownej wysyłki.
--
-- Opóźnienie: zmiana zadania (`push_changes`) albo ustawień → wyzwalacz → `pg_net` → `calendar-sync/tasks/flush`
-- po zatwierdzeniu transakcji (raz na transakcję i użytkownika); zmiana w Google → kanał `watch`. Zapas:
-- `cron/poll` co 10 minut uzgadnia wszystko od nowa.

-- ── Ustawienie (wiersz synchronizowany) ──────────────────────────────────────────────────────

-- `CalendarSync` z `packages/core/src/schemas/model.ts`: {accountId, workspaceIds}; `null` = wyłączone.
alter table public.profiles add column calendar_sync jsonb
  check (calendar_sync is null or (jsonb_typeof(calendar_sync) = 'object' and jsonb_typeof(calendar_sync -> 'workspaceIds') = 'array'));

-- ── Powiązania zadanie ↔ wydarzenie ──────────────────────────────────────────────────────────

create table public.calendar_task_links (
  calendar_id uuid not null references public.calendars (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  external_id text not null,
  etag text,
  -- Rzut zadania na wydarzenie w chwili ostatniej zgodności (`TaskProjection` z `_shared/task-events.ts`).
  pushed jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (calendar_id, task_id),
  unique (calendar_id, external_id)
);
create index calendar_task_links_task on public.calendar_task_links (task_id);

-- Dzierżawa uzgadniania jednego kalendarza: webhook, wyzwalacz i cron nie pracują równolegle. Kto nie
-- dostał dzierżawy, ustawia `rerun` — posiadacz powtórzy przebieg przed oddaniem (żadna zmiana nie ginie).
create table public.calendar_task_runs (
  calendar_id uuid primary key references public.calendars (id) on delete cascade,
  holder text,
  expires_at timestamptz,
  rerun boolean not null default false
);

alter table public.calendar_task_links enable row level security;
alter table public.calendar_task_runs enable row level security;
revoke all on public.calendar_task_links, public.calendar_task_runs from anon, authenticated;
-- Projekt w chmurze nie nadaje ról API do nowych tabel (PoC-6) — jawnie.
grant select, insert, update, delete on public.calendar_task_links, public.calendar_task_runs to service_role;

create function public.calendar_task_lock(p_calendar uuid, p_holder text, p_ttl_seconds int default 120) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  got text;
begin
  insert into public.calendar_task_runs as r (calendar_id, holder, expires_at)
  values (p_calendar, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (calendar_id) do update
     set holder = excluded.holder, expires_at = excluded.expires_at, rerun = false
   where r.holder is null or r.expires_at < now()
  returning holder into got;
  if got is null then
    update public.calendar_task_runs set rerun = true where calendar_id = p_calendar;
    return false;
  end if;
  return true;
end $$;

-- Oddanie dzierżawy. `true` = w międzyczasie ktoś prosił o przebieg: dzierżawa zostaje, powtórz.
create function public.calendar_task_unlock(p_calendar uuid, p_holder text, p_ttl_seconds int default 120) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  again boolean;
begin
  select rerun into again from public.calendar_task_runs where calendar_id = p_calendar and holder = p_holder for update;
  if again is null then
    return false;
  end if;
  update public.calendar_task_runs
     set rerun = false,
         holder = case when again then holder end,
         expires_at = case when again then now() + make_interval(secs => p_ttl_seconds) end
   where calendar_id = p_calendar;
  return again;
end $$;

-- ── Zmiany z kalendarza → zadania (HLC serwera) ──────────────────────────────────────────────

-- Zmiana wydarzenia w zadaniu: pola z `p_patch` (`title`, `due_date`, `due_time`, `duration_min`)
-- zapisane z HLC serwera według LWW jak w `push_changes` (klienci scalają to jak zmianę z innego
-- urządzenia), oraz powiązanie (`p_link` = {external_id, etag, pushed}; `null` = usuń). Jedna transakcja,
-- więc powtórka po przerwie niczego nie podwaja. Zwraca bieżący wiersz zadania.
create function public.calendar_task_apply(p_calendar uuid, p_task uuid, p_patch jsonb, p_link jsonb) returns jsonb
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

-- Wydarzenie dodane w Google w kalendarzu „TaskPlanner” → nowe zadanie (`create_integration_task`)
-- i powiązanie w jednej transakcji. To samo wydarzenie drugi raz (powtórka, pełna synchronizacja) zwraca
-- istniejące zadanie — bez duplikatu.
create function public.calendar_task_create(p_calendar uuid, p_task jsonb, p_link jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  owner uuid;
  tid uuid;
begin
  select user_id into owner from public.calendars where id = p_calendar and is_task_target;
  if owner is null then
    raise exception using errcode = 'P0002', message = 'Brak kalendarza zadań';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_calendar::text || '/' || (p_link ->> 'external_id'), 0));
  select task_id into tid from public.calendar_task_links where calendar_id = p_calendar and external_id = p_link ->> 'external_id';
  if tid is not null then
    return tid;
  end if;
  perform set_config('taskplanner.source', 'calendar', true);
  tid := public.create_integration_task(owner, p_task);
  insert into public.calendar_task_links (calendar_id, task_id, external_id, etag, pushed)
  values (p_calendar, tid, p_link ->> 'external_id', p_link ->> 'etag', p_link -> 'pushed');
  perform set_config('taskplanner.source', '', true);
  return tid;
end $$;

-- ── Sygnał do wysyłki (pg_net po zatwierdzeniu) ──────────────────────────────────────────────

-- Raz na transakcję i użytkownika: paczka 200 operacji z `push_changes` to jedno wywołanie funkcji.
-- `pg_net` wysyła żądanie dopiero po zatwierdzeniu (kolejka w tabeli), wycofana transakcja nic nie wysyła.
create function public.calendar_kick(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  kicked text := coalesce(current_setting('taskplanner.calendar_kicked', true), '');
begin
  if position(p_user::text in kicked) > 0 then
    return;
  end if;
  perform set_config('taskplanner.calendar_kicked', kicked || p_user::text || ',', true);
  perform public.call_edge_function('calendar-sync/tasks/flush', jsonb_build_object('userId', p_user));
end $$;

create function public.calendar_task_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  owner uuid;
begin
  if coalesce(current_setting('taskplanner.source', true), '') = 'calendar' then
    return null;
  end if;
  if tg_op = 'INSERT' then
    if new.due_time is null then
      return null;
    end if;
  elsif (old.due_time is null and new.due_time is null)
     or (new.title, new.due_date, new.due_time, new.duration_min, new.time_zone, new.deleted_at, new.status, new.scope_id, new.kind)
        is not distinct from (old.title, old.due_date, old.due_time, old.duration_min, old.time_zone, old.deleted_at, old.status, old.scope_id, old.kind) then
    return null;
  end if;
  for owner in
    select distinct s.owner_id
      from public.sync_scopes s
      join public.profiles p on p.id = s.owner_id
     where s.id in (new.scope_id, case when tg_op = 'UPDATE' then old.scope_id end)
       and p.calendar_sync -> 'workspaceIds' ? s.id::text
  loop
    perform public.calendar_kick(owner);
  end loop;
  return null;
end $$;
create trigger calendar_kick after insert or update on public.tasks for each row execute function public.calendar_task_changed();

-- Zmiana wyboru (konto, przestrzenie) albo strefy (zadania bez strefy idą do Google w strefie z ustawień).
create function public.calendar_profile_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.calendar_sync is distinct from old.calendar_sync
     or (new.calendar_sync is not null and new.settings ->> 'timeZone' is distinct from old.settings ->> 'timeZone')
     or (new.calendar_sync is not null and new.settings ->> 'defaultDurationMin' is distinct from old.settings ->> 'defaultDurationMin') then
    perform public.calendar_kick(new.id);
  end if;
  return null;
end $$;
create trigger calendar_kick after update on public.profiles for each row execute function public.calendar_profile_changed();

-- Kalendarz „TaskPlanner” usunięty w Google: serwer wyłącza wysyłanie (HLC serwera — jak zmiana z innego
-- urządzenia). Zadania zostają bez zmian.
create function public.calendar_sync_disable(p_user uuid, p_account uuid) returns void
language sql security definer set search_path = '' as $$
  update public.profiles
     set calendar_sync = null,
         field_clock = field_clock || jsonb_build_object('calendar_sync', public.server_hlc())
   where id = p_user and calendar_sync ->> 'accountId' = p_account::text;
$$;

revoke execute on function
  public.calendar_task_lock(uuid, text, int), public.calendar_task_unlock(uuid, text, int),
  public.calendar_task_apply(uuid, uuid, jsonb, jsonb), public.calendar_task_create(uuid, jsonb, jsonb),
  public.calendar_kick(uuid), public.calendar_task_changed(), public.calendar_profile_changed(),
  public.calendar_sync_disable(uuid, uuid)
  from public, anon, authenticated;
grant execute on function
  public.calendar_task_lock(uuid, text, int), public.calendar_task_unlock(uuid, text, int),
  public.calendar_task_apply(uuid, uuid, jsonb, jsonb), public.calendar_task_create(uuid, jsonb, jsonb),
  public.calendar_sync_disable(uuid, uuid)
  to service_role;
