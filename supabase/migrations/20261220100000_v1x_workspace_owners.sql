-- v1.x: rola właściciela przestrzeni dla współpracownika i przekazanie przestrzeni — za jego zgodą.
--
-- Przestrzeń może mieć kilku właścicieli (`scope_members.role = 'owner'`) z tymi samymi uprawnieniami.
-- Jeden z nich jest **głównym** (`sync_scopes.owner_id`, zawsze członek z rolą `owner`): tylko on odbiera
-- rolę innym właścicielom i usuwa ich z przestrzeni; jemu roli nikt nie odbierze.
--   * Propozycja (`scope_owner_offers`, 14 dni) trafia do członka przestrzeni; nic się nie zmienia, dopóki
--     jej nie przyjmie: `after_role` `null` — zostaje kolejnym właścicielem, `editor` / `viewer` / `leave` —
--     przejmuje przestrzeń, a proponujący traci rolę właściciela (zostaje z tą rolą albo wychodzi); po
--     głównym właścicielu przejmujący staje się głównym.
--   * Współwłaściciel (nie główny) może zrzec się roli bez następcy (`resign_workspace_owner`); główny —
--     tylko przekazując przestrzeń, więc nigdy nie zostaje ona bez właściciela.
--   * Usunięcie konta głównego właściciela przekazuje przestrzeń innemu właścicielowi (bez niego znika jak dotąd).
-- Zmiana ról podbija licznik zakresu — sygnał Realtime, po którym członkowie pobierają nową rolę.
-- Klient nie czyta tabeli propozycji — wszystko przez funkcje poniżej.

create table public.scope_owner_offers (
  id uuid primary key default gen_random_uuid(),
  scope_id uuid not null,
  user_id uuid not null,
  offered_by uuid not null,
  after_role text check (after_role in ('editor', 'viewer', 'leave')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  unique (scope_id, user_id, offered_by),
  check (user_id <> offered_by),
  -- Utrata członkostwa (wyjście, usunięcie, usunięte konto) po którejkolwiek stronie unieważnia propozycję.
  foreign key (scope_id, user_id) references public.scope_members (scope_id, user_id) on delete cascade,
  foreign key (scope_id, offered_by) references public.scope_members (scope_id, user_id) on delete cascade
);
create index scope_owner_offers_user on public.scope_owner_offers (user_id);
create index scope_owner_offers_by on public.scope_owner_offers (scope_id, offered_by);
alter table public.scope_owner_offers enable row level security;
revoke all on public.scope_owner_offers from public, anon, authenticated;
grant select, insert, update, delete on public.scope_owner_offers to service_role;

-- ── Pomocnicze ───────────────────────────────────────────────────────────────────────────────

-- Uprawnienia właściciela sprawdzone pod blokadą zakresu (dwie zmiany ról naraz idą po kolei).
create function public.lock_workspace_owner(p_scope uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_workspace_owner(p_scope);
  perform 1 from public.sync_scopes where id = p_scope for update;
  perform public.require_workspace_owner(p_scope);
end $$;

-- Czy zalogowany jest głównym właścicielem przestrzeni.
create function public.is_primary_owner(p_scope uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sync_scopes s where s.id = p_scope and s.kind = 'workspace' and s.owner_id = auth.uid())
$$;

create function public.signal_scope(p_scope uuid) returns void
language sql security definer set search_path = '' as $$
  update public.sync_scopes set sync_version = sync_version + 1 where id = p_scope
$$;

-- Właściciel przestaje nim być: rola `editor` / `viewer` albo wyjście (`leave`); jego propozycje tracą ważność.
create function public.drop_scope_owner(p_scope uuid, p_user uuid, p_after text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.scope_owner_offers where scope_id = p_scope and offered_by = p_user;
  if p_after = 'leave' then
    delete from public.scope_members where scope_id = p_scope and user_id = p_user;
  else
    update public.scope_members set role = p_after where scope_id = p_scope and user_id = p_user;
  end if;
end $$;

-- ── Propozycja i zgoda ───────────────────────────────────────────────────────────────────────

-- Propozycja dla członka: `p_after` `null` — kolejny właściciel, `editor` / `viewer` / `leave` — przekazanie
-- przestrzeni (co z proponującym po przyjęciu). Ponowna zastępuje poprzednią tej samej osobie, a nowe
-- przekazanie — poprzednie przekazanie komukolwiek (przestrzeń przejmuje jedna osoba).
create function public.offer_workspace_ownership(p_scope uuid, p_user uuid, p_after text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_id uuid;
begin
  perform public.lock_workspace_owner(p_scope);
  if p_after is not null and p_after not in ('editor', 'viewer', 'leave') then
    raise exception 'Nieznana rola: %', p_after using errcode = '22023';
  end if;
  if p_user = auth.uid() then
    raise exception 'Jesteś już właścicielem tej przestrzeni' using errcode = '22023';
  end if;
  select m.role into v_role from public.scope_members m where m.scope_id = p_scope and m.user_id = p_user;
  if v_role is null then
    raise exception 'Nie ma takiego członka' using errcode = 'P0002';
  end if;
  if v_role = 'owner' and p_after is null then
    raise exception 'Ta osoba jest już właścicielem przestrzeni' using errcode = '22023';
  end if;
  if p_after is not null then
    delete from public.scope_owner_offers where scope_id = p_scope and offered_by = auth.uid() and after_role is not null;
  end if;
  insert into public.scope_owner_offers (scope_id, user_id, offered_by, after_role)
    values (p_scope, p_user, auth.uid(), p_after)
    on conflict (scope_id, user_id, offered_by) do update
      set id = gen_random_uuid(), after_role = excluded.after_role, created_at = now(), expires_at = now() + interval '14 days'
    returning id into v_id;
  return v_id;
end $$;

-- Wycofanie: proponujący albo główny właściciel.
create function public.cancel_workspace_ownership_offer(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.scope_owner_offers o
   where o.id = p_id and (o.offered_by = auth.uid() or public.is_primary_owner(o.scope_id));
  return found;
end $$;

-- Ważne propozycje dla zalogowanego; `primary` — przejmie rolę głównego właściciela.
create function public.my_ownership_offers() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'scopeId', o.scope_id, 'workspace', w.name, 'offeredBy', lower(u.email),
           'after', o.after_role, 'primary', o.after_role is not null and s.owner_id = o.offered_by,
           'createdAt', o.created_at, 'expiresAt', o.expires_at) order by o.created_at desc), '[]')
    from public.scope_owner_offers o
    join public.sync_scopes s on s.id = o.scope_id
    join public.workspaces w on w.id = o.scope_id and w.deleted_at is null
    left join auth.users u on u.id = o.offered_by
   where o.user_id = auth.uid() and o.expires_at >= now()
$$;

-- Odpowiedź osoby, do której jest propozycja. Przyjęcie zmienia role w jednej transakcji.
create function public.answer_workspace_ownership_offer(p_id uuid, p_accept boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_offer public.scope_owner_offers;
  v_scope uuid := (select o.scope_id from public.scope_owner_offers o where o.id = p_id and o.user_id = auth.uid());
begin
  if v_scope is not null then
    perform 1 from public.sync_scopes where id = v_scope for update;
    delete from public.scope_owner_offers o where o.id = p_id and o.user_id = auth.uid() returning * into v_offer;
  end if;
  if v_offer.id is null then
    raise exception 'Propozycja nie istnieje albo została wycofana' using errcode = 'P0002';
  end if;
  if not coalesce(p_accept, false) then
    return v_scope;
  end if;
  if v_offer.expires_at < now() then
    raise exception 'Propozycja wygasła — poproś o nową' using errcode = '22023';
  end if;
  if not exists (select 1 from public.scope_members m
                  where m.scope_id = v_scope and m.user_id = v_offer.offered_by and m.role = 'owner') then
    raise exception 'Osoba, która to proponowała, nie jest już właścicielem przestrzeni' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspaces w where w.id = v_scope and w.deleted_at is null) then
    raise exception 'Ta przestrzeń została usunięta' using errcode = 'P0002';
  end if;
  update public.scope_members set role = 'owner' where scope_id = v_scope and user_id = auth.uid();
  if v_offer.after_role is not null then
    update public.sync_scopes set owner_id = auth.uid() where id = v_scope and owner_id = v_offer.offered_by;
    perform public.drop_scope_owner(v_scope, v_offer.offered_by, v_offer.after_role);
  end if;
  -- Propozycje samej roli właściciela od innych osób są już zbędne; przekazania dalej mają sens.
  delete from public.scope_owner_offers where scope_id = v_scope and user_id = auth.uid() and after_role is null;
  perform public.signal_scope(v_scope);
  return v_scope;
end $$;

-- ── Zrzeczenie się, zmiana roli, usunięcie ───────────────────────────────────────────────────

-- Współwłaściciel rezygnuje z roli bez następcy (główny właściciel zostaje).
create function public.resign_workspace_owner(p_scope uuid, p_after text default 'editor') returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.lock_workspace_owner(p_scope);
  if coalesce(p_after, '') not in ('editor', 'viewer', 'leave') then
    raise exception 'Nieznana rola: %', p_after using errcode = '22023';
  end if;
  if public.is_primary_owner(p_scope) then
    raise exception 'Główny właściciel zrzeka się roli, przekazując przestrzeń współpracownikowi' using errcode = '22023';
  end if;
  perform public.drop_scope_owner(p_scope, auth.uid(), p_after);
  perform public.signal_scope(p_scope);
end $$;

-- Rola członka (`editor` / `viewer`); właściciela nadaje się propozycją, a odbiera tylko główny właściciel.
create or replace function public.set_scope_member_role(p_scope uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
begin
  perform public.lock_workspace_owner(p_scope);
  if coalesce(p_role, '') not in ('editor', 'viewer') then
    raise exception 'Nieznana rola: %', p_role using errcode = '22023';
  end if;
  if p_user = auth.uid() then
    raise exception 'Z własnej roli właściciela rezygnuje się osobno' using errcode = '22023';
  end if;
  select m.role into v_role from public.scope_members m where m.scope_id = p_scope and m.user_id = p_user;
  if v_role is null then
    raise exception 'Nie ma takiego członka' using errcode = 'P0002';
  end if;
  if v_role = 'owner' then
    if not public.is_primary_owner(p_scope) then
      raise exception 'Rolę innego właściciela zmienia tylko główny właściciel' using errcode = '42501';
    end if;
    perform public.drop_scope_owner(p_scope, p_user, p_role);
  else
    update public.scope_members set role = p_role where scope_id = p_scope and user_id = p_user;
  end if;
  perform public.signal_scope(p_scope);
end $$;

-- Właściciel usuwa członka (innego właściciela — tylko główny); członek (nie właściciel) usuwa siebie.
create or replace function public.remove_scope_member(p_scope uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_drop_owner boolean := false;
begin
  if p_user = auth.uid() then
    if public.scope_role(p_scope) = 'owner' then
      raise exception 'Właściciel nie może opuścić przestrzeni — najpierw zrzeknij się tej roli' using errcode = '22023';
    end if;
  else
    perform public.lock_workspace_owner(p_scope);
    v_drop_owner := public.is_primary_owner(p_scope);
    if not v_drop_owner and exists (select 1 from public.scope_members m where m.scope_id = p_scope and m.user_id = p_user and m.role = 'owner') then
      raise exception 'Innego właściciela usuwa tylko główny właściciel' using errcode = '42501';
    end if;
  end if;
  delete from public.scope_members where scope_id = p_scope and user_id = p_user and (role <> 'owner' or v_drop_owner);
  if not found then
    raise exception 'Nie ma takiego członka' using errcode = 'P0002';
  end if;
  perform public.signal_scope(p_scope);
end $$;

-- Jak w `*_v1x_workspace_sharing.sql` + `primary` (główny właściciel) i propozycje własności: właściciele
-- widzą wszystkie, pozostali — swoje.
create or replace function public.workspace_sharing(p_scope uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := public.scope_role(p_scope);
begin
  if v_role is null then
    raise exception 'Brak dostępu do przestrzeni' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'role', v_role,
    'members', (select coalesce(jsonb_agg(jsonb_build_object('userId', m.user_id, 'email', lower(u.email), 'role', m.role, 'me', m.user_id = auth.uid(),
                    'primary', m.user_id = s.owner_id)
                  order by (m.user_id = s.owner_id) desc, case m.role when 'owner' then 0 when 'editor' then 1 else 2 end, lower(u.email)), '[]')
                  from public.scope_members m
                  join public.sync_scopes s on s.id = m.scope_id
                  join auth.users u on u.id = m.user_id
                 where m.scope_id = p_scope),
    'offers', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'userId', o.user_id, 'email', lower(t.email), 'offeredBy', lower(b.email),
                    'mine', o.offered_by = auth.uid(), 'after', o.after_role, 'createdAt', o.created_at, 'expiresAt', o.expires_at,
                    'expired', o.expires_at < now()) order by o.created_at desc), '[]')
                 from public.scope_owner_offers o
                 join auth.users t on t.id = o.user_id
                 join auth.users b on b.id = o.offered_by
                where o.scope_id = p_scope and (v_role = 'owner' or o.user_id = auth.uid())),
    'invites', case when v_role = 'owner' then
                 (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role, 'token', i.token,
                    'createdAt', i.created_at, 'expiresAt', i.expires_at, 'expired', i.expires_at < now()) order by i.created_at desc), '[]')
                    from public.scope_invites i where i.scope_id = p_scope)
               else '[]'::jsonb end);
end $$;

-- ── Usunięcie konta głównego właściciela ─────────────────────────────────────────────────────

-- Przestrzeń z innym właścicielem przechodzi na niego (najstarsze konto), zanim kaskada
-- z `sync_scopes.owner_id` by ją usunęła; czekające zaproszenia też.
create function public.hand_over_workspaces() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_scope record;
begin
  for v_scope in
    select s.id, (select m.user_id from public.scope_members m join auth.users u on u.id = m.user_id
                   where m.scope_id = s.id and m.role = 'owner' and m.user_id <> old.id
                   order by u.created_at, u.id limit 1) as heir
      from public.sync_scopes s
     where s.owner_id = old.id and s.kind = 'workspace'
  loop
    if v_scope.heir is not null then
      update public.sync_scopes set owner_id = v_scope.heir, sync_version = sync_version + 1 where id = v_scope.id;
      update public.scope_invites set invited_by = v_scope.heir where scope_id = v_scope.id and invited_by = old.id;
    end if;
  end loop;
  return old;
end $$;
create trigger hand_over_workspaces before delete on auth.users for each row execute function public.hand_over_workspaces();

-- ── Kalendarz Google ─────────────────────────────────────────────────────────────────────────

-- Jak w `*_etap12_calendar_tasks.sql`, ale zmiana zadania budzi wysyłkę u każdego właściciela przestrzeni.
create or replace function public.calendar_task_changed() returns trigger
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
    select distinct m.user_id
      from public.scope_members m
      join public.profiles p on p.id = m.user_id
     where m.scope_id in (new.scope_id, case when tg_op = 'UPDATE' then old.scope_id end)
       and m.role = 'owner'
       and p.calendar_sync -> 'workspaceIds' ? m.scope_id::text
  loop
    perform public.calendar_kick(owner);
  end loop;
  return null;
end $$;

-- ── Uprawnienia ──────────────────────────────────────────────────────────────────────────────

revoke execute on function public.lock_workspace_owner(uuid), public.is_primary_owner(uuid), public.signal_scope(uuid),
  public.drop_scope_owner(uuid, uuid, text), public.hand_over_workspaces(),
  public.offer_workspace_ownership(uuid, uuid, text), public.cancel_workspace_ownership_offer(uuid), public.my_ownership_offers(),
  public.answer_workspace_ownership_offer(uuid, boolean), public.resign_workspace_owner(uuid, text)
  from public, anon, authenticated;
grant execute on function public.offer_workspace_ownership(uuid, uuid, text), public.cancel_workspace_ownership_offer(uuid),
  public.my_ownership_offers(), public.answer_workspace_ownership_offer(uuid, boolean), public.resign_workspace_owner(uuid, text)
  to authenticated;
