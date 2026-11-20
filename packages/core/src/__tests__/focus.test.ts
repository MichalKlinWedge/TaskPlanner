/**
 * Pomodoro (M14, §7.7): stan ze znaczników czasu, wpisy `time_entries` przy przejściach.
 */
import { describe, expect, it } from 'vitest';

import { advanceFocus, DEFAULT_FOCUS, FOCUS_IDLE, focusEndPush, focusEndText, focusEntryId, focusMinutes, focusRemaining, FocusSettings, FocusState, focusStepOps, focusWeek, manualEntryOps, orphanEntryOps, parseFocusState, pauseFocus, phaseEndsAt, resumeFocus, skipPhase, startFocus, stopFocus, type EntryOp } from '../focus.ts';
import { formatTimer } from '../format.ts';
import { FOCUS_PHASE } from '../labels.ts';

const T0 = Date.parse('2026-11-18T09:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);
const ids = () => {
  let n = 0;
  return () => `e${++n}`;
};
const describeOps = (ops: EntryOp[]) => ops.map((o) => (o.op === 'open' ? `open ${o.id} ${o.kind}#${o.pomodoroIndex ?? '-'} @${(Date.parse(o.startedAt) - T0) / 60_000}` : `close ${o.id} @${(Date.parse(o.endedAt) - T0) / 60_000}`));

describe('ustawienia', () => {
  it('domyślne 25/5/15 co 4 i walidacja', () => {
    expect(DEFAULT_FOCUS).toEqual({ focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longBreakEvery: 4, enabled: true });
    expect(FocusSettings.parse({ enabled: false })).toMatchObject({ enabled: false, focusMin: 25 });
    expect(FocusSettings.safeParse({ focusMin: 0 }).success).toBe(false);
  });
});

describe('Pomodoro', () => {
  it('start, pozostały czas, koniec etapu', () => {
    const { state, entries } = startFocus(FOCUS_IDLE, { taskId: 'task', now: at(0), newId: ids() });
    expect(describeOps(entries)).toEqual(['open e1 focus#1 @0']);
    expect(focusRemaining(state, at(10))).toBe(15 * 60_000);
    expect(phaseEndsAt(state)).toEqual(at(25));
    expect(FocusState.parse(state)).toEqual(state);
  });

  it('pauza zamyka wpis, wznowienie otwiera nowy; czas pauzy się nie liczy', () => {
    const newId = ids();
    let s = startFocus(FOCUS_IDLE, { taskId: 'task', now: at(0), newId }).state;
    const paused = pauseFocus(s, at(10));
    expect(describeOps(paused.entries)).toEqual(['close e1 @10']);
    expect(focusRemaining(paused.state, at(40))).toBe(15 * 60_000);
    expect(phaseEndsAt(paused.state)).toBeNull();
    const resumed = resumeFocus(paused.state, at(40), newId);
    s = resumed.state;
    expect(describeOps(resumed.entries)).toEqual(['open e2 focus#1 @40']);
    expect(phaseEndsAt(s)).toEqual(at(55));
  });

  it('koniec pracy sam zaczyna przerwę, koniec przerwy czeka (uśpione urządzenie)', () => {
    const newId = ids();
    const s = startFocus(FOCUS_IDLE, { taskId: 'task', now: at(0), newId }).state;
    // Aplikacja wraca po 3 godzinach: praca 0–25, przerwa 25–30, potem gotowe — bez kolejnych cykli.
    const step = advanceFocus(s, at(180), { newId });
    expect(describeOps(step.entries)).toEqual(['close e1 @25', 'open e2 break#1 @25', 'close e2 @30']);
    expect(step.state.phase).toBe('ready');
    expect(step.state.completedFocus).toBe(1);
    expect(advanceFocus(s, at(20), { newId }).entries).toEqual([]);
  });

  it('długa przerwa po 4. etapie pracy, seria trwa po `ready`', () => {
    const newId = ids();
    let s = FOCUS_IDLE;
    const phases: string[] = [];
    for (let i = 0, t = 0; i < 4; i++) {
      s = startFocus(s, { taskId: 'task', now: at(t), newId }).state;
      s = advanceFocus(s, at(t + 25), { newId }).state;
      phases.push(`${s.phase}:${s.completedFocus}`);
      t += 60;
      s = advanceFocus(s, at(t), { newId }).state;
    }
    expect(phases).toEqual(['short_break:1', 'short_break:2', 'short_break:3', 'long_break:4']);
  });

  it('pomiń i stop', () => {
    const newId = ids();
    const s = startFocus(FOCUS_IDLE, { taskId: 'task', now: at(0), newId }).state;
    const skipped = skipPhase(s, at(12), { newId });
    expect(describeOps(skipped.entries)).toEqual(['close e1 @12', 'open e2 break#1 @12']);
    expect(skipped.state.phase).toBe('short_break');
    const stopped = stopFocus(skipped.state, at(14));
    expect(describeOps(stopped.entries)).toEqual(['close e2 @14']);
    expect(stopped.state).toEqual(FOCUS_IDLE);
  });

  it('stoper bez limitu; nowy start zamyka poprzedni wpis', () => {
    const newId = ids();
    const watch = startFocus(FOCUS_IDLE, { taskId: 'a', mode: 'stopwatch', now: at(0), newId });
    expect(describeOps(watch.entries)).toEqual(['open e1 focus#- @0']);
    expect(focusRemaining(watch.state, at(500))).toBeNull();
    expect(advanceFocus(watch.state, at(500), { newId }).entries).toEqual([]);
    const next = startFocus(watch.state, { taskId: 'b', now: at(90), newId });
    expect(describeOps(next.entries)).toEqual(['close e1 @90', 'open e2 focus#1 @90']);
  });

  it('własne długości etapów', () => {
    const settings = FocusSettings.parse({ focusMin: 50, shortBreakMin: 10 });
    const s = startFocus(FOCUS_IDLE, { taskId: null, now: at(0), newId: ids() }).state;
    expect(phaseEndsAt(s, settings)).toEqual(at(50));
    expect(advanceFocus(s, at(55), { settings, newId: ids() }).state.phase).toBe('short_break');
  });
});

describe('powiadomienie o końcu etapu (Web Push z serwera)', () => {
  it('koniec w oknie → klucz odcinka i treść; pauza, stoper, poza oknem — nic', () => {
    const work = startFocus(FOCUS_IDLE, { taskId: 'task', now: at(0), newId: ids() }).state;
    const win = (from: number, to: number) => focusEndPush(work, DEFAULT_FOCUS, { from: at(from), to: at(to) });
    expect(win(20, 26)).toEqual({ key: 'e1:focus', endsAt: at(25).toISOString(), taskId: 'task', title: 'Koniec pracy', body: 'Krótka przerwa — odpocznij.' });
    expect(win(26, 30)).toBeNull();
    expect(win(0, 24)).toBeNull();
    expect(focusEndPush(pauseFocus(work, at(10)).state, DEFAULT_FOCUS, { from: at(0), to: at(60) })).toBeNull();
    const watch = startFocus(FOCUS_IDLE, { taskId: null, mode: 'stopwatch', now: at(0), newId: ids() }).state;
    expect(focusEndPush(watch, DEFAULT_FOCUS, { from: at(0), to: at(600) })).toBeNull();
    // Przerwa (już po przejściu): koniec przerwy, bez zadania.
    const brk = advanceFocus(startFocus(FOCUS_IDLE, { taskId: null, now: at(0), newId: ids() }).state, at(26), { newId: ids() }).state;
    expect(focusEndPush(brk, DEFAULT_FOCUS, { from: at(29), to: at(31) })).toMatchObject({ endsAt: at(30).toISOString(), taskId: null, title: 'Koniec przerwy' });
    expect(focusEndText('focus', { ...FOCUS_IDLE, phase: 'long_break' }).body).toBe('Długa przerwa — odpocznij.');
  });
});

describe('czas pracy', () => {
  const entries = [
    { taskId: 'a', kind: 'focus' as const, startedAt: at(0).toISOString(), endedAt: at(25).toISOString() },
    { taskId: 'a', kind: 'break' as const, startedAt: at(25).toISOString(), endedAt: at(30).toISOString() },
    { taskId: 'a', kind: 'manual' as const, startedAt: at(60).toISOString(), endedAt: at(90).toISOString() },
    { taskId: 'b', kind: 'focus' as const, startedAt: at(100).toISOString(), endedAt: null },
  ];
  it('praca i ręczne wpisy, otwarty do teraz, przycięcie do okresu', () => {
    expect(focusMinutes(entries, at(110), { taskId: 'a' })).toBe(55);
    expect(focusMinutes(entries, at(110), { taskId: 'b' })).toBe(10);
    expect(focusMinutes(entries, at(110))).toBe(65);
    expect(focusMinutes(entries, at(110), { from: at(10), to: at(70) })).toBe(25);
  });
});

describe('zapis w aplikacji (Etap 7)', () => {
  const user = '0190a000-0000-7000-8000-000000000001';

  it('przejście → wpisy time_entries i stan w profilu; stop czyści stan', () => {
    const start = startFocus(FOCUS_IDLE, { taskId: 't1', now: at(0), newId: focusEntryId(user) });
    const ops = focusStepOps(user, start);
    expect(ops).toEqual([
      { table: 'time_entries', id: start.state.entryId, patch: { task_id: 't1', kind: 'focus', started_at: at(0).toISOString(), ended_at: null, pomodoro_index: 1 } },
      { table: 'profiles', id: user, patch: { focus: start.state } },
    ]);
    const stop = focusStepOps(user, stopFocus(start.state, at(10)));
    expect(stop).toEqual([
      { table: 'time_entries', id: start.state.entryId, patch: { ended_at: at(10).toISOString() } },
      { table: 'profiles', id: user, patch: { focus: null } },
    ]);
    expect(parseFocusState(JSON.stringify(start.state))).toEqual(start.state);
    expect(parseFocusState(null)).toEqual(FOCUS_IDLE);
    expect(parseFocusState('{zepsute')).toEqual(FOCUS_IDLE);
  });

  it('dwa urządzenia doliczają koniec etapu niezależnie — te same wpisy (id deterministyczne)', () => {
    const start = startFocus(FOCUS_IDLE, { taskId: 't1', now: at(0), newId: focusEntryId(user) });
    const a = advanceFocus(start.state, at(26), { newId: focusEntryId(user) });
    const b = advanceFocus(start.state, at(29), { newId: focusEntryId(user) });
    expect(a).toEqual(b);
    expect(a.state.phase).toBe('short_break');
  });

  it('kryterium: 4 cykle Pomodoro → 4 wpisy pracy i 4 przerwy, ostatnia długa', () => {
    const newId = focusEntryId(user);
    let step = startFocus(FOCUS_IDLE, { taskId: 't1', now: at(0), newId });
    const entries: EntryOp[] = [...step.entries];
    let t = 0;
    for (let cycle = 0; cycle < 4; cycle++) {
      t += 25 + (cycle === 3 ? 15 : 5);
      const done = advanceFocus(step.state, at(t), { newId });
      entries.push(...done.entries);
      expect(done.state.phase).toBe('ready');
      if (cycle < 3) {
        step = startFocus(done.state, { taskId: 't1', now: at(t), newId });
        entries.push(...step.entries);
      }
    }
    const opened = entries.filter((e): e is Extract<EntryOp, { op: 'open' }> => e.op === 'open');
    expect(opened.map((e) => `${e.kind}#${e.pomodoroIndex}`)).toEqual(['focus#1', 'break#1', 'focus#2', 'break#2', 'focus#3', 'break#3', 'focus#4', 'break#4']);
    expect(new Set(opened.map((e) => e.id)).size).toBe(8);
    expect(entries.filter((e) => e.op === 'close')).toHaveLength(8);
    expect(describeOps(entries.slice(-1))).toEqual([`close ${opened[7]!.id} @${t}`]);
  });

  it('porzucony wpis (stan wygrał na innym urządzeniu) zamyka się, bieżący i świeże zostają', () => {
    const state = startFocus(FOCUS_IDLE, { taskId: 't2', now: at(30), newId: () => 'current' }).state;
    const entries = [
      { id: 'lost', taskId: 't1', kind: 'focus' as const, startedAt: at(20).toISOString(), endedAt: null, pomodoroIndex: 1 },
      { id: 'current', taskId: 't2', kind: 'focus' as const, startedAt: at(30).toISOString(), endedAt: null, pomodoroIndex: 1 },
      { id: 'old-watch', taskId: null, kind: 'focus' as const, startedAt: at(-600).toISOString(), endedAt: null, pomodoroIndex: null },
      { id: 'fresh', taskId: 't3', kind: 'focus' as const, startedAt: at(39).toISOString(), endedAt: null, pomodoroIndex: 1 },
    ];
    expect(orphanEntryOps(entries, state, at(40))).toEqual([
      { table: 'time_entries', id: 'lost', patch: { ended_at: at(30).toISOString() } },
      { table: 'time_entries', id: 'old-watch', patch: { ended_at: at(30).toISOString() } },
    ]);
    // Bez działającego timera: Pomodoro — po długości etapu, stoper — teraz.
    expect(orphanEntryOps([entries[0]!, entries[2]!], FOCUS_IDLE, at(100))).toEqual([
      { table: 'time_entries', id: 'lost', patch: { ended_at: at(45).toISOString() } },
      { table: 'time_entries', id: 'old-watch', patch: { ended_at: at(100).toISOString() } },
    ]);
  });

  it('ręczny wpis kończy się teraz; poza zakresem — nic', () => {
    expect(manualEntryOps('t1', 45, at(60), () => 'm1')).toEqual([
      { table: 'time_entries', id: 'm1', patch: { task_id: 't1', kind: 'manual', started_at: at(15).toISOString(), ended_at: at(60).toISOString(), pomodoro_index: null } },
    ]);
    expect(manualEntryOps('t1', 0, at(60))).toEqual([]);
    expect(manualEntryOps('t1', Number.NaN, at(60))).toEqual([]);
  });

  it('statystyki tygodnia: dni w strefie, przestrzenie, listy, zadania, ukończone Pomodoro', () => {
    // Środa 18.11.2026 w Warszawie (UTC+1); tydzień od poniedziałku 16.11.
    const e = (id: string, taskId: string | null, kind: 'focus' | 'break' | 'manual', from: string, to: string, pomodoroIndex: number | null) => ({
      id,
      taskId,
      kind,
      startedAt: new Date(from).toISOString(),
      endedAt: new Date(to).toISOString(),
      pomodoroIndex,
    });
    const entries = [
      // Pomodoro z pauzą: dwa wpisy pracy #1, potem przerwa — jedno ukończone.
      e('a', 't1', 'focus', '2026-11-16T08:00:00Z', '2026-11-16T08:10:00Z', 1),
      e('b', 't1', 'focus', '2026-11-16T08:20:00Z', '2026-11-16T08:35:00Z', 1),
      e('c', 't1', 'break', '2026-11-16T08:35:00Z', '2026-11-16T08:40:00Z', 1),
      // Przerwane stopem — bez przerwy, nie liczy się jako ukończone.
      e('d', 't2', 'focus', '2026-11-17T10:00:00Z', '2026-11-17T10:12:00Z', 1),
      // Przez północ czasu warszawskiego (23:30–00:30): po 30 min we wtorek i w środę.
      e('e', null, 'focus', '2026-11-17T22:30:00Z', '2026-11-17T23:30:00Z', null),
      e('f', 't3', 'manual', '2026-11-18T09:00:00Z', '2026-11-18T10:00:00Z', null),
      // Poprzedni tydzień — poza.
      e('g', 't1', 'focus', '2026-11-15T10:00:00Z', '2026-11-15T11:00:00Z', null),
    ];
    const tasks = [
      { id: 't1', listId: 'L1', workspaceId: 'W1' },
      { id: 't2', listId: 'L2', workspaceId: 'W1' },
      { id: 't3', listId: 'L3', workspaceId: 'W2' },
    ];
    const week = focusWeek(entries, tasks, { today: '2026-11-18', timeZone: 'Europe/Warsaw', now: new Date('2026-11-18T12:00:00Z') });
    expect(week.from).toBe('2026-11-16');
    expect(week.days.map((d) => d.minutes)).toEqual([25, 42, 90, 0, 0, 0, 0]);
    expect(week.total).toBe(157);
    expect(week.pomodoros).toBe(1);
    expect(week.byWorkspace.map((b) => [b.id, b.minutes])).toEqual([
      ['W2', 60],
      [null, 60],
      ['W1', 37],
    ]);
    expect(week.byList.find((b) => b.id === 'L1')?.minutes).toBe(25);
    expect(week.byTask.find((b) => b.id === null)?.minutes).toBe(60);
  });

  it('tarcza timera i etykiety etapów', () => {
    expect(formatTimer(25 * 60_000)).toBe('25:00');
    expect(formatTimer(59_001)).toBe('1:00');
    expect(formatTimer(0)).toBe('0:00');
    expect(formatTimer(3_723_000)).toBe('1:02:03');
    expect(FOCUS_PHASE.short_break).toBe('Krótka przerwa');
  });
});
