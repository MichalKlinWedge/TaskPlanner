/**
 * Arkusze wyboru wywoływane z dowolnego miejsca (gest na wierszu, pasek zaznaczenia, szczegóły
 * zadania): `pickOption` — lista opcji, `pickMany` — kilka opcji z „Gotowe”, `pickDate` — gotowe dni + kalendarz miesiąca, `pickTime` —
 * gotowe godziny + wpisanie. Jeden `<PickerHost />` w układzie głównym; Promise kończy się wyborem
 * albo `undefined` po zamknięciu. Własne arkusze zamiast natywnego wyboru daty — bez dodatkowego
 * modułu natywnego, a gotowe dni („Jutro”, „Za tydzień”) są o jedno dotknięcie.
 */
import { addDays, addMonths, capitalized, dayChip, isoWeekday, monthLabel, WEEKDAY, type IsoWeekday, type LocalDate, type LocalTime } from '@taskplanner/core';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePalette } from './ui';

export interface Option<T> {
  label: string;
  value: T;
  hint?: string;
  tone?: 'bad' | 'accent';
  selected?: boolean;
}

type Request =
  | { kind: 'option'; title: string; options: Option<unknown>[]; resolve: (value: unknown) => void }
  | { kind: 'many'; title: string; options: Option<unknown>[]; resolve: (value: unknown[] | undefined) => void }
  | { kind: 'date'; title: string; value: LocalDate | null; today: LocalDate; allowNone: boolean; firstDayOfWeek: number; resolve: (value: LocalDate | null | undefined) => void }
  | { kind: 'time'; title: string; value: LocalTime | null; allowNone: boolean; resolve: (value: LocalTime | null | undefined) => void };

let current: Request | null = null;
const listeners = new Set<() => void>();
const set = (r: Request | null) => {
  current = r;
  listeners.forEach((l) => l());
};

type Pending = Request extends infer R ? (R extends { resolve: unknown } ? Omit<R, 'resolve'> : never) : never;

function open<T>(request: Pending): Promise<T> {
  // Poprzedni arkusz (gdyby był otwarty) kończy się bez wyboru.
  (current?.resolve as ((v: unknown) => void) | undefined)?.(undefined);
  return new Promise<T>((resolve) => set({ ...request, resolve } as unknown as Request));
}

export const pickOption = <T,>(title: string, options: Option<T>[]): Promise<T | undefined> =>
  open<T | undefined>({ kind: 'option', title, options: options as Option<unknown>[] });

/** Wybór kilku opcji (`selected` = zaznaczone na starcie); „Gotowe” zwraca zaznaczone, zamknięcie — `undefined`. */
export const pickMany = <T,>(title: string, options: Option<T>[]): Promise<T[] | undefined> =>
  open<T[] | undefined>({ kind: 'many', title, options: options as Option<unknown>[] });

/** `null` = „Bez terminu” (gdy `allowNone`), `undefined` = zamknięte bez wyboru. */
export const pickDate = (opts: { title: string; value: LocalDate | null; today: LocalDate; allowNone?: boolean; firstDayOfWeek?: number }): Promise<LocalDate | null | undefined> =>
  open<LocalDate | null | undefined>({ kind: 'date', allowNone: false, firstDayOfWeek: 1, ...opts });

export const pickTime = (opts: { title: string; value: LocalTime | null; allowNone?: boolean }): Promise<LocalTime | null | undefined> =>
  open<LocalTime | null | undefined>({ kind: 'time', allowNone: false, ...opts });

const close = (value?: unknown) => {
  const r = current;
  set(null);
  (r?.resolve as ((v: unknown) => void) | undefined)?.(value);
};

export function PickerHost() {
  const request = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  return (
    <Modal visible={!!request} transparent animationType="slide" onRequestClose={() => close()} statusBarTranslucent navigationBarTranslucent>
      {request ? (
        <Sheet title={request.title} onClose={() => close()}>
          {request.kind === 'option' ? <OptionList options={request.options} /> : null}
          {request.kind === 'many' ? <ManyList key={request.title} options={request.options} /> : null}
          {request.kind === 'date' ? <DatePicker key={`${request.title}:${request.value}`} request={request} /> : null}
          {request.kind === 'time' ? <TimePicker key={`${request.title}:${request.value}`} request={request} /> : null}
        </Sheet>
      ) : null}
    </Modal>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.backdrop}>
      <Pressable accessibilityLabel="Zamknij" style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: p.card, paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.head}>
          <Text style={[styles.title, { color: p.fg }]} numberOfLines={2}>
            {title}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Zamknij" hitSlop={10} onPress={onClose}>
            <Text style={{ color: p.muted, fontSize: 18 }}>✕</Text>
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 520 }}>
          {children}
        </ScrollView>
      </View>
    </View>
  );
}

function OptionList({ options }: { options: Option<unknown>[] }) {
  const p = usePalette();
  return (
    <View>
      {options.map((o, i) => (
        <Pressable
          key={`${i}:${o.label}`}
          accessibilityRole="button"
          accessibilityState={{ selected: !!o.selected }}
          onPress={() => close(o.value)}
          style={({ pressed }) => [styles.option, { borderColor: p.border, backgroundColor: pressed ? p.border : 'transparent' }]}
        >
          <Text style={[styles.optionText, { color: o.tone === 'bad' ? p.bad : o.tone === 'accent' ? p.accent : p.fg, fontWeight: o.selected ? '700' : '400' }]}>
            {o.selected ? '✓ ' : ''}
            {o.label}
          </Text>
          {o.hint ? <Text style={{ color: p.muted, fontSize: 13 }}>{o.hint}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

function ManyList({ options }: { options: Option<unknown>[] }) {
  const p = usePalette();
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set(options.flatMap((o, i) => (o.selected ? [i] : []))));
  const toggle = (i: number) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <View>
      {options.map((o, i) => (
        <Pressable
          key={`${i}:${o.label}`}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: picked.has(i) }}
          onPress={() => toggle(i)}
          style={({ pressed }) => [styles.option, styles.check, { borderColor: p.border, backgroundColor: pressed ? p.border : 'transparent' }]}
        >
          <Text style={[styles.box, { borderColor: picked.has(i) ? p.accent : p.border, backgroundColor: picked.has(i) ? p.accent : 'transparent' }]}>{picked.has(i) ? '✓' : ' '}</Text>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[styles.optionText, { color: p.fg }]}>{o.label}</Text>
            {o.hint ? <Text style={{ color: p.muted, fontSize: 13 }}>{o.hint}</Text> : null}
          </View>
        </Pressable>
      ))}
      <Pressable accessibilityRole="button" onPress={() => close(options.filter((_, i) => picked.has(i)).map((o) => o.value))} style={[styles.done, { backgroundColor: p.accent }]}>
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>Gotowe</Text>
      </Pressable>
    </View>
  );
}

function Pill({ label, onPress, selected, tone }: { label: string; onPress: () => void; selected?: boolean; tone?: 'bad' }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.pill, { borderColor: selected ? p.accent : p.border, backgroundColor: selected ? p.accent : pressed ? p.border : 'transparent' }]}
    >
      <Text style={{ color: selected ? '#fff' : tone === 'bad' ? p.bad : p.fg, fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

function DatePicker({ request }: { request: Extract<Request, { kind: 'date' }> }) {
  const p = usePalette();
  const { today, value, firstDayOfWeek } = request;
  const [month, setMonth] = useState(() => `${(value ?? today).slice(0, 7)}-01` as LocalDate);
  const nextMonday = addDays(today, ((8 - isoWeekday(today)) % 7) || 7);
  const presets: { label: string; date: LocalDate }[] = [
    { label: 'Dziś', date: today },
    { label: 'Jutro', date: addDays(today, 1) },
    { label: 'Pojutrze', date: addDays(today, 2) },
    { label: `Pon. ${dayChip(nextMonday).replace(/^[^,]+,\s*/, '')}`, date: nextMonday },
    { label: 'Za tydzień', date: addDays(today, 7) },
  ];
  // Siatka: od pierwszego dnia tygodnia przed 1. dniem miesiąca, 6 tygodni.
  const lead = (isoWeekday(month) - firstDayOfWeek + 7) % 7;
  const start = addDays(month, -lead);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const weekdays = Array.from({ length: 7 }, (_, i) => (((firstDayOfWeek - 1 + i) % 7) + 1) as IsoWeekday);
  return (
    <View style={{ gap: 12 }}>
      <View style={styles.pills}>
        {presets.map((d) => (
          <Pill key={d.label} label={d.label} selected={value === d.date} onPress={() => close(d.date)} />
        ))}
        {request.allowNone ? <Pill label="Bez terminu" tone="bad" onPress={() => close(null)} /> : null}
      </View>
      <View style={styles.monthHead}>
        <Pressable accessibilityRole="button" accessibilityLabel="Poprzedni miesiąc" hitSlop={10} onPress={() => setMonth(addMonths(month, -1))}>
          <Text style={[styles.arrow, { color: p.accent }]}>‹</Text>
        </Pressable>
        <Text style={[styles.monthTitle, { color: p.fg }]}>{capitalized(monthLabel(month))}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Następny miesiąc" hitSlop={10} onPress={() => setMonth(addMonths(month, 1))}>
          <Text style={[styles.arrow, { color: p.accent }]}>›</Text>
        </Pressable>
      </View>
      <View style={styles.grid}>
        {weekdays.map((w) => (
          <Text key={w} style={[styles.cell, styles.weekday, { color: p.muted }]}>
            {WEEKDAY[w].short}
          </Text>
        ))}
        {days.map((d) => {
          const inMonth = d.slice(0, 7) === month.slice(0, 7);
          const selected = d === value;
          return (
            <Pressable
              key={d}
              accessibilityRole="button"
              accessibilityLabel={dayChip(d)}
              accessibilityState={{ selected }}
              onPress={() => close(d)}
              style={[styles.cell, styles.day, selected && { backgroundColor: p.accent }, d === today && !selected && { borderColor: p.accent, borderWidth: 1 }]}
            >
              <Text style={{ color: selected ? '#fff' : inMonth ? p.fg : p.muted, opacity: inMonth ? 1 : 0.5, fontWeight: d === today ? '700' : '400' }}>{Number(d.slice(8))}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const TIME = /^([01]?\d|2[0-3])[:.]?([0-5]\d)$/;

function TimePicker({ request }: { request: Extract<Request, { kind: 'time' }> }) {
  const p = usePalette();
  const [text, setText] = useState(request.value ?? '');
  const match = text.trim().match(TIME);
  const valid = match ? (`${match[1]!.padStart(2, '0')}:${match[2]}` as LocalTime) : null;
  return (
    <View style={{ gap: 12 }}>
      <View style={styles.pills}>
        {(['08:00', '09:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00'] as LocalTime[]).map((t) => (
          <Pill key={t} label={t} selected={request.value === t} onPress={() => close(t)} />
        ))}
        {request.allowNone ? <Pill label="Bez godziny" tone="bad" onPress={() => close(null)} /> : null}
      </View>
      <View style={[styles.pills, { alignItems: 'center' }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="GG:MM"
          placeholderTextColor={p.muted}
          keyboardType="numbers-and-punctuation"
          maxLength={5}
          onSubmitEditing={() => valid && close(valid)}
          style={[styles.timeInput, { color: p.fg, borderColor: valid || !text ? p.border : p.bad }]}
        />
        <Pill label="Ustaw" selected={!!valid} onPress={() => valid && close(valid)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 16, paddingTop: 14, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6 },
  title: { flex: 1, fontSize: 17, fontWeight: '600' },
  option: { paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
  optionText: { fontSize: 16 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  box: { width: 22, height: 22, borderWidth: 1.5, borderRadius: 5, textAlign: 'center', color: '#fff', fontSize: 14, lineHeight: 19, overflow: 'hidden' },
  done: { marginTop: 12, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { borderWidth: 1, borderRadius: 18, paddingVertical: 7, paddingHorizontal: 13 },
  monthHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6 },
  monthTitle: { fontSize: 16, fontWeight: '600' },
  arrow: { fontSize: 28, paddingHorizontal: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, alignItems: 'center', justifyContent: 'center' },
  weekday: { fontSize: 12, textAlign: 'center', paddingBottom: 4 },
  day: { height: 42, borderRadius: 21 },
  timeInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 18, minWidth: 100 },
});
