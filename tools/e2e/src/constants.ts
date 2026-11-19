/** Wspólne stałe testów E2E i pomiarów. */
export const E2E_EMAIL = 'e2e@taskplanner.test';
export const PERF_EMAIL = 'perf@taskplanner.test';
export const TIME_ZONE = 'Europe/Warsaw';
export const E2E_PROJECT = 'Projekt E2E';
export const E2E_TIMELINE_TASK = 'Etap na osi';
/** Port buildu produkcyjnego (`scripts/dev-alt.mjs --prod`) — Service Worker działa tylko w nim. */
export const PORT = Number(process.env.E2E_PORT ?? 3020);
