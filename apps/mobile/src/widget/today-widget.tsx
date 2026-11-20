'use no memo';
// Widżet to drzewo zwykłych funkcji wywoływanych poza Reactem — React Compiler nie może ich
// przerabiać (dodałby hooki pamięci podręcznej → „Invalid hook call”).
import type { TodayWidgetModel } from '@taskplanner/core';
import { FlexWidget, ListWidget, TextWidget } from 'react-native-android-widget';

import { APP_URI, themed, WidgetError, WidgetHeader, type Palette } from './ui';

export const TODAY_WIDGET = 'Today';
/** Dane kliknięcia: `{ id, done, occurrence? }` — stan docelowy, nie „przełącz”. */
export const TASK_DONE_ACTION = 'TASK_DONE';

const EMPTY: TodayWidgetModel = { items: [], open: 0, more: 0 };

function TodayWidgetView({ model, palette, updatedAt, error }: { model: TodayWidgetModel; palette: Palette; updatedAt: string; error?: string }) {
  return (
    <FlexWidget style={{ height: 'match_parent', width: 'match_parent', backgroundColor: palette.bg, borderRadius: 16, padding: 12, flexDirection: 'column' }}>
      <WidgetHeader title={`Dziś · ${model.open}`} updatedAt={updatedAt} uri={APP_URI.today} palette={palette} />
      {error ? <WidgetError error={error} palette={palette} /> : null}
      {model.items.length === 0 && !error ? <TextWidget text="Nic na dziś." style={{ fontSize: 13, color: palette.muted }} /> : null}
      <ListWidget style={{ height: 'match_parent', width: 'match_parent' }}>
        {[
          ...model.items.map((task) => (
            <FlexWidget
              key={task.id}
              clickAction={TASK_DONE_ACTION}
              clickActionData={task.occurrence ? { id: task.id, done: !task.done, occurrence: task.occurrence } : { id: task.id, done: !task.done }}
              accessibilityLabel={`${task.done ? 'Przywróć' : 'Ukończ'}: ${task.title}`}
              style={{ width: 'match_parent', flexDirection: 'row', alignItems: 'center', paddingVertical: 6 }}
            >
              <TextWidget text={task.done ? '☑' : '☐'} style={{ fontSize: 18, color: task.done ? palette.muted : palette.accent, marginRight: 8 }} />
              <FlexWidget style={{ flex: 1 }}>
                <TextWidget
                  text={task.title}
                  maxLines={1}
                  truncate="END"
                  style={{ fontSize: 14, color: task.done ? palette.muted : task.overdue ? palette.danger : palette.fg }}
                />
              </FlexWidget>
              {task.time ? <TextWidget text={task.time} style={{ fontSize: 12, color: palette.muted, marginLeft: 6 }} /> : null}
            </FlexWidget>
          )),
          ...(model.more > 0
            ? [
                <FlexWidget key="more" clickAction="OPEN_URI" clickActionData={{ uri: APP_URI.today }} style={{ width: 'match_parent', paddingVertical: 6 }}>
                  <TextWidget text={`+${model.more} więcej w aplikacji`} style={{ fontSize: 13, color: palette.accent }} />
                </FlexWidget>,
              ]
            : []),
        ]}
      </ListWidget>
    </FlexWidget>
  );
}

export const todayWidget = (model: TodayWidgetModel | null, updatedAt: string, error?: string) =>
  themed((palette) => <TodayWidgetView model={model ?? EMPTY} palette={palette} updatedAt={updatedAt} error={error} />);
