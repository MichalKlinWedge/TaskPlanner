/**
 * Kalendarz na telefonie (Etap 5, M11; D16 — własna oś dnia, bez calendar-kit): dzień / tydzień (agenda)
 * / miesiąc nad `core/time-blocking.ts`, jak `#/calendar` na webie. Dzień: wiersz „cały dzień”,
 * konflikty, oś z przeciąganiem bloków zadań (przytrzymanie → przesunięcie, uchwyt → długość),
 * „Zaplanuj…” dla zadań bez godziny (arkusz ze źródłem i szukaniem — core `calendarPanelTasks`; `scheduleBlockPatch`),
 * cień poza godzinami pracy (`workWindow`), licznik nakładających się bloków w tygodniu i miesiącu, menu bloku i pozycji „cały dzień” (otwórz, godzina,
 * inny dzień, czas trwania, „Bez godziny” — `unscheduleBlockPatch`), „+” = nowe zadanie na oglądany dzień, dotknięcie pustego miejsca osi = nowe zadanie na tę godzinę. Tydzień: `calendarEntries` → `agendaDays`. Miesiąc: `monthWeeks`
 * z liczbą pozycji, dotknięcie dnia → agenda dnia. Wydarzenia: kalendarze połączone na serwerze
 * i wybrane kalendarze telefonu (`lib/calendar-events.ts`). Wszystkie zmiany z „Cofnij”. Chipy filtra
 * zawężają zadania we wszystkich widokach (wydarzenia i nawyki zostają); bez terminu i godziny, bo o nich
 * decyduje kalendarz; filtr trwa do opuszczenia ekranu, nie jest zapisywany.
 * Wysokość wiersza osi dnia (15 min / 30 min / 1 h) przełącza się przy filtrze. „Pokaż” (`lib/calendar-sources.ts`)
 * ukrywa listy i kalendarze zewnętrzne: ich pozycji nie ma w widoku ani w konfliktach, wolnych oknach
 * i „Zaplanuj…”. Listy dnia w tygodniu
 * i miesiącu są stronicowane (`EntryList`): przy 10 000 zadań dzień ma ~100 pozycji (`docs/WYDAJNOSC.md`).
 */
import {
  addDays,
  addMonths,
  agendaDays,
  applyFilter,
  blockLanes,
  CALENDAR_PANEL_SOURCE,
  CALENDAR_SLOTS,
  calendarEntries,
  calendarPanelTasks,
  capitalized,
  clickedTime,
  datesPatch,
  dayLabel,
  formatMinutes,
  habitSlots,
  isEmptyFilter,
  isOpen,
  isoWeekday,
  localDateTimeAt,
  minutesToTime,
  monthLabel,
  monthWeeks,
  parseCalendarSlot,
  plural,
  PRIORITY,
  projectFilterLabel,
  relativeDay,
  resizeBlockPatch,
  scheduleBlockPatch,
  searchTaskTitles,
  shortDate,
  unscheduleBlockPatch,
  weekStart,
  WEEKDAY,
  workWindow,
  type Block,
  type CalendarEntry,
  type CalendarPanelSource,
  type CalendarSlot,
  type FilterQuery,
  type IsoWeekday,
  type LocalDate,
  type LocalTime,
  type TaskOp,
  type ViewTask,
} from '@taskplanner/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTaskActions } from '@/components/actions';
import { DayTimeline, MIN_BLOCK } from '@/components/day-timeline';
import { FilterBar, type FilterField } from '@/components/filter-bar';
import { WorkspaceSwitcher } from '@/components/header';
import { pickAmount, pickDate, pickMany, pickOption, pickTime, Sheet, type Option } from '@/components/pickers';
import { Fab, openQuickAdd } from '@/components/task-list';
import { Chip, usePalette } from '@/components/ui';
import { listEditable, useView, type AppData } from '@/lib/app-data';
import { useCalendarHidden, useExternalCalendars, type CalendarHidden } from '@/lib/calendar-sources';
import { deviceCalendars, setDeviceCalendarIds, useCalendarEvents, useDeviceCalendarIds, type EventInfo } from '@/lib/calendar-events';
import { useDayPlan, useNowMinute } from '@/lib/day-plan';
import { perfMeasure, usePerfReady } from '@/lib/perf';

type Mode = 'day' | 'week' | 'month';
const MODE_KEY = 'calendar.mode';
const MODES: { mode: Mode; label: string }[] = [
  { mode: 'day', label: 'Dzień' },
  { mode: 'week', label: 'Tydzień' },
  { mode: 'month', label: 'Miesiąc' },
];
/** Wysokość wiersza osi dnia w minutach (jak na webie, per urządzenie) → pikseli na godzinę. */
const SLOT_KEY = 'calendar.slot';
const HOUR: Record<CalendarSlot, number> = { 15: 112, 30: 56, 60: 36 };
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const HABIT_COLOR = '#059669';
/** Termin i godzinę ustala kalendarz — te warunki filtra nic tu nie zmieniają. */
const HIDDEN: FilterField[] = ['due', 'hasTime'];

const datesBefore = (t: ViewTask): Record<string, unknown> => ({ start_date: t.startDate, due_date: t.dueDate, due_time: t.dueTime, duration_min: t.durationMin });
const pick = (all: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, all[k] ?? null]));
const toMin = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export default function CalendarScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ date?: string; mode?: string }>();
  const { data: all, today, workspaceId } = useView();
  usePerfReady('/calendar', all.loaded);
  const [filter, setFilter] = useState<FilterQuery>({});
  const [hidden, setHidden] = useCalendarHidden();
  const externalCalendars = useExternalCalendars();
  const data = useMemo((): AppData => {
    const visible = hidden.lists.size ? all.tasks.filter((t) => !(t.listId && hidden.lists.has(t.listId))) : all.tasks;
    if (isEmptyFilter(filter)) return visible === all.tasks ? all : { ...all, tasks: visible };
    const shown = new Set(applyFilter(visible, filter, today).map((t) => t.id));
    return { ...all, tasks: visible.filter((t) => t.kind === 'habit' || shown.has(t.id)) };
  }, [all, filter, today, hidden.lists]);
  const { notify } = useTaskActions();
  const [mode, setModeState] = useState<Mode>(() => (params.mode as Mode | undefined) ?? (Storage.getItemSync(MODE_KEY) as Mode | null) ?? 'day');
  const [date, setDate] = useState<LocalDate>(() => (/^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '') ? (params.date as LocalDate) : today));
  const [slot, setSlotState] = useState<CalendarSlot>(() => parseCalendarSlot(Storage.getItemSync(SLOT_KEY)));
  const deviceIds = useDeviceCalendarIds();
  const firstDay = data.settings.firstDayOfWeek;

  const setMode = (next: Mode) => {
    Storage.setItemSync(MODE_KEY, next);
    setModeState(next);
  };
  const setSlot = (next: CalendarSlot) => {
    Storage.setItemSync(SLOT_KEY, String(next));
    setSlotState(next);
  };
  const openDay = (day: LocalDate) => {
    setDate(day);
    setMode('day');
  };
  const shift = (dir: 1 | -1) => setDate((d) => (mode === 'day' ? addDays(d, dir) : mode === 'week' ? addDays(d, 7 * dir) : addMonths(d, dir)));
  const weekFrom = weekStart(date, firstDay);
  // „+” dodaje na oglądany dzień; w tygodniu — dziś, gdy jest widoczny, inaczej jego pierwszy dzień.
  const addDate = mode !== 'week' ? date : today >= weekFrom && today < addDays(weekFrom, 7) ? today : weekFrom;
  const title = mode === 'day' ? capitalized(dayLabel(date)) : mode === 'week' ? `${shortDate(weekFrom)} – ${shortDate(addDays(weekFrom, 6))}` : capitalized(monthLabel(date));

  // „Pokaż”: listy bieżącej przestrzeni (albo wszystkich) i kalendarze zewnętrzne; zaznaczone = widoczne.
  const sources = useMemo(() => {
    const lists = all.workspaces
      .filter((w) => !workspaceId || w.id === workspaceId)
      .flatMap((w) =>
        all.lists
          .filter((l) => l.workspaceId === w.id)
          .sort((a, b) => Number(b.kind === 'inbox') - Number(a.kind === 'inbox') || (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
          .map((l) => ({ id: l.id, name: l.kind === 'inbox' ? 'Inbox' : l.name, hint: w.name, list: true })),
      );
    return [...lists, ...externalCalendars.map((c) => ({ id: c.id, name: c.name, hint: 'Kalendarz zewnętrzny', list: false }))];
  }, [all.workspaces, all.lists, workspaceId, externalCalendars]);
  const sourcesLabel = projectFilterLabel(sources, new Set([...hidden.lists, ...hidden.calendars]));
  const chooseSources = async () => {
    const shown = await pickMany(
      'Pokaż w kalendarzu',
      sources.map((s) => ({ label: s.name, hint: s.hint, value: s.id, selected: !(s.list ? hidden.lists : hidden.calendars).has(s.id) })),
    );
    if (!shown) return;
    const visible = new Set(shown);
    // Ukryte spoza tej listy (inna przestrzeń) zostają ukryte.
    const next = (kind: boolean, before: ReadonlySet<string>) => {
      const out = new Set([...before].filter((id) => !sources.some((s) => s.id === id)));
      for (const s of sources) if (s.list === kind && !visible.has(s.id)) out.add(s.id);
      return out;
    };
    setHidden({ lists: next(true, hidden.lists), calendars: next(false, hidden.calendars) } satisfies CalendarHidden);
  };

  const chooseCalendars = async () => {
    const calendars = await deviceCalendars().catch(() => null);
    if (!calendars) return notify('Bez zgody na kalendarz telefonu — włącz ją w ustawieniach aplikacji.');
    if (!calendars.length) return notify('W telefonie nie ma kalendarzy.');
    const chosen = await pickMany(
      'Kalendarze telefonu',
      calendars.map((c) => ({ label: c.title, hint: c.account || undefined, value: c.id, selected: deviceIds.includes(c.id) })),
    );
    if (chosen) setDeviceCalendarIds(chosen);
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <Stack.Screen
        options={{
          title: 'Kalendarz',
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <WorkspaceSwitcher />
              <Pressable accessibilityRole="button" accessibilityLabel="Kalendarze telefonu" hitSlop={10} onPress={() => void chooseCalendars()}>
                <Text style={{ color: p.accent, fontSize: 14 }}>📱 {deviceIds.length || ''}</Text>
              </Pressable>
            </View>
          ),
        }}
      />
      <View style={[styles.bar, { borderColor: p.border, backgroundColor: p.card }]}>
        <View style={styles.row}>
          <Pressable accessibilityRole="button" accessibilityLabel="Wstecz" hitSlop={10} onPress={() => shift(-1)} style={styles.arrow}>
            <Text style={{ color: p.fg, fontSize: 20 }}>‹</Text>
          </Pressable>
          <Text style={{ color: p.fg, fontSize: 15, fontWeight: '600', flex: 1, textAlign: 'center' }} numberOfLines={1}>
            {title}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Dalej" hitSlop={10} onPress={() => shift(1)} style={styles.arrow}>
            <Text style={{ color: p.fg, fontSize: 20 }}>›</Text>
          </Pressable>
        </View>
        <View style={styles.row}>
          {MODES.map((m) => (
            <Chip key={m.mode} label={m.label} selected={mode === m.mode} onPress={() => setMode(m.mode)} />
          ))}
          <View style={{ flex: 1 }} />
          <Chip label="Dziś" selected={date === today} onPress={() => setDate(today)} />
        </View>
        <View style={styles.filters}>
          {/* Z warunkami filtra chipy wiersza schodzą pod nie. */}
          <View style={isEmptyFilter(filter) ? { flex: 1 } : { width: '100%' }}>
            <FilterBar query={filter} onChange={setFilter} hide={HIDDEN} />
          </View>
          <Chip label={`Pokaż: ${sourcesLabel}`} selected={sourcesLabel !== 'wszystkie'} onPress={() => void chooseSources()} />
          {mode === 'day' ? (
            <View style={styles.row} accessibilityLabel="Wysokość wiersza">
              {CALENDAR_SLOTS.map((s) => (
                <Chip key={s} label={formatMinutes(s)} selected={slot === s} onPress={() => setSlot(s)} />
              ))}
            </View>
          ) : null}
        </View>
      </View>
      {mode === 'day' ? (
        <DayView key={date} slot={slot} hiddenCalendars={hidden.calendars} data={data} date={date} today={today} workspaceId={workspaceId} bottom={insets.bottom} />
      ) : mode === 'week' ? (
        <RangeAgenda hiddenCalendars={hidden.calendars} data={data} from={weekFrom} to={addDays(weekFrom, 7)} today={today} workspaceId={workspaceId} onDay={openDay} bottom={insets.bottom} />
      ) : (
        <MonthView hiddenCalendars={hidden.calendars} data={data} date={date} today={today} workspaceId={workspaceId} onSelect={setDate} onDay={openDay} bottom={insets.bottom} />
      )}
      <Fab label={`Dodaj zadanie: ${dayLabel(addDate)}`} bottom={insets.bottom + 16} onPress={() => openQuickAdd({ dueDate: addDate })} />
    </View>
  );
}

/** Zapis terminu / godziny / długości z „Cofnij” (jak `schedule` w kalendarzu na webie). */
function useSchedule() {
  const { run } = useTaskActions();
  return (task: ViewTask, patch: Record<string, unknown>, text: string) => {
    const before = datesBefore(task);
    if (!Object.keys(patch).length || Object.entries(patch).every(([k, v]) => before[k] === v)) return;
    const ops: TaskOp[] = [{ table: 'tasks', id: task.id, patch }];
    void run(ops, { text: `„${task.title}” ${text}`, undo: [{ table: 'tasks', id: task.id, patch: pick(before, Object.keys(patch)) }] });
  };
}

/** Ile pozycji arkusza „Zaplanuj…” naraz; reszta po „Pokaż więcej” (bez cichego limitu). */
const PLAN_PAGE = 50;

/**
 * Arkusz „Zaplanuj…”: otwarte zadania bez godziny ze źródła (core `calendarPanelTasks` — dziś i zaległe,
 * oglądany dzień, Inbox, bez terminu, zapisane filtry) i szukanie w tytułach; wybór → godzina.
 */
function ScheduleSheet({ data, date, today, workspaceId, onPick, onClose }: { data: AppData; date: LocalDate; today: LocalDate; workspaceId: string | null; onPick: (task: ViewTask) => void; onClose: () => void }) {
  const p = usePalette();
  const [source, setSource] = useState<CalendarPanelSource>(date === today ? 'today' : 'day');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PLAN_PAGE);
  const { timeZone, firstDayOfWeek } = data.settings;
  const sources = useMemo((): { value: CalendarPanelSource; label: string }[] => [
    { value: 'today', label: CALENDAR_PANEL_SOURCE.today },
    ...(date !== today ? [{ value: 'day' as const, label: capitalized(relativeDay(date, today)) }] : []),
    { value: 'inbox', label: CALENDAR_PANEL_SOURCE.inbox },
    { value: 'none', label: CALENDAR_PANEL_SOURCE.none },
    ...data.savedFilters.map((f) => ({ value: `filter:${f.id}` as const, label: `${f.icon ? `${f.icon} ` : ''}${f.name}` })),
  ], [date, today, data.savedFilters]);
  const candidates = useMemo(() => {
    const inboxListIds = new Set(data.lists.filter((l) => l.kind === 'inbox').map((l) => l.id));
    const list = calendarPanelTasks(source, { tasks: data.tasks, inboxListIds, savedFilters: data.savedFilters }, { today, timeZone, workspaceId, firstDayOfWeek }, date);
    return searchTaskTitles(list, query);
  }, [source, data.tasks, data.lists, data.savedFilters, today, timeZone, workspaceId, firstDayOfWeek, date, query]);
  const choose = (next: CalendarPanelSource) => {
    setSource(next);
    setShown(PLAN_PAGE);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Sheet title={`Zaplanuj zadanie — ${relativeDay(date, today)}`} onClose={onClose}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sources} accessibilityLabel="Źródło zadań">
          {sources.map((s) => (
            <Chip key={s.value} label={s.label} selected={source === s.value} onPress={() => choose(s.value)} />
          ))}
        </ScrollView>
        <TextInput
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            setShown(PLAN_PAGE);
          }}
          placeholder="Szukaj w tytułach"
          placeholderTextColor={p.muted}
          accessibilityLabel="Szukaj zadania"
          autoCorrect={false}
          returnKeyType="search"
          style={[styles.search, { color: p.fg, borderColor: p.border }]}
        />
        <Text style={{ color: p.muted, fontSize: 12, marginBottom: 4 }}>{plural(candidates.length, ['zadanie bez godziny', 'zadania bez godziny', 'zadań bez godziny'])}</Text>
        {candidates.slice(0, shown).map((t) => (
          <Pressable
            key={t.id}
            accessibilityRole="button"
            onPress={() => onPick(t)}
            style={({ pressed }) => [styles.candidate, { borderColor: p.border, borderLeftColor: PRIORITY[t.priority]?.color ?? p.border, backgroundColor: pressed ? p.border : 'transparent' }]}
          >
            <Text style={{ color: p.fg, fontSize: 15 }} numberOfLines={2}>
              {t.title}
            </Text>
            <Text style={{ color: p.muted, fontSize: 12 }}>
              {t.dueDate ? relativeDay(t.dueDate, today) : 'bez terminu'}
              {t.durationMin ? ` · ${formatMinutes(t.durationMin)}` : ''}
            </Text>
          </Pressable>
        ))}
        {!candidates.length ? <Text style={{ color: p.muted, fontSize: 13, paddingVertical: 8 }}>{query.trim() ? 'Nic nie pasuje.' : 'Brak zadań bez godziny.'}</Text> : null}
        {candidates.length > shown ? (
          <Pressable accessibilityRole="button" hitSlop={6} onPress={() => setShown(shown + PLAN_PAGE)} style={{ paddingVertical: 10 }}>
            <Text style={{ color: p.accent, fontSize: 14 }}>Pokaż więcej ({candidates.length - shown})</Text>
          </Pressable>
        ) : null}
      </Sheet>
    </Modal>
  );
}

/** Pozycje w konflikcie (nakładające się bloki) — licznik tygodnia, miesiąca i dnia agendy. */
const conflictCount = (entries: readonly CalendarEntry[]) => entries.reduce((n, e) => n + (e.conflict ? 1 : 0), 0);

/** „⚠ N” w nagłówku dnia agendy. */
function DayConflicts({ entries }: { entries: readonly CalendarEntry[] }) {
  const p = usePalette();
  const count = conflictCount(entries);
  if (!count) return null;
  return <Text style={{ color: p.bad, fontSize: 12, fontWeight: '600' }} accessibilityLabel={`Nakładające się bloki: ${count}`}>⚠ {count}</Text>;
}

function ConflictNote({ count }: { count: number }) {
  const p = usePalette();
  if (!count) return null;
  return (
    <Text accessibilityRole="text" style={{ color: p.bad, fontSize: 12, fontWeight: '600' }}>
      ⚠ Nakładające się bloki w widocznym zakresie: {count}
    </Text>
  );
}

function DayView({ slot, hiddenCalendars, data, date, today, workspaceId, bottom }: { slot: CalendarSlot; hiddenCalendars: ReadonlySet<string>; data: AppData; date: LocalDate; today: LocalDate; workspaceId: string | null; bottom: number }) {
  const p = usePalette();
  const { notify } = useTaskActions();
  const plan = useDayPlan(data, date, workspaceId, today, hiddenCalendars);
  const nowMin = useNowMinute(plan.dayStart);
  const schedule = useSchedule();
  const { defaultDurationMin, workHours, timeZone } = data.settings;
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const touched = useRef(false);
  const [axisTop, setAxisTop] = useState<number | null>(null);
  const [allDayOpen, setAllDayOpen] = useState(false);
  const day = plan.day;
  const hour = HOUR[slot];
  const lanes = useMemo(() => blockLanes(day.timed, ((MIN_BLOCK - 4) / hour) * 60), [day.timed, hour]);
  const clock = (b: Pick<Block, 'startAt'>) => localDateTimeAt(b.startAt, timeZone).slice(11);

  const at = (startMin: number) => `→ ${relativeDay(date, today)} ${minutesToTime(startMin)}`;
  const setTime = async (task: ViewTask) => {
    const time = await pickTime({ title: `Godzina: „${task.title}”`, value: task.dueTime ?? (workHours.start as LocalTime) });
    if (!time) return;
    schedule(task, scheduleBlockPatch(task, date, toMin(time), { defaultDurationMin }), at(toMin(time)));
  };
  const setDuration = async (task: ViewTask) => {
    const current = task.durationMin ?? defaultDurationMin;
    const minutes = await pickAmount(
      `Czas trwania: „${task.title}”`,
      [...new Set([...DURATIONS, current])].sort((a, b) => a - b).map((m) => ({ label: formatMinutes(m), value: m, selected: m === current })),
      { value: current, min: 5, max: 1440, unit: 'min' },
    );
    if (minutes) schedule(task, resizeBlockPatch(0, minutes), `— ${formatMinutes(minutes)}`);
  };

  // Inny dzień: godzina i długość bloku zostają (jak przeciągnięcie między dniami na webie).
  const setDay = async (task: ViewTask) => {
    const day = await pickDate({ title: `Dzień: „${task.title}”`, value: task.dueDate, today });
    if (!day || day === task.dueDate) return;
    const patch = task.dueTime ? scheduleBlockPatch(task, day, toMin(task.dueTime), { defaultDurationMin }) : datesPatch(task, { due_date: day });
    schedule(task, patch, `→ ${relativeDay(day, today)}${task.dueTime ? ` ${task.dueTime}` : ''}`);
  };
  const openTask = (task: ViewTask) => router.push({ pathname: '/task/[id]', params: { id: task.id } });
  const canChange = (task: ViewTask) => isOpen(task) && listEditable(data, task.listId);
  // Zadanie z dniem bez godziny: wiersz „cały dzień”.
  const onAllDay = async (task: ViewTask) => {
    // Przyszłe wystąpienie serii: wiersz zadania ma termin bieżącego — bez zmian z tego dnia.
    const virtual = task.dueDate !== date && !(task.startDate && task.dueDate && task.startDate <= date && date <= task.dueDate);
    if (virtual || !canChange(task)) return openTask(task);
    const choice = await pickOption<'open' | 'time' | 'day'>(task.title, [
      { label: 'Otwórz', value: 'open' },
      { label: 'Zaplanuj godzinę…', value: 'time' },
      { label: 'Zmień dzień…', value: 'day' },
    ]);
    if (choice === 'open') openTask(task);
    else if (choice === 'time') await setTime(task);
    else if (choice === 'day') await setDay(task);
  };

  const onBlock = async (block: Block) => {
    if (block.kind === 'habit') return router.push({ pathname: '/habit/[id]', params: { id: block.id } });
    if (block.kind === 'event') {
      const info = plan.info.get(block.id);
      return notify(`${block.title} · ${clock(block)}${info?.calendar ? ` · ${info.calendar}` : ''}${info?.location ? ` · ${info.location}` : ''}`);
    }
    const task = plan.tasks.get(block.id);
    if (!task) return;
    const options: Option<'open' | 'time' | 'day' | 'duration' | 'unschedule'>[] = [{ label: 'Otwórz', value: 'open' }];
    if (!block.virtual && canChange(task)) options.push({ label: 'Zmień godzinę…', value: 'time' }, { label: 'Zmień dzień…', value: 'day' }, { label: 'Czas trwania…', value: 'duration' }, { label: 'Bez godziny', value: 'unschedule', hint: 'Dzień zostaje' });
    const choice = options.length > 1 ? await pickOption(`${clock(block)} ${task.title}`, options) : 'open';
    if (choice === 'open') openTask(task);
    else if (choice === 'time') await setTime(task);
    else if (choice === 'day') await setDay(task);
    else if (choice === 'duration') await setDuration(task);
    else if (choice === 'unschedule') schedule(task, unscheduleBlockPatch(), '— bez godziny');
  };

  // „Zaplanuj…”: arkusz zadań bez godziny ze źródłem i szukaniem (jak panel kalendarza na webie).
  const [planning, setPlanning] = useState(false);
  const planTask = (task: ViewTask) => {
    setPlanning(false);
    void setTime(task);
  };
  const work = useMemo(() => workWindow(date, workHours, timeZone), [date, workHours, timeZone]);

  // „Cały dzień”: wydarzenia, potem zadania bez godziny; zwinięte do 8 pozycji (jak na webie).
  const ALL_DAY_LIMIT = 8;
  const allDayItems = [...day.allDay.filter((i) => i.kind === 'event'), ...day.allDay.filter((i) => i.kind === 'task')];
  const allDayShown = allDayOpen ? allDayItems : allDayItems.slice(0, ALL_DAY_LIMIT);
  // Przewinięcie na start: dziś — godzina przed „teraz”, inny dzień — początek pracy albo pierwszy blok.
  const initial = Math.max(0, ((date === today ? nowMin - 60 : Math.min(toMin(workHours.start), ...day.timed.map((b) => b.startMin))) / 60) * hour - 8);
  // Wyrównanie do „teraz” / początku dnia po każdej zmianie treści nad osią (konflikty, „cały dzień”,
  // wydarzenia telefonu dochodzą asynchronicznie) i wysokości — dopóki użytkownik sam nie przewinie.
  const align = () => {
    if (touched.current || axisTop === null || !data.loaded) return;
    scroll.current?.scrollTo({ y: axisTop + initial, animated: false });
  };
  useEffect(align);
  // Inna wysokość wiersza: u góry zostaje ta sama godzina (bez przewijania palcem robi to `align`).
  const offset = useRef(0);
  const drawnHour = useRef(hour);
  const rescaled = useRef<number | null>(null);
  useLayoutEffect(() => {
    const ratio = hour / drawnHour.current;
    drawnHour.current = hour;
    if (ratio !== 1 && touched.current && axisTop !== null && offset.current > axisTop) rescaled.current = axisTop + (offset.current - axisTop) * ratio;
  }, [hour, axisTop]);
  const onContentSize = () => {
    align();
    if (rescaled.current === null) return;
    scroll.current?.scrollTo({ y: rescaled.current, animated: false });
    rescaled.current = null;
  };

  return (
    <ScrollView
      ref={scroll}
      contentContainerStyle={{ paddingBottom: bottom + 88 }}
      onScrollBeginDrag={() => {
        touched.current = true;
      }}
      onScroll={(e) => {
        offset.current = e.nativeEvent.contentOffset.y;
      }}
      scrollEventThrottle={64}
      onContentSizeChange={onContentSize}
    >
      <View style={{ padding: 12, gap: 8 }}>
        {plan.conflicts.length ? (
          <View style={[styles.box, { borderColor: p.bad }]} accessibilityLabel="Konflikty">
            <Text style={{ color: p.bad, fontWeight: '700', fontSize: 13 }}>⚠ {plural(plan.conflicts.length, ['konflikt', 'konflikty', 'konfliktów'])}</Text>
            {plan.conflicts.map((c) => (
              <Text key={`${c.a.kind}:${c.a.id}|${c.b.kind}:${c.b.id}`} style={{ color: p.fg, fontSize: 12 }}>
                {clock(c.b)} {c.a.title} ↔ {c.b.title} <Text style={{ color: p.muted }}>· {c.overlapMin} min</Text>
              </Text>
            ))}
          </View>
        ) : null}
        {day.allDay.length ? (
          <View style={styles.wrap} accessibilityLabel="Cały dzień">
            {allDayShown.map((t) => {
              if (t.kind === 'event')
                return (
                  <View key={`event:${t.id}`} style={[styles.allDay, { borderColor: plan.info.get(t.id)?.color ?? p.border }]}>
                    <Text style={{ color: p.fg, fontSize: 12 }} numberOfLines={1}>
                      {t.title}
                    </Text>
                  </View>
                );
              const task = plan.tasks.get(t.id);
              return (
                <Pressable key={`task:${t.id}`} accessibilityRole="button" accessibilityLabel={`„${t.title}” — otwórz albo zaplanuj`} onPress={() => task && void onAllDay(task)} style={[styles.allDay, { borderColor: p.border, backgroundColor: p.card }]}>
                  <Text style={{ color: task && !isOpen(task) ? p.muted : p.fg, fontSize: 12, textDecorationLine: task && !isOpen(task) ? 'line-through' : 'none' }} numberOfLines={1}>
                    {t.title}
                  </Text>
                </Pressable>
              );
            })}
            {allDayItems.length > ALL_DAY_LIMIT ? (
              <Pressable accessibilityRole="button" onPress={() => setAllDayOpen(!allDayOpen)} style={[styles.allDay, { borderColor: p.border }]}>
                <Text style={{ color: p.accent, fontSize: 12 }}>{allDayOpen ? 'Zwiń' : `+${allDayItems.length - ALL_DAY_LIMIT}`}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <View style={styles.row}>
          <Text style={{ color: p.muted, fontSize: 12, flex: 1 }}>
            {plural(day.timed.filter((b) => !b.passive).length, ['blok', 'bloki', 'bloków'])} · przytrzymaj blok, żeby go przesunąć · dotknij pustego miejsca, żeby dodać zadanie
          </Text>
          <Chip label="+ Zaplanuj…" onPress={() => setPlanning(true)} />
        </View>
      </View>
      {planning ? <ScheduleSheet data={data} date={date} today={today} workspaceId={workspaceId} onPick={planTask} onClose={() => setPlanning(false)} /> : null}
      <View onLayout={(e) => setAxisTop(e.nativeEvent.layout.y)}>
      <DayTimeline
        key={slot}
        slot={slot}
        plan={day}
        hot={plan.hot}
        lanes={lanes}
        free={plan.free}
        work={work}
        info={plan.info}
        tasks={plan.tasks}
        from={0}
        to={day.dayMinutes}
        hour={hour}
        nowMin={date === today ? nowMin : null}
        editable
        onPress={(b) => void onBlock(b)}
        onEmpty={(min) => openQuickAdd({ dueDate: date, dueTime: clickedTime(min, slot) })}
        onMove={(task, startMin, durationMin) => schedule(task, scheduleBlockPatch(task, date, startMin, { durationMin }), at(startMin))}
        onResize={(task, startMin, endMin) => schedule(task, resizeBlockPatch(startMin, endMin), `— ${formatMinutes(Math.max(5, endMin - startMin))}`)}
      />
      </View>
    </ScrollView>
  );
}

/** Pozycje kalendarza dla `[from, to)` z wydarzeniami i nawykami bieżącej przestrzeni. */
function useEntries(data: AppData, from: LocalDate, to: LocalDate, today: LocalDate, workspaceId: string | null, hiddenCalendars: ReadonlySet<string>): { entries: CalendarEntry[]; info: Map<string, EventInfo>; tasks: Map<string, ViewTask> } {
  const { timeZone, defaultDurationMin } = data.settings;
  const range = useMemo(() => ({ from, to }), [from, to]);
  const events = useCalendarEvents(range, timeZone, hiddenCalendars);
  const tasks = useMemo(() => new Map(data.tasks.map((t) => [t.id, t])), [data.tasks]);
  const result = useMemo(() => {
    const own = data.tasks.filter((t) => !workspaceId || t.workspaceId === workspaceId);
    const habits = habitSlots(own, data.habitCompletions, from, to, today);
    const entries = perfMeasure(
      'kalendarz: pozycje',
      () => calendarEntries(own.filter((t) => t.kind === 'task'), events.list, from, to, { timeZone, defaultDurationMin, habits }),
      (list) => `${list.length} w ${from}…${to}`,
    );
    return { entries, info: events.info };
  }, [data.tasks, data.habitCompletions, events, from, to, today, workspaceId, timeZone, defaultDurationMin]);
  return { ...result, tasks };
}

/** Pierwsze `limit` pozycji dnia i „Pokaż więcej” (jak `Paged` na webie): bez tego tydzień to ~700 wierszy naraz. */
function EntryList({ entries, tasks, info, limit }: { entries: readonly CalendarEntry[]; tasks: Map<string, ViewTask>; info: Map<string, EventInfo>; limit: number }) {
  const p = usePalette();
  const [shown, setShown] = useState(limit);
  if (!entries.length) return <Text style={{ color: p.muted, fontSize: 12 }}>Nic nie zaplanowano.</Text>;
  return (
    <>
      {entries.slice(0, shown).map((e) => (
        <EntryRow key={e.key} entry={e} task={e.kind === 'task' ? tasks.get(e.id) : undefined} info={info} />
      ))}
      {entries.length > shown ? (
        <Pressable accessibilityRole="button" hitSlop={6} onPress={() => setShown(shown + 100)}>
          <Text style={{ color: p.accent, fontSize: 13 }}>Pokaż więcej ({entries.length - shown})</Text>
        </Pressable>
      ) : null}
    </>
  );
}

function EntryRow({ entry, task, info }: { entry: CalendarEntry; task: ViewTask | undefined; info: Map<string, EventInfo> }) {
  const p = usePalette();
  const color = task ? (PRIORITY[task.priority]?.color ?? p.border) : entry.kind === 'habit' ? HABIT_COLOR : (info.get(entry.id)?.color ?? p.muted);
  const time = entry.allDay ? (entry.kind === 'event' ? 'cały dzień' : 'bez godziny') : `${entry.start.slice(11, 16)}–${entry.end.slice(11, 16)}`;
  const mark = entry.kind === 'habit' ? (entry.habitState === 'done' ? '✓ ' : '◎ ') : '';
  const onPress =
    entry.kind === 'task'
      ? () => router.push({ pathname: '/task/[id]', params: { id: entry.id } })
      : entry.kind === 'habit'
        ? () => router.push({ pathname: '/habit/[id]', params: { id: entry.id } })
        : undefined;
  return (
    <Pressable accessibilityRole={onPress ? 'button' : 'text'} disabled={!onPress} onPress={onPress} style={[styles.entry, { borderLeftColor: color, opacity: entry.passive || entry.virtual ? 0.6 : 1 }]}>
      <Text style={{ color: p.muted, fontSize: 12, width: 82 }}>{time}</Text>
      <Text style={{ color: p.fg, fontSize: 14, flex: 1, textDecorationLine: entry.passive && entry.kind !== 'event' ? 'line-through' : 'none' }} numberOfLines={1}>
        {entry.conflict ? '⚠ ' : ''}
        {mark}
        {entry.title}
      </Text>
    </Pressable>
  );
}

function RangeAgenda({ hiddenCalendars, data, from, to, today, workspaceId, onDay, bottom }: { hiddenCalendars: ReadonlySet<string>; data: AppData; from: LocalDate; to: LocalDate; today: LocalDate; workspaceId: string | null; onDay: (d: LocalDate) => void; bottom: number }) {
  const p = usePalette();
  const { entries, info, tasks } = useEntries(data, from, to, today, workspaceId, hiddenCalendars);
  const days = useMemo(() => perfMeasure('kalendarz: agenda', () => agendaDays(entries, from, to)), [entries, from, to]);
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 10, paddingBottom: bottom + 88 }}>
      <ConflictNote count={conflictCount(entries)} />
      {days.map((d) => (
        <View key={d.date} style={[styles.dayCard, { borderColor: d.date === today ? p.accent : p.border, backgroundColor: p.card }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Otwórz dzień ${dayLabel(d.date)}`} onPress={() => onDay(d.date)} style={styles.row}>
            <Text style={{ color: d.date === today ? p.accent : p.fg, fontSize: 14, fontWeight: '700', flex: 1 }}>{capitalized(dayLabel(d.date))}</Text>
            <DayConflicts entries={d.entries} />
            <Text style={{ color: p.muted, fontSize: 18 }}>›</Text>
          </Pressable>
          <EntryList key={`${d.date}:${workspaceId}`} entries={d.entries} tasks={tasks} info={info} limit={10} />
        </View>
      ))}
    </ScrollView>
  );
}

function MonthView({ hiddenCalendars, data, date, today, workspaceId, onSelect, onDay, bottom }: { hiddenCalendars: ReadonlySet<string>; data: AppData; date: LocalDate; today: LocalDate; workspaceId: string | null; onSelect: (d: LocalDate) => void; onDay: (d: LocalDate) => void; bottom: number }) {
  const p = usePalette();
  const firstDay = data.settings.firstDayOfWeek;
  const weeks = useMemo(() => monthWeeks(date, firstDay), [date, firstDay]);
  const from = weeks[0]![0]!;
  const to = addDays(weeks[weeks.length - 1]![6]!, 1);
  const { entries, info, tasks } = useEntries(data, from, to, today, workspaceId, hiddenCalendars);
  const days = useMemo(() => new Map(perfMeasure('kalendarz: agenda', () => agendaDays(entries, from, to)).map((d) => [d.date, d.entries])), [entries, from, to]);
  const month = date.slice(0, 7);
  const selected = days.get(date) ?? [];
  return (
    <ScrollView contentContainerStyle={{ padding: 8, gap: 10, paddingBottom: bottom + 88 }}>
      <ConflictNote count={conflictCount(entries)} />
      <View>
        <View style={styles.week}>
          {weeks[0]!.map((d) => (
            <Text key={d} style={[styles.weekday, { color: p.muted }]}>
              {WEEKDAY[isoWeekday(d) as IsoWeekday].short}
            </Text>
          ))}
        </View>
        {weeks.map((week) => (
          <View key={week[0]} style={styles.week}>
            {week.map((d) => {
              const list = days.get(d) ?? [];
              // Kropki: najpierw aktywne, potem ukończone i „wolny” (przygaszone).
              const dots = [...list.filter((e) => !e.passive), ...list.filter((e) => e.passive)];
              const isSelected = d === date;
              const hot = conflictCount(list);
              return (
                <Pressable
                  key={d}
                  accessibilityRole="button"
                  accessibilityLabel={`${dayLabel(d)}, ${plural(list.length, ['pozycja', 'pozycje', 'pozycji'])}${hot ? `, nakładające się bloki: ${hot}` : ''}`}
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => (isSelected ? onDay(d) : onSelect(d))}
                  style={[styles.cell, { borderColor: isSelected ? p.accent : p.border, backgroundColor: isSelected ? p.selected : d.slice(0, 7) === month ? p.card : 'transparent' }]}
                >
                  <Text style={{ color: d === today ? p.accent : d.slice(0, 7) === month ? p.fg : p.muted, fontSize: 13, fontWeight: d === today ? '700' : '400' }}>{Number(d.slice(8, 10))}</Text>
                  <View style={styles.dots}>
                    {dots.slice(0, 4).map((e) => (
                      <View key={e.key} style={[styles.dot, { opacity: e.passive ? 0.4 : 1, backgroundColor: e.conflict ? p.bad : e.kind === 'event' ? (info.get(e.id)?.color ?? p.muted) : e.kind === 'habit' ? HABIT_COLOR : p.accent }]} />
                    ))}
                  </View>
                  {dots.length > 4 ? <Text style={{ color: p.muted, fontSize: 9 }}>+{dots.length - 4}</Text> : null}
                  {hot ? <Text style={{ color: p.bad, fontSize: 9, fontWeight: '700' }}>⚠{hot}</Text> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
      <View style={[styles.dayCard, { borderColor: p.border, backgroundColor: p.card }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Otwórz dzień ${dayLabel(date)}`} onPress={() => onDay(date)} style={styles.row}>
          <Text style={{ color: p.fg, fontSize: 14, fontWeight: '700', flex: 1 }}>{capitalized(dayLabel(date))}</Text>
          <DayConflicts entries={selected} />
          <Text style={{ color: p.accent, fontSize: 13 }}>Oś dnia ›</Text>
        </Pressable>
        <EntryList key={`${date}:${workspaceId}`} entries={selected} tasks={tasks} info={info} limit={30} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: { padding: 8, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'flex-end', gap: 6 },
  arrow: { paddingHorizontal: 12, paddingVertical: 2 },
  box: { borderWidth: 1, borderRadius: 8, padding: 8, gap: 2 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  allDay: { borderWidth: StyleSheet.hairlineWidth, borderLeftWidth: 3, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, maxWidth: '100%' },
  dayCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 6 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 6, borderLeftWidth: 3, paddingLeft: 8, paddingVertical: 4 },
  week: { flexDirection: 'row', gap: 3, marginBottom: 3 },
  weekday: { flex: 1, textAlign: 'center', fontSize: 11 },
  cell: { flex: 1, minHeight: 54, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, padding: 3, alignItems: 'center', gap: 3 },
  dots: { flexDirection: 'row', flexWrap: 'wrap', gap: 2, justifyContent: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  sources: { gap: 6, paddingBottom: 8 },
  search: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15, marginBottom: 6 },
  candidate: { borderBottomWidth: StyleSheet.hairlineWidth, borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 10, gap: 2 },
});
