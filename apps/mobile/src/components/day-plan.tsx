/**
 * „Plan dnia” w „Dziś” (M9, M11) — jak aside na webie (`day-plan.tsx`): oś godzin pracy z blokami zadań,
 * nawyków i wydarzeń, wolne okna, linia „teraz”, konflikty, wiersz „cały dzień” (zadania na ten dzień bez
 * godziny — dotknięcie otwiera zadanie — i wydarzenia całodniowe); zwijany (stan na urządzeniu, domyślnie
 * zwinięty — wtedy w nagłówku liczba bloków, konflikty i najbliższy blok, żeby nie zasłaniać listy). Przesuwanie
 * bloków — w kalendarzu (`/calendar`); tu dotknięcie bloku otwiera zadanie albo nawyk, a „Ułóż dzień”
 * (`day-planner.tsx`) układa zadania w wolnych oknach (szkic jako przerywane bloki do „Zastosuj”). Chipy
 * „Dziś | Jutro” wybierają dzień rozwiniętego planu; zwinięty zawsze mówi o dzisiejszym. Na końcu przeglądu
 * dnia (`initial`) karta jest rozwinięta od razu, bez zapamiętywania.
 */
import { addDays, blockLanes, DAY_PLANNER, isOpen, localDateTimeAt, plural, withDraft, type Block, type LocalDate } from '@taskplanner/core';
import { router } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AppData } from '@/lib/app-data';
import { axisRange, useDayPlan, useNowMinute } from '@/lib/day-plan';

import { useTaskActions } from './actions';
import { DayPlanner, type PlanPreview } from './day-planner';
import { DayTimeline } from './day-timeline';
import { Chip, Row, usePalette } from './ui';

const OPEN_KEY = 'today.plan';
/** Pikseli na godzinę (oś godzin pracy mieści się na ekranie). */
const HOUR = 40;
/** Wiersz „cały dzień” (zadania bez godziny i wydarzenia całodniowe) — dalej tylko „+N”, jak na webie. */
const ALL_DAY_LIMIT = 8;

export function DayPlanCard({ data, today, workspaceId, initial }: { data: AppData; today: LocalDate; workspaceId: string | null; initial?: LocalDate }) {
  const p = usePalette();
  const { notify } = useTaskActions();
  const [open, setOpenState] = useState(() => !!initial || Storage.getItemSync(OPEN_KEY) === '1');
  const setOpen = (next: boolean) => {
    if (!initial) Storage.setItemSync(OPEN_KEY, next ? '1' : '0');
    setOpenState(next);
  };
  const tomorrow = addDays(today, 1);
  // Wybór jako data: po północy wybrane „jutro” staje się „dziś”.
  const [picked, setPicked] = useState<LocalDate | null>(initial ?? null);
  const date = open && picked === tomorrow ? tomorrow : today;
  const plan = useDayPlan(data, date, workspaceId, today);
  const nowMin = useNowMinute(plan.dayStart);
  // Szkic osobno dla każdego dnia — przełączenie go nie gubi, a spóźniona odpowiedź AI trafia do swojego dnia.
  const [previews, setPreviews] = useState<Record<LocalDate, PlanPreview | null>>({});
  const preview = previews[date] ?? null;
  const setPreview = (next: PlanPreview | null) => setPreviews((all) => ({ ...all, [date]: next }));
  // Szkic dotyczy tej przestrzeni; zadania zamknięte od ułożenia znikają.
  const draft = useMemo(() => {
    if (!preview || preview.workspaceId !== workspaceId) return null;
    return { ...preview, blocks: preview.blocks.filter((b) => isOpen(plan.tasks.get(b.taskId) ?? { status: 'cancelled' })) };
  }, [preview, workspaceId, plan.tasks]);
  const day = useMemo(() => (draft ? withDraft(plan.day, draft.blocks, plan.tasks, data.settings.timeZone) : plan.day), [draft, plan.day, plan.tasks, data.settings.timeZone]);
  const lanes = useMemo(() => (draft ? blockLanes(day.timed) : plan.lanes), [draft, day.timed, plan.lanes]);
  const drafted = useMemo(() => new Set(draft?.blocks.map((b) => b.taskId)), [draft]);
  const { timeZone } = data.settings;
  const clock = (b: Pick<Block, 'startAt'>) => localDateTimeAt(b.startAt, timeZone).slice(11);
  const blocks = plan.day.timed.filter((b) => !b.passive).length;
  const range = axisRange({ ...plan, day }, data.settings.workHours);
  const next = plan.day.timed.find((b) => !b.passive && b.endMin > nowMin);

  const openTask = (id: string) => router.push({ pathname: '/task/[id]', params: { id } });
  const onPress = (block: Block) => {
    if (block.kind === 'task') return openTask(block.id);
    if (block.kind === 'habit') return router.push({ pathname: '/habit/[id]', params: { id: block.id } });
    const info = plan.info.get(block.id);
    notify(`${block.title} · ${clock(block)}${info?.calendar ? ` · ${info.calendar}` : ''}${info?.location ? ` · ${info.location}` : ''}`);
  };

  return (
    <View style={[styles.card, { borderColor: p.border, backgroundColor: p.card }]} accessibilityLabel="Plan dnia">
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={[styles.row, { flex: 1 }]}>
          <Text style={{ color: p.fg, fontSize: 13, fontWeight: '700' }}>{open ? '▾' : '▸'} Plan dnia</Text>
          <Text style={{ color: p.muted, fontSize: 12 }}>{plural(blocks, ['blok', 'bloki', 'bloków'])}</Text>
          {plan.conflicts.length ? <Text style={{ color: p.bad, fontSize: 12 }}>⚠ {plan.conflicts.length}</Text> : null}
        </Pressable>
        <Pressable accessibilityRole="link" hitSlop={8} onPress={() => router.push({ pathname: '/calendar', params: { date, mode: 'day' } })}>
          <Text style={{ color: p.accent, fontSize: 12 }}>Kalendarz ›</Text>
        </Pressable>
      </View>
      {!open && next ? (
        <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={1}>
          {next.startMin <= nowMin ? 'Teraz' : 'Następny'}: {clock(next)} {next.title}
        </Text>
      ) : null}
      {open ? (
        <View style={{ gap: 6 }}>
          <Row>
            {[today, tomorrow].map((d) => (
              <Chip key={d} label={d === today ? DAY_PLANNER.today : DAY_PLANNER.tomorrow} selected={date === d} onPress={() => setPicked(d)} />
            ))}
          </Row>
          <DayPlanner key={date} data={data} date={date} today={today} workspaceId={workspaceId} events={plan.events} nowMin={nowMin} preview={draft} onPreview={setPreview} onOpen={openTask} />
          {plan.conflicts.map((c) => (
            <Text key={`${c.a.kind}:${c.a.id}|${c.b.kind}:${c.b.id}`} style={{ color: p.bad, fontSize: 12 }}>
              ⚠ {clock(c.b)} {c.a.title} ↔ {c.b.title} · {c.overlapMin} min
            </Text>
          ))}
          {day.allDay.length ? (
            <View style={styles.allDay} accessibilityLabel="Cały dzień">
              {day.allDay.slice(0, ALL_DAY_LIMIT).map((item) =>
                item.kind === 'task' ? (
                  <Pressable
                    key={`task:${item.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Otwórz „${item.title}”`}
                    onPress={() => openTask(item.id)}
                    style={({ pressed }) => [styles.allDayItem, { backgroundColor: p.border, opacity: pressed ? 0.6 : 1 }]}
                  >
                    <Text style={{ color: p.fg, fontSize: 12 }} numberOfLines={1}>
                      {item.title}
                    </Text>
                  </Pressable>
                ) : (
                  <View key={`event:${item.id}`} style={[styles.allDayItem, { borderColor: p.border, borderWidth: StyleSheet.hairlineWidth }]}>
                    <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={1}>
                      {item.title}
                    </Text>
                  </View>
                ),
              )}
              {day.allDay.length > ALL_DAY_LIMIT ? <Text style={{ color: p.muted, fontSize: 12, alignSelf: 'center' }}>+{day.allDay.length - ALL_DAY_LIMIT}</Text> : null}
            </View>
          ) : null}
          {day.timed.length ? (
            <DayTimeline
              plan={day}
              hot={plan.hot}
              lanes={lanes}
              drafted={drafted}
              free={plan.free}
              info={plan.info}
              tasks={plan.tasks}
              from={range.from}
              to={range.to}
              hour={HOUR}
              nowMin={nowMin}
              onPress={onPress}
            />
          ) : (
            <Text style={{ color: p.muted, fontSize: 12 }}>Brak bloków z godziną — „Ułóż dzień” albo przeciągnij zadania w kalendarzu.</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 12, marginVertical: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  allDay: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  allDayItem: { maxWidth: '100%', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
});
