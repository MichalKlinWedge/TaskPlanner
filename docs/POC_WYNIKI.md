# Wyniki PoC

## PoC-1 — Synchronizacja local-first w obie strony (18.11.2026)

**Werdykt: GO.** Decyzja D2 (web local-first) potwierdzona. Do sprawdzenia na telefonie po pierwszym dev buildzie (MVP-3): `expo-sqlite` w działaniu i synchronizacja w tle.

### Co powstało
| Element | Miejsce |
|---|---|
| Zakresy, tabele (przestrzenie, listy, zadania, tagi, tagi zadań, ukończenia), triggery, RLS, `push_changes`, `pull_changes` | `supabase/migrations/20261118120000_poc1_sync.sql` |
| Testy pgTAP: RLS, LWW per pole, idempotencja, drzewo (4 poziomy, cykle), kaskady usunięcia i przeniesienia, obcinanie zegara, deterministyczne id | `supabase/tests/sync.test.sql` (31 testów) |
| HLC, UUIDv7, UUIDv5 (czysty TS, własne SHA-1) | `packages/core/src/hlc.ts`, `ids.ts` |
| Silnik: `mutate` + outbox w jednej transakcji, push/pull, scalanie per pole, Realtime jako sygnał | `packages/sync/src/engine.ts`, `merge.ts`, `remote.ts`, `specs.ts` |
| Lokalna baza: Node (`node:sqlite`), telefon (`expo-sqlite`), przeglądarka (SQLite WASM + `opfs-sahpool` w workerze) | `packages/sync/src/adapters/*` |
| Kilka kart: lider przez Web Locks, reszta przez BroadcastChannel, przejęcie po zamknięciu lidera | `packages/sync/src/tabs.ts` |
| Strona prób w przeglądarce (tylko dev) | `apps/web/src/app/dev/sync`, `components/sync-lab.tsx` |
| Podłączenie na telefonie (bez ekranów) | `apps/mobile/src/lib/sync.ts`, `polyfills.ts` |

### Kryteria i wyniki
| Kryterium (PLAN_ETAPOWY PoC-1, SPECYFIKACJA §6) | Wynik | Jak sprawdzone |
|---|---|---|
| Różne pola offline na dwóch urządzeniach → obie zmiany | ✅ | `npm run test:sync` |
| To samo pole → wygrywa późniejszy HLC niezależnie od kolejności wysyłki | ✅ (oba warianty kolejności) | `test:sync`, pgTAP |
| Usunięcie kontra późniejsza edycja → usunięte, edycja zachowana na przywrócenie | ✅ | `test:sync`, pgTAP (kaskada i przywrócenie poddrzewa) |
| Przeniesienie w cykl na dwóch urządzeniach → drugie odrzucone, cofnięte do wersji serwera | ✅ `TP002`, wiersz serwera nadpisuje lokalny | `test:sync`, pgTAP |
| Podwójne ukończenie wystąpienia → jeden wiersz | ✅ (UUIDv5) | `test:sync`, pgTAP |
| 500 operacji offline wysłane < 10 s | ✅ **405 ms** (lokalny Supabase) | `test:sync` |
| Zmiana z telefonu na webie < 5 s po włączeniu sieci | ✅ ~0,4 s (push + pull) | `test:sync` |
| Zmiana na drugim urządzeniu online < 3 s (Realtime) | ✅ **469 ms** od wysłania; sygnał zmiany, nie pobranie po `SUBSCRIBED` | `test:sync` (licznik pobrań) |
| Zgubiony sygnał Realtime → nadrobiony | ✅ pobranie po ponownym `SUBSCRIBED` | `test:sync` |
| Zegar urządzenia +1 dzień nie wygrywa z późniejszą edycją | ✅ HLC z przyszłości obcinany do czasu serwera, klient dostaje wiersz serwera | `test:sync`, pgTAP |
| Obcy użytkownik: brak odczytu i zapisu | ✅ RLS + `TP003` (także gdy zmiana i tak przegrałaby LWW) | `test:sync`, pgTAP |
| Dwie karty przeglądarki na jednej bazie | ✅ lider trzyma bazę (OPFS, trwała), druga karta czyta i pisze przez lidera, po zamknięciu lidera przejmuje bazę z tymi samymi danymi | ręcznie w przeglądarce aplikacji (Chromium), `/dev/sync` |
| Bundel telefonu (Hermes) z silnikiem | ✅ `expo export --platform android` | ręcznie |

### Odstępstwa od SPECYFIKACJA §5 (do wpisania w v0.2)
- **Członkostwo per zakres** (`scope_members`) zamiast `workspace_members` — zakres osobisty też potrzebuje członka. Zakres osobisty ma id = id użytkownika i powstaje triggerem przy zakładaniu konta.
- **Brak kolumny `workspace_id`**: dla tabel przestrzeni `scope_id` = id przestrzeni. `scope_id` zadań, tagów zadań i ukończeń jest **wyliczany** (z listy / zadania) i klient go nie wysyła; listę podzadania wylicza się z rodzica.
- `due_time` jako tekst `GG:MM` (jak w EP: `time` w JSON daje `GG:MM:SS`).
- Unikalność nazwy tagu: `lower(name)` bez `unaccent`; tag o tej samej nazwie z dwóch urządzeń daje ten sam id (`tagId` = UUIDv5 z nazwy bez polskich znaków), więc konflikt nie powstaje.
- Kody odrzuceń: `TP001` głębokość, `TP002` cykl, `TP003` brak dostępu, `TP004` zły zakres, `TP005` nieznana tabela/pole, `TP006` zły HLC.

### Wnioski techniczne
- **Turbopack nie bundluje `@sqlite.org/sqlite-wasm`** (dynamiczny `new Worker(new URL(...))` w proxy VFS „opfs”). Rozwiązanie: pliki biblioteki kopiowane do `apps/web/public/sqlite-wasm` (`scripts/copy-sqlite-wasm.mjs`, `predev`/`prebuild`) i ładowane w workerze przez `import(/* turbopackIgnore */)`. `packages/sync` dostaje moduł SQLite z zewnątrz (`startSqliteWorker(load)`).
- **Kolejność w karcie-liderze**: rola i odświeżenie widoków dopiero po utworzeniu silnika — wcześniej UI pokazywało „zwykła” mimo trzymanej blokady.
- **Strict Mode** w dev uruchamia efekty dwa razy: koordynacja kart jest jedna na stronę i użytkownika (zamykana przy wylogowaniu), nie per efekt.
- `push_changes` sprawdza dostęp jawnie, a nie tylko w triggerze — inaczej obca operacja, która przegrałaby LWW, wracała jako „przyjęta bez zmian”.
- Funkcje STABLE w Postgresie widzą migawkę zapytania wywołującego → wersje zakresów i wiersze w `pull_changes` są ze sobą zgodne (ta sama obserwacja co w EP).

### Niesprawdzone / na później
- **Telefon w działaniu** (expo-sqlite, Realtime w tle, `expo-background-task`) — MVP-3 na dev buildzie; PoC-4 i tak wymaga dev buildu.
- **Automatyczny test dwóch kart (Playwright)** — sprawdzone ręcznie; Playwright dochodzi w MVP-2 razem z E2E webu.
- Firefox w trybie prywatnym (brak OPFS → baza w pamięci, ścieżka jest w kodzie, nieprzetestowana), Safari.
- **Kaskady lokalnie**: usunięcie rodzica i przeniesienie listy liczy serwer; lokalnie dzieci znikają / zmieniają przestrzeń dopiero po synchronizacji. Widoki (MVP-2) muszą ukrywać dzieci usuniętego rodzica albo `mutate` powtórzy kaskady lokalnie.
- Stronicowanie pierwszej pełnej migawki (`pull_changes` zwraca wszystko naraz; 2 000 zadań to ~1 MB) — przy MVP-1.
- Utrata dostępu do zakresu przy współdzieleniu (wiersz przeniesiony do zakresu, którego ktoś nie widzi, zostaje u niego) — v1.x.
