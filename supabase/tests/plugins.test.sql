-- v1.x: integracje wychodzące, etap I1 (migracja *_v1x_plugins.sql) — reguły i prośby „Wyślij do…”
-- (zakres osobisty, sprawdzenia dostępu), kolejka `plugin_outbox`, połączenia bez sekretów dla klienta,
-- Vault, wybór należnych wysyłek z limitem na połączenie, „Ponów”, rzut zadania, dzierżawa.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000001a1', 'pluginy-a@test.local'),
  ('00000000-0000-4000-8000-0000000001a2', 'pluginy-b@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.h(p_wall bigint, p_node text default 'dev') returns text language sql as $$
  select lpad(p_wall::text, 15, '0') || ':00000:' || p_node
$$;
create function pg_temp.op(p_table text, p_id uuid, p_set jsonb, p_hlc text) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', p_hlc)
$$;
create function pg_temp.push(variadic p_ops jsonb[]) returns jsonb language sql as $$
  select public.push_changes(to_jsonb(p_ops))
$$;
create function pg_temp.code(p_result jsonb) returns text language sql as $$
  select p_result -> 'rejected' -> 0 ->> 'code'
$$;
create function pg_temp.rule(p_connection uuid) returns jsonb language sql as $$
  select jsonb_build_object('name', 'Do n8n', 'connection_id', p_connection, 'enabled', true, 'trigger', '{"kind": "manual"}'::jsonb,
                            'action', '{"message": "{{title}}"}'::jsonb, 'options', '{}'::jsonb, 'sort_key', 'n')
$$;

\set A  '''00000000-0000-4000-8000-0000000001a1'''
\set B  '''00000000-0000-4000-8000-0000000001a2'''
\set W  '''b7000000-0000-4000-8000-000000000001'''
\set L  '''c7000000-0000-4000-8000-000000000001'''
\set T  '''d7000000-0000-4000-8000-000000000001'''
\set C  '''e7000000-0000-4000-8000-000000000001'''
\set CB '''e7000000-0000-4000-8000-000000000002'''
\set R  '''e7100000-0000-4000-8000-000000000001'''
\set RB '''e7100000-0000-4000-8000-000000000002'''
\set Q  '''e7200000-0000-4000-8000-000000000001'''
\set QB '''e7200000-0000-4000-8000-000000000002'''

-- Połączenia zapisuje Edge Function (service_role).
insert into public.plugin_connections (id, user_id, plugin, label, config) values
  (:C, :A, 'webhook', 'n8n', '{"url": "https://n8n.example.com/hook"}'),
  (:CB, :B, 'webhook', 'Make', '{"url": "https://hook.example.com/b"}');
select ok((select row_version > 0 from public.plugin_connections where id = :C), 'połączenie podbija licznik zakresu osobistego');

select pg_temp.login(:A);
select pg_temp.push(
  pg_temp.op('workspaces', :W, '{"name": "Praca"}', pg_temp.h(1000)),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox'), pg_temp.h(1001)),
  pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Zgłoś błąd', 'priority', 2), pg_temp.h(1002)));

-- ── Reguły ──
select is((pg_temp.push(pg_temp.op('plugin_rules', :R, pg_temp.rule(:C), pg_temp.h(2000))) ->> 'applied')::int, 1, 'reguła z własnym połączeniem zapisana');
select is((select scope_id from public.plugin_rules where id = :R), :A::uuid, 'reguła w zakresie osobistym');
select pg_temp.login(:B);
select is(pg_temp.code(pg_temp.push(pg_temp.op('plugin_rules', :RB, pg_temp.rule(:C), pg_temp.h(2100)))), 'TP003', 'reguła z cudzym połączeniem odrzucona');
select is((pg_temp.push(pg_temp.op('plugin_rules', :RB, pg_temp.rule(:CB), pg_temp.h(2101))) ->> 'applied')::int, 1, 'druga osoba — własna reguła');
select is(pg_temp.code(pg_temp.push(pg_temp.op('plugin_rules', :R, '{"enabled": false}', pg_temp.h(2102)))), 'TP003', 'cudzej reguły nie można zmienić');

-- ── Prośby „Wyślij do…” ──
select pg_temp.login(:A);
select is((pg_temp.push(pg_temp.op('plugin_requests', :Q, jsonb_build_object('rule_id', :R, 'task_id', :T, 'requested_at', '2026-11-23T10:00:00Z'), pg_temp.h(3000))) ->> 'applied')::int, 1,
  'prośba o wysyłkę zapisana');
reset role;
select results_eq($$ select table_name, row_id, task_id, origin, processed_at is null from public.plugin_outbox where row_id = 'e7200000-0000-4000-8000-000000000001' $$,
  $$ values ('plugin_requests'::text, 'e7200000-0000-4000-8000-000000000001'::uuid, 'd7000000-0000-4000-8000-000000000001'::uuid, 'client'::text, true) $$,
  'prośba trafia do kolejki plugin_outbox');
select pg_temp.login(:A);
select is((pg_temp.push(pg_temp.op('plugin_requests', :Q, jsonb_build_object('rule_id', :R, 'task_id', :T, 'requested_at', '2026-11-23T10:00:00Z'), pg_temp.h(3000))) ->> 'applied')::int, 1,
  'ponowne wysłanie tej samej operacji (powtórka z outboxu klienta)');
reset role;
select is((select count(*)::int from public.plugin_outbox where row_id = :Q), 1, 'powtórka nie dodaje drugiego zdarzenia');
select pg_temp.login(:A);
select is(pg_temp.code(pg_temp.push(pg_temp.op('plugin_requests', :Q, jsonb_build_object('task_id', :R), pg_temp.h(3100)))), 'TP003', 'prośby nie można zmienić');

select pg_temp.login(:B);
select is(pg_temp.code(pg_temp.push(pg_temp.op('plugin_requests', :QB, jsonb_build_object('rule_id', :R, 'task_id', :T, 'requested_at', '2026-11-23T10:00:00Z'), pg_temp.h(3200)))), 'TP003',
  'prośba z cudzą regułą odrzucona');
select is(pg_temp.code(pg_temp.push(pg_temp.op('plugin_requests', :QB, jsonb_build_object('rule_id', :RB, 'task_id', :T, 'requested_at', '2026-11-23T10:00:00Z'), pg_temp.h(3201)))), 'TP003',
  'prośba o zadanie bez dostępu odrzucona');

-- ── Odczyt klienta ──
select is((select count(*)::int from public.plugin_connections), 1, 'klient widzi tylko swoje połączenia');
select throws_ok($$ select secret_id from public.plugin_connections $$, '42501', null, 'identyfikator sekretu niewidoczny dla klienta');
select throws_ok($$ insert into public.plugin_deliveries (id, user_id, source) values (gen_random_uuid(), auth.uid(), 'manual') $$, '42501', null, 'klient nie pisze wysyłek');
select throws_ok($$ select * from public.claim_plugin_deliveries() $$, '42501', null, 'funkcje serwera niedostępne dla klienta');
select pg_temp.login(:A);
select ok((select (public.pull_changes() -> 'tables' -> 'plugin_connections') @> jsonb_build_array(jsonb_build_object('id', :C, 'label', 'n8n', 'plugin', 'webhook'))),
  'połączenie w pull_changes jako tabela tylko do odczytu');
select ok((select not (public.pull_changes() -> 'tables' -> 'plugin_connections' -> 0 ? 'secret_id')), 'pull_changes bez identyfikatora sekretu');
select is((select jsonb_array_length(public.pull_changes() -> 'tables' -> 'plugin_requests')), 1, 'prośba w pull_changes (synchronizowana)');

-- ── Serwer: Vault, rzut zadania, wysyłki ──
reset role;
select public.plugin_secret_set(:C, 'tajne-1');
select public.plugin_secret_set(:C, 'tajne-2');
select is(public.plugin_secret_get(:C), 'tajne-2', 'sekret połączenia w Vault (nadpisany)');
select ok((select (public.plugin_task_context(:T, :A) ->> 'list') = 'Inbox' and (public.plugin_task_context(:T, :A) ->> 'workspace') = 'Praca'),
  'rzut zadania z nazwą listy i przestrzeni');
select is(public.plugin_task_context(:T, :B), null, 'bez dostępu do przestrzeni — brak rzutu');

-- Limit 2 / min na połączenie: jedna wysyłka już poszła, z trzech należnych bierze się jedna.
insert into public.plugin_deliveries (id, user_id, rule_id, connection_id, task_id, source, status, sent_at, next_attempt_at) values
  ('f7000000-0000-4000-8000-000000000001', :A, :R, :C, :T, 'manual', 'sent', now(), now() - interval '1 minute'),
  ('f7000000-0000-4000-8000-000000000002', :A, :R, :C, :T, 'manual', 'pending', null, now() - interval '3 seconds'),
  ('f7000000-0000-4000-8000-000000000003', :A, :R, :C, :T, 'manual', 'pending', null, now() - interval '2 seconds'),
  ('f7000000-0000-4000-8000-000000000004', :A, :R, :C, :T, 'manual', 'pending', null, now() + interval '1 hour'),
  ('f7000000-0000-4000-8000-000000000005', :A, :R, :C, :T, 'manual', 'failed', null, now());
select results_eq($$ select id, status, attempts from public.claim_plugin_deliveries(50, 2) $$,
  $$ values ('f7000000-0000-4000-8000-000000000002'::uuid, 'sending'::text, 1) $$, 'należne wysyłki z limitem na połączenie, najstarsza pierwsza');

select pg_temp.login(:B);
select throws_ok($$ select public.retry_plugin_delivery('f7000000-0000-4000-8000-000000000005') $$, 'P0002', null, 'cudzej wysyłki nie można ponowić');
select pg_temp.login(:A);
select lives_ok($$ select public.retry_plugin_delivery('f7000000-0000-4000-8000-000000000005') $$, '„Ponów” własnej nieudanej wysyłki');
select is((select status from public.plugin_deliveries where id = 'f7000000-0000-4000-8000-000000000005'), 'pending', 'po „Ponów” wysyłka czeka');

reset role;
select ok(public.plugin_lock('test', 'h1') and not public.plugin_lock('test', 'h2'), 'dzierżawa: drugi przebieg czeka');
select ok(public.plugin_unlock('test', 'h1') and not public.plugin_unlock('test', 'h1'), 'oddanie dzierżawy powtarza przebieg, o który ktoś prosił');

select public.plugin_connection_remove(:C);
select ok((select deleted_at is not null and secret_id is null and status = 'disabled' from public.plugin_connections where id = :C)
          and public.plugin_secret_get(:C) is null
          and not exists (select 1 from vault.secrets where name = 'plugin_connection:' || 'e7000000-0000-4000-8000-000000000001'),
  'usunięcie połączenia usuwa sekret z Vault');

select * from finish();
rollback;
