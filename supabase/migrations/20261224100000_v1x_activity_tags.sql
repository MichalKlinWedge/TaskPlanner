-- Historia zmian zadania (M3): tagi i wysyłki integracji (v1.x).
--
-- `activity_log` dostawał tylko zmiany wiersza `tasks`. Teraz wpisy (zawsze `row_id` = zadanie) dają też:
--   * `task_tags` — `{"tag_added": {id, name}}` / `{"tag_removed": {id, name}}` (nazwa z chwili zmiany; kto widzi
--     zadanie, widzi też jego tagi). Zmiana kolejności tagów i przeniesienie zadania to nie zmiana tagu.
--   * `plugin_deliveries` — `{"delivery": {id, status, trigger, plugin, ruleId}}`: „Wyślij do…” z wynikiem (wysłane,
--     nieudane, pominięte) i udane wysyłki reguł zdarzeniowych. Bez nazwy reguły, połączenia i adresu obiektu —
--     to dane właściciela reguły, a historię widzą wszyscy, którzy widzą zadanie (nazwę reguły dokłada klient
--     jej właściciela). Wysyłka osoby, która nie ma już dostępu do zadania, nie zostawia wpisu.
-- Nowa kolumna `source` (`{kind, ruleId?}`, null = użytkownik) mówi, że zmianę zrobiła integracja
-- (`taskplanner.source`): reguła po udanej wysyłce (`plugin`, wykonawca = właściciel reguły) albo `calendar`.
-- Migracja addytywna: kolumna, wyzwalacze, ta sama treść `log_activity` i `plugin_after_send` z nowym
-- parametrem `p_rule` (z domyślnym `null` — wcześniejsza Edge Function działa dalej) oraz wpisy dla wysyłek
-- z ostatnich 30 dni (retencja `plugin_deliveries`).

alter table public.activity_log add column source jsonb check (source is null or jsonb_typeof(source) = 'object');

create function public.activity_source() returns jsonb
language sql stable set search_path = '' as $$
  select case when coalesce(current_setting('taskplanner.source', true), '') <> ''
              then jsonb_strip_nulls(jsonb_build_object('kind', current_setting('taskplanner.source', true),
                                                        'ruleId', nullif(current_setting('taskplanner.rule', true), ''))) end;
$$;

create function public.activity_actor() returns uuid
language sql stable set search_path = '' as $$
  select coalesce(auth.uid(), nullif(current_setting('taskplanner.actor', true), '')::uuid);
$$;

create or replace function public.log_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  changes jsonb;
  node text;
begin
  select coalesce(jsonb_object_agg(n.key, n.value), '{}') into changes
    from jsonb_each(to_jsonb(new)) n
   where n.key not in ('id', 'created_at', 'updated_at', 'created_by', 'row_version', 'field_clock', 'scope_id', 'canvas_pos', 'derived_from')
     and (tg_op = 'INSERT' or n.value is distinct from to_jsonb(old) -> n.key);
  if changes = '{}' then
    return null;
  end if;
  select split_part(max(c.value #>> '{}'), ':', 3) into node
    from jsonb_each(new.field_clock) c
   where changes ? c.key;
  insert into public.activity_log (scope_id, table_name, row_id, changes, device_id, actor_id, source)
  values (new.scope_id, tg_table_name, new.id, changes, node, public.activity_actor(), public.activity_source());
  return null;
end $$;

-- ── Tagi ─────────────────────────────────────────────────────────────────────────────────────

create function public.log_task_tag() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.activity_log (scope_id, table_name, row_id, changes, device_id, actor_id, source)
  select new.scope_id, tg_table_name, new.task_id,
         jsonb_build_object(case when new.deleted_at is null then 'tag_added' else 'tag_removed' end,
                            jsonb_build_object('id', g.id, 'name', g.name)),
         split_part(case when tg_op = 'UPDATE' then new.field_clock ->> 'deleted_at'
                         else (select max(c.value #>> '{}') from jsonb_each(new.field_clock) c) end, ':', 3),
         public.activity_actor(), public.activity_source()
    from public.tags g
   where g.id = new.tag_id;
  return null;
end $$;
create trigger log_activity_added after insert on public.task_tags
  for each row when (new.deleted_at is null) execute function public.log_task_tag();
create trigger log_activity_changed after update on public.task_tags
  for each row when ((old.deleted_at is null) is distinct from (new.deleted_at is null)) execute function public.log_task_tag();

-- ── Wysyłki ──────────────────────────────────────────────────────────────────────────────────

create function public.log_plugin_delivery() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.status = new.status then
    return null;
  end if;
  insert into public.activity_log (scope_id, table_name, row_id, changes, actor_id)
  select t.scope_id, tg_table_name, t.id,
         jsonb_build_object('delivery', jsonb_build_object(
           'id', new.id, 'status', new.status, 'trigger', new.source, 'ruleId', new.rule_id,
           'plugin', (select c.plugin from public.plugin_connections c where c.id = new.connection_id))),
         new.user_id
    from public.tasks t
   where t.id = new.task_id
     and exists (select 1 from public.scope_members m where m.scope_id = t.scope_id and m.user_id = new.user_id)
     and public.list_access(t.list_id, new.user_id) is distinct from 'hidden';
  return null;
end $$;
-- Reguły zdarzeniowe tylko udane (reszta jest w historii wysyłek właściciela), „Wyślij do…” z każdym wynikiem.
create trigger log_activity after insert or update of status on public.plugin_deliveries
  for each row when (new.status = 'sent' or (new.source = 'manual' and new.status in ('failed', 'dead', 'skipped')))
  execute function public.log_plugin_delivery();

insert into public.activity_log (scope_id, table_name, row_id, changes, actor_id, at)
select t.scope_id, 'plugin_deliveries', t.id,
       jsonb_build_object('delivery', jsonb_build_object(
         'id', d.id, 'status', d.status, 'trigger', d.source, 'ruleId', d.rule_id,
         'plugin', (select c.plugin from public.plugin_connections c where c.id = d.connection_id))),
       d.user_id, d.sent_at
  from public.plugin_deliveries d
  join public.tasks t on t.id = d.task_id
 where d.status = 'sent' and d.sent_at is not null
   and exists (select 1 from public.scope_members m where m.scope_id = t.scope_id and m.user_id = d.user_id)
   and public.list_access(t.list_id, d.user_id) is distinct from 'hidden'
 order by d.sent_at;

-- Każdy wpis dotyczy zadania (`row_id`) — ukryta lista chowa też tagi i wysyłki.
drop policy activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log for select to authenticated
  using (public.has_scope_access(scope_id) and public.task_visible(row_id));

-- ── Zmiana po wysyłce: z której reguły (treść jak w `*_v1x_plugin_after_send.sql`) ───────────

drop function public.plugin_after_send(uuid, uuid, text, jsonb, uuid[]);
create function public.plugin_after_send(p_user uuid, p_task uuid, p_status text, p_add jsonb, p_remove uuid[], p_rule uuid default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  hlc text := public.server_hlc();
  t public.tasks;
  notes text[] := '{}';
  item jsonb;
  tag uuid;
  existing public.task_tags;
  skipped int := 0;
begin
  select * into t from public.tasks where id = p_task for update;
  if not found or t.deleted_at is not null then
    return 'Po wysyłce: zadanie w koszu — bez zmian';
  end if;
  if not exists (select 1 from public.scope_members m where m.scope_id = t.scope_id and m.user_id = p_user and m.role in ('owner', 'editor'))
     or public.list_access(t.list_id, p_user) is distinct from 'edit' then
    return 'Po wysyłce: brak prawa zmiany zadania — bez zmian';
  end if;
  perform set_config('taskplanner.source', 'plugin', true);
  perform set_config('taskplanner.actor', p_user::text, true);
  perform set_config('taskplanner.rule', coalesce(p_rule::text, ''), true);

  if p_status is not null and p_status is distinct from t.status then
    if p_status not in ('todo', 'in_progress', 'waiting', 'done', 'cancelled') then
      notes := notes || 'nieznany status'::text;
    elsif t.recurrence is not null and p_status in ('done', 'cancelled') then
      notes := notes || 'status serii bez zmian (ukończ ją w aplikacji)'::text;
    elsif hlc collate "C" > coalesce(t.field_clock ->> 'status', '') collate "C" then
      update public.tasks
         set status = p_status,
             completed_at = case when p_status in ('done', 'cancelled') then now() end,
             field_clock = field_clock || jsonb_build_object('status', hlc, 'completed_at', hlc)
       where id = p_task;
    end if;
  end if;

  for item in select value from jsonb_array_elements(coalesce(p_add, '[]')) loop
    tag := (item ->> 'tagId')::uuid;
    if not exists (select 1 from public.tags g where g.id = tag and g.scope_id = p_user and g.deleted_at is null)
       and not exists (select 1 from public.scope_tags st where st.tag_id = tag and st.scope_id = t.scope_id and st.deleted_at is null) then
      skipped := skipped + 1;
      continue;
    end if;
    select * into existing from public.task_tags where task_id = p_task and tag_id = tag order by deleted_at nulls first limit 1 for update;
    if not found then
      insert into public.task_tags (id, task_id, tag_id, created_by, field_clock)
      values ((item ->> 'id')::uuid, p_task, tag, p_user, jsonb_build_object('task_id', hlc, 'tag_id', hlc))
      on conflict do nothing;
    elsif existing.deleted_at is not null and hlc collate "C" > coalesce(existing.field_clock ->> 'deleted_at', '') collate "C" then
      update public.task_tags set deleted_at = null, field_clock = field_clock || jsonb_build_object('deleted_at', hlc) where id = existing.id;
    end if;
  end loop;
  if skipped > 0 then
    notes := notes || 'pominięto usunięte tagi'::text;
  end if;

  update public.task_tags
     set deleted_at = now(), field_clock = field_clock || jsonb_build_object('deleted_at', hlc)
   where task_id = p_task and tag_id = any(coalesce(p_remove, '{}')) and deleted_at is null
     and hlc collate "C" > coalesce(field_clock ->> 'deleted_at', '') collate "C";

  perform set_config('taskplanner.source', '', true);
  perform set_config('taskplanner.actor', '', true);
  perform set_config('taskplanner.rule', '', true);
  return case when cardinality(notes) > 0 then 'Po wysyłce: ' || array_to_string(notes, '; ') end;
end $$;

revoke execute on function public.plugin_after_send(uuid, uuid, text, jsonb, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.plugin_after_send(uuid, uuid, text, jsonb, uuid[], uuid) to service_role;
revoke execute on function public.activity_source(), public.activity_actor(), public.log_task_tag(), public.log_plugin_delivery()
  from public, anon, authenticated;
