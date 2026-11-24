/**
 * „Plan dnia” w „Dziś” (M9, M11) — jak aside na webie (`day-plan.tsx`): oś godzin pracy z blokami zadań,
 * nawyków i wydarzeń, wolne okna, linia „teraz”, konflikty; zwijany (stan na urządzeniu, domyślnie
 * zwinięty — wtedy w nagłówku liczba bloków, konflikty i najbliższy blok, żeby nie zasłaniać listy). Przesuwanie
 * bloków — w kalendarzu (`/calendar`); tu dotknięcie bloku otwiera zadanie albo nawyk, a „Ułóż dzień”
 * (`day-planner.tsx`) układa zadania w wolnych oknach (szkic jako przerywane bloki do „Zastosuj”).
 */
import { blockLanes, isOpen, localDateTimeAt, plural, withDraft, type Block, type LocalDate } from '@taskplanner/core';
import { router } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AppData } from '@/lib/app-data';
import { axisRange, useDayPlan, useNowMinute } from '@/lib/day-plan';

import { useTaskActions } from './actions';
import { DayPlanner, type PlanPreview } from './day-planner';
import { DayTimeline } from './day-timeline';
import { usePalette } from './ui';

const OPEN_KEY = 'today.plan';
/** Pikseli na godzinę (oś godzin pracy mieści się na ekranie). */
const HOUR = 40;

export function DayPlanCard({ data, today, workspaceId }: { data: AppData; today: LocalDate; workspaceId: string | null }) {
  const p = usePalette();
  const { notify } = useTaskActions();
  const plan = useDayPlan(data, today, workspaceId, today);
  const nowMin = useNowMinute(plan.dayStart);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  // Szkic dotyczy tego dnia i tej przestrzeni; zadania zamknięte od ułożenia znikają.
  const draft = useMemo(() => {
    if (!preview || preview.date !== today || preview.workspaceId !== workspaceId) return null;
    return { ...preview, blocks: preview.blocks.filter((b) => isOpen(plan.tasks.get(b.taskId) ?? { status: 'cancelled' })) };
  }, [preview, today, workspaceId, plan.tasks]);
  const day = useMemo(() => (draft ? withDraft(plan.day, draft.blocks, plan.tasks, data.settings.timeZone) : plan.day), [draft, plan.day, plan.tasks, data.settings.timeZone]);
  const lanes = useMemo(() => (draft ? blockLanes(day.timed) : plan.lanes), [draft, day.timed, plan.lanes]);
  const drafted = useMemo(() => new Set(draft?.blocks.map((b) => b.taskId)), [draft]);
  const [open, setOpenState] = useState(() => Storage.getItemSync(OPEN_KEY) === '1');
  const setOpen = (next: boolean) => {
    Storage.setItemSync(OPEN_KEY, next ? '1' : '0');
    setOpenState(next);
  };
  const { timeZone } = data.settings;
  const clock = (b: Pick<Block, 'startAt'>) => localDateTimeAt(b.startAt, timeZone).slice(11);
  const blocks = plan.day.timed.filter((b) => !b.passive).length;
  const range = axisRange({ ...plan, day }, data.settings.workHours);
  const events = plan.day.allDay.filter((i) => i.kind === 'event');
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
        <Pressable accessibilityRole="link" hitSlop={8} onPress={() => router.push({ pathname: '/calendar', params: { date: today, mode: 'day' } })}>
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
          <DayPlanner data={data} date={today} today={today} workspaceId={workspaceId} events={plan.events} nowMin={nowMin} preview={draft} onPreview={setPreview} onOpen={openTask} />
          {plan.conflicts.map((c) => (
            <Text key={`${c.a.kind}:${c.a.id}|${c.b.kind}:${c.b.id}`} style={{ color: p.bad, fontSize: 12 }}>
              ⚠ {clock(c.b)} {c.a.title} ↔ {c.b.title} · {c.overlapMin} min
            </Text>
          ))}
          {events.length ? (
            <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={2}>
              Cały dzień: {events.map((e) => e.title).join(' · ')}
            </Text>
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
});
