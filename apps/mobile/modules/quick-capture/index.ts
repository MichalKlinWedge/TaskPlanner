/** Okno szybkiego dodawania nad ekranem głównym (Android, `android/`). `null`, gdy modułu nie ma w buildzie (stary APK). */
import { requireOptionalNativeModule } from 'expo';

/** Wpis z okna czekający na zapis do Inbox. */
export interface QuickCaptureEntry {
  key: string;
  text: string;
  at: number;
}

interface NativeQuickCapture {
  pending(): string;
  ack(key: string): void;
}

const native = requireOptionalNativeModule<NativeQuickCapture>('QuickCapture');

export const QuickCapture = native && {
  pending: () => JSON.parse(native.pending()) as QuickCaptureEntry[],
  ack: (key: string) => native.ack(key),
};
