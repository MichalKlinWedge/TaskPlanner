/**
 * Zadania do zaplanowania w kalendarzu (panel „Zadania bez godziny” na webie, „Zaplanuj…” na
 * telefonie): otwarte zadania bez godziny z wybranego źródła — „Dziś i zaległe”, wybrany dzień,
 * Inbox, „Bez terminu” albo zapisany filtr — i szukanie po tytule (bez ogonków, każde słowo).
 */
import type { LocalDate } from './schemas/primitives.ts';
import { normalizeText } from './search.ts';
import { applyFilter, isOpen, selectInbox, selectToday, type FilterQuery, type ViewContext, type ViewTask } from './views.ts';

/** `day` — zadania z terminem w oglądanym dniu; `filter:<id>` — zapisany filtr. */
export type CalendarPanelSource = 'today' | 'day' | 'inbox' | 'none' | `filter:${string}`;

export const CALENDAR_PANEL_SOURCE: Record<'today' | 'day' | 'inbox' | 'none', string> = {
  today: 'Dziś i zaległe',
  day: 'Ten dzień',
  inbox: 'Inbox',
  none: 'Bez terminu',
};

export interface CalendarPanelData {
  tasks: readonly ViewTask[];
  /** Id list Inbox (wszystkich przestrzeni — zawęża `ctx.workspaceId`). */
  inboxListIds: ReadonlySet<string>;
  savedFilters: readonly { id: string; query: FilterQuery }[];
}

const byPriority = (a: ViewTask, b: ViewTask) => a.priority - b.priority || (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1);

/**
 * Otwarte zadania (nie nawyki) bez godziny ze źródła, w przestrzeni `ctx.workspaceId`. `date` —
 * oglądany dzień dla źródła `day` (domyślnie `ctx.today`). Nieznany zapisany filtr → pusto.
 */
export function calendarPanelTasks(source: CalendarPanelSource, data: CalendarPanelData, ctx: ViewContext, date: LocalDate = ctx.today): ViewTask[] {
  const inSpace = (t: ViewTask) => !ctx.workspaceId || t.workspaceId === ctx.workspaceId;
  const noTime = (t: ViewTask) => t.kind === 'task' && isOpen(t) && !t.dueTime && inSpace(t);
  if (source === 'today') {
    const view = selectToday(data.tasks, ctx, { completed: 'hidden' });
    return [...view.overdue, ...view.today].filter(noTime);
  }
  if (source === 'day') return data.tasks.filter((t) => noTime(t) && t.dueDate === date).sort(byPriority);
  if (source === 'inbox') return selectInbox(data.tasks, data.inboxListIds, ctx).filter(noTime);
  if (source === 'none') return data.tasks.filter((t) => noTime(t) && !t.dueDate).sort(byPriority);
  const filter = data.savedFilters.find((f) => `filter:${f.id}` === source);
  return filter ? applyFilter(data.tasks, filter.query, ctx.today).filter(noTime) : [];
}

/** Szukanie w tytułach: każde słowo zapytania występuje w tytule (małe litery, bez ogonków); puste → wszystko. */
export function searchTaskTitles<T extends Pick<ViewTask, 'title'>>(tasks: readonly T[], query: string): T[] {
  const words = normalizeText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...tasks];
  return tasks.filter((t) => {
    const title = normalizeText(t.title);
    return words.every((w) => title.includes(w));
  });
}
