/**
 * Zadania uruchamiane przez system bez ekranu — muszą być zdefiniowane w zasięgu modułu
 * (import w `index.ts` przed Expo Routerem), bo przy zamkniętej aplikacji żaden komponent się nie montuje.
 */
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { registerWidgetTaskHandler } from 'react-native-android-widget';

import { handleResponse, NOTIFICATION_TASK } from '../lib/reminders';
import { widgetTaskHandler } from '../widget/task-handler';

TaskManager.defineTask<Notifications.NotificationTaskPayload>(NOTIFICATION_TASK, async ({ data, error }) => {
  if (error || !data || !('actionIdentifier' in data)) return Notifications.BackgroundNotificationTaskResult.NoData;
  await handleResponse(data, 'background-task');
  return Notifications.BackgroundNotificationTaskResult.NewData;
});

registerWidgetTaskHandler(widgetTaskHandler);
