-- Asystent AI na własnym koncie użytkownika, krok 1: konto AI (PLAN_ETAPOWY.md → v1.x „Asystent AI”,
-- docs/USLUGI.md § Gemini API — własny klucz użytkownika).
--
-- Każdy użytkownik podpina własny klucz (BYOK) — aplikacja nie ma wspólnego klucza. Na start tylko Gemini,
-- klucz z projektu Google z włączonym rozliczeniem (warunki dla użytkowników w EOG; aplikacja tego nie sprawdzi,
-- więc zapisujemy chwilę oświadczenia `billing_confirmed_at`).
--
--   * `ai_accounts` — konto AI użytkownika (zakres osobisty, jak `plugin_connections`): dostawca, wybrany model,
--     lista modeli z ostatniego „Sprawdź”, stan, ostatni błąd, końcówka klucza do rozpoznania. Pisze tylko
--     Edge Function `ai` (`service_role`); klucz w Vault `ai_account:<id>` (`ai_secret_set/get`). Klient dostaje
--     wiersz bez `secret_id` w `pull_changes` jako tabelę tylko do odczytu. Odłączenie = `deleted_at` + usunięcie
--     sekretu. Najwyżej jedno konto na dostawcę.
--
-- Bez limitów zapytań po naszej stronie — użytkownik zużywa limit własnego projektu Google.

create table public.ai_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('gemini')),
  -- Identyfikator modelu z listy dostawcy (`models`); `null` = jeszcze nie wybrany (przed pierwszym „Sprawdź”).
  model text check (model is null or model ~ '^[a-z0-9]+([.-][a-z0-9]+)*$'),
  -- Modele tekstowe z ostatniego udanego „Sprawdź”: `[{ id, label }]` (`core/ai.ts` `AiModelEntry`).
  models jsonb not null default '[]' check (jsonb_typeof(models) = 'array'),
  -- Ostatnie 4 znaki klucza („…x1Y2”) — żeby było widać, który klucz jest podpięty; reszta tylko w Vault.
  key_hint text check (key_hint is null or length(key_hint) <= 8),
  status text not null default 'unverified' check (status in ('unverified', 'active', 'error')),
  last_error text check (last_error is null or length(last_error) <= 500),
  verified_at timestamptz,
  -- Oświadczenie „klucz z projektu z włączonym rozliczeniem” przy podpięciu / zmianie klucza.
  billing_confirmed_at timestamptz not null,
  secret_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  row_version bigint not null default 0
);
create unique index ai_accounts_one on public.ai_accounts (user_id, provider) where deleted_at is null;
create index ai_accounts_user on public.ai_accounts (user_id, row_version);
create trigger z_stamp before insert or update on public.ai_accounts for each row execute function public.stamp_integration_row();
-- Usunięcie konta Task Plannera (kaskada z `auth.users`) zabiera też klucz z Vault.
create trigger drop_secret after delete on public.ai_accounts for each row execute function public.drop_account_secret();

alter table public.ai_accounts enable row level security;
revoke all on public.ai_accounts from anon, authenticated;
grant all on public.ai_accounts to service_role;
-- Klient widzi swoje konta bez identyfikatora sekretu.
create policy own on public.ai_accounts for select to authenticated using (user_id = auth.uid());
grant select (id, user_id, provider, model, models, key_hint, status, last_error, verified_at, billing_confirmed_at,
              created_at, updated_at, deleted_at, row_version)
  on public.ai_accounts to authenticated;

-- ── Klucz w Vault (Edge Function `ai`, service_role) ─────────────────────────────────────────

create function public.ai_secret_set(p_account uuid, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
begin
  select secret_id into sid from public.ai_accounts where id = p_account and deleted_at is null for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Brak konta AI';
  end if;
  if sid is null then
    sid := vault.create_secret(p_secret, 'ai_account:' || p_account, 'Klucz API konta AI użytkownika');
    update public.ai_accounts set secret_id = sid where id = p_account;
  else
    perform vault.update_secret(sid, p_secret);
  end if;
end $$;

create function public.ai_secret_get(p_account uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret
    from public.ai_accounts a
    join vault.decrypted_secrets s on s.id = a.secret_id
   where a.id = p_account and a.deleted_at is null;
$$;

-- Odłączenie: klucz znika z Vault, wiersz zostaje z `deleted_at` (klienci usuwają swoją kopię po `pull_changes`).
create function public.ai_account_remove(p_account uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
begin
  select secret_id into sid from public.ai_accounts where id = p_account for update;
  if sid is not null then
    delete from vault.secrets where id = sid;
  end if;
  update public.ai_accounts
     set secret_id = null, deleted_at = coalesce(deleted_at, now())
   where id = p_account;
end $$;

revoke execute on function public.ai_secret_set(uuid, text), public.ai_secret_get(uuid), public.ai_account_remove(uuid)
  from public, anon, authenticated;
grant execute on function public.ai_secret_set(uuid, text), public.ai_secret_get(uuid), public.ai_account_remove(uuid)
  to service_role;

-- ── Odczyt: konta AI jako tabela tylko do odczytu ────────────────────────────────────────────

create or replace function public.pulled_readonly_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array['calendar_accounts', 'calendars', 'calendar_events', 'scope_collaborators', 'scope_tags', 'plugin_connections', 'ai_accounts']
$$;

-- `pull_changes` jak w `*_v1x_plugins.sql`, z kontami AI (bez `secret_id`; usunięte tylko przyrostowo).

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
