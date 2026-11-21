-- v1.x: zarządzanie listą zaproszonych z aplikacji (Ustawienia → „Zaproszenia”, tylko administrator).
--
-- Administrator = wiersz w `app_admins` (dopisywany ręcznie w SQL Editor, adresu nie ma w repozytorium):
--   insert into public.app_admins (user_id) select id from auth.users where email = 'twoj@adres.pl';
-- Klient nie czyta tabel bezpośrednio — tylko przez funkcje poniżej, które sprawdzają `is_app_admin()`.

create table public.app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
comment on table public.app_admins is 'Konta z dostępem do zarządzania aplikacją (lista zaproszonych).';
alter table public.app_admins enable row level security;
revoke all on public.app_admins from public, anon, authenticated;
grant select, insert, delete on public.app_admins to service_role;

create function public.is_app_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (select 1 from public.app_admins a where a.user_id = auth.uid())
$$;

create function public.require_app_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_app_admin() then
    raise exception 'Tylko administrator aplikacji' using errcode = '42501';
  end if;
end $$;

-- Lista zaproszonych z liczbą kont, które już powstały z danego adresu / domeny.
create function public.list_invites() returns table (pattern text, note text, created_at timestamptz, accounts integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_app_admin();
  return query
    select a.pattern, a.note, a.created_at,
      (select count(*)::integer from auth.users u
        where lower(u.email) = a.pattern
           or (left(a.pattern, 1) = '@' and right(lower(u.email), length(a.pattern)) = a.pattern))
    from public.allowed_emails a
    order by a.created_at desc, a.pattern;
end $$;

-- Dodanie albo zmiana notatki (wzorzec normalizowany jak w core `invitePattern`; zły — błąd z `check`).
create function public.add_invite(p_pattern text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_app_admin();
  insert into public.allowed_emails (pattern, note)
    values (lower(btrim(p_pattern)), nullif(btrim(left(coalesce(p_note, ''), 200)), ''))
    on conflict (pattern) do update set note = excluded.note;
end $$;

-- Usunięcie z listy (konto, które już powstało, zostaje — usuwa się je osobno).
create function public.remove_invite(p_pattern text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_app_admin();
  delete from public.allowed_emails where pattern = lower(btrim(p_pattern));
  return found;
end $$;

revoke execute on function public.is_app_admin(), public.require_app_admin(), public.list_invites(),
  public.add_invite(text, text), public.remove_invite(text) from public, anon;
grant execute on function public.is_app_admin(), public.list_invites(), public.add_invite(text, text), public.remove_invite(text) to authenticated;
revoke execute on function public.require_app_admin() from authenticated;
