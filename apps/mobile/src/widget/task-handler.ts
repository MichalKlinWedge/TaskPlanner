/**
 * Obsługa widżetu (zadanie bez ekranu `RNWidgetBackgroundTask`): dodanie, odświeżenie, zmiana
 * rozmiaru i kliknięcie w zadanie → odhaczenie w lokalnej bazie (+ outbox, reguły core) i nowy widok.
 */
import type { WidgetTaskHandlerProps } from 'react-native-android-widget';

import { readJson, writeJson } from '../lib/config';
import { toggleTaskById } from '../lib/headless';
import { renderTodayWidget } from './refresh';
import { TODAY_WIDGET, TOGGLE_ACTION } from './today-widget';

export interface WidgetLog {
  at: number;
  action: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export const widgetLog = () => readJson<WidgetLog[]>('poc4.widget', []);

export async function widgetTaskHandler({ widgetInfo, widgetAction, clickAction, clickActionData, renderWidget }: WidgetTaskHandlerProps) {
  if (widgetInfo.widgetName !== TODAY_WIDGET || widgetAction === 'WIDGET_DELETED') return;
  const start = Date.now();
  const entry: WidgetLog = { at: start, action: widgetAction === 'WIDGET_CLICK' ? `CLICK ${clickAction}` : widgetAction, ok: true, ms: 0 };
  try {
    if (widgetAction === 'WIDGET_CLICK' && clickAction === TOGGLE_ACTION && typeof clickActionData?.id === 'string') {
      await toggleTaskById(clickActionData.id);
    }
  } catch (error) {
    entry.ok = false;
    entry.error = error instanceof Error ? error.message : String(error);
  }
  renderWidget(await renderTodayWidget());
  entry.ms = Date.now() - start;
  writeJson('poc4.widget', [...widgetLog().slice(-99), entry]);
}
