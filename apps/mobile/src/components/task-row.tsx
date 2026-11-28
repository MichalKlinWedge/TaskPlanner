/**
 * Wiersz zadania (MVP-3): kółko ukończenia w kolorze priorytetu, tytuł, termin / godzina /
 * powtarzanie / postęp podzadań / lista. Gesty: przesunięcie w prawo = ukończ, w lewo = menu
 * terminu; długie przytrzymanie = zaznaczanie (potem dotknięcie dokłada kolejne), dotknięcie =
 * szczegóły zadania. Wirtualne wystąpienie serii (Nadchodzące) — tylko do odczytu.
 *
 * Szybkie otwarcie listy (`docs/WYDAJNOSC.md` § Telefon): gest przesunięcia (`Swipeable` — gest,
 * wartości współdzielone i trzy widoki animowane na wiersz) dochodzi dopiero po pierwszym
 * narysowaniu listy (`RowsInteractive` z `TaskSections`), a metadane to jeden `Text` z jednym zagnieżdżonym.
 * Kolumny, które nie mieszczą się na ekranie, przewijają listę w poziomie (`WideList`) — wtedy bez gestu przesunięcia.
 */
import {
  assigneeOf,
  collaboratorBadge,
  collaboratorBadgeColors,
  columnDate,
  describeRecurrence,
  formatMinutes,
  highlightParts,
  isOpen,
  LIST_COLUMN,
  needsDecision,
  PRIORITY,
  READONLY_LIST_NOTE,
  readableColor,
  relativeDay,
  type ListColumn,
  type LocalDate,
  type ViewTask,
} from '@taskplanner/core';
import { router } from 'expo-router';
import { createContext, Fragment, memo, useContext, useRef, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import Swipeable, { SwipeDirection, type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';

import { listEditable, useAppData } from '@/lib/app-data';

import { useTaskActions } from './actions';
import { rescheduleWithMenu } from './task-menus';
import { usePalette } from './ui';

export interface TaskRowProps {
  task: ViewTask;
  today: LocalDate;
  /** Pokazać termin (w sekcji „Dziś” zbędny). */
  showDate?: boolean;
  /** Nazwa listy w widokach zbiorczych. */
  listName?: string;
  /** Ile minut po godzinie zadania (`minutesLate`) — wyróżnia godzinę; 0 / brak = w czasie. */
  lateMin?: number;
  /** Przycisk „→ Dziś” po prawej (ekran „Zaległe”). */
  onToday?: () => void;
  /** Przycisk „⏱” po prawej (ekran „Zaległe”): wybór „+15 min / +30 min / +1 h” (`overdueLaterOps`). */
  onLater?: () => void;
  depth?: number;
  progress?: { done: number; total: number };
  /** `true`/`false` — węzeł z podzadaniami (zwinięty / rozwinięty); brak — bez podzadań. */
  collapsed?: boolean;
  onCollapse?: () => void;
  /** Przyszłe wystąpienie serii — tylko do odczytu. */
  virtualDate?: LocalDate;
  /** Nawyk odhaczony dziś. */
  habitDone?: boolean;
  tagNames?: readonly string[];
  /** Tagi w kolumnie „Tagi” (bąbelki w kolorze tagu); brak — z `tagNames` bez koloru. */
  tagItems?: readonly { id: string; name: string; color: string | null }[];
  /** Dodatkowe kolumny listy (`view_prefs.columns`, kolejność `orderedColumns`) — po prawej stronie wiersza. */
  columns?: readonly ListColumn[];
  /** Trafienia wyszukiwarki w tytule (`highlights` z `core/search.ts`) — wyróżnione. */
  highlights?: readonly (readonly [number, number])[];
  /** Przed otwarciem szczegółów (np. zapamiętanie w „ostatnio otwieranych” wyszukiwarki). */
  onOpen?: () => void;
}

/**
 * Tekst z wyróżnionymi trafieniami wyszukiwarki (tło jak `<mark>` na webie) — do wstawienia wewnątrz `<Text>`.
 */
export function Highlighted({ text, ranges }: { text: string; ranges: readonly (readonly [number, number])[] }) {
  const background = useColorScheme() === 'dark' ? 'rgba(180, 83, 9, 0.6)' : 'rgba(252, 211, 77, 0.7)';
  return (
    <>
      {highlightParts(text, ranges).map((part, i) =>
        part.hit ? (
          <Text key={i} style={{ backgroundColor: background }}>
            {part.text}
          </Text>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

/** Szerokości kolumn — wspólne dla wiersza i nagłówka `TaskColumnsHeader`. */
const COLUMN_WIDTH: Record<ListColumn, number> = { start: 50, due: 56, duration: 48, description: 36, attachments: 64, tags: 80 };
/** Najmniejsza szerokość tytułu obok kolumn — węższy ekran przewija listę w poziomie. */
const TITLE_MIN = 180;

/** Szerokość wiersza z kolumnami, przy której tytuł ma jeszcze `TITLE_MIN` (odstępy i kółko jak w `styles.row`). */
export const columnsRowWidth = (columns: readonly ListColumn[]) => 12 + 22 + 10 + TITLE_MIN + columns.reduce((sum, c) => sum + 10 + COLUMN_WIDTH[c], 0) + 12;

/**
 * Lista szersza niż ekran (`TaskSections`): przesunięcie poziome, widoczna szerokość i szerokość wierszy.
 * `null` — lista mieści się na ekranie.
 */
export const WideList = createContext<{ x: SharedValue<number>; view: number; width: number } | null>(null);

/** Część szerokiej listy, która stoi w miejscu (nagłówek ekranu, sekcje): przesuwa się razem z przewinięciem. */
export function Sticky({ children }: { children: ReactNode }) {
  const wide = useContext(WideList);
  const shift = useAnimatedStyle(() => ({ transform: [{ translateX: wide ? wide.x.value : 0 }] }));
  if (!wide) return children;
  return <Animated.View style={[{ width: wide.view }, shift]}>{children}</Animated.View>;
}

/** Nagłówek kolumn nad wierszami listy (w szerokiej liście leży w `Sticky`, więc przesuwa się odwrotnie — razem z wierszami). */
export function TaskColumnsHeader({ columns }: { columns: readonly ListColumn[] }) {
  const p = usePalette();
  const wide = useContext(WideList);
  const shift = useAnimatedStyle(() => ({ transform: [{ translateX: wide ? -wide.x.value : 0 }] }));
  if (!columns.length) return null;
  return (
    <Animated.View style={[styles.columnsHeader, { borderColor: p.border }, wide ? { width: wide.width } : null, shift]}>
      <View style={{ flex: 1 }} />
      {columns.map((c) => (
        <Text key={c} style={[styles.column, { width: COLUMN_WIDTH[c], color: p.muted, fontWeight: '600' }]} numberOfLines={1}>
          {LIST_COLUMN[c]}
        </Text>
      ))}
    </Animated.View>
  );
}

/**
 * `false` — wiersze bez gestu przesunięcia (pierwsze narysowanie listy); `TaskSections` przełącza na
 * `true` w pierwszej wolnej chwili po nim. Poza listą (szczegóły, wyszukiwanie) — od razu `true`.
 */
export const RowsInteractive = createContext(true);

/** Przytrzymanie zaznacza tylko tam, gdzie jest pasek akcji (`TaskSections`); gdzie indziej dotknięcie zawsze otwiera zadanie. */
export const RowsSelectable = createContext(false);

export const TaskRow = memo(function TaskRow({ task, today, showDate = true, listName, lateMin = 0, onToday, onLater, depth = 0, progress, collapsed, onCollapse, virtualDate, habitDone, tagNames, tagItems, columns, highlights, onOpen }: TaskRowProps) {
  const tagBubbles = columns?.includes('tags') ? (tagItems ?? (tagNames ?? []).map((name) => ({ id: name, name, color: null }))) : [];
  const p = usePalette();
  const actions = useTaskActions();
  const { toggle, selected, toggleSelected, notify } = actions;
  const data = useAppData();
  const swipe = useRef<SwipeableMethods>(null);
  const selectable = useContext(RowsSelectable);
  const isSelected = selectable && selected.has(task.id);
  const selecting = selectable && selected.size > 0;
  // Przestrzeń albo lista udostępniona do podglądu: zadanie da się otworzyć, ale nie zmienić.
  const readOnly = !listEditable(data, task.listId);
  const closed = task.kind === 'habit' ? !!habitDone : !isOpen(task);
  const date = virtualDate ?? task.dueDate;
  const overdue = !virtualDate && !closed && task.dueDate !== null && task.dueDate < today;
  const color = PRIORITY[task.priority]?.color ?? PRIORITY[4].color;
  const interactive = useContext(RowsInteractive);
  // Szeroka lista przewija się w poziomie — przesunięcie wiersza by z tym walczyło.
  const wide = !!useContext(WideList);
  const swipeable = !virtualDate && !selecting && interactive && !readOnly && !wide;
  const assignee = assigneeOf(task.assigneeId, data.collaborators);
  const attachments = data.attachmentCounts.get(task.id) ?? 0;
  // Uczestnicy obok odpowiedzialnego — razem najwyżej 4 znaczki (jak na webie).
  const participants = (data.participants.get(task.id) ?? [])
    .filter((id) => id !== task.assigneeId)
    .flatMap((id) => assigneeOf(id, data.collaborators) ?? [])
    .slice(0, assignee ? 3 : 4);

  // Kolumna „Koniec” / „Załączniki” zastępuje to samo w szarym wierszu pod tytułem.
  const dueColumn = !!columns?.includes('due');
  const attachmentsColumn = !!columns?.includes('attachments');

  const meta = [
    showDate && date && !dueColumn ? { text: relativeDay(date, today), bad: overdue } : null,
    task.dueTime && !dueColumn ? lateMin > 0 ? { text: `${task.dueTime} · ${formatMinutes(lateMin)} po czasie`, bad: true } : { text: task.dueTime } : null,
    task.recurrence ? { text: `↻ ${describeRecurrence(task.recurrence)}` } : null,
    needsDecision(task) && !closed ? { text: `odłożone ${task.postponeCount}×` } : null,
    progress && progress.total > 0 ? { text: `☑ ${progress.done}/${progress.total}` } : null,
    task.status === 'in_progress' ? { text: 'w trakcie' } : task.status === 'waiting' ? { text: 'oczekuje' } : null,
    attachments && !attachmentsColumn ? { text: `📎 ${attachments}` } : null,
    listName ? { text: listName } : null,
    assignee ? { text: `👤 ${collaboratorBadge(assignee)}`, people: [assignee], strong: true } : null,
    participants.length ? { text: `👥 ${participants.map(collaboratorBadge).join(' ')}`, people: participants } : null,
    ...(columns?.includes('tags') ? [] : (tagNames ?? [])).map((t) => ({ text: `@${t}` })),
  ].filter(Boolean) as { text: string; bad?: boolean; people?: typeof participants; strong?: boolean }[];
  // Wyróżniony (zaległy termin) jest zawsze pierwszy; zwykłe pozycje sklejone w jeden tekst, osoby
  // w kolorze (`collaborators.color`) — po jednym zagnieżdżonym `Text` na znaczek z kolorem.
  const lead = meta[0]?.bad ? meta[0] : null;
  const restItems = lead ? meta.slice(1) : meta;
  const colored = restItems.some((m) => m.people?.some((c) => c.color));
  const rest: ReactNode = colored
    ? restItems.map((m, i) => (
        <Fragment key={i}>
          {i ? ' · ' : ''}
          {m.people ? (
            <>
              {m.strong ? '👤' : '👥'}
              {m.people.map((c) => {
                const own = collaboratorBadgeColors(c, p.bg, p.fg);
                return (
                  <Fragment key={c.id}>
                    {' '}
                    {own ? <Text style={{ color: own.line, fontWeight: m.strong ? '700' : '600' }}>{collaboratorBadge(c)}</Text> : collaboratorBadge(c)}
                  </Fragment>
                );
              })}
            </>
          ) : (
            m.text
          )}
        </Fragment>
      ))
    : restItems.map((m) => m.text).join(' · ');

  const body = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={task.title}
      accessibilityState={{ selected: isSelected }}
      accessibilityHint={
        selecting
          ? 'Dotknij, żeby zaznaczyć albo odznaczyć'
          : readOnly
            ? 'Otwiera szczegóły; tylko podgląd'
            : `Otwiera szczegóły${wide ? '' : '; przesuń w prawo — ukończ, w lewo — termin'}${selectable ? '; przytrzymaj — zaznacz' : ''}`
      }
      onPress={() => {
        if (selecting) return readOnly ? notify(READONLY_LIST_NOTE) : toggleSelected(task.id);
        onOpen?.();
        router.push({ pathname: '/task/[id]', params: { id: task.id } });
      }}
      onLongPress={selectable && !virtualDate ? () => (readOnly ? notify(READONLY_LIST_NOTE) : toggleSelected(task.id)) : undefined}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: isSelected ? p.selected : pressed ? p.border : p.bg, paddingLeft: 12 + depth * 18, borderColor: p.border, opacity: virtualDate ? 0.6 : 1 },
      ]}
    >
      {collapsed === undefined ? (
        depth > 0 || onCollapse ? <View style={styles.caret} /> : null
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={collapsed ? 'Rozwiń podzadania' : 'Zwiń podzadania'} hitSlop={10} onPress={onCollapse} style={styles.caret}>
          <Text style={{ color: p.muted, fontSize: 14 }}>{collapsed ? '▸' : '▾'}</Text>
        </Pressable>
      )}
      {virtualDate ? (
        <View style={[styles.check, { borderColor: color, borderStyle: 'dashed' }]} />
      ) : selecting ? (
        <View style={[styles.check, styles.square, { borderColor: isSelected ? p.accent : p.muted, backgroundColor: isSelected ? p.accent : 'transparent' }]}>
          {isSelected ? <Text style={[styles.tick, { color: p.onAccent }]}>✓</Text> : null}
        </View>
      ) : (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: closed, disabled: readOnly }}
          accessibilityLabel={closed ? `Przywróć „${task.title}”` : `Ukończ „${task.title}”`}
          hitSlop={12}
          onPress={() => (readOnly ? notify(READONLY_LIST_NOTE) : void toggle(task, { habitDone }))}
          style={[styles.check, { borderColor: color, backgroundColor: closed ? color : `${color}1A`, opacity: readOnly ? 0.4 : 1 }]}
        >
          {closed ? <Text style={styles.tick}>✓</Text> : null}
        </Pressable>
      )}
      <View style={styles.text}>
        <Text style={[styles.title, { color: closed ? p.muted : p.fg, textDecorationLine: closed ? 'line-through' : 'none' }]} numberOfLines={3}>
          {highlights?.length ? <Highlighted text={task.title} ranges={highlights} /> : task.title}
        </Text>
        {meta.length ? (
          <Text style={[styles.meta, { color: p.muted }]} numberOfLines={1}>
            {lead ? <Text style={[styles.bad, { color: p.bad }]}>{lead.text}</Text> : null}
            {lead && restItems.length ? ' · ' : null}
            {rest}
          </Text>
        ) : null}
      </View>
      {onLater && !readOnly && !selecting ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Przesuń „${task.title}” o kilka minut od teraz`}
          hitSlop={10}
          onPress={onLater}
          style={({ pressed }) => [styles.today, { borderColor: p.border, backgroundColor: pressed ? p.border : 'transparent' }]}
        >
          <Text style={{ color: p.accent, fontSize: 13, fontWeight: '600' }}>⏱</Text>
        </Pressable>
      ) : null}
      {onToday && !readOnly && !selecting ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Przenieś „${task.title}” na dziś`}
          hitSlop={10}
          onPress={onToday}
          style={({ pressed }) => [styles.today, { borderColor: p.border, backgroundColor: pressed ? p.border : 'transparent' }]}
        >
          <Text style={{ color: p.accent, fontSize: 13, fontWeight: '600' }}>→ Dziś</Text>
        </Pressable>
      ) : null}
      {columns?.map((c) => {
        if (c === 'tags')
          return (
            <View key={c} style={[styles.tags, { width: COLUMN_WIDTH[c], opacity: closed ? 0.5 : 1 }]}>
              {tagBubbles.length ? (
                tagBubbles.map((tag) => (
                  <Text key={tag.id} style={[styles.tag, tag.color ? { color: readableColor(tag.color, p.card, p.fg), backgroundColor: `${tag.color}33` } : { color: p.fg, backgroundColor: p.border }]} numberOfLines={1}>
                    {tag.name}
                  </Text>
                ))
              ) : (
                <Text style={[styles.column, { color: p.muted }]}>—</Text>
              )}
            </View>
          );
        // Sekcja „Dziś” (`showDate` false): dzisiejsza data jest oczywista, wystarczy godzina.
        const timeOnly = c === 'due' && !showDate && date === today && !!task.dueTime;
        // Opis i załączniki to znaczniki: bez nich pusta komórka zamiast „—”.
        if (c === 'description' || c === 'attachments') {
          const flag = c === 'description' ? (task.hasDescription ? '📝' : null) : attachments ? `📎 ${attachments}` : null;
          return (
            <View key={c} style={{ width: COLUMN_WIDTH[c], paddingTop: 2, opacity: closed ? 0.5 : 1 }}>
              {flag ? (
                <Text style={[styles.column, { color: p.fg }]} numberOfLines={1} accessibilityLabel={c === 'description' ? 'Ma opis' : `Załączniki: ${attachments}`}>
                  {flag}
                </Text>
              ) : null}
            </View>
          );
        }
        const value = c === 'duration' ? (task.durationMin ? formatMinutes(task.durationMin) : null) : c === 'start' ? (task.startDate ? columnDate(task.startDate, today) : null) : timeOnly ? task.dueTime : date ? columnDate(date, today) : null;
        return (
          <View key={c} style={{ width: COLUMN_WIDTH[c], paddingTop: 2, opacity: closed ? 0.5 : 1 }}>
            <Text style={[styles.column, { color: value ? (c === 'due' && overdue ? p.bad : p.fg) : p.muted }]} numberOfLines={2}>
              {value ?? '—'}
            </Text>
            {c === 'due' && date && task.dueTime && !timeOnly ? <Text style={[styles.column, { color: overdue ? p.bad : p.muted }]}>{task.dueTime}</Text> : null}
          </View>
        );
      })}
    </Pressable>
  );

  if (!swipeable) return body;
  return (
    <Swipeable
      ref={swipe}
      friction={1.6}
      leftThreshold={72}
      rightThreshold={72}
      overshootLeft={false}
      overshootRight={false}
      renderLeftActions={() => (
        <View style={[styles.action, styles.left, { backgroundColor: closed ? p.muted : p.ok }]}>
          <Text style={[styles.actionText, { color: closed ? p.onAccent : p.onOk }]}>{closed ? '↺ Przywróć' : '✓ Ukończ'}</Text>
        </View>
      )}
      renderRightActions={() => (
        <View style={[styles.action, styles.right, { backgroundColor: p.accent }]}>
          <Text style={[styles.actionText, { color: p.onAccent }]}>📅 Termin</Text>
        </View>
      )}
      onSwipeableWillOpen={(direction) => {
        swipe.current?.close();
        // Kierunek = ruch palca: w prawo odsłania lewy panel („Ukończ”).
        if (direction === SwipeDirection.RIGHT) void toggle(task, { habitDone });
        else void rescheduleWithMenu(task, today, actions);
      }}
    >
      {body}
    </Swipeable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingRight: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  caret: { width: 14, alignItems: 'center', paddingTop: 2 },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  square: { borderRadius: 6 },
  tick: { color: '#fff', fontSize: 13, fontWeight: '700' },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 16, lineHeight: 21 },
  meta: { fontSize: 12.5 },
  column: { fontSize: 12 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, paddingTop: 2 },
  tag: { fontSize: 11, borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden', maxWidth: 80 },
  columnsHeader: { flexDirection: 'row', gap: 10, paddingRight: 12, paddingTop: 6, paddingBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  today: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  bad: { fontWeight: '600' },
  action: { flex: 1, justifyContent: 'center' },
  left: { alignItems: 'flex-start', paddingLeft: 20 },
  right: { alignItems: 'flex-end', paddingRight: 20 },
  actionText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
