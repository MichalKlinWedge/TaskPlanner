-- Współpracownicy: akronim i status (v1.x, po `*_v1x_collaborators_comments.sql`).
--
--   * `acronym` — skrót do znaczka przy zadaniu (1–5 znaków); `null` = inicjały z nazwy.
--   * `archived_at` — status: `null` = aktywny, data = nieaktywny (jak `lists.archived_at`). Tylko aktywni
--     podpowiadają się przy dodawaniu uczestnika i wyborze odpowiedzialnego; nieaktywny zostaje przy
--     zadaniach, w których już jest.
--
-- `push_changes` bierze dozwolone pola z `writable_columns` (information_schema), więc nowe kolumny
-- są zapisywalne bez zmian w RPC. Klient z nowym zestawem pól raz pobiera zakresy od zera
-- (`SYNCED_SCHEMA` w packages/sync/src/engine.ts).

alter table public.collaborators
  add column acronym text check (acronym is null or length(btrim(acronym)) between 1 and 5),
  add column archived_at timestamptz;
