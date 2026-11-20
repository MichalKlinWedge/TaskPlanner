/**
 * Obsługa widżetów (zadanie bez ekranu `RNWidgetBackgroundTask`): dodanie, odświeżenie co 30 min
 * (`WIDGET_UPDATE`), zmiana rozmiaru i kliknięcia — odhaczenie zadania albo wpis dnia nawyku w
 * lokalnej bazie (+ outbox, reguły core przez `lib/headless.ts`), nowy widok tego widżetu i pozostałych
 * (licznik Inbox, „Dziś”), na końcu wysyłka od razu, gdy jest sieć.
 */
import type { WidgetTaskHandlerProps } from 'react-native-android-widget';

import { readJson, writeJson } from '../lib/config';
import { reportError } from '../lib/error-log';
import { pushNow, setHabitEntryById, setTaskDoneById } from '../lib/headless';
import { entryFromClick, HABIT_ENTRY_ACTION } from './habits-widget';
import { isWidgetName, loadWidgetView, refreshWidgets, renderWidgetView } from './refresh';
import { TASK_DONE_ACTION } from './today-widget';

export interface WidgetLog {
  at: number;
  widget: string;
  action: string;
  ok: boolean;
  /** Czy kliknięcie coś zapisało (powtórzone / nieaktualne — nie). */
  changed?: boolean;
  ms: number;
  error?: string;
}

const LOG_KEY = 'widget.log';
export const widgetLog = () => readJson<WidgetLog[]>(LOG_KEY, []);

/** Zapis z kliknięcia; `false` — nic do zmiany (powtórzone kliknięcie, nieaktualny widżet). */
async function applyClick(action: string | undefined, data: Record<string, unknown> | undefined): Promise<boolean> {
  if (action === TASK_DONE_ACTION && typeof data?.id === 'string' && typeof data.done === 'boolean') {
    return setTaskDoneById(data.id, data.done, typeof data.occurrence === 'string' ? (data.occurrence as never) : null);
  }
  if (action === HABIT_ENTRY_ACTION) {
    const click = entryFromClick(data);
    if (click) return setHabitEntryById(click.id, click.date as never, click.entry);
  }
  return false;
}

export async function widgetTaskHandler({ widgetInfo, widgetAction, clickAction, clickActionData, renderWidget }: WidgetTaskHandlerProps) {
  const name = widgetInfo.widgetName;
  if (!isWidgetName(name) || widgetAction === 'WIDGET_DELETED') return;
  const start = Date.now();
  const entry: WidgetLog = { at: start, widget: name, action: widgetAction === 'WIDGET_CLICK' ? `CLICK ${clickAction}` : widgetAction, ok: true, ms: 0 };
  try {
    if (widgetAction === 'WIDGET_CLICK') entry.changed = await applyClick(clickAction, clickActionData);
  } catch (error) {
    entry.ok = false;
    entry.error = error instanceof Error ? error.message : String(error);
    reportError('error', error, { area: 'widget', widget: name, action: clickAction ?? widgetAction });
  }
  const view = await loadWidgetView();
  renderWidget(renderWidgetView(name, view));
  // Zmiana z jednego widżetu zmienia też inne (licznik Inbox, zadania „Dziś”).
  if (entry.changed) await refreshWidgets(undefined, { except: name, view }).catch(() => undefined);
  entry.ms = Date.now() - start;
  writeJson(LOG_KEY, [...widgetLog().slice(-99), entry]);
  if (entry.changed) await pushNow();
}
