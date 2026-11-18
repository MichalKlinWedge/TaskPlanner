'use no memo';
// Widżet to drzewo zwykłych funkcji wywoływanych poza Reactem — React Compiler nie może ich
// przerabiać (dodałby hooki pamięci podręcznej → „Invalid hook call”).
import { FlexWidget, ListWidget, TextWidget } from 'react-native-android-widget';

export const TODAY_WIDGET = 'Today';
export const TOGGLE_ACTION = 'TOGGLE_TASK';

export interface WidgetTask {
  id: string;
  title: string;
  done: boolean;
  time: string | null;
  overdue: boolean;
}

interface Palette {
  bg: `#${string}`;
  fg: `#${string}`;
  muted: `#${string}`;
  accent: `#${string}`;
  danger: `#${string}`;
}

const LIGHT: Palette = { bg: '#ffffff', fg: '#18181b', muted: '#71717a', accent: '#2563eb', danger: '#dc2626' };
const DARK: Palette = { bg: '#18181b', fg: '#fafafa', muted: '#a1a1aa', accent: '#60a5fa', danger: '#f87171' };

function TodayWidgetView({ tasks, palette, updatedAt, error }: { tasks: WidgetTask[]; palette: Palette; updatedAt: string; error?: string }) {
  const open = tasks.filter((t) => !t.done).length;
  return (
    <FlexWidget style={{ height: 'match_parent', width: 'match_parent', backgroundColor: palette.bg, borderRadius: 16, padding: 12, flexDirection: 'column' }}>
      <FlexWidget clickAction="OPEN_APP" style={{ width: 'match_parent', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
        <TextWidget text={`Dziś · ${open}`} style={{ fontSize: 16, fontWeight: '600', color: palette.fg }} />
        <TextWidget text={updatedAt} style={{ fontSize: 11, color: palette.muted }} />
      </FlexWidget>
      {error ? <TextWidget text={error} style={{ fontSize: 12, color: palette.danger }} maxLines={3} /> : null}
      {tasks.length === 0 && !error ? <TextWidget text="Nic na dziś." style={{ fontSize: 13, color: palette.muted }} /> : null}
      <ListWidget style={{ height: 'match_parent', width: 'match_parent' }}>
        {tasks.map((task) => (
          <FlexWidget
            key={task.id}
            clickAction={TOGGLE_ACTION}
            clickActionData={{ id: task.id }}
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
        ))}
      </ListWidget>
    </FlexWidget>
  );
}

export function todayWidget(tasks: WidgetTask[], updatedAt: string, error?: string) {
  return {
    light: <TodayWidgetView tasks={tasks} palette={LIGHT} updatedAt={updatedAt} error={error} />,
    dark: <TodayWidgetView tasks={tasks} palette={DARK} updatedAt={updatedAt} error={error} />,
  };
}
