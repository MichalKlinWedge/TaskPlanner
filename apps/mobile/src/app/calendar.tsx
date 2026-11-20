import { CalendarBody, CalendarContainer, CalendarHeader, type EventItem, type OnEventResponse } from '@howljs/calendar-kit';
import { applyFilter, isEmptyFilter, type FilterQuery } from '@taskplanner/core';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';

import { FilterBar, type FilterField } from '@/components/filter-bar';
import { P, Screen, Section } from '@/components/ui';
import { useView } from '@/lib/app-data';
import { deviceEvents, taskBlocks, type DayItem, type DeviceEvents } from '@/lib/day-items';
import { moveTaskBlock } from '@/lib/tasks';
import { toLocalDate, toLocalTime } from '@/lib/time';
import { refreshWidgets } from '@/widget/refresh';

/** Kalendarz pokazuje dzisiejsze zadania z godziną — warunki terminu i godziny nic tu nie zmieniają. */
const HIDDEN: FilterField[] = ['due', 'hasTime'];

const toEvent = (item: DayItem): EventItem => ({
  id: item.id,
  title: item.taskId ? `✓ ${item.title}` : item.title,
  color: item.color,
  start: item.allDay ? { date: toLocalDate(item.start) } : { dateTime: item.start.toISOString() },
  end: item.allDay ? { date: toLocalDate(item.end) } : { dateTime: item.end.toISOString() },
});

/**
 * PoC-4: widok dnia z @howljs/calendar-kit — wydarzenia telefonu + zadania; przeciągnięcie bloku zadania
 * zmienia jego czas. Chipy filtra zawężają bloki zadań (wydarzenia telefonu zostają); filtr trwa do
 * opuszczenia ekranu, nie jest zapisywany.
 */
export default function CalendarScreen() {
  const { data, today } = useView();
  const [items, setItems] = useState<DayItem[]>([]);
  const [filter, setFilter] = useState<FilterQuery>({});
  const [info, setInfo] = useState<DeviceEvents | null>(null);
  const [last, setLast] = useState<string | null>(null);

  const load = useCallback(async () => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + 7 * 86_400_000);
    const [device, tasks] = await Promise.all([deviceEvents(new Date(from.getTime() - 86_400_000), to), taskBlocks()]);
    setInfo(device);
    setItems([...device.items, ...tasks]);
  }, []);

  const events = useMemo(() => {
    if (isEmptyFilter(filter)) return items.map(toEvent);
    const shown = new Set(applyFilter(data.tasks, filter, today).map((t) => t.id));
    return items.filter((item) => !item.taskId || shown.has(item.taskId)).map(toEvent);
  }, [items, filter, data.tasks, today]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onDragEnd = async (event: OnEventResponse) => {
    const started = Date.now();
    if (!event.id.startsWith('task:') || !event.start.dateTime || !event.end.dateTime) {
      setLast('Wydarzenia z kalendarza telefonu są tylko do odczytu.');
      await load();
      return;
    }
    const start = new Date(event.start.dateTime);
    const end = new Date(event.end.dateTime);
    await moveTaskBlock(event.id.slice(5), toLocalDate(start), toLocalTime(start), (end.getTime() - start.getTime()) / 60_000);
    setLast(`Zapisano ${toLocalTime(start)}–${toLocalTime(end)} (${Date.now() - started} ms, lokalna baza + outbox)`);
    await load();
    await refreshWidgets().catch(() => undefined);
  };

  return (
    <Screen scroll={false}>
      <Section>
        <P muted>
          {info
            ? info.granted
              ? `Kalendarze telefonu: ${info.calendars}, wydarzeń (8 dni): ${info.items.length}, odczyt ${info.ms} ms${info.error ? ` · błąd: ${info.error}` : ''}`
              : 'Brak dostępu do kalendarza.'
            : 'Wczytywanie…'}
        </P>
        <P muted>Przytrzymaj blok zadania (✓), przeciągnij albo rozciągnij dolną krawędź.</P>
        {last ? <P tone="ok">{last}</P> : null}
        <FilterBar query={filter} onChange={setFilter} hide={HIDDEN} />
      </Section>
      <View style={{ flex: 1, minHeight: 480 }}>
        <CalendarContainer numberOfDays={1} events={events} allowDragToEdit scrollToNow onDragEventEnd={onDragEnd} useHaptic locale="pl" initialLocales={{ pl: { weekDayShort: 'nd_pn_wt_śr_cz_pt_sb'.split('_'), meridiem: { ante: '', post: '' }, more: 'więcej' } }}>
          <CalendarHeader />
          <CalendarBody hourFormat="HH:mm" />
        </CalendarContainer>
      </View>
    </Screen>
  );
}
