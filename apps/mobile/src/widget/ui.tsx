'use no memo';
// Widżet to drzewo zwykłych funkcji wywoływanych poza Reactem — React Compiler nie może ich
// przerabiać (dodałby hooki pamięci podręcznej → „Invalid hook call”).
import type { ReactElement } from 'react';
import { FlexWidget, TextWidget } from 'react-native-android-widget';

export interface Palette {
  bg: `#${string}`;
  fg: `#${string}`;
  muted: `#${string}`;
  accent: `#${string}`;
  danger: `#${string}`;
  field: `#${string}`;
}

const LIGHT: Palette = { bg: '#ffffff', fg: '#18181b', muted: '#71717a', accent: '#2563eb', danger: '#dc2626', field: '#f4f4f5' };
const DARK: Palette = { bg: '#18181b', fg: '#fafafa', muted: '#a1a1aa', accent: '#60a5fa', danger: '#f87171', field: '#27272a' };

/** Wersja jasna i ciemna — launcher wybiera według motywu systemu. */
export const themed = (view: (palette: Palette) => ReactElement) => ({ light: view(LIGHT), dark: view(DARK) });

/** Głębokie linki do aplikacji (te same trasy co skróty aplikacji). */
export const APP_URI = {
  today: 'taskplanner:///',
  inbox: 'taskplanner:///inbox',
  quickAdd: 'taskplanner://quick-add',
  voice: 'taskplanner://quick-add?voice=1',
} as const;

/** Nagłówek: tytuł z licznikiem (otwiera aplikację) i godzina ostatniego odświeżenia. */
export function WidgetHeader({ title, updatedAt, uri, palette }: { title: string; updatedAt: string; uri: string; palette: Palette }) {
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri }}
      style={{ width: 'match_parent', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}
    >
      <TextWidget text={title} style={{ fontSize: 16, fontWeight: '600', color: palette.fg }} />
      <TextWidget text={updatedAt} style={{ fontSize: 11, color: palette.muted }} />
    </FlexWidget>
  );
}

/**
 * Komunikat błędu. Zawsze zwraca element: biblioteka pomija `null` jako dziecko, ale komponent
 * zwracający `null` wywraca `buildWidgetTree` („Cannot read property 'type' of null”) i widżet
 * zostaje pusty — warunek jest w miejscu użycia (`{error ? <WidgetError … /> : null}`).
 */
export const WidgetError = ({ error, palette }: { error: string; palette: Palette }) => (
  <TextWidget text={error} style={{ fontSize: 12, color: palette.danger }} maxLines={3} />
);
