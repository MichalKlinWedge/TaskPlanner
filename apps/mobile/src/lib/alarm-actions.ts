/**
 * „Zakończ” z alarmu: zapis z kolejki modułu natywnego, potem przeplanowanie i widżety. Osobno od `alarm.ts`,
 * bo planowanie (`scheduler.ts`) samo z niego korzysta.
 */
import { refreshWidgets } from '../widget/refresh';
import { drainAlarmActions } from './alarm';
import { scheduleReminders } from './scheduler';

export async function handleAlarmActions(): Promise<void> {
  if (!(await drainAlarmActions().catch(() => false))) return;
  await scheduleReminders().catch(() => undefined);
  await refreshWidgets().catch(() => undefined);
}
