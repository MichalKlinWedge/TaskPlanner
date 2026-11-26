/**
 * Strona startowa (v1.x, jak web `home.tsx`): pierwsza zakładka, otwiera się po starcie aplikacji. Pole szybkiego
 * dodawania do Inboxu i pulpit statystyk — liczby z core `homeStats` (lokalne dane, działa offline); tu tylko
 * układ i słupki z `View`. Dotknięcie słupka pokazuje jego dzień pod wykresem.
 */
import { addDays, dayChip, dayLabel, formatMinutes, HOME_HISTORY_DAYS, homeStats, homeStatsFrom, isoWeekday, PRIORITY, plural, pluralForm, WEEKDAY, type IsoWeekday, type Priority } from '@taskplanner/core';
import type { SqlRow } from '@taskplanner/sync';
import { router, type Href } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { QuickAddField } from '@/components/quick-add-field';
import { ScreenHeader } from '@/components/sync-banner';
import { usePalette } from '@/components/ui';
import { targetInbox, useLocalMinute, useView, type AppData } from '@/lib/app-data';
import { useFocusData } from '@/lib/focus';
import { useLocalQuery } from '@/lib/local-query';
import { usePerfReady } from '@/lib/perf';

type Palette = ReturnType<typeof usePalette>;

const greeting = (hour: number) => (hour < 5 ? 'Dobranoc' : hour < 18 ? 'Dzień dobry' : 'Dobry wieczór');
const weekday = (date: string) => WEEKDAY[isoWeekday(date) as IsoWeekday].short;
const TASKS = ['zadanie', 'zadania', 'zadań'] as const;

export default function HomeScreen() {
  const p = usePalette();
  const { data, today, ctx, workspaceId } = useView();
  const { entries } = useFocusData();
  // Lokalna minuta (zegar ściany) — odświeża liczby co minutę i po powrocie z tła.
  const minute = useLocalMinute(data.settings.timeZone);
  usePerfReady('tab:index', data.loaded);
  const since = addDays(homeStatsFrom(today), -2);
  const series = useLocalQuery(
    ['task_completions', 'tasks'],
    (engine) =>
      engine.db.all<SqlRow>(
        `select c.task_id, c.completed_at from task_completions c join tasks t on t.id = c.task_id
           where c.deleted_at is null and c.kind = 'done' and t.kind = 'task' and t.deleted_at is null and c.completed_at >= ?`,
        [since],
      ),
    [since],
  );
  const stats = useMemo(
    () =>
      homeStats(
        {
          tasks: data.tasks,
          lists: data.lists,
          seriesDone: (series ?? []).map((r) => ({ taskId: String(r.task_id), completedAt: String(r.completed_at) })),
          habitCompletions: data.habitCompletions,
          timeEntries: entries,
          now: new Date(),
        },
        ctx,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `minute` przelicza „teraz” (trwający wpis skupienia)
    [data.tasks, data.lists, data.habitCompletions, series, entries, minute, ctx],
  );

  const wsName = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const target = targetInbox(data, workspaceId);
  const placeholder = target && !workspaceId && data.workspaces.length > 1 ? `Dodaj do Inboxu („${wsName.get(target.workspaceId)}”)` : 'Dodaj do Inboxu';
  const trend = stats.doneWeek - stats.donePrevWeek;
  const go = (href: Href) => () => router.navigate(href);

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled" testID="home">
      <ScreenHeader />
      <View style={styles.pad}>
        <Text style={{ color: p.fg, fontSize: 20, fontWeight: '600' }}>{greeting(Number(minute.slice(11, 13)))}</Text>
        <Text style={{ color: p.muted, fontSize: 13 }}>
          {dayLabel(today)}
          {workspaceId ? ` · ${wsName.get(workspaceId) ?? ''}` : ' · wszystkie przestrzenie'}
        </Text>
      </View>
      {data.loaded ? <QuickAddField listId={target?.id} placeholder={placeholder} /> : null}

      <View style={[styles.pad, styles.tiles]}>
        <Tile p={p} label="Na dziś" value={stats.today} hint={stats.today ? 'z terminem dziś' : 'nic na dziś'} onPress={go('/today')} />
        <Tile p={p} label="Zaległe" value={stats.overdue} danger={stats.overdue > 0} hint={stats.overdue ? 'po terminie' : 'wszystko na czas'} onPress={go('/overdue')} />
        <Tile p={p} label="Inbox" value={stats.inbox} hint={stats.inbox ? 'do rozplanowania' : 'pusty'} onPress={go('/inbox')} />
        <Tile p={p} label="Otwarte" value={stats.open} hint="niezamknięte" />
        <Tile p={p} label="Ukończone dziś" value={stats.doneToday} hint={stats.streak ? `seria: ${plural(stats.streak, ['dzień', 'dni', 'dni'])}` : 'jeszcze bez serii'} />
        <Tile p={p} label="Ukończone w 7 dni" value={stats.doneWeek} hint={trend === 0 ? 'jak tydzień wcześniej' : `${trend > 0 ? '▲' : '▼'} ${Math.abs(trend)} wobec 7 dni wcześniej`} />
        <Tile p={p} label="Dodane w 7 dni" value={stats.createdWeek} hint={stats.createdWeek > stats.doneWeek ? 'przybywa szybciej' : 'ubywa co najmniej tyle'} />
        {stats.habitsTotal ? (
          <Tile p={p} label="Cykliczne dziś" value={`${stats.habitsDone}/${stats.habitsTotal}`} hint={stats.habitsDone === stats.habitsTotal ? 'wszystkie zaliczone' : 'do odhaczenia'} onPress={go('/habits')} />
        ) : data.settings.focus.enabled ? (
          <Tile p={p} label="Skupienie dziś" value={formatMinutes(stats.focusTodayMin)} hint="w trybie skupienia" onPress={go('/focus')} />
        ) : null}
      </View>

      <HistoryChart p={p} history={stats.history} />
      <UpcomingChart p={p} days={stats.upcoming} today={today} onOpen={go('/upcoming')} />
      <PriorityChart p={p} counts={stats.priority} total={stats.open} />
      <ListsProgress p={p} items={stats.lists} data={data} />
    </ScrollView>
  );
}

function Tile({ p, label, value, hint, danger, onPress }: { p: Palette; label: string; value: number | string; hint?: string; danger?: boolean; onPress?: () => void }) {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${label}: ${value}${hint ? `, ${hint}` : ''}`}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.tile, { backgroundColor: pressed ? p.border : p.card, borderColor: p.border }]}
    >
      <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={1}>
        {label}
      </Text>
      <Text style={{ color: danger ? p.bad : p.fg, fontSize: 22, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{value}</Text>
      {hint ? (
        <Text style={{ color: p.muted, fontSize: 11 }} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}

function Card({ p, title, readout, legend, children }: { p: Palette; title: string; readout?: string; legend?: ReactNode; children: ReactNode }) {
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}>
      <View style={styles.cardHead}>
        <Text style={{ color: p.fg, fontSize: 14, fontWeight: '600' }}>{title}</Text>
        {legend}
      </View>
      {children}
      {readout ? <Text style={{ color: p.muted, fontSize: 12, marginTop: 8 }}>{readout}</Text> : null}
    </View>
  );
}

const Swatch = ({ p, color, label }: { p: Palette; color: string; label: string }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
    <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: color }} />
    <Text style={{ color: p.muted, fontSize: 12 }}>{label}</Text>
  </View>
);

/** Szary drugiej serii — widoczny na obu tłach. */
const createdColor = (p: Palette) => (p.bg === '#fafafa' ? '#c4c4c8' : '#52525b');
const CHART_H = 120;

function Bar({ value, max, color, width }: { value: number; max: number; color: string; width?: number | `${number}%` }) {
  return <View style={{ width, height: value ? Math.max(3, (value / max) * CHART_H) : 0, backgroundColor: color, borderTopLeftRadius: 3, borderTopRightRadius: 3 }} />;
}

function HistoryChart({ p, history }: { p: Palette; history: { date: string; done: number; created: number }[] }) {
  const [picked, setPicked] = useState<number | null>(null);
  const max = Math.max(1, ...history.flatMap((d) => [d.done, d.created]));
  const day = picked === null ? null : history[picked];
  const total = history.reduce((n, d) => n + d.done, 0);
  return (
    <Card
      p={p}
      title={`Ukończone i dodane — ${HOME_HISTORY_DAYS} dni`}
      legend={
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Swatch p={p} color={p.accent} label="ukończone" />
          <Swatch p={p} color={createdColor(p)} label="dodane" />
        </View>
      }
      readout={day ? `${dayChip(day.date)}: ukończone ${day.done}, dodane ${day.created}` : `Razem ukończone: ${total} · dotknij słupka`}
    >
      <View style={[styles.plot, { borderColor: p.border }]}>
        {history.map((d, i) => (
          <Pressable
            key={d.date}
            onPress={() => setPicked(picked === i ? null : i)}
            accessibilityLabel={`${dayLabel(d.date)}: ukończone ${d.done}, dodane ${d.created}`}
            style={[styles.column, { gap: 1, backgroundColor: picked === i ? p.border : 'transparent' }]}
          >
            <Bar value={d.done} max={max} color={p.accent} width="45%" />
            <Bar value={d.created} max={max} color={createdColor(p)} width="45%" />
          </Pressable>
        ))}
      </View>
      <View style={styles.axis}>
        {history.map((d, i) => (
          <Text key={d.date} style={[styles.tick, { color: p.muted }]} numberOfLines={1}>
            {i === history.length - 1 ? 'dziś' : i % 3 === (history.length - 1) % 3 ? weekday(d.date) : ''}
          </Text>
        ))}
      </View>
    </Card>
  );
}

function UpcomingChart({ p, days, today, onOpen }: { p: Palette; days: { date: string; items: number; minutes: number }[]; today: string; onOpen: () => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.items));
  const day = picked === null ? null : days[picked];
  const total = days.reduce((n, d) => n + d.items, 0);
  return (
    <Card
      p={p}
      title="Najbliższe dni"
      legend={
        <Pressable accessibilityRole="link" onPress={onOpen} hitSlop={8}>
          <Text style={{ color: p.accent, fontSize: 12 }}>Nadchodzące ›</Text>
        </Pressable>
      }
      readout={
        day
          ? `${dayChip(day.date)}: ${plural(day.items, TASKS)}${day.minutes ? `, ${formatMinutes(day.minutes)} zaplanowanego czasu` : ''}`
          : `Razem: ${plural(total, TASKS)} w ${days.length} dni · dotknij słupka`
      }
    >
      <View style={[styles.plot, { borderColor: p.border, gap: 6 }]}>
        {days.map((d, i) => (
          <Pressable
            key={d.date}
            onPress={() => setPicked(picked === i ? null : i)}
            accessibilityLabel={`${dayLabel(d.date)}: ${plural(d.items, TASKS)}`}
            style={[styles.column, { flexDirection: 'column', justifyContent: 'flex-end', backgroundColor: picked === i ? p.border : 'transparent' }]}
          >
            {d.items ? <Text style={{ color: p.muted, fontSize: 11, textAlign: 'center' }}>{d.items}</Text> : null}
            <View style={{ alignItems: 'center' }}>
              <Bar value={d.items} max={max / 0.85} color={d.date === today ? p.accent : `${p.accent}99`} width="70%" />
            </View>
          </Pressable>
        ))}
      </View>
      <View style={[styles.axis, { gap: 6 }]}>
        {days.map((d) => (
          <Text key={d.date} style={[styles.tick, { color: p.muted }]} numberOfLines={1}>
            {d.date === today ? 'dziś' : `${weekday(d.date)} ${Number(d.date.slice(8, 10))}`}
          </Text>
        ))}
      </View>
    </Card>
  );
}

function PriorityChart({ p, counts, total }: { p: Palette; counts: Record<Priority, number>; total: number }) {
  const max = Math.max(1, ...Object.values(counts));
  return (
    <Card p={p} title="Otwarte według priorytetu" readout={total ? `Razem ${plural(total, ['otwarte zadanie', 'otwarte zadania', 'otwartych zadań'])}` : 'Brak otwartych zadań'}>
      {([1, 2, 3, 4] as const).map((n) => (
        <View key={n} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: n === 1 ? 0 : 8 }}>
          <Text style={{ color: p.muted, fontSize: 12, width: 72 }}>{PRIORITY[n].label}</Text>
          <View style={{ flex: 1, height: 12 }}>
            <View style={{ height: 12, width: counts[n] ? `${Math.max(1.5, (counts[n] / max) * 100)}%` : 0, backgroundColor: PRIORITY[n].color, borderTopRightRadius: 3, borderBottomRightRadius: 3 }} />
          </View>
          <Text style={{ color: p.fg, fontSize: 12, width: 40, textAlign: 'right', fontVariant: ['tabular-nums'] }}>{counts[n]}</Text>
        </View>
      ))}
    </Card>
  );
}

function ListsProgress({ p, items, data }: { p: Palette; items: { listId: string; open: number; done: number }[]; data: AppData }) {
  const lists = new Map(data.lists.map((l) => [l.id, l]));
  return (
    <Card p={p} title="Listy z największą liczbą otwartych" readout={items.length ? 'Pasek = ukończone ze wszystkich zadań listy (bez anulowanych)' : 'Brak otwartych zadań poza Inboxem'}>
      {items.map((item, i) => {
        const list = lists.get(item.listId);
        const total = item.open + item.done;
        const pct = total ? Math.round((item.done / total) * 100) : 0;
        return (
          <Pressable
            key={item.listId}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/list/[id]', params: { id: item.listId } })}
            style={({ pressed }) => ({ marginTop: i ? 10 : 0, opacity: pressed ? 0.6 : 1 })}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 8, height: 8, backgroundColor: list?.color ?? p.muted, borderRadius: list?.kind === 'project' ? 1 : 4, transform: list?.kind === 'project' ? [{ rotate: '45deg' }] : undefined }} />
              <Text style={{ color: p.fg, fontSize: 14, flex: 1 }} numberOfLines={1}>
                {list?.name ?? '(lista)'}
              </Text>
              <Text style={{ color: p.muted, fontSize: 12, fontVariant: ['tabular-nums'] }}>
                {item.open} {pluralForm(item.open, ['otwarte', 'otwarte', 'otwartych'])} · {pct}%
              </Text>
            </View>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: p.border, marginTop: 4, overflow: 'hidden' }}>
              <View style={{ height: 6, width: `${pct}%`, backgroundColor: p.accent, borderRadius: 3 }} />
            </View>
          </Pressable>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 12, paddingTop: 10 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { width: '48.5%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  card: { marginHorizontal: 12, marginTop: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12 },
  cardHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 4, marginBottom: 8 },
  plot: { flexDirection: 'row', alignItems: 'flex-end', height: CHART_H + 16, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
  column: { flex: 1, height: '100%', flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  axis: { flexDirection: 'row', gap: 2, marginTop: 3 },
  tick: { flex: 1, fontSize: 10, textAlign: 'center' },
});
