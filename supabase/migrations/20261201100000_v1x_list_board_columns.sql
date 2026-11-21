-- Własne kolumny tablicy per lista zamiast per przestrzeń (v1.x, doprecyzowanie `*_v1x_board_columns.sql`).
--
--   * `lists.board_columns` — kolumny tablicy listy: tablica `{ id, name }` (jsonb) w kolejności
--     wyświetlania; `null` = brak. `tasks.board_column_id` bez zmian: id spoza kolumn listy zadania
--     (usunięta kolumna, zadanie przeniesione na inną listę) = pierwsza kolumna „Do przypisania”.
--   * `workspaces.board_columns` zostaje (migracje tylko dodają), ale klienci już go nie używają.
--
-- Przeniesienie danych: kolumny przestrzeni trafiają do każdej jej listy, która ich używa — ma zadanie
-- w jednej z tych kolumn albo tablicę w trybie „Własne” (`view_prefs.boardBy`). Ta sama definicja
-- (te same id) w kilku listach jest w porządku: zadanie należy do jednej listy. Znacznik pola z serwera
-- (`server_hlc`), więc późniejsza zmiana z urządzenia wygrywa jak zwykle.

alter table public.lists
  add column board_columns jsonb
    check (board_columns is null or (jsonb_typeof(board_columns) = 'array' and jsonb_array_length(board_columns) <= 50));

comment on column public.workspaces.board_columns is
  'Nieużywane — własne kolumny tablicy są per lista (lists.board_columns, migracja 20261201100000).';

update public.lists l
   set board_columns = w.board_columns,
       field_clock = l.field_clock || jsonb_build_object('board_columns', public.server_hlc())
  from public.workspaces w
 where w.id = l.scope_id
   and w.board_columns is not null
   and jsonb_array_length(w.board_columns) > 0
   and l.deleted_at is null
   and l.board_columns is null
   and (l.view_prefs ->> 'boardBy' = 'custom'
        or exists (
          select 1 from public.tasks t
           where t.list_id = l.id and t.deleted_at is null and t.board_column_id is not null
             and w.board_columns @> jsonb_build_array(jsonb_build_object('id', t.board_column_id::text))));
