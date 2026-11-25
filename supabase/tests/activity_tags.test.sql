-- v1.x: historia zmian zadania — tagi i wysyłki integracji (migracja *_v1x_activity_tags.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000009a1', 'historia-a@test.local'),
  ('00000000-0000-4000-8000-0000000009a2', 'historia-b@test.local'),
  ('00000000-0000-4000-8000-0000000009a3', 'historia-c@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.h(p_wall bigint) returns text language sql as $$
  select lpad(p_wall::text, 15, '0') || ':00000:dev'
$$;
create function pg_temp.op(p_table text, p_id uuid, p_set jsonb, p_hlc text) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', p_hlc)
$$;
create function pg_temp.push(variadic p_ops jsonb[]) returns jsonb language sql as $$
  select public.push_changes(to_jsonb(p_ops))
$$;
create function pg_temp.last_entry(p_table text) returns public.activity_log language sql as $$
  select * from public.activity_log where table_name = p_table and row_id = 'd9000000-0000-4000-8000-000000000001' order by id desc limit 1
$$;
create function pg_temp.entries(p_table text) returns bigint language sql as $$
  select count(*) from public.activity_log where table_name = p_table and row_id = 'd9000000-0000-4000-8000-000000000001'
$$;

\set A  '''00000000-0000-4000-8000-0000000009a1'''
\set B  '''00000000-0000-4000-8000-0000000009a2'''
\set X  '''00000000-0000-4000-8000-0000000009a3'''
\set W  '''b9000000-0000-4000-8000-000000000001'''
\set L  '''c9000000-0000-4000-8000-000000000001'''
\set L2 '''c9000000-0000-4000-8000-000000000002'''
\set T  '''d9000000-0000-4000-8000-000000000001'''
\set G1 '''a9000000-0000-4000-8000-000000000001'''
\set G2 '''a9000000-0000-4000-8000-000000000002'''
\set TT1 '''f9000000-0000-4000-8000-000000000001'''
\set C  '''e9000000-0000-4000-8000-000000000001'''
\set CX '''e9000000-0000-4000-8000-000000000002'''
\set R  '''e9100000-0000-4000-8000-000000000001'''

select pg_temp.login(:A);
select pg_temp.push(
  pg_temp.op('workspaces', :W, '{"name": "Historia"}', pg_temp.h(1000)),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox'), pg_temp.h(1001)),
  pg_temp.op('lists', :L2, jsonb_build_object('scope_id', :W, 'kind', 'list', 'name', 'Druga'), pg_temp.h(1002)),
  pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Zgłoszenie'), pg_temp.h(1003)),
  pg_temp.op('tags', :G1, jsonb_build_object('scope_id', :A, 'name', 'pilne'), pg_temp.h(1004)),
  pg_temp.op('tags', :G2, jsonb_build_object('scope_id', :A, 'name', 'wysłane'), pg_temp.h(1005)));

-- ── Tagi ──
select pg_temp.push(pg_temp.op('task_tags', :TT1, jsonb_build_object('task_id', :T, 'tag_id', :G1), pg_temp.h(2000)));
reset role;
select is((pg_temp.last_entry('task_tags')).changes, jsonb_build_object('tag_added', jsonb_build_object('id', :G1, 'name', 'pilne')), 'dodanie tagu w historii zadania');
select is((pg_temp.last_entry('task_tags')).actor_id, :A::uuid, 'kto dodał');
select is((pg_temp.last_entry('task_tags')).device_id, 'dev', 'z którego urządzenia');
select is((pg_temp.last_entry('task_tags')).source, null, 'zmiana użytkownika bez źródła');

select pg_temp.login(:A);
select pg_temp.push(pg_temp.op('task_tags', :TT1, '{"sort_key": "n"}', pg_temp.h(2100)));
select pg_temp.push(pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L2), pg_temp.h(2101)));
reset role;
select is(pg_temp.entries('task_tags'), 1::bigint, 'kolejność tagów i przeniesienie zadania to nie zmiana tagu');

select pg_temp.login(:A);
select pg_temp.push(pg_temp.op('task_tags', :TT1, '{"deleted_at": "2026-11-25T10:00:00Z"}', pg_temp.h(2200)));
reset role;
select ok((pg_temp.last_entry('task_tags')).changes -> 'tag_removed' ->> 'name' = 'pilne', 'zdjęcie tagu');
select pg_temp.login(:A);
select pg_temp.push(pg_temp.op('task_tags', :TT1, '{"deleted_at": null}', pg_temp.h(2300)));
reset role;
select ok((pg_temp.last_entry('task_tags')).changes -> 'tag_added' ->> 'name' = 'pilne', 'przywrócenie tagu = dodany');

-- ── Reguła po udanej wysyłce (service_role) ──
select set_config('request.jwt.claims', '', true);
select is(public.plugin_after_send(:A, :T, 'waiting', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tagId', :G2)), array[:G1]::uuid[], :R), null, 'po wysyłce bez uwag');
select set_eq(
  $$ select array(select jsonb_object_keys(changes)) , source, actor_id from public.activity_log
      where row_id = 'd9000000-0000-4000-8000-000000000001' and source is not null $$,
  $$ values (array['status'], '{"kind": "plugin", "ruleId": "e9100000-0000-4000-8000-000000000001"}'::jsonb, '00000000-0000-4000-8000-0000000009a1'::uuid),
            (array['tag_added'], '{"kind": "plugin", "ruleId": "e9100000-0000-4000-8000-000000000001"}'::jsonb, '00000000-0000-4000-8000-0000000009a1'::uuid),
            (array['tag_removed'], '{"kind": "plugin", "ruleId": "e9100000-0000-4000-8000-000000000001"}'::jsonb, '00000000-0000-4000-8000-0000000009a1'::uuid) $$,
  'status i tagi z reguły: źródło, reguła i jej właściciel');
update public.tasks set title = 'Po' where id = :T;
select is((pg_temp.last_entry('tasks')).source, null, 'źródło nie zostaje po wyjściu z funkcji');

-- ── Wysyłki ──
insert into public.plugin_connections (id, user_id, plugin, label, config) values
  (:C, :A, 'gitlab', 'GitLab firmowy', '{}'), (:CX, :X, 'webhook', 'Obcy', '{}');
insert into public.plugin_deliveries (id, user_id, rule_id, connection_id, task_id, source, events, status)
values ('e9300000-0000-4000-8000-000000000001', :A, :R, :C, :T, 'manual', '{task.sent}', 'pending');
update public.plugin_deliveries set status = 'sending' where id = 'e9300000-0000-4000-8000-000000000001';
select is(pg_temp.entries('plugin_deliveries'), 0::bigint, 'wysyłka w toku jeszcze nie jest wpisem');
update public.plugin_deliveries set status = 'sent', sent_at = now(), external_url = 'https://gitlab.example.com/x/1' where id = 'e9300000-0000-4000-8000-000000000001';
update public.plugin_deliveries set status = 'sent', error = 'uwaga' where id = 'e9300000-0000-4000-8000-000000000001';
select is(pg_temp.entries('plugin_deliveries'), 1::bigint, '„Wyślij do…” wysłane — jeden wpis');
select is((pg_temp.last_entry('plugin_deliveries')).changes,
  jsonb_build_object('delivery', jsonb_build_object('id', 'e9300000-0000-4000-8000-000000000001', 'status', 'sent', 'trigger', 'manual', 'ruleId', :R, 'plugin', 'gitlab')),
  'usługa i wynik, bez etykiety połączenia i adresu');
select is((pg_temp.last_entry('plugin_deliveries')).actor_id, :A::uuid, 'kto wysłał');

insert into public.plugin_deliveries (id, user_id, rule_id, connection_id, task_id, source, events, status) values
  ('e9300000-0000-4000-8000-000000000002', :A, :R, :C, :T, 'manual', '{task.sent}', 'skipped'),
  ('e9300000-0000-4000-8000-000000000003', :A, :R, :C, :T, 'event', '{task.tagged}', 'skipped'),
  ('e9300000-0000-4000-8000-000000000004', :A, :R, :C, :T, 'event', '{task.tagged}', 'sent'),
  ('e9300000-0000-4000-8000-000000000005', :X, :R, :CX, :T, 'manual', '{task.sent}', 'skipped');
select set_eq($$ select changes -> 'delivery' ->> 'trigger' as trig, changes -> 'delivery' ->> 'status' as status from public.activity_log
                  where table_name = 'plugin_deliveries' and row_id = 'd9000000-0000-4000-8000-000000000001' $$,
  $$ values ('manual', 'sent'), ('manual', 'skipped'), ('event', 'sent') $$, 'ręczna z każdym wynikiem, zdarzeniowa tylko udana');
select is(pg_temp.entries('plugin_deliveries'), 3::bigint, 'wysyłka osoby bez dostępu do zadania nie zostawia wpisu');

-- ── Widoczność ──
insert into public.scope_members (scope_id, user_id, role) values (:W, :B, 'viewer');
select pg_temp.login(:B);
select ok((select count(*) from public.activity_log where row_id = :T and table_name in ('task_tags', 'plugin_deliveries')) >= 7, 'członek przestrzeni widzi tagi i wysyłki w historii');
reset role;
select set_config('request.jwt.claims', '', true);
update public.lists set guest_access = 'hidden' where id = :L2;
select pg_temp.login(:B);
select is((select count(*) from public.activity_log where row_id = :T), 0::bigint, 'ukryta lista chowa całą historię zadania');
select pg_temp.login(:X);
select is((select count(*) from public.activity_log where row_id = :T), 0::bigint, 'obcy nie widzi historii');

reset role;
select * from finish();
rollback;
