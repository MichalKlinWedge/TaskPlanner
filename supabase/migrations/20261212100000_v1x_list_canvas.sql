-- Widok „Karteczki” — burza mózgów na liście (v1.x, PLAN_ETAPOWY.md).
--
--   * `tasks.canvas_pos` — komórka siatki karteczki `{ col, row }` (liczby całkowite); jedno pole, żeby
--     LWW per pole nie złożył kolumny z jednego urządzenia i wiersza z drugiego. `null` = karta jeszcze
--     nieułożona (pasek „Do ułożenia”). Kolizje (dwie karty w jednej komórce) rozwiązuje klient przy
--     wyświetlaniu (core `canvasLayout`).
--   * `lists.canvas_groups` — grupy karteczek listy: tablica `{ id, name, color, col, row, w, h }`
--     (prostokąty na siatce, tylko graficzne — zadanie nie wie, w której grupie leży).
--   * `task_tags.sort_key` — kolejność tagów w zadaniu (pierwszy kolorowy tag = kolor karteczki);
--     `null` = kolejność dodania (po tagach z kluczem).
--
-- `push_changes` bierze dozwolone pola z `writable_columns`, więc kolumny są zapisywalne bez zmian w
-- RPC; zapis gości blokuje `stamp_row` jak przy innych polach zadań i list. Przesunięcie karteczki nie
-- trafia do historii zadania (`log_activity`).

alter table public.tasks
  add column canvas_pos jsonb
    check (canvas_pos is null or (
      jsonb_typeof(canvas_pos) = 'object'
      and jsonb_typeof(canvas_pos -> 'col') = 'number'
      and jsonb_typeof(canvas_pos -> 'row') = 'number'));

alter table public.lists
  add column canvas_groups jsonb
    check (canvas_groups is null or (jsonb_typeof(canvas_groups) = 'array' and jsonb_array_length(canvas_groups) <= 100));

alter table public.task_tags
  add column sort_key text
    check (sort_key is null or sort_key ~ '^[0-9a-z]+$');

create or replace function public.log_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  changes jsonb;
  node text;
begin
  select coalesce(jsonb_object_agg(n.key, n.value), '{}') into changes
    from jsonb_each(to_jsonb(new)) n
   where n.key not in ('id', 'created_at', 'updated_at', 'created_by', 'row_version', 'field_clock', 'scope_id', 'canvas_pos')
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
