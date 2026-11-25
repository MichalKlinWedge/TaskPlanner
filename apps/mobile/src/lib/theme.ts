/**
 * Motyw aplikacji z `settings.theme` (wspólny z webem): nadpisuje jasny / ciemny tryb systemu dla ekranów
 * (`useColorScheme`). Ostatni wybór jest w kv-store, żeby start nie mignął motywem systemu przed
 * wczytaniem profilu. Widżety zostają przy trybie systemu.
 */
import type { ProfileSettings } from '@taskplanner/core';
import Storage from 'expo-sqlite/kv-store';
import { Appearance } from 'react-native';

type Theme = ProfileSettings['theme'];

const KEY = 'ui.theme';
let applied: Theme = 'system';

/** Wywołanie bez zmiany motywu nic nie robi. */
export function applyTheme(theme: Theme) {
  if (theme === applied) return;
  applied = theme;
  Appearance.setColorScheme(theme === 'system' ? 'unspecified' : theme);
  Storage.setItemSync(KEY, theme);
}

/** Przy starcie, przed pierwszym ekranem. */
export function applySavedTheme() {
  const saved = Storage.getItemSync(KEY);
  if (saved === 'light' || saved === 'dark') applyTheme(saved);
}
