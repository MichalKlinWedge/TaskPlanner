/**
 * Oś czasu na telefonie (Etap 6, poza D7 — przegląd bez przeciągania): projekty → zadania →
 * podzadania z paskami w skali dzień / tydzień / miesiąc, z `core` `timelineModel` jak na webie.
 * „Bez terminu” pokazuje też zadania bez daty jako wiersze bez paska (`withUndated`); wiersz bez
 * własnej daty rysuje cienki zakres potomków (`timelineRowSpans`). Lewa kolumna stoi, oś przewija się
 * w poziomie (nagłówek okresów idzie za nią), dotknięcie wiersza otwiera zadanie albo projekt.
 * „Ścieżka krytyczna” (core `criticalPath`, zapas w dniach roboczych z ustawień) barwi zadania bez zapasu
 * na pomarańczowo, przy pozostałych pokazuje zapas („+3”) i wypisuje ścieżkę każdego projektu.
 * Jak na webie, ale tylko do podglądu (D7): filtr projektów (core `visibleProjects`, ukryte w kv),
 * lista naruszeń zależności i ścieżka krytyczna z tytułami otwierającymi zadanie, strzałki zależności
 * (koniec poprzednika → początek następnika; czerwone = naruszenie, pomarańczowe = ścieżka krytyczna).
 * Przy tytule znaczki osób (odpowiedzialny pełny, uczestnicy w obrysie — jak na webie); szerokość lewej
 * kolumny zmienia uchwyt na krawędzi nagłówka „Zadanie”, zapamiętana w kv (`timeline.left`).
 */
import {
  addDays,
  assigneeOf,
  collaboratorBadge,
  dayMonth,
  daysBetween,
  plural,
  projectFilterLabel,
  timelineGridSheet,
  timelineModel,
  timelinePeriods,
  timelineRowSpans,
  timelineSheet,
  type Dependency,
  type LocalDate,
  type TimelineRow,
  type TimelineScale,
  visibleProjects,
} from '@taskplanner/core';
import { router, Stack } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTaskActions } from '@/components/actions';
import { ExportChip } from '@/components/export-button';
import { WorkspaceSwitcher } from '@/components/header';
import { pickMany } from '@/components/pickers';
import { Chip, usePalette } from '@/components/ui';
import { useView } from '@/lib/app-data';
import { useLocalQuery } from '@/lib/local-query';
import { mutate } from '@/lib/sync';

const SCALE_KEY = 'timeline.scale';
const UNDATED_KEY = 'timeline.undated';
const CRITICAL_KEY = 'timeline.critical';
const ARROWS_KEY = 'timeline.arrows';
/** Ukryte projekty (JSON z listą id, jak na webie `tp-timeline-hidden`). */
const HIDDEN_KEY = 'timeline.hidden';
/** Szerokość lewej kolumny (px, jak na webie `tp-timeline-widths`). */
const LEFT_KEY = 'timeline.left';
/** Kolor ścieżki krytycznej (jak na webie `--critical`). */
const CRITICAL = '#ea580c';
const SCALES: Record<TimelineScale, { label: string; dayWidth: number }> = {
  day: { label: 'Dzień', dayWidth: 34 },
  week: { label: 'Tydzień', dayWidth: 9 },
  month: { label: 'Miesiąc', dayWidth: 3 },
};
const ROW = 40;
const ARROW_WIDTH = 1.5;
const LEFT = 150;
const MIN_LEFT = 100;
/** Znaczki osób przy tytule: najwyżej tyle (jak na webie). */
const PEOPLE_SHOWN = 4;
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

const readHidden = (): ReadonlySet<string> => {
  try {
    const ids: unknown = JSON.parse(readStored(HIDDEN_KEY) ?? '[]');
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
};

interface Segment {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Odcinki strzałki zależności (łamana pozioma / pionowa) od końca paska poprzednika do początku następnika. */
const ARROW_STUB = 6;
function arrowSegments(x1: number, y1: number, x2: number, y2: number): Segment[] {
  const out: Segment[] = [];
  const line = (ax: number, ay: number, bx: number, by: number) =>
    out.push(ay === by ? { left: Math.min(ax, bx), top: ay, width: Math.abs(bx - ax), height: 0 } : { left: ax, top: Math.min(ay, by), width: 0, height: Math.abs(by - ay) });
  const xm = x1 + ARROW_STUB;
  line(x1, y1, xm, y1);
  if (x2 - ARROW_STUB >= xm) {
    line(xm, y1, xm, y2);
    line(xm, y2, x2, y2);
  } else {
    // Następnik zaczyna się przed końcem poprzednika: obejście po granicy wiersza.
    const yb = y1 + (y2 >= y1 ? ROW / 2 : -ROW / 2);
    line(xm, y1, xm, yb);
    line(xm, yb, x2 - ARROW_STUB, yb);
    line(x2 - ARROW_STUB, yb, x2 - ARROW_STUB, y2);
    line(x2 - ARROW_STUB, y2, x2, y2);
  }
  return out;
}

export default function TimelineScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { data, today, ctx } = useView();
  const [scale, setScaleState] = useState<TimelineScale>(() => {
    const v = readStored(SCALE_KEY);
    return v === 'day' || v === 'week' || v === 'month' ? v : 'week';
  });
  const [withUndated, setWithUndatedState] = useState(() => readStored(UNDATED_KEY) !== '0');
  const [showCritical, setShowCriticalState] = useState(() => readStored(CRITICAL_KEY) === '1');
  const [showArrows, setShowArrowsState] = useState(() => readStored(ARROWS_KEY) !== '0');
  const [hidden, setHiddenState] = useState<ReadonlySet<string>>(readHidden);
  const { notify } = useTaskActions();
  // Lewa kolumna: najwyżej ¾ ekranu, żeby oś zawsze było widać.
  const { width: screenWidth } = useWindowDimensions();
  const maxLeft = Math.max(MIN_LEFT, Math.round(screenWidth * 0.75));
  const leftWidth = useSharedValue(Math.min(maxLeft, Math.max(MIN_LEFT, Number(readStored(LEFT_KEY)) || LEFT)));
  const leftStart = useSharedValue(0);
  const saveLeft = (w: number) => store(LEFT_KEY, String(Math.round(w)));
  const resizeLeft = usePanGesture({
    activeOffsetX: [-4, 4],
    failOffsetY: [-12, 12],
    onActivate: () => {
      'worklet';
      leftStart.value = leftWidth.value;
    },
    onUpdate: (e) => {
      'worklet';
      leftWidth.value = Math.min(maxLeft, Math.max(MIN_LEFT, leftStart.value + e.translationX));
    },
    onDeactivate: () => {
      'worklet';
      scheduleOnRN(saveLeft, leftWidth.value);
    },
  });
  const leftStyle = useAnimatedStyle(() => ({ width: leftWidth.value }));
  // Zwinięte zadania — do wyjścia z ekranu; zwinięte projekty — w profilu (`settings.timeline.collapsed`, jak na webie),
  // więc zostają na każdym urządzeniu. Wiersz projektu ma id listy.
  const [closedTasks, setClosedTasks] = useState<ReadonlySet<string>>(new Set());
  const collapsedProjects = data.settings.timeline.collapsed;
  const closed = useMemo(() => new Set([...closedTasks, ...collapsedProjects]), [closedTasks, collapsedProjects]);
  const setScale = (s: TimelineScale) => {
    setScaleState(s);
    store(SCALE_KEY, s);
  };
  const setWithUndated = (on: boolean) => {
    setWithUndatedState(on);
    store(UNDATED_KEY, on ? '1' : '0');
  };
  const setShowCritical = (on: boolean) => {
    setShowCriticalState(on);
    store(CRITICAL_KEY, on ? '1' : '0');
  };
  const setShowArrows = (on: boolean) => {
    setShowArrowsState(on);
    store(ARROWS_KEY, on ? '1' : '0');
  };
  const setHidden = (next: ReadonlySet<string>) => {
    setHiddenState(next);
    store(HIDDEN_KEY, JSON.stringify([...next]));
  };

  const rows = useLocalQuery(['task_dependencies'], (engine) =>
    engine.db.all<{ id: string; predecessor_id: string; successor_id: string; lag_days: number }>('select id, predecessor_id, successor_id, lag_days from task_dependencies where deleted_at is null'),
  );
  const deps = useMemo((): Dependency[] => (rows ?? []).map((r) => ({ id: r.id, predecessorId: r.predecessor_id, successorId: r.successor_id, lagDays: Number(r.lag_days) || 0 })), [rows]);

  const allProjects = useMemo(
    () => data.lists.filter((l) => l.kind === 'project' && (!ctx.workspaceId || l.workspaceId === ctx.workspaceId)).map((l) => ({ id: l.id, name: l.name, color: l.color, startDate: l.startDate, endDate: l.endDate })),
    [data.lists, ctx.workspaceId],
  );
  const projects = useMemo(() => visibleProjects(allProjects, hidden), [allProjects, hidden]);
  // Ukryte projekty spoza tej przestrzeni zostają ukryte przy każdej zmianie wyboru.
  const hiddenElsewhere = () => [...hidden].filter((id) => !allProjects.some((pr) => pr.id === id));
  const pickProjects = () =>
    void pickMany(
      'Projekty na osi',
      allProjects.map((pr) => ({ label: pr.name, value: pr.id, selected: !hidden.has(pr.id) })),
    ).then((shown) => {
      if (!shown) return;
      const keep = new Set(shown);
      setHidden(new Set([...hiddenElsewhere(), ...allProjects.filter((pr) => !keep.has(pr.id)).map((pr) => pr.id)]));
    });
  const workdays = data.settings.workHours.days;
  const model = useMemo(() => timelineModel(projects, data.tasks, deps, { withUndated, workdays }), [projects, data.tasks, deps, withUndated, workdays]);
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
  const toggle = (row: TimelineRow) => {
    if (row.kind === 'project') {
      const known = new Set(data.lists.filter((l) => l.kind === 'project').map((l) => l.id));
      const next = collapsedProjects.filter((id) => id !== row.id && known.has(id));
      if (!collapsedProjects.includes(row.id)) next.push(row.id);
      void mutate('profiles', data.userId, { settings: { ...data.settings, timeline: { ...data.settings.timeline, collapsed: next } } }).catch((e: unknown) => notify(String(e)));
      return;
    }
    setClosedTasks((all) => {
      const next = new Set(all);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  };

  // Strzałki zależności między widocznymi wierszami z paskiem (pod zwiniętym rodzicem — brak).
  const arrows = useMemo(() => {
    if (!showArrows) return [];
    const index = new Map(visible.map(({ row }, i) => [row.id, i]));
    const violated = new Set(model.violations.map((v) => v.dependency.id));
    const critical = new Set(showCritical ? model.criticalLinks : []);
    const out: { id: string; tone: 'bad' | 'critical' | 'plain'; segments: Segment[]; x: number; y: number }[] = [];
    for (const link of model.links) {
      const a = index.get(link.predecessorId);
      const b = index.get(link.successorId);
      const from = spans.get(link.predecessorId);
      const to = spans.get(link.successorId);
      if (a === undefined || b === undefined || !from || !to) continue;
      const x1 = (daysBetween(origin, from.end) + 1) * dayWidth;
      const x2 = daysBetween(origin, to.start) * dayWidth;
      const y1 = a * ROW + ROW / 2;
      const y2 = b * ROW + ROW / 2;
      out.push({ id: link.id, tone: violated.has(link.id) ? 'bad' : critical.has(link.id) ? 'critical' : 'plain', segments: arrowSegments(x1, y1, x2, y2), x: x2, y: y2 });
    }
    return out;
  }, [showArrows, showCritical, visible, model, spans, origin, dayWidth]);
  // Kolejne zadania ścieżki połączone zależnością na ścieżce: „→”, równoległe: „·” (jak na webie).
  const criticalPairs = useMemo(() => {
    const onPath = new Set(model.criticalLinks);
    return new Set(model.links.filter((d) => onPath.has(d.id)).map((d) => `${d.predecessorId}>${d.successorId}`));
  }, [model]);
  const titleOf = (id: string) => data.tasks.find((t) => t.id === id)?.title ?? '?';
  const tasksById = useMemo(() => new Map(data.tasks.map((t) => [t.id, t])), [data.tasks]);
  /** Osoby zadania: odpowiedzialny, potem uczestnicy (bez nieznanych), jak web `PeopleBadges`. */
  const peopleOf = (id: string) => {
    const task = tasksById.get(id);
    if (!task) return [];
    const assignee = assigneeOf(task.assigneeId, data.collaborators);
    return [
      ...(assignee ? [{ person: assignee, assignee: true }] : []),
      ...(data.participants.get(id) ?? [])
        .filter((pid) => pid !== task.assigneeId)
        .flatMap((pid) => assigneeOf(pid, data.collaborators) ?? [])
        .map((person) => ({ person, assignee: false })),
    ];
  };
  const openTask = (id: string) => router.push({ pathname: '/task/[id]', params: { id } });

  const todayX = x(today);
  const showLabel = (label: string, w: number) => (w >= 28 ? label : '');

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <Stack.Screen options={{ title: 'Oś czasu', headerRight: () => <WorkspaceSwitcher /> }} />
      <View style={styles.top}>
        {(Object.keys(SCALES) as TimelineScale[]).map((s) => (
          <Chip key={s} label={SCALES[s].label} selected={scale === s} onPress={() => setScale(s)} />
        ))}
        <Chip label="Dziś" onPress={() => scrollToday()} />
        <Chip label="Bez terminu" selected={withUndated} onPress={() => setWithUndated(!withUndated)} />
        <Chip label="Ścieżka krytyczna" selected={showCritical} onPress={() => setShowCritical(!showCritical)} />
        <Chip label="Zależności" selected={showArrows} onPress={() => setShowArrows(!showArrows)} />
        {allProjects.length ? <Chip label={`Projekty: ${projectFilterLabel(allProjects, hidden)}`} selected={projects.length !== allProjects.length} onPress={pickProjects} /> : null}
        {/* Jak na webie: karta „Oś czasu” = siatka okresów bieżącej skali, „Szczegóły” = wiersze z zależnościami. */}
        <ExportChip
          title="Oś czasu"
          sheets={() => ({
            count: model.rows.filter((r) => r.kind === 'task').length,
            sheets: [timelineGridSheet(model, { scale, today, colors: new Map(projects.map((pr) => [pr.id, pr.color])), firstDayOfWeek: ctx.firstDayOfWeek }), timelineSheet(model, data.tasks, 'Szczegóły')],
          })}
        />
      </View>
      <Text style={[styles.info, { color: p.muted }]}>
        {projects.length === allProjects.length ? plural(projects.length, ['projekt', 'projekty', 'projektów']) : `${projects.length} z ${plural(allProjects.length, ['projektu', 'projektów', 'projektów'])}`} ·{' '}
        {plural(model.links.length, ['zależność', 'zależności', 'zależności'])}
        {model.undated ? ` · ${plural(model.undated, ['zadanie', 'zadania', 'zadań'])} bez terminu${withUndated ? '' : ' poza osią'}` : ''}
      </Text>
      {model.violations.length ? (
        <View style={[styles.box, { borderColor: p.bad }]}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: p.bad }}>⚠ {plural(model.violations.length, ['naruszona zależność', 'naruszone zależności', 'naruszonych zależności'])}</Text>
          <ScrollView style={styles.boxList} nestedScrollEnabled>
            {model.violations.map((v) => (
              <Text key={v.dependency.id} style={{ fontSize: 12, color: p.fg, paddingVertical: 2 }}>
                <Text style={{ color: p.accent }} onPress={() => openTask(v.dependency.successorId)}>
                  „{titleOf(v.dependency.successorId)}”
                </Text>{' '}
                zaczyna się {plural(v.days, ['dzień', 'dni', 'dni'])} za wcześnie po{' '}
                <Text style={{ color: p.accent }} onPress={() => openTask(v.dependency.predecessorId)}>
                  „{titleOf(v.dependency.predecessorId)}”
                </Text>
                {v.dependency.lagDays ? ` (+${plural(v.dependency.lagDays, ['dzień', 'dni', 'dni'])} odstępu)` : ''}
              </Text>
            ))}
          </ScrollView>
        </View>
      ) : null}
      {showCritical && projects.length ? (
        <View style={[styles.box, { borderColor: CRITICAL }]}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: CRITICAL }}>Ścieżka krytyczna</Text>
          {model.criticalChains.length ? (
            <ScrollView style={styles.boxList} nestedScrollEnabled>
              {model.criticalChains.map((c) => (
                <Text key={c.projectId} style={{ fontSize: 12, color: p.fg, paddingVertical: 2 }}>
                  <Text style={{ fontWeight: '700' }}>{projects.find((pr) => pr.id === c.projectId)?.name}</Text> — koniec {dayMonth(c.end)}:{' '}
                  {c.taskIds.map((id, i) => (
                    <Text key={id}>
                      {i ? (criticalPairs.has(`${c.taskIds[i - 1]}>${id}`) ? ' → ' : ' · ') : ''}
                      <Text style={{ color: p.accent }} onPress={() => openTask(id)}>
                        {titleOf(id)}
                      </Text>
                    </Text>
                  ))}
                </Text>
              ))}
            </ScrollView>
          ) : (
            <Text style={{ fontSize: 12, color: p.muted }}>Brak otwartych zadań z terminem w widocznych projektach.</Text>
          )}
        </View>
      ) : null}

      {!projects.length ? (
        allProjects.length ? (
          <View style={styles.emptyBox}>
            <Text style={[styles.empty, { color: p.muted }]}>Żaden projekt nie jest wybrany.</Text>
            <Chip label="Pokaż wszystkie" onPress={() => setHidden(new Set(hiddenElsewhere()))} />
          </View>
        ) : (
          <Text style={[styles.empty, { color: p.muted }]}>Brak projektów w tej przestrzeni — oś pokazuje listy typu „projekt”.</Text>
        )
      ) : (
        <ScrollView stickyHeaderIndices={[0]} contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}>
          <View style={[styles.headerRow, { backgroundColor: p.bg, borderColor: p.border }]}>
            <Animated.View style={[styles.left, leftStyle, { height: HEADER, justifyContent: 'flex-end', borderColor: p.border, backgroundColor: p.bg }]}>
              <Text style={{ color: p.muted, fontSize: 12, paddingBottom: 4 }}>Zadanie</Text>
              <GestureDetector gesture={resizeLeft}>
                <View style={styles.leftHandle} accessibilityLabel="Zmień szerokość kolumny zadań">
                  <View style={[styles.leftGrip, { backgroundColor: p.muted }]} />
                </View>
              </GestureDetector>
            </Animated.View>
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
            <Animated.View style={[styles.left, leftStyle, { borderColor: p.border }]}>
              {visible.map(({ row, depth }) => {
                const people = row.kind === 'task' ? peopleOf(row.id) : [];
                return (
                  <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={`Otwórz „${row.title}”`} onPress={() => open(row)} style={[styles.titleCell, { borderColor: p.border, paddingLeft: 4 + depth * INDENT }]}>
                    {row.hasChildren ? (
                      <Pressable accessibilityRole="button" accessibilityLabel={closed.has(row.id) ? 'Rozwiń' : 'Zwiń'} hitSlop={8} onPress={() => toggle(row)} style={styles.toggle}>
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
                    {people.slice(0, PEOPLE_SHOWN).map(({ person, assignee }) => (
                      <Text
                        key={person.id}
                        accessibilityLabel={`${assignee ? 'Odpowiedzialny' : 'Uczestnik'}: ${person.name}`}
                        style={[styles.person, assignee ? { backgroundColor: `${p.accent}2e`, borderColor: 'transparent', color: p.fg } : { borderColor: p.accent, color: p.accent }]}
                      >
                        {collaboratorBadge(person)}
                      </Text>
                    ))}
                    {people.length > PEOPLE_SHOWN ? <Text style={{ fontSize: 10, color: p.muted }}>+{people.length - PEOPLE_SHOWN}</Text> : null}
                    {showCritical && row.float !== null ? (
                      <Text style={{ fontSize: 11, color: row.critical ? CRITICAL : p.muted, fontWeight: row.critical ? '700' : '400' }}>{row.critical ? '●' : `+${row.float}`}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </Animated.View>
            <Animated.ScrollView ref={chart} horizontal showsHorizontalScrollIndicator onScroll={onScroll} scrollEventThrottle={16} onContentSizeChange={placeOnToday} style={{ flex: 1 }}>
              <View style={{ width, height: visible.length * ROW }}>
                {periods.map((period) => (
                  <View key={period.start} style={[styles.gridLine, { left: daysBetween(origin, period.start) * dayWidth, height: visible.length * ROW, backgroundColor: p.border }]} />
                ))}
                <View style={[styles.today, { left: todayX + (scale === 'day' ? dayWidth / 2 : 0), height: visible.length * ROW, backgroundColor: p.bad }]} />
                {arrows.map((a) => {
                  const color = a.tone === 'bad' ? p.bad : a.tone === 'critical' ? CRITICAL : p.muted;
                  return (
                    <View key={a.id} pointerEvents="none" style={StyleSheet.absoluteFill}>
                      {a.segments.map((seg, i) => (
                        <View
                          key={i}
                          style={[
                            styles.arrowLine,
                            {
                              left: seg.left - (seg.width ? 0 : ARROW_WIDTH / 2),
                              top: seg.top - (seg.height ? 0 : ARROW_WIDTH / 2),
                              width: seg.width || ARROW_WIDTH,
                              height: seg.height || ARROW_WIDTH,
                              backgroundColor: color,
                            },
                          ]}
                        />
                      ))}
                      <View style={[styles.arrowHead, { left: a.x - 5, top: a.y - 4, borderLeftColor: color }]} />
                    </View>
                  );
                })}
                {visible.map(({ row }, i) => {
                  const span = spans.get(row.id);
                  if (!span) return null;
                  const critical = showCritical && row.critical;
                  const color = critical ? CRITICAL : (colors.get(row.projectId) ?? p.accent);
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
                          borderColor: row.violated ? p.bad : critical ? CRITICAL : 'transparent',
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
  box: { marginHorizontal: 12, marginBottom: 8, padding: 8, gap: 2, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8 },
  boxList: { maxHeight: 112 },
  emptyBox: { alignItems: 'center', gap: 4 },
  arrowLine: { position: 'absolute', opacity: 0.85 },
  arrowHead: { position: 'absolute', width: 0, height: 0, borderTopWidth: 4, borderBottomWidth: 4, borderLeftWidth: 5, borderTopColor: 'transparent', borderBottomColor: 'transparent' },
  headerRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  left: { width: LEFT, borderRightWidth: StyleSheet.hairlineWidth, paddingLeft: 8 },
  titleCell: { height: ROW, flexDirection: 'row', alignItems: 'center', gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, paddingRight: 6 },
  toggle: { width: 14, alignItems: 'center' },
  leftHandle: { position: 'absolute', right: -10, top: 0, bottom: 0, width: 20, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  leftGrip: { width: 3, height: 18, borderRadius: 2, opacity: 0.6 },
  person: { fontSize: 10, fontWeight: '600', minWidth: 18, paddingHorizontal: 3, borderRadius: 9, borderWidth: 1, textAlign: 'center', overflow: 'hidden' },
  group: { position: 'absolute', top: 2, height: 20, fontSize: 12, fontWeight: '600', paddingLeft: 4, borderLeftWidth: StyleSheet.hairlineWidth },
  period: { position: 'absolute', top: 22, height: 22, fontSize: 11, textAlign: 'center', paddingTop: 3, borderLeftWidth: StyleSheet.hairlineWidth },
  gridLine: { position: 'absolute', top: 0, width: StyleSheet.hairlineWidth },
  today: { position: 'absolute', top: 0, width: 2, opacity: 0.6 },
  bar: { position: 'absolute', height: ROW - 18, borderRadius: 5, borderWidth: 2, overflow: 'hidden' },
  thinBar: { position: 'absolute', height: 8, borderRadius: 4, borderWidth: 1 },
  progress: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.25)' },
});
