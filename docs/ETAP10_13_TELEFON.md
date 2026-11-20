# Etapy 10 i 13 — scenariusze na telefonie

Część telefoniczna przechwytywania i załączników (Etap 10) i dziennika błędów (Etap 13, D20) w `apps/mobile` (widżety Etapu 11 — osobna gałąź):

- załączniki: kolejka `src/lib/files.ts` (`createFileQueue` z `packages/sync`, pliki w `Paths.document/pending-files/<user>`, metadane w kv-store, wysyłka po udanej synchronizacji, kopia wysłanego pliku w `Paths.cache/attachments`), sekcja „Załączniki” na ekranie zadania `src/components/attachments-field.tsx` (aparat i galeria `expo-image-picker`, pliki `expo-document-picker`, link; podgląd obrazów w aplikacji, PDF i reszta przez `File.preview` → aplikacja systemowa);
- link z Chrome: `src/app/share.tsx` (`core` `sharedText`) → `QuickAddField` z `link` (`withLinkOps` — załącznik-link i `source`), tytuł strony z `link-preview` (`fillLinkPreviews` w `src/lib/files.ts`, po synchronizacji i po nowym linku);
- dziennik błędów: `src/lib/error-log.ts` (instalowany w `index.ts` przed zadaniami w tle: `ErrorUtils`, śledzenie odrzuceń obietnic Hermesa), `ErrorBoundary` w `src/app/_layout.tsx`, błędy i odrzucenia synchronizacji w `src/lib/sync.ts`; kolejka w kv-store (`errors.queue`), wysyłka do `report_client_errors` (5 s po błędzie, przy starcie, po synchronizacji, w tle); wersja = `versionName (versionCode)`; sekcja „Błędy aplikacji” w „Konto i synchronizacja”.

## Przygotowanie

- Lokalny Supabase, `adb reverse tcp:54521 tcp:54521`, funkcje (`npm run serve --workspace tools/edge-tests` — prawdziwe strony dla `link-preview`).
- **Nowy APK obowiązkowy** (nowe moduły natywne `expo-image-picker`, `expo-document-picker`, `expo-file-system`, `expo-application`). Release: `docs/ANDROID_BUILD.md`.
- Konto `dev@taskplanner.test` zalogowane na telefonie i na webie (`npm run web:local`).

## E1. Zdjęcie offline → załącznik (kryterium Etapu 10)

1. Odciąć serwer: `adb reverse --remove tcp:54521` (jak T8 w MVP-3) albo tryb samolotowy.
2. Dodać zadanie, otworzyć je → „Załączniki” → „📷 Aparat” → zdjęcie. Kafelek z przerywaną ramką: „czeka na sieć”; dotknięcie otwiera zdjęcie na pełnym ekranie.
3. Przywrócić serwer. Oczekiwane: po synchronizacji kafelek zwykły, na webie w panelu zadania miniatura i podgląd; obiekt w bucketcie `attachments`.

## E2. Galeria, plik, PDF

1. „🖼 Galeria” — dwa obrazy naraz; „📎 Plik” — PDF.
2. PDF otwiera się w aplikacji systemowej; obraz dodany na webie pobiera się przy pierwszym pokazaniu (miniatura), potem działa też bez sieci.
3. Przytrzymanie kafelka / linku = usunięcie z „Cofnij”.

## E3. Link z Chrome → zadanie z tytułem (kryterium Etapu 10)

1. Chrome → strona → ⋮ → Udostępnij → TaskPlanner → „Dodaj”.
2. Oczekiwane: zadanie z załącznikiem-linkiem i `source = {kind:'link'}`; tytuł = tytuł z Chrome albo sam adres, który `link-preview` zastępuje tytułem strony (z siecią po kilku sekundach).
3. To samo przy odciętym serwerze: zadanie z adresem w tytule, tytuł strony po powrocie sieci.

## B1. Dziennik błędów

1. „Konto i synchronizacja” → „Błędy aplikacji” → „Zapisz błąd testowy”.
2. Oczekiwane: na webie Ustawienia → „Błędy aplikacji”: „Błąd testowy z telefonu” · telefon · wersja `0.1.0 (1)`; wpis offline czeka w kolejce (licznik „Niewysłane”) i idzie po połączeniu.

## Wyniki

| Scenariusz | Data | Build | Wynik | Uwagi |
| --- | --- | --- | --- | --- |
| E1 | 19.11.2026 | release, S22 Ultra | OK | Serwer odcięty (`adb reverse --remove` + wymuszone zamknięcie — samo usunięcie przekierowania nie zrywa otwartych połączeń i pierwsze zdjęcie poszło od razu). Zdjęcie 1,9 MB: kafelek „czeka na sieć”, podgląd na pełnym ekranie; po przywróceniu wiersz `attachments` i obiekt w Storage po 16 s (czekanie na ponowienie synchronizacji). |
| E2 | 19.11.2026 | release, S22 Ultra | OK | PDF z „📎 Plik” (wybór Androida) → wysłany od razu, otwiera się w Adobe Reader z pliku w pamięci podręcznej. Galeria i usuwanie przytrzymaniem — nie sprawdzone osobno. |
| E3 | 19.11.2026 | release, S22 Ultra | OK | Prawdziwy Chrome (⋮ → Udostępnij → Więcej → TaskPlanner) podaje tytuł strony → zadanie „Local-first software - Wikipedia”, `source = {kind:'link', url, title}`, załącznik-link z podglądem. Sam adres (intencja `SEND` bez tematu) przy odciętym serwerze → tytuł = adres, po przywróceniu tytuł strony po 9 s. Błąd znaleziony: udostępnienie przy otwartym arkuszu szybkiego dodawania nie pokazywało ekranu „Udostępnione” — poprawione (arkusz się zamyka). |
| B1 | 19–20.11.2026 | release, S22 Ultra | OK | Pierwsza próba: wpis zapisany, ale niewysłany (przy pustej kolejce `flushErrors` zostawiał zakończoną obietnicę) — poprawione w `lib/error-log.ts`. Po poprawce: wpis z kolejki przetrwał reinstalację i poszedł przy starcie, nowy błąd testowy poszedł od razu (niewysłane: 0). Web → Ustawienia → „Błędy aplikacji”: „Błąd testowy z telefonu · Błąd · telefon · 0.1.0 (1)” ze stosem z `index.android.bundle`. |
