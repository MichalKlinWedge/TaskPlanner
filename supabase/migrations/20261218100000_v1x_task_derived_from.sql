-- Strzałki w widoku „Karteczki” (v1.x, PLAN_ETAPOWY.md § Widok „Karteczki” → Strzałki między kartami).
--
--   * „blokuje” = zwykła zależność `task_dependencies` (bez zmian w schemacie).
--   * „wynika z” = samo powiązanie, nie zależność: `tasks.derived_from` — lista id zadań-źródeł na
--     zadaniu, które z nich wynika (`null` = brak, najwyżej 50 — core `DERIVED_FROM_MAX`). Jedno pole,
--     więc LWW zapisuje całą listę naraz (nigdy pół zmiany). Id nie są sprawdzane z tabelą `tasks`:
--     źródło w koszu albo niewidoczne dla gościa klient po prostu pomija.
--
-- `push_changes` bierze dozwolone pola z `writable_columns` (wszystkie kolumny tabeli), więc kolumna
-- jest zapisywalna bez zmian w RPC; zapis gości bez edycji blokuje `stamp_row` jak przy innych polach
-- zadań (TP003). Zmiana powiązań nie trafia do historii zadania (`log_activity`, jak `canvas_pos`).
-- Migracja tylko dodaje kolumnę i podmienia `log_activity` (ta sama treść + pominięte pole).

alter table public.tasks
  add column derived_from jsonb
    check (derived_from is null or (
      jsonb_typeof(derived_from) = 'array'
      and jsonb_array_length(derived_from) between 1 and 50
      and not jsonb_path_exists(derived_from, '$[*] ? (@.type() != "string")')));

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
  insert into public.activity_log (scope_id, table_name, row_id, changes, device_id, actor_id)
  values (new.scope_id, tg_table_name, new.id, changes, node, auth.uid());
  return null;
end $$;
