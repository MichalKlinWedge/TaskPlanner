/**
 * Dane i odświeżanie widżetów „Dziś”, „Cykliczne”, „Szybkie dodawanie” z lokalnej bazy — modele z core
 * (`todayWidgetModel`, `habitsWidgetModel`, `inboxCount`), bieżąca przestrzeń jak w aplikacji.
 * Odświeżenie (M20): po każdej zmianie danych w aplikacji, po akcji z powiadomienia i z widżetu,
 * z zadania w tle oraz co 30 min (`updatePeriodMillis` → `WIDGET_UPDATE` w `task-handler.ts`).
 */
import { habitsWidgetModel, inboxCount, localDateAt, todayWidgetModel, type HabitsWidgetModel, type TodayWidgetModel, type ViewContext } from '@taskplanner/core';
import { Platform } from 'react-native';
import { getWidgetInfo, requestWidgetUpdate, type WidgetRepresentation } from 'react-native-android-widget';

import { currentWorkspace, type AppData } from '../lib/app-data';
import { headlessData } from '../lib/headless';
import { toLocalTime } from '../lib/time';
import { HABITS_WIDGET, habitsWidget } from './habits-widget';
import { QUICK_ADD_WIDGET, quickAddWidget } from './quick-add-widget';
import { TODAY_WIDGET, todayWidget } from './today-widget';

export const WIDGETS = [TODAY_WIDGET, HABITS_WIDGET, QUICK_ADD_WIDGET] as const;
export type WidgetName = (typeof WIDGETS)[number];

export const isWidgetName = (name: string): name is WidgetName => (WIDGETS as readonly string[]).includes(name);

export interface WidgetView {
  today: TodayWidgetModel | null;
  habits: HabitsWidgetModel | null;
  inbox: number | null;
  updatedAt: string;
  error?: string;
}

/** Wszystkie modele naraz — jeden odczyt bazy na odświeżenie. `given` — już wczytane dane widoków (ekran). */
export async function loadWidgetView(given?: AppData): Promise<WidgetView> {
  const updatedAt = toLocalTime(new Date());
  try {
    const data = given ?? (await headlessData());
    const today = localDateAt(new Date(), data.settings.timeZone);
    const selected = currentWorkspace();
    const ctx: ViewContext = {
      today,
      timeZone: data.settings.timeZone,
      workspaceId: data.workspaces.some((w) => w.id === selected) ? selected : null,
      firstDayOfWeek: data.settings.firstDayOfWeek,
    };
    const inboxIds = new Set(data.lists.filter((l) => l.kind === 'inbox').map((l) => l.id));
    return {
      today: todayWidgetModel(data.tasks, ctx),
      habits: habitsWidgetModel(data.tasks, data.habitCompletions, ctx),
      inbox: inboxCount(data.tasks, inboxIds, ctx),
      updatedAt,
    };
  } catch (error) {
    return { today: null, habits: null, inbox: null, updatedAt, error: `Błąd bazy: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function renderWidgetView(name: WidgetName, view: WidgetView): WidgetRepresentation {
  switch (name) {
    case TODAY_WIDGET:
      return todayWidget(view.today, view.updatedAt, view.error);
    case HABITS_WIDGET:
      return habitsWidget(view.habits, view.updatedAt, view.error);
    case QUICK_ADD_WIDGET:
      return quickAddWidget(view.inbox);
  }
}

/** Widżety położone na ekranie głównym (bez żadnego — bez odczytu bazy). */
async function placedWidgets(): Promise<WidgetName[]> {
  const placed = await Promise.all(WIDGETS.map(async (name) => ((await getWidgetInfo(name)).length > 0 ? name : null)));
  return placed.filter((name): name is WidgetName => name !== null);
}

/**
 * Odświeżenie położonych widżetów (wszystkich albo bez `except` — ten rysuje obsługa kliknięcia).
 * `view` — już policzone modele (obsługa widżetu), inaczej odczyt z `given` albo z bazy.
 */
export async function refreshWidgets(given?: AppData, { except, view }: { except?: WidgetName; view?: WidgetView } = {}): Promise<void> {
  if (Platform.OS !== 'android') return;
  const placed = (await placedWidgets()).filter((name) => name !== except);
  if (!placed.length) return;
  const current = view ?? (await loadWidgetView(given));
  await Promise.all(placed.map((name) => requestWidgetUpdate({ widgetName: name, renderWidget: () => renderWidgetView(name, current) })));
}
