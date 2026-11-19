import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { P, Section, usePalette } from '@/components/ui';
import { deviceEvents, taskBlocks, type DayItem } from '@/lib/day-items';
import { moveTaskBlock } from '@/lib/tasks';
import { localToday, toLocalTime } from '@/lib/time';
import { refreshTodayWidget } from '@/widget/refresh';

const HOUR = 64;
const SNAP_MIN = 5;
const LEFT = 52;
const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();
const fmt = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;

/** Blok zadania: przytrzymanie + przeciągnięcie przesuwa, uchwyt na dole zmienia długość (co 5 min). */
function TaskBlock({ item, onCommit }: { item: DayItem; onCommit: (id: string, startMin: number, durationMin: number) => void }) {
  const startMin = minutesOf(item.start);
  const duration = (item.end.getTime() - item.start.getTime()) / 60_000;
  const top = useSharedValue((startMin / 60) * HOUR);
  const height = useSharedValue((duration / 60) * HOUR);
  const baseTop = useSharedValue(top.value);
  const baseHeight = useSharedValue(height.value);
  const active = useSharedValue(0);
  const [label, setLabel] = useState(`${fmt(startMin)}–${fmt(startMin + duration)}`);

  const snap = (px: number) => {
    'worklet';
    const step = (SNAP_MIN / 60) * HOUR;
    return Math.round(px / step) * step;
  };
  const toMin = (px: number) => {
    'worklet';
    return Math.round((px / HOUR) * 60);
  };
  const showLabel = (t: number, h: number) => setLabel(`${fmt(toMinJs(t))}–${fmt(toMinJs(t + h))}`);
  const toMinJs = (px: number) => Math.round((px / HOUR) * 60);

  const move = usePanGesture({
    activateAfterLongPress: 250,
    onActivate: () => {
      'worklet';
      baseTop.value = top.value;
      active.value = 1;
    },
    onUpdate: (e) => {
      'worklet';
      top.value = Math.max(0, Math.min(24 * HOUR - height.value, snap(baseTop.value + e.translationY)));
      scheduleOnRN(showLabel, top.value, height.value);
    },
    onDeactivate: () => {
      'worklet';
      active.value = 0;
      scheduleOnRN(onCommit, item.taskId!, toMin(top.value), toMin(height.value));
    },
  });

  const resize = usePanGesture({
    onActivate: () => {
      'worklet';
      baseHeight.value = height.value;
      active.value = 1;
    },
    onUpdate: (e) => {
      'worklet';
      height.value = Math.max((15 / 60) * HOUR, snap(baseHeight.value + e.translationY));
      scheduleOnRN(showLabel, top.value, height.value);
    },
    onDeactivate: () => {
      'worklet';
      active.value = 0;
      scheduleOnRN(onCommit, item.taskId!, toMin(top.value), toMin(height.value));
    },
  });

  const style = useAnimatedStyle(() => ({ top: top.value, height: height.value, opacity: active.value ? 0.85 : 1, zIndex: active.value ? 10 : 1 }));

  return (
    <Animated.View style={[styles.block, { backgroundColor: item.color, left: LEFT + 70, right: 8 }, style]}>
      <GestureDetector gesture={move}>
        <View style={{ flex: 1, padding: 6 }}>
          <Text style={styles.blockText} numberOfLines={2}>
            ✓ {item.title}
          </Text>
          <Text style={styles.blockTime}>{label}</Text>
        </View>
      </GestureDetector>
      <GestureDetector gesture={resize}>
        <View style={styles.handle}>
          <View style={styles.grip} />
        </View>
      </GestureDetector>
    </Animated.View>
  );
}

export default function Timeline() {
  const p = usePalette();
  const [items, setItems] = useState<DayItem[]>([]);
  const [last, setLast] = useState<string | null>(null);

  const load = useCallback(async () => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + 86_400_000);
    const [device, tasks] = await Promise.all([deviceEvents(from, to), taskBlocks()]);
    setItems([...device.items.filter((e) => !e.allDay), ...tasks]);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const commit = async (taskId: string, startMin: number, durationMin: number) => {
    const t = Date.now();
    await moveTaskBlock(taskId, localToday(), fmt(startMin), durationMin);
    setLast(`Zapisano ${fmt(startMin)} na ${durationMin} min (${Date.now() - t} ms)`);
    await refreshTodayWidget().catch(() => undefined);
  };

  const now = minutesOf(new Date());
  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{ padding: 12 }}>
        <Section>
          <P muted>Wydarzenia telefonu (szare, z lewej) i zadania z godziną. Przytrzymaj blok, żeby go przesunąć; uchwyt na dole zmienia długość.</P>
          {last ? <P tone="ok">{last}</P> : null}
        </Section>
      </View>
      <ScrollView contentOffset={{ x: 0, y: Math.max(0, (now / 60 - 2) * HOUR) }}>
        <View style={{ height: 24 * HOUR }}>
          {Array.from({ length: 24 }, (_, h) => (
            <View key={h} style={[styles.hour, { top: h * HOUR, borderColor: p.border }]}>
              <Text style={[styles.hourText, { color: p.muted }]}>{String(h).padStart(2, '0')}:00</Text>
            </View>
          ))}
          <View style={[styles.now, { top: (now / 60) * HOUR }]} />
          {items
            .filter((i) => !i.taskId)
            .map((e) => {
              const s = Math.max(0, minutesOf(e.start));
              const d = Math.max(15, (e.end.getTime() - e.start.getTime()) / 60_000);
              return (
                <View key={e.id} style={[styles.event, { top: (s / 60) * HOUR, height: (d / 60) * HOUR, borderColor: e.color }]}>
                  <Text style={{ color: p.fg, fontSize: 11 }} numberOfLines={2}>
                    {toLocalTime(e.start)} {e.title}
                  </Text>
                </View>
              );
            })}
          {items
            .filter((i) => i.taskId)
            .map((item) => (
              <TaskBlock key={`${item.id}-${item.start.getTime()}-${item.end.getTime()}`} item={item} onCommit={(id, s, d) => void commit(id, s, d)} />
            ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  hour: { position: 'absolute', left: 0, right: 0, height: HOUR, borderTopWidth: StyleSheet.hairlineWidth },
  hourText: { width: LEFT, textAlign: 'right', paddingRight: 6, fontSize: 11, marginTop: -7 },
  now: { position: 'absolute', left: LEFT, right: 0, height: 2, backgroundColor: '#dc2626' },
  event: { position: 'absolute', left: LEFT + 4, width: 62, borderLeftWidth: 3, paddingLeft: 3, backgroundColor: 'rgba(113,113,122,0.15)' },
  block: { position: 'absolute', borderRadius: 8, overflow: 'hidden' },
  blockText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  blockTime: { color: '#e0e7ff', fontSize: 11 },
  handle: { height: 14, alignItems: 'center', justifyContent: 'center' },
  grip: { width: 28, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.7)' },
});
