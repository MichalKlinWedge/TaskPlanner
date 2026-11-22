/**
 * Oś czasu na telefonie (Etap 6, poza D7 — przegląd bez przeciągania): projekty → zadania →
 * podzadania z paskami w skali dzień / tydzień / miesiąc, z `core` `timelineModel` jak na webie.
 * „Bez terminu” pokazuje też zadania bez daty jako wiersze bez paska (`withUndated`); wiersz bez
 * własnej daty rysuje cienki zakres potomków (`timelineRowSpans`). Lewa kolumna stoi, oś przewija się
 * w poziomie (nagłówek okresów idzie za nią), dotknięcie wiersza otwiera zadanie albo projekt.
 */
import {
  addDays,
  daysBetween,
  plural,
  timelineModel,
  timelinePeriods,
  timelineRowSpans,
  type Dependency,
  type LocalDate,
  type TimelineRow,
  type TimelineScale,
} from '@taskplanner/core';
import { router, Stack } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Chip, usePalette } from '@/components/ui';
import { useView } from '@/lib/app-data';
import { useLocalQuery } from '@/lib/local-query';

const SCALE_KEY = 'timeline.scale';
const UNDATED_KEY = 'timeline.undated';
const SCALES: Record<TimelineScale, { label: string; dayWidth: number }> = {
  day: { label: 'Dzień', dayWidth: 34 },
  week: { label: 'Tydzień', dayWidth: 9 },
  month: { label: 'Miesiąc', dayWidth: 3 },
};
const ROW = 40;
const LEFT = 150;
const INDENT = 12;
const HEADER = 44;

const readStored = (key: string): string | null => {
  try {
    return Storage.getItemSync(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    Storage.setItemSync(key, value);
  } catch {
    // Brak zapamiętania nie przeszkadza.
  }
};

const validColor = (color: string | null) => (color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null);

export default function TimelineScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { data, today, ctx } = useView();
  const [scale, setScaleState] = useState<TimelineScale>(() => {
    const v = readStored(SCALE_KEY);
    return v === 'day' || v === 'week' || v === 'month' ? v : 'week';
  });
  const [withUndated, setWithUndatedState] = useState(() => readStored(UNDATED_KEY) !== '0');
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const setScale = (s: TimelineScale) => {
    setScaleState(s);
    store(SCALE_KEY, s);
  };
  const setWithUndated = (on: boolean) => {
    setWithUndatedState(on);
    store(UNDATED_KEY, on ? '1' : '0');
  };

  const rows = useLocalQuery(['task_dependencies'], (engine) =>
    engine.db.all<{ id: string; predecessor_id: string; successor_id: string; lag_days: number }>('select id, predecessor_id, successor_id, lag_days from task_dependencies where deleted_at is null'),
  );
  const deps = useMemo((): Dependency[] => (rows ?? []).map((r) => ({ id: r.id, predecessorId: r.predecessor_id, successorId: r.successor_id, lagDays: Number(r.lag_days) || 0 })), [rows]);

  const projects = useMemo(
    () => data.lists.filter((l) => l.kind === 'project' && (!ctx.workspaceId || l.workspaceId === ctx.workspaceId)).map((l) => ({ id: l.id, name: l.name, color: l.color, startDate: l.startDate, endDate: l.endDate })),
    [data.lists, ctx.workspaceId],
  );
  const model = useMemo(() => timelineModel(projects, data.tasks, deps, { withUndated }), [projects, data.tasks, deps, withUndated]);
  const spans = useMemo(() => timelineRowSpans(model.rows), [model.rows]);
  const colors = useMemo(() => new Map(projects.map((pr) => [pr.id, validColor(pr.color)])), [projects]);

  // Wiersze pod zwiniętym rodzicem znikają (z całym poddrzewem).
  const visible = useMemo(() => {
    const hidden = new Set<string>();
    const out: { row: TimelineRow; depth: number }[] = [];
    const depth = new Map<string, number>();
    for (const row of model.rows) {
      if (row.parentId && (hidden.has(row.parentId) || closed.has(row.parentId))) {
        hidden.add(row.id);
        continue;
      }
      const d = row.parentId ? (depth.get(row.parentId) ?? 0) + 1 : 0;
      depth.set(row.id, d);
      out.push({ row, depth: d });
    }
    return out;
  }, [model.rows, closed]);

  // Zakres osi: od 2 tygodni przed dziś (albo początkiem planu) do 2 miesięcy po (albo końcu planu), jak na webie.
  const periods = useMemo(() => {
    let from = addDays(today, -14);
    let to = addDays(today, 60);
    for (const r of model.rows) {
      if (!r.span) continue;
      if (r.span.start < addDays(from, 7)) from = addDays(r.span.start, -7);
      if (r.span.end > addDays(to, -14)) to = addDays(r.span.end, 30);
    }
    return timelinePeriods(from, to, scale, ctx.firstDayOfWeek);
  }, [model.rows, today, scale, ctx.firstDayOfWeek]);
  const { dayWidth } = SCALES[scale];
  const origin = periods[0]?.start ?? today;
  const width = periods.length ? (daysBetween(origin, periods.at(-1)!.end) + 1) * dayWidth : 0;
  const x = (date: LocalDate) => daysBetween(origin, date) * dayWidth;
  const groups = useMemo(() => {
    const out: { label: string; left: number; width: number }[] = [];
    for (const period of periods) {
      const left = daysBetween(origin, period.start) * dayWidth;
      const w = (daysBetween(period.start, period.end) + 1) * dayWidth;
      const last = out.at(-1);
      if (last && last.label === period.group) last.width += w;
      else out.push({ label: period.group, left, width: w });
    }
    return out;
  }, [periods, origin, dayWidth]);

  const scrollX = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollX.value = e.contentOffset.x;
  });
  const headerStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -scrollX.value }] }));
  const chart = useRef<Animated.ScrollView>(null);
  const scrollToday = (animated = true) => chart.current?.scrollTo({ x: Math.max(0, x(today) - 3 * dayWidth - 20), animated });
  // Na „dziś” tylko po otwarciu i zmianie skali / zakresu — nie po każdej zmianie danych.
  const placed = useRef<string | null>(null);
  const placeOnToday = () => {
    const key = `${scale}:${origin}`;
    if (placed.current === key) return;
    placed.current = key;
    scrollToday(false);
  };

  const open = (row: TimelineRow) => {
    if (row.kind === 'project') router.push({ pathname: '/list/[id]', params: { id: row.id } });
    else router.push({ pathname: '/task/[id]', params: { id: row.id } });
  };
  const toggle = (id: string) =>
    setClosed((all) => {
      const next = new Set(all);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const todayX = x(today);
  const showLabel = (label: string, w: number) => (w >= 28 ? label : '');

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <Stack.Screen options={{ title: 'Oś czasu' }} />
      <View style={styles.top}>
        {(Object.keys(SCALES) as TimelineScale[]).map((s) => (
          <Chip key={s} label={SCALES[s].label} selected={scale === s} onPress={() => setScale(s)} />
        ))}
        <Chip label="Dziś" onPress={() => scrollToday()} />
        <Chip label="Bez terminu" selected={withUndated} onPress={() => setWithUndated(!withUndated)} />
      </View>
      <Text style={[styles.info, { color: p.muted }]}>
        {plural(projects.length, ['projekt', 'projekty', 'projektów'])} · {plural(model.links.length, ['zależność', 'zależności', 'zależności'])}
        {model.undated ? ` · ${plural(model.undated, ['zadanie', 'zadania', 'zadań'])} bez terminu${withUndated ? '' : ' poza osią'}` : ''}
        {model.violations.length ? ` · ⚠ ${plural(model.violations.length, ['naruszona zależność', 'naruszone zależności', 'naruszonych zależności'])}` : ''}
      </Text>

      {!projects.length ? (
        <Text style={[styles.empty, { color: p.muted }]}>Brak projektów w tej przestrzeni — oś pokazuje listy typu „projekt”.</Text>
      ) : (
        <ScrollView stickyHeaderIndices={[0]} contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}>
          <View style={[styles.headerRow, { backgroundColor: p.bg, borderColor: p.border }]}>
            <View style={[styles.left, { height: HEADER, justifyContent: 'flex-end', borderColor: p.border, backgroundColor: p.bg }]}>
              <Text style={{ color: p.muted, fontSize: 12, paddingBottom: 4 }}>Zadanie</Text>
            </View>
            <View style={{ flex: 1, overflow: 'hidden', height: HEADER }}>
              <Animated.View style={[{ width, height: HEADER }, headerStyle]}>
                {groups.map((g) => (
                  <Text key={`${g.label}:${g.left}`} numberOfLines={1} style={[styles.group, { left: g.left, width: g.width, color: p.fg, borderColor: p.border }]}>
                    {g.width >= 60 ? g.label : ''}
                  </Text>
                ))}
                {periods.map((period) => {
                  const left = daysBetween(origin, period.start) * dayWidth;
                  const w = (daysBetween(period.start, period.end) + 1) * dayWidth;
                  const current = period.start <= today && today <= period.end;
                  return (
                    <Text
                      key={period.start}
                      numberOfLines={1}
                      style={[styles.period, { left, width: w, color: current ? p.accent : p.muted, borderColor: p.border, fontWeight: current ? '700' : '400' }]}
                    >
                      {showLabel(period.label, w)}
                    </Text>
                  );
                })}
              </Animated.View>
            </View>
          </View>

          <View style={{ flexDirection: 'row' }}>
            <View style={[styles.left, { borderColor: p.border }]}>
              {visible.map(({ row, depth }) => (
                <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={`Otwórz „${row.title}”`} onPress={() => open(row)} style={[styles.titleCell, { borderColor: p.border, paddingLeft: 4 + depth * INDENT }]}>
                  {row.hasChildren ? (
                    <Pressable accessibilityRole="button" accessibilityLabel={closed.has(row.id) ? 'Rozwiń' : 'Zwiń'} hitSlop={8} onPress={() => toggle(row.id)} style={styles.toggle}>
                      <Text style={{ color: p.muted, fontSize: 11 }}>{closed.has(row.id) ? '▸' : '▾'}</Text>
                    </Pressable>
                  ) : (
                    <View style={styles.toggle} />
                  )}
                  <Text
                    numberOfLines={1}
                    style={{
                      flex: 1,
                      fontSize: 13,
                      fontWeight: row.kind === 'project' ? '700' : '400',
                      color: row.done ? p.muted : row.violated ? p.bad : p.fg,
                      textDecorationLine: row.done ? 'line-through' : 'none',
                    }}
                  >
                    {row.title}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Animated.ScrollView ref={chart} horizontal showsHorizontalScrollIndicator onScroll={onScroll} scrollEventThrottle={16} onContentSizeChange={placeOnToday} style={{ flex: 1 }}>
              <View style={{ width, height: visible.length * ROW }}>
                {periods.map((period) => (
                  <View key={period.start} style={[styles.gridLine, { left: daysBetween(origin, period.start) * dayWidth, height: visible.length * ROW, backgroundColor: p.border }]} />
                ))}
                <View style={[styles.today, { left: todayX + (scale === 'day' ? dayWidth / 2 : 0), height: visible.length * ROW, backgroundColor: p.bad }]} />
                {visible.map(({ row }, i) => {
                  const span = spans.get(row.id);
                  if (!span) return null;
                  const color = colors.get(row.projectId) ?? p.accent;
                  const left = x(span.start);
                  const w = Math.max(dayWidth, (daysBetween(span.start, span.end) + 1) * dayWidth);
                  // Projekt i wiersz bez własnej daty (zakres potomków) — cienki pasek.
                  const thin = row.kind === 'project' || !row.span;
                  return (
                    <Pressable
                      key={row.id}
                      accessibilityRole="button"
                      accessibilityLabel={`${row.title}: ${span.start} – ${span.end}`}
                      onPress={() => open(row)}
                      style={[
                        thin ? styles.thinBar : styles.bar,
                        {
                          top: i * ROW + (thin ? ROW / 2 - 4 : 9),
                          left,
                          width: w,
                          backgroundColor: row.done ? p.muted : color,
                          opacity: row.done ? 0.5 : thin ? 0.55 : 0.9,
                          borderColor: row.violated ? p.bad : 'transparent',
                        },
                      ]}
                    >
                      {!thin && row.progress > 0 && row.progress < 100 ? <View style={[styles.progress, { width: `${row.progress}%` }]} /> : null}
                    </Pressable>
                  );
                })}
              </View>
            </Animated.ScrollView>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingTop: 10 },
  info: { fontSize: 12, paddingHorizontal: 12, paddingVertical: 8 },
  empty: { padding: 24, textAlign: 'center' },
  headerRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  left: { width: LEFT, borderRightWidth: StyleSheet.hairlineWidth, paddingLeft: 8 },
  titleCell: { height: ROW, flexDirection: 'row', alignItems: 'center', gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, paddingRight: 6 },
  toggle: { width: 14, alignItems: 'center' },
  group: { position: 'absolute', top: 2, height: 20, fontSize: 12, fontWeight: '600', paddingLeft: 4, borderLeftWidth: StyleSheet.hairlineWidth },
  period: { position: 'absolute', top: 22, height: 22, fontSize: 11, textAlign: 'center', paddingTop: 3, borderLeftWidth: StyleSheet.hairlineWidth },
  gridLine: { position: 'absolute', top: 0, width: StyleSheet.hairlineWidth },
  today: { position: 'absolute', top: 0, width: 2, opacity: 0.6 },
  bar: { position: 'absolute', height: ROW - 18, borderRadius: 5, borderWidth: 2, overflow: 'hidden' },
  thinBar: { position: 'absolute', height: 8, borderRadius: 4, borderWidth: 1 },
  progress: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.25)' },
});
