/**
 * Czas ścienny w strefie IANA ↔ chwila (ms od epoki) przez `Intl` — bez bibliotek, tak samo w Deno,
 * Node i przeglądarce. Czysty moduł (testy w `tools/edge-tests`).
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

export function isValidZone(zone: string): boolean {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  /** `RRRR-MM-DD` */
  date: string;
  /** `GG:MM` */
  time: string;
  second: number;
}

export function zonedParts(ms: number, zone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    second: Number(parts.second),
  };
}

/** Przesunięcie strefy w chwili `ms` (ms, czas lokalny − UTC). */
function offsetAt(ms: number, zone: string): number {
  const p = zonedParts(ms, zone);
  const [y, m, d] = p.date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = p.time.split(':').map(Number) as [number, number];
  return Date.UTC(y, m - 1, d, hh, mm, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * Chwila dla czasu ściennego `date` + `time` (`GG:MM` albo `GG:MM:SS`) w strefie. Godzina z luki przy
 * zmianie na czas letni przesuwa się do przodu (jak w Google Calendar), podwójna jesienią — pierwsza.
 */
export function zonedToInstant(date: string, time: string, zone: string): number {
  // Serie powtarzają te same godziny — pamięć podręczna skraca rozwinięcie ICS kilkukrotnie (CPU funkcji: 2 s).
  const key = `${zone}|${date}|${time}`;
  let hit = instants.get(key);
  if (hit === undefined) {
    if (instants.size > 50_000) instants.clear();
    hit = computeInstant(date, time, zone);
    instants.set(key, hit);
  }
  return hit;
}

const instants = new Map<string, number>();

function computeInstant(date: string, time: string, zone: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm, ss = 0] = time.split(':').map(Number) as [number, number, number?];
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss);
  // Przesunięcia sprzed i po ewentualnej zmianie czasu (zmiany są rzadsze niż co 12 h).
  const candidates = [...new Set([wall - offsetAt(wall - 43_200_000, zone), wall - offsetAt(wall + 43_200_000, zone)])];
  const fits = candidates.filter((t) => {
    const p = zonedParts(t, zone);
    return p.date === date && p.time === time.slice(0, 5);
  });
  // Jesień: oba pasują → wcześniejsza. Wiosna (luka): żaden → późniejsza chwila (czas przesunięty do przodu).
  return fits.length ? Math.min(...fits) : Math.max(...candidates);
}

export const DAY_MS = 86_400_000;
