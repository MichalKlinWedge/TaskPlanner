-- v1.x: rejestracja tylko z listy zaproszonych (`allowed_emails`, `hook_before_user_created`).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into public.allowed_emails (pattern, note) values ('jan@example.com', 'Jan'), ('@firma.pl', 'cała domena');

create function pg_temp.hook(p_email text) returns jsonb language sql as $$
  select public.hook_before_user_created(jsonb_build_object(
    'metadata', jsonb_build_object('name', 'before-user-created'),
    'user', jsonb_build_object('email', p_email, 'app_metadata', jsonb_build_object('provider', 'email'))))
$$;

select is(pg_temp.hook('jan@example.com'), '{}'::jsonb, 'adres z listy');
select is(pg_temp.hook('  Jan@Example.COM '), '{}'::jsonb, 'wielkość liter i spacje bez znaczenia');
select is(pg_temp.hook('ktokolwiek@firma.pl'), '{}'::jsonb, 'adres z domeny z listy');
select is(pg_temp.hook('anna@example.com')->'error'->>'http_code', '403', 'inny adres w tej samej domenie — odmowa');
select ok(pg_temp.hook('ktos@nie-firma.pl') ? 'error', 'domena kończąca się tak samo — odmowa');
select ok(pg_temp.hook('jan@example.com.evil.pl') ? 'error', 'adres z listy jako przedrostek — odmowa');
select ok(pg_temp.hook('') ? 'error', 'pusty adres (np. telefon) — odmowa');
select ok(pg_temp.hook(null) ? 'error', 'brak adresu — odmowa');
select ok(pg_temp.hook('obcy@example.org')->'error'->>'message' like 'signup_not_invited:%', 'komunikat ze znacznikiem dla aplikacji');

select throws_ok($$ insert into public.allowed_emails (pattern) values ('Duze@Litery.pl') $$, '23514', null, 'wzorzec tylko małymi literami');

select ok(has_function_privilege('supabase_auth_admin', 'public.hook_before_user_created(jsonb)', 'execute'), 'Auth wywołuje hook');
select ok(not has_function_privilege('authenticated', 'public.hook_before_user_created(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.hook_before_user_created(jsonb)', 'execute'), 'klient nie wywołuje hooka');
select ok(not has_table_privilege('authenticated', 'public.allowed_emails', 'select')
  and not has_table_privilege('anon', 'public.allowed_emails', 'select'), 'klient nie widzi listy zaproszonych');

select * from finish();
rollback;
