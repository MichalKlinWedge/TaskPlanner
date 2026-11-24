/**
 * Ułożenie dnia: korpus `fixtures/day-plan.json` (wyniki policzone ręcznie), niezmienniki na losowych dniach
 * (brak kolizji, godziny pracy, zależności) i operacje z cofnięciem; kontekst „✨ Ułóż z AI”.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AI_PLAN_MAX_TASKS, AiDayPlan, AiDayPlanRequest, dayPlanFromAi, dayPlanPrompt, dayPlanRequest } from '../ai-day-plan.ts';
import { zonedInstant } from '../dates.ts';
import {
  autoPlanDay,
  dayPlanOps,
  draftMinutes,
  planCandidates,
  planSlots,
  validateDayPlan,
  wallTimeAt,
  withDraft,
  withoutBlock,
  type AutoPlanOptions,
  type DayPlanDraft,
  type PlanProposal,
} from '../day-planner.ts';
import type { HabitSlot } from '../habits.ts';
import { blocksForDay, conflicts, type BlockTask, type CalendarEventLike, type DayPlan, type WorkHours } from '../time-blocking.ts';
import type { ViewTask } from '../views.ts';

interface CaseTask extends Partial<ViewTask> {
  id: string;
  rrule?: string;
}
type Row = [string, string, string];
interface Case {
  name: string;
  date?: string;
  today?: string;
  days?: number[];
  work?: [string, string];
  nowMin?: number;
  bufferMin?: number;
  tasks: CaseTask[];
  events?: [string, string, string, boolean?][];
  habits?: [string, string, HabitSlot['state']][];
  deps?: [string, string, number?][];
  plan?: Row[];
  unplaced?: [string, string][];
  series?: number;
  workday?: boolean;
  invariants?: boolean;
  ai?: { proposals: [string, string][]; plan: Row[]; unplaced: [string, string][]; rejected: [string, string][] };
}

const corpus = JSON.parse(readFileSync(new URL('../../../../fixtures/day-plan.json', import.meta.url), 'utf8')) as { date: string; timeZone: string; cases: Case[] };
const TODAY = corpus.date;
const timeZone = corpus.timeZone;

const task = ({ rrule, ...over }: CaseTask): ViewTask => ({
  workspaceId: 'w1',
  listId: 'l1',
  parentId: null,
  kind: 'task',
  title: over.id,
  status: 'todo',
  priority: 4,
  startDate: null,
  dueDate: TODAY,
  dueTime: null,
  durationMin: null,
  recurrence: rrule ? { mode: 'schedule', rrule, anchor: over.dueDate ?? TODAY } : null,
  habit: null,
  completedAt: null,
  createdAt: '2026-11-01T10:00:00Z',
  sortKey: 'm',
  tagIds: [],
  postponeCount: 0,
  ...over,
});

interface Setup {
  tasks: ViewTask[];
  plan: DayPlan;
  work: WorkHours;
  options: AutoPlanOptions & { bufferMin: number };
}

function setup(c: Case): Setup {
  const date = c.date ?? TODAY;
  const tasks = c.tasks.map(task);
  const events: CalendarEventLike[] = (c.events ?? []).map(([id, from, to, busy]) => ({
    id,
    title: id,
    allDay: false,
    startAt: zonedInstant(date, from, timeZone).toISOString(),
    endAt: zonedInstant(date, to, timeZone).toISOString(),
    ...(busy !== undefined && { busy }),
  }));
  const habits: HabitSlot[] = (c.habits ?? []).map(([id, time, state]) => ({ id, title: id, date, time, state, future: false }));
  return {
    tasks,
    plan: blocksForDay(tasks.filter((t) => t.kind === 'task') as BlockTask[], events, date, { timeZone, habits }),
    work: { days: c.days ?? [1, 2, 3, 4, 5], start: c.work?.[0] ?? '09:00', end: c.work?.[1] ?? '17:00' },
    options: {
      date,
      today: c.today ?? TODAY,
      canEdit: (t) => t.listId !== 'ro',
      deps: (c.deps ?? []).map(([predecessorId, successorId, lagDays = 0]) => ({ predecessorId, successorId, lagDays })),
      nowMin: c.nowMin ?? null,
      bufferMin: c.bufferMin ?? 10,
      timeZone,
    },
  };
}

const rows = (draft: DayPlanDraft): Row[] => draft.blocks.map((b) => [b.taskId, b.start, b.end]);
const left = (draft: DayPlanDraft) => draft.unplaced.map((u) => [u.taskId, u.reason]);

/** Niezmienniki kryterium odbioru: bez kolizji, w godzinach pracy, po „teraz”, zależności, każde zadanie raz. */
function checkInvariants(draft: DayPlanDraft, { tasks, plan, work, options }: Setup) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const candidates = planCandidates(tasks, options).tasks.map((t) => t.id);
  const ids = [...draft.blocks.map((b) => b.taskId), ...draft.unplaced.map((u) => u.taskId)];
  expect([...ids].sort()).toEqual([...candidates].sort());

  // Po zapisie: prawdziwe bloki z zapisanych godzin, konflikty liczone tym samym silnikiem co w kalendarzu.
  const { ops } = dayPlanOps(draft, tasks);
  const saved = tasks.map((t) => {
    const patch = ops.find((op) => op.id === t.id)?.patch;
    return patch ? { ...t, dueDate: String(patch.due_date), dueTime: String(patch.due_time), durationMin: Number(patch.duration_min) } : t;
  });
  const day = blocksForDay(saved.filter((t) => t.kind === 'task') as BlockTask[], [], plan.date, { timeZone });
  const others = plan.timed.filter((b) => b.kind !== 'task');
  const placed = new Set(draft.blocks.map((b) => b.taskId));
  const all = [...day.timed, ...others].map((b) => ({ ...b, virtual: false }));
  expect(conflicts(all).filter((c) => placed.has(c.a.id) || placed.has(c.b.id))).toEqual([]);
  const block = new Map(day.timed.map((b) => [b.id, b]));
  const minute = (time: string) => Math.round((zonedInstant(plan.date, time, timeZone).getTime() - zonedInstant(plan.date, '00:00', timeZone).getTime()) / 60_000);
  for (const b of draft.blocks) {
    const real = block.get(b.taskId)!;
    expect([real.startMin, real.endMin]).toEqual([b.startMin, b.endMin]);
    expect(b.startMin).toBeGreaterThanOrEqual(Math.max(minute(work.start), options.nowMin ?? 0));
    expect(b.endMin).toBeLessThanOrEqual(minute(work.end));
    expect(b.startMin % 5).toBe(0);
  }
  for (const d of options.deps ?? []) {
    const [p, s] = [block.get(d.predecessorId), block.get(d.successorId)];
    if (d.lagDays === 0 && p && s && (placed.has(d.predecessorId) || placed.has(d.successorId))) expect(p.endMin).toBeLessThanOrEqual(s.startMin);
    const predecessor = byId.get(d.predecessorId);
    if (d.lagDays >= 0 && placed.has(d.successorId) && predecessor && candidates.includes(predecessor.id)) expect(placed.has(d.predecessorId) && d.lagDays === 0).toBe(true);
  }
}

describe('korpus fixtures/day-plan.json', () => {
  for (const c of corpus.cases) {
    it(c.name, () => {
      const s = setup(c);
      const draft = autoPlanDay(s.tasks, s.plan, s.work, s.options);
      checkInvariants(draft, s);
      if (c.plan) {
        expect(rows(draft)).toEqual(c.plan);
        expect(left(draft)).toEqual(c.unplaced);
        expect(draft.series).toBe(c.series ?? 0);
        expect(draft.workday).toBe(c.workday ?? true);
      }
      if (c.ai) {
        const proposals: PlanProposal[] = c.ai.proposals.map(([taskId, start]) => ({ taskId, start }));
        const checked = validateDayPlan(proposals, s.tasks, s.plan, s.work, s.options);
        checkInvariants(checked, s);
        expect(rows(checked)).toEqual(c.ai.plan);
        expect(left(checked)).toEqual(c.ai.unplaced);
        expect(checked.rejected.map((r) => [r.taskId, r.reason])).toEqual(c.ai.rejected);
      }
      // Własny wynik jako propozycja przechodzi sprawdzenie bez zmian.
      const again = validateDayPlan(draft.blocks.map((b) => ({ taskId: b.taskId, start: b.start })), s.tasks, s.plan, s.work, s.options);
      expect(again.rejected).toEqual([]);
      expect(rows(again)).toEqual(rows(draft));
    });
  }
});

describe('losowe dni', () => {
  /** Generator liczb pseudolosowych (mulberry32) — powtarzalny. */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

  it('300 dni: ułożenie i dowolna propozycja AI spełniają kryterium odbioru', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = random(seed);
      const int = (n: number) => Math.floor(rnd() * n);
      const tasks: CaseTask[] = Array.from({ length: 3 + int(15) }, (_, i) => ({
        id: `t${i}`,
        priority: (1 + int(4)) as ViewTask['priority'],
        dueDate: ['2026-11-19', TODAY, TODAY, '2026-11-26'][int(4)]!,
        dueTime: int(4) === 0 ? clock(8 * 60 + int(40) * 15) : null,
        durationMin: [null, 15, 25, 60, 90, 240][int(6)]!,
        parentId: i > 0 && int(6) === 0 ? `t${int(i)}` : null,
        postponeCount: int(4),
      }));
      const deps: [string, string, number][] = Array.from({ length: int(8) }, () => {
        const a = int(tasks.length);
        const b = int(tasks.length);
        return [`t${Math.min(a, b)}`, `t${Math.max(a, b)}`, [0, 0, 0, 1, -1][int(5)]!];
      });
      const s = setup({
        name: String(seed),
        tasks,
        deps: deps.filter(([a, b]) => a !== b),
        events: Array.from({ length: int(4) }, (_, i) => {
          const from = 8 * 60 + int(36) * 15;
          return [`e${i}`, clock(from), clock(from + 15 + int(6) * 15)];
        }),
        nowMin: int(2) ? 480 + int(540) : undefined,
        bufferMin: [0, 5, 10, 15][int(4)]!,
      });
      const draft = autoPlanDay(s.tasks, s.plan, s.work, s.options);
      checkInvariants(draft, s);
      expect(autoPlanDay([...s.tasks].reverse(), s.plan, s.work, s.options).blocks).toEqual(draft.blocks);
      const proposals = Array.from({ length: 12 }, () => ({ taskId: `t${int(tasks.length + 2)}`, start: ['x', '24:10', clock(int(24 * 60)), clock(8 * 60 + int(120) * 5)][int(6)] ?? clock(9 * 60 + int(96) * 5) }));
      checkInvariants(validateDayPlan(proposals, s.tasks, s.plan, s.work, s.options), s);
    }
  });

  it('cykl zależności nie zawiesza i niczego z cyklu nie układa', () => {
    const s = setup({ name: 'cykl', tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], deps: [['a', 'b'], ['b', 'a']] });
    const draft = autoPlanDay(s.tasks, s.plan, s.work, s.options);
    expect(rows(draft)).toEqual([['c', '09:00', '09:30']]);
    expect(left(draft).map(([, reason]) => reason)).toEqual(['dependency', 'dependency']);
  });
});

describe('zapis', () => {
  const s = setup({ name: 'zapis', tasks: [{ id: 'a', dueDate: '2026-11-20', startDate: '2026-11-18', dueTime: '08:00', priority: 1 }, { id: 'b', durationMin: 45 }] });
  const draft = autoPlanDay(s.tasks, s.plan, s.work, s.options);

  it('termin, godzina i czas; cofnięcie przywraca poprzednie wartości', () => {
    const result = dayPlanOps(draft, s.tasks);
    expect(result.ops).toEqual([
      { table: 'tasks', id: 'a', patch: { due_date: TODAY, due_time: '09:00', duration_min: 30 } },
      { table: 'tasks', id: 'b', patch: { due_date: TODAY, due_time: '09:40', duration_min: 45 } },
    ]);
    expect(result.undo).toEqual([
      { table: 'tasks', id: 'a', patch: { due_date: '2026-11-20', due_time: '08:00', duration_min: null } },
      { table: 'tasks', id: 'b', patch: { due_date: TODAY, due_time: null, duration_min: 45 } },
    ]);
    expect(result.count).toBe(2);
    expect(draftMinutes(draft)).toBe(75);
  });

  it('pomija zadania zmienione od ułożenia i wyrzucone z podglądu', () => {
    expect(dayPlanOps(draft, [{ ...s.tasks[0]!, status: 'done' }]).count).toBe(0);
    expect(dayPlanOps(withoutBlock(draft, 'a'), s.tasks).ops.map((op) => op.id)).toEqual(['b']);
  });

  it('podgląd: szkic jako bloki, bez pozycji „cały dzień” tych zadań', () => {
    const day = withDraft(s.plan, draft.blocks, new Map(s.tasks.map((t) => [t.id, t])), timeZone);
    expect(day.timed.map((b) => [b.id, wallTimeAt(TODAY, b.startMin, timeZone)])).toEqual([['a', '09:00'], ['b', '09:40']]);
    expect(day.allDay).toEqual([]);
    expect(planSlots(day, s.work, { bufferMin: 0, timeZone })).toEqual([{ startMin: 570, endMin: 580 }, { startMin: 625, endMin: 1020 }]);
  });
});

describe('„✨ Ułóż z AI”', () => {
  const ACCOUNT = '0190a000-0000-4000-8000-00000000000a';
  const s = setup({
    name: 'ai',
    tasks: [
      { id: 'cel', title: 'Wyślij ofertę do jan.k@firma.pl', priority: 1, dueDate: '2026-11-20', postponeCount: 2 },
      { id: 'dane', title: 'Zbierz dane', durationMin: 45 },
      { id: 'spotkanie', title: 'Tajne spotkanie', dueTime: '13:00', durationMin: 60 },
      { id: 'notatka', title: 'Notatka' },
      { id: 'jutro', title: 'Jutrzejsze', dueDate: '2026-11-25' },
      { id: 'po-jutrze', title: 'Zablokowane' },
    ],
    deps: [['dane', 'cel'], ['spotkanie', 'notatka'], ['jutro', 'po-jutrze']],
    events: [['wizyta u lekarza', '10:00', '11:00']],
  });
  const built = dayPlanRequest(s.tasks, s.plan, s.work, s.options, { accountId: ACCOUNT, hint: ' rano trudne, pytania: a@b.pl ' })!;

  it('kontekst: numery zamiast id, bez e-maili, wydarzeń i zablokowanych; przechodzi schemat funkcji', () => {
    expect(AiDayPlanRequest.parse(built.request)).toEqual(built.request);
    expect(built.ids).toEqual(['dane', 'cel', 'notatka']);
    expect(built.request.tasks).toEqual([
      { n: 1, title: 'Zbierz dane', durationMin: 45, priority: 4, dueDate: TODAY, postponed: 0, after: [], notBefore: null, endBefore: null },
      { n: 2, title: 'Wyślij ofertę do [e-mail]', durationMin: 30, priority: 1, dueDate: '2026-11-20', postponed: 2, after: [1], notBefore: null, endBefore: null },
      { n: 3, title: 'Notatka', durationMin: 30, priority: 4, dueDate: TODAY, postponed: 0, after: [], notBefore: '14:00', endBefore: null },
    ]);
    expect(built.request.free).toEqual([{ start: '09:00', end: '09:50' }, { start: '11:10', end: '12:50' }, { start: '14:10', end: '17:00' }]);
    expect(built.request.hint).toBe('rano trudne, pytania: [e-mail]');
    const prompt = dayPlanPrompt(built.request);
    for (const secret of ['Tajne', 'lekarza', 'Jutrzejsze', 'Zablokowane', '@']) expect(prompt).not.toContain(secret);
    expect(prompt).toContain('"preferencjaUzytkownika":"rano trudne, pytania: [e-mail]"');
    expect(prompt).toContain('"zalegleOd":"2026-11-20"');
    expect(prompt).toContain('zostaw 10 min przerwy');
  });

  it('odpowiedź: numer → zadanie, zmyślony numer odpada, godzina „9:00” = „09:00”', () => {
    const answer = AiDayPlan.parse({ blocks: [{ n: 1, start: '9:00' }, { n: 2, start: '11:10:00' }, { n: 9, start: '15:00' }, { n: 0, start: '15:00' }] });
    const draft = dayPlanFromAi(answer, built.ids, s.tasks, s.plan, s.work, s.options);
    expect(rows(draft)).toEqual([['dane', '09:00', '09:45'], ['cel', '11:10', '11:40']]);
    expect(draft.rejected.map((r) => [r.taskId, r.reason])).toEqual([['#9', 'unknown'], ['#0', 'unknown']]);
    expect(left(draft)).toEqual([['notatka', 'omitted'], ['po-jutrze', 'dependency']]);
    expect(AiDayPlan.safeParse({ blocks: [{ n: 'a', start: '09:00' }] }).success).toBe(false);
    expect(AiDayPlan.safeParse({ plan: [] }).success).toBe(false);
  });

  it('null bez zadań albo bez wolnego okna; najwyżej AI_PLAN_MAX_TASKS zadań', () => {
    expect(dayPlanRequest([], s.plan, s.work, s.options, { accountId: ACCOUNT })).toBeNull();
    expect(dayPlanRequest(s.tasks, s.plan, { ...s.work, days: [7] }, s.options, { accountId: ACCOUNT })).toBeNull();
    const many = setup({ name: 'dużo', tasks: Array.from({ length: AI_PLAN_MAX_TASKS + 5 }, (_, i) => ({ id: `t${i}` })) });
    const request = dayPlanRequest(many.tasks, many.plan, many.work, many.options, { accountId: ACCOUNT })!.request;
    expect(AiDayPlanRequest.parse(request).tasks).toHaveLength(AI_PLAN_MAX_TASKS);
  });
});
