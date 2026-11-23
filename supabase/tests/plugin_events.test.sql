-- v1.x: integracje wychodzące, etap I2 (migracja *_v1x_plugin_events.sql) — wyzwalacze zdarzeń zadań
-- → `plugin_outbox` (tylko przy włączonej regule zdarzeniowej kogoś z przestrzeni), rzut zadania przed / po,
-- tagi, ukończenie wystąpienia serii, komentarz, pochodzenie z integracji, reguły osób widzących zadanie.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000002a1', 'zdarzenia-a@test.local'),
  ('00000000-0000-4000-8000-0000000002a2', 'zdarzenia-b@test.local');

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
create function pg_temp.outbox(p_table text) returns bigint language sql as $$
  select count(*) from public.plugin_outbox where table_name = p_table and task_id = 'd8000000-0000-4000-8000-000000000001'
$$;
create function pg_temp.last_row(p_table text) returns public.plugin_outbox language sql as $$
  select * from public.plugin_outbox where table_name = p_table order by id desc limit 1
$$;

\set A  '''00000000-0000-4000-8000-0000000002a1'''
\set B  '''00000000-0000-4000-8000-0000000002a2'''
\set W  '''b8000000-0000-4000-8000-000000000001'''
\set L  '''c8000000-0000-4000-8000-000000000001'''
\set LH '''c8000000-0000-4000-8000-000000000002'''
\set T  '''d8000000-0000-4000-8000-000000000001'''
\set TH '''d8000000-0000-4000-8000-000000000002'''
\set G  '''f8000000-0000-4000-8000-000000000001'''
\set TG '''f8100000-0000-4000-8000-000000000001'''
\set C  '''e8000000-0000-4000-8000-000000000001'''
\set R  '''e8100000-0000-4000-8000-000000000001'''
\set RB '''e8100000-0000-4000-8000-000000000002'''
\set K  '''e8300000-0000-4000-8000-000000000001'''
\set CP '''e8400000-0000-4000-8000-000000000001'''

insert into public.plugin_connections (id, user_id, plugin, label, config) values
  (:C, :A, 'webhook', 'n8n', '{"url": "https://n8n.example.com/hook"}'),
  ('e8000000-0000-4000-8000-000000000002', :B, 'webhook', 'Make', '{"url": "https://hook.example.com/b"}');

select pg_temp.login(:A);
select pg_temp.push(
  pg_temp.op('workspaces', :W, '{"name": "Zgłoszenia"}', pg_temp.h(1000)),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox'), pg_temp.h(1001)),
  pg_temp.op('lists', :LH, jsonb_build_object('scope_id', :W, 'kind', 'list', 'name', 'Tajne', 'guest_access', 'hidden'), pg_temp.h(1002)),
  pg_temp.op('tags', :G, '{"name": "zgłoś"}', pg_temp.h(1003)),
  pg_temp.op('tasks', :T, jsonb_build_object('list_id', :L, 'title', 'Bez reguły'), pg_temp.h(1004)),
  pg_temp.op('plugin_rules', :R, jsonb_build_object('name', 'Ręczna', 'connection_id', :C, 'enabled', true, 'trigger', '{"kind": "manual"}'::jsonb,
    'action', '{}'::jsonb, 'options', '{}'::jsonb, 'sort_key', 'n'), pg_temp.h(1005)));
reset role;
select is(pg_temp.outbox('tasks'), 0::bigint, 'bez reguły zdarzeniowej zmiana zadania nie trafia do kolejki');

-- Reguła zdarzeniowa (wyłączona) — dalej nic.
select pg_temp.login(:A);
select pg_temp.push(pg_temp.op('plugin_rules', :R, '{"trigger": {"kind": "event", "events": ["task.tagged"]}, "enabled": false}', pg_temp.h(2000)));
select pg_temp.push(pg_temp.op('tasks', :T, '{"priority": 1}', pg_temp.h(2001)));
reset role;
select is(pg_temp.outbox('tasks'), 0::bigint, 'wyłączona reguła zdarzeniowa — nadal nic');

select pg_temp.login(:A);
select pg_temp.push(pg_temp.op('plugin_rules', :R, '{"enabled": true}', pg_temp.h(2100)));
select pg_temp.push(pg_temp.op('tasks', :T, '{"title": "Tylko tytuł"}', pg_temp.h(2101)));
reset role;
select is(pg_temp.outbox('tasks'), 0::bigint, 'zmiana pola spoza rzutu (tytuł) — nic');

select pg_temp.login(:A);
select pg_temp.push(pg_temp.op('tasks', :T, '{"status": "done", "due_date": "2026-11-24"}', pg_temp.h(2200)));
reset role;
select is(pg_temp.outbox('tasks'), 1::bigint, 'ukończenie i termin — jeden wiersz kolejki');
select is((pg_temp.last_row('tasks')).before ->> 'status', 'todo', 'stan przed: do zrobienia');
select is((pg_temp.last_row('tasks')).after ->> 'status', 'done', 'stan po: ukończone');
select is((pg_temp.last_row('tasks')).after ->> 'dueDate', '2026-11-24', 'stan po: termin');
select is(((pg_temp.last_row('tasks')).after ->> 'priority')::int, 1, 'stan po: priorytet (do filtra)');
select is((pg_temp.last_row('tasks')).origin, 'client', 'zmiana z aplikacji');

-- Tag dodany i zdjęty.
select pg_temp.login(:A);
select pg_temp.push(pg_temp.op('task_tags', :TG, jsonb_build_object('task_id', :T, 'tag_id', :G), pg_temp.h(2300)));
reset role;
select is((pg_temp.last_row('task_tags')).before -> 'tagIds', '[]'::jsonb, 'tag dodany: przed — bez tagów');
select is((pg_temp.last_row('task_tags')).after -> 'tagIds', jsonb_build_array(:G), 'tag dodany: po — z tagiem');
select pg_temp.login(:A);
select pg_temp.push(pg_temp.op('task_tags', :TG, '{"deleted_at": "2026-11-23T10:00:00Z"}', pg_temp.h(2400)));
reset role;
select is((pg_temp.last_row('task_tags')).before -> 'tagIds', jsonb_build_array(:G), 'tag zdjęty: przed — z tagiem');
select is((pg_temp.last_row('task_tags')).after -> 'tagIds', '[]'::jsonb, 'tag zdjęty: po — bez tagu');

-- Ukończenie wystąpienia serii i komentarz.
select pg_temp.login(:A);
select pg_temp.push(
  pg_temp.op('task_completions', :CP, jsonb_build_object('task_id', :T, 'occurrence_date', '2026-11-24', 'kind', 'done', 'completed_at', '2026-11-23T10:00:00Z'), pg_temp.h(2500)),
  pg_temp.op('task_comments', :K, jsonb_build_object('task_id', :T, 'body', 'Drukarka znów stoi', 'posted_at', '2026-11-23T10:00:00Z'), pg_temp.h(2501)));
reset role;
select is((pg_temp.last_row('task_completions')).extra, jsonb_build_object('completion', jsonb_build_object('id', :CP, 'occurrence', '2026-11-24')), 'ukończenie wystąpienia — dodatek z dniem');
select is((pg_temp.last_row('task_comments')).extra, jsonb_build_object('comment', jsonb_build_object('id', :K)), 'komentarz — dodatek z id');
select ok((pg_temp.last_row('task_comments')).before = (pg_temp.last_row('task_comments')).after, 'komentarz nie zmienia rzutu zadania');

-- Pochodzenie z integracji (kalendarz / e-mail ustawiają `taskplanner.source`).
select set_config('taskplanner.source', 'calendar', true);
update public.tasks set due_date = '2026-11-30' where id = :T;
select set_config('taskplanner.source', '', true);
select is((pg_temp.last_row('tasks')).origin, 'integration', 'zmiana z integracji oznaczona');

-- Reguły osób widzących zadanie: gość nie dostaje zadań z listy ukrytej przed gośćmi.
insert into public.scope_members (scope_id, user_id, role) values (:W, :B, 'editor');
select pg_temp.login(:B);
select pg_temp.push(pg_temp.op('plugin_rules', :RB, jsonb_build_object('name', 'Gość', 'connection_id', 'e8000000-0000-4000-8000-000000000002', 'enabled', true,
  'trigger', '{"kind": "event", "events": ["task.created"]}'::jsonb, 'action', '{}'::jsonb, 'options', '{}'::jsonb, 'sort_key', 'n'), pg_temp.h(3000)));
select pg_temp.login(:A);
select pg_temp.push(pg_temp.op('tasks', :TH, jsonb_build_object('list_id', :LH, 'title', 'Ukryte'), pg_temp.h(3001)));
reset role;
select set_eq($$ select id from public.plugin_event_rules('d8000000-0000-4000-8000-000000000001') $$,
  $$ values ('e8100000-0000-4000-8000-000000000001'::uuid), ('e8100000-0000-4000-8000-000000000002'::uuid) $$, 'zadanie z Inboxu — reguły obu osób');
select set_eq($$ select id from public.plugin_event_rules('d8000000-0000-4000-8000-000000000002') $$,
  $$ values ('e8100000-0000-4000-8000-000000000001'::uuid) $$, 'zadanie z listy ukrytej przed gośćmi — tylko reguła właściciela');

-- Bieżący rzut i uprawnienia.
select is(public.plugin_task_state_now(:T) ->> 'dueDate', '2026-11-30', 'bieżący rzut zadania');
select pg_temp.login(:A);
select throws_ok($$ select public.plugin_event_rules('d8000000-0000-4000-8000-000000000001') $$, '42501', null, 'klient nie woła funkcji serwera');
reset role;

select * from finish();
rollback;
