-- Integracje wychodzące: zmiana zadania po udanej wysyłce (SPECYFIKACJA M21; reguła `options.afterSend`,
-- `PluginAfterSend` w `core/plugins/rules.ts`).
--
-- Edge Function `plugins` po wysłaniu woła `plugin_after_send` w imieniu właściciela reguły: tagi (jego własne
-- albo kopie z przestrzeni zadania) dodane / zdjęte i status — z HLC serwera, tylko pola, w których HLC serwera
-- jest nowszy (jak `calendar_task_apply`). Zmiana idzie z `taskplanner.source = 'plugin'`, więc w `plugin_outbox`
-- ma `origin = 'integration'` — reguły zdarzeniowe bez „także zadania z integracji” jej nie widzą (brak pętli).
-- Status kończący serię (done / cancelled przy `recurrence`) jest pomijany — przesunięcie serii robi aplikacja.
-- Zwraca uwagę do historii wysyłki albo `null`. Migracja wyłącznie dodaje (dane produkcyjne od 20.11.2026).

create function public.plugin_after_send(p_user uuid, p_task uuid, p_status text, p_add jsonb, p_remove uuid[]) returns text
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
  return case when cardinality(notes) > 0 then 'Po wysyłce: ' || array_to_string(notes, '; ') end;
end $$;

revoke execute on function public.plugin_after_send(uuid, uuid, text, jsonb, uuid[]) from public, anon, authenticated;
grant execute on function public.plugin_after_send(uuid, uuid, text, jsonb, uuid[]) to service_role;
