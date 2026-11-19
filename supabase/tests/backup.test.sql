-- Etap 13 (kopie zapasowe): eksport JSON wpisuje w puste kolumny `not null` wartości domyślne bazy
-- (`BACKUP_DEFAULTS` w packages/core/src/backup.ts) — lista musi się zgadzać z migracjami.
-- Import z zachowaniem id: ten sam wiersz z kopii drugi raz nie zmienia niczego.
-- Uruchomienie: npm run test:db
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

-- Kolumny `not null` z wartością domyślną w tabelach kopii (bez systemowych i `devices`, której kopia nie ma).
select is(
  array(select (table_name::text || '.' || column_name::text || ' = ' || column_default::text) collate "C"
       from information_schema.columns
      where table_schema = 'public' and is_nullable = 'NO' and column_default is not null
        and table_name = any(public.synced_tables()) and table_name <> 'devices'
        and column_name not in ('id', 'scope_id', 'created_at', 'updated_at', 'created_by', 'row_version', 'field_clock')
      order by 1),
  array[
    'lists.kind = ''list''::text',
    'lists.sort_key = ''n''::text',
    'lists.view_prefs = ''{}''::jsonb',
    'profiles.settings = ''{}''::jsonb',
    'saved_filters.query = ''{}''::jsonb',
    'saved_filters.sort_key = ''n''::text',
    'tags.sort_key = ''n''::text',
    'task_completions.completed_at = now()',
    'task_completions.kind = ''done''::text',
    'task_dependencies.kind = ''finish_to_start''::text',
    'task_dependencies.lag_days = 0',
    'tasks.kind = ''task''::text',
    'tasks.postpone_count = 0',
    'tasks.priority = 4',
    'tasks.sort_key = ''n''::text',
    'tasks.status = ''todo''::text',
    'workspaces.sort_key = ''n''::text'
  ]::text[],
  'wartości domyślne kolumn not null = BACKUP_DEFAULTS w core/backup.ts'
);

-- Przywrócenie wiersza z kopii: te same id, nowszy HLC, wartości z pliku.
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000e1', 'kopia-etap13@test.local');
select set_config('role', 'authenticated', true),
       set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000000e1', 'role', 'authenticated')::text, true);

create function pg_temp.restore(p_hlc text) returns jsonb language sql as $$
  select public.push_changes(jsonb_build_array(
    jsonb_build_object('op', gen_random_uuid(), 'table', 'workspaces', 'id', '00000000-0000-4000-8000-0000000000e2',
      'set', jsonb_build_object('name', 'Dom', 'color', null, 'icon', null, 'sort_key', 'a0', 'archived_at', null, 'deleted_at', null), 'hlc', p_hlc),
    jsonb_build_object('op', gen_random_uuid(), 'table', 'lists', 'id', '00000000-0000-4000-8000-0000000000e3',
      'set', jsonb_build_object('scope_id', '00000000-0000-4000-8000-0000000000e2', 'kind', 'inbox', 'name', 'Inbox', 'sort_key', 'a', 'view_prefs', '{}'::jsonb, 'deleted_at', null), 'hlc', p_hlc),
    jsonb_build_object('op', gen_random_uuid(), 'table', 'tasks', 'id', '00000000-0000-4000-8000-0000000000e4',
      'set', jsonb_build_object('list_id', '00000000-0000-4000-8000-0000000000e3', 'title', 'Z kopii', 'deleted_at', '2026-11-18T08:00:00+00:00'), 'hlc', p_hlc)))
$$;

select is((pg_temp.restore('001763452800000:00000:import') -> 'rejected'), '[]'::jsonb, 'kopia na pusty serwer — bez odrzuceń');
select is((select deleted_at from public.tasks where id = '00000000-0000-4000-8000-0000000000e4'), '2026-11-18T08:00:00+00:00'::timestamptz, 'kosz też wraca (deleted_at z pliku)');

create temp table before_again as select row_version from public.tasks where id = '00000000-0000-4000-8000-0000000000e4';
select is((pg_temp.restore('001763452800000:00000:import') -> 'rejected'), '[]'::jsonb, 'drugi import tego samego pliku przyjęty');
select is((select row_version from public.tasks where id = '00000000-0000-4000-8000-0000000000e4'), (select row_version from before_again), 'ten sam HLC drugi raz — wiersz bez zmian (idempotentnie)');

select * from finish();
rollback;
