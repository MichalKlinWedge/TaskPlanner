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
/** Druga osoba (edytor) we wspólnej przestrzeni z listą „Burza wspólna” — 30 karteczek na pasku. */
export const E2E_EMAIL_2 = 'e2e-2@taskplanner.test';
export const E2E_SHARED_LIST = 'Burza wspólna';
export const E2E_SHARED_CARDS = 30;
export const E2E_CANVAS = { first: 'Pomysł pierwszy', second: 'Pomysł drugi', tray: 'Pomysł z paska', sub: 'Pomysł drugi — szczegół', person: 'Ola Nowak', participant: 'Jan Kowal' } as const;
/** Port buildu produkcyjnego (`scripts/dev-alt.mjs --prod`) — Service Worker działa tylko w nim. */
export const PORT = Number(process.env.E2E_PORT ?? 3020);
