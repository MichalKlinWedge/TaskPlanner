-- Przychodzące API — dopasowanie do kontraktu z Expedition Plan (`docs/INTEGRACJA_TP.md` w repozytorium EP).
-- Migracja addytywna (`create or replace`), wdrażana razem z `*_v1x_inbound_api.sql`.
--
--   * Pole nieobecne w wysyłce = aplikacja nim nie zarządza: nie zmienia się i nie zmienia rzutu `pushed`
--     (zostaje wartość z poprzedniej wysyłki, przy utworzeniu = wartość, z którą zadanie powstało); `null` = wyczyść.
--     `p_task` niesie tylko klucze obecne w treści.
--   * Strefa terminu (`time_zone`) dochodzi do pól API i scala się razem z datami: termin (`start_date`, `due_date`,
--     `due_time`, `time_zone`) zmienia się w całości albo wcale; zapis, po którym początek wypadłby po terminie
--     albo godzina bez daty, zostawia termin zadania (`kept`).
--   * Zamknięcie z aplikacji (`done` / `cancelled`, zmiana względem ostatniej wysyłki) zamyka zadanie także wtedy, gdy
--     użytkownik zmienił w Task Plannerze status na inny otwarty (np. `in_progress`) — przykład z kontraktu.
--     Zamknięcia ani innej zmiany użytkownika nie cofa (reguła ogólna: zmienione w Task Plannerze zostaje).
--   * Tagi tylko przy `p_tags` różnym od `null` (tagi nieobecne w wysyłce = bez zmian i bez zmiany `pushed.tags`).
--   * Wynik dostaje `applied` (kolumny zmienione tym zapisem, `tags` = tagi; przy utworzeniu = wysłane pola).
--   * `api_task_links.pushed.fields` ma klucze kolumn `tasks`, także `time_zone`.

create or replace function public.upsert_integration_task(p_token uuid, p_key text, p_task_id uuid, p_task jsonb, p_tags jsonb default null,
                                                          p_source jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_token public.api_tokens;
  v_hlc text := public.server_hlc();
  v_task public.tasks;
  v_link public.api_task_links;
  v_linked boolean;
  v_keys constant text[] := array['title', 'description_md', 'status', 'priority', 'start_date', 'due_date', 'due_time', 'time_zone'];
  v_dates constant text[] := array['start_date', 'due_date', 'due_time', 'time_zone'];
  v_defaults constant jsonb := jsonb_build_object('description_md', null, 'status', 'todo', 'priority', 4, 'start_date', null,
                                                   'due_date', null, 'due_time', null, 'time_zone', null);
  v_sent text[];
  v_dsent text[];
  v_want jsonb;
  v_row jsonb;
  v_cur jsonb;
  v_was jsonb;
  v_new jsonb;
  v_want_tags jsonb;
  v_cols text[] := '{}';
  v_kept text[] := '{}';
  v_applied text[] := '{}';
  v_f text;
  v_tags_changed boolean := false;
  v_status text;
begin
  select * into v_token from public.api_tokens where id = p_token and revoked_at is null;
  if not found then
    raise exception using errcode = 'TP003', message = 'Token odwołany';
  end if;
  if p_key is null or length(p_key) not between 1 and 300 then
    raise exception using errcode = '22023', message = 'Niepoprawny klucz zadania';
  end if;
  select coalesce(array_agg(k order by o), '{}') into v_sent from unnest(v_keys) with ordinality u(k, o) where coalesce(p_task, '{}') ? k;
  if not ('title' = any(v_sent)) or coalesce(btrim(p_task ->> 'title'), '') = '' then
    raise exception using errcode = '22023', message = 'Brak tytułu';
  end if;
  select jsonb_object_agg(k, p_task -> k) into v_want from unnest(v_sent) k;
  select coalesce(array_agg(k order by o), '{}') into v_dsent from unnest(v_dates) with ordinality u(k, o) where k = any(v_sent);
  if p_tags is not null then
    select coalesce(jsonb_agg(distinct lower(btrim(x.value ->> 'name'))), '[]') into v_want_tags
      from jsonb_array_elements(p_tags) x where coalesce(btrim(x.value ->> 'name'), '') <> '';
  end if;

  select * into v_link from public.api_task_links where task_id = p_task_id for update;
  v_linked := found;
  if v_linked and (v_link.user_id <> v_token.user_id or v_link.external_key <> p_key) then
    raise exception using errcode = 'TP003', message = 'Zadanie należy do innego klucza';
  end if;
  select * into v_task from public.tasks where id = p_task_id for update;

  perform set_config('taskplanner.source', 'api', true);
  perform set_config('taskplanner.actor', v_token.user_id::text, true);

  if v_task.id is null and v_linked then
    -- Usunięte na stałe w Task Plannerze — aplikacja go nie przywraca.
    v_status := 'deleted';
  elsif v_task.id is null then
    if not exists (select 1 from public.lists l where l.id = v_token.list_id and l.deleted_at is null)
       or public.list_access(v_token.list_id, v_token.user_id) is distinct from 'edit' then
      raise exception using errcode = 'TP003', message = 'Brak prawa zapisu na liście tokenu';
    end if;
    v_row := v_defaults || v_want;
    insert into public.tasks (id, list_id, title, description_md, status, priority, start_date, due_date, due_time, time_zone, completed_at,
                              source, created_by, field_clock)
    select p_task_id, v_token.list_id, r.title, r.description_md, r.status, r.priority, r.start_date, r.due_date, r.due_time, r.time_zone,
           case when r.status in ('done', 'cancelled') then now() end, p_source, v_token.user_id,
           (select jsonb_object_agg(k, v_hlc) from unnest(v_keys || array['list_id', 'completed_at', 'source']) k)
      from jsonb_populate_record(null::public.tasks, v_row) r;
    if p_tags is not null then
      perform public.api_task_tags(v_token.user_id, p_task_id, p_tags, '{}', v_hlc);
    end if;
    insert into public.api_task_links (task_id, user_id, external_key, token_id, pushed)
    values (p_task_id, v_token.user_id, p_key, v_token.id, jsonb_build_object('fields', v_row, 'tags', coalesce(v_want_tags, '[]')));
    v_applied := v_sent || case when p_tags is not null then array['tags'] else '{}'::text[] end;
    v_status := 'created';
  elsif not v_linked then
    raise exception using errcode = 'TP003', message = 'Zadanie nie pochodzi z API';
  elsif v_task.deleted_at is not null then
    v_status := 'trashed';
  elsif public.list_access(v_task.list_id, v_token.user_id) is distinct from 'edit' then
    raise exception using errcode = 'TP003', message = 'Brak prawa zmiany zadania';
  else
    v_cur := to_jsonb(v_task);
    v_was := coalesce(v_link.pushed -> 'fields', '{}');
    foreach v_f in array array['title', 'description_md', 'status', 'priority'] loop
      continue when not (v_f = any(v_sent)) or (v_want -> v_f) is not distinct from coalesce(v_cur -> v_f, 'null'::jsonb);
      if (coalesce(v_was -> v_f, 'null'::jsonb) is not distinct from coalesce(v_cur -> v_f, 'null'::jsonb)
          and v_hlc collate "C" > coalesce(v_task.field_clock ->> v_f, '') collate "C"
          or v_f = 'status' and v_want ->> 'status' in ('done', 'cancelled') and v_task.status in ('todo', 'in_progress', 'waiting')
             and coalesce(v_was -> v_f, 'null'::jsonb) is distinct from (v_want -> v_f))
         and not (v_f = 'status' and v_task.recurrence is not null and v_want ->> 'status' in ('done', 'cancelled')) then
        v_cols := v_cols || v_f;
      elsif coalesce(v_was -> v_f, 'null'::jsonb) is distinct from (v_want -> v_f) then
        v_kept := v_kept || v_f;
      end if;
    end loop;
    -- Termin jako całość (tylko wysłane pola terminu).
    if cardinality(v_dsent) > 0
       and exists (select 1 from unnest(v_dsent) k where (v_want -> k) is distinct from coalesce(v_cur -> k, 'null'::jsonb)) then
      v_new := v_cur || (select jsonb_object_agg(k, v_want -> k) from unnest(v_dsent) k);
      if not exists (select 1 from unnest(v_dsent) k where coalesce(v_was -> k, 'null'::jsonb) is distinct from coalesce(v_cur -> k, 'null'::jsonb))
         and not exists (select 1 from unnest(v_dsent) k where v_hlc collate "C" <= coalesce(v_task.field_clock ->> k, '') collate "C")
         and (v_new ->> 'due_date' is not null or (v_new ->> 'due_time' is null and v_new ->> 'start_date' is null))
         and (v_new ->> 'start_date' is null or v_new ->> 'due_date' is null or v_new ->> 'start_date' <= v_new ->> 'due_date') then
        v_cols := v_cols || array(select k from unnest(v_dsent) k where (v_want -> k) is distinct from coalesce(v_cur -> k, 'null'::jsonb));
      else
        v_kept := v_kept || array(select k from unnest(v_dsent) k where coalesce(v_was -> k, 'null'::jsonb) is distinct from (v_want -> k));
      end if;
    end if;

    if cardinality(v_cols) > 0 then
      execute format(
        'update public.tasks set (%1$s, field_clock) = (select %1$s, $2 from jsonb_populate_record(null::public.tasks, $1)) where id = $3',
        (select string_agg(quote_ident(c), ', ') from unnest(v_cols) c))
      using v_want, v_task.field_clock || (select jsonb_object_agg(c, v_hlc) from unnest(v_cols) c), p_task_id;
      if 'status' = any(v_cols) then
        update public.tasks
           set completed_at = case when status in ('done', 'cancelled') then now() end,
               field_clock = field_clock || jsonb_build_object('completed_at', v_hlc)
         where id = p_task_id;
      end if;
    end if;
    if p_tags is not null then
      v_tags_changed := public.api_task_tags(
        v_token.user_id, p_task_id, p_tags,
        array(select jsonb_array_elements_text(coalesce(v_link.pushed -> 'tags', '[]'))), v_hlc);
    end if;
    update public.api_task_links
       set pushed = jsonb_build_object('fields', v_was || v_want,
                                       'tags', case when p_tags is null then coalesce(v_link.pushed -> 'tags', '[]') else v_want_tags end),
           token_id = v_token.id, updated_at = now()
     where task_id = p_task_id;
    v_applied := v_cols || case when v_tags_changed then array['tags'] else '{}'::text[] end;
    v_status := case when cardinality(v_applied) > 0 then 'updated' else 'unchanged' end;
  end if;

  perform set_config('taskplanner.source', '', true);
  perform set_config('taskplanner.actor', '', true);
  return jsonb_build_object(
    'status', v_status,
    'applied', to_jsonb(v_applied),
    'kept', to_jsonb(v_kept),
    'task', case when v_status <> 'deleted' then public.plugin_task_context(p_task_id, v_token.user_id) end);
end $$;

revoke execute on function public.upsert_integration_task(uuid, text, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_integration_task(uuid, text, uuid, jsonb, jsonb, jsonb) to service_role;
