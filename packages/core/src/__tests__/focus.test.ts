/**
 * Pomodoro (M14, §7.7): stan ze znaczników czasu, wpisy `time_entries` przy przejściach.
 */
import { describe, expect, it } from 'vitest';

import { advanceFocus, DEFAULT_FOCUS, FOCUS_IDLE, focusMinutes, focusRemaining, FocusSettings, FocusState, pauseFocus, phaseEndsAt, resumeFocus, skipPhase, startFocus, stopFocus, type EntryOp } from '../focus.ts';

const T0 = Date.parse('2026-11-18T09:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);
const ids = () => {
  let n = 0;
  return () => `e${++n}`;
};
const describeOps = (ops: EntryOp[]) => ops.map((o) => (o.op === 'open' ? `open ${o.id} ${o.kind}#${o.pomodoroIndex ?? '-'} @${(Date.parse(o.startedAt) - T0) / 60_000}` : `close ${o.id} @${(Date.parse(o.endedAt) - T0) / 60_000}`));

describe('ustawienia', () => {
  it('domyślne 25/5/15 co 4 i walidacja', () => {
    expect(DEFAULT_FOCUS).toEqual({ focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longBreakEvery: 4 });
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
