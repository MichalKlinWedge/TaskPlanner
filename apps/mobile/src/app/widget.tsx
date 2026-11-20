import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { requestPinWidget } from 'react-native-android-widget';

import { Button, P, Row, Screen, Section, usePalette } from '@/components/ui';
import { localEngine } from '@/lib/sync';
import { seedDemoTasks, todayTasks, toggleTask, type TaskRow } from '@/lib/tasks';
import { formatClock, localToday } from '@/lib/time';
import { refreshWidgets } from '@/widget/refresh';
import { widgetLog, type WidgetLog } from '@/widget/task-handler';
import { HABITS_WIDGET } from '@/widget/habits-widget';
import { QUICK_ADD_WIDGET } from '@/widget/quick-add-widget';
import { TODAY_WIDGET } from '@/widget/today-widget';

/** Nazwy z `app.json` (plugin `react-native-android-widget`). */
const PIN = [
  { name: TODAY_WIDGET, title: 'Dziś', label: 'TaskPlanner — Dziś' },
  { name: QUICK_ADD_WIDGET, title: 'Szybkie dodawanie', label: 'TaskPlanner — Szybkie dodawanie' },
  { name: HABITS_WIDGET, title: 'Nawyki', label: 'TaskPlanner — Nawyki' },
];

export default function Today() {
  const p = usePalette();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [log, setLog] = useState<WidgetLog[]>([]);

  const load = useCallback(async () => {
    setTasks(await todayTasks());
    setLog(widgetLog().slice(-8).reverse());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Zmiana z innego miejsca (synchronizacja, zadanie w tle w tym samym procesie) → odświeżenie.
  useEffect(() => {
    let off: (() => void) | undefined;
    void localEngine().then((engine) => {
      off = engine.watch(['tasks', 'task_completions'], () => void load());
    });
    return () => off?.();
  }, [load]);

  const toggle = async (id: string) => {
    await toggleTask(id);
    await load();
    await refreshWidgets();
  };

  const today = localToday();
  return (
    <Screen>
      <Section title={`Dziś · ${tasks.filter((t) => t.status !== 'done').length}`}>
        {tasks.length === 0 ? <P muted>Brak zadań — dodaj przykładowe.</P> : null}
        {tasks.map((t) => (
          <Pressable key={t.id} onPress={() => void toggle(t.id)} style={{ flexDirection: 'row', gap: 10, paddingVertical: 6, alignItems: 'center' }}>
            <Text style={{ fontSize: 20, color: t.status === 'done' ? p.muted : p.accent }}>{t.status === 'done' ? '☑' : '☐'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.status === 'done' ? p.muted : t.due_date && t.due_date < today ? p.bad : p.fg, textDecorationLine: t.status === 'done' ? 'line-through' : 'none' }}>
                {t.title}
              </Text>
              <Text style={{ color: p.muted, fontSize: 12 }}>
                {[t.due_date !== today ? t.due_date : null, t.due_time, t.recurrence ? 'cykliczne' : null].filter(Boolean).join(' · ')}
              </Text>
            </View>
          </Pressable>
        ))}
      </Section>
      <Row>
        <Button
          title="Dodaj przykładowe zadania"
          onPress={async () => {
            await seedDemoTasks();
            await load();
            await refreshWidgets();
          }}
        />
        <Button kind="secondary" title="Odśwież widżety" onPress={() => void refreshWidgets()} />
      </Row>
      <Section title="Dodaj widżet na ekran główny">
        <Row>
          {PIN.map((w) => (
            <Button
              key={w.name}
              kind="secondary"
              title={w.title}
              onPress={async () => {
                const ok = await requestPinWidget({ widgetName: w.name });
                if (!ok) Alert.alert('Widżet', `Launcher nie obsługuje przypinania — dodaj „${w.label}” z listy widżetów (długie przytrzymanie ekranu głównego).`);
              }}
            />
          ))}
        </Row>
      </Section>
      <Section title="Dziennik widżetów (zdarzenia bez ekranu)">
        {log.length === 0 ? <P muted>Brak zdarzeń.</P> : null}
        {log.map((l) => (
          <P key={l.at} mono tone={l.ok ? undefined : 'bad'}>
            {formatClock(l.at)} {l.widget} {l.action}{l.changed === false ? ' (bez zmian)' : ''} {l.ms} ms {l.error ?? ''}
          </P>
        ))}
      </Section>
    </Screen>
  );
}
