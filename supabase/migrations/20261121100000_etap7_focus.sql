-- Etap 7: stan timera skupienia w profilu (SPECYFIKACJA M14, §7.7).
--
-- Jeden aktywny timer na użytkownika, widoczny na drugim urządzeniu po synchronizacji: stan
-- (`FocusState` z `packages/core/src/focus.ts` — etap, zadanie, znaczniki czasu, otwarty wpis)
-- jest osobnym polem profilu, więc zmiana timera nie nadpisuje równoległej zmiany ustawień
-- (HLC per pole). Wpisy czasu są w `time_entries` (MVP-1). Pusty = brak timera.
--
-- `push_changes` bierze dozwolone pola z `writable_columns` (information_schema), a uprawnienia
-- do tabeli obejmują nową kolumnę — bez dodatkowych grantów.

alter table public.profiles add column focus jsonb check (focus is null or jsonb_typeof(focus) = 'object');
