/** Natywny alarm przypomnień (Android, `android/`). `null`, gdy modułu nie ma w buildzie (stary APK, web). */
import type { AlarmEntry, LocalDate } from '@taskplanner/core';
import { requireOptionalNativeModule } from 'expo';

/** „Zakończ” z planszy albo powiadomienia, czekające na zapis do bazy. */
export interface AlarmAction {
  key: string;
  taskId: string;
  occurrenceDate: LocalDate | null;
  habit: boolean;
  at: number;
}

export interface AlarmState {
  scheduled: AlarmEntry[];
  ringing: AlarmEntry[];
  actions: AlarmAction[];
}

interface NativeTaskAlarm {
  state(): string;
  schedule(entries: string): void;
  cancel(ids: string[]): void;
  dismiss(ids: string[]): void;
  ackAction(key: string): void;
  canFullScreen(): boolean;
  openFullScreenSettings(): void;
}

const native = requireOptionalNativeModule<NativeTaskAlarm>('TaskAlarm');

export const TaskAlarm = native && {
  state: () => JSON.parse(native.state()) as AlarmState,
  schedule: (entries: readonly AlarmEntry[]) => native.schedule(JSON.stringify(entries)),
  cancel: (ids: string[]) => native.cancel(ids),
  dismiss: (ids: string[]) => native.dismiss(ids),
  ackAction: (key: string) => native.ackAction(key),
  canFullScreen: () => native.canFullScreen(),
  openFullScreenSettings: () => native.openFullScreenSettings(),
};
