-- Przychodzące API (v1.x; PLAN_ETAPOWY.md → v1.x „Przychodzące API”, SPECYFIKACJA M22): inna aplikacja — na start
-- Expedition Plan — tworzy i aktualizuje zadania tokenem osobistym przez Edge Function `inbound-api`
-- (`PUT/GET tasks/<klucz>`). Zamknięcie zadania wraca do tamtej aplikacji istniejącym webhookiem (reguła
-- zdarzeniowa `task.completed`; ładunek niesie teraz `task.source` z kluczem zewnętrznym). Migracja addytywna.
--
--   * `api_tokens` — tokeny konta (zakres osobisty, jak `plugin_connections`): etykieta, skrót SHA-256 tokenu
--     (jawny token widać tylko raz, przy utworzeniu), końcówka do rozpoznania, lista, na której API zakłada
--     zadania. Pisze tylko Edge Function (`service_role`, `api_token_create` / `api_token_revoke`); klient dostaje
--     wiersz bez skrótu w `pull_changes` jako tabelę tylko do odczytu. Odwołanie = `revoked_at` (u klienta
--     jak usunięcie).
--   * `api_token_usage` — okno minutowe zapytań tokenu (limit w `api_token_auth`); osobno, żeby licznik nie
--     podbijał wersji zakresu przy każdym zapytaniu.
--   * `api_task_links` — zadanie ↔ klucz zewnętrzny konta i rzut ostatniej wysyłki (`pushed`, jak
--     `calendar_task_links.pushed`) — podstawa scalania trójstronnego. Bez klucza obcego do `tasks`: po
--     usunięciu zadania na stałe powiązanie zostaje i kolejny zapis dostaje „usunięte” zamiast nowego zadania.
--
-- `upsert_integration_task` — id zadania z klucza (UUIDv5 liczony w `packages/core`, `apiTaskId`), więc powtórka
-- jest idempotentna. Pierwszy zapis jak `create_integration_task` (HLC serwera w `field_clock`, prawo `edit` do
-- listy tokenu). Kolejne: pole zmienia się tylko wtedy, gdy aplikacja przysłała inną wartość niż ostatnio,
-- a w Task Plannerze ma ono nadal wartość z ostatniej wysyłki (użytkownik go nie zmienił) i HLC serwera jest
-- nowszy niż HLC pola. Daty (`start_date`, `due_date`, `due_time`) scalają się razem (jedno pole „termin”), żeby
-- nie powstał początek po terminie. Tagi po nazwie: dochodzą tylko nowe w wysyłce, znikają tylko usunięte z niej.
-- Zadanie w koszu się nie zmienia. Zapis idzie z `taskplanner.source = 'api'` (pochodzenie `integration`
-- w `plugin_outbox` — reguły bez „także zadania z integracji” go nie widzą) i wykonawcą = właściciel tokenu.

-- ── Tokeny ───────────────────────────────────────────────────────────────────────────────────

create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null check (length(btrim(label)) between 1 and 100),
  -- SHA-256 tokenu (szesnastkowo, `core/inbound-api.ts` `apiTokenHash`); sam token nigdzie nie jest zapisany.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- Ostatnie 4 znaki tokenu („…x1Y2”).
  token_hint text check (token_hint is null or length(token_hint) <= 8),
  -- Lista, na której API zakłada nowe zadania (prawo `edit` sprawdzane przy utworzeniu tokenu i każdym zadaniu).
  list_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Najwyżej co 5 minut (każde zapytanie podbijałoby wersję zakresu).
  last_used_at timestamptz,
  revoked_at timestamptz,
  row_version bigint not null default 0
);
create index api_tokens_user on public.api_tokens (user_id, row_version);
create trigger z_stamp before insert or update on public.api_tokens for each row execute function public.stamp_integration_row();

create table public.api_token_usage (
  token_id uuid primary key references public.api_tokens (id) on delete cascade,
  window_start timestamptz not null,
  hits integer not null
);

create table public.api_task_links (
  task_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  external_key text not null check (length(external_key) between 1 and 300),
  -- Token ostatniego zapisu (informacyjnie; zadaniem może zarządzać każdy token tego konta).
  token_id uuid references public.api_tokens (id) on delete set null,
  -- Rzut ostatniej wysyłki: `{fields: {title, description_md, status, priority, start_date, due_date, due_time}, tags: [nazwy małymi literami]}`.
  pushed jsonb not null check (jsonb_typeof(pushed) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, external_key)
);

alter table public.api_tokens enable row level security;
alter table public.api_token_usage enable row level security;
alter table public.api_task_links enable row level security;
revoke all on public.api_tokens, public.api_token_usage, public.api_task_links from anon, authenticated;
-- Projekt w chmurze nie nadaje ról API do tabel z migracji (wniosek z PoC-6).
grant all on public.api_tokens, public.api_token_usage, public.api_task_links to service_role;
-- Klient widzi swoje tokeny bez skrótu.
create policy own on public.api_tokens for select to authenticated using (user_id = auth.uid());
grant select (id, user_id, label, token_hint, list_id, created_at, updated_at, last_used_at, revoked_at, row_version)
  on public.api_tokens to authenticated;

-- ── Funkcje Edge Function `inbound-api` (service_role) ───────────────────────────────────────

-- Nowy token: lista z prawem zapisu właściciela, najwyżej `MAX_API_TOKENS` aktywnych.
create function public.api_token_create(p_user uuid, p_label text, p_list uuid, p_hash text, p_hint text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.lists l where l.id = p_list and l.deleted_at is null and l.archived_at is null)
     or public.list_access(p_list, p_user) is distinct from 'edit' then
    raise exception using errcode = 'TP003', message = 'Brak prawa zapisu na tej liście';
  end if;
  if (select count(*) from public.api_tokens where user_id = p_user and revoked_at is null) >= 10 then
    raise exception using errcode = '22023', message = 'Najwyżej 10 tokenów — odwołaj nieużywany';
  end if;
  insert into public.api_tokens (user_id, label, token_hash, token_hint, list_id)
  values (p_user, btrim(p_label), p_hash, p_hint, p_list)
  returning id into v_id;
  return v_id;
end $$;

create function public.api_token_revoke(p_user uuid, p_token uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.api_tokens set revoked_at = now() where id = p_token and user_id = p_user and revoked_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'Nie ma takiego tokenu';
  end if;
end $$;

-- Token ze skrótu: `null` = nieznany lub odwołany. Liczy zapytanie w oknie minutowym (`allowed = false` po
-- przekroczeniu limitu, `retryAfter` w sekundach) i odświeża `last_used_at` najwyżej co 5 minut.
create function public.api_token_auth(p_hash text, p_per_minute int default 60) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_token public.api_tokens;
  v_usage public.api_token_usage;
  v_allowed boolean;
begin
  select * into v_token from public.api_tokens where token_hash = p_hash and revoked_at is null;
  if not found then
    return null;
  end if;
  insert into public.api_token_usage as u (token_id, window_start, hits) values (v_token.id, now(), 1)
  on conflict (token_id) do update
     set window_start = case when u.window_start <= now() - interval '1 minute' then now() else u.window_start end,
         hits = case when u.window_start <= now() - interval '1 minute' then 1 else u.hits + 1 end
  returning * into v_usage;
  v_allowed := v_usage.hits <= p_per_minute;
  if v_allowed and (v_token.last_used_at is null or v_token.last_used_at < now() - interval '5 minutes') then
    update public.api_tokens set last_used_at = now() where id = v_token.id;
  end if;
  return jsonb_build_object(
    'id', v_token.id, 'userId', v_token.user_id, 'listId', v_token.list_id, 'allowed', v_allowed,
    'retryAfter', case when v_allowed then 0
                       else greatest(1, ceil(extract(epoch from v_usage.window_start + interval '1 minute' - now())))::int end);
end $$;

-- Tagi zadania z API po nazwie (tagi osobiste właściciela tokenu). `p_tags` = `[{name, tagId, id}]` z
-- `core/inbound-api.ts` `inboundTags` (id istniejącego tagu albo `tagId` nowego, id `task_tags`), `p_was` =
-- nazwy z ostatniej wysyłki (małymi literami). Dodaje tylko nazwy nowe w wysyłce (brakujący tag zakłada albo
-- przywraca z kosza), zdejmuje tylko nazwy, które z wysyłki zniknęły — zmiany użytkownika zostają. `true` = zmiana.
create function public.api_task_tags(p_user uuid, p_task uuid, p_tags jsonb, p_was text[], p_hlc text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_name text;
  v_tag uuid;
  v_link public.task_tags;
  v_want text[];
  v_changed boolean := false;
begin
  select coalesce(array_agg(lower(btrim(x.value ->> 'name'))), '{}') into v_want from jsonb_array_elements(coalesce(p_tags, '[]')) x;

  for v_item in select x.value from jsonb_array_elements(coalesce(p_tags, '[]')) x loop
    v_name := btrim(v_item ->> 'name');
    continue when v_name is null or v_name = '' or lower(v_name) = any(p_was);
    select g.id into v_tag from public.tags g where g.scope_id = p_user and lower(g.name) = lower(v_name) and g.deleted_at is null;
    if v_tag is null then
      v_tag := (v_item ->> 'tagId')::uuid;
      if exists (select 1 from public.tags g where g.id = v_tag) then
        -- Ten sam id: tag w koszu albo zapisany inaczej (bez polskich znaków) — tylko własny.
        continue when not exists (select 1 from public.tags g where g.id = v_tag and g.scope_id = p_user);
        update public.tags
           set deleted_at = null, name = v_name, field_clock = field_clock || jsonb_build_object('deleted_at', p_hlc, 'name', p_hlc)
         where id = v_tag and deleted_at is not null;
      else
        insert into public.tags (id, scope_id, name, created_by, field_clock)
        values (v_tag, p_user, v_name, p_user, jsonb_build_object('scope_id', p_hlc, 'name', p_hlc));
      end if;
    end if;
    select * into v_link from public.task_tags where task_id = p_task and tag_id = v_tag order by deleted_at nulls first limit 1 for update;
    if not found then
      insert into public.task_tags (id, task_id, tag_id, created_by, field_clock)
      values (coalesce((v_item ->> 'id')::uuid, gen_random_uuid()), p_task, v_tag, p_user, jsonb_build_object('task_id', p_hlc, 'tag_id', p_hlc))
      on conflict do nothing;
      v_changed := true;
    elsif v_link.deleted_at is not null and p_hlc collate "C" > coalesce(v_link.field_clock ->> 'deleted_at', '') collate "C" then
      update public.task_tags set deleted_at = null, field_clock = field_clock || jsonb_build_object('deleted_at', p_hlc) where id = v_link.id;
      v_changed := true;
    end if;
    v_tag := null;
  end loop;

  for v_name in select unnest(p_was) except select unnest(v_want) loop
    update public.task_tags tt
       set deleted_at = now(), field_clock = tt.field_clock || jsonb_build_object('deleted_at', p_hlc)
      from public.tags g
     where tt.task_id = p_task and tt.tag_id = g.id and g.scope_id = p_user and lower(g.name) = v_name and tt.deleted_at is null
       and p_hlc collate "C" > coalesce(tt.field_clock ->> 'deleted_at', '') collate "C";
    if found then
      v_changed := true;
    end if;
  end loop;
  return v_changed;
end $$;

-- Utworzenie albo scalenie zadania z API. `p_task` = pola `InboundTaskRow` (snake_case; brak = `null`),
-- `p_tags` jak w `api_task_tags`, `p_source` = `tasks.source` (tylko przy utworzeniu). Wynik:
-- `{status: created|updated|unchanged|trashed|deleted, kept: [pola zachowane po stronie użytkownika], task}`,
-- `task` = `plugin_task_context` (bez `deleted`).
create function public.upsert_integration_task(p_token uuid, p_key text, p_task_id uuid, p_task jsonb, p_tags jsonb default '[]',
                                               p_source jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_token public.api_tokens;
  v_hlc text := public.server_hlc();
  v_task public.tasks;
  v_link public.api_task_links;
  v_linked boolean;
  v_keys constant text[] := array['title', 'description_md', 'status', 'priority', 'start_date', 'due_date', 'due_time'];
  v_dates constant text[] := array['start_date', 'due_date', 'due_time'];
  v_want jsonb;
  v_cur jsonb;
  v_was jsonb;
  v_want_tags jsonb;
  v_cols text[] := '{}';
  v_kept text[] := '{}';
  v_f text;
  v_tags_changed boolean := false;
  v_status text;
begin
  select * into v_token from public.api_tokens where id = p_token and revoked_at is null;
  if not found then
    raise exception using errcode = 'TP003', message = 'Token odwołany';
  end if;
  if p_key is null or length(p_key) not between 1 and 300 then
    raise exception using errcode = '22023', message = 'Niepoprawny klucz zadania';
  end if;
  select jsonb_object_agg(k, coalesce(p_task -> k, 'null'::jsonb)) into v_want from unnest(v_keys) k;
  if coalesce(btrim(v_want ->> 'title'), '') = '' then
    raise exception using errcode = '22023', message = 'Brak tytułu';
  end if;
  select coalesce(jsonb_agg(distinct lower(btrim(x.value ->> 'name'))), '[]') into v_want_tags
    from jsonb_array_elements(coalesce(p_tags, '[]')) x where coalesce(btrim(x.value ->> 'name'), '') <> '';

  select * into v_link from public.api_task_links where task_id = p_task_id for update;
  v_linked := found;
  if v_linked and (v_link.user_id <> v_token.user_id or v_link.external_key <> p_key) then
    raise exception using errcode = 'TP003', message = 'Zadanie należy do innego klucza';
  end if;
  select * into v_task from public.tasks where id = p_task_id for update;

  perform set_config('taskplanner.source', 'api', true);
  perform set_config('taskplanner.actor', v_token.user_id::text, true);

  if v_task.id is null and v_linked then
    -- Usunięte na stałe w Task Plannerze — aplikacja go nie przywraca.
    v_status := 'deleted';
  elsif v_task.id is null then
    if not exists (select 1 from public.lists l where l.id = v_token.list_id and l.deleted_at is null)
       or public.list_access(v_token.list_id, v_token.user_id) is distinct from 'edit' then
      raise exception using errcode = 'TP003', message = 'Brak prawa zapisu na liście tokenu';
    end if;
    insert into public.tasks (id, list_id, title, description_md, status, priority, start_date, due_date, due_time, completed_at, source,
                              created_by, field_clock)
    select p_task_id, v_token.list_id, r.title, r.description_md, r.status, r.priority, r.start_date, r.due_date, r.due_time,
           case when r.status in ('done', 'cancelled') then now() end, p_source, v_token.user_id,
           (select jsonb_object_agg(k, v_hlc) from unnest(v_keys || array['list_id', 'completed_at', 'source']) k)
      from jsonb_populate_record(null::public.tasks, v_want) r;
    perform public.api_task_tags(v_token.user_id, p_task_id, p_tags, '{}', v_hlc);
    insert into public.api_task_links (task_id, user_id, external_key, token_id, pushed)
    values (p_task_id, v_token.user_id, p_key, v_token.id, jsonb_build_object('fields', v_want, 'tags', v_want_tags));
    v_status := 'created';
  elsif not v_linked then
    raise exception using errcode = 'TP003', message = 'Zadanie nie pochodzi z API';
  elsif v_task.deleted_at is not null then
    v_status := 'trashed';
  elsif public.list_access(v_task.list_id, v_token.user_id) is distinct from 'edit' then
    raise exception using errcode = 'TP003', message = 'Brak prawa zmiany zadania';
  else
    v_cur := to_jsonb(v_task);
    v_was := coalesce(v_link.pushed -> 'fields', '{}');
    foreach v_f in array array['title', 'description_md', 'status', 'priority'] loop
      continue when (v_want -> v_f) is not distinct from coalesce(v_cur -> v_f, 'null'::jsonb);
      if coalesce(v_was -> v_f, 'null'::jsonb) is not distinct from coalesce(v_cur -> v_f, 'null'::jsonb)
         and v_hlc collate "C" > coalesce(v_task.field_clock ->> v_f, '') collate "C"
         and not (v_f = 'status' and v_task.recurrence is not null and v_want ->> 'status' in ('done', 'cancelled')) then
        v_cols := v_cols || v_f;
      elsif coalesce(v_was -> v_f, 'null'::jsonb) is distinct from (v_want -> v_f) then
        v_kept := v_kept || v_f;
      end if;
    end loop;
    -- Termin jako całość.
    if (select jsonb_object_agg(k, v_want -> k) from unnest(v_dates) k)
       is distinct from (select jsonb_object_agg(k, coalesce(v_cur -> k, 'null'::jsonb)) from unnest(v_dates) k) then
      if (select jsonb_object_agg(k, coalesce(v_was -> k, 'null'::jsonb)) from unnest(v_dates) k)
           is not distinct from (select jsonb_object_agg(k, coalesce(v_cur -> k, 'null'::jsonb)) from unnest(v_dates) k)
         and not exists (select 1 from unnest(v_dates) k where v_hlc collate "C" <= coalesce(v_task.field_clock ->> k, '') collate "C") then
        v_cols := v_cols || v_dates;
      elsif (select jsonb_object_agg(k, coalesce(v_was -> k, 'null'::jsonb)) from unnest(v_dates) k)
              is distinct from (select jsonb_object_agg(k, v_want -> k) from unnest(v_dates) k) then
        v_kept := v_kept || 'dates'::text;
      end if;
    end if;

    if cardinality(v_cols) > 0 then
      execute format(
        'update public.tasks set (%1$s, field_clock) = (select %1$s, $2 from jsonb_populate_record(null::public.tasks, $1)) where id = $3',
        (select string_agg(quote_ident(c), ', ') from unnest(v_cols) c))
      using v_want, v_task.field_clock || (select jsonb_object_agg(c, v_hlc) from unnest(v_cols) c), p_task_id;
      if 'status' = any(v_cols) then
        update public.tasks
           set completed_at = case when status in ('done', 'cancelled') then now() end,
               field_clock = field_clock || jsonb_build_object('completed_at', v_hlc)
         where id = p_task_id;
      end if;
    end if;
    v_tags_changed := public.api_task_tags(
      v_token.user_id, p_task_id, p_tags,
      array(select jsonb_array_elements_text(coalesce(v_link.pushed -> 'tags', '[]'))), v_hlc);
    update public.api_task_links
       set pushed = jsonb_build_object('fields', v_want, 'tags', v_want_tags), token_id = v_token.id, updated_at = now()
     where task_id = p_task_id;
    v_status := case when cardinality(v_cols) > 0 or v_tags_changed then 'updated' else 'unchanged' end;
  end if;

  perform set_config('taskplanner.source', '', true);
  perform set_config('taskplanner.actor', '', true);
  return jsonb_build_object(
    'status', v_status,
    'kept', to_jsonb(v_kept),
    'task', case when v_status <> 'deleted' then public.plugin_task_context(p_task_id, v_token.user_id) end);
end $$;

-- Stan zadania z API (`GET tasks/<klucz>`): `{status: ok|trashed, task}`, `missing` (klucz nieznany temu kontu),
-- `deleted` (usunięte na stałe). Brak dostępu do zadania (np. lista ukryta po zmianie roli) = TP003.
create function public.integration_task_state(p_token uuid, p_key text, p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_token public.api_tokens;
  v_ctx jsonb;
begin
  select * into v_token from public.api_tokens where id = p_token and revoked_at is null;
  if not found then
    raise exception using errcode = 'TP003', message = 'Token odwołany';
  end if;
  if not exists (select 1 from public.api_task_links
                  where task_id = p_task_id and user_id = v_token.user_id and external_key = p_key) then
    return jsonb_build_object('status', 'missing');
  end if;
  if not exists (select 1 from public.tasks where id = p_task_id) then
    return jsonb_build_object('status', 'deleted');
  end if;
  v_ctx := public.plugin_task_context(p_task_id, v_token.user_id);
  if v_ctx is null then
    raise exception using errcode = 'TP003', message = 'Brak dostępu do zadania';
  end if;
  return jsonb_build_object('status', case when v_ctx ->> 'deletedAt' is null then 'ok' else 'trashed' end, 'task', v_ctx);
end $$;

-- ── Ładunek pluginów: `source` zadania (klucz zewnętrzny w webhooku `task.completed`) ─────────

-- Jak w `*_v1x_plugins.sql`, z `source`.
create or replace function public.plugin_task_context(p_task uuid, p_user uuid) returns jsonb
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
           'fromIntegration', t.source is not null and t.source ->> 'kind' in ('email', 'calendar'),
           'source', t.source)
    from public.tasks t
    join public.lists l on l.id = t.list_id
    left join public.workspaces w on w.id = t.scope_id
   where t.id = p_task
     and exists (select 1 from public.scope_members m where m.scope_id = t.scope_id and m.user_id = p_user)
     and public.list_access(t.list_id, p_user) is distinct from 'hidden';
$$;

revoke execute on function
  public.api_token_create(uuid, text, uuid, text, text), public.api_token_revoke(uuid, uuid), public.api_token_auth(text, int),
  public.api_task_tags(uuid, uuid, jsonb, text[], text), public.upsert_integration_task(uuid, text, uuid, jsonb, jsonb, jsonb),
  public.integration_task_state(uuid, text, uuid), public.plugin_task_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function
  public.api_token_create(uuid, text, uuid, text, text), public.api_token_revoke(uuid, uuid), public.api_token_auth(text, int),
  public.upsert_integration_task(uuid, text, uuid, jsonb, jsonb, jsonb), public.integration_task_state(uuid, text, uuid),
  public.plugin_task_context(uuid, uuid)
  to service_role;

-- ── Odczyt: tokeny jako tabela tylko do odczytu ──────────────────────────────────────────────

create or replace function public.pulled_readonly_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array['calendar_accounts', 'calendars', 'calendar_events', 'scope_collaborators', 'scope_tags', 'plugin_connections', 'ai_accounts',
               'api_tokens']
$$;

-- `pull_changes` jak w `*_v1x_collaborator_color.sql`, z tokenami API (bez skrótu; odwołane = usunięte, tylko przyrostowo).

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
                              'acronym', r.acronym, 'color', r.color, 'user_id', r.user_id, 'archived_at', r.archived_at, 'created_at', r.created_at,
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
    select 'api_tokens', r.user_id, r.row_version,
           jsonb_build_object('id', r.id, 'scope_id', r.user_id, 'label', r.label, 'token_hint', r.token_hint, 'list_id', r.list_id,
                              'last_used_at', r.last_used_at, 'created_at', r.created_at, 'updated_at', r.updated_at,
                              'row_version', r.row_version, 'deleted_at', r.revoked_at)
      from public.api_tokens r
     where r.user_id = auth.uid() and r.row_version > coalesce(($1 ->> r.user_id::text)::bigint, 0)
       and (coalesce(($1 ->> r.user_id::text)::bigint, 0) > 0 or r.revoked_at is null)
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
