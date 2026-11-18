/** Czas pływający urządzenia (SPECYFIKACJA: `due_date` RRRR-MM-DD, `due_time` GG:MM). */
const pad = (n: number) => String(n).padStart(2, '0');

export const toLocalDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toLocalTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const localToday = () => toLocalDate(new Date());
/** `RRRR-MM-DDTGG:MM` — kontekst szybkiego dodawania. */
export const localNow = () => {
  const d = new Date();
  return `${toLocalDate(d)}T${toLocalTime(d)}`;
};

/** Data i godzina pływająca → chwila w strefie urządzenia. */
export function fromLocal(date: string, time = '00:00'): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

/** Początek dnia lokalnego jako ISO (porównanie z `completed_at`). */
export const startOfDayIso = (date: string) => fromLocal(date).toISOString();

export const formatClock = (ms: number) => {
  const d = new Date(ms);
  return `${toLocalDate(d).slice(5)} ${toLocalTime(d)}:${pad(d.getSeconds())}`;
};
