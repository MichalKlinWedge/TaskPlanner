/**
 * Zadania uruchamiane przez system bez ekranu — muszą być zdefiniowane w zasięgu modułu
 * (import w `index.ts` przed Expo Routerem), bo przy zamkniętej aplikacji żaden komponent się nie montuje.
 */
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { AppRegistry } from 'react-native';
import { registerWidgetTaskHandler } from 'react-native-android-widget';

import { ALARM_TASK } from '../lib/alarm';
import { handleAlarmActions } from '../lib/alarm-actions';
import { defineBackgroundSync } from '../lib/background-sync';
import { handleQuickCaptures, QUICK_CAPTURE_TASK } from '../lib/quick-capture';
import { handleResponse, NOTIFICATION_TASK } from '../lib/reminders';
import { widgetTaskHandler } from '../widget/task-handler';

TaskManager.defineTask<Notifications.NotificationTaskPayload>(NOTIFICATION_TASK, async ({ data, error }) => {
  if (error || !data || !('actionIdentifier' in data)) return Notifications.BackgroundNotificationTaskResult.NoData;
  await handleResponse(data, 'background-task');
  return Notifications.BackgroundNotificationTaskResult.NewData;
});

AppRegistry.registerHeadlessTask(ALARM_TASK, () => handleAlarmActions);
AppRegistry.registerHeadlessTask(QUICK_CAPTURE_TASK, () => async () => {
  await handleQuickCaptures();
});
registerWidgetTaskHandler(widgetTaskHandler);
defineBackgroundSync();
