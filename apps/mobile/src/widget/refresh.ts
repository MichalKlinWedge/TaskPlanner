/**
 * Dane widżetu „Dziś” z lokalnej bazy. Wywoływane z obsługi widżetu (bez ekranu), po akcji
 * z powiadomienia i po zmianie na ekranie aplikacji.
 */
import { Platform } from 'react-native';
import { requestWidgetUpdate } from 'react-native-android-widget';

import { todayTasks } from '../lib/tasks';
import { localToday, toLocalTime } from '../lib/time';
import { TODAY_WIDGET, todayWidget, type WidgetTask } from './today-widget';

export async function renderTodayWidget() {
  const updatedAt = toLocalTime(new Date());
  try {
    const today = localToday();
    const tasks: WidgetTask[] = (await todayTasks(today)).map((t) => ({
      id: t.id,
      title: t.title,
      done: t.status === 'done',
      time: t.due_time,
      overdue: !!t.due_date && t.due_date < today,
    }));
    return todayWidget(tasks, updatedAt);
  } catch (error) {
    return todayWidget([], updatedAt, `Błąd bazy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function refreshTodayWidget() {
  if (Platform.OS !== 'android') return;
  const widget = await renderTodayWidget();
  await requestWidgetUpdate({ widgetName: TODAY_WIDGET, renderWidget: () => widget });
}
