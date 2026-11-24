/**
 * Podsumowanie tygodnia (v1.x): fakty policzone ręcznie (dziś = wtorek 2026-11-24, tydzień 18–24.11), opis AI bez
 * własnych liczb i sugestie tylko przy istniejących zadaniach.
 */
import { describe, expect, it } from 'vitest';

import {
  AiWeekSummary,
  AiWeekSummaryRequest,
  validWeekSentences,
  weekSentenceProblem,
  weekSuggestionActive,
  weekSummaryAnswer,
  weekSummaryFromAi,
  weekSummaryPrompt,
  weekSummaryRequest,
} from '../ai-week-summary.ts';
import type { TimeEntryRecord } from '../focus.ts';
import type { HabitCompletion } from '../habits.ts';
import type { Recurrence } from '../recurrence.ts';
import { reviewFinishOp, ReviewStats, reviewStats, reviewSummary, weeklyReview } from '../review.ts';
import { completeTaskOps } from '../tasks.ts';
import type { ViewContext, ViewTask } from '../views.ts';
import { nextWeekNote, weekFactList, weekFacts, weekFactTexts, type WeekFactsInput } from '../week-summary.ts';

const W1 = '0190a000-0000-7000-8000-000000000001';
const W2 = '0190a000-0000-7000-8000-000000000002';
const ACCOUNT = '0190a000-0000-4000-8000-00000000000a';
const ctx: ViewContext = { today: '2026-11-24', timeZone: 'Europe/Warsaw', firstDayOfWeek: 1 };

const task = (over: Partial<ViewTask> & { id: string }): ViewTask => ({
  workspaceId: W1,
  listId: 'dom',
  parentId: null,
  kind: 'task',
  title: over.id,
  status: 'todo',
  priority: 4,
  startDate: null,
  dueDate: null,
  dueTime: null,
  durationMin: null,
  recurrence: null,
  habit: null,
  completedAt: null,
  createdAt: '2026-10-01T10:00:00Z',
  sortKey: '0010',
  tagIds: [],
  postponeCount: 0,
  ...over,
});

const daily: Recurrence = { mode: 'schedule', anchor: '2026-11-01', rrule: 'FREQ=DAILY' };
const entry = (id: string, taskId: string | null, start: string, end: string, over: Partial<TimeEntryRecord> = {}): TimeEntryRecord => ({
  id,
  taskId,
  kind: 'focus',
  startedAt: start,
  endedAt: end,
  pomodoroIndex: 1,
  ...over,
});

const tasks = [
  task({ id: 'zrobione', status: 'done', completedAt: '2026-11-20T10:00:00Z', listId: 'praca' }),
  // 17.11 23:30 UTC = 18.11 0:30 w Warszawie — pierwszy dzień tygodnia.
  task({ id: 'na-granicy', status: 'done', completedAt: '2026-11-17T23:30:00Z' }),
  task({ id: 'za-wczesnie', status: 'done', completedAt: '2026-11-17T22:30:00Z' }),
  task({ id: 'anulowane', status: 'cancelled', completedAt: '2026-11-21T10:00:00Z' }),
  task({ id: 'seria', recurrence: { mode: 'after_completion', every: { unit: 'day', n: 3 } }, dueDate: '2026-11-26', durationMin: 30, listId: 'praca' }),
  task({ id: 'nowe', createdAt: '2026-11-23T08:00:00Z', dueDate: '2026-11-25', durationMin: 90 }),
  task({ id: 'zalegle', dueDate: '2026-11-10', postponeCount: 4 }),
  task({ id: 'zalegle-2', dueDate: '2026-11-22' }),
  task({ id: 'jutro', dueDate: '2026-11-25' }),
  task({ id: 'dzis', dueDate: '2026-11-24' }),
  task({ id: 'za-osiem', dueDate: '2026-12-02' }),
  task({ id: 'inna-przestrzen', workspaceId: W2, listId: 'klub', status: 'done', completedAt: '2026-11-24T08:00:00Z' }),
  task({ id: 'woda', kind: 'habit', recurrence: daily }),
];
const day = (date: string): HabitCompletion => ({ date: date as HabitCompletion['date'], kind: 'done', value: null });
const input: WeekFactsInput = {
  tasks,
  seriesDone: [
    { taskId: 'seria', completedAt: '2026-11-19T18:00:00Z' },
    { taskId: 'seria', completedAt: '2026-11-23T18:00:00+00:00' },
    { taskId: 'seria', completedAt: '2026-11-10T18:00:00Z' },
    { taskId: 'nie-ma', completedAt: '2026-11-20T18:00:00Z' },
  ],
  habitCompletions: new Map([['woda', [day('2026-11-18'), day('2026-11-19'), day('2026-11-21')]]]),
  timeEntries: [
    entry('a', 'zrobione', '2026-11-20T08:00:00Z', '2026-11-20T08:50:00Z'),
    entry('b', null, '2026-11-24T08:00:00Z', '2026-11-24T08:30:00Z', { kind: 'manual', pomodoroIndex: null }),
    entry('c', 'zrobione', '2026-11-12T08:00:00Z', '2026-11-12T09:00:00Z'),
  ],
  workHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
  now: new Date('2026-11-24T12:00:00Z'),
};
const names = { list: (id: string) => ({ dom: 'Dom', praca: 'Praca', klub: 'Klub' })[id] ?? '?', task: (id: string) => tasks.find((t) => t.id === id)?.title ?? '?' };

describe('weekFacts', () => {
  const facts = weekFacts(input, ctx);

  it('ukończone z seriami i granicą strefy, bez anulowanych i nawyków', () => {
    expect(facts.from).toBe('2026-11-18');
    expect(facts.done).toBe(5);
    expect(facts.doneByList).toEqual([
      { listId: 'praca', count: 3 },
      { listId: 'dom', count: 1 },
      { listId: 'klub', count: 1 },
    ]);
    expect(facts.doneTaskIds).toEqual(['inna-przestrzen', 'seria', 'zrobione', 'na-granicy']);
  });

  it('nowe, zaległe, przekładane, skupienie, nawyki', () => {
    expect([facts.created, facts.overdue, facts.postponed]).toEqual([1, 2, 1]);
    expect(facts.focusMin).toBe(80);
    // 7 dni, dziś jeszcze trwa → 6 możliwych.
    expect(facts.habits).toEqual([{ taskId: 'woda', done: 3, possible: 6 }]);
  });

  it('następne 7 dni od jutra', () => {
    // 25.11 (środa): nowe, jutro; 26.11: seria; 2.12 poza zakresem (25.11–1.12).
    expect(facts.next.items).toBe(3);
    expect(facts.next.minutes).toBe(120);
    expect(facts.next.withoutDuration).toBe(1);
    expect(facts.next.days).toHaveLength(7);
    expect(facts.next.days[0]).toEqual({ date: '2026-11-25', items: 2, minutes: 90 });
    expect(facts.next.busiest?.date).toBe('2026-11-25');
    // śr, czw, pt, pon, wt = 5 dni × 8 h.
    expect(facts.next.workMin).toBe(2_400);
    expect(nextWeekNote(facts)).toBe('2 h z 40 h godzin pracy, 1 zadanie bez podanego czasu');
  });

  it('jedna przestrzeń: tylko jej zadania i czas przy jej zadaniach', () => {
    const one = weekFacts(input, { ...ctx, workspaceId: W2 });
    expect([one.done, one.overdue, one.focusMin, one.next.items]).toEqual([1, 0, 0, 0]);
    expect(one.next.busiest).toBeNull();
    expect(nextWeekNote(one)).toBe('');
    // Czas bez zadania liczy się tylko przy wszystkich przestrzeniach.
    expect(weekFacts(input, { ...ctx, workspaceId: W1 }).focusMin).toBe(50);
  });

  it('ostatnie wystąpienie serii (wpis + zamknięcie zadania) liczy się raz', () => {
    const last = task({ id: 'ostatnie', dueDate: '2026-11-24', recurrence: { ...daily, rrule: 'FREQ=DAILY;UNTIL=20261124' } });
    const now = '2026-11-24T09:00:00.000Z';
    expect(completeTaskOps(last, { now }).ops.some((o) => o.table === 'task_completions')).toBe(true);
    const closed = weekFacts({ ...input, tasks: [{ ...last, status: 'done', completedAt: now }], seriesDone: [{ taskId: 'ostatnie', completedAt: '2026-11-24T09:00:00+00:00' }] }, ctx);
    expect(closed.done).toBe(1);
  });

  it('pusty tydzień: same zera, bez faktów bez sensu', () => {
    const empty = weekFacts({ ...input, tasks: [], seriesDone: [], timeEntries: [] }, ctx);
    const texts = weekFactTexts(empty, names);
    expect(texts.main.map((f) => f.key)).toEqual(['ukonczone', 'nowe', 'zalegle', 'przekladane', 'przyszlosc']);
    expect(texts.main[0]!.text).toBe('0 ukończonych zadań');
  });

  it('frazy z liczbami', () => {
    const texts = weekFactTexts(facts, names);
    const by = new Map(weekFactList(texts).map((f) => [f.key, f.text]));
    expect(by.get('ukonczone')).toBe('5 ukończonych zadań');
    expect(by.get('zalegle')).toBe('2 zaległe zadania');
    expect(by.get('skupienie')).toBe('1 h 20 min skupienia');
    expect(by.get('nawyki')).toBe('zadania cykliczne wykonane 3 z 6');
    expect(by.get('lista1')).toBe('3 ukończone zadania w „Praca”');
    expect(by.get('nawyk1')).toBe('„woda” 3 z 6');
    expect(by.get('pelnyDzien')).toContain('25 listopada (2 zadania)');
  });
});

describe('liczby w zdaniach', () => {
  const known = new Set(['zalegle', 'z1']);
  const ok = (s: string) => weekSentenceProblem(s, known) === null;

  it('znaczniki przechodzą, cyfry, liczebniki, procenty i obce znaczniki nie', () => {
    expect(ok('Do nadrobienia {zalegle}, zacznij od {z1}.')).toBe(true);
    expect(ok('Trzymaj tempo, prosta sprawa — stoisz przed spokojnym tygodniem, sześcian to nie liczba.')).toBe(true);
    for (const bad of [
      'Masz 3 zaległe.',
      'Masz trzy zaległe.',
      'Dwa zadania czekają.',
      'Zostało pięć.',
      'Minęło dwadzieścia dni.',
      'Siedemnaście zadań.',
      'Jedno zadanie utknęło.',
      'Zrobiono połowę.',
      'Zrobiono dwukrotnie więcej.',
      'Wynik: 80%.',
      'To dziesięć procent.',
      'Masz ²  zadania.',
      'Masz ٣ zadania.',
      'Masz {nieznany}.',
      'Masz {z2}.',
      'Masz {zalegle.',
      'Masz {1}.',
    ])
      expect(ok(bad), bad).toBe(false);
  });

  it('za długie zdanie odpada', () => {
    expect(ok(`${'a '.repeat(200)}.`)).toBe(false);
  });
});

describe('zapytanie i odpowiedź AI', () => {
  const facts = weekFacts(input, ctx);
  const list = weekFactList(weekFactTexts(facts, names));
  const review = weeklyReview({ tasks, lists: [], completions: input.habitCompletions }, ctx);
  const build = (over: Partial<Parameters<typeof weekSummaryRequest>[0]> = {}) =>
    weekSummaryRequest({ accountId: ACCOUNT, from: facts.from, today: ctx.today, facts: list, doneTaskIds: facts.doneTaskIds, tasks, review, canEdit: () => true, listName: names.list, hint: null, ...over });
  const query = build();
  const options = { facts: list, tasks, canEdit: () => true, ctx };
  const answer = (over: Partial<AiWeekSummary> = {}) => AiWeekSummary.parse({ sentences: ['Za tobą {ukonczone}.', '{zalegle} czeka, zacznij od {z1}', 'Najpełniej zapowiada się {pelnyDzien}.'], suggestions: [], ...over });

  it('zadania pod numerami: przekładane, zaległe, potem ukończone; zgodne ze schematem', () => {
    expect(AiWeekSummaryRequest.safeParse(query.request).success).toBe(true);
    expect(query.ids.slice(0, 3)).toEqual(['zalegle', 'zalegle-2', 'inna-przestrzen']);
    expect(query.request.tasks[0]).toEqual({ n: 1, title: 'zalegle', state: 'postponed', list: 'Dom', dueDate: '2026-11-10', series: false });
    expect(query.request.tasks[2]!.state).toBe('done');
    const prompt = weekSummaryPrompt(query.request);
    expect(prompt).toContain('{"znacznik":"{zalegle}","opis":"Zaległe","wstawi":"2 zaległe zadania"}');
    expect(prompt).not.toContain(W1);
  });

  it('e-maile zasłonięte, zadań tylko do odczytu nie ma do decyzji; opis wstawia prawdziwy tytuł', () => {
    const mail = [...tasks.filter((t) => t.id !== 'zalegle'), task({ id: 'zalegle', title: 'Odpisz jan@example.com', dueDate: '2026-11-10', postponeCount: 4 })];
    const withMail = build({ tasks: mail, review: weeklyReview({ tasks: mail, lists: [] }, ctx) });
    expect(JSON.stringify(withMail.request)).not.toContain('example.com');
    expect(weekSummaryFromAi(answer(), withMail, { ...options, tasks: mail })!.text).toContain('„Odpisz jan@example.com”');
    expect(build({ canEdit: (t) => t.id !== 'zalegle' }).ids[0]).toBe('zalegle-2');
  });

  it('liczby podstawia kod, zdania z własnymi liczbami odpadają', () => {
    const summary = weekSummaryFromAi(answer({ sentences: ['Za tobą {ukonczone}.', 'Masz 7 spraw.', '{zalegle} czeka, zacznij od {z1}', 'Zrobiłeś {wymyslone}.'] }), query, options)!;
    expect(summary.text).toBe('Za tobą 5 ukończonych zadań. 2 zaległe zadania czeka, zacznij od „zalegle”.');
    expect(weekSummaryFromAi(answer({ sentences: ['Masz 7 spraw.'] }), query, options)).toBeNull();
    expect(weekSummaryFromAi(answer({ sentences: Array.from({ length: 9 }, () => 'Dobrze.') }), query, options)!.text).toBe('Dobrze. Dobrze. Dobrze. Dobrze. Dobrze.');
  });

  it('sugestie: zmyślony numer, ukończone, powtórzone, bez skutku i obca akcja odpadają; najwyżej trzy', () => {
    const suggest = (suggestions: unknown[]) => weekSummaryFromAi(answer({ suggestions } as Partial<AiWeekSummary>), query, options)!.suggestions;
    expect(suggest([{ n: 1, kind: 'tomorrow', reason: 'Zaległe od {zalegle}' }])).toEqual([{ taskId: 'zalegle', action: { kind: 'tomorrow' }, reason: 'Zaległe od 2 zaległe zadania.' }]);
    expect(suggest([{ n: 1, kind: 'date', date: '2026-11-27', reason: 'Za 3 dni.' }])).toEqual([{ taskId: 'zalegle', action: { kind: 'date', date: '2026-11-27' }, reason: null }]);
    expect(suggest([{ n: 99, kind: 'today' }, { n: 0, kind: 'today' }, { n: 3, kind: 'today' }])).toEqual([]);
    expect(suggest([{ n: 1, kind: 'done' }, { n: 1, kind: 'zrob' }, { n: 1, kind: 'date', date: '2026-11-24' }, { n: 1, kind: 'date', date: '2028-01-01' }, { n: 1, kind: 'date', date: '2026-02-31' }, { n: 1, kind: 'date' }])).toEqual([]);
    expect(suggest([{ n: 1, kind: 'someday' }, { n: 1, kind: 'delete' }, { n: 2, kind: 'delete' }])).toEqual([
      { taskId: 'zalegle', action: { kind: 'someday' }, reason: null },
      { taskId: 'zalegle-2', action: { kind: 'delete' }, reason: null },
    ]);
  });

  it('seria bez „kiedyś”; zadanie zamknięte w międzyczasie nie ma sugestii', () => {
    const late = task({ id: 'pozna-seria', dueDate: '2026-11-20', recurrence: daily });
    const all = [late, ...tasks];
    const q = build({ tasks: all, review: weeklyReview({ tasks: [late], lists: [] }, ctx) });
    expect(q.ids[0]).toBe('pozna-seria');
    const suggestions = [{ n: 1, kind: 'someday', date: null, reason: null }];
    expect(weekSummaryFromAi(answer({ suggestions }), q, { ...options, tasks: all })!.suggestions).toEqual([]);
    const gone = { ...options, tasks: tasks.map((t) => (t.id === 'zalegle' ? { ...t, status: 'done' as const } : t)) };
    expect(weekSummaryFromAi(answer({ suggestions: [{ n: 1, kind: 'today', date: null, reason: null }] }), query, gone)!.suggestions).toEqual([]);
    expect(weekSuggestionActive(late, { action: { kind: 'someday' } }, ctx)).toBe(false);
    expect(weekSuggestionActive(late, { action: { kind: 'today' } }, ctx)).toBe(true);
    expect(weekSuggestionActive({ ...late, dueDate: ctx.today }, { action: { kind: 'today' } }, ctx)).toBe(false);
    expect(weekSuggestionActive(undefined, { action: { kind: 'delete' } }, ctx)).toBe(false);
  });

  it('serwer: za mało poprawnych zdań = powody do naprawy, reszta przycięta', () => {
    const schema = weekSummaryAnswer(query.request);
    const bad = schema.safeParse({ sentences: ['Za tobą {ukonczone}.', 'Masz 3 zaległe.'] });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.map((i) => i.message)).toEqual(['Liczba wpisana poza znacznikiem faktu.', 'Napisz 3–5 zdań.']);
    expect(schema.safeParse({ sentences: ['a.', 'b.', 'c.', 'Masz 3.'] }).success).toBe(true);
    expect(validWeekSentences(['a.', 'b.', 'c.', 'Masz 3.'], query.request)).toEqual(['a.', 'b.', 'c.']);
  });

  it('losowe odpowiedzi: po odjęciu fraz faktów i tytułów w tekście nie zostaje żadna liczba', () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) % n;
    const parts = ['{ukonczone}', '{zalegle}', '{z1}', '{z9}', '{lista1}', '{pelnyDzien}', '12', 'trzy', '50%', 'i', 'czeka', 'dziewięćdziesiąt', '{wymysl}', '{', 'w piątek', 'setki', 'jeden'];
    const texts = [...list.map((f) => f.text), ...tasks.map((t) => `„${t.title}”`)].sort((a, b) => b.length - a.length);
    for (let i = 0; i < 500; i++) {
      const sentences = Array.from({ length: 6 }, () => Array.from({ length: 1 + rnd(5) }, () => parts[rnd(parts.length)]).join(' '));
      const result = weekSummaryFromAi({ sentences, suggestions: [] }, query, options);
      if (!result) continue;
      let rest = result.text;
      for (const t of texts) for (const form of [t, t.charAt(0).toUpperCase() + t.slice(1)]) rest = rest.replaceAll(form, ' ');
      expect(weekSentenceProblem(rest.slice(0, 300), new Set()), result.text).toBeNull();
    }
  });
});

describe('zapis w sesji przeglądu', () => {
  it('`stats.summary` jest opcjonalne i wraca z lokalnej bazy', () => {
    const stats = { ...reviewStats([]), summary: 'Za tobą 5 ukończonych zadań.' };
    expect(ReviewStats.parse(stats)).toEqual(stats);
    expect(ReviewStats.parse(reviewStats([]))).not.toHaveProperty('summary');
    const op = reviewFinishOp('0190a000-0000-7000-8000-000000000009', stats, new Date('2026-11-24T12:00:00Z'));
    expect(reviewSummary(JSON.stringify(op.patch.stats))).toBe('Za tobą 5 ukończonych zadań.');
    expect(reviewSummary(reviewStats([]))).toBeNull();
    expect(reviewSummary('{zły json')).toBeNull();
    expect(reviewSummary(null)).toBeNull();
  });
});
