-- v1.x: automatyczne przypomnienie osoby odpowiedzialnej (migracja *_v1x_assignee_reminders.sql).
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000f1', 'wlasciciel-przyp@test.local'),
  ('00000000-0000-4000-8000-0000000000f2', 'gosc-przyp@test.local');

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
-- „tytuł: kto” zadań z automatycznym przypomnieniem obu kont.
create function pg_temp.due(p_from date default '2026-11-18', p_to date default '2026-11-22') returns text language sql as $$
  select string_agg(x.title || ': ' || case x.user_id when '00000000-0000-4000-8000-0000000000f1' then 'O' else 'G' end, ', ' order by x.title)
    from public.assignee_reminder_tasks(array['00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000f2']::uuid[], p_from, p_to) x
$$;

\set O  '''00000000-0000-4000-8000-0000000000f1'''
\set G  '''00000000-0000-4000-8000-0000000000f2'''
\set W  '''b6000000-0000-4000-8000-000000000001'''
\set L  '''c6000000-0000-4000-8000-000000000001'''
\set C  '''e6000000-0000-4000-8000-000000000001'''
\set D  '''e6000000-0000-4000-8000-000000000002'''

-- Grażyna (C) ma e-mail gościa (inna wielkość liter), Dorota (D) — nikogo z przestrzeni.
select pg_temp.login(:O);
select is((pg_temp.push(
    pg_temp.op('workspaces', :W, '{"name": "Wspólna"}', pg_temp.h(1000)),
    pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'project', 'name', 'Projekt'), pg_temp.h(1001)),
    pg_temp.op('collaborators', :C, '{"name": "Grażyna", "email": "Gosc-Przyp@test.local"}', pg_temp.h(1002)),
    pg_temp.op('collaborators', :D, '{"name": "Dorota", "email": "nikt@test.local"}', pg_temp.h(1002)),
    pg_temp.op('tasks', 'd6000000-0000-4000-8000-000000000001', jsonb_build_object('list_id', :L, 'title', 'Gość', 'assignee_id', :C, 'due_date', '2026-11-20', 'due_time', '10:00'), pg_temp.h(1003)),
    pg_temp.op('tasks', 'd6000000-0000-4000-8000-000000000002', jsonb_build_object('list_id', :L, 'title', 'Twórca', 'due_date', '2026-11-20', 'due_time', '10:00'), pg_temp.h(1003)),
    pg_temp.op('tasks', 'd6000000-0000-4000-8000-000000000003', jsonb_build_object('list_id', :L, 'title', 'Bez konta', 'assignee_id', :D, 'due_date', '2026-11-20', 'due_time', '10:00'), pg_temp.h(1003)),
    pg_temp.op('tasks', 'd6000000-0000-4000-8000-000000000004', jsonb_build_object('list_id', :L, 'title', 'Bez godziny', 'assignee_id', :C, 'due_date', '2026-11-20'), pg_temp.h(1003)),
    pg_temp.op('tasks', 'd6000000-0000-4000-8000-000000000005', jsonb_build_object('list_id', :L, 'title', 'Zrobione', 'assignee_id', :C, 'due_date', '2026-11-20', 'due_time', '10:00', 'status', 'done'), pg_temp.h(1003)),
    pg_temp.op('tasks', 'd6000000-0000-4000-8000-000000000006', jsonb_build_object('list_id', :L, 'title', 'Odległe', 'assignee_id', :C, 'due_date', '2026-12-20', 'due_time', '10:00'), pg_temp.h(1003)),
    pg_temp.op('tasks', 'd6000000-0000-4000-8000-000000000007', jsonb_build_object('list_id', :L, 'title', 'Seria', 'assignee_id', :C, 'due_date', '2026-11-02', 'due_time', '10:00', 'recurrence', '{"mode": "schedule", "rrule": "FREQ=DAILY", "anchor": "2026-11-01"}'::jsonb), pg_temp.h(1003)),
    pg_temp.op('tasks', 'd6000000-0000-4000-8000-000000000008', jsonb_build_object('list_id', :L, 'title', 'Dawne', 'assignee_id', :C, 'due_date', '2026-11-02', 'due_time', '10:00'), pg_temp.h(1003))
  ) -> 'rejected'), '[]'::jsonb, 'właściciel zakłada przestrzeń, osoby i zadania');

reset role; select set_config('request.jwt.claims', '', true);
select is((select user_id from public.scope_collaborators where collaborator_id = :C), null, 'przed dołączeniem gościa osoba nie ma konta w przestrzeni');
select is(pg_temp.due(), null, 'nieudostępniona przestrzeń — bez automatycznych przypomnień');

-- ── Gość dołącza ─────────────────────────────────────────────────────────────────────────────
create temp table ver as select sync_version from public.sync_scopes where id = :W;
insert into public.scope_members (scope_id, user_id, role) values (:W, :G, 'viewer');
select is((select user_id from public.scope_collaborators where collaborator_id = :C), :G::uuid, 'konto po e-mailu (bez wielkości liter) od chwili dołączenia');
select ok((select s.sync_version > v.sync_version from public.sync_scopes s, ver v where s.id = :W), 'zmiana konta podbija wersję zakresu (telefon ją pobierze)');
select is((select user_id from public.scope_collaborators where collaborator_id = :D), null, 'osoba spoza przestrzeni — bez konta');
select is(pg_temp.due(), 'Gość: G, Seria: G, Twórca: O', 'wskazana osoba, seria i twórca; bez godziny, zamknięte, odległe, dawne i bez konta — nie');
select is((select count(*)::int from public.assignee_reminder_tasks(array[:O]::uuid[], '2026-11-18', '2026-11-22')), 1, 'tylko podane konta');

select pg_temp.login(:G);
select is((select x ->> 'user_id' from jsonb_array_elements(public.pull_changes('{}', 1000) -> 'tables' -> 'scope_collaborators') x where x ->> 'collaborator_id' = :C), :G, 'konto przychodzi w pull_changes');
select ok(not exists (select 1 from jsonb_array_elements(public.pull_changes('{}', 1000) -> 'tables' -> 'scope_collaborators') x where x ? 'email'), 'nadal bez e-maila');
select throws_ok($$select * from public.assignee_reminder_tasks('{}', '2026-11-18', '2026-11-22')$$, '42501', null, 'RPC tylko dla serwera');
reset role; select set_config('request.jwt.claims', '', true);

-- ── Ukryta lista, zmiany e-maili ─────────────────────────────────────────────────────────────
update public.lists set guest_access = 'hidden' where id = :L;
select is(pg_temp.due(), 'Twórca: O', 'lista ukryta przed gościem — jego przypomnienia milkną');
update public.lists set guest_access = 'edit' where id = :L;

select pg_temp.login(:O);
select pg_temp.push(pg_temp.op('collaborators', :C, '{"email": "inny@test.local"}', pg_temp.h(2000)));
reset role; select set_config('request.jwt.claims', '', true);
select is((select user_id from public.scope_collaborators where collaborator_id = :C), null, 'zmiana e-maila osoby odpina konto');
update auth.users set email = 'inny@test.local' where id = :G;
select is((select user_id from public.scope_collaborators where collaborator_id = :C), :G::uuid, 'zmiana e-maila konta przypina je z powrotem');

-- ── Archiwum, wyjście, usunięcie ─────────────────────────────────────────────────────────────
update public.lists set archived_at = now() where id = :L;
select is(pg_temp.due(), null, 'zarchiwizowana lista — bez przypomnień');
update public.lists set archived_at = null where id = :L;

delete from public.scope_members where scope_id = :W and user_id = :G;
select is((select user_id from public.scope_collaborators where collaborator_id = :C), null, 'wyjście z przestrzeni odpina konto');
select is(pg_temp.due(), null, 'po wyjściu gościa przestrzeń znów nieudostępniona');

insert into public.scope_members (scope_id, user_id, role) values (:W, :G, 'editor');
select lives_ok($$delete from auth.users where id = '00000000-0000-4000-8000-0000000000f2'$$, 'usunięcie konta członka');
select lives_ok($$delete from public.sync_scopes where id = 'b6000000-0000-4000-8000-000000000001'$$, 'usunięcie zakresu z kaskadą');

select * from finish();
rollback;
