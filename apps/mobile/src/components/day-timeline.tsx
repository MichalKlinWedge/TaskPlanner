/**
 * Własna oś dnia (D16, Etap 5): godziny, wolne okna w godzinach pracy, linia „teraz”, bloki zadań,
 * nawyków i wydarzeń obok siebie przy nakładaniu (`blockLanes`), obramowanie konfliktu. Plan liczy
 * `core` (`blocksForDay`, `conflicts`, `freeSlots`) — tu jest tylko rysowanie i gesty. Z `editable`
 * blok zadania przesuwa się po przytrzymaniu i przeciągnięciu, a uchwyt na dole zmienia długość
 * (co 15 min, `snapMinutes`); zapis robi ekran (`onMove` / `onResize`). Dotknięcie bloku → `onPress`.
 */
import { minutesToTime, PRIORITY, snapMinutes, type Block, type DayPlan, type FreeSlot, type ViewTask } from '@taskplanner/core';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { EventInfo } from '@/lib/calendar-events';

import { usePalette } from './ui';

const GUTTER = 44;
/** Odstęp nad pierwszą godziną (etykieta „GG:00” wystaje nad linię). */
const TOP = 8;
const SNAP = 15;
const HABIT_COLOR = '#059669';

export interface DayTimelineProps {
  plan: DayPlan;
  /** Id bloków w konflikcie (`conflictIds`). */
  hot: ReadonlySet<string>;
  lanes: ReadonlyMap<string, { lane: number; lanes: number }>;
  free: readonly FreeSlot[];
  info: ReadonlyMap<string, EventInfo>;
  tasks: ReadonlyMap<string, ViewTask>;
  /** Zakres osi w minutach od północy dnia (pełne godziny). */
  from: number;
  to: number;
  /** Pikseli na godzinę. */
  hour: number;
  /** Minuta „teraz” (tylko w dzisiejszym dniu). */
  nowMin?: number | null;
  editable?: boolean;
  /** Id zadań ze szkicu ułożenia dnia — bloki przerywane, jeszcze niezapisane. */
  drafted?: ReadonlySet<string>;
  onPress: (block: Block) => void;
  onMove?: (task: ViewTask, startMin: number, durationMin: number) => void;
  onResize?: (task: ViewTask, startMin: number, endMin: number) => void;
}

const clock = (min: number) => minutesToTime(min);

export function DayTimeline(props: DayTimelineProps) {
  const p = usePalette();
  const { plan, from, to, hour } = props;
  const y = (min: number) => ((Math.min(Math.max(min, from), to) - from) / 60) * hour;
  const hours = Array.from({ length: (to - from) / 60 + 1 }, (_, i) => from + i * 60);
  return (
    <View style={{ height: y(to) + TOP + 8, marginTop: TOP }}>
      {hours.map((h) => (
        <View key={h} style={[styles.hour, { top: y(h), borderColor: p.border }]}>
          <Text style={[styles.hourText, { color: p.muted }]}>{String(Math.floor(h / 60) % 24).padStart(2, '0')}:00</Text>
        </View>
      ))}
      <View style={[styles.lane, { height: y(to) }]} pointerEvents="box-none">
        {props.free.map((s) => (
          <View key={s.startMin} pointerEvents="none" style={[styles.free, { top: y(s.startMin), height: y(s.endMin) - y(s.startMin) }]} />
        ))}
        {plan.timed.map((block) => (
          <TimelineBlock key={`${block.kind}:${block.id}:${block.startMin}:${block.endMin}`} block={block} {...props} y={y} />
        ))}
        {props.nowMin != null && props.nowMin >= from && props.nowMin <= to ? <View pointerEvents="none" accessibilityLabel="Teraz" style={[styles.now, { top: y(props.nowMin), backgroundColor: p.bad }]} /> : null}
      </View>
    </View>
  );
}

function TimelineBlock({ block, y, ...props }: DayTimelineProps & { block: Block; y: (min: number) => number }) {
  const p = usePalette();
  const { hour, from, to } = props;
  const task = block.kind === 'task' ? props.tasks.get(block.id) : undefined;
  const source = block.kind === 'event' ? props.info.get(block.id) : undefined;
  const lane = props.lanes.get(`${block.kind}:${block.id}`) ?? { lane: 0, lanes: 1 };
  const hot = props.hot.has(block.id) && !block.passive && !block.virtual;
  const draft = block.kind === 'task' && !!props.drafted?.has(block.id);
  const startMin = Math.max(block.startMin, from);
  const endMin = Math.min(block.endMin, to);
  // Przesuwalne: zadanie (nie przyszłe wystąpienie serii), otwarte, mieszczące się w dniu.
  const draggable = !!(props.editable && task && !draft && !block.virtual && !block.passive && block.startMin >= from && block.endMin <= to);

  // Przesuwanie zmienia tylko `shift` (`translateY` — bez przeliczania układu); `top` stoi do zapisu.
  // Godzinę na żywo rysuje `BlockText` (`live` = 1 od chwytu do zapisu albo powrotu), więc blok
  // z gestami nie renderuje się przy każdym przeskoku — nowe domknięcia workletów kosztowały klatkę.
  const top = useSharedValue(y(startMin));
  const height = useSharedValue(Math.max(18, y(endMin) - y(startMin) - 1));
  const shift = useSharedValue(0);
  const base = useSharedValue(0);
  const active = useSharedValue(0);
  const live = useSharedValue(0);

  const px = (min: number) => (min / 60) * hour;
  const step = px(SNAP);
  const limit = px(to - from);
  const toMin = (value: number) => from + snapMinutes((value / hour) * 60, SNAP);
  const reset = () => {
    top.value = y(startMin);
    height.value = Math.max(18, y(endMin) - y(startMin) - 1);
    shift.value = 0;
    live.value = 0;
  };
  const commitMove = (t: number) => {
    const next = toMin(t);
    if (!task || next === block.startMin) return reset();
    props.onMove?.(task, next, block.endMin - block.startMin);
  };
  const commitResize = (h: number) => {
    const end = toMin(top.value + h);
    if (!task || end === block.endMin) return reset();
    props.onResize?.(task, block.startMin, end);
  };
  const buzz = () => void Haptics.selectionAsync().catch(() => undefined);

  const move = usePanGesture({
    enabled: draggable,
    activateAfterLongPress: 300,
    onActivate: () => {
      'worklet';
      shift.value = 0;
      active.value = 1;
      live.value = 1;
      scheduleOnRN(buzz);
    },
    onUpdate: (e) => {
      'worklet';
      shift.value = Math.max(0, Math.min(limit - height.value, Math.round((top.value + e.translationY) / step) * step)) - top.value;
    },
    onDeactivate: () => {
      'worklet';
      active.value = 0;
      scheduleOnRN(commitMove, top.value + shift.value);
    },
  });
  const resize = usePanGesture({
    enabled: draggable,
    onActivate: () => {
      'worklet';
      base.value = height.value;
      active.value = 1;
      live.value = 1;
    },
    onUpdate: (e) => {
      'worklet';
      height.value = Math.max(step, Math.min(limit - top.value, Math.round((base.value + e.translationY) / step) * step));
    },
    onDeactivate: () => {
      'worklet';
      active.value = 0;
      scheduleOnRN(commitResize, height.value);
    },
  });
  const tap = useTapGesture({ runOnJS: true, onActivate: () => props.onPress(block) });
  const gesture = useExclusiveGestures(move, tap);
  const animated = useAnimatedStyle(() => ({ top: top.value, height: height.value, transform: [{ translateY: shift.value }], opacity: active.value ? 0.85 : 1, zIndex: active.value ? 10 : 1, elevation: active.value ? 6 : 0 }));

  const color = task ? (PRIORITY[task.priority]?.color ?? p.border) : block.kind === 'habit' ? HABIT_COLOR : (source?.color ?? p.muted);
  const event = block.kind === 'event';
  const mark = block.kind === 'habit' ? (block.habitState === 'done' ? '✓ ' : '◎ ') : '';
  const label = `${hot ? '⚠ ' : ''}${mark}${block.title}`;
  const tall = y(endMin) - y(startMin) >= 34;
  const style = [
    styles.block,
    {
      left: `${(lane.lane / lane.lanes) * 100}%` as const,
      width: `${100 / lane.lanes}%` as const,
      borderLeftColor: color,
      backgroundColor: event ? `${color}26` : p.card,
      borderColor: hot ? p.bad : draft ? p.accent : p.border,
      borderWidth: hot ? 2 : draft ? 1 : StyleSheet.hairlineWidth,
      borderStyle: block.virtual || draft ? ('dashed' as const) : ('solid' as const),
      opacity: block.passive || block.virtual ? 0.6 : 1,
    },
  ];
  const a11y = `${clock(block.startMin)}–${clock(block.endMin)} ${block.title}${hot ? ', konflikt' : ''}${draft ? ', szkic' : ''}${source?.calendar ? `, ${source.calendar}` : ''}`;
  const body = (
    <BlockText
      label={label}
      time={`${clock(block.startMin)}–${clock(block.endMin)}`}
      location={source?.location}
      tall={tall}
      struck={!!block.passive && !event}
      live={live}
      top={top}
      shift={shift}
      height={height}
      toMin={toMin}
    />
  );

  if (!draggable)
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={() => props.onPress(block)} style={[...style, { top: y(startMin), height: Math.max(18, y(endMin) - y(startMin) - 1) }]}>
        {body}
      </Pressable>
    );
  return (
    <Animated.View style={[...style, animated]} accessible accessibilityRole="button" accessibilityLabel={a11y} accessibilityHint="Przytrzymaj i przeciągnij, żeby zmienić godzinę" onAccessibilityTap={() => props.onPress(block)}>
      <GestureDetector gesture={gesture}>
        <View style={{ flex: 1 }}>{body}</View>
      </GestureDetector>
      {/* Uchwyt nad dolną krawędzią (nie zabiera miejsca tytułowi krótkiego bloku). */}
      <GestureDetector gesture={resize}>
        <View style={styles.handle} accessibilityLabel="Zmień długość">
          <View style={[styles.grip, { backgroundColor: p.muted }]} />
        </View>
      </GestureDetector>
    </Animated.View>
  );
}

interface BlockTextProps {
  label: string;
  time: string;
  location?: string | null;
  tall: boolean;
  struck: boolean;
  live: SharedValue<number>;
  top: SharedValue<number>;
  shift: SharedValue<number>;
  height: SharedValue<number>;
  toMin: (px: number) => number;
}

/** Tytuł i godzina bloku; w trakcie przesuwania godzina idzie za blokiem (renderuje się tylko ten tekst). */
function BlockText({ live, top, shift, height, toMin, ...props }: BlockTextProps) {
  const p = usePalette();
  const [moved, setMoved] = useState<string | null>(null);
  const show = (t: number | null, h: number) => setMoved(t == null ? null : `${clock(toMin(t))}–${clock(toMin(t + h))}`);
  useAnimatedReaction(
    () => (live.value ? [top.value + shift.value, height.value] : null),
    (now, before) => {
      if (now?.[0] === before?.[0] && now?.[1] === before?.[1]) return;
      scheduleOnRN(show, now ? now[0] : null, now ? now[1] : 0);
    },
  );
  const time = moved ?? props.time;
  return (
    <View style={{ flex: 1, paddingHorizontal: 5, paddingVertical: props.tall ? 2 : 0 }}>
      <Text style={{ color: p.fg, fontSize: props.tall ? 12 : 11, lineHeight: props.tall ? 16 : 14, fontWeight: '600', textDecorationLine: props.struck ? 'line-through' : 'none' }} numberOfLines={props.tall ? 2 : 1}>
        {props.tall ? props.label : `${time} ${props.label}`}
      </Text>
      {props.tall ? (
        <Text style={{ color: p.muted, fontSize: 11 }} numberOfLines={1}>
          {time}
          {props.location ? ` · ${props.location}` : ''}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hour: { position: 'absolute', left: 0, right: 0, borderTopWidth: StyleSheet.hairlineWidth },
  hourText: { width: GUTTER - 6, textAlign: 'right', fontSize: 10, marginTop: -7 },
  lane: { position: 'absolute', top: 0, left: GUTTER, right: 4 },
  free: { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(34,197,94,0.10)' },
  now: { position: 'absolute', left: -4, right: 0, height: 2, zIndex: 20 },
  block: { position: 'absolute', borderRadius: 6, borderLeftWidth: 4, overflow: 'hidden' },
  handle: { position: 'absolute', left: '30%', right: '30%', bottom: 0, height: 12, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 2 },
  grip: { width: 24, height: 3, borderRadius: 2, opacity: 0.6 },
});
