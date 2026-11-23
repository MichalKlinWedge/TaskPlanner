# Usługi zewnętrzne — zweryfikowane warunki

Stan na **18.11.2026** (oficjalna dokumentacja i cenniki). Przed wprowadzeniem nowej usługi albo zmianą planu: sprawdzić ponownie i zaktualizować datę. Pewność: **W** wysoka, **Ś** średnia, **N** niska / niezweryfikowane.

## Supabase (plan Free)
| Warunek | Wartość | Pewność | Źródło |
|---|---|---|---|
| Aktywne projekty | **2 na konto** (łącznie we wszystkich organizacjach, gdzie jesteś Owner/Admin); wstrzymane się nie liczą | W | supabase.com/docs/guides/platform/billing-on-supabase |
| Wstrzymanie | po 7 dniach niskiej aktywności (ostrzeżenie mailem); przywrócenie do roku | W | supabase.com/docs/guides/platform/free-plan-pausing |
| Baza / Storage / MAU | 500 MB / 1 GB / 50 000 | W | supabase.com/pricing |
| Edge Functions | 500 000 wywołań; limity funkcji: 150 s wall clock, 2 s CPU, 256 MB | W | supabase.com/docs/guides/functions/limits |
| Kopie zapasowe | brak (dzienne kopie od Pro, PITR jako dodatek od Pro); dla Free zalecany własny zrzut (`db dump`) poza Supabase → nocny `pg_dump` w GitHub Actions (Etap 13) | W | supabase.com/docs/guides/platform/backups (19.11.2026) |
| Połączenie do `pg_dump` z GitHub Actions | bezpośrednie tylko IPv6 (Free/Pro bez dodatku IPv4), runnery GitHuba tylko IPv4 → **Session pooler** (port 5432, IPv4 na każdym planie) | W | supabase.com/docs/guides/database/connecting-to-postgres, …/platform/ipv4-address (19.11.2026) |
| `pg_cron`, `pg_net` na Free | **działają** — projekt TaskPlanner (Free, eu-west-1): zadanie co minutę → `pg_net` → Edge Function, 18.11.2026 (PoC-6) | W | PoC-6 |
| Uprawnienia nowych tabel (chmura) | nowe projekty nie nadają `anon`/`authenticated`/`service_role` do tabel z migracji — jawne `grant` w migracji (lokalnie nadawane automatycznie) | W | PoC-6 |
| Edge Runtime lokalnie | 1.77.8 (zgodny z Deno 2.1.4); importy spoza `supabase/functions` (np. `packages/core`) działają, `npm:` i `jsr:` przez mapę importów | W | PoC-6 |
| Realtime | 200 jednoczesnych połączeń, 2 mln wiadomości/mies., 100 wiad./s | W | supabase.com/docs/guides/realtime/limits |
| Auth Hook „Before User Created” | dostępny na **Free** i Pro; hook w Postgresie ma 2 s; odmowa `{"error": {"http_code", "message"}}`. Lokalnie (CLI 2.122.0, 21.11.2026): `signInWithOtp` dostaje 403, `code: 'unknown'` i komunikat hooka dosłownie, a `auth.admin.createUser` hooka **nie** wywołuje. Powrót z Google po odmowie niesprawdzony | W | supabase.com/docs/guides/auth/auth-hooks, …/auth-hooks/before-user-created-hook (21.11.2026) |

**Wniosek:** TaskPlanner ma projekt na osobnym koncie Supabase (D10), więc limit 2 aktywnych projektów go nie ogranicza; nadal obowiązuje wstrzymanie po 7 dniach niskiej aktywności (wiersz wyżej).

## Vercel (Hobby)
| Warunek | Wartość | Pewność | Źródło |
|---|---|---|---|
| Zastosowanie | tylko osobiste / niekomercyjne | W | vercel.com/terms |
| Cron Jobs (legacy) | maks. **raz dziennie**, precyzja ±59 min | W | vercel.com/docs/cron-jobs/usage-and-pricing |
| Vercel Schedules (beta) | co 15 min (jitter 15 min), 5 000 uruchomień/okres | W | vercel.com/docs/schedules/limits |

**Wniosek:** przypomnienia co minutę tylko przez `pg_cron` (D12) — Vercel się nie nadaje.

**Budżet wywołań (M21, 23.11.2026):** `reminders-push` co minutę ≈ 43 200 / mies.; `plugins` — `cron/tick` co minutę tylko przy zaległej pracy (`plugins_tick()` sprawdza w bazie, więc ≤ 43 200) plus `flush` raz na transakcję z prośbą o wysyłkę albo zmianą zadania przy włączonej regule zdarzeniowej (I2: przebieg w tle `EdgeRuntime.waitUntil`, czeka na okno opóźnienia ≤ 45 s — czas oczekiwania nie zużywa CPU, mieści się w 150 s wall clock); razem z `calendar-sync` (co 10 min) daleko poniżej 500 000. Przebieg wysyłek kończy się po 100 s (limit 150 s wall clock), resztę bierze następny.

## Expo EAS (Free)
| Warunek | Wartość | Pewność | Źródło |
|---|---|---|---|
| Buildy | 15 Android + 15 iOS miesięcznie, kolejka niskiego priorytetu, limit 45 min | W | expo.dev/pricing |
| EAS Update | 1 000 MAU, bez dopłat | W | docs.expo.dev/billing/plans |

**Wniosek (PoC-4, 18.11.2026):** EAS nie używamy — limit 15 buildów wyczerpał się w trakcie PoC-4, a builder w chmurze nie jest potrzebny. APK lokalnie i w GitHub Actions (`docs/ANDROID_BUILD.md`), bez EAS Update.

## GitHub Actions (plan Free, konto osobiste)
| Warunek | Wartość | Pewność | Źródło |
|---|---|---|---|
| Repozytoria publiczne | standardowe runnery bez opłat | W | docs.github.com/en/billing/concepts/product-billing/github-actions (18.11.2026) |
| Repozytoria prywatne — limit | **12 USD/mies.** wliczonego zużycia (kwota, nie minuty) ≈ **2 000 min** Linux 2-core; reset na początku miesiąca; zaokrąglanie każdego joba w górę do pełnej minuty | W | j.w. |
| Stawki (zamiast dawnych mnożników) | Linux 2-core x64 0,006 USD/min (1×), Linux arm64 0,005, Windows 2-core 0,010 (≈ 1,7×), macOS 0,062 (≈ 10×) | W | docs.github.com/en/billing/reference/actions-runner-pricing (18.11.2026) |
| Po wyczerpaniu | bez metody płatności — **blokada** (nie obciążenie) | W | j.w. |
| Artefakty | 500 MB (wspólnie z Packages), cache 10 GB na repozytorium | W | j.w. |
| Retencja artefaktów i logów | domyślnie 90 dni; repozytorium publiczne 1–90, prywatne 1–400 | W | docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization (19.11.2026) |
| Pobieranie artefaktów | wymaga dostępu do odczytu repozytorium — w publicznym = artefakt traktować jak publiczny (kopia bazy tylko zaszyfrowana) | W | docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts (19.11.2026) |
| REST API bez tokena (sprawdzanie aktualizacji APK w aplikacji: `GET /repos/…/releases`) | **60 zapytań/h na adres IP**; aplikacja pyta najwyżej co 6 h + ręcznie; pobranie pliku z Releases nie liczy się do limitu API | W | docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api; nagłówek `x-ratelimit-limit: 60` (20.11.2026) |
| Zaplanowane workflow | w repozytorium publicznym wyłączane po 60 dniach bez aktywności w repozytorium | Ś | docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows (19.11.2026) |

**Wniosek:** build APK na `ubuntu-latest` (najtańszy, bez problemu długich ścieżek Windows); szacunkowo 15–25 min na build bez cache Gradle → ok. 80–130 buildów/mies. w limicie. Artefakt z retencją 30 dni, starsze APK w Releases.

## Google (OAuth, Calendar API)
| Warunek | Wartość | Pewność | Źródło |
|---|---|---|---|
| Status *Testing* | token odświeżania wygasa po **7 dniach**; maks. 100 testerów | W | developers.google.com/identity/protocols/oauth2 |
| *In production* bez weryfikacji | dozwolone z zakresem wrażliwym: ekran „unverified app”, limit 100 nowych użytkowników łącznie, bez 7-dniowego wygasania (token wygasa po 6 mies. nieużywania) | W | support.google.com/cloud/answer/7454865 |
| Zakres kalendarza | **wrażliwy** (sensitive), nie ograniczony | Ś–W | developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification |
| `events.watch` | domyślny TTL 7 dni, bez automatycznego odnawiania; maks. czas życia niezweryfikowany | W / N | developers.google.com/workspace/calendar/api/guides/push |
| Limity API | 10 000 zap./min na projekt, 600 zap./min na użytkownika, 1 mln/dzień | W | developers.google.com/workspace/calendar/api/guides/quota |
| Opłaty | Google zapowiada opłaty za przekroczenie limitów „later in 2026” (z ≥ 90-dniowym wyprzedzeniem) — przy jednym użytkowniku bez znaczenia, ale obserwować | W | j.w. |

**Wniosek:** aplikacja OAuth w stanie *In production* (bez weryfikacji); odnawianie kanałów `watch` codziennie.

## Cloudflare (Email Routing + Email Workers)
| Warunek | Wartość | Pewność | Źródło |
|---|---|---|---|
| Koszt odbioru | bezpłatny, bez limitu (Workers Free); Worker rozliczany wg cennika Workers | W | developers.cloudflare.com/email-service/platform/pricing |
| Wymóg | **DNS domeny w Cloudflare** (własne rekordy MX) | W | developers.cloudflare.com/email-routing/get-started/enable-email-routing |
| Rozmiar wiadomości | do 25 MiB; na Free złożony handler może przekroczyć limit CPU | W | developers.cloudflare.com/email-routing/limits |
| Parsowanie | `message.raw` (ReadableStream) + `postal-mime`; `fetch()` do Edge Function możliwy | W | developers.cloudflare.com/email-routing/email-workers/runtime-api |
| Adresy | catch-all i plus-addressing (włączane w ustawieniach) | W | developers.cloudflare.com/email-routing/setup/email-routing-addresses |

**Wniosek:** Worker tylko przekazuje surową wiadomość albo minimalnie sparsowaną (mało CPU), resztę robi `inbound-email`.

## Web Push z Deno
| Warunek | Wartość | Pewność | Źródło |
|---|---|---|---|
| Biblioteka | `jsr:@negrel/webpush` 0.5.0 (VAPID, Deno/Workers); alternatywa `npm:web-push` | Ś | jsr.io/@negrel/webpush |
| Supabase | brak oficjalnego przykładu (dokumentują tylko FCM/Expo); używane w publicznych repozytoriach | Ś | — |

**Wniosek:** PoC-6: `jsr:@negrel/webpush` 0.5.0 działa w lokalnym Edge Runtime (podpis VAPID ES256 i treść aes128gcm sprawdzone w testach), `npm:web-push` niepotrzebny. Dostarczenie do prawdziwego Chrome (FCM) przy zamkniętej karcie potwierdzone 18.11.2026.

## Android — dokładne alarmy
| Warunek | Wartość | Pewność | Źródło |
|---|---|---|---|
| `SCHEDULE_EXACT_ALARM` | Android 14+: **domyślnie odmówione** dla nowych instalacji (targetSdk ≥ 33) poza budzikami i kalendarzami | W | developer.android.com/about/versions/14/changes/schedule-exact-alarms |
| `USE_EXACT_ALARM` | polityka Play: tylko budzik/timer albo kalendarz z powiadomieniami o wydarzeniach — menedżer zadań raczej **się nie kwalifikuje** | Ś | support.google.com/googleplay/android-developer/answer/16558241 |
| expo-notifications SDK 58 | `delivery: 'bestEffort'` (domyślnie, `setExactAndAllowWhileIdle`, bez pozwolenia — czas przybliżony), `'alarmClock'` (`setAlarmClock`); `requestExactAlarmPermissionsAsync()` | W | docs.expo.dev/versions/v58.0.0/sdk/notifications |

**Wniosek:** prośba o `SCHEDULE_EXACT_ALARM` z wyjaśnieniem w aplikacji; APK poza Play (EAS internal), więc polityka Play nie blokuje, ale planujemy zgodnie z nią. Pomiar w PoC-4.

## Biblioteki
| Biblioteka | Stan | Pewność | Źródło |
|---|---|---|---|
| `@sqlite.org/sqlite-wasm` 3.54.1 (Apache-2.0) | `opfs-sahpool` **bez** COOP/COEP; **brak współbieżności między kartami** (potrzebny lider kart); FTS5 w buildzie | W | sqlite.org/wasm/doc/trunk/persistence.md |
| `react-native-android-widget` 0.26.0 (MIT, 29.10.2026) | plugin Expo, wymaga dev buildu, deklaruje New Architecture | W | saleksovski.github.io/react-native-android-widget |
| `expo-share-intent` 9.0.0 (MIT, 21.10.2026) | SDK 58 → wersja 9.x | W | github.com/achorein/expo-share-intent |
| FullCalendar | MIT: daygrid, timegrid, list, multimonth, interaction (z `Draggable`); Premium: timeline, resource-* | W | fullcalendar.io/license |
| `@svar-ui/react-gantt` 2.8.3 (MIT, 17.11.2026) | darmowa: przesuwanie, zmiana długości, zależności (4 typy); PRO: auto-planowanie, ścieżka krytyczna, eksport, undo | W | docs.svar.dev/react/gantt |
| `@howljs/calendar-kit` 2.5.6 (MIT) | **ostatnie wydanie 10.10.2025**; otwarte zgłoszenia z 11.2026 o problemach z Reanimated 4.7 (#258 pętla renderów, #259 przeciąganie na Androidzie) | N–Ś | github.com/howljs/react-native-calendar-kit/issues |

**Wniosek:** calendar-kit to ryzyko (R7) — w PoC-4 sprawdzić razem z wariantem własnej osi dnia na Reanimated + Gesture Handler.
