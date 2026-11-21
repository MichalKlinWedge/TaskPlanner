-- v1.x: współdzielenie przestrzeni (zakres `workspace`) z innymi kontami.
--
-- Role w `scope_members`: `owner` (twórca przestrzeni), `editor` (zmienia wszystko poza członkami
-- i usunięciem przestrzeni), `viewer` (tylko odczyt — `can_write_scope` odrzuca jego zapisy, TP003).
-- Zaproszenie (`scope_invites`) jest na adres e-mail i trafia do osoby, która już ma konto albo jest na
-- liście zaproszonych do aplikacji (`allowed_emails`) — udostępnienie nie wpuszcza nowych kont.
-- Dostarczenie: zaproszony widzi je w aplikacji (`my_scope_invites`), a właściciel dostaje link
-- z tokenem (`/?invite=<token>`); przyjąć może tylko konto z adresem z zaproszenia.
-- Klient nie czyta tych tabel — wszystko przez funkcje poniżej. Po przyjęciu klient pobiera nowy
-- zakres od zera (`pull_changes` zwraca każdy zakres członka); po usunięciu z przestrzeni jej wiersze
-- znikają z urządzenia przy najbliższym pobraniu (`SyncEngine`, brak zakresu w `scopes`).

create table public.scope_invites (
  id uuid primary key default gen_random_uuid(),
  scope_id uuid not null references public.sync_scopes (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role text not null check (role in ('editor', 'viewer')),
  token text not null unique default public.random_token(),
  invited_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  unique (scope_id, email)
);
create index scope_invites_email on public.scope_invites (email);
alter table public.scope_invites enable row level security;
revoke all on public.scope_invites from public, anon, authenticated;
grant select, insert, update, delete on public.scope_invites to service_role;

-- Adres e-mail zalogowanego (małymi literami).
create function public.caller_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(u.email) from auth.users u where u.id = auth.uid()
$$;

-- Rola zalogowanego w zakresie (`null` — nie jest członkiem).
create function public.scope_role(p_scope uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.scope_members m where m.scope_id = p_scope and m.user_id = auth.uid()
$$;

create function public.require_workspace_owner(p_scope uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.sync_scopes s where s.id = p_scope and s.kind = 'workspace')
     or public.scope_role(p_scope) is distinct from 'owner' then
    raise exception 'Tylko właściciel przestrzeni zarządza jej udostępnianiem' using errcode = '42501';
  end if;
end $$;

-- Zaproszenie (albo zmiana roli / odnowienie zaproszenia, które już czeka). Zwraca id i token linku.
create function public.share_workspace(p_scope uuid, p_email text, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_invite public.scope_invites;
begin
  perform public.require_workspace_owner(p_scope);
  if p_role not in ('editor', 'viewer') then
    raise exception 'Nieznana rola: %', p_role using errcode = '22023';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Niepoprawny adres e-mail' using errcode = '22023';
  end if;
  if v_email = public.caller_email() then
    raise exception 'To Twój adres — przestrzeń już do Ciebie należy' using errcode = '22023';
  end if;
  if exists (select 1 from public.scope_members m join auth.users u on u.id = m.user_id
              where m.scope_id = p_scope and lower(u.email) = v_email) then
    raise exception 'Ta osoba już należy do przestrzeni' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where lower(u.email) = v_email)
     and not exists (select 1 from public.allowed_emails a
                      where a.pattern = v_email or (left(a.pattern, 1) = '@' and right(v_email, length(a.pattern)) = a.pattern)) then
    raise exception 'Ta osoba nie ma konta w Task Plannerze ani zaproszenia do aplikacji — poproś administratora o dodanie jej adresu do zaproszeń'
      using errcode = '22023';
  end if;
  insert into public.scope_invites (scope_id, email, role, invited_by)
    values (p_scope, v_email, p_role, auth.uid())
    on conflict (scope_id, email) do update
      set role = excluded.role, invited_by = excluded.invited_by, token = public.random_token(),
          created_at = now(), expires_at = now() + interval '14 days'
    returning * into v_invite;
  return jsonb_build_object('id', v_invite.id, 'token', v_invite.token);
end $$;

-- Członkowie i (dla właściciela) zaproszenia czekające na odpowiedź. Widzi każdy członek przestrzeni.
create function public.workspace_sharing(p_scope uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := public.scope_role(p_scope);
begin
  if v_role is null then
    raise exception 'Brak dostępu do przestrzeni' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'role', v_role,
    'members', (select coalesce(jsonb_agg(jsonb_build_object('userId', m.user_id, 'email', lower(u.email), 'role', m.role, 'me', m.user_id = auth.uid())
                  order by case m.role when 'owner' then 0 when 'editor' then 1 else 2 end, lower(u.email)), '[]')
                  from public.scope_members m join auth.users u on u.id = m.user_id where m.scope_id = p_scope),
    'invites', case when v_role = 'owner' then
                 (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role, 'token', i.token,
                    'createdAt', i.created_at, 'expiresAt', i.expires_at, 'expired', i.expires_at < now()) order by i.created_at desc), '[]')
                    from public.scope_invites i where i.scope_id = p_scope)
               else '[]'::jsonb end);
end $$;

-- Zaproszenia do zalogowanego (ważne), z nazwą przestrzeni i adresem zapraszającego.
create function public.my_scope_invites() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'scopeId', i.scope_id, 'workspace', w.name, 'role', i.role,
           'invitedBy', lower(u.email), 'createdAt', i.created_at) order by i.created_at desc), '[]')
    from public.scope_invites i
    join public.workspaces w on w.id = i.scope_id and w.deleted_at is null
    left join auth.users u on u.id = i.invited_by
   where i.email = public.caller_email() and i.expires_at >= now()
$$;

-- Przyjęcie po id (lista w aplikacji) albo tokenie (link). Zwraca id przestrzeni.
create function public.accept_scope_invite(p_id uuid default null, p_token text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_invite public.scope_invites;
begin
  if auth.uid() is null then
    raise exception 'Wymagane logowanie' using errcode = '42501';
  end if;
  select * into v_invite from public.scope_invites i
   where (p_id is not null and i.id = p_id) or (p_token is not null and i.token = p_token);
  if v_invite.id is null then
    raise exception 'Zaproszenie nie istnieje albo zostało już przyjęte lub cofnięte' using errcode = 'P0002';
  end if;
  if v_invite.email is distinct from public.caller_email() then
    raise exception 'To zaproszenie jest dla innego adresu e-mail — zaloguj się kontem, na które przyszło' using errcode = '42501';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'Zaproszenie wygasło — poproś o nowe' using errcode = '22023';
  end if;
  insert into public.scope_members (scope_id, user_id, role) values (v_invite.scope_id, auth.uid(), v_invite.role)
    on conflict (scope_id, user_id) do nothing;
  delete from public.scope_invites where id = v_invite.id;
  return v_invite.scope_id;
end $$;

create function public.decline_scope_invite(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.scope_invites where id = p_id and email = public.caller_email();
  return found;
end $$;

create function public.revoke_scope_invite(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_scope uuid := (select i.scope_id from public.scope_invites i where i.id = p_id);
begin
  if v_scope is null then
    return false;
  end if;
  perform public.require_workspace_owner(v_scope);
  delete from public.scope_invites where id = p_id;
  return true;
end $$;

create function public.set_scope_member_role(p_scope uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_workspace_owner(p_scope);
  if p_role not in ('editor', 'viewer') then
    raise exception 'Nieznana rola: %', p_role using errcode = '22023';
  end if;
  update public.scope_members set role = p_role where scope_id = p_scope and user_id = p_user and role <> 'owner';
  if not found then
    raise exception 'Nie ma takiego członka (właściciela nie da się zmienić)' using errcode = 'P0002';
  end if;
end $$;

-- Właściciel usuwa członka; członek (nie właściciel) usuwa siebie — „Opuść przestrzeń”.
create function public.remove_scope_member(p_scope uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user = auth.uid() then
    if public.scope_role(p_scope) = 'owner' then
      raise exception 'Właściciel nie może opuścić własnej przestrzeni' using errcode = '22023';
    end if;
  else
    perform public.require_workspace_owner(p_scope);
  end if;
  delete from public.scope_members where scope_id = p_scope and user_id = p_user and role <> 'owner';
  if not found then
    raise exception 'Nie ma takiego członka' using errcode = 'P0002';
  end if;
end $$;

-- Jak w `*_poc1_sync.sql` + usunięcie / przywrócenie przestrzeni tylko przez właściciela.
create or replace function public.derive_workspace() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := coalesce(auth.uid(), new.created_by);
begin
  new.scope_id := new.id;
  if tg_op = 'INSERT' then
    if owner is null then
      raise exception using errcode = 'TP004', message = 'Przestrzeń bez właściciela';
    end if;
    insert into public.sync_scopes (id, kind, owner_id) values (new.id, 'workspace', owner) on conflict do nothing;
    insert into public.scope_members (scope_id, user_id, role)
      select new.id, owner, 'owner' where exists (select 1 from public.sync_scopes where id = new.id and owner_id = owner)
      on conflict do nothing;
  elsif new.deleted_at is distinct from old.deleted_at and auth.uid() is not null
        and public.scope_role(new.id) is distinct from 'owner' then
    raise exception using errcode = 'TP003', message = 'Przestrzeń usuwa tylko jej właściciel';
  end if;
  return new;
end $$;

revoke execute on function public.caller_email(), public.scope_role(uuid), public.require_workspace_owner(uuid),
  public.share_workspace(uuid, text, text), public.workspace_sharing(uuid), public.my_scope_invites(),
  public.accept_scope_invite(uuid, text), public.decline_scope_invite(uuid), public.revoke_scope_invite(uuid),
  public.set_scope_member_role(uuid, uuid, text), public.remove_scope_member(uuid, uuid)
  from public, anon;
revoke execute on function public.caller_email(), public.require_workspace_owner(uuid) from authenticated;
grant execute on function public.scope_role(uuid), public.share_workspace(uuid, text, text), public.workspace_sharing(uuid),
  public.my_scope_invites(), public.accept_scope_invite(uuid, text), public.decline_scope_invite(uuid),
  public.revoke_scope_invite(uuid), public.set_scope_member_role(uuid, uuid, text), public.remove_scope_member(uuid, uuid)
  to authenticated;
