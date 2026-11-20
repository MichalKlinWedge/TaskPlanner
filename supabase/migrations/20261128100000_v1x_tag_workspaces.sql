-- Tagi widoczne w wybranych przestrzeniach (v1.x, wariant „widoczność”).
--
--   * `workspace_ids` — tablica id przestrzeni (jsonb), w których tag się podpowiada i pokazuje w pasku
--     bocznym / filtrach; `null` albo `[]` = we wszystkich (jak dotąd). Tag zostaje w zakresie osobistym,
--     jeden na nazwę (`tagId`), więc to tylko filtr widoku: zadanie z innej przestrzeni może go mieć,
--     a `@nazwa` w szybkim dodawaniu nadal trafia w ten sam tag. Id usuniętych przestrzeni są pomijane.
--
-- `push_changes` bierze dozwolone pola z `writable_columns` (information_schema), więc kolumna jest
-- zapisywalna bez zmian w RPC. Klient z nowym zestawem pól raz pobiera zakresy od zera
-- (`SYNCED_SCHEMA` w packages/sync/src/engine.ts).

alter table public.tags
  add column workspace_ids jsonb check (workspace_ids is null or jsonb_typeof(workspace_ids) = 'array');
