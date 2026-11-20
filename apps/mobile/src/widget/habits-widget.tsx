'use no memo';
// Widżet to drzewo zwykłych funkcji wywoływanych poza Reactem — React Compiler nie może ich
// przerabiać (dodałby hooki pamięci podręcznej → „Invalid hook call”).
import type { HabitEntry, HabitsWidgetModel } from '@taskplanner/core';
import { FlexWidget, ListWidget, TextWidget } from 'react-native-android-widget';

import { APP_URI, themed, WidgetError, WidgetHeader, type Palette } from './ui';

export const HABITS_WIDGET = 'Habits';
/** Dane kliknięcia: `{ id, date, kind: 'done' | 'skipped' | 'clear', value? }` — wpis docelowy dnia. */
export const HABIT_ENTRY_ACTION = 'HABIT_ENTRY';

/** Wpis → dane kliknięcia (natywna strona nie przyjmuje `null`). */
const entryData = (id: string, date: string, entry: HabitEntry): Record<string, unknown> =>
  !entry ? { id, date, kind: 'clear' } : entry.kind === 'done' && entry.value != null ? { id, date, kind: 'done', value: entry.value } : { id, date, kind: entry.kind };

/** Dane kliknięcia → wpis (odwrotność `entryData`); nieznane dane → `undefined`. */
export function entryFromClick(data: Record<string, unknown> | undefined): { id: string; date: string; entry: HabitEntry } | undefined {
  if (typeof data?.id !== 'string' || typeof data.date !== 'string') return undefined;
  if (data.kind === 'clear') return { id: data.id, date: data.date, entry: null };
  if (data.kind === 'skipped') return { id: data.id, date: data.date, entry: { kind: 'skipped' } };
  if (data.kind === 'done') return { id: data.id, date: data.date, entry: { kind: 'done', value: typeof data.value === 'number' ? data.value : null } };
  return undefined;
}

const EMPTY: HabitsWidgetModel = { date: '', items: [], open: 0 };

function HabitsWidgetView({ model, palette, updatedAt, error }: { model: HabitsWidgetModel; palette: Palette; updatedAt: string; error?: string }) {
  return (
    <FlexWidget style={{ height: 'match_parent', width: 'match_parent', backgroundColor: palette.bg, borderRadius: 16, padding: 12, flexDirection: 'column' }}>
      <WidgetHeader title={`Nawyki · ${model.open}`} updatedAt={updatedAt} uri={APP_URI.today} palette={palette} />
      <WidgetError error={error} palette={palette} />
      {model.items.length === 0 && !error ? <TextWidget text="Brak nawyków na dziś." style={{ fontSize: 13, color: palette.muted }} /> : null}
      <ListWidget style={{ height: 'match_parent', width: 'match_parent' }}>
        {model.items.map((h) => (
          <FlexWidget key={h.id} style={{ width: 'match_parent', flexDirection: 'row', alignItems: 'center', paddingVertical: 4 }}>
            <FlexWidget
              clickAction={HABIT_ENTRY_ACTION}
              clickActionData={entryData(h.id, model.date, h.toggle)}
              accessibilityLabel={`${h.done ? 'Cofnij' : 'Zrobione'}: ${h.title}`}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', paddingVertical: 2 }}
            >
              <TextWidget text={h.done ? '☑' : '☐'} style={{ fontSize: 18, color: h.settled ? palette.muted : palette.accent, marginRight: 8 }} />
              <FlexWidget style={{ flex: 1, flexDirection: 'column' }}>
                <TextWidget text={h.title} maxLines={1} truncate="END" style={{ fontSize: 14, color: h.settled ? palette.muted : palette.fg }} />
                {h.progress ? <TextWidget text={h.progress} maxLines={1} style={{ fontSize: 11, color: palette.muted }} /> : null}
              </FlexWidget>
            </FlexWidget>
            {h.plusOne ? (
              <FlexWidget
                clickAction={HABIT_ENTRY_ACTION}
                clickActionData={entryData(h.id, model.date, h.plusOne)}
                accessibilityLabel={`Dodaj 1: ${h.title}`}
                style={{ backgroundColor: palette.field, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, marginLeft: 6 }}
              >
                <TextWidget text="+1" style={{ fontSize: 13, fontWeight: '600', color: palette.accent }} />
              </FlexWidget>
            ) : null}
          </FlexWidget>
        ))}
      </ListWidget>
    </FlexWidget>
  );
}

export const habitsWidget = (model: HabitsWidgetModel | null, updatedAt: string, error?: string) =>
  themed((palette) => <HabitsWidgetView model={model ?? EMPTY} palette={palette} updatedAt={updatedAt} error={error} />);
