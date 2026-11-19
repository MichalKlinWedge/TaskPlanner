/**
 * Samosprawdzenie na telefonie (Hermes): te same przypadki co Vitest w Node i `/dev/recurrence`
 * w przeglądarce (PoC-2, PoC-3) + lokalna część PoC-1 (expo-sqlite, outbox, scalanie)
 * + część sieciowa PoC-1 na prawdziwym Supabase, jeśli jest konto.
 */
import {
  completionId,
  dayLabel,
  describeRecurrence,
  formatHlc,
  formatMinutes,
  habitRate,
  habitStreak,
  HlcClock,
  keyBetween,
  nextDue,
  occurrences,
  parseQuickAdd,
  uuidv5,
  uuidv7,
  type Habit,
  type HabitCompletion,
  type QuickAddContext,
  type QuickAddResult,
  type Recurrence,
  type ScheduleRecurrence,
} from '@taskplanner/core';
import { openExpoDb } from '@taskplanner/sync/expo';
import { deleteDatabaseAsync, openDatabaseAsync } from 'expo-sqlite';

import habitsFixture from '../../../../fixtures/habits.json';
import quickAddContext from '../../../../fixtures/quick-add.context.json';
import quickAddCases from '../../../../fixtures/quick-add.jsonl';
import recurrenceFixture from '../../../../fixtures/recurrence.json';
import { sessionUser } from '../lib/config';
import { localEngine, supabaseClient, syncNow } from '../lib/sync';
import { demoListId, getTask } from '../lib/tasks';
import { localToday } from '../lib/time';
import { localSyncScenario, type Add } from './local-sync';

export interface Check {
  group: string;
  name: string;
  ok: boolean;
  detail: string;
}

const collector = (group: string, out: Check[]): Add => (name, ok, detail = '') => out.push({ group, name, ok, detail });

// ── Środowisko ───────────────────────────────────────────────────────────────────────────────

function environment(add: Add) {
  const g = globalThis as { HermesInternal?: { getRuntimeProperties?: () => Record<string, string> } };
  const props = g.HermesInternal?.getRuntimeProperties?.() ?? {};
  add('Silnik JS = Hermes', !!g.HermesInternal, props['OSS Release Version'] ?? props['Build'] ?? '');
  add('Intl po polsku (dayLabel)', dayLabel('2026-11-18') === 'środa, 18 listopada', dayLabel('2026-11-18'));
  add('formatMinutes', formatMinutes(95) === '1 h 35 min', formatMinutes(95));
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  add('crypto.getRandomValues (polyfill)', bytes.some((b) => b !== 0));
  add('URL (polyfill)', new URL('https://a.pl/x?y=1').searchParams.get('y') === '1');
}

// ── PoC-1: identyfikatory i zegar ────────────────────────────────────────────────────────────

function ids(add: Add) {
  const a = uuidv7();
  add('UUIDv7: format', /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a), a);
  add('UUIDv7: rosnące', uuidv7(1000) < uuidv7(2000));
  // Wartości policzone w Node (Vitest) — muszą być identyczne na każdym silniku.
  const v5 = completionId('0190a000-0000-7000-8000-000000000001', '2026-11-18');
  add('UUIDv5 (własne SHA-1) = Node', v5 === '28792671-ee4e-5a35-9b67-1acdcbfaff0c', v5);
  add('UUIDv5 nazwa = Node', uuidv5('taskplanner') === '60f0b16b-1792-5063-9dd9-4dddc9e1f7e7');
  add('sort_key między', keyBetween('a', 'b') === 'ai', keyBetween('a', 'b'));
  let wall = 5_000;
  const clock = new HlcClock('dev1', () => wall);
  const t1 = clock.tick();
  const t2 = clock.tick();
  wall = 4_000; // zegar cofnięty
  const t3 = clock.tick();
  add('HLC monotoniczny (także po cofnięciu zegara)', t1 < t2 && t2 < t3, `${t1} < ${t2} < ${t3}`);
}

// ── PoC-3: cykliczność i nawyki (jak RecurrenceLab w przeglądarce) ───────────────────────────

type HabitCase = {
  name: string;
  habit: Habit;
  history: { doneFrom?: string; doneTo?: string; missed?: string[]; skipped: string[]; done?: (string | [string, number])[] };
  expect: { current: number; best: number; rate: { from: string; to: string; done: number; possible: number } };
};

function recurrence(add: Add) {
  for (const c of recurrenceFixture.cases as { name: string; rule: Recurrence; occurrences?: string[]; completions?: { occurrence: string; on: string; next: string }[] }[]) {
    if (c.occurrences) {
      const got = occurrences(c.rule as ScheduleRecurrence, { limit: c.occurrences.length + 1 }).slice(
        0,
        /COUNT|UNTIL/.test((c.rule as ScheduleRecurrence).rrule) ? undefined : c.occurrences.length,
      );
      add(`${c.name} (${describeRecurrence(c.rule)})`, JSON.stringify(got) === JSON.stringify(c.occurrences), got.join(', '));
    }
    for (const done of c.completions ?? []) {
      const next = nextDue(c.rule, { occurrence: done.occurrence, completedOn: done.on });
      add(`${c.name}: ukończone ${done.on}`, next === done.next, `→ ${next}`);
    }
  }
  const start = performance.now();
  const many = occurrences({ mode: 'schedule', rrule: 'FREQ=DAILY', anchor: '2026-01-01' }, { limit: 1000 });
  const elapsed = performance.now() - start;
  add('1 000 wystąpień < 20 ms', many.length === 1000 && elapsed < 20, `${elapsed.toFixed(2)} ms`);
}

function habits(add: Add) {
  const { today, cases } = habitsFixture as unknown as { today: string; cases: HabitCase[] };
  for (const c of cases) {
    const h = c.history;
    const history: HabitCompletion[] = h.doneFrom
      ? occurrences(c.habit.recurrence, { from: h.doneFrom, to: h.doneTo, limit: 5000 })
          .filter((d) => !h.missed?.includes(d))
          .map((date) => ({ date, kind: h.skipped.includes(date) ? ('skipped' as const) : ('done' as const) }))
      : [
          ...(h.done ?? []).map((d) => (Array.isArray(d) ? { date: d[0], kind: 'done' as const, value: d[1] } : { date: d, kind: 'done' as const })),
          ...h.skipped.map((date) => ({ date, kind: 'skipped' as const })),
        ];
    const streak = habitStreak(c.habit, history, today);
    const rate = habitRate(c.habit, history, c.expect.rate.from, c.expect.rate.to, today);
    const ok = streak.current === c.expect.current && streak.best === c.expect.best && rate.done === c.expect.rate.done && rate.possible === c.expect.rate.possible;
    add(c.name, ok, `passa ${streak.current}, najdłuższa ${streak.best}, ${rate.done}/${rate.possible}`);
  }
}

// ── PoC-2: korpus szybkiego dodawania (jak quick-add.test.ts) ────────────────────────────────

function comparable(result: QuickAddResult) {
  const { target, recurrence: rec, ...rest } = result.fields;
  return {
    title: result.title,
    ...rest,
    ...(target && { target: { kind: target.kind, name: target.name } }),
    ...(rec && (rec.mode === 'schedule' ? { recurrence: { mode: rec.mode, rrule: rec.rrule } } : { recurrence: rec })),
  };
}

const sorted = (value: unknown): unknown =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]))
    : Array.isArray(value)
      ? value.map(sorted)
      : value;

function quickAdd(add: Add) {
  const ctx: QuickAddContext = {
    now: quickAddContext.now,
    currentWorkspace: quickAddContext.currentWorkspace,
    workspaces: quickAddContext.workspaces,
    lists: quickAddContext.lists,
    tags: quickAddContext.tags,
  };
  const cases = quickAddCases as { input: string; expect: Record<string, unknown>; note?: string }[];
  const failed: string[] = [];
  for (const c of cases) {
    const got = comparable(parseQuickAdd(c.input, ctx));
    if (JSON.stringify(sorted(got)) !== JSON.stringify(sorted(c.expect))) failed.push(`${c.input} → ${JSON.stringify(got)}`);
  }
  add(`Korpus: ${cases.length - failed.length}/${cases.length} zgodnych (Node: 100 %)`, failed.length === 0, failed.slice(0, 3).join(' | '));
  const traps = cases.filter((c) => c.note?.startsWith('pułapka'));
  add(`Pułapki: 0 błędów z ${traps.length}`, !failed.some((f) => traps.some((t) => f.startsWith(`${t.input} →`))));
  const start = performance.now();
  const rounds = 20;
  for (let r = 0; r < rounds; r++) for (const c of cases) parseQuickAdd(c.input, ctx);
  const per = (performance.now() - start) / (rounds * cases.length);
  add('< 5 ms na wpis', per < 5, `${per.toFixed(3)} ms`);
}

// ── PoC-1 lokalnie: expo-sqlite + silnik z udawanym serwerem ─────────────────────────────────

async function localSync(add: Add) {
  const name = 'selftest.db';
  await deleteDatabaseAsync(name).catch(() => undefined);
  const sqlite = await openDatabaseAsync(name);
  try {
    await localSyncScenario(await openExpoDb(sqlite), add);
  } finally {
    await sqlite.closeAsync().catch(() => undefined);
    await deleteDatabaseAsync(name).catch(() => undefined);
  }
}

// ── PoC-1 z serwerem (wymaga konta) ──────────────────────────────────────────────────────────

async function onlineSync(add: Add) {
  const user = sessionUser();
  if (!user.online) {
    add('Pominięte — tryb offline (zaloguj się w „Serwer i konto”)', true);
    return;
  }
  const engine = await localEngine();
  const client = supabaseClient();
  const listId = await demoListId();
  const taskId = uuidv7();
  const title = `Z telefonu ${new Date().toLocaleTimeString('pl-PL')}`;

  // Realtime: drugi kanał patrzy na `sync_scopes` — mierzy czas od wysłania do sygnału.
  let signalAt = 0;
  let ready = false;
  const channel = client
    .channel(`selftest-${uuidv7()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sync_scopes' }, () => {
      signalAt ||= performance.now();
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') ready = true;
    });
  try {
    for (let i = 0; i < 50 && !ready; i++) await new Promise((r) => setTimeout(r, 100));
    add('Realtime: subskrypcja', ready);

    await engine.mutate('tasks', taskId, { list_id: listId, title, due_date: localToday(), sort_key: 'n' });
    const start = performance.now();
    const syncMs = await syncNow();
    add('push + pull na serwer', (await engine.pendingCount()) === 0, `${syncMs} ms`);
    const { data, error } = await client.from('tasks').select('id, title, scope_id, row_version').eq('id', taskId).maybeSingle();
    add('wiersz na serwerze (RLS, zakres wyliczony)', !error && data?.title === title && data?.scope_id === user.id, error?.message ?? `row_version ${data?.row_version}`);
    for (let i = 0; i < 50 && !signalAt; i++) await new Promise((r) => setTimeout(r, 100));
    add('sygnał Realtime < 3 s od wysłania', signalAt > 0 && signalAt - start < 3000, signalAt ? `${(signalAt - start).toFixed(0)} ms` : 'brak sygnału');

    // Zmiana „z drugiego urządzenia” (bezpośrednio RPC z innym węzłem HLC) → pobranie.
    const other = formatHlc({ wall: Date.now(), counter: 0, node: 'selftest2' });
    const { error: pushError } = await client.rpc('push_changes', { p_ops: [{ op: uuidv7(), table: 'tasks', id: taskId, set: { title: `${title} (zmiana z drugiego urządzenia)` }, hlc: other }] });
    add('push_changes z innego węzła', !pushError, pushError?.message ?? '');
    await engine.pull();
    const local = await getTask(taskId);
    add('pull: zmiana z serwera w lokalnej bazie', !!local?.title.endsWith('(zmiana z drugiego urządzenia)'), local?.title ?? '');
  } finally {
    void client.removeChannel(channel);
  }
}

export async function runChecks(onProgress?: (checks: Check[]) => void): Promise<{ checks: Check[]; ms: number }> {
  const checks: Check[] = [];
  const start = performance.now();
  const sync = (group: string, fn: (add: Add) => void) => {
    try {
      fn(collector(group, checks));
    } catch (error) {
      checks.push({ group, name: 'wyjątek', ok: false, detail: String(error) });
    }
    onProgress?.([...checks]);
  };
  const async = async (group: string, fn: (add: Add) => Promise<void>) => {
    try {
      await fn(collector(group, checks));
    } catch (error) {
      checks.push({ group, name: 'wyjątek', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    onProgress?.([...checks]);
  };
  sync('Środowisko', environment);
  sync('PoC-1: id i zegar', ids);
  sync('PoC-3: cykliczność', recurrence);
  sync('PoC-3: nawyki', habits);
  sync('PoC-2: szybkie dodawanie', quickAdd);
  await async('PoC-1: SQLite + silnik (lokalnie)', localSync);
  await async('PoC-1: Supabase', onlineSync);
  return { checks, ms: performance.now() - start };
}
