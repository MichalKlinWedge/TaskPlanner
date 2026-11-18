/**
 * Lokalna część PoC-1 (bez Expo): silnik na podanej bazie z udawanym serwerem. Na telefonie
 * na expo-sqlite (`checks.ts`), w Node na `node:sqlite` — ten sam scenariusz.
 */
import { completionId, formatHlc, uuidv7 } from '@taskplanner/core';
import { SyncEngine, type LocalDb, type PullResult, type PushOp, type PushResult, type Remote } from '@taskplanner/sync';

export type Add = (name: string, ok: boolean, detail?: string) => void;
const ms = (start: number) => `${(performance.now() - start).toFixed(2)} ms`;

const serverHlc = () => formatHlc({ wall: Date.now(), counter: 0, node: 'server' });

/** Serwer w pamięci: przyjmuje wszystko poza operacjami z polem `title` = „ODRZUĆ”. */
function fakeRemote(userId: string) {
  const pushed: PushOp[] = [];
  let pending: PullResult['tables'] = {};
  const remote: Remote = {
    async push(ops): Promise<PushResult> {
      pushed.push(...ops);
      const bad = ops.filter((o) => o.set.title === 'ODRZUĆ');
      return {
        applied: ops.length - bad.length,
        rejected: bad.map((o) => ({ op: o.op, code: 'TP003', message: 'brak dostępu (test)' })),
        clamped: [],
        rows: bad.map((o) => ({ table: o.table, id: o.id, row: null })),
        serverHlc: serverHlc(),
      };
    },
    async pull(): Promise<PullResult> {
      const tables = pending;
      pending = {};
      return { scopes: { [userId]: { kind: 'personal', version: 1, role: 'owner' } }, tables, serverHlc: serverHlc() };
    },
  };
  return { remote, pushed, serve: (tables: PullResult['tables']) => (pending = tables) };
}

export async function localSyncScenario(db: LocalDb, add: Add) {
  {
    const userId = '00000000-0000-4000-8000-0000000000aa';
    const fake = fakeRemote(userId);
    const engine = await SyncEngine.open({ db, remote: fake.remote, userId, autoSync: false });
    const listId = uuidv7();
    const taskId = uuidv7();

    await engine.mutate('lists', listId, { scope_id: userId, kind: 'list', name: 'Test', sort_key: 'n' });
    await engine.mutate('tasks', taskId, { list_id: listId, title: 'Pierwsze', priority: 3, sort_key: 'n' });
    const row = await engine.get('tasks', taskId);
    add('mutate: wiersz lokalny + zakres z listy', row?.title === 'Pierwsze' && row?.scope_id === userId, `scope ${row?.scope_id}`);
    add('mutate: 2 wpisy w outboxie', (await engine.pendingCount()) === 2);

    let threw = false;
    try {
      await engine.mutate('tasks', taskId, { nie_ma_takiego_pola: 1 });
    } catch {
      threw = true;
    }
    add('nieznane pole → wyjątek, nic nie zapisane', threw && (await engine.pendingCount()) === 2);

    await engine.sync();
    add('push: outbox pusty, operacje wysłane', (await engine.pendingCount()) === 0 && fake.pushed.length === 2, `${fake.pushed.length} op.`);

    const rejectedId = uuidv7();
    await engine.mutate('tasks', rejectedId, { list_id: listId, title: 'ODRZUĆ', sort_key: 'n' });
    await engine.sync();
    const rejected = await engine.rejectedOps();
    add('odrzucona operacja → status rejected, wiersz serwera (brak) nadpisuje lokalny', rejected.length === 1 && !(await engine.get('tasks', rejectedId)), String(rejected[0]?.error ?? ''));

    // Scalanie per pole: serwer ma nowszy tytuł, lokalnie nowszy priorytet (niewysłany).
    const local = await engine.get('tasks', taskId);
    const localClock = JSON.parse(String(local?.field_clock ?? '{}')) as Record<string, string>;
    await engine.mutate('tasks', taskId, { priority: 1 });
    const newer = formatHlc({ wall: Date.now() + 60_000, counter: 0, node: 'other' });
    fake.serve({
      tasks: [
        {
          ...local,
          id: taskId,
          scope_id: userId,
          title: 'Z serwera',
          priority: 2,
          row_version: 2,
          field_clock: { ...localClock, title: newer, priority: localClock.priority },
        },
      ],
    });
    await engine.pull();
    const merged = await engine.get('tasks', taskId);
    add('pull: nowszy HLC z serwera wygrywa per pole, lokalna niewysłana zmiana zostaje', merged?.title === 'Z serwera' && merged?.priority === 1, `${merged?.title}, !${merged?.priority}`);

    const completion = completionId(taskId, '2026-11-18');
    await engine.mutate('task_completions', completion, { task_id: taskId, occurrence_date: '2026-11-18', kind: 'done', completed_at: new Date().toISOString() });
    await engine.mutate('task_completions', completion, { task_id: taskId, occurrence_date: '2026-11-18', kind: 'done', completed_at: new Date().toISOString() });
    const count = (await db.all<{ n: number }>('select count(*) as n from task_completions where task_id = ?', [taskId]))[0]?.n;
    add('podwójne ukończenie (UUIDv5) → jeden wiersz', Number(count) === 1);

    const start = performance.now();
    for (let i = 0; i < 500; i++) await engine.mutate('tasks', uuidv7(), { list_id: listId, title: `Offline ${i}`, sort_key: 'n' });
    const writeMs = performance.now() - start;
    add('500 zapisów offline (wiersz + outbox) < 10 s', writeMs < 10_000, `${writeMs.toFixed(0)} ms, ${(writeMs / 500).toFixed(2)} ms/zapis`);
    const pushStart = performance.now();
    await engine.push();
    add('wysłanie 500 op. (paczki po 200, serwer udawany)', (await engine.pendingCount()) === 0, ms(pushStart));
  }
}

