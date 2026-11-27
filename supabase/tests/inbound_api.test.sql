-- v1.x: przychodzące API (migracje *_v1x_inbound_api.sql, *_v1x_inbound_api_contract.sql): tokeny (uprawnienia, skrót niewidoczny, limit
-- zapytań, `pull_changes`), `upsert_integration_task` (utworzenie, idempotencja, scalanie trójstronne pól,
-- terminu i tagów, HLC urządzenia, kosz, usunięcie na stałe, cudzy klucz, odwołany token, pochodzenie
-- `integration`, pola nieobecne i `null`, strefa terminu, `applied`), `integration_task_state` i `source`
-- w `plugin_task_context`.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(58);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000005a1', 'api-a@test.local'),
  ('00000000-0000-4000-8000-0000000005a2', 'api-b@test.local');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;

create function pg_temp.op(p_table text, p_id uuid, p_set jsonb, p_hlc text) returns jsonb language sql as $$
  select jsonb_build_object('op', gen_random_uuid(), 'table', p_table, 'id', p_id, 'set', p_set, 'hlc', p_hlc)
$$;

-- HLC urządzenia „teraz” (+ przesunięcie w ms) — nowszy niż wcześniejsze zapisy serwera.
create function pg_temp.hlc(p_offset_ms bigint default 0) returns text language sql as $$
  select lpad((floor(extract(epoch from clock_timestamp()) * 1000)::bigint + p_offset_ms)::text, 15, '0') || ':00001:dev'
$$;

create function pg_temp.task(p_title text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('title', p_title, 'description_md', null, 'status', 'todo', 'priority', 4,
                            'start_date', null, 'due_date', null, 'due_time', null, 'time_zone', null) || p_extra
$$;

create function pg_temp.tags(variadic p_names text[]) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', n, 'tagId', md5('tag:' || lower(n))::uuid,
                                               'id', md5('tt:' || lower(n))::uuid)), '[]')
    from unnest(p_names) n
$$;

\set A '''00000000-0000-4000-8000-0000000005a1'''
\set B '''00000000-0000-4000-8000-0000000005a2'''
\set W '''b5000000-0000-4000-8000-000000000001'''
\set L '''c5000000-0000-4000-8000-000000000001'''
\set WB '''b5000000-0000-4000-8000-0000000000b1'''
\set LB '''c5000000-0000-4000-8000-0000000000b1'''
\set T '''d5000000-0000-4000-8000-000000000001'''
\set T3 '''d5000000-0000-4000-8000-000000000003'''
\set C '''e5000000-0000-4000-8000-000000000001'''
\set HASH_A '''aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'''
\set HASH_B '''bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'''
\set KEY '''ep:trip-1:task-1'''

select pg_temp.login(:A);
select public.push_changes(jsonb_build_array(
  pg_temp.op('workspaces', :W, '{"name": "Wyjazdy"}', '000000000001000:00000:dev'),
  pg_temp.op('lists', :L, jsonb_build_object('scope_id', :W, 'kind', 'inbox', 'name', 'Inbox'), '000000000001001:00000:dev')));
select pg_temp.login(:B);
select public.push_changes(jsonb_build_array(
  pg_temp.op('workspaces', :WB, '{"name": "Cudza"}', '000000000001000:00000:dev'),
  pg_temp.op('lists', :LB, jsonb_build_object('scope_id', :WB, 'kind', 'inbox', 'name', 'Inbox'), '000000000001001:00000:dev')));
reset role;
-- Reguła zdarzeniowa A — inaczej wyzwalacze nic nie piszą do `plugin_outbox`.
insert into public.plugin_connections (id, user_id, plugin, label, config) values (:C, :A, 'webhook', 'EP', '{"url": "https://example.com/h"}');
select pg_temp.login(:A);
select public.push_changes(jsonb_build_array(pg_temp.op('plugin_rules', gen_random_uuid(),
  jsonb_build_object('name', 'Zamknięte', 'connection_id', :C, 'enabled', true, 'sort_key', 'n',
    'trigger', '{"kind": "event", "events": ["task.completed"]}'::jsonb, 'action', '{}'::jsonb, 'options', '{}'::jsonb), '000000000001010:00000:dev')));
reset role;

-- ── Tokeny ───────────────────────────────────────────────────────────────────────────────────

select throws_ok($$ select public.api_token_create('00000000-0000-4000-8000-0000000005a1', 'Cudza lista', 'c5000000-0000-4000-8000-0000000000b1', repeat('c', 64), '…cccc') $$,
  'TP003', null, 'token tylko na liście z prawem zapisu');
create temp table tok as
  select public.api_token_create(:A, 'Expedition Plan', :L, :HASH_A, '…aaaa') as a,
         public.api_token_create(:B, 'Inny', :LB, :HASH_B, '…bbbb') as b;
grant select on tok to authenticated;
select ok((select user_id = :A and list_id = :L and revoked_at is null from public.api_tokens where id = (select a from tok)), 'token zapisany');

select is(public.api_token_auth(repeat('0', 64)), null, 'nieznany skrót = brak tokenu');
select is((public.api_token_auth(:HASH_A, 2) ->> 'allowed')::boolean, true, 'pierwsze zapytanie w limicie');
select ok((select last_used_at is not null from public.api_tokens where id = (select a from tok)), 'ostatnie użycie zapisane');
select is((public.api_token_auth(:HASH_A, 2) ->> 'userId')::uuid, :A::uuid, 'token wskazuje konto');
select ok((select (r ->> 'allowed')::boolean = false and (r ->> 'retryAfter')::int between 1 and 60 from public.api_token_auth(:HASH_A, 2) r),
  'trzecie zapytanie w minucie ponad limit (z retryAfter)');

select pg_temp.login(:A);
select throws_ok($$ select token_hash from public.api_tokens $$, '42501', null, 'skrót tokenu niewidoczny dla klienta');
select is((select count(*) from public.api_tokens), 1::bigint, 'klient widzi tylko swoje tokeny');
select throws_ok($$ select public.upsert_integration_task((select a from tok), 'ep:x:y', gen_random_uuid(), '{"title": "x"}') $$,
  '42501', null, 'klient nie woła upsert_integration_task');
select throws_ok($$ select public.api_token_create(auth.uid(), 'x', 'c5000000-0000-4000-8000-000000000001', repeat('d', 64), null) $$,
  '42501', null, 'klient nie zakłada tokenów sam');
select ok((select (public.pull_changes() -> 'tables' -> 'api_tokens') @> jsonb_build_array(jsonb_build_object('label', 'Expedition Plan', 'token_hint', '…aaaa', 'list_id', :L))),
  'token w pull_changes jako tabela tylko do odczytu');
select ok((select not (public.pull_changes() -> 'tables' -> 'api_tokens' -> 0 ? 'token_hash')), 'pull_changes bez skrótu');
reset role;

-- ── Utworzenie ───────────────────────────────────────────────────────────────────────────────

delete from public.plugin_outbox where scope_id = :W;
select is(
  public.upsert_integration_task((select a from tok), :KEY, :T,
    pg_temp.task('Kupić bilety', '{"description_md": "Pociąg", "due_date": "2026-12-10"}'), pg_temp.tags('wyjazd', 'bilety'),
    '{"kind": "expeditionplan", "tripId": "trip-1", "ref": "task-1"}') ->> 'status',
  'created', 'pierwszy zapis zakłada zadanie');
select ok((select list_id = :L and title = 'Kupić bilety' and description_md = 'Pociąg' and due_date = '2026-12-10' and created_by = :A
                  and source ->> 'tripId' = 'trip-1' and field_clock ->> 'title' like '%:server'
             from public.tasks where id = :T), 'zadanie na liście tokenu z HLC serwera i źródłem');
select is((select count(*) from public.task_tags tt join public.tags g on g.id = tt.tag_id
            where tt.task_id = :T and tt.deleted_at is null and g.scope_id = :A), 2::bigint, 'brakujące tagi założone i przypięte');
select ok((select count(*) > 0 and bool_and(origin = 'integration') from public.plugin_outbox where scope_id = :W),
  'zapis z API idzie jako z integracji');
select ok((select source = '{"kind": "api"}'::jsonb and actor_id = :A from public.activity_log where row_id = :T and table_name = 'tasks' order by id limit 1),
  'historia: zmiana z API w imieniu właściciela tokenu');
select is(public.plugin_task_context(:T, :A) -> 'source', '{"kind": "expeditionplan", "tripId": "trip-1", "ref": "task-1"}'::jsonb,
  'ładunek pluginu niesie wyjazd i zadanie EP');

-- ── Idempotencja ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from public.activity_log where row_id = :T)
    || ':' || (public.upsert_integration_task((select a from tok), :KEY, :T,
                 pg_temp.task('Kupić bilety', '{"description_md": "Pociąg", "due_date": "2026-12-10"}'), pg_temp.tags('wyjazd', 'bilety')) ->> 'status')
    || ':' || (select count(*) from public.activity_log where row_id = :T),
  (select count(*) from public.activity_log where row_id = :T) || ':unchanged:' || (select count(*) from public.activity_log where row_id = :T),
  'powtórka tej samej treści nic nie zmienia');

-- ── Scalanie trójstronne ─────────────────────────────────────────────────────────────────────

select pg_temp.login(:A);
select public.push_changes(jsonb_build_array(pg_temp.op('tasks', :T, '{"title": "Bilety (moje)"}', pg_temp.hlc())));
-- Użytkownik zdejmuje tag „bilety” wysłany przez aplikację.
select public.push_changes(jsonb_build_array(pg_temp.op('task_tags', md5('tt:bilety')::uuid, jsonb_build_object('deleted_at', now()), pg_temp.hlc())));
reset role;

create temp table r1 as select public.upsert_integration_task((select a from tok), :KEY, :T,
  pg_temp.task('Kupić bilety PKP', '{"description_md": "Pociąg nocny", "due_date": "2026-12-10", "priority": 2}'),
  pg_temp.tags('wyjazd', 'bilety', 'pkp')) as r;
select is((select r ->> 'status' from r1), 'updated', 'druga wysyłka zmienia zadanie');
select is((select title from public.tasks where id = :T), 'Bilety (moje)', 'tytuł zmieniony przez użytkownika zostaje');
select is((select r -> 'kept' from r1), '["title"]'::jsonb, 'odpowiedź mówi, które pole zostało po stronie użytkownika');
select ok((select description_md = 'Pociąg nocny' and priority = 2 from public.tasks where id = :T), 'pola niezmienione przez użytkownika nadpisane');
select ok((select deleted_at is not null from public.task_tags where id = md5('tt:bilety')::uuid), 'zdjęty przez użytkownika tag nie wraca');
select ok((select exists (select 1 from public.task_tags tt join public.tags g on g.id = tt.tag_id
                           where tt.task_id = :T and g.name = 'pkp' and tt.deleted_at is null)), 'nowy tag z wysyłki dochodzi');

select is(public.upsert_integration_task((select a from tok), :KEY, :T,
  pg_temp.task('Kupić bilety PKP', '{"description_md": "Pociąg nocny", "due_date": "2026-12-10", "priority": 2}'),
  pg_temp.tags('bilety', 'pkp')) ->> 'status', 'updated', 'tag usunięty z wysyłki');
select ok((select not exists (select 1 from public.task_tags tt join public.tags g on g.id = tt.tag_id
                               where tt.task_id = :T and g.name = 'wyjazd' and tt.deleted_at is null)), 'tag usunięty z wysyłki znika z zadania');

-- Termin jako całość: użytkownik przesuwa termin, aplikacja zmienia początek — zostaje termin użytkownika.
select pg_temp.login(:A);
select public.push_changes(jsonb_build_array(pg_temp.op('tasks', :T, '{"due_date": "2026-12-11"}', pg_temp.hlc())));
reset role;
create temp table r2 as select public.upsert_integration_task((select a from tok), :KEY, :T,
  pg_temp.task('Kupić bilety PKP', '{"description_md": "Pociąg nocny", "due_date": "2026-12-10", "start_date": "2026-12-01", "priority": 2}'),
  pg_temp.tags('bilety', 'pkp')) as r;
select ok((select due_date = '2026-12-11' and start_date is null from public.tasks where id = :T), 'termin zmieniony przez użytkownika zostaje w całości');
select is((select r -> 'kept' from r2), '["start_date"]'::jsonb, 'w zachowanych tylko pole terminu zmienione przez aplikację (tytuł wysłany bez zmian — to nie konflikt)');

-- HLC urządzenia nowszy niż serwera: pole się nie zmienia, choć wartość jest z ostatniej wysyłki.
select pg_temp.login(:A);
select public.push_changes(jsonb_build_array(pg_temp.op('tasks', :T, '{"priority": 2}', pg_temp.hlc(240000))));
reset role;
select is(public.upsert_integration_task((select a from tok), :KEY, :T,
  pg_temp.task('Kupić bilety PKP', '{"description_md": "Pociąg nocny", "due_date": "2026-12-10", "start_date": "2026-12-01", "priority": 1}'),
  pg_temp.tags('bilety', 'pkp')) -> 'kept', '["priority"]'::jsonb, 'nowszy HLC urządzenia chroni pole');
select is((select priority from public.tasks where id = :T), 2::smallint, 'priorytet bez zmian');

-- Zamknięcie z aplikacji.
select is(public.upsert_integration_task((select a from tok), :KEY, :T,
  pg_temp.task('Kupić bilety PKP', '{"description_md": "Pociąg nocny", "due_date": "2026-12-10", "start_date": "2026-12-01", "priority": 1, "status": "done"}'),
  pg_temp.tags('bilety', 'pkp')) -> 'task' ->> 'status', 'done', 'status Gotowe z aplikacji');
select ok((select completed_at is not null from public.tasks where id = :T), 'data ukończenia ustawiona');

-- Pola nieobecne: aplikacja nimi nie zarządza — bez zmian w zadaniu i w rzucie ostatniej wysyłki.
create temp table r3 as select public.upsert_integration_task((select a from tok), :KEY, :T,
  '{"title": "Kupić bilety PKP", "description_md": "Pociąg nocny, miejsca 12 i 13"}') as r;
select is((select r -> 'applied' from r3), '["description_md"]'::jsonb, 'applied: tylko zmienione pole');
select ok((select status = 'done' and priority = 2 and due_date = '2026-12-11' and description_md = 'Pociąg nocny, miejsca 12 i 13'
             and (select array_agg(g.name) from public.task_tags tt join public.tags g on g.id = tt.tag_id where tt.task_id = :T and tt.deleted_at is null) = array['pkp']
             from public.tasks where id = :T), 'nieobecne pola i tagi bez zmian');
select ok((select pushed -> 'fields' ->> 'priority' = '1' and pushed -> 'fields' ->> 'status' = 'done' and pushed -> 'tags' @> '["pkp"]'
             from public.api_task_links where task_id = :T), 'rzut ostatniej wysyłki zachowuje nieobecne pola');

-- Strefa terminu, `null` = wyczyść, termin, który nie pasuje do zmian użytkownika.
create temp table r4 as select public.upsert_integration_task((select a from tok), 'ep:trip-1:task-3', :T3,
  '{"title": "Wiza", "due_date": "2026-12-10", "due_time": "18:00", "time_zone": "Europe/Warsaw"}') as r;
select is((select r -> 'applied' from r4), '["title", "due_date", "due_time", "time_zone"]'::jsonb, 'utworzenie: applied = wysłane pola (bez tagów)');
select ok((select time_zone = 'Europe/Warsaw' and status = 'todo' and priority = 4 from public.tasks where id = :T3), 'strefa zapisana, reszta domyślna');
select ok(not exists (select 1 from public.task_tags where task_id = :T3), 'bez tagów w wysyłce — bez tagów');
select is(public.upsert_integration_task((select a from tok), 'ep:trip-1:task-3', :T3,
  '{"title": "Wiza", "due_date": "2026-12-10", "due_time": null, "time_zone": null}') -> 'applied', '["due_time", "time_zone"]'::jsonb, 'null czyści godzinę i strefę');
select ok((select due_time is null and time_zone is null and due_date = '2026-12-10' from public.tasks where id = :T3), 'godzina i strefa wyczyszczone');
select pg_temp.login(:A);
select public.push_changes(jsonb_build_array(pg_temp.op('tasks', :T3, '{"start_date": "2026-12-05"}', pg_temp.hlc())));
reset role;
select is(public.upsert_integration_task((select a from tok), 'ep:trip-1:task-3', :T3, '{"title": "Wiza", "due_date": "2026-12-03"}') -> 'kept',
  '["due_date"]'::jsonb, 'termin przed początkiem ustawionym przez użytkownika zostaje po stronie użytkownika');
select ok((select due_date = '2026-12-10' and start_date = '2026-12-05' from public.tasks where id = :T3), 'termin bez zmian');
-- Status: EP bez zmiany nie rusza „w toku” użytkownika, ale zamknięcie z EP wygrywa (przykład z kontraktu).
select pg_temp.login(:A);
select public.push_changes(jsonb_build_array(pg_temp.op('tasks', :T3, '{"status": "in_progress"}', pg_temp.hlc())));
reset role;
select is(public.upsert_integration_task((select a from tok), 'ep:trip-1:task-3', :T3, '{"title": "Wiza", "status": "todo"}') -> 'task' ->> 'status',
  'in_progress', 'ponowne todo z EP nie cofa „w toku” użytkownika');
select is(public.upsert_integration_task((select a from tok), 'ep:trip-1:task-3', :T3, '{"title": "Wiza", "status": "done"}') -> 'applied',
  '["status"]'::jsonb, 'zamknięcie z EP wygrywa nad „w toku” użytkownika');

-- ── Stan, cudzy klucz, kosz, odwołanie ───────────────────────────────────────────────────────

select is(public.integration_task_state((select a from tok), :KEY, :T) ->> 'status', 'ok', 'GET: stan zadania');
select is(public.integration_task_state((select a from tok), 'ep:trip-1:inny', :T) ->> 'status', 'missing', 'GET: inny klucz = brak');
select is(public.integration_task_state((select b from tok), :KEY, :T) ->> 'status', 'missing', 'GET: token innego konta nie widzi zadania');
select throws_ok($$ select public.upsert_integration_task((select b from tok), 'ep:trip-1:task-1', 'd5000000-0000-4000-8000-000000000001', '{"title": "Przejęte"}') $$,
  'TP003', null, 'token innego konta nie zmienia zadania (ten sam id)');
select throws_ok($$ select public.upsert_integration_task((select a from tok), 'ep:trip-1:inny', 'd5000000-0000-4000-8000-000000000001', '{"title": "Przejęte"}') $$,
  'TP003', null, 'inny klucz tego konta nie trafia w cudze zadanie');

update public.tasks set deleted_at = now() where id = :T;
select is(public.upsert_integration_task((select a from tok), :KEY, :T, pg_temp.task('Z kosza?')) ->> 'status', 'trashed', 'zadanie w koszu: bez zmian');
select ok((select title = 'Bilety (moje)' and deleted_at is not null from public.tasks where id = :T), 'zadanie w koszu nietknięte');
select is(public.integration_task_state((select a from tok), :KEY, :T) ->> 'status', 'trashed', 'GET: w koszu');

delete from public.task_tags where task_id = :T;
delete from public.activity_log where row_id = :T;
delete from public.tasks where id = :T;
select is(public.upsert_integration_task((select a from tok), :KEY, :T, pg_temp.task('Znowu')) ->> 'status', 'deleted', 'usunięte na stałe nie wraca');
select ok(not exists (select 1 from public.tasks where id = :T), 'brak nowego zadania');

select public.api_token_revoke(:A, (select a from tok));
select throws_ok($$ select public.upsert_integration_task((select a from tok), 'ep:trip-1:task-2', gen_random_uuid(), '{"title": "Po odwołaniu"}') $$,
  'TP003', null, 'odwołany token nie działa');
select is(public.api_token_auth(:HASH_A), null, 'odwołany token nie uwierzytelnia');

select * from finish();
rollback;
