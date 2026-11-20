-- Współpracownicy widoczni w wybranych przestrzeniach (v1.x, jak `tags.workspace_ids`).
--
--   * `workspace_ids` — tablica id przestrzeni (jsonb), w których osoba podpowiada się przy zadaniach
--     (uczestnicy, odpowiedzialny) i w filtrze „Odpowiedzialny”; `null` albo `[]` = we wszystkich.
--     Współpracownik zostaje w zakresie osobistym, jeden na nazwę (`collaboratorId`), więc to tylko
--     filtr widoku: zostaje przy zadaniach z innych przestrzeni, a wpisana nazwa trafia w tę samą osobę.
--
-- `push_changes` bierze dozwolone pola z `writable_columns` (information_schema), więc kolumna jest
-- zapisywalna bez zmian w RPC. Klient z nowym zestawem pól raz pobiera zakresy od zera
-- (`SYNCED_SCHEMA` w packages/sync/src/engine.ts).

alter table public.collaborators
  add column workspace_ids jsonb check (workspace_ids is null or jsonb_typeof(workspace_ids) = 'array');
