"use client";

import { ProfileSettings, THEME, WEEKDAY, type IsoWeekday } from "@taskplanner/core";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";

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
}: {
  initial: { displayName: string | null; settings: unknown };
  submitLabel: string;
  busy?: boolean;
  onSubmit: (values: ProfileValues) => void | Promise<void>;
  /** Dodatkowe pola przed przyciskiem (np. wybór przestrzeni w onboardingu). */
  extra?: ReactNode;
}) {
  const start = useMemo(() => {
    const parsed = ProfileSettings.safeParse(initial.settings ?? {});
    return parsed.success ? parsed.data : ProfileSettings.parse({});
  }, [initial.settings]);
  const [displayName, setDisplayName] = useState(initial.displayName ?? "");
  const [timeZone, setTimeZone] = useState(start.timeZone ?? deviceZone());
  const [firstDayOfWeek, setFirstDayOfWeek] = useState<IsoWeekday>(start.firstDayOfWeek as IsoWeekday);
  const [days, setDays] = useState<IsoWeekday[]>(start.workHours.days as IsoWeekday[]);
  const [workStart, setWorkStart] = useState(start.workHours.start);
  const [workEnd, setWorkEnd] = useState(start.workHours.end);
  const [reminderTime, setReminderTime] = useState(start.defaultReminderTime);
  const [duration, setDuration] = useState(String(start.defaultDurationMin));
  const [theme, setTheme] = useState(start.theme);
  const [dailyReview, setDailyReview] = useState(start.dailyReview);
  const [weeklyReview, setWeeklyReview] = useState(start.weeklyReview);
  const [focus, setFocus] = useState(() => ({
    focusMin: String(start.focus.focusMin),
    shortBreakMin: String(start.focus.shortBreakMin),
    longBreakMin: String(start.focus.longBreakMin),
    longBreakEvery: String(start.focus.longBreakEvery),
  }));
  const [focusEnabled, setFocusEnabled] = useState(start.focus.enabled);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => timeZones(timeZone), [timeZone]);

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
    await onSubmit({ displayName: displayName.trim(), settings: parsed.data });
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
      <div>
        <Button kind="primary" type="submit" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
