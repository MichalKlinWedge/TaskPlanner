# Edge Functions

Funkcje Deno (SPECYFIKACJA §2): `reminders-push`, `calendar-sync`, `inbound-email`, `link-preview`.
Powstają od PoC-6; logikę biorą z `packages/core` (importy z rozszerzeniem `.ts` działają w Deno).
Sekrety: `npm run supabase -- secrets set NAZWA=wartość` (nigdy w repozytorium).
