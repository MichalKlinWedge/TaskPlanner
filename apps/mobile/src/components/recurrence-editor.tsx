/**
 * Edytor reguły powtarzania (M7) na telefonie — jak `recurrence-editor.tsx` na webie: szablony,
 * „Więcej opcji…” (tryb, co ile, dni tygodnia, miesięcznie / rocznie, koniec serii), reguła słowami
 * (gramatyka szybkiego dodawania), opis po polsku na żywo i podgląd 5 najbliższych dat.
 * Formularz ↔ reguła — `core/recurrence-editor.ts`; tu tylko widok.
 */
import {
  dayChip,
  daysBetween,
  describeRecurrence,
  draftError,
  draftFromRecurrence,
  localDateTimeAt,
  parseQuickAdd,
  previewDates,
  recurrenceFromDraft,
  recurrenceTemplates,
  shortDate,
  WEEKDAY_CODES,
  type LocalDate,
  type MonthlyBy,
  type Recurrence,
  type RecurrenceDraft,
  type RecurrenceUnit,
  type WeekdayCode,
} from '@taskplanner/core';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { pickDate, pickOption } from './pickers';
import { Chip, usePalette } from './ui';

const DAY_SHORT: Record<WeekdayCode, string> = { MO: 'Pn', TU: 'Wt', WE: 'Śr', TH: 'Cz', FR: 'Pt', SA: 'So', SU: 'Nd' };
const DAY_NAME: Record<WeekdayCode, string> = { MO: 'poniedziałek', TU: 'wtorek', WE: 'środa', TH: 'czwartek', FR: 'piątek', SA: 'sobota', SU: 'niedziela' };
const UNIT_LABEL: Record<RecurrenceUnit, string> = { day: 'dni', week: 'tygodni', month: 'miesięcy', year: 'lat' };
const MONTHLY_LABEL: Record<MonthlyBy, string> = { day: 'dnia miesiąca', weekday: 'dnia tygodnia', last_day: 'ostatniego dnia', last_workday: 'ostatniego dnia roboczego' };
const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const NTH: [number, string][] = [[1, 'pierwszy'], [2, 'drugi'], [3, 'trzeci'], [4, 'czwarty'], [-1, 'ostatni']];

/** Daty podglądu; gdy seria wychodzi poza rok — z rokiem (jak na webie). */
const previewLine = (dates: LocalDate[]) =>
  dates.map((d) => (dates.at(-1)!.slice(0, 4) !== dates[0]!.slice(0, 4) && daysBetween(dates[0]!, dates.at(-1)!) > 300 ? `${dayChip(d)}.${d.slice(0, 4)}` : dayChip(d))).join(' · ');

const num = (v: string) => (v === '' ? 0 : Math.trunc(Number(v.replace(/\D/g, ''))));

/** Wybór z listy jako pole („przycisk z wartością”). */
function Select<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  const p = usePalette();
  const current = options.find(([v]) => v === value)?.[1] ?? String(value);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${current}`}
      onPress={() => void pickOption<T>(label, options.map(([v, l]) => ({ label: l, value: v, selected: v === value }))).then((v) => v !== undefined && onChange(v))}
      style={({ pressed }) => [styles.select, { borderColor: p.border, backgroundColor: pressed ? p.border : p.card }]}
    >
      <Text style={{ color: p.fg, fontSize: 14 }}>{current} ▾</Text>
    </Pressable>
  );
}

function NumberInput({ label, value, onChange, width = 56 }: { label: string; value: number; onChange: (n: number) => void; width?: number }) {
  const p = usePalette();
  return (
    <TextInput
      accessibilityLabel={label}
      value={value ? String(value) : ''}
      onChangeText={(t) => onChange(num(t))}
      keyboardType="number-pad"
      maxLength={3}
      style={[styles.number, { width, color: p.fg, borderColor: p.border }]}
    />
  );
}

export function RecurrenceEditor({
  value,
  anchor,
  today,
  timeZone,
  onSave,
  onCancel,
}: {
  value: Recurrence | null;
  /** Termin zadania (albo dziś) — od niego liczy się seria. */
  anchor: LocalDate;
  today: LocalDate;
  timeZone?: string;
  onSave: (recurrence: Recurrence) => void;
  onCancel: () => void;
}) {
  const p = usePalette();
  const [draft, setDraft] = useState<RecurrenceDraft>(() => draftFromRecurrence(value, anchor));
  const [advanced, setAdvanced] = useState(value !== null);
  const [text, setText] = useState('');
  const [textError, setTextError] = useState<string | null>(null);
  const [monthDaysText, setMonthDaysText] = useState<string | null>(null);
  const templates = useMemo(() => recurrenceTemplates(anchor), [anchor]);
  const error = draftError(draft);
  const result = useMemo(() => (error ? null : recurrenceFromDraft(draft, anchor)), [draft, anchor, error]);
  const set = (patch: Partial<RecurrenceDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const schedule = draft.mode === 'schedule';

  const fromText = () => {
    const parsed = parseQuickAdd(`x ${text}`, { now: localDateTimeAt(new Date(), timeZone), workspaces: [], lists: [], tags: [] });
    const rec = parsed.fields.recurrence;
    if (!rec) return setTextError('Nie rozpoznano — np. „co tydzień w poniedziałek”, „co miesiąc 15.”, „co 3 dni po ukończeniu”.');
    setDraft(draftFromRecurrence(rec.mode === 'schedule' ? { ...rec, anchor } : rec, anchor));
    setMonthDaysText(null);
    setAdvanced(true);
    setText('');
    setTextError(null);
  };

  return (
    <View style={[styles.box, { borderColor: p.border }]}>
      <View style={styles.wrap} accessibilityLabel="Szablony">
        {templates.map((t) => (
          <Chip
            key={t.id}
            label={t.label}
            onPress={() => {
              setDraft(t.draft);
              setMonthDaysText(null);
            }}
          />
        ))}
        <Pressable accessibilityRole="button" onPress={() => setAdvanced((a) => !a)} style={styles.more}>
          <Text style={{ color: p.accent, fontSize: 14 }}>{advanced ? 'Ukryj szczegóły' : 'Więcej opcji…'}</Text>
        </Pressable>
      </View>

      {advanced ? (
        <View style={{ gap: 10 }}>
          <View style={styles.line}>
            <Select<RecurrenceDraft['mode']>
              label="Tryb"
              value={draft.mode}
              options={[['schedule', 'Według harmonogramu'], ['after_completion', 'Po ukończeniu']]}
              onChange={(mode) => set({ mode })}
            />
          </View>
          <View style={styles.line}>
            <Text style={{ color: p.fg }}>co</Text>
            <NumberInput label="Co ile" value={draft.interval} onChange={(interval) => set({ interval })} />
            <Select<RecurrenceUnit> label="Jednostka" value={draft.unit} options={(Object.keys(UNIT_LABEL) as RecurrenceUnit[]).map((u) => [u, UNIT_LABEL[u]])} onChange={(unit) => set({ unit })} />
          </View>

          {schedule && draft.unit === 'week' ? (
            <View style={styles.days} accessibilityLabel="Dni tygodnia">
              {WEEKDAY_CODES.map((d) => {
                const on = draft.days.includes(d);
                return (
                  <Pressable
                    key={d}
                    accessibilityRole="button"
                    accessibilityLabel={DAY_NAME[d]}
                    accessibilityState={{ selected: on }}
                    onPress={() => set({ days: on ? draft.days.filter((x) => x !== d) : [...draft.days, d] })}
                    style={[styles.day, { borderColor: on ? p.accent : p.border, backgroundColor: on ? p.accent : 'transparent' }]}
                  >
                    <Text style={{ color: on ? '#fff' : p.fg, fontSize: 13 }}>{DAY_SHORT[d]}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {schedule && draft.unit === 'month' ? (
            <View style={styles.line}>
              <Select<MonthlyBy> label="Którego dnia" value={draft.monthlyBy} options={(Object.keys(MONTHLY_LABEL) as MonthlyBy[]).map((m) => [m, MONTHLY_LABEL[m]])} onChange={(monthlyBy) => set({ monthlyBy })} />
              {draft.monthlyBy === 'day' ? (
                <TextInput
                  accessibilityLabel="Dni miesiąca"
                  value={monthDaysText ?? draft.monthDays.map((d) => (d === -1 ? 'ostatni' : d)).join(', ')}
                  onChangeText={(t) => {
                    setMonthDaysText(t);
                    set({ monthDays: t.split(/[,\s]+/).filter(Boolean).map((x) => (/^ost/i.test(x) ? -1 : num(x))) });
                  }}
                  placeholder="np. 15, ostatni"
                  placeholderTextColor={p.muted}
                  style={[styles.number, { width: 140, color: p.fg, borderColor: p.border }]}
                />
              ) : null}
              {draft.monthlyBy === 'weekday' ? (
                <>
                  <Select<number> label="Który" value={draft.nth} options={NTH} onChange={(nth) => set({ nth })} />
                  <Select<WeekdayCode> label="Dzień tygodnia" value={draft.weekday} options={WEEKDAY_CODES.map((d) => [d, DAY_NAME[d]])} onChange={(weekday) => set({ weekday })} />
                </>
              ) : null}
            </View>
          ) : null}

          {schedule && draft.unit === 'year' ? (
            <View style={styles.line}>
              <NumberInput label="Dzień" value={draft.monthDay} onChange={(monthDay) => set({ monthDay })} />
              <Select<number> label="Miesiąc" value={draft.month} options={MONTHS.map((m, i) => [i + 1, m])} onChange={(month) => set({ month })} />
            </View>
          ) : null}

          {schedule ? (
            <View style={styles.line}>
              <Text style={{ color: p.fg }}>Koniec:</Text>
              <Select<RecurrenceDraft['end']['kind']>
                label="Koniec serii"
                value={draft.end.kind}
                options={[['never', 'nigdy'], ['until', 'w dniu'], ['count', 'po liczbie powtórzeń']]}
                onChange={(kind) => set({ end: kind === 'until' ? { kind, date: today > anchor ? today : anchor } : kind === 'count' ? { kind, n: 10 } : { kind: 'never' } })}
              />
              {draft.end.kind === 'until' ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Data końca"
                  onPress={() =>
                    void pickDate({ title: 'Koniec serii', value: draft.end.kind === 'until' ? draft.end.date : anchor, today }).then((date) => date && set({ end: { kind: 'until', date: date < anchor ? anchor : date } }))
                  }
                  style={[styles.select, { borderColor: p.border, backgroundColor: p.card }]}
                >
                  <Text style={{ color: p.fg, fontSize: 14 }}>{shortDate(draft.end.date)} ▾</Text>
                </Pressable>
              ) : null}
              {draft.end.kind === 'count' ? <NumberInput label="Liczba powtórzeń" value={draft.end.n} onChange={(n) => set({ end: { kind: 'count', n } })} width={64} /> : null}
            </View>
          ) : null}

          <View style={{ gap: 4 }}>
            <View style={styles.line}>
              <TextInput
                value={text}
                onChangeText={setText}
                onSubmitEditing={() => text.trim() && fromText()}
                placeholder="albo wpisz, np. co drugi wtorek"
                placeholderTextColor={p.muted}
                accessibilityLabel="Reguła słowami"
                style={[styles.number, { flex: 1, color: p.fg, borderColor: p.border }]}
              />
              <Chip label="Rozpoznaj" disabled={!text.trim()} onPress={fromText} />
            </View>
            {textError ? <Text style={{ color: p.bad, fontSize: 12 }}>{textError}</Text> : null}
          </View>
        </View>
      ) : null}

      <View accessibilityLiveRegion="polite" style={{ gap: 2 }}>
        {result ? (
          <>
            <Text style={{ color: p.fg, fontSize: 15, fontWeight: '600' }}>↻ {describeRecurrence(result)}</Text>
            <Text style={{ color: p.muted, fontSize: 12 }}>
              {previewLine(previewDates(result, anchor))}
              {result.mode === 'after_completion' ? ' (przy ukończeniu w terminie)' : ''}
            </Text>
          </>
        ) : (
          <Text style={{ color: p.bad, fontSize: 12 }}>{error}</Text>
        )}
      </View>

      <View style={styles.line}>
        <Chip label="Zapisz" selected={!!result} disabled={!result} onPress={() => result && onSave(result)} />
        <Chip label="Anuluj" onPress={onCancel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 12 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  more: { paddingVertical: 6, paddingHorizontal: 6 },
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  select: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  number: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, fontSize: 15 },
  days: { flexDirection: 'row', gap: 4 },
  day: { flex: 1, height: 38, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
