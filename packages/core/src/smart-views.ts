/**
 * Widoki zbiorcze (Inbox, Dziś, Zaległe, Nadchodzące) z opcjami widoku listy: „Lista | Tablica” i kolumny.
 * Ustawienia są w profilu (`settings.views`, synchronizowane); tablica pokazuje te same zadania co lista widoku.
 */
import type { BoardOptions } from './kanban.ts';
import { VIEW_SECTION } from './labels.ts';
import type { ProfileSettings, SmartViewPrefs } from './schemas/model.ts';
import type { LocalDate } from './schemas/primitives.ts';
import { isOpen, selectInbox, selectOverdue, selectToday, selectUpcoming, type ViewContext, type ViewTask } from './views.ts';

export type SmartView = 'inbox' | 'today' | 'overdue' | 'upcoming';

export const SMART_VIEW: Record<SmartView, string> = { inbox: 'Inbox', today: VIEW_SECTION.today, overdue: VIEW_SECTION.overdue, upcoming: 'Nadchodzące' };

/** Ile dni „Nadchodzące” pokazuje osobno (lista i tablica). */
export const UPCOMING_DAYS = 14;

/** Klucz ustawień w `settings.views`: widok zbiorczy albo wszystkie widoki tagu / zapisanego filtra (tylko kolumny). */
export type ViewSettingsKey = keyof ProfileSettings['views'];

/** `settings.views` po zmianie jednego widoku; puste listy i `undefined` znikają z zapisu. */
export function smartViewsPatch(views: ProfileSettings['views'], view: ViewSettingsKey, patch: Partial<SmartViewPrefs>): ProfileSettings['views'] {
  const next = Object.entries({ ...views[view], ...patch }).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length));
  return { ...views, [view]: Object.fromEntries(next) };
}

export interface SmartBoard {
  tasks: ViewTask[];
  options: BoardOptions;
  /** Opis kolumny „Gotowe”; `null` = widok nie trzyma ukończonych (odhaczone znika z tablicy). */
  doneNote: string | null;
  /** Termin nowej karty (`null` = bez terminu); `undefined` = na tej tablicy się nie dodaje. */
  addDue: LocalDate | null | undefined;
}

/** Opcje kolumn są stałe — aplikacje mają je w zależnościach `useMemo`. */
const INBOX: BoardOptions = {};
const DATED: BoardOptions = { subtasks: true, outside: true };

/**
 * Zadania i opcje tablicy widoku. Inbox — jak tablica listy: główne zadania, „Gotowe” z 7 dni; pozostałe
 * wybiera termin, więc karty mają też podzadania, a dni spoza kolumn stoją w „Wcześniej” / „Później”.
 * `now` — zegar ścienny (`selectOverdue`). Wirtualne wystąpienia serii nie mają kart.
 */
export function smartBoard(view: SmartView, tasks: readonly ViewTask[], ctx: ViewContext, { inboxIds, now }: { inboxIds: ReadonlySet<string>; now: string }): SmartBoard {
  if (view === 'inbox') {
    const closed = tasks.filter((t) => t.kind === 'task' && !isOpen(t) && inboxIds.has(t.listId) && (!ctx.workspaceId || t.workspaceId === ctx.workspaceId));
    return { tasks: [...selectInbox(tasks, inboxIds, ctx), ...closed], options: INBOX, doneNote: '„Gotowe” z ostatnich 7 dni', addDue: null };
  }
  if (view === 'today') {
    const { overdue, today, ongoing, done } = selectToday(tasks, ctx);
    return { tasks: [...overdue, ...today, ...ongoing, ...done], options: DATED, doneNote: '„Gotowe” — ukończone dziś', addDue: ctx.today };
  }
  if (view === 'overdue') {
    const { today, earlier } = selectOverdue(tasks, ctx, now);
    return { tasks: [...today, ...earlier], options: DATED, doneNote: null, addDue: undefined };
  }
  const { days, later } = selectUpcoming(tasks, ctx, { days: UPCOMING_DAYS });
  const items = [...days, ...later].flatMap((d) => d.items).filter((i) => !i.virtual);
  return { tasks: items.map((i) => i.task), options: { ...DATED, days: { from: ctx.today, count: UPCOMING_DAYS } }, doneNote: null, addDue: ctx.today };
}
