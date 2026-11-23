/** Wspólne stałe testów E2E i pomiarów. */
export const E2E_EMAIL = 'e2e@taskplanner.test';
export const PERF_EMAIL = 'perf@taskplanner.test';
/** Konto pomiaru widoku „Karteczki” (500 karteczek na jednej liście) — zakładane od zera. */
export const CANVAS_PERF_EMAIL = 'canvas-perf@taskplanner.test';
export const CANVAS_PERF_CARDS = 500;
export const TIME_ZONE = 'Europe/Warsaw';
export const E2E_PROJECT = 'Projekt E2E';
export const E2E_TIMELINE_TASK = 'Etap na osi';
/** Lista w widoku „Karteczki” (v1.x): dwie karteczki na tablicy i jedna na pasku „Do ułożenia”. */
export const E2E_CANVAS_LIST = 'Burza E2E';
export const E2E_CANVAS = { first: 'Pomysł pierwszy', second: 'Pomysł drugi', tray: 'Pomysł z paska', person: 'Ola Nowak' } as const;
/** Port buildu produkcyjnego (`scripts/dev-alt.mjs --prod`) — Service Worker działa tylko w nim. */
export const PORT = Number(process.env.E2E_PORT ?? 3020);
