-- Własne kolumny tablicy przestrzeni (v1.x, kanban „Kolumny: Własne”).
--
--   * `workspaces.board_columns` — kolumny tablicy przestrzeni: tablica `{ id, name }` (jsonb) w
--     kolejności wyświetlania; `null` = brak własnych kolumn. Edytowane z tablicy przestrzeni
--     (dodanie, zmiana nazwy, usunięcie, przeciąganie). Cała tablica to jedno pole — LWW jak inne
--     pola wiersza (`field_clock`).
--   * `tasks.board_column_id` — kolumna zadania (id z `board_columns` jego przestrzeni); `null` albo
--     id spoza przestrzeni (usunięta kolumna, zadanie przeniesione) = pierwsza kolumna „Do przypisania”.
--     Bez klucza obcego: kolumny nie są wierszami, a nieznane id to po prostu „nieprzypisane”.
--
-- `push_changes` bierze dozwolone pola z `writable_columns` (information_schema), więc kolumny są
-- zapisywalne bez zmian w RPC. Klient z nowym zestawem pól raz pobiera zakresy od zera
-- (`SYNCED_SCHEMA` w packages/sync/src/engine.ts).

alter table public.workspaces
  add column board_columns jsonb
    check (board_columns is null or (jsonb_typeof(board_columns) = 'array' and jsonb_array_length(board_columns) <= 50));

alter table public.tasks add column board_column_id uuid;
