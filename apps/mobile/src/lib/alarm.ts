/**
 * Tryb przypomnień tego telefonu (M8): powiadomienie na belce albo alarm na cały ekran z przyciskami „Zakończ” /
 * „Edytuj” / „Czekaj N min”. Alarm (plansza, dźwięk, „Czekaj”) działa w module natywnym `task-alarm` bez JS;
 * tu jest ustawienie urządzenia, dopasowanie planu i zapis „Zakończ” z kolejki modułu.
 */
import { ALARM_SNOOZE_CHOICES, alarmPlan, alarmStillDue, DEFAULT_ALARM_SNOOZE, uuidv7, type AlarmEntry, type ReminderMode, type ReminderTask } from '@taskplanner/core';

import { TaskAlarm } from '../../modules/task-alarm';
import type { AppData } from './app-data';
import { readJson, writeJson } from './config';
import { reportError } from './error-log';
import { completeTaskById, habitDoneById, pushNow } from './headless';

/** Zadanie bez ekranu uruchamiane po „Zakończ” (`AlarmActionWorker`). */
export const ALARM_TASK = 'TaskAlarmActions';

const K = { mode: 'reminders.mode', snooze: 'reminders.alarmSnooze' } as const;
/** Alarmy próbne — poza planem przypomnień. */
const TEST_PREFIX = 't_';

export const alarmAvailable = TaskAlarm !== null;

export const reminderMode = (): ReminderMode => (alarmAvailable && readJson<string>(K.mode, 'banner') === 'alarm' ? 'alarm' : 'banner');
export const setReminderMode = (mode: ReminderMode) => writeJson(K.mode, mode);

export function alarmSnooze(): number {
  const value = readJson<number>(K.snooze, DEFAULT_ALARM_SNOOZE);
  return (ALARM_SNOOZE_CHOICES as readonly number[]).includes(value) ? value : DEFAULT_ALARM_SNOOZE;
}
export const setAlarmSnooze = (minutes: number) => writeJson(K.snooze, minutes);

export const canFullScreen = (): boolean => TaskAlarm?.canFullScreen() ?? false;
export const openFullScreenSettings = () => TaskAlarm?.openFullScreenSettings();

/**
 * Alarmy zgodne z planem (`wanted` puste w trybie belki). Odłożone i dzwoniące zostają, dopóki mają o czym
 * przypominać; `enabled = false` (przypomnienia na telefonie wyłączone) kasuje wszystko.
 */
export function syncAlarms(
  wanted: readonly AlarmEntry[],
  tasks: ReadonlyMap<string, ReminderTask>,
  habitCompletions: AppData['habitCompletions'],
  enabled: boolean,
): { added: number; removed: number } {
  if (!TaskAlarm) return { added: 0, removed: 0 };
  const test = (e: AlarmEntry) => e.taskId === '';
  const { scheduled, ringing, actions } = TaskAlarm.state();
  // „Zakończ” czekające na zapis: zadanie jeszcze otwarte w bazie, ale alarmu już nie trzeba.
  const closing = new Set(actions.map((a) => `${a.taskId}:${a.occurrenceDate ?? ''}`));
  const pending = (e: AlarmEntry) => closing.has(`${e.taskId}:${e.occurrenceDate ?? ''}`);
  const plan = alarmPlan(
    wanted.filter((e) => !pending(e)),
    { scheduled: scheduled.filter((e) => !test(e)), ringing: ringing.filter((e) => !test(e)) },
    Date.now(),
    (e) => enabled && !pending(e) && alarmStillDue(e, tasks.get(e.taskId), habitCompletions),
  );
  if (plan.cancel.length) TaskAlarm.cancel(plan.cancel);
  if (plan.dismiss.length) TaskAlarm.dismiss(plan.dismiss);
  if (plan.set.length) TaskAlarm.schedule(plan.set);
  return { added: plan.set.length, removed: plan.cancel.length };
}

/** Próba z ustawień: plansza za `seconds` (bez zadania — „Zakończ” niczego nie zapisuje). */
export function testAlarm(seconds = 10) {
  TaskAlarm?.schedule([
    {
      id: TEST_PREFIX + uuidv7(),
      taskId: '',
      at: Date.now() + seconds * 1000,
      title: 'Próbny alarm',
      body: 'Tak będą wyglądać przypomnienia',
      snoozedBody: 'Odłożone',
      description: 'Tu pojawi się opis zadania.',
      occurrenceDate: null,
      habit: false,
      snoozeMin: alarmSnooze(),
    },
  ]);
}

let draining: Promise<boolean> | null = null;

/**
 * Zapis „Zakończ” z kolejki modułu (zadanie bez ekranu, start i powrót aplikacji). Operacje są idempotentne,
 * a wpis znika z kolejki dopiero po zapisie. `true` — coś zapisano.
 */
export function drainAlarmActions(): Promise<boolean> {
  draining ??= drain().finally(() => {
    draining = null;
  });
  return draining;
}

async function drain(): Promise<boolean> {
  if (!TaskAlarm) return false;
  let changed = false;
  for (const action of TaskAlarm.state().actions) {
    try {
      if (action.habit) changed = (action.occurrenceDate ? await habitDoneById(action.taskId, action.occurrenceDate) : false) || changed;
      else changed = (await completeTaskById(action.taskId, action.occurrenceDate)) || changed;
      TaskAlarm.ackAction(action.key);
    } catch (error) {
      reportError('error', error, { alarm: true });
    }
  }
  if (changed) await pushNow();
  return changed;
}
