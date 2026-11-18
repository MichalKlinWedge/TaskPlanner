/**
 * Wspólny kształt wydarzenia z kalendarza zewnętrznego (wiersz `calendar_events` bez kluczy) i okno
 * synchronizacji −30…+180 dni (SPECYFIKACJA M18). Czysty moduł.
 */
import { DAY_MS } from './time.ts';

export interface EventRow {
  external_id: string;
  title: string;
  all_day: boolean;
  /** ISO 8601 UTC; tylko wydarzenia z godziną. */
  start_at: string | null;
  end_at: string | null;
  /** `RRRR-MM-DD`; tylko całodniowe, `end_date` bez włączenia (jak w iCalendar). */
  start_date: string | null;
  end_date: string | null;
  location: string | null;
  /** Skrót treści (ICS) albo etag Google — zmiana = zapis. */
  etag: string;
}

export interface SyncWindow {
  fromMs: number;
  toMs: number;
}

export const syncWindow = (nowMs: number): SyncWindow => ({ fromMs: nowMs - 30 * DAY_MS, toMs: nowMs + 180 * DAY_MS });

/**
 * Czy wydarzenie zachodzi na okno. Całodniowe porównywane po datach UTC z marginesem jednego dnia
 * (strefa użytkownika nie jest tu znana; klient i tak przycina do widoku).
 */
export function overlapsWindow(ev: EventRow, w: SyncWindow): boolean {
  if (ev.all_day) {
    const start = Date.parse(`${ev.start_date}T00:00:00Z`) - DAY_MS;
    const end = Date.parse(`${ev.end_date}T00:00:00Z`) + DAY_MS;
    return end > w.fromMs && start < w.toMs;
  }
  return Date.parse(ev.end_at!) > w.fromMs && Date.parse(ev.start_at!) < w.toMs;
}

/** Krótki, stabilny skrót tekstu (cyrb53) — do wykrywania zmian, nie do bezpieczeństwa. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function contentEtag(ev: Omit<EventRow, 'etag'>): string {
  return hashText(JSON.stringify([ev.title, ev.all_day, ev.start_at, ev.end_at, ev.start_date, ev.end_date, ev.location]));
}
