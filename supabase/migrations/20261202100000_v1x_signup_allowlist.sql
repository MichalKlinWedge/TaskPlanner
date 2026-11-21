-- v1.x: rejestracja tylko dla zaproszonych (hook Supabase Auth „Before User Created”).
--
-- Nowe konto (link z maila, pierwsze logowanie Google) powstaje tylko dla adresu z `allowed_emails`:
-- dokładny adres („jan@example.com”) albo cała domena („@example.com”). Istniejących kont hook
-- nie dotyczy (działa tylko przy tworzeniu użytkownika). Odmowa niesie w komunikacie znacznik
-- `signup_not_invited` (core `SIGNUP_NOT_INVITED`), po którym aplikacje pokazują polski komunikat.
--
-- Hook włącza się osobno: lokalnie `[auth.hook.before_user_created]` w `supabase/config.toml`,
-- w chmurze Dashboard → Authentication → Hooks → „Before User Created” → Postgres →
-- `public.hook_before_user_created`. Bez włączenia ta migracja niczego nie zmienia.
-- Zaproszenie: `insert into public.allowed_emails (pattern, note) values ('jan@example.com', 'Jan');`
-- (SQL Editor jako `postgres` albo `service_role`).

create table public.allowed_emails (
  pattern text primary key check (pattern = lower(btrim(pattern)) and pattern ~ '^[^@[:space:]]*@[^@[:space:]]+\.[^@[:space:]]+$'),
  note text,
  created_at timestamptz not null default now()
);
comment on table public.allowed_emails is 'Adresy (albo „@domena”), z których można założyć konto — hook hook_before_user_created.';

alter table public.allowed_emails enable row level security;
revoke all on public.allowed_emails from public, anon, authenticated;
grant select, insert, update, delete on public.allowed_emails to service_role;
grant select on public.allowed_emails to supabase_auth_admin;
create policy auth_admin_read on public.allowed_emails for select to supabase_auth_admin using (true);

-- Bez `security definer` (zalecenie Supabase): wywołuje ją `supabase_auth_admin`, który ma odczyt tabeli.
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(event->'user'->>'email', '')));
begin
  if v_email <> '' and exists (
    select 1 from public.allowed_emails a
    where a.pattern = v_email
       or (left(a.pattern, 1) = '@' and right(v_email, length(a.pattern)) = a.pattern)
  ) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'signup_not_invited: rejestracja tylko dla zaproszonych adresów'));
end $$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
