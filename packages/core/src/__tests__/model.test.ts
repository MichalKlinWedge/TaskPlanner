/**
 * Schematy modelu (§5): ograniczenia jak w migracji, reguły między polami, domyślne ustawienia.
 */
import { describe, expect, it } from 'vitest';

import { AttachmentRow, ListRow, ProfileSettings, ReminderRow, TaskDependencyRow, TaskRow, TaskSource, TimeEntryRow, TimeZone, ViewPrefs } from '../schemas/model.ts';

const ID = '0190a000-0000-7000-8000-000000000001';
const ID2 = '0190a000-0000-7000-8000-000000000002';

const task = {
  id: ID,
  list_id: ID2,
  parent_id: null,
  kind: 'task',
  title: 'Zadzwonić do hydraulika',
  description_md: null,
  status: 'todo',
  priority: 2,
  start_date: null,
  due_date: '2026-11-19',
  due_time: '09:30',
  duration_min: 15,
  time_zone: null,
  recurrence: null,
  habit: null,
  completed_at: null,
  sort_key: '0010',
  board_sort_key: null,
  source: { kind: 'quick_add', text: 'Zadzwonić do hydraulika jutro 9:30 ~15m !2' },
  postpone_count: 0,
  assignee_id: null,
  board_column_id: null,
  canvas_pos: null,
  derived_from: null,
} as const;

const issues = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.success ? [] : result.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

describe('zadanie', () => {
  it('poprawny wiersz przechodzi', () => {
    expect(TaskRow.parse(task)).toEqual(task);
  });

  it('ograniczenia kolumn jak w migracji', () => {
    expect(TaskRow.safeParse({ ...task, title: '   ' }).success).toBe(false);
    expect(TaskRow.safeParse({ ...task, priority: 5 }).success).toBe(false);
    expect(TaskRow.safeParse({ ...task, due_time: '24:00' }).success).toBe(false);
    expect(TaskRow.safeParse({ ...task, duration_min: 10_081 }).success).toBe(false);
    expect(TaskRow.safeParse({ ...task, sort_key: 'A1' }).success).toBe(false);
    expect(TaskRow.safeParse({ ...task, time_zone: 'Europe/Warszawa' }).success).toBe(false);
    expect(TaskRow.safeParse({ ...task, time_zone: 'Europe/Warsaw' }).success).toBe(true);
    expect(TaskRow.safeParse({ ...task, derived_from: [ID] }).success).toBe(true);
    expect(TaskRow.safeParse({ ...task, derived_from: [] }).success).toBe(false);
    expect(TaskRow.safeParse({ ...task, derived_from: ['x'] }).success).toBe(false);
  });

  it('reguły między polami', () => {
    expect(issues(TaskRow.safeParse({ ...task, due_date: null }))).toEqual(['due_date: Godzina i początek wymagają terminu.']);
    expect(issues(TaskRow.safeParse({ ...task, start_date: '2026-11-20' }))).toEqual(['start_date: Początek po terminie.']);
    expect(issues(TaskRow.safeParse({ ...task, kind: 'habit' }))).toEqual(['recurrence: Nawyk wymaga reguły według harmonogramu.']);
    expect(issues(TaskRow.safeParse({ ...task, parent_id: ID }))).toEqual(['parent_id: Zadanie nie może być własnym podzadaniem.']);
    expect(
      TaskRow.safeParse({ ...task, kind: 'habit', recurrence: { mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-11-01' }, habit: { target: 8, unit: 'szklanek' } }).success,
    ).toBe(true);
  });

  it('źródło zadania', () => {
    expect(TaskSource.safeParse({ kind: 'link', url: 'https://example.com', title: 'Strona' }).success).toBe(true);
    expect(TaskSource.safeParse({ kind: 'link', url: 'nie-url' }).success).toBe(false);
    expect(TaskSource.safeParse({ kind: 'telepatia' }).success).toBe(false);
  });
});

describe('lista', () => {
  const list = { id: ID, scope_id: ID2, kind: 'project', name: 'Remont', color: '#2563eb', icon: null, description_md: null, start_date: '2026-11-01', end_date: '2026-12-31', project_status: 'active', sort_key: '0010', view_prefs: {}, archived_at: null, board_columns: null, canvas_groups: null } as const;
  it('projekt z datami; zwykła lista bez dat i statusu', () => {
    expect(ListRow.safeParse(list).success).toBe(true);
    expect(issues(ListRow.safeParse({ ...list, end_date: '2026-10-01' }))).toEqual(['end_date: Koniec projektu przed początkiem.']);
    expect(issues(ListRow.safeParse({ ...list, kind: 'list' }))).toEqual(['kind: Daty i status mają tylko projekty.']);
    expect(ListRow.safeParse({ ...list, color: 'blue' }).success).toBe(false);
  });
  it('ustawienia widoku', () => {
    expect(ViewPrefs.parse({ view: 'kanban', groupBy: 'priority', sortBy: 'due', completed: 'today' })).toBeTruthy();
    expect(ViewPrefs.safeParse({ groupBy: 'kolor' }).success).toBe(false);
  });
  it('zapamiętany filtr listy; uszkodzony nie kasuje reszty ustawień', () => {
    const filter = { priorities: [1 as const], due: { kind: 'any' as const } };
    expect(ViewPrefs.parse({ completed: 'hidden', filter })).toEqual({ completed: 'hidden', filter });
    expect(ViewPrefs.parse({ completed: 'hidden', filter: { priorities: [] } })).toEqual({ completed: 'hidden' });
  });
  it('kolumny listy; nieznana kolumna nie kasuje reszty ustawień', () => {
    expect(ViewPrefs.parse({ columns: ['description', 'due'] })).toEqual({ columns: ['description', 'due'] });
    // Dawna kolumna „Odpowiedzialny” i nieznane z nowszej wersji odpadają po jednej.
    expect(ViewPrefs.parse({ columns: ['assignee', 'due', 'kolor'] })).toEqual({ columns: ['due'] });
    expect(ViewPrefs.parse({ sortBy: 'due', columns: ['kolor'] }).columns).toBeUndefined();
    expect(ViewPrefs.parse({ sortBy: 'due', columns: 'due' })).toEqual({ sortBy: 'due' });
    expect(ViewPrefs.parse({ columns: ['start', 'due', 'duration', 'description', 'attachments', 'tags'] }).columns).toHaveLength(6);
    const tag = '01900000-0000-7000-8000-000000000001';
    expect(ViewPrefs.parse({ columns: ['tags'], columnTags: [tag] })).toEqual({ columns: ['tags'], columnTags: [tag] });
    expect(ViewPrefs.parse({ sortBy: 'due', columnTags: ['x'] })).toEqual({ sortBy: 'due' });
    expect(ViewPrefs.parse({ view: 'canvas', canvasTasks: 'all' })).toEqual({ view: 'canvas', canvasTasks: 'all' });
    expect(ViewPrefs.parse({ view: 'canvas', canvasTasks: 'kolor' })).toEqual({ view: 'canvas' });
  });
});

describe('pozostałe tabele', () => {
  it('przypomnienia: względne z wyprzedzeniem, bezwzględne z datą i godziną', () => {
    const base = { id: ID, task_id: ID2, offset_min: null, at_date: null, at_time: null };
    expect(ReminderRow.safeParse({ ...base, kind: 'relative', offset_min: 30 }).success).toBe(true);
    expect(ReminderRow.safeParse({ ...base, kind: 'relative' }).success).toBe(false);
    expect(ReminderRow.safeParse({ ...base, kind: 'absolute', at_date: '2026-11-20', at_time: '08:00' }).success).toBe(true);
    expect(ReminderRow.safeParse({ ...base, kind: 'absolute', at_date: '2026-11-20' }).success).toBe(false);
  });

  it('zależność od siebie, wpis czasu wstecz, załącznik bez ścieżki / adresu, limit 25 MB', () => {
    expect(TaskDependencyRow.safeParse({ id: ID, predecessor_id: ID2, successor_id: ID2, kind: 'finish_to_start', lag_days: 0 }).success).toBe(false);
    expect(TimeEntryRow.safeParse({ id: ID, task_id: ID2, kind: 'focus', started_at: '2026-11-18T10:00:00Z', ended_at: '2026-11-18T09:00:00Z', pomodoro_index: 1 }).success).toBe(false);
    expect(TimeEntryRow.safeParse({ id: ID, task_id: null, kind: 'focus', started_at: '2026-11-18T10:00:00+01:00', ended_at: null, pomodoro_index: null }).success).toBe(true);
    const file = { id: ID, task_id: ID2, kind: 'file', storage_path: `${ID}/${ID2}/a.pdf`, name: 'a.pdf', mime: 'application/pdf', size_bytes: 1000, url: null, preview: null } as const;
    expect(AttachmentRow.safeParse(file).success).toBe(true);
    expect(AttachmentRow.safeParse({ ...file, storage_path: null }).success).toBe(false);
    expect(AttachmentRow.safeParse({ ...file, size_bytes: 26 * 1024 * 1024 }).success).toBe(false);
  });
});

describe('ustawienia profilu', () => {
  it('pusty obiekt → komplet domyślnych', () => {
    expect(ProfileSettings.parse({})).toEqual({
      firstDayOfWeek: 1,
      workHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
      defaultReminderTime: '09:00',
      defaultDurationMin: 30,
      focus: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longBreakEvery: 4, enabled: true },
      dailyReview: { enabled: false, time: '20:00' },
      weeklyReview: { enabled: false, weekday: 7, time: '18:00' },
      theme: 'system',
      taskPanel: { collapsed: {} },
      timeline: { collapsed: [] },
      views: {},
      notifications: { tasks: 'app', sharing: 'app', system: 'app', reminders: 'app', toast: true, autoReminder: 'shared', autoReminderOffset: 0, follow: { created: false, participating: false }, muted: [], quiet: { enabled: false, from: '22:00', to: '07:00' } },
      onboarded: false,
    });
  });
  it('stan sekcji panelu zadania zostaje w ustawieniach', () => {
    expect(ProfileSettings.parse({ taskPanel: { collapsed: { history: false, opis: true } } }).taskPanel.collapsed).toEqual({ history: false, opis: true });
  });
  it('zwinięte projekty osi czasu zostają w ustawieniach', () => {
    expect(ProfileSettings.parse({ timeline: { collapsed: ['L1', 'L2'] } }).timeline.collapsed).toEqual(['L1', 'L2']);
  });
  it('częściowe ustawienia uzupełnia, błędne odrzuca', () => {
    expect(ProfileSettings.parse({ focus: { focusMin: 50 }, workHours: { start: '08:00' } }).focus.shortBreakMin).toBe(5);
    expect(ProfileSettings.safeParse({ workHours: { start: '18:00', end: '08:00' } }).success).toBe(false);
    expect(ProfileSettings.safeParse({ firstDayOfWeek: 0 }).success).toBe(false);
    expect(TimeZone.safeParse('America/New_York').success).toBe(true);
  });
});
