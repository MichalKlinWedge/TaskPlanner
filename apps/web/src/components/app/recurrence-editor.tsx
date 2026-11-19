"use client";

/**
 * Edytor reguły powtarzania (M7): szablony, tryb zaawansowany, opis po polsku na żywo i podgląd
 * 5 najbliższych dat. Stan formularza i reguła — `core/recurrence-editor.ts` (to samo na telefonie);
 * pole tekstowe rozumie tę samą gramatykę co szybkie dodawanie.
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
  WEEKDAY_CODES,
  type LocalDate,
  type MonthlyBy,
  type Recurrence,
  type RecurrenceDraft,
  type RecurrenceUnit,
  type WeekdayCode,
} from "@taskplanner/core";
import { useMemo, useState, type FormEvent } from "react";

import { Button, Input, Select } from "./ui";

const DAY_SHORT: Record<WeekdayCode, string> = { MO: "Pn", TU: "Wt", WE: "Śr", TH: "Cz", FR: "Pt", SA: "So", SU: "Nd" };
const DAY_NAME: Record<WeekdayCode, string> = { MO: "poniedziałek", TU: "wtorek", WE: "środa", TH: "czwartek", FR: "piątek", SA: "sobota", SU: "niedziela" };
const UNIT_LABEL: Record<RecurrenceUnit, string> = { day: "dni", week: "tygodni", month: "miesięcy", year: "lat" };
const MONTHS = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
/** Daty podglądu; gdy seria wychodzi poza rok — z rokiem („co roku” bez roku to pięć razy ta sama data). */
const previewLine = (dates: LocalDate[]) =>
  dates.map((d) => (dates.at(-1)!.slice(0, 4) !== dates[0]!.slice(0, 4) && daysBetween(dates[0]!, dates.at(-1)!) > 300 ? `${dayChip(d)}.${d.slice(0, 4)}` : dayChip(d))).join(" · ");
const NTH: [number, string][] = [[1, "pierwszy"], [2, "drugi"], [3, "trzeci"], [4, "czwarty"], [-1, "ostatni"]];

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
  const [draft, setDraft] = useState<RecurrenceDraft>(() => draftFromRecurrence(value, anchor));
  const [advanced, setAdvanced] = useState(value !== null);
  const [text, setText] = useState("");
  const [textError, setTextError] = useState<string | null>(null);
  const templates = useMemo(() => recurrenceTemplates(anchor), [anchor]);
  const error = draftError(draft);
  const result = useMemo(() => (error ? null : recurrenceFromDraft(draft, anchor)), [draft, anchor, error]);
  const set = (patch: Partial<RecurrenceDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const fromText = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseQuickAdd(`x ${text}`, { now: localDateTimeAt(new Date(), timeZone), workspaces: [], lists: [], tags: [] });
    const rec = parsed.fields.recurrence;
    if (!rec) return setTextError("Nie rozpoznano — np. „co tydzień w poniedziałek”, „co miesiąc 15.”, „co 3 dni po ukończeniu”.");
    setDraft(draftFromRecurrence(rec.mode === "schedule" ? { ...rec, anchor } : rec, anchor));
    setAdvanced(true);
    setText("");
    setTextError(null);
  };

  const num = (v: string) => (v === "" ? 0 : Math.trunc(Number(v)));

  return (
    <div className="flex flex-col gap-3 rounded-md border border-[var(--line)] p-3 text-sm">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Szablony">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setDraft(t.draft)}
            className="rounded-full border border-[var(--line)] px-2 py-0.5 text-xs hover:bg-[var(--hover)]"
          >
            {t.label}
          </button>
        ))}
        <button type="button" onClick={() => setAdvanced((a) => !a)} className="rounded-full px-2 py-0.5 text-xs text-[var(--accent)] hover:underline">
          {advanced ? "Ukryj szczegóły" : "Więcej opcji…"}
        </button>
      </div>

      {advanced ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Tryb" value={draft.mode} onChange={(e) => set({ mode: e.target.value as RecurrenceDraft["mode"] })}>
              <option value="schedule">Według harmonogramu</option>
              <option value="after_completion">Po ukończeniu</option>
            </Select>
            <span>co</span>
            <Input aria-label="Co ile" type="number" min={1} max={999} value={draft.interval || ""} onChange={(e) => set({ interval: num(e.target.value) })} className="w-16" />
            <Select aria-label="Jednostka" value={draft.unit} onChange={(e) => set({ unit: e.target.value as RecurrenceUnit })}>
              {(Object.keys(UNIT_LABEL) as RecurrenceUnit[]).map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABEL[u]}
                </option>
              ))}
            </Select>
          </div>

          {draft.mode === "schedule" && draft.unit === "week" ? (
            <div className="flex gap-1" role="group" aria-label="Dni tygodnia">
              {WEEKDAY_CODES.map((d) => {
                const on = draft.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    title={DAY_NAME[d]}
                    onClick={() => set({ days: on ? draft.days.filter((x) => x !== d) : [...draft.days, d] })}
                    className={`h-8 w-9 rounded-md border text-xs ${on ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)] hover:bg-[var(--hover)]"}`}
                  >
                    {DAY_SHORT[d]}
                  </button>
                );
              })}
            </div>
          ) : null}

          {draft.mode === "schedule" && draft.unit === "month" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label="Którego dnia" value={draft.monthlyBy} onChange={(e) => set({ monthlyBy: e.target.value as MonthlyBy })}>
                <option value="day">dnia miesiąca</option>
                <option value="weekday">dnia tygodnia</option>
                <option value="last_day">ostatniego dnia</option>
                <option value="last_workday">ostatniego dnia roboczego</option>
              </Select>
              {draft.monthlyBy === "day" ? (
                <Input
                  aria-label="Dni miesiąca"
                  value={draft.monthDays.map((d) => (d === -1 ? "ostatni" : d)).join(", ")}
                  onChange={(e) =>
                    set({
                      monthDays: e.target.value
                        .split(/[,\s]+/)
                        .filter(Boolean)
                        .map((p) => (/^ost/i.test(p) ? -1 : num(p))),
                    })
                  }
                  placeholder="np. 15, ostatni"
                  className="w-36"
                />
              ) : null}
              {draft.monthlyBy === "weekday" ? (
                <>
                  <Select aria-label="Który" value={draft.nth} onChange={(e) => set({ nth: Number(e.target.value) })}>
                    {NTH.map(([n, label]) => (
                      <option key={n} value={n}>
                        {label}
                      </option>
                    ))}
                  </Select>
                  <Select aria-label="Dzień tygodnia" value={draft.weekday} onChange={(e) => set({ weekday: e.target.value as WeekdayCode })}>
                    {WEEKDAY_CODES.map((d) => (
                      <option key={d} value={d}>
                        {DAY_NAME[d]}
                      </option>
                    ))}
                  </Select>
                </>
              ) : null}
            </div>
          ) : null}

          {draft.mode === "schedule" && draft.unit === "year" ? (
            <div className="flex items-center gap-2">
              <Input aria-label="Dzień" type="number" min={1} max={31} value={draft.monthDay || ""} onChange={(e) => set({ monthDay: num(e.target.value) })} className="w-16" />
              <Select aria-label="Miesiąc" value={draft.month} onChange={(e) => set({ month: Number(e.target.value) })}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          {draft.mode === "schedule" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>Koniec:</span>
              <Select
                aria-label="Koniec serii"
                value={draft.end.kind}
                onChange={(e) => {
                  const kind = e.target.value;
                  set({ end: kind === "until" ? { kind, date: today } : kind === "count" ? { kind, n: 10 } : { kind: "never" } });
                }}
              >
                <option value="never">nigdy</option>
                <option value="until">w dniu</option>
                <option value="count">po liczbie powtórzeń</option>
              </Select>
              {draft.end.kind === "until" ? (
                <Input aria-label="Data końca" type="date" value={draft.end.date} min={anchor} onChange={(e) => e.target.value && set({ end: { kind: "until", date: e.target.value } })} />
              ) : null}
              {draft.end.kind === "count" ? (
                <Input aria-label="Liczba powtórzeń" type="number" min={1} max={999} value={draft.end.n || ""} onChange={(e) => set({ end: { kind: "count", n: num(e.target.value) } })} className="w-20" />
              ) : null}
            </div>
          ) : null}

          <form onSubmit={fromText} className="flex flex-col gap-1">
            <div className="flex gap-2">
              <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="albo wpisz, np. co drugi wtorek" aria-label="Reguła słowami" className="flex-1" />
              <Button type="submit" kind="ghost" disabled={!text.trim()}>
                Rozpoznaj
              </Button>
            </div>
            {textError ? <p className="text-xs text-[var(--danger)]">{textError}</p> : null}
          </form>
        </div>
      ) : null}

      <div aria-live="polite" className="flex flex-col gap-1">
        {result ? (
          <>
            <p className="font-medium">↻ {describeRecurrence(result)}</p>
            <p className="text-xs text-[var(--muted)]" data-testid="recurrence-preview">
              {previewLine(previewDates(result, anchor))}
              {result.mode === "after_completion" ? " (przy ukończeniu w terminie)" : ""}
            </p>
          </>
        ) : (
          <p className="text-xs text-[var(--danger)]">{error}</p>
        )}
      </div>

      <div className="flex gap-2">
        <Button disabled={!result} onClick={() => result && onSave(result)}>
          Zapisz
        </Button>
        <Button kind="ghost" onClick={onCancel}>
          Anuluj
        </Button>
      </div>
    </div>
  );
}
