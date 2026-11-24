-- v1.x: asystent AI, konto AI użytkownika (migracja *_v1x_ai.sql) — zakres osobisty, zapis tylko serwera,
-- klucz w Vault, klient bez `secret_id` (RLS, granty kolumn, `pull_changes`), jedno konto na dostawcę,
-- odłączenie i usunięcie konta Task Plannera zabierają klucz.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000002a1', 'ai-a@test.local'),
  ('00000000-0000-4000-8000-0000000002a2', 'ai-b@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;

\set A  '''00000000-0000-4000-8000-0000000002a1'''
\set B  '''00000000-0000-4000-8000-0000000002a2'''
\set K  '''e8000000-0000-4000-8000-000000000001'''
\set KB '''e8000000-0000-4000-8000-000000000002'''

-- Konto zapisuje Edge Function `ai` (service_role).
insert into public.ai_accounts (id, user_id, provider, key_hint, billing_confirmed_at) values
  (:K, :A, 'gemini', '…x1Y2', now()),
  (:KB, :B, 'gemini', '…b9Z0', now());
select ok((select row_version > 0 and status = 'unverified' and model is null and models = '[]' from public.ai_accounts where id = :K),
  'nowe konto: niesprawdzone, bez modelu, podbija licznik zakresu osobistego');
select throws_ok($$ insert into public.ai_accounts (user_id, provider, billing_confirmed_at) values ('00000000-0000-4000-8000-0000000002a1', 'gemini', now()) $$,
  '23505', null, 'najwyżej jedno aktywne konto na dostawcę');
select throws_ok($$ insert into public.ai_accounts (user_id, provider, billing_confirmed_at) values ('00000000-0000-4000-8000-0000000002a1', 'openai', now()) $$,
  '23514', null, 'na start tylko Gemini');
select throws_ok($$ insert into public.ai_accounts (user_id, provider) values ('00000000-0000-4000-8000-0000000002a2', 'gemini') $$,
  '23502', null, 'bez oświadczenia o rozliczeniu nie ma konta');
select throws_ok($$ update public.ai_accounts set model = 'Gemini 3.5 Flash-Lite' where id = 'e8000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'model tylko jako identyfikator');

select public.ai_secret_set(:K, 'AQ.klucz-testowy-1');
select public.ai_secret_set(:K, 'AQ.klucz-testowy-2');
select is(public.ai_secret_get(:K), 'AQ.klucz-testowy-2', 'klucz w Vault (nadpisany przy zmianie klucza)');
select is((select count(*)::int from vault.secrets where name = 'ai_account:' || 'e8000000-0000-4000-8000-000000000001'), 1, 'jeden sekret na konto');
update public.ai_accounts
   set status = 'active', model = 'gemini-3.5-flash-lite', verified_at = now(),
       models = '[{"id": "gemini-3.5-flash-lite", "label": "Gemini 3.5 Flash-Lite"}]'
 where id = :K;

-- ── Klient ──
select pg_temp.login(:A);
select is((select count(*)::int from public.ai_accounts), 1, 'klient widzi tylko swoje konto (RLS)');
select is((select model from public.ai_accounts), 'gemini-3.5-flash-lite', 'klient czyta model i stan');
select throws_ok($$ select secret_id from public.ai_accounts $$, '42501', null, 'identyfikator sekretu niewidoczny dla klienta');
select throws_ok($$ select * from public.ai_accounts $$, '42501', null, 'select * odrzucony (kolumna sekretu bez grantu)');
select throws_ok($$ update public.ai_accounts set model = 'gemini-3.8-flash' $$, '42501', null, 'klient nie zmienia konta');
select throws_ok($$ insert into public.ai_accounts (user_id, provider, billing_confirmed_at) values (auth.uid(), 'gemini', now()) $$, '42501', null, 'klient nie zakłada konta');
select throws_ok($$ delete from public.ai_accounts $$, '42501', null, 'klient nie usuwa konta');
select throws_ok($$ select public.ai_secret_get('e8000000-0000-4000-8000-000000000001') $$, '42501', null, 'klucz z Vault niedostępny dla klienta');
select ok((select (public.pull_changes() -> 'tables' -> 'ai_accounts') @> jsonb_build_array(jsonb_build_object('id', :K, 'provider', 'gemini', 'model', 'gemini-3.5-flash-lite', 'key_hint', '…x1Y2', 'status', 'active'))),
  'konto w pull_changes jako tabela tylko do odczytu');
select ok((select not (public.pull_changes() -> 'tables' -> 'ai_accounts' -> 0 ? 'secret_id')
              and jsonb_array_length(public.pull_changes() -> 'tables' -> 'ai_accounts') = 1),
  'pull_changes: tylko własne konto, bez identyfikatora sekretu');
select ok((select position('AQ.klucz' in public.pull_changes()::text) = 0), 'klucza nie ma nigdzie w pull_changes');

-- ── Odłączenie i usunięcie konta Task Plannera ──
reset role;
select public.ai_account_remove(:K);
select ok((select deleted_at is not null and secret_id is null from public.ai_accounts where id = :K)
          and public.ai_secret_get(:K) is null
          and not exists (select 1 from vault.secrets where name = 'ai_account:' || 'e8000000-0000-4000-8000-000000000001'),
  '„Odłącz” usuwa klucz z Vault, wiersz zostaje z deleted_at');

select public.ai_secret_set(:KB, 'AQ.klucz-b');
delete from auth.users where id = :B;
select ok(not exists (select 1 from vault.secrets where name = 'ai_account:' || 'e8000000-0000-4000-8000-000000000002')
          and not exists (select 1 from public.ai_accounts where id = :KB),
  'usunięcie konta Task Plannera zabiera konto AI i klucz z Vault');

select * from finish();
rollback;
