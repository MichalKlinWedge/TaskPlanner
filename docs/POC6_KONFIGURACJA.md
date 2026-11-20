# PoC-6 — konfiguracja kont zewnętrznych

Lokalnie wszystko działa bez kont (fałszywe Google, ICS i usługa push w testach). Konta są potrzebne do pomiarów
z kryterium Go (zmiana w Google → `calendar_events`, mail → zadanie, push do zamkniętej karty). Webhook `watch`
Google i Email Worker Cloudflare potrzebują **publicznego adresu HTTPS** funkcji, więc pomiary na prawdziwych
usługach robimy na projekcie Supabase w chmurze.

**Sekrety nigdy nie trafiają do czatu ani do repozytorium** — tylko do `.env.local` w głównym katalogu repozytorium (git-ignored; `setup` czyta go także z worktree),
skąd biorą je skrypty, oraz do sekretów Supabase / Cloudflare.

## 1. Supabase w chmurze (≈ 10 min)
1. supabase.com → New project: nazwa `taskplanner`, region `eu-central-1` (Frankfurt), plan Free. Free = 2 aktywne
   projekty na konto (`docs/USLUGI.md`) — jeśli ExpeditionPlan zajmuje oba, wstrzymaj jeden albo powiedz, to zostajemy
   przy pomiarach lokalnych.
2. W terminalu (raz): `npm run supabase -- login` (otwiera przeglądarkę, token zostaje lokalnie).
3. Do `.env.local` dopisz `SUPABASE_PROJECT_REF=<ref>` (ref = fragment adresu `https://<ref>.supabase.co`).

Resztę (`link`, `db push`, `functions deploy`, `secrets set`) robię ja — **zapytam przed pierwszym wdrożeniem**.

## 2. Google Cloud — Calendar API i OAuth (≈ 15 min)
1. console.cloud.google.com → nowy projekt `TaskPlanner`.
2. APIs & Services → Library → **Google Calendar API** → Enable.
3. Google Auth Platform (OAuth consent screen): typ **External**, nazwa „TaskPlanner”, e-mail kontaktowy — Twój.
   - Data access → Add scopes: `.../auth/calendar.readonly`, `openid`, `.../auth/userinfo.email` (Etap 12: też `.../auth/calendar.app.created` — §2a).
   - Audience → **Publish app** (stan *In production*, bez weryfikacji — ekran „unverified app” jest oczekiwany;
     w stanie *Testing* token odświeżania wygasa po 7 dniach).
4. Clients → Create client → **Web application**, Authorized redirect URIs:
   - `http://127.0.0.1:54521/functions/v1/calendar-sync/google/callback` (lokalnie)
   - `https://<ref>.supabase.co/functions/v1/calendar-sync/google/callback` (chmura)
5. Do `.env.local`: `GOOGLE_CLIENT_ID=…`, `GOOGLE_CLIENT_SECRET=…`.
6. W Google Calendar załóż kalendarz testowy (np. „TaskPlanner test”), w jego ustawieniach skopiuj
   **Tajny adres w formacie iCal** i dopisz do `.env.local` jako `ICS_TEST_URL=…` (to też sekret).

### 2a. Etap 12 — zapis do kalendarza „Task Planner” (≈ 5 min, robisz Ty w Google Cloud)
Dwukierunkowa synchronizacja zadań potrzebuje drugiego zakresu: **`https://www.googleapis.com/auth/calendar.app.created`**
(„Make secondary Google calendars, and see, create, change, and delete events on them”). Pozwala utworzyć kalendarz
„Task Planner” i pisać tylko w nim — bez prawa zapisu w innych kalendarzach (odczyt nadal przez `calendar.readonly`).
1. Google Auth Platform → Data access → Add or remove scopes → dopisz `.../auth/calendar.app.created` → Save.
   Zakres jest wrażliwy: aplikacja *In production* bez weryfikacji dalej działa z ekranem „unverified app”
   (limit 100 użytkowników — wystarczy).
2. Nic więcej w projekcie: ten sam klient OAuth i adresy przekierowania.
3. Konta połączone przed Etapem 12 mają tylko odczyt — w aplikacji: Ustawienia → „Połączone kalendarze” →
   **Połącz Google Calendar** jeszcze raz (to samo konto; zgoda pokaże nowy zakres, zostaw go zaznaczony).
   Bez zgody na zapis karta konta pokazuje „Brak zgody na zapis w Google…”, a zadania nie są wysyłane.

Zapasowo, gdyby `calendar.app.created` nie dawał `calendars.insert`/`events.watch` na prawdziwym Google: pełny
zakres `https://www.googleapis.com/auth/calendar` (wtedy zmiana stałej `CALENDAR_WRITE_SCOPE`
w `supabase/functions/_shared/google.ts`).

## 3. Cloudflare — Email Routing + Email Worker (≈ 15 min, wymaga domeny — decyzja D9)
1. Domena z DNS w Cloudflare (Websites → Add a domain, zmiana serwerów nazw u rejestratora). Bez domeny:
   e-mail mierzymy tylko lokalnie, a M19-e-mail przechodzi do v1.x (No-go z planu).
2. Domena → Email → Email Routing → **Enable** (Cloudflare doda rekordy MX/SPF).
3. Email Routing → Settings → **Subaddressing** włączone (adres `zadania+<token>@domena`).
4. W terminalu: `npx wrangler@4 login`.
5. Do `.env.local`: `INBOUND_DOMAIN=<domena>`.

Wdrożenie Workera (`tools/email-worker`), sekret współdzielony i regułę „`zadania@domena` → Send to Worker” robię ja
po Twoim „ok”. Na koniec poproszę o wysłanie maila z Twojej skrzynki na podany adres.

## 4. Web Push — bez konta
Klucze VAPID są już wygenerowane lokalnie (`npm run setup --workspace tools/edge-tests`, zapis do `supabase/functions/.env`).
Do pomiaru „push dociera do zamkniętej karty” potrzebny jest Twój Chrome: otworzę stronę próbną na `localhost`,
klikniesz „Zezwól”, zamkniesz kartę, a ja wyślę powiadomienie.
