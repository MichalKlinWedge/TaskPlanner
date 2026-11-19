/**
 * Dane widżetu „Dziś” z lokalnej bazy — reguły widoku z core (`selectToday`: zaległe, dziś,
 * ukończone dziś), bieżąca przestrzeń jak w aplikacji. Wywoływane z obsługi widżetu (bez ekranu),
 * po akcji z powiadomienia, po zmianie w aplikacji i z zadania w tle.
 */
import { localDateAt, selectToday } from '@taskplanner/core';
import { Platform } from 'react-native';
import { requestWidgetUpdate } from 'react-native-android-widget';

import { currentWorkspace } from '../lib/app-data';
import { headlessData } from '../lib/headless';
import { toLocalTime } from '../lib/time';
import { TODAY_WIDGET, todayWidget, type WidgetTask } from './today-widget';

export async function renderTodayWidget() {
  const updatedAt = toLocalTime(new Date());
  try {
    const data = await headlessData();
    const today = localDateAt(new Date(), data.settings.timeZone);
    const workspaceId = currentWorkspace();
    const view = selectToday(data.tasks, { today, timeZone: data.settings.timeZone, workspaceId: data.workspaces.some((w) => w.id === workspaceId) ? workspaceId : null });
    const tasks: WidgetTask[] = [...view.overdue, ...view.today, ...view.done].map((t) => ({
      id: t.id,
      title: t.title,
      done: t.status === 'done',
      time: t.dueTime,
      overdue: !!t.dueDate && t.dueDate < today && t.status !== 'done',
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
