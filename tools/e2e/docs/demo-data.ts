/**
 * Przykładowe dane instrukcji użytkownika (`docs/instrukcja`): fikcyjna osoba, firma i zadania, zawsze
 * względem „dziś”, więc zrzuty wyglądają tak samo niezależnie od dnia uruchomienia. Tylko LOKALNY Supabase.
 */
import {
  addDays,
  attachmentPath,
  collaboratorId,
  defaultWorkspaceId,
  inboxId,
  isoWeekday,
  onboardingOps,
  participantId,
  taskTagId,
  uuidv5,
  zonedInstant,
  completionId,
  type LocalDate,
} from '@taskplanner/core';

import type { Account, Op } from '../src/supabase.ts';

/**
 * Strefa, w której „teraz” jest ok. 10:00 — zrzuty pokazują dzień w środku pracy (linia „teraz”, wolne okna)
 * niezależnie od tego, o której je robimy. `Etc/GMT+6` = UTC−6.
 */
export function demoZone(now = new Date()): string {
  const diff = 10 - now.getUTCHours();
  if (diff === 0) return 'Etc/GMT';
  return diff < 0 ? `Etc/GMT+${-diff}` : `Etc/GMT-${diff}`;
}

export const demoIds = (userId: string) => {
  const id = (key: string) => uuidv5(`docs:${key}:${userId}`);
  return {
    id,
    personal: defaultWorkspaceId(userId, 'personal'),
    work: defaultWorkspaceId(userId, 'work'),
    shared: id('ws-remont'),
    www: id('list-www'),
    fair: id('list-targi'),
    clients: id('list-klienci'),
    canvas: id('list-kampania'),
    home: id('list-dom'),
    books: id('list-ksiazki'),
    kitchen: id('list-kuchnia'),
    design: id('task-projekt'),
    print: id('task-drukarnia'),
    fairTrip: id('task-wyjazd'),
    water: id('habit-woda'),
    gym: id('habit-silownia'),
    reading: id('habit-czytanie'),
    tag: (name: string) => id(`tag-${name}`),
    person: (name: string) => collaboratorId(userId, name),
    filter: id('filter-pilne'),
    webhook: id('plugin-webhook'),
    gitlab: id('plugin-gitlab'),
  };
};

const TAGS: [string, string | null][] = [
  ['telefon', '#2563EB'],
  ['e-mail', '#EA580C'],
  ['pilne', '#DC2626'],
  ['dom', '#16A34A'],
  ['marketing', '#9333EA'],
  ['produkt', '#0891B2'],
  ['obsługa', '#CA8A04'],
];
const PEOPLE: [string, string, string | null][] = [
  ['Piotr Zieliński', 'PZ', 'piotr.zielinski@example.com'],
  ['Marta Kowal', 'MK', 'marta.kowal@example.com'],
  ['Tomasz Wrona', 'TW', null],
];

/** Pseudolosowość bez `Math.random` — ta sama historia cyklicznych przy każdym przebiegu. */
const chance = (seed: string) => parseInt(uuidv5(`docs:rnd:${seed}`).slice(0, 8), 16) / 0xffffffff;

export function demoOps(userId: string, today: LocalDate, timeZone: string, now = new Date()): Op[] {
  const ids = demoIds(userId);
  const d = (offset: number) => addDays(today, offset);
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const ops: Op[] = [];
  const add = (table: string, id: string, patch: Record<string, unknown>) => ops.push({ table, id, patch });

  ops.push(
    ...onboardingOps(userId, {
      displayName: 'Anna',
      settings: {
        timeZone,
        theme: 'light',
        dailyReview: { enabled: false, time: '16:30' },
        weeklyReview: { enabled: false, weekday: 5, time: '15:00' },
      },
    }),
  );

  // ── Przestrzenie, listy, projekty ──
  add('workspaces', ids.shared, { name: 'Remont', color: '#EA580C', icon: 'home', sort_key: 'z' });
  add('lists', inboxId(ids.shared), { scope_id: ids.shared, kind: 'inbox', name: 'Inbox', sort_key: 'a' });
  const list = (id: string, scope: string, name: string, key: string, extra: Record<string, unknown> = {}) =>
    add('lists', id, { scope_id: scope, kind: 'list', name, sort_key: key, ...extra });
  const project = (id: string, scope: string, name: string, key: string, start: number, end: number, color: string) =>
    add('lists', id, { scope_id: scope, kind: 'project', name, sort_key: key, color, start_date: d(start), end_date: d(end), project_status: 'active' });

  project(ids.www, ids.work, 'Nowa strona www', 'c', -14, 24, '#4F46E5');
  project(ids.fair, ids.work, 'Targi wiosenne', 'd', 6, 44, '#DB2777');
  const columns = ['Pierwszy kontakt', 'Oferta', 'Negocjacje', 'Umowa'].map((name, i) => ({ id: ids.id(`col-${i}`), name }));
  list(ids.clients, ids.work, 'Klienci', 'e', { color: '#0891B2', board_columns: columns, view_prefs: { view: 'kanban', boardBy: 'custom' } });
  list(ids.canvas, ids.work, 'Pomysły na kampanię', 'f', { color: '#9333EA', view_prefs: { view: 'canvas', canvasTasks: 'top' } });
  list(ids.home, ids.personal, 'Dom', 'c', { color: '#16A34A' });
  list(ids.books, ids.personal, 'Książki do przeczytania', 'd');
  project(ids.kitchen, ids.shared, 'Remont kuchni', 'c', -5, 30, '#EA580C');

  // ── Tagi, osoby ──
  TAGS.forEach(([name, color], i) => add('tags', ids.tag(name), { name, color, sort_key: `b${String.fromCharCode(97 + i)}` }));
  PEOPLE.forEach(([name, acronym, email]) => add('collaborators', ids.person(name), { name, acronym, email }));

  // ── Zadania ──
  const order = new Map<string, number>();
  const task = (
    key: string,
    listId: string,
    title: string,
    patch: Record<string, unknown> = {},
    { tags = [], people = [], parent }: { tags?: string[]; people?: string[]; parent?: string } = {},
  ) => {
    const id = ids.id(`task-${key}`);
    const bucket = parent ?? listId;
    const n = (order.get(bucket) ?? 0) + 1;
    order.set(bucket, n);
    add('tasks', id, { list_id: listId, title, sort_key: `k${String(n).padStart(2, '0')}`, ...(parent && { parent_id: parent }), ...patch });
    tags.forEach((t, i) => add('task_tags', taskTagId(id, ids.tag(t)), { task_id: id, tag_id: ids.tag(t), sort_key: `b${String.fromCharCode(97 + i)}` }));
    people.forEach((p) => add('task_participants', participantId(id, ids.person(p)), { task_id: id, collaborator_id: ids.person(p) }));
    return id;
  };
  const doneAt = (offset: number, time = '15:00') => ({ status: 'done', completed_at: zonedInstant(d(offset), time, timeZone).toISOString() });
  const workInbox = inboxId(ids.work);
  const homeInbox = inboxId(ids.personal);

  // Inbox
  task('i1', workInbox, 'Sprawdzić nowe logo od grafika');
  task('i2', workInbox, 'Pomysł: newsletter dla stałych klientów', { priority: 4 });
  task('i3', homeInbox, 'Oddać książki do biblioteki');
  task('i4', homeInbox, 'Prezent dla Zosi', { due_date: d(4) });

  // Dziś i zaległe
  task('z1', ids.home, 'Wymienić filtr w okapie', { due_date: d(-2), priority: 3, duration_min: 30, postpone_count: 3 }, { tags: ['dom'] });
  task('z2', workInbox, 'Odpisać na zapytanie z formularza', { due_date: d(-1), priority: 2, duration_min: 20 }, { tags: ['e-mail'] });
  task('standup', workInbox, 'Stand-up zespołu', {
    due_date: today,
    due_time: '09:00',
    duration_min: 15,
    recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', anchor: d(-21) },
  });
  const print = task('drukarnia', ids.fair, 'Zadzwonić do drukarni w sprawie ulotek', { due_date: today, due_time: '11:30', duration_min: 30, priority: 2 }, { tags: ['telefon'] });
  add('reminders', ids.id('rem-1'), { task_id: print, kind: 'relative', offset_min: 15 });
  task('spotkanie', ids.clients, 'Spotkanie z klientem: Kawiarnia Lipa', { due_date: today, due_time: '13:00', duration_min: 60, priority: 2, board_column_id: columns[2]!.id, assignee_id: ids.person('Marta Kowal') });
  task('oferta', ids.clients, 'Wysłać ofertę: Ogrody Anny', { due_date: today, priority: 1, duration_min: 45, board_column_id: columns[1]!.id }, { tags: ['e-mail', 'pilne'] });
  task('prad', ids.home, 'Zapłacić rachunek za prąd', { due_date: today, priority: 1, duration_min: 10 }, { tags: ['dom'] });
  task('paczka', homeInbox, 'Odebrać paczkę z punktu', { due_date: today, duration_min: 20 });
  task('raport', workInbox, 'Przygotować raport miesięczny', { due_date: today, priority: 3, duration_min: 90 });
  task('d1', workInbox, 'Zaktualizować cennik', { due_date: today, ...doneAt(0, '09:10') });
  task('d2', ids.home, 'Podlać kwiaty', { due_date: today, ...doneAt(0, '07:30') });
  [-1, -1, -2, -2, -3, -4, -5].forEach((o, i) =>
    task(`h${i}`, i % 3 ? workInbox : ids.home, ['Faktura dla Studia Nova', 'Zakupy na weekend', 'Przegląd umów', 'Spotkanie z księgową', 'Umyć okna', 'Publikacja wpisu na blogu', 'Zamówić papier firmowy'][i]!, { due_date: d(o), ...doneAt(o) }),
  );

  // Nadchodzące
  task('n1', ids.home, 'Przegląd rowerów', { due_date: d(1), due_time: '17:30', duration_min: 60 }, { tags: ['dom'] });
  task('n2', workInbox, 'Rozmowa rekrutacyjna', { due_date: d(1), due_time: '10:00', duration_min: 60, priority: 2 });
  task('n3', workInbox, 'Prezentacja wyników kwartału', { due_date: d(2), due_time: '12:00', duration_min: 60, priority: 1 }, { tags: ['pilne'] });
  task('n4', ids.home, 'Wizyta u dentysty', { due_date: d(3), due_time: '08:30', duration_min: 45 });
  task('n5', workInbox, 'Zamówić catering na szkolenie', { due_date: d(3), priority: 3 }, { tags: ['telefon'] });
  task('n6', ids.home, 'Opłacić ubezpieczenie samochodu', { due_date: d(6), priority: 2 }, { tags: ['dom'] });
  task('n7', workInbox, 'Wysłać podsumowanie tygodnia', { due_date: d(1 + ((5 - isoWeekday(d(1)) + 7) % 7)), recurrence: { mode: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=FR', anchor: d(-14) } }, { tags: ['e-mail'] });
  task('czynsz', ids.home, 'Zapłacić czynsz', { due_date: d(9), recurrence: { mode: 'schedule', rrule: `FREQ=MONTHLY;BYMONTHDAY=${Number(d(9).slice(8))}`, anchor: d(9) } }, { tags: ['dom'] });

  // Książki
  ['Zarządzanie czasem — wprowadzenie', 'Podstawy typografii', 'Ogród na balkonie'].forEach((t, i) => task(`k${i}`, ids.books, t, i === 0 ? { ...doneAt(-3) } : {}));

  // Projekt „Nowa strona www” (oś czasu, zależności, ścieżka krytyczna)
  const marta = ids.person('Marta Kowal');
  const tomasz = ids.person('Tomasz Wrona');
  const piotr = ids.person('Piotr Zieliński');
  const w1 = task('wymagania', ids.www, 'Zebrać wymagania', { start_date: d(-14), due_date: d(-11), ...doneAt(-11), assignee_id: piotr });
  const w2 = task('makiety', ids.www, 'Makiety stron', { start_date: d(-10), due_date: d(-5), ...doneAt(-5), assignee_id: marta });
  const w3 = task(
    'projekt',
    ids.www,
    'Projekt graficzny',
    {
      start_date: d(-4),
      due_date: d(3),
      status: 'in_progress',
      priority: 2,
      duration_min: 480,
      assignee_id: marta,
      description_md: [
        '## Zakres',
        '',
        'Projekt **wszystkich podstron** w wersji na komputer i telefon.',
        '',
        '- [x] Paleta kolorów i typografia',
        '- [x] Strona główna',
        '- [ ] Oferta i cennik',
        '- [ ] Formularz kontaktowy',
        '',
        '| Wersja | Szerokość |',
        '| --- | --- |',
        '| Telefon | 390 px |',
        '| Komputer | 1440 px |',
        '',
        'Wzory: [przykładowa biblioteka](https://example.com/wzory)',
      ].join('\n'),
    },
    { tags: ['produkt', 'pilne'], people: ['Tomasz Wrona', 'Piotr Zieliński'] },
  );
  task('p1', ids.www, 'Paleta kolorów i typografia', { ...doneAt(-3) }, { parent: w3 });
  task('p2', ids.www, 'Strona główna', { ...doneAt(-1) }, { parent: w3 });
  task('p3', ids.www, 'Oferta i cennik', { due_date: d(1) }, { parent: w3 });
  task('p4', ids.www, 'Formularz kontaktowy', { due_date: d(2) }, { parent: w3 });
  const w4 = task('teksty', ids.www, 'Teksty na stronę', { start_date: d(-1), due_date: d(5), status: 'waiting', assignee_id: piotr }, { tags: ['marketing'] });
  const w5 = task('wdrozenie', ids.www, 'Wdrożenie szablonów', { start_date: d(6), due_date: d(13), priority: 2, assignee_id: tomasz }, { tags: ['produkt'] });
  const w6 = task('testy', ids.www, 'Testy na urządzeniach', { start_date: d(14), due_date: d(17), assignee_id: tomasz });
  const w7 = task('szkolenie', ids.www, 'Szkolenie redaktorów', { start_date: d(16), due_date: d(16), duration_min: 120, assignee_id: marta }, { people: ['Piotr Zieliński'] });
  const w8 = task('start', ids.www, 'Uruchomienie strony', { start_date: d(20), due_date: d(20), priority: 1 }, { tags: ['pilne'] });
  task('analityka', ids.www, 'Podłączyć statystyki odwiedzin');
  for (const [from, to, lag] of [
    [w1, w2, 0],
    [w2, w3, 0],
    [w3, w5, 1],
    [w4, w5, 0],
    [w5, w6, 0],
    [w6, w7, 0],
    [w6, w8, 1],
  ] as [string, string, number][]) {
    add('task_dependencies', ids.id(`dep-${from}-${to}`), { predecessor_id: from, successor_id: to, kind: 'finish_to_start', lag_days: lag });
  }
  add('reminders', ids.id('rem-2'), { task_id: w3, kind: 'relative', offset_min: 1440 });
  add('reminders', ids.id('rem-3'), { task_id: w3, kind: 'absolute', at_date: d(1), at_time: '09:00' });
  add('task_comments', ids.id('com-1'), { task_id: w3, body: 'Wersja na telefon gotowa do przejrzenia — wzory w załączniku.', posted_at: ago(26 * 60) });
  add('task_comments', ids.id('com-2'), { task_id: w3, body: 'Klient prosi o większy przycisk „Umów wizytę” na stronie głównej.', posted_at: ago(50) });
  add('attachments', ids.id('att-link'), {
    task_id: w3,
    kind: 'link',
    name: 'Wytyczne dostępności',
    url: 'https://example.com/dostepnosc',
    preview: { title: 'Wytyczne dostępności', description: 'Kontrast, rozmiar tekstu i obsługa klawiaturą', siteName: 'example.com' },
  });

  // Projekt „Targi wiosenne”
  const f1 = task('stoisko', ids.fair, 'Rezerwacja stoiska', { start_date: d(6), due_date: d(8), priority: 2, assignee_id: piotr });
  const f2 = task('rollup', ids.fair, 'Projekt roll-upu', { start_date: d(9), due_date: d(15), assignee_id: marta }, { tags: ['marketing'] });
  const f3 = task('druk', ids.fair, 'Druk materiałów', { start_date: d(16), due_date: d(24) });
  const f4 = task('wyjazd', ids.fair, 'Wyjazd na targi', { start_date: d(40), due_date: d(42), duration_min: 960 }, { people: ['Marta Kowal', 'Tomasz Wrona'] });
  for (const [from, to] of [[f1, f2], [f2, f3], [f3, f4]] as [string, string][]) {
    add('task_dependencies', ids.id(`dep-${from}-${to}`), { predecessor_id: from, successor_id: to, kind: 'finish_to_start', lag_days: 0 });
  }

  // Klienci — własne kolumny tablicy
  task('c1', ids.clients, 'Pracownia Glina', {}, {});
  task('c2', ids.clients, 'Szkoła językowa Most', { board_column_id: columns[0]!.id, priority: 3, due_date: d(2) }, { tags: ['telefon'] });
  task('c3', ids.clients, 'Warsztat Rowerowy Szprycha', { board_column_id: columns[0]!.id });
  task('c4', ids.clients, 'Biuro podróży Kompas', { board_column_id: columns[1]!.id, due_date: d(5), assignee_id: piotr }, { tags: ['e-mail'] });
  task('c5', ids.clients, 'Piekarnia Kłos', { board_column_id: columns[3]!.id, priority: 2, due_date: d(7), assignee_id: marta });

  // Karteczki
  const note = (key: string, title: string, col: number, row: number, tags: string[], extra: Record<string, unknown> = {}) =>
    task(`n-${key}`, ids.canvas, title, { canvas_pos: { col, row }, ...extra }, { tags });
  const k1 = note('cel', 'Cel kampanii: 50 nowych klientów do lata', 0, 1, ['marketing'], { priority: 1, assignee_id: piotr });
  const k2 = note('grupa', 'Kto jest odbiorcą? Małe firmy lokalne', 2, 0, ['marketing'], { assignee_id: marta });
  const k3 = note('budzet', 'Budżet na trzy miesiące', 2, 2, ['produkt'], { priority: 2, due_date: d(4) });
  const k4 = note('film', 'Krótki film o pracowni', 4, 0, ['marketing'], { assignee_id: tomasz });
  const k5 = note('opinie', 'Zebrać opinie klientów', 4, 1, ['obsługa'], { assignee_id: marta });
  const k6 = note('landing', 'Strona kampanii z formularzem', 4, 2, ['produkt'], { priority: 2 });
  const k7 = note('newsletter', 'Seria trzech newsletterów', 6, 1, ['marketing']);
  note('faq', 'Odpowiedzi na częste pytania', 6, 2, ['obsługa']);
  task('n-t1', ids.canvas, 'Konkurs dla obserwujących', {}, { tags: ['marketing'] });
  task('n-t2', ids.canvas, 'Program poleceń', {}, { tags: ['obsługa'] });
  add('lists', ids.canvas, {
    canvas_groups: [
      { id: ids.id('grp-1'), name: 'Założenia', color: '#4F46E5', col: 2, row: 0, w: 1, h: 3 },
      { id: ids.id('grp-2'), name: 'Działania', color: '#16A34A', col: 4, row: 0, w: 3, h: 3 },
    ],
  });
  add('task_dependencies', ids.id('dep-k1'), { predecessor_id: k3, successor_id: k6, kind: 'finish_to_start', lag_days: 0 });
  add('task_dependencies', ids.id('dep-k2'), { predecessor_id: k5, successor_id: k7, kind: 'finish_to_start', lag_days: 0 });
  add('tasks', k2, { derived_from: [k1] });
  add('tasks', k3, { derived_from: [k1] });
  add('tasks', k4, { derived_from: [k2] });
  task('n-s1', ids.canvas, 'Scenariusz', { ...doneAt(-1) }, { parent: k4 });
  task('n-s2', ids.canvas, 'Nagranie', {}, { parent: k4 });

  // Wspólna przestrzeń
  task('r1', ids.kitchen, 'Zdjęcie wymiarów', { start_date: d(-5), due_date: d(-4), ...doneAt(-4) });
  task('r2', ids.kitchen, 'Wybór frontów szafek', { start_date: d(-2), due_date: d(4), priority: 2, assignee_id: piotr });
  task('r3', ids.kitchen, 'Zamówienie blatu', { start_date: d(5), due_date: d(9) });
  task('r4', ids.kitchen, 'Montaż', { start_date: d(20), due_date: d(24), priority: 2 });

  // Do kosza trafia w trakcie zrzutów.
  task('kosz', ids.books, 'Stara lista życzeń');

  // ── Cykliczne z historią ──
  const habit = (id: string, title: string, rrule: string, settings: Record<string, unknown>, key: string, listId = ids.home) =>
    add('tasks', id, { list_id: listId, kind: 'habit', title, sort_key: key, due_date: d(-120), recurrence: { mode: 'schedule', rrule, anchor: d(-120) }, habit: settings });
  habit(ids.water, 'Woda', 'FREQ=DAILY', { target: 8, unit: 'szklanek' }, 'p1');
  habit(ids.gym, 'Siłownia', 'FREQ=DAILY', { goal: { period: 'week', times: 3 } }, 'p2');
  habit(ids.reading, 'Czytanie 20 min', 'FREQ=DAILY', { time: '15:30' }, 'p3');
  const flowers = ids.id('habit-hiszpanski');
  habit(flowers, 'Hiszpański', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', {}, 'p4');
  const entry = (taskId: string, offset: number, kind: 'done' | 'skipped', value: number | null) =>
    add('task_completions', completionId(taskId, d(offset)), { task_id: taskId, occurrence_date: d(offset), kind, value, completed_at: zonedInstant(d(offset), '09:00', timeZone).toISOString() });
  for (let o = -119; o <= -1; o++) {
    const wd = isoWeekday(d(o));
    const r = (k: string) => chance(`${k}:${o}`);
    // Ostatnie dwa tygodnie bez przerw — widoczna passa.
    const fresh = o > -13;
    if (r('w') < 0.82 || fresh) entry(ids.water, o, 'done', 8);
    else if (r('w') < 0.95) entry(ids.water, o, 'done', 3 + Math.floor(r('w2') * 4));
    if ([1, 3, 5].includes(wd) && (r('g') < 0.85 || fresh)) entry(ids.gym, o, 'done', null);
    if (r('c') < 0.7 || (fresh && o > -9)) entry(ids.reading, o, 'done', null);
    else if (r('c') < 0.76) entry(ids.reading, o, 'skipped', null);
    if (wd <= 5 && (r('h') < 0.75 || (fresh && o > -6))) entry(flowers, o, 'done', null);
  }
  entry(ids.water, 0, 'done', 3);
  entry(flowers, 0, 'done', null);

  // ── Czas pracy w tym tygodniu ──
  const monday = 1 - isoWeekday(today);
  for (let o = monday; o <= 0; o++) {
    const sessions: [string, string, number][] = o === 0 ? [['09:20', w3, 25]] : [['09:20', w3, 25], ['10:00', w3, 25], ['13:30', w5, 25], ['14:10', f1, 25]];
    sessions.forEach(([time, taskId, min], i) => {
      const start = zonedInstant(d(o), time, timeZone).getTime();
      const iso = (ms: number) => new Date(ms).toISOString();
      add('time_entries', ids.id(`te-${o}-${i}`), { task_id: taskId, kind: 'focus', started_at: iso(start), ended_at: iso(start + min * 60_000), pomodoro_index: i });
      add('time_entries', ids.id(`tb-${o}-${i}`), { task_id: taskId, kind: 'break', started_at: iso(start + min * 60_000), ended_at: iso(start + (min + 5) * 60_000), pomodoro_index: null });
    });
  }

  // ── Zapisany filtr ──
  add('saved_filters', ids.filter, { name: 'Ważne w tym tygodniu', icon: null, query: { priorities: [1, 2], due: { kind: 'range', to: { offsetDays: 7 } } }, sort_key: 'b' });
  return ops;
}

/** Dane, które w aplikacji zapisuje serwer (integracje, konto AI, spotkania) oraz reguły i plik — po zadaniach. */
export async function demoServerRows(admin: Account['client'], account: Account, today: LocalDate, timeZone: string) {
  const ids = demoIds(account.id);
  const fail = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  const at = (offset: number, time: string) => zonedInstant(addDays(today, offset), time, timeZone).toISOString();
  const calAccount = ids.id('cal-account');
  const calendar = ids.id('calendar');
  fail('calendar_accounts', (await admin.from('calendar_accounts').insert({ id: calAccount, user_id: account.id, provider: 'ics', label: 'Kalendarz firmowy', external_id: 'docs', status: 'active', last_synced_at: new Date().toISOString() })).error);
  fail('calendars', (await admin.from('calendars').insert({ id: calendar, account_id: calAccount, user_id: account.id, external_id: 'docs', name: 'Spotkania', color: '#57534E', last_synced_at: new Date().toISOString() })).error);
  const events: [string, number, string, string][] = [
    ['Przegląd projektu', 0, '10:30', '11:15'],
    ['Rozmowa z dostawcą', 0, '13:30', '14:15'],
    ['Planowanie sprintu', 1, '13:00', '14:30'],
    ['Lunch z zespołem', 2, '13:30', '14:30'],
    ['Warsztat: dostępność', 3, '10:00', '12:00'],
    ['Podsumowanie tygodnia', -1, '14:00', '15:00'],
  ];
  fail('calendar_events', (await admin.from('calendar_events').insert(events.map(([title, o, from, to], i) => ({ calendar_id: calendar, user_id: account.id, external_id: `docs-${i}`, title, start_at: at(o, from), end_at: at(o, to) })))).error);

  fail('plugin_connections', (await admin.from('plugin_connections').insert([
    { id: ids.webhook, user_id: account.id, plugin: 'webhook', label: 'n8n — zgłoszenia', config: { url: 'https://n8n.example.com/webhook/zgloszenia' }, last_used_at: at(0, '08:40') },
    { id: ids.gitlab, user_id: account.id, plugin: 'gitlab', label: 'GitLab — strona www', config: { baseUrl: 'https://gitlab.example.com', project: 'studio/strona-www' } },
  ])).error);
  fail('ai_accounts', (await admin.from('ai_accounts').insert({
    id: ids.id('ai'),
    user_id: account.id,
    provider: 'gemini',
    model: 'gemini-flash-lite-latest',
    models: [{ id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite' }, { id: 'gemini-flash-latest', label: 'Gemini Flash' }],
    key_hint: '…x1Y2',
    status: 'active',
    verified_at: new Date().toISOString(),
    billing_confirmed_at: new Date().toISOString(),
  })).error);

  // Plik załącznika — prosty obraz PNG (podgląd w panelu zadania).
  const attachment = ids.id('att-file');
  const path = attachmentPath(account.id, ids.design, attachment, 'makieta-telefon.png');
  const { default: sharp } = await import('sharp');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="640"><rect width="390" height="640" fill="#eef2ff"/><rect x="24" y="24" width="342" height="56" rx="8" fill="#4F46E5"/><rect x="24" y="104" width="342" height="200" rx="12" fill="#c7d2fe"/><rect x="24" y="328" width="260" height="18" rx="6" fill="#818cf8"/><rect x="24" y="362" width="320" height="12" rx="6" fill="#c7d2fe"/><rect x="24" y="386" width="300" height="12" rx="6" fill="#c7d2fe"/><rect x="24" y="440" width="180" height="48" rx="24" fill="#16A34A"/></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  fail('storage', (await account.client.storage.from('attachments').upload(path, png, { contentType: 'image/png', upsert: true })).error);
  return [
    { table: 'attachments', id: attachment, patch: { task_id: ids.design, kind: 'file', name: 'makieta-telefon.png', storage_path: path, mime: 'image/png', size_bytes: png.length } },
    { table: 'plugin_rules', id: ids.id('rule-1'), patch: { name: 'Zgłoszenie do n8n', connection_id: ids.webhook, enabled: true, trigger: { kind: 'manual' }, action: { message: '{{title}} — termin {{due}}' }, options: {}, sort_key: 'b' } },
    {
      table: 'plugin_rules',
      id: ids.id('rule-2'),
      patch: {
        name: 'Tag „produkt” → issue w GitLabie',
        connection_id: ids.gitlab,
        enabled: true,
        trigger: { kind: 'event', events: ['task.tagged'], filter: { tags: { ids: [ids.tag('produkt')], match: 'all' } } },
        action: { title: '{{title}}', description: '{{description}}', labels: 'task-planner' },
        options: { delaySec: 20 },
        sort_key: 'c',
      },
    },
  ] satisfies Op[];
}

/** Historia wysyłek (karta „Integracje”) — po regułach, żeby miały nazwy. */
export async function demoDeliveries(admin: Account['client'], account: Account, today: LocalDate, timeZone: string) {
  const ids = demoIds(account.id);
  const at = (offset: number, time: string) => zonedInstant(addDays(today, offset), time, timeZone).toISOString();
  const row = (key: string, patch: Record<string, unknown>) => ({ id: ids.id(`del-${key}`), user_id: account.id, source: 'manual', attempts: 1, status: 'sent', http_status: 200, ...patch });
  const { error } = await admin.from('plugin_deliveries').insert([
    row('1', { rule_id: ids.id('rule-1'), connection_id: ids.webhook, task_id: ids.print, events: ['task.sent'], created_at: at(0, '08:40'), sent_at: at(0, '08:40') }),
    row('2', { rule_id: ids.id('rule-2'), connection_id: ids.gitlab, task_id: ids.design, source: 'event', events: ['task.tagged'], created_at: at(-1, '14:05'), sent_at: at(-1, '14:05'), external_url: 'https://gitlab.example.com/studio/strona-www/-/issues/12', http_status: 201 }),
    row('3', { rule_id: ids.id('rule-1'), connection_id: ids.webhook, task_id: ids.design, events: ['task.sent'], created_at: at(-2, '11:20'), status: 'dead', attempts: 8, http_status: 503, error: 'Serwer odpowiedział 503' }),
  ]);
  if (error) throw new Error(`plugin_deliveries: ${error.message}`);
}
