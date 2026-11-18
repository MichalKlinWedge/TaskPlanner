# Usługi zewnętrzne — zweryfikowane warunki

Stan na **18.11.2026** (oficjalna dokumentacja i cenniki). Przed wprowadzeniem nowej usługi albo zmianą planu: sprawdzić ponownie i zaktualizować datę. Pewność: **W** wysoka, **Ś** średnia, **N** niska / niezweryfikowane.

## Supabase (plan Free)
| Warunek | Wartość | Pewność | Źródło |
|---|---|---|---|
| Aktywne projekty | **2 na konto** (łącznie we wszystkich organizacjach, gdzie jesteś Owner/Admin); wstrzymane się nie liczą | W | supabase.com/docs/guides/platform/billing-on-supabase |
| Wstrzymanie | po 7 dniach niskiej aktywności (ostrzeżenie mailem); przywrócenie do roku | W | supabase.com/docs/guides/platform/free-plan-pausing |
| Baza / Storage / MAU | 500 MB / 1 GB / 50 000 | W | supabase.com/pricing |
| Edge Functions | 500 000 wywołań; limity funkcji: 150 s wall clock, 2 s CPU, 256 MB | W | supabase.com/docs/guides/functions/limits |
| Kopie zapasowe | brak (bez PITR) → własny `pg_dump` / eksport | W | supabase.com/docs/guides/platform/backups |
| `pg_cron`, `pg_net` na Free | oficjalnie bez ograniczeń planu, ale bez wprost potwierdzenia → **sprawdzić w PoC-6** | Ś | — |
| Realtime | 200 jednoczesnych połączeń, 2 mln wiadomości/mies., 100 wiad./s | W | supabase.com/docs/guides/realtime/limits |

**Wniosek:** sprawdzić, ile aktywnych projektów zajmuje ExpeditionPlan — przy 2 aktywnych TaskPlanner wymaga wstrzymania jednego albo planu Pro (D10).

## Vercel (Hobby)
| Warunek | Wartość | Pewność | Źródło |
|---|---|---|---|
| Zastosowanie | tylko osobiste / niekomercyjne | W | vercel.com/terms |
| Cron Jobs (legacy) | maks. **raz dziennie**, precyzja ±59 min | W | vercel.com/docs/cron-jobs/usage-and-pricing |
| Vercel Schedules (beta) | co 15 min (jitter 15 min), 5 000 uruchomień/okres | W | vercel.com/docs/schedules/limits |

**Wniosek:** przypomnienia co minutę tylko przez `pg_cron` (D12) — Vercel się nie nadaje.

## Expo EAS (Free)
| Warunek | Wartość | Pewność | Źródło |
|---|---|---|---|
| Buildy | 15 Android + 15 iOS miesięcznie, kolejka niskiego priorytetu, limit 45 min | W | expo.dev/pricing |
| EAS Update | 1 000 MAU, bez dopłat | W | docs.expo.dev/billing/plans |

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

**Wniosek:** test w PoC-6, wyjście awaryjne — `npm:web-push`.

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
