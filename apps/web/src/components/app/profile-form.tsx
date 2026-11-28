"use client";

import { ProfileSettings, THEME, WEEKDAY, type IsoWeekday } from "@taskplanner/core";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { Button, Field, Input, Notice, Select } from "./ui";

export interface ProfileValues {
  displayName: string;
  settings: ProfileSettings;
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const satisfies readonly IsoWeekday[];

const FOCUS_FIELDS = [
  ["focusMin", "Praca (min)", 1, 180],
  ["shortBreakMin", "Krótka przerwa (min)", 1, 60],
  ["longBreakMin", "Długa przerwa (min)", 1, 90],
  ["longBreakEvery", "Długa co (etapów)", 1, 12],
] as const;

const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Wartości pól formularza (jak w stanie) — do porównania „zapisane / zmienione” i szkicu. */
function snapshot(s: ProfileSettings, displayName: string | null) {
  return {
    displayName: (displayName ?? "").trim(),
    timeZone: s.timeZone ?? deviceZone(),
    firstDayOfWeek: s.firstDayOfWeek as IsoWeekday,
    days: [...(s.workHours.days as IsoWeekday[])].sort(),
    workStart: s.workHours.start,
    workEnd: s.workHours.end,
    reminderTime: s.defaultReminderTime,
    duration: String(s.defaultDurationMin),
    theme: s.theme,
    dailyReview: s.dailyReview,
    weeklyReview: s.weeklyReview,
    focus: {
      focusMin: String(s.focus.focusMin),
      shortBreakMin: String(s.focus.shortBreakMin),
      longBreakMin: String(s.focus.longBreakMin),
      longBreakEvery: String(s.focus.longBreakEvery),
    },
    focusEnabled: s.focus.enabled,
  };
}
type Snapshot = ReturnType<typeof snapshot>;

/** Niezapisane szkice per `draftKey` w tej karcie (moduł żyje dłużej niż odmontowany ekran „Ustawień”). */
const drafts = new Map<string, { base: string; values: Snapshot }>();

/** Strefy IANA znane przeglądarce; bieżąca zawsze na liście. */
function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return all.includes(current) ? all : [current, ...all];
}

/** Ustawienia profilu (M1) — ten sam formularz w onboardingu i w „Ustawieniach”. */
export function ProfileForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  extra,
  draftKey,
}: {
  initial: { displayName: string | null; settings: unknown };
  submitLabel: string;
  busy?: boolean;
  onSubmit: (values: ProfileValues) => void | Promise<void>;
  /** Dodatkowe pola przed przyciskiem (np. wybór przestrzeni w onboardingu). */
  extra?: ReactNode;
  /** Klucz szkicu (np. id użytkownika): niezapisane pola przetrwają wyjście z ekranu w tej karcie, a zamknięcie karty pyta. */
  draftKey?: string;
}) {
  const start = useMemo(() => {
    const parsed = ProfileSettings.safeParse(initial.settings ?? {});
    return parsed.success ? parsed.data : ProfileSettings.parse({});
  }, [initial.settings]);
  const saved = snapshot(start, initial.displayName);
  const savedKey = JSON.stringify(saved);
  // Szkic sprzed wyjścia z „Ustawień” (ekran się odmontowuje) — tylko gdy zapisane wartości się od tego czasu nie zmieniły.
  const [init] = useState(() => (draftKey && drafts.get(draftKey)?.base === savedKey ? drafts.get(draftKey)!.values : saved));
  const [displayName, setDisplayName] = useState(init.displayName);
  const [timeZone, setTimeZone] = useState(init.timeZone);
  const [firstDayOfWeek, setFirstDayOfWeek] = useState<IsoWeekday>(init.firstDayOfWeek);
  const [days, setDays] = useState<IsoWeekday[]>(init.days);
  const [workStart, setWorkStart] = useState(init.workStart);
  const [workEnd, setWorkEnd] = useState(init.workEnd);
  const [reminderTime, setReminderTime] = useState(init.reminderTime);
  const [duration, setDuration] = useState(init.duration);
  const [theme, setTheme] = useState(init.theme);
  const [dailyReview, setDailyReview] = useState(init.dailyReview);
  const [weeklyReview, setWeeklyReview] = useState(init.weeklyReview);
  const [focus, setFocus] = useState(init.focus);
  const [focusEnabled, setFocusEnabled] = useState(init.focusEnabled);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const zones = useMemo(() => timeZones(timeZone), [timeZone]);

  const current: Snapshot = { displayName: displayName.trim(), timeZone, firstDayOfWeek, days: [...days].sort(), workStart, workEnd, reminderTime, duration, theme, dailyReview, weeklyReview, focus, focusEnabled };
  const currentKey = JSON.stringify(current);
  const dirty = currentKey !== savedKey;

  // Ustawienia zmienione gdzie indziej (inna sekcja, telefon): czysty formularz przyjmuje nowe wartości,
  // a rozpoczęte zmiany zostają (zapis i tak scala je z najnowszymi ustawieniami — `...start`).
  const [base, setBase] = useState(savedKey);
  if (base !== savedKey) {
    setBase(savedKey);
    if (currentKey === base) {
      setDisplayName(saved.displayName);
      setTimeZone(saved.timeZone);
      setFirstDayOfWeek(saved.firstDayOfWeek);
      setDays(saved.days);
      setWorkStart(saved.workStart);
      setWorkEnd(saved.workEnd);
      setReminderTime(saved.reminderTime);
      setDuration(saved.duration);
      setTheme(saved.theme);
      setDailyReview(saved.dailyReview);
      setWeeklyReview(saved.weeklyReview);
      setFocus(saved.focus);
      setFocusEnabled(saved.focusEnabled);
    }
  }

  useEffect(() => {
    if (!draftKey) return;
    if (dirty) drafts.set(draftKey, { base: savedKey, values: current });
    else drafts.delete(draftKey);
  });

  useEffect(() => {
    if (!dirty || !draftKey) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, draftKey]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = ProfileSettings.safeParse({
      ...start,
      timeZone,
      firstDayOfWeek,
      workHours: { days: [...days].sort(), start: workStart, end: workEnd },
      defaultReminderTime: reminderTime,
      defaultDurationMin: Number(duration),
      theme,
      dailyReview,
      weeklyReview,
      focus: {
        focusMin: Number(focus.focusMin),
        shortBreakMin: Number(focus.shortBreakMin),
        longBreakMin: Number(focus.longBreakMin),
        longBreakEvery: Number(focus.longBreakEvery),
        enabled: focusEnabled,
      },
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Niepoprawne ustawienia.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSubmit({ displayName: displayName.trim(), settings: parsed.data });
      setDone(true);
    } catch (e) {
      setError(`Nie udało się zapisać: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleDay = (day: IsoWeekday) => setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day]));

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Field label="Jak się do Ciebie zwracać">
        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={100} autoComplete="given-name" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Strefa czasowa" hint="Terminy zadań są w czasie lokalnym; strefa liczy „dziś” i przypomnienia.">
          <Select value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Pierwszy dzień tygodnia">
          <Select value={firstDayOfWeek} onChange={(e) => setFirstDayOfWeek(Number(e.target.value) as IsoWeekday)}>
            <option value={1}>{WEEKDAY[1].label}</option>
            <option value={7}>{WEEKDAY[7].label}</option>
          </Select>
        </Field>
      </div>
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1 font-medium">Godziny pracy</legend>
        <div className="flex flex-wrap gap-1">
          {WEEKDAYS.map((day) => (
            <button
              key={day}
              type="button"
              aria-pressed={days.includes(day)}
              onClick={() => toggleDay(day)}
              className={`rounded-full border px-3 py-1 text-xs ${days.includes(day) ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)]"}`}
            >
              {WEEKDAY[day].short}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input type="time" aria-label="Początek pracy" value={workStart} onChange={(e) => setWorkStart(e.target.value)} className="w-32" />
          <span>–</span>
          <Input type="time" aria-label="Koniec pracy" value={workEnd} onChange={(e) => setWorkEnd(e.target.value)} className="w-32" />
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Przypomnienie zadania bez godziny" hint="Godzina, o której przypomina się zadanie z samą datą.">
          <Input type="time" value={reminderTime} onChange={(e) => setReminderTime(e.target.value)} />
        </Field>
        <Field label="Domyślny czas bloku (min)" hint="Przy przeciąganiu zadania do kalendarza.">
          <Input type="number" min={5} max={480} step={5} value={duration} onChange={(e) => setDuration(e.target.value)} />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1 font-medium">Przeglądy</legend>
        <p className="text-xs opacity-60">O tej porze w pasku bocznym pojawia się link do przeglądu, a gdy karta jest w tle — powiadomienie (jeśli przeglądarka na nie pozwala).</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={dailyReview.enabled} onChange={(e) => setDailyReview({ ...dailyReview, enabled: e.target.checked })} />
            Przegląd dnia o
          </label>
          <Input type="time" aria-label="Godzina przeglądu dnia" value={dailyReview.time} disabled={!dailyReview.enabled} onChange={(e) => setDailyReview({ ...dailyReview, time: e.target.value as typeof dailyReview.time })} className="w-32" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={weeklyReview.enabled} onChange={(e) => setWeeklyReview({ ...weeklyReview, enabled: e.target.checked })} />
            Przegląd tygodnia w
          </label>
          <Select aria-label="Dzień przeglądu tygodnia" value={weeklyReview.weekday} disabled={!weeklyReview.enabled} onChange={(e) => setWeeklyReview({ ...weeklyReview, weekday: Number(e.target.value) as IsoWeekday })}>
            {WEEKDAYS.map((day) => (
              <option key={day} value={day}>
                {WEEKDAY[day].label}
              </option>
            ))}
          </Select>
          <span>o</span>
          <Input type="time" aria-label="Godzina przeglądu tygodnia" value={weeklyReview.time} disabled={!weeklyReview.enabled} onChange={(e) => setWeeklyReview({ ...weeklyReview, time: e.target.value as typeof weeklyReview.time })} className="w-32" />
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1 font-medium">Tryb skupienia (Pomodoro)</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={focusEnabled} onChange={(e) => setFocusEnabled(e.target.checked)} data-testid="focus-enabled" />
          Włącz tryb skupienia (timer, skrót F, „▶ Skup się” w zadaniu)
        </label>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {FOCUS_FIELDS.map(([key, label, min, max]) => (
            <Field key={key} label={label}>
              <Input type="number" min={min} max={max} value={focus[key]} disabled={!focusEnabled} onChange={(e) => setFocus({ ...focus, [key]: e.target.value })} />
            </Field>
          ))}
        </div>
      </fieldset>
      <Field label="Motyw">
        <Select value={theme} onChange={(e) => setTheme(e.target.value as keyof typeof THEME)} className="sm:w-60">
          {(Object.keys(THEME) as (keyof typeof THEME)[]).map((key) => (
            <option key={key} value={key}>
              {THEME[key]}
            </option>
          ))}
        </Select>
      </Field>
      {extra}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex items-center gap-3">
        <Button kind="primary" type="submit" disabled={busy || saving}>
          {submitLabel}
        </Button>
        {dirty ? <span className="text-sm text-[var(--muted)]">Niezapisane zmiany</span> : done ? <span role="status" className="text-sm text-[var(--ok)]">✓ Zapisano</span> : null}
      </div>
    </form>
  );
}
