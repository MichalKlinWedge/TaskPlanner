# Backlog różnic web ↔ APK (Android)

Stan kodu: 24.11.2026, commit `73e5983` (gałąź `claude/selfhost-docs`; kod aplikacji = `main` `a515cdb`). Ostatnie wydane APK: **0.1.25** (versionCode 26, tag `android-v0.1.25`, 23.11.2026). Porównanie z kodu, niczego nie uruchamiano na urządzeniu; co wymaga próby, ma dopisek **do sprawdzenia**. Podobnego dokumentu wcześniej nie było (`PLAN_ETAPOWY.md` § „Backlog do v1.0” to próby ręczne i wydajność, nie parytet).

## Podsumowanie

- **Rdzeń jest w parytecie**: pola zadania, powtarzanie, filtry i ich warunki, sortowanie / grupowanie / kolumny, kosz, nawyki (liczenie), przeglądy (kolejka i decyzje), udostępnianie przestrzeni, szablony, asystent AI, parser szybkiego dodawania (pełna lista w § „Sprawdzone, bez różnic”).
- **P1 zrobione w kodzie 24.11.2026 (A-01…A-05, razem z nimi A-07), czekają na wydanie APK i próbę na urządzeniu.** **P2 dla APK zrobione w kodzie tego samego dnia (A-06, A-08…A-25, R-03, R-04 i telefonowa część R-01).** Było w P1: ryzyko utraty danych albo mylące zachowanie na telefonie: opis gubi się po „Wstecz” (A-01), wylogowanie wyrzuca niewysłane zmiany (A-02), wyłączenie przypomnienia w nawyku kasuje wszystkie, także dodane na webie (A-03), ustawień profilu nie da się zmienić po kreatorze (A-04), telefon nie jest w „urządzeniach” i dubluje przypomnienia z przeglądarką (A-05).
- **P2 dla webu zrobione w kodzie 24.11.2026 (W-01…W-03, W-05…W-08, R-01, R-02), czeka na wdrożenie webu.** Z P2 zostaje W-04 (odhaczanie pól w podglądzie opisu).
- **Celowe** (nie do nadrabiania): Karteczki, edycja osi czasu, kalendarz tygodnia i miesiąca bez przeciągania, historia zmian, konfiguracja integracji — § „Różnice celowe”.
- **Baza:** żadna pozycja nie wymaga migracji. Prawie wszystkie pozycje „A” wymagają nowego APK (bez OTA, D17), pozycje „W” tylko wdrożenia webu.

| | P1 | P2 | P3 | razem |
|---|---|---|---|---|
| A — do nadrobienia w APK | 0 (5 zrobionych) | 0 (20 zrobionych) | 27 | 27 |
| W — do nadrobienia na webie | 0 | 1 (7 zrobionych) | 16 | 17 |
| R — działa inaczej, do ujednolicenia | 0 | 0 (4 zrobione) | 12 | 12 |

### Proponowana kolejność

1. **Wydać APK z tym, co już jest w kodzie** (§ „W kodzie, jeszcze nie w APK”) razem z krokiem 2.
2. ~~**Ochrona danych na telefonie** — A-01, A-02, A-03~~ (zrobione w kodzie).
3. **Ustawienia i przypomnienia** — ~~A-04, A-05, A-07~~ (zrobione w kodzie), ~~A-06~~ (zrobione w kodzie), ~~R-01~~.
4. ~~**Czytelność współdzielenia i synchronizacji na telefonie** — A-08, A-09, A-10, A-11, A-21~~ (zrobione w kodzie; link zaproszenia wymaga też wdrożenia webu).
5. ~~**Codzienna wygoda na telefonie** — A-12…A-20, A-22…A-25~~ (zrobione w kodzie).
6. **Szybkie poprawki webu** — ~~W-01…W-03, W-05…W-08~~ (zrobione w kodzie), W-04.
7. Reszta P3 przy okazji prac w danym pliku.

## Jak czytać

- **A-nn** — jest w web, brak lub uboższe w APK. **W-nn** — jest w APK, brak lub uboższe w web. **R-nn** — jest w obu, działa inaczej.
- Ścieżki: `W/` = `apps/web/src/components/app/`, `WL/` = `apps/web/src/lib/`, `M/` = `apps/mobile/src/`, `C/` = `packages/core/src/`. „grep M = 0” = brak trafień w całym `apps/mobile/src`, „grep W = 0” — w całym `apps/web/src`.
- Priorytet: **P1** utrata danych / obietnica ze specyfikacji bez obejścia, **P2** codzienne użycie, **P3** drobne albo rzadkie. Szacunek: **S** ≤ ½ dnia, **M** 1–2 dni, **L** > 2 dni.
- Kolumna „Mig. / APK”: „—” = bez migracji; „APK” = potrzebne nowe APK.

## A. Jest w web, brak lub uboższe w APK

### P1

✅ = zrobione w kodzie telefonu, jeszcze nie w wydanym APK; opis pozycji to stan sprzed zmiany.

| ID | Obszar | Web | APK | Co zrobić | Dowód | Dlaczego | Szac. | Mig. / APK |
|---|---|---|---|---|---|---|---|---|
| A-01 ✅ | Zadanie — opis | Zapis przy opuszczeniu pola i przy zamknięciu panelu | Zapis tylko przyciskiem „Gotowe”; „Wstecz” w trakcie edycji gubi szkic | Zapis przy odmontowaniu / utracie fokusu, jak `save` na webie | `W/task-panel.tsx:1252-1263`; `M/app/task/[id].tsx` `DescriptionField` (tylko „Gotowe”, brak `onBlur` i zapisu przy wyjściu) | Utrata wpisanego tekstu | S | — / APK |
| A-02 ✅ | Konto — wylogowanie | Najpierw `store.sync()`, pyta tylko, gdy coś zostało; dane zostają w przeglądarce | Ostrzega ogólnie, nie próbuje wysłać, czyści lokalną bazę | Przed wylogowaniem synchronizacja; w pytaniu liczba niewysłanych zmian | `W/signed-in.tsx:217-226`; `M/app/settings.tsx:199-209`, `M/lib/auth.ts:148-159` | Utrata niewysłanych zmian | S | — / APK |
| A-03 ✅ | Nawyki — przypomnienia | Lista wielu przypomnień: względne i jednorazowe | Jeden przełącznik: wyłączenie kasuje **wszystkie** przypomnienia nawyku (też z webu), nie widać ile ich jest; nawyk z samym przypomnieniem jednorazowym i bez pory nie da się zapisać („Przypomnienie wymaga pory”) | Lista jak na webie przez `habitSaveOps({ reminders })`; co najmniej: nie ruszać istniejących i nie wymagać pory dla jednorazowych | `W/habits.tsx:596-664, 836-897`; `M/app/habit-form.tsx:63,78-79,122-123,289`; `C/habits.ts:672-673` | Ciche kasowanie danych z webu | M | — / APK |
| A-04 ✅ | Ustawienia profilu | Pełny formularz: nazwa, strefa, pierwszy dzień tygodnia, godziny pracy, przypomnienie, czas bloku, pory przeglądów, motyw | Po kreatorze do zmiany tylko skupienie; przeglądów i motywu nie ma wcale; kreator pisze „wszystkie zmienisz później” | Sekcja „Profil” w Ustawieniach (te same pola `ProfileSettings`), z własnymi arkuszami godzin i strefy zamiast wolnego tekstu | `W/profile-form.tsx`; `M/app/settings.tsx`, `M/app/onboarding.tsx:84-135`; zapisy `profiles.settings` w M: tylko `settings.tsx:37`, `focus.tsx:110`, `panel-section.tsx:25`, kreator | Specyfikacja M1 [W+A]; obietnica w kreatorze; bez komputera nie da się zmienić godzin pracy | M | — / APK |
| A-05 ✅ | Przypomnienia — urządzenia | Lista urządzeń z kanałem przypomnień; karta mówi „przychodzi tylko na urządzenia z włączonymi przypomnieniami” | Telefon nie tworzy wiersza `devices`, nie czyta `reminder_channel`; alarmy planuje zawsze, gdy jest zgoda systemu. Przypomnienie i koniec etapu skupienia mogą przyjść dwa razy (push + alarm) | Rejestrować telefon w `devices` (`platform = 'android'` już dozwolone), `scheduler.ts` pomija planowanie przy `disabled`, w Ustawieniach telefonu przełącznik | `W/reminders-card.tsx:25,57`; `supabase/functions/reminders-push/index.ts` (filtr `platform = web`); `M/lib/scheduler.ts:98-99`; grep M `devices\|reminder_channel` = 0 | Specyfikacja M1/M8 („kanał per urządzenie, bez duplikatów”); podwójne powiadomienia do sprawdzenia na urządzeniu | M | — / APK |

### P2

| ID | Obszar | Web | APK | Co zrobić | Dowód | Dlaczego | Szac. | Mig. / APK |
|---|---|---|---|---|---|---|---|---|
| A-06 ✅ | Przeglądy — pora | Link na każdym ekranie, „Nie dziś”, zegar co minutę, powiadomienie raz dziennie | Link tylko w „Dziś”, bez odrzucenia, bez własnego zegara i bez powiadomienia | Zaplanować lokalne powiadomienie w `scheduler.ts` (`reviewsDue`), „Nie dziś” w pasku | `W/review.tsx:709-755`; `M/components/review.tsx:126-149`, `M/app/(tabs)/index.tsx:59`; `M/lib/scheduler.ts` — brak `reviewsDue` | Specyfikacja M8/M16, Etap 9 wymieniają powiadomienie o przeglądzie | M | — / APK |
| A-07 ✅ | Motyw | system / jasny / ciemny, synchronizowany | `settings.theme` ignorowany, zawsze systemowy (też widżety) | `usePalette` z `data.settings.theme`; wybór w A-04 | `W/profile-form.tsx` („Motyw”), `WL/theme.ts`; `M/components/ui.tsx:8`; grep M `settings.theme` = 0 | Ustawienie z webu nie działa na telefonie | S | — / APK |
| A-08 ✅ | Lista „tylko podgląd” | Kółko zablokowane, pole dodawania zastąpione notką | Wiersze i lista nie sprawdzają `listEditable`: „+”, kółko, gesty i akcje grupowe aktywne, zapis odrzuca silnik z dymkiem | `TaskRow` i `list/[id].tsx`: `listEditable` + `READONLY_LIST_NOTE` (szczegóły i tablica już blokują) | `W/task-item.tsx:251,310`, `W/views.tsx:387,426`; `M/components/task-row.tsx`, `M/app/list/[id].tsx` — brak `listEditable` (jest w `board.tsx:85`, `task/[id].tsx:180`) | Udostępnianie jest w produkcji | S | — / APK |
| A-09 ✅ | Synchronizacja — odrzucone zmiany | Dymek „Serwer odrzucił zmianę — cofnięto ją: …” | Tylko licznik / kody w stanie synchronizacji | Dymek w `lib/sync.ts` `onRejected` z tym samym tekstem | `WL/local-store.ts:79-83`, `W/task-item.tsx:58-62`; `M/lib/sync.ts:253-257`, `M/components/sync-indicator.tsx` | Zmiana znika bez wyjaśnienia | S | — / APK |
| A-10 ✅ | Synchronizacja — stan offline | „Offline — N zmian czeka” w nagłówku | Kropka w nagłówku; liczba zmian dopiero w Ustawieniach, bez stanu „offline” | Stan „Offline — N zmian czeka” w nagłówku / banerze | `W/signed-in.tsx:228-250`; `M/components/sync-indicator.tsx:36-52`, `M/components/header.tsx:54` | Specyfikacja M20 wprost | S | — / APK |
| A-11 ✅ | Zaproszenia — link | `/?invite=<token>` przyjmuje zaproszenie | Brak obsługi tokenu i App Links; link otwiera przeglądarkę, w aplikacji tylko pasek z `my_scope_invites` | Intent filter https + `assetlinks.json` na webie, przyjęcie tokenem (`accept_scope_invite`) | `WL/sharing.ts:45-88`, `W/sharing.tsx:283-295`; grep M `p_token\|inviteToken` = 0, `apps/mobile/app.json` tylko `scheme` | Zaproszenie wysłane z telefonu nie otwiera telefonu | M | — / APK |
| A-12 ✅ | Lista — ręczna kolejność i drzewo | Przeciąganie (też klawiaturą) zmienia kolejność i zagnieżdżenie | Sortowanie „Ręcznie” można wybrać, ale nie zmienić; rodzica tylko w szczegółach | Przeciąganie po przytrzymaniu z `dropTaskOps` albo „Przenieś wyżej / niżej” w menu | `W/dnd.tsx:42-73`; grep M `dropTaskOps` = 0 | D7 „pełna edycja” | L | — / APK |
| A-13 ✅ | Zapisany filtr — tworzenie | „Zapisz jako filtr” z chipów list, tablicy, tagu i widoków | Tylko edycja nazwy / warunków istniejącego | Przycisk przy chipach → `saved_filters` | `W/filter-views.tsx:42-71`, `W/shell.tsx:295,602`; `M/app/filter/[id].tsx` — jedyny zapis `saved_filters` | D7 „pełna edycja” | S | — / APK |
| A-14 ✅ | Zadanie — formatowanie opisu | 12 przycisków, przełączanie wł./wył., Enter kontynuuje listę | 5 przycisków, tylko dokładają znaki; brak linku, cytatu, kodu, numeracji, tabeli | Użyć core `markdownEdit` / `markdownContinueList` | `W/task-panel.tsx:1197-1210`; `M/app/task/[id].tsx` `wrap` / `linePrefix`; grep M `markdownEdit` = 0 | Logika już w core | M | — / APK |
| A-15 ✅ | Zadanie — tabele w opisie | Podgląd tabel GFM | Parser i widok nie znają tabel — wiersze `\|…\|` sklejają się w akapit | Blok tabeli w `C/markdown.ts` + `markdown-view.tsx` (+ testy) | `WL/editor.ts` (TableKit); grep `table` w `C/markdown.ts` = 0 | Tabela wstawiona przyciskiem na webie jest nieczytelna | M | — / APK |
| A-16 ✅ | Zadanie — wartości liczbowe | Czas 1–10080 min, ręczny wpis pracy 1–1440, odstęp zależności −365…365 | Wybór z krótkich list (10 / 9 / 12 wartości) | „Inna…” w arkuszach (pole liczby) | `W/task-panel.tsx:244-258,537-554`, `W/focus.tsx:344-357`; `M/app/task/[id].tsx:94-96,241-251,440,886-894` | Nie da się ustawić np. 25 min | S | — / APK |
| A-17 ✅ | Wiersz zadania — znaczki | Uczestnicy (do 4), 📎 liczba, „⇥ N×” | Tylko odpowiedzialny | Dociągnąć `participants` / `attachments` do `app-data.ts`, dopisać do meta | `W/task-item.tsx:247,266-273,334-345`; `M/components/task-row.tsx:91-100`; grep M `participants\|attachments` w `lib/app-data.ts` = 0 | Informacja z webu niewidoczna; uważać na wydajność startu | M | — / APK |
| A-18 ✅ | Skupienie — ekran | Ukończenie zadania, opis, przełączenie trwającego timera, wyszukiwarka wszystkich otwartych | Brak ukończenia i opisu; w trakcie timera `?task=` pomijany; wybór tylko zaległe / dziś / trwające (40) | Kółko + opis + „Przełącz na to zadanie” + szukanie | `W/focus.tsx:409,426-430,499,518,540`; `M/app/focus.tsx:68,77,98-104,186` | Specyfikacja M14 (tytuł, opis, podzadania) | M | — / APK |
| A-19 ✅ | Przegląd dnia — plan | Na końcu `DayPlan` z wydarzeniami i „Ułóż dzień” | Tylko lista zadań na dziś / jutro | Wstawić istniejące `components/day-plan.tsx` w `DailyDone` | `W/review.tsx:342`; `M/app/review/daily.tsx:168-215`, grep `DayPlan` w `M/app/review` = 0 | Specyfikacja M16 „podgląd planu na jutro (z kalendarzem)” | S | — / APK |
| A-20 ✅ | Nawyki — formularz | Pole „Koniec”: nigdy / data / po N razach | Brak (wartość zachowana, ale niewidoczna) | Pole „Koniec” jak w edytorze powtarzania (`HabitDraft.end`) | `W/habits.tsx:800-805`; grep `UNTIL\|end` w `M/app/habit-form.tsx` = 0 | Parytet formularza, reguła w core | S | — / APK |
| A-21 ✅ | Zaznaczanie poza listami (błąd) | — | Przytrzymanie wiersza w Szukaj, podzadaniach, Skupieniu i przeglądzie włącza zaznaczanie, a paska akcji tam nie ma (jest tylko w `TaskSections`); dotknięcie przestaje otwierać zadanie, zaznaczenie zostaje po zmianie ekranu | Wyłączyć przytrzymanie bez paska albo dodać `BottomBar`; „Wstecz” czyści zaznaczenie | `M/components/task-row.tsx:75-112`, `M/components/task-list.tsx:70,89-112`; `M/app/search.tsx:89`, `focus.tsx:186`, `review/daily.tsx:195` | Kod pewny; odczucie na telefonie do sprawdzenia | S | — / APK |
| A-22 ✅ | Szybkie dodawanie — dostępność | Z każdego widoku (Q, „+ Dodaj zadanie”) | „+” tylko na listach; wyłączone na tagu i filtrze, brak w kalendarzu, osi, Przeglądaj, Szukaj | Na tagu / filtrze „+” z tagiem; w kalendarzu z datą dnia | `W/shell.tsx:425,511-519`; `M/components/filter-screen.tsx:38` (`quickAdd={null}`), `M/app/calendar.tsx` | Główna rola telefonu = przechwytywanie | S | — / APK |
| A-23 ✅ | Załączniki — zapis | „Pobierz” dla każdego pliku | Obraz tylko na pełnym ekranie, bez zapisu / udostępnienia / powiększenia | Udostępnij / zapisz (nowa zależność, np. `expo-sharing`) | `W/attachments.tsx:445-470`; `M/components/attachments-field.tsx:133-141,204-208`; `expo-sharing` / `MediaLibrary` w `apps/mobile` = 0 | Nie da się wyjąć zdjęcia z aplikacji | M | — / APK |
| A-24 ✅ | Kalendarz — całodniowe | Klik otwiera zadanie | W widoku dnia dotknięcie od razu pyta o godzinę; zadania nie da się otworzyć | Menu jak przy bloku (Otwórz / Zaplanuj…) + „Zmień dzień…” | `W/calendar.tsx:345-349`; `M/app/calendar.tsx:208-223,287-293` | Zadania z datą bez godziny to częsty przypadek | S | — / APK |
| A-25 ✅ | Kalendarz — zmiana dnia | Przeciąganie między dniami | Przesuwanie tylko w obrębie dnia; inny dzień dopiero w szczegółach | Pozycja „Zmień dzień…” w menu bloku (kalendarz tygodnia bez przeciągania zostaje — M11) | `W/calendar.tsx:198-213`; `M/app/calendar.tsx:208-223` | Najczęstsza korekta planu | S | — / APK |

### P3

| ID | Obszar | Web | APK | Co zrobić | Dowód | Dlaczego | Szac. | Mig. / APK |
|---|---|---|---|---|---|---|---|---|
| A-26 | Paleta poleceń | 25 poleceń (widoki, akcje, motyw, przestrzeń, nowy projekt) | Szukaj bez poleceń, choć komentarz w core mówi, że telefon je pokazuje | Dołożyć `commandSearchItems(0)` (widoki, przeglądy, przestrzeń, nowy projekt) albo poprawić komentarz | `W/command-palette.tsx:31-57,155`; `C/commands.ts:1-4`; `M/app/search.tsx`, grep M `commandSearchItems` = 0 | Specyfikacja M17 „te same wyniki” | M | — / APK |
| A-27 | Szukanie | Podświetlenie trafień, ostatnio używane przy pustym polu | Brak obu | `ranges` z `search`, lista z `readRecent()` | `W/command-palette.tsx:113-122,186-188`; `M/app/search.tsx:52` | Wygoda | S | — / APK |
| A-28 | Eksport XLSX | Inbox, Dziś, Nadchodzące, lista, tablica, tag, filtr, oś czasu | Brak | core `xlsxWorkbook` + udostępnienie pliku (razem z A-23) | `W/export.tsx`, `W/timeline.tsx:568`; grep M `xlsx\|tasksSheet` = 0 | Rzadkie na telefonie | M | — / APK |
| A-29 | Kopia JSON | Eksport i import z podglądem | Brak | Na początek sam eksport (core `backup.ts`, `packages/sync/src/backup.ts`) + udostępnienie | `W/backup-card.tsx`; grep M `backup` = 0 | Jest nocna kopia serwera i web | M | — / APK |
| A-30 | Integracje | Historia wysyłek, „Ponów”, włączanie reguł, „Wyślij do…” dla wielu | Tylko „Wyślij do…” z jednego zadania, bez wyniku | Lista reguł wł./wył. (M21 [A]), ostatnie wysyłki, akcja grupowa | `W/plugins-card.tsx:731-913`, `W/shell.tsx:942-947`; `M/lib/plugins.ts`, grep M `plugin_deliveries` = 0 | Specyfikacja M21 przewiduje listę reguł na telefonie; edycja zostaje na webie | M | — / APK |
| A-31 | Kalendarze zewnętrzne | Podłączenie Google / ICS, odświeżenie, odłączenie, widoczność kalendarza, „Zadania z godziną → Google” | Tylko odczyt widocznych + kalendarze telefonu | Najpierw widoczność i stan konta (S); OAuth Google z telefonu osobno (L) — **do decyzji**, czy potrzebne | `W/calendars-card.tsx`; grep M `calendar-sync\|calendar_sync` = 0 | Konfiguracja jednorazowa, można na webie | S / L | — / APK |
| A-32 | Nawyki — statystyki | Rok kalendarzowy ‹ ›, zaplanowane dni; tabela 12 tygodni | Ostatnie 53 tygodnie, sam wykres | `habitYear({ year })` + `habitYearRange`, tabela | `W/habits.tsx:322-325,460-576`; `M/app/habit/[id].tsx:63,120` | Core gotowy | S | — / APK |
| A-33 | Skupienie — statystyki | Przestrzenie, listy / projekty, top 5 zadań | Tylko top 5 zadań | Dodać podziały z `focusWeek` | `W/focus.tsx:594-614`; `M/app/focus.tsx:215-226` | Specyfikacja M14 | S | — / APK |
| A-34 | Tagi w zadaniu | Kolor z chipa, kolejność przeciąganiem | Chip tylko usuwa; kolor na ekranie tagu, kolejności brak | Menu chipa: kolor, przesuń w lewo / prawo (`reorderTaskTagOps`), usuń | `W/task-panel.tsx:1033-1102`; `M/app/task/[id].tsx` `TagsField`; grep M `reorderTaskTagOps` = 0 | Kolejność liczy się głównie dla Karteczek | S | — / APK |
| A-35 | Szablony projektów | Zmiana nazwy | Tylko usunięcie | `renameTemplateOp` w sekcji szablonów | `W/templates.tsx:187-222`; grep M `renameTemplateOp` = 0 | Rzadkie | S | — / APK |
| A-36 | Oś czasu — podgląd | Filtr projektów, lista naruszeń, klikalna ścieżka krytyczna, kolumny Początek / Dni, strzałki | Liczba naruszeń, tekst ścieżki, bez filtra i strzałek | W ramach podglądu (D7): filtr projektów, lista naruszeń i ścieżki z otwieraniem zadań | `W/timeline.tsx:151-200,515-596,624-661`; `M/app/timeline.tsx:95-98,186-207` | Edycja osi celowo tylko na webie (D7) | M | — / APK |
| A-37 | Projekt — daty | Zmiana dat projektu na osi (pasek projektu) | Brak miejsca do zmiany | Pola początek / koniec w „Edytuj” listy (telefon), patrz też W-09 | `W/timeline.tsx:462-472`; zapisy `start_date` w `M/lib/workspaces.ts:107` (tylko czyszczenie) i szablony | Projekt z telefonu nie ma dat | S | — / APK |
| A-38 | Lista — zapamiętany tryb | Otwiera się w `view_prefs.view` | Zawsze lista, „▦ Tablica” osobno, wybór nie zapisywany | Przy `view = 'kanban'` otwierać tablicę (Karteczki → lista) | `W/views.tsx:367-368,495-501`; `M/app/list/[id].tsx` | Drobne | S | — / APK |
| A-39 | Kalendarz — „Zaplanuj…” | Źródła: dziś i zaległe, Inbox, bez terminu, zapisane filtry | Zadania dnia + bez terminu, max 60 | Wybór źródła i szukanie | `W/calendar.tsx:84-97,265-275`; `M/app/calendar.tsx:226-240` | Wygoda | M | — / APK |
| A-40 | Kalendarz — sygnały | Cieniowane godziny pracy, liczba konfliktów w każdym widoku | Brak cieniowania; w tygodniu / miesiącu tylko znak | Tło godzin pracy w `day-timeline.tsx`, licznik | `W/calendar.tsx:156,315-332`; grep `work` w `M/components/day-timeline.tsx` = 0 | Wygoda | S | — / APK |
| A-41 | Lista — podzadanie z wiersza | „+” przy wierszu | Tylko w szczegółach | Parametr `parentId` w `openQuickAdd` (jest, nieużywany) w menu wiersza | `W/task-item.tsx:374-385`; `M/components/task-list.tsx:82` | Wygoda | S | — / APK |
| A-42 | Liczniki nawigacji | Inbox, Dziś (czerwone zaległe), Nawyki | Zakładki bez liczników | `tabBarBadge` | `W/shell.tsx:392-400`; `M/app/(tabs)/_layout.tsx` | Drobne | S | — / APK |
| A-43 | Przestrzenie — rola i przełącznik | „(podgląd)” / „(udostępniona)” w przełączniku | Same nazwy; przełącznik tylko w 4 zakładkach; pasek zaproszeń tylko w `ScreenHeader` | Dopisek roli; przełącznik na tablicy / kalendarzu / osi; pasek w Przeglądaj | `W/shell.tsx:488-492,746-750`; `M/components/header.tsx:31-34`, `M/app/(tabs)/browse.tsx`, `M/components/sync-banner.tsx:56` | Drobne | S | — / APK |
| A-44 | Wybór listy | Szukanie w „Przenieś do…” | Przewijana lista bez pola | Pole szukania w `pickList` | `W/command-palette.tsx:169-176`; `M/components/task-menus.ts:35-43` | Przy wielu listach | S | — / APK |
| A-45 | Szybkie dodawanie — link | Chip „🔗 domena — trafi do załączników” | Zapis działa, podglądu brak (jest w `/share`) | Chip w `quick-add-field.tsx` | `W/quick-add.tsx:167-171`; `M/components/quick-add-field.tsx:109,163-189` | Drobne | S | — / APK |
| A-46 | Załączniki — drobne | Ikona strony linku, przyczyna błędu wysyłki, ✕ | Stałe 🔗, bez przyczyny, usuwanie tylko przytrzymaniem | Ikona, przyczyna, widoczne menu | `W/attachments.tsx:338-408`; `M/components/attachments-field.tsx:179-183,250-280` | Drobne | S | — / APK |
| A-47 | Pierwszy dzień tygodnia (błąd) | Natywne pola daty | Gest „Termin”, przypomnienie, koniec serii, szablon, formularz nawyku — zawsze poniedziałek | Domyślnie `data.settings.firstDayOfWeek` w `pickDate` | `M/components/pickers.tsx:53`, `M/components/task-menus.ts:14`; poprawnie: `task/[id].tsx` Termin / Początek | Drobne | S | — / APK |
| A-48 | Nazwy — limity (błąd) | 60 (filtr), 100 (przestrzeń) | Pole filtra 100, przestrzeni / listy 200 | Limity jak w bazie (`saved_filters.name` ≤ 60) | `M/components/edit-name-bar.tsx:31`, `M/components/editable-item.tsx:74`; `supabase/migrations/20261119100000_mvp1_model.sql:84` | Odrzucenie przez serwer do sprawdzenia | S | — / APK |
| A-49 | Przypomnienia — odłożenie | (web: bez akcji, W-07) | „Odłóż 10 min”, „Jutro”; brak „1 h” | Trzecia akcja (Android pokazuje do 3 — do wyboru, która ustępuje) | `C/reminders.ts:183` (`1h` nieużywane); `M/lib/reminders.ts:114-118` | Specyfikacja M8 „10 min / 1 h / do jutra” | S | — / APK |
| A-50 | Plan dnia / AI — drobne | Całodniowe zadania w planie; min/max daty kroku AI; data sprawdzenia klucza | Tylko wydarzenia całodniowe; bez ograniczeń daty (przycina core); bez daty | Wyrównać | `W/day-plan.tsx:128-143`, `W/ai-breakdown.tsx:134-156`, `W/ai-card.tsx`; `M/components/day-plan.tsx:57,98-100`, `M/components/ai-breakdown.tsx:107-110`, `M/components/ai-section.tsx:78-100` | Drobne | S | — / APK |
| A-51 | Szczegóły w trybie podglądu | Linki w opisie działają | `pointerEvents="none"` blokuje też linki, zależności i zwijanie sekcji | Wyłączać same pola, nie cały blok | `W/task-panel.tsx:117-123`; `M/app/task/[id].tsx:105-112` | Gość nie otworzy linku z opisu | S | — / APK |
| A-52 | Konto — drobne | Strona prywatności, stos i adres w dzienniku błędów (20 wpisów) | Brak linku; 10 wpisów bez stosu | Link + szczegóły wpisu | `W/login-screen.tsx:127`, `W/errors-card.tsx:71-98`; grep M `prywatnosc` = 0, `M/components/errors-section.tsx:65-78` | Drobne | S | — / APK |

## W. Jest w APK, brak lub uboższe w web

### P2

| ID | Obszar | Web | APK | Co zrobić | Dowód | Dlaczego | Szac. | Mig. / APK |
|---|---|---|---|---|---|---|---|---|
| W-01 ✅ | Projekt — status | Przy tworzeniu `active`, potem tylko odczyt w przeglądzie; nie widać i nie da się zmienić | Aktywny / wstrzymany / zakończony | Wybór w „Przestrzenie i listy” i w nagłówku projektu (`PROJECT_STATUS`) | `M/app/workspace/[id].tsx:60,104-110`; `W/workspaces-screen.tsx:158`, `W/review.tsx:411`; `PROJECT_STATUS` grep W = 0 | Specyfikacja M2; bez tego wstrzymany projekt wraca w przeglądzie tygodnia | S | — / web |
| W-02 ✅ | Lista — rodzaj, usunięcie, kolor | Rodzaj tylko przy tworzeniu; pustą można tylko zarchiwizować; kolor dopiero po utworzeniu | Zmiana lista ↔ projekt, „Usuń pustą listę”, kolor przy tworzeniu | Te same operacje w `workspaces-screen.tsx` | `M/app/workspace/[id].tsx:98-122,167`, `M/lib/workspaces.ts:102-122`; `W/workspaces-screen.tsx:150-160,287` | Pomyłki rodzaju nie da się naprawić na webie | S | — / web |
| W-03 ✅ | Szukanie w opisach | Paleta nie przekazuje opisu do indeksu | Szuka też w opisie; rodzaj listy jako słowo kluczowe | `description` w `taskSearchItem` (zapytanie jak na telefonie), `keywords` listy | `M/app/search.tsx:28-43`; `W/command-palette.tsx:150-151` | Specyfikacja M17 (tytuł, opis, tagi, lista) | S | — / web |
| W-04 | Opis — pola `[ ]` | Podgląd tylko do odczytu, klik w pole niczego nie zapisuje | Odhaczanie w podglądzie | `toggleMarkdownCheckbox` przez `onReadOnlyChecked` TipTapa | `M/app/task/[id].tsx` `MarkdownView onToggleCheckbox`; `W/task-panel.tsx:1179-1185`, `WL/editor.ts:14` | Lista zadań w opisie bez sensu w podglądzie | S | — / web |
| W-05 ✅ | Chipy filtra | Tylko Inbox, Dziś, Nadchodzące, lista, tablica, tag, filtr | Także kosz, kalendarz, nawyki, przegląd tygodnia, wyniki szukania | `FilterBar` w tych widokach | `M/app/trash.tsx:57`, `calendar.tsx:155`, `habits.tsx:45`, `review/weekly.tsx:289`, `search.tsx:80`; `W/shell.tsx:286` (`filterable`) | Specyfikacja M4 „chipy w każdym widoku” | M | — / web |
| W-06 ✅ | Wiersz zadania — tagi | Tylko w kolumnie „Tagi” listy | Tagi w każdym wierszu | `TAG_CHIP` w meta wiersza, gdy nie ma kolumny | `M/components/task-row.tsx`, `M/lib/rows.ts:17`; `W/task-item.tsx:264,324-347` | W Dziś / Inbox nie widać kontekstu | S | — / web |
| W-07 ✅ | Web Push — akcje | Zadanie bez akcji (`actions: []`); nawyk ma „Zrobione” | „Ukończ”, „Odłóż 10 min”, „Jutro” bez otwierania aplikacji | „Ukończ” / „Odłóż” w `sw.js` jak `habit-done` (wiadomość do karty albo `/?…`) | `M/lib/reminders.ts:114-118`; `apps/web/public/sw.js` (`actions: data.habit ? … : []`) | Telefon jest głównym kanałem, web pomocniczym | M | — / web |
| W-08 ✅ | Karta na tablicy | Bez osoby, statusu i kółka ukończenia | Osoba, status, kółko, gest terminu | Znaczek osoby i kółko na karcie | `M/app/board.tsx:465-471`, `M/components/task-row.tsx`; `W/board.tsx:61-94` | Na tablicy zespołowej nie widać, czyje zadanie | S | — / web |

### P3

| ID | Obszar | Web | APK | Co zrobić | Dowód | Dlaczego | Szac. | Mig. / APK |
|---|---|---|---|---|---|---|---|---|
| W-09 | Projekt — daty w formularzu | Tylko przez pasek na osi czasu | Brak (A-37) | Pola dat w „Przestrzenie i listy” | `W/timeline.tsx:462-472`, `W/workspaces-screen.tsx` — brak `start_date` | Razem z A-37 | S | — / web |
| W-10 | Pasek akcji grupowych | Tylko skróty i paleta | Widoczny pasek ✓ Dziś Jutro 📅 ! → 🗑 | Pasek przy zaznaczeniu | `M/components/task-list.tsx:112-149`; `W/shell.tsx:779-947` | Odkrywalność | S | — / web |
| W-11 | „Bez terminu” i gotowe dni | Paleta: samo pole daty; zdjęcie terminu tylko w panelu | Dziś, Jutro, Pojutrze, Pon., Za tydzień, „Bez terminu” | Pozycje w palecie „Wybierz datę…” | `M/components/pickers.tsx:190-196`, `M/components/task-menus.ts:13-24`; `W/command-palette.tsx:215-228` | Wygoda | S | — / web |
| W-12 | Kalendarz — menu bloku | Przeciąganie albo panel | Otwórz / Zmień godzinę / Czas trwania / Bez godziny | Menu kontekstowe bloku | `M/app/calendar.tsx:208-223`; `W/calendar.tsx:345-349` | Dostępność bez myszy | S | — / web |
| W-13 | Kalendarz — kliknięcie wydarzenia | Tylko dymek `title` | Szczegóły po dotknięciu (w widoku dnia) | Okienko szczegółów | `M/app/calendar.tsx:210-213`; `W/calendar.tsx:345-349` | Drobne | S | — / web |
| W-14 | Skupienie w nawigacji | Brak w pasku bocznym (F, paleta, wskaźnik) | Pozycja w Przeglądaj | Pozycja paska, gdy `focus.enabled` | `M/app/(tabs)/browse.tsx:93`; `W/shell.tsx:392-407` | Odkrywalność | S | — / web |
| W-15 | Ręczna synchronizacja | Stan to tekst, bez przycisku | „Synchronizuj teraz” | Klik w stan = `store.sync()` | `M/components/sync-indicator.tsx:51-62`; `W/signed-in.tsx:228-250` | Diagnostyka | S | — / web |
| W-16 | Logowanie kodem | Tylko link | Kod z maila | Pole kodu po wysłaniu linku (`verifyOtp`) | `M/lib/auth.ts:48-52`; grep W `verifyOtp` = 0 | Mail otwarty na innym urządzeniu | S | — / web |
| W-17 | Usunięcie nawyku | Pytanie, potem dymek **bez** „Cofnij” | „Cofnij” w dymku | Dodać `undo` (`restoreTaskOps`) | `M/app/habit/[id].tsx:77-79`; `W/habits.tsx:345-349` | Spójność | S | — / web |
| W-18 | Przegląd — listy klikalne | „Ukończone dziś” to liczba; plan i „Nadchodzący tydzień” nieklikalne | Listy z otwieraniem i ukończeniem | Otwieranie zadania z listy | `M/app/review/daily.tsx:168-195`, `weekly.tsx:236`; `W/review.tsx:303,330,626` | Wygoda | S | — / web |
| W-19 | Przypomnienie o porze — podpis (błąd) | Dzień liczony względem terminu zadania (bez terminu zawsze „dziś”) | Względem dziś | `relativeDay(at_date, today)` | `W/task-panel.tsx:1121`; `M/app/task/[id].tsx` `RemindersField` | Mylący opis | S | — / web |
| W-20 | Oś czasu — klik projektu | Nic nie robi | Otwiera listę | `navigate({ view: "list" })` | `M/app/timeline.tsx:164-167`; `W/timeline.tsx:416` | Drobne | S | — / web |
| W-21 | Przechwytywanie — wskazówka | Karta kieruje użytkownika Androida do PWA | — | Dodać link do APK (wydanie `android-v*`) | `W/capture-card.tsx:33-35`; `M/lib/app-update.ts` | Dwie drogi na ten sam telefon | S | — / web |
| W-22 | Wersja aplikacji | Nie widać wersji ani nowej wersji | „Aktualizacje”, baner | Wersja w Ustawieniach | `M/components/app-update.tsx`; `WL/error-log.ts:17` (tylko do dziennika); brak w UI do sprawdzenia | Drobne | S | — / web |
| W-23 | Pomoc składni | Jedna linia przykładu | Ściąga w oknie | Rozwijana ściąga w oknie Q | `M/app/quick-add.tsx:59-62`; `W/quick-add.tsx:204-206` | Wygoda | S | — / web |
| W-24 | Tablica „tylko podgląd” | Karty dają się chwycić, zapis odrzuca silnik | Przeciąganie zablokowane (menu „⇄” nie — też poprawić) | `useSortable({ disabled: locked })` | `M/app/board.tsx:85,458`; `W/board.tsx:63,344` | Razem z A-08 | S | — / web (+ APK) |

## R. Jest w obu, działa inaczej

| ID | Obszar | Web | APK | Co zrobić | Dowód | Priorytet — dlaczego | Szac. | Mig. / APK |
|---|---|---|---|---|---|---|---|---|
| R-01 ✅ | Zakres wylogowania | `signOut()` bez `scope` | `signOut()` bez `scope` | `scope: 'local'` po obu stronach: domyślny zakres supabase-js to `global`, więc wylogowanie na jednym urządzeniu kończy sesję na wszystkich | `W/signed-in.tsx:225`, `M/lib/auth.ts:149-150`; `@supabase/auth-js` `signOut(options = { scope: 'global' })` | P2 — telefon traci sesję po wylogowaniu webu; skutek do sprawdzenia | S | — / APK + web |
| R-02 ✅ | Filtr zmieniony na innym urządzeniu | Trzyma stary szkic, „Zapisz zmiany” może nadpisać nowszy | Odrzuca szkic i bierze nową wersję | Web jak telefon (klucz z `query`) | `W/filter-views.tsx:163-165`; `M/app/filter/[id].tsx:22-35` | P2 — możliwe nadpisanie; do sprawdzenia | S | — / web |
| R-03 ✅ | Wklejenie wielu linii | Pyta przy wklejeniu; „nie” = złączony tekst do edycji | Pyta przy dodaniu; „Jedno” (też zamknięcie okna) od razu zapisuje jedno zadanie | Telefon: zamknięcie = anuluj | `W/quick-add.tsx:130-140`; `M/components/quick-add-field.tsx:123-133`, `M/components/actions.tsx:54` | P2 — przypadkowy zapis | S | — / APK |
| R-04 ✅ | Pierwszy dzień tygodnia | Tylko poniedziałek / niedziela | Kreator: dowolny z 7 | Ten sam zestaw (pon. / niedz.) | `W/profile-form.tsx` (Select 1/7); `M/app/onboarding.tsx:92-96` | P2 — wartość z telefonu nie ma opcji na webie | S | — / APK |
| R-05 | Zwinięte projekty osi | W profilu, synchronizowane | Stan lokalny do wyjścia z ekranu | Odczyt / zapis `settings.timeline.collapsed` | `W/timeline.tsx:269-273,427-430`; `M/app/timeline.tsx:76` | P3 | S | — / APK |
| R-06 | Filtr doraźny | Kasowany przy zmianie widoku | Osobny na zakładkę, do zamknięcia aplikacji | Ustalić jedną zasadę | `W/shell.tsx:254,265`; `M/app/(tabs)/index.tsx:26` | P3 | S | — |
| R-07 | Licznik na „Przestrzenie i listy” | Otwarte z podzadaniami | Tylko zadania główne | Jeden licznik (jak w pasku / Przeglądaj: wszystkie poziomy) | `W/workspaces-screen.tsx:51`; `M/lib/workspaces.ts:52` | P3 — różne liczby tej samej listy | S | — / APK |
| R-08 | Nadchodzące — domyślny termin | Q bez terminu, brak pola u góry | „+” daje termin dziś | Ustalić (np. bez terminu po obu) | `W/shell.tsx:415`; `M/app/(tabs)/upcoming.tsx:57` | P3 | S | — / APK |
| R-09 | Udostępnianie do aplikacji | Cel = otwarta lista, okno się zamyka | Zawsze Inbox, ekran zostaje | Ujednolicić cel; pliki / obrazy — brak po obu (N) | `W/shell.tsx:125-127,562`; `M/app/share.tsx` | P3 | S | — / APK |
| R-10 | Skróty z ikony | Szybkie dodawanie / Dziś / Kalendarz | Szybkie dodawanie / Dziś / **Szukaj** | Specyfikacja M20 mówi o „Tryb skupienia” na telefonie — do decyzji | `apps/web/src/app/manifest.ts:25-29`; `apps/mobile/plugins/app-shortcuts.js:11-13` | P3 | S | — / APK |
| R-11 | Usunięcie członka przestrzeni / współpracownika | Członek: pyta; współpracownik: od razu z „Cofnij” | Odwrotnie: członek od razu, współpracownik pyta | Członek — pytać po obu | `W/sharing.tsx:175`, `W/collaborators.tsx:82-90`; `M/components/sharing.tsx:123`, `M/app/collaborators.tsx:81` | P3 | S | — / APK |
| R-12 | Zaznaczenie po akcji | Zostaje; czyści zmiana widoku | Czyści się po akcji; zmiana ekranu nie czyści | Ustalić (razem z A-21) | `W/shell.tsx:264,785-793`; `M/components/actions.tsx:163` | P3 | S | — / APK |
| R-13 | Kółko zadania anulowanego | Puste | Zaznaczone | Ujednolicić | `W/task-panel.tsx:192-198`; `M/app/task/[id].tsx` (`closed`) | P3 | S | — |
| R-14 | „Wynika z” (`derived_from`) | Widać i edytuje się tylko na Karteczkach; w panelu zadania nie ma | Nigdzie | Pole tylko do odczytu „Wynika z…” w panelu i na ekranie zadania (celowo tylko web dotyczy Karteczek) | `W/canvas.tsx:270,594`; grep M `derived` = 0, `W/task-panel.tsx` — brak | P3 — powiązanie niewidoczne poza tablicą | S | — / APK + web |
| R-15 | Nagłówek widżetu „Nawyki” | — | Otwiera „Dziś” zamiast „Nawyki” | `APP_URI` na `/habits` | `M/widget/habits-widget.tsx:31` | P3 | S | — / APK |
| R-16 | Skupienie wyłączone | `#/focus` pokazuje komunikat | Wejście ukryte, ale `/focus` z linku działa | Komunikat na telefonie | `W/shell.tsx:337-340`; `M/app/focus.tsx` (brak warunku), `M/lib/focus.ts:312` | P3 — do sprawdzenia | S | — / APK |

## Różnice celowe (nie nadrabiać)

| ID | Różnica | Decyzja |
|---|---|---|
| C-01 | Karteczki (układ, grupy, strzałki, „Ułóż”, eksport PNG / PDF) tylko na webie; telefon pokazuje zwykłą listę | `PLAN_ETAPOWY.md` v1.x „Widok «Karteczki»”: „tylko web, bez APK”, `M` grep `canvas` = 0 |
| C-02 | Edycja osi czasu (przeciąganie, zależności na osi, „Przesuń zależne”, przesunięcie projektu) tylko na webie; telefon = podgląd | D7 (zmiana 22.11.2026), M12 [W] |
| C-03 | Tablica na telefonie: jedna kolumna na ekran, przenoszenie menu „⇄” / chipem, bez zwijania kolumn i zaznaczania wielu kart | D7 („kanban uproszczony”), M10 |
| C-04 | Telefon: tydzień = agenda, miesiąc = kropki + lista; siatka godzin tylko w dniu, własna oś dnia | M11 [A], D16 |
| C-05 | Historia zmian zadania tylko na webie | M3 „Historia zmian zadania [W]” |
| C-06 | Połączenia i reguły integracji konfigurowane tylko na webie (na telefonie brakuje jednak listy reguł wł./wył. — A-30) | M21 [W], `PLAN_ETAPOWY.md` I2 („telefon ich nie edytuje”) |
| C-07 | Skróty klawiszowe, paleta `Ctrl+K`, zaznaczanie zakresu, przeciągnij-upuść pliku, bookmarklet, PWA (instalacja, karta offline, wiele kart), panel zadania pełnoekranowy | M3 [W], M17 [W], M20, D11 |
| C-08 | Gesty wiersza i przeglądu, wibracje, widżety, skróty aplikacji, kalendarze telefonu, aparat, alarmy lokalne, trwałe powiadomienie skupienia, niegasnący ekran, synchronizacja w tle | M8, M9 [A], M11 [A], M14 [A], M16 [A], M20, D11 |
| C-09 | Aktualizacja w aplikacji (APK z GitHub), wybór serwera, praca bez konta, narzędzia PoC tylko na telefonie | D17 |
| C-10 | Dostarczanie przypomnień: telefon lokalnie (7 dni, 50 alarmów), web przez serwer | M8 (ale patrz A-05 — kanał per urządzenie) |
| C-11 | Widżet pulpitu i globalny skrót na komputerze — brak | D11 (Tauri w v1.x) |
| C-12 | Dźwięk / wibracja powiadomień ustawiane w kanałach Androida, nie w aplikacji | Ograniczenie systemu; patrz „Do sprawdzenia” |

## W kodzie telefonu, jeszcze nie w wydanym APK 0.1.25

**Aktualizacja 24.11.2026:** wydano 0.1.26 z `main` (`android-v0.1.26`) — ma asystenta AI i plan na jutro, **nie ma** P1 i P2 z tego backlogu (ta gałąź jest jeszcze niescalona z `main`).

`git diff android-v0.1.25..HEAD -- apps/mobile` (14 plików); `app.json` nadal `0.1.25` / 26 — wydanie wymaga podbicia wersji i taga.

- **Asystent AI**: Ustawienia → „Asystent AI” (`M/components/ai-section.tsx`, `M/lib/ai.ts`), „✨ Rozbij na kroki” (`ai-breakdown.tsx`), „Ułóż dzień” i „✨ Ułóż z AI” (`day-planner.tsx`), „Podsumowanie tygodnia” (`week-summary.tsx`, krok 7 w `review/weekly.tsx`).
- **Plan dnia**: przełącznik „Dziś | Jutro” (`day-plan.tsx`, `lib/day-plan.ts`).
- **Dane**: odczyt `ai_accounts` i pola `tasks.derived_from` (schemat lokalny — po aktualizacji jednorazowe ponowne pobranie), limit 140 s dla `functions/v1/ai/` (`lib/sync.ts`).
- **P1 z tego backlogu (24.11.2026)**: zapis szkicu opisu przy wyjściu z zadania i przejściu w tło (A-01, `app/task/[id].tsx`); wylogowanie po próbie synchronizacji, z liczbą niewysłanych zmian (A-02, `unsentChanges` w `lib/sync.ts`); lista przypomnień nawyku (A-03, `app/habit-form.tsx`); sekcja „Profil” w Ustawieniach (A-04, `components/profile-section.tsx`, `updateSettings` w `lib/profile.ts`) i motyw z `settings.theme` (A-07, `lib/theme.ts`; widżety zostają przy motywie systemu); telefon w `devices` i przełącznik „Przypomnienia na tym telefonie” — wyłączony (też z weba) kasuje zaplanowane alarmy i wycisza koniec etapu skupienia (A-05, `lib/device.ts`). Sprawdzone: typy, lint, testy, bundel; **nie na urządzeniu**.
- **P2 z tego backlogu (24.11.2026)**, sprawdzone: typy, lint, testy, bundel; **nie na urządzeniu**:
  - przeglądy: powiadomienie o porze (core `reviewFireTimes`, `lib/scheduler.ts`), „Nie dziś” i zegar w pasku (`lib/review-nudge.ts`, A-06); plan dnia z „Ułóż dzień” na końcu przeglądu dnia (A-19);
  - współdzielenie i synchronizacja: wiersze i lista „tylko podgląd” (A-08), dymek odrzuconej zmiany (A-09), „Offline — N zmian czeka” (A-10), link zaproszenia otwiera aplikację i przyjmuje token, też po zalogowaniu i z „Udostępnij” (A-11: `app/invite.tsx`, nowe linki `/invite?invite=<token>`, App Links w `app.json`; na webie przekierowanie `/invite` → `/` i `public/.well-known/assetlinks.json` z odciskiem klucza wydań);
  - listy: kolejność i zagnieżdżanie jednego zaznaczonego zadania przyciskami ↑ ↓ ⇥ ⇤ (core `nudgeTaskOps`, A-12), „Zapisz jako filtr” (A-13), znaczki uczestników / 📎 / „⇥ N×” (A-17), zaznaczanie tylko tam, gdzie jest pasek akcji, „Wstecz” je zdejmuje (A-21);
  - zadanie: 12 przycisków opisu i Enter w liście (`components/description-field.tsx`, core `markdownNewline`, A-14), tabele GFM w podglądzie (core `markdown.ts`, A-15), „Inna…” przy czasie, wpisie pracy i odstępie (`pickAmount`, A-16), „Udostępnij / zapisz” i „Otwórz w…” załącznika (`expo-sharing`, A-23);
  - skupienie: ukończenie, opis, „Przełącz na…”, szukanie wśród otwartych (A-18); nawyki: „Koniec” (A-20); „+” na tagu, filtrze i w kalendarzu z datą dnia (A-22); kalendarz: menu całodniowych i „Zmień dzień…” (A-24, A-25);
  - wylogowanie kończy sesję tylko na tym telefonie (R-01), zamknięcie pytania o wiele linii = anuluj (R-03), pierwszy dzień tygodnia pon. / niedz. (R-04).
- Nowa zależność natywna `expo-sharing` i filtr intencji — potrzebny pełny build (prebuild) APK. **Kolejność wydania: najpierw web** (przekierowanie `/invite` i `assetlinks.json`), potem APK — telefon wysyła już linki `/invite`.
- Do tego czasu użytkownik APK nie widzi niczego z asystenta AI, a „Ułóż dzień” i „Jutro” w planie są tylko na webie. Samych pozycji powyżej nie wpisano do sekcji A (w kodzie parytet).

## Do sprawdzenia

1. Dźwięk przypomnień na urządzeniu — kanały `reminders-sound` / `focus-end-sound` z 0.1.17 (kod: `M/lib/reminders.ts`, `M/lib/scheduler.ts`).
2. A-05 na urządzeniu: wiersz telefonu na webie po synchronizacji, wyłączenie z weba kasuje alarmy po pobraniu zmiany, brak dubla z Web Push; A-07: zmiana motywu bez restartu ekranu; szukanie strefy w „Profilu” (czy Hermes ma `Intl.supportedValuesOf`).
3. Po wdrożeniu webu: „Ukończ” i „Odłóż 10 min” w prawdziwym powiadomieniu Chrome przy zamkniętej karcie (W-07; test E2E wywołuje handlery Service Workera, nie klika systemowego przycisku); „Odłóż” na webie to jednorazowe przypomnienie (`reminders`), więc po synchronizacji zadzwoni też telefon.
4. Na telefonie z P2: powiadomienie o przeglądzie i dotknięcie go (A-06), `adb shell pm get-app-links pl.taskplanner.app` = `verified` po instalacji APK z Actions (A-11; APK z kluczem debug nie przejdzie weryfikacji), kursor po przycisku formatowania i Enter w liście na klawiaturze Samsunga (A-14), „Udostępnij” obrazu i pliku z kolejki (A-23), przyciski ↑ ↓ ⇥ ⇤ (A-12).
5. Odrzucenie nazwy filtra dłuższej niż 60 znaków (A-48).
6. Nawyk otwarty jako zwykłe zadanie na telefonie (wyszukiwarka → `/task/[id]`): brak sekcji „Nawyk” z linkiem, którą ma web (`W/task-panel.tsx:290-296`; `M/app/task/[id].tsx`). Szukaj nie odfiltrowuje nawyków (`M/app/search.tsx`).
7. Web: pole „Dni miesiąca” w edytorze powtarzania przelicza tekst przy każdym znaku — przecinek może znikać (`W/recurrence-editor.tsx:138-156`; telefon ma bufor, `M/components/recurrence-editor.tsx:97,175`).
8. Web: tablica przy włączonym filtrze liczy postęp i kolejność z przefiltrowanych danych (`W/shell.tsx:290-318`, `W/board.tsx:131-141`), telefon z pełnych (`M/app/board.tsx:180-208`).
9. Załącznik SVG na telefonie (core uznaje za obraz, RN `Image` raczej nie pokaże) — `C/attachments.ts`.
10. Długość etapu skupienia spoza listy telefonu ustawiona na webie — działa, ale nie jest zaznaczona (`M/app/focus.tsx:52-57,197-211`).
11. Szkic „Ułóż dzień” na telefonie znika przy zmianie przestrzeni, na webie nie (`M/components/day-plan.tsx`, `W/day-plan.tsx:58-61`).

## Brak po obu stronach (nie różnica — informacyjnie)

Kopiowanie linku do zadania, duplikowanie, zamiana zadania w projekt, strefa czasowa zadania, lista / edycja wpisów czasu, podpowiedzi `#`/`@` przy pisaniu, własny zakres dat i warunek „Przestrzeń” w chipach, przeniesienie listy do innej przestrzeni i usunięcie przestrzeni, kolejność tagów i filtrów, trwałe usunięcie z kosza, szukanie w komentarzach, tworzenie zadania klikiem w pusty slot kalendarza, tablica wg osoby i limity WIP, zmiana nazwy i kolejności załączników, udostępnianie plików / obrazów do aplikacji, historia dawnych przeglądów, „wyloguj wszędzie”, zmiana e-maila. Uwaga: wybór statusu „Gotowe” z listy statusów dla serii po obu stronach zamyka serię zamiast przesunąć wystąpienie (`W/task-panel.tsx:209`, `M/app/task/[id].tsx` „Status”) — do decyzji, czy to błąd.

## Sprawdzone, bez różnic

- **Widoki**: sekcje Dziś, Nadchodzące 14 dni + tygodnie + wystąpienia wirtualne, Inbox zbiorczy i per przestrzeń, drzewo ze zwijaniem i postępem, tag (nazwa, kolor, przestrzenie), kosz 30 dni z przywracaniem, archiwum, liczniki list / tagów / filtrów.
- **Filtry i układ**: wszystkie warunki chipów, filtr listy w `view_prefs`, sortowanie (4), grupowanie (6), ukończone (3), kolumny i tagi w kolumnie.
- **Zadanie**: tytuł, 5 statusów, priorytety, lista, terminy, kolumna tablicy, rodzic, podzadania (4 poziomy, z istniejących), powtarzanie (wszystkie formy, pomiń / zakończ), przypomnienia, zależności z naruszeniami, osoby, komentarze, zwijanie sekcji, kosz z „Cofnij”.
- **Tablica**: 6 trybów, własne kolumny (dodaj / zmień / usuń / kolejność), dodawanie z atrybutem kolumny. **Oś**: skale, „Dziś”, „Bez terminu”, ścieżka krytyczna.
- **Skupienie**: Pomodoro / stoper, wspólny stan, osierocone wpisy, „Czas pracy”. **Nawyki**: harmonogramy, cel, passy, 7/30/90, uzupełnianie wstecz. **Przeglądy**: kolejka, 6 decyzji, 7 kroków, sesje.
- **Szybkie dodawanie**: parser, chipy z cofaniem, wiele linii. **Szablony**: zapis, tworzenie od startu / końca, usunięcie.
- **Współdzielenie**: role, zaproszenia, opuszczenie, dostęp gości, plakietki, współpracownicy i osoby z przestrzeni. **Załączniki**: limity, kolejka offline, miniatury, linki z podglądem. **AI**: konto i trzy funkcje. **Konto**: magic link, Google, usunięcie konta, zaproszenia (admin), dziennik błędów.
