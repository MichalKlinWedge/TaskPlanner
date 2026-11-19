import { describe, expect, it } from 'vitest';

import { createFileQueue, FileUploadError, memoryFileStore, retryDelayMs, type PendingFile } from '../files.ts';

const file = (id: string) => ({ id, taskId: 't1', storagePath: `u/t1/${id}-a.jpg`, name: 'a.jpg', mime: 'image/jpeg', size: 3 });

function setup(upload: (path: string) => Promise<void>) {
  let clock = 1_000_000;
  const store = memoryFileStore();
  const committed: PendingFile[] = [];
  const queue = createFileQueue({ store, upload, commit: async (f) => void committed.push(f), now: () => clock, maxAttempts: 3 });
  return { queue, store, committed, tick: (ms: number) => (clock += ms) };
}

describe('kolejka plików', () => {
  it('wiersz `attachments` dopiero po udanej wysyłce; offline czeka z odstępem', async () => {
    let online = false;
    const sent: string[] = [];
    const { queue, committed, tick } = setup(async (path) => {
      if (!online) throw new TypeError('Failed to fetch');
      sent.push(path);
    });
    await queue.enqueue(file('a1'), new Uint8Array([1, 2, 3]));
    expect(await queue.flush()).toBe(0);
    expect(committed).toHaveLength(0);
    const [pending] = await queue.list();
    expect(pending).toMatchObject({ attempts: 1, failed: false, error: 'Failed to fetch' });

    online = true;
    expect(await queue.flush()).toBe(0); // przed upływem odstępu nie ponawia
    tick(retryDelayMs(1));
    expect(await queue.flush()).toBe(1);
    expect(sent).toEqual(['u/t1/a1-a.jpg']);
    expect(committed.map((f) => f.id)).toEqual(['a1']);
    expect(await queue.list()).toEqual([]);
  });

  it('błąd zapisu wiersza po wysyłce → ponowienie (wysyłka „już istnieje” = sukces)', async () => {
    const store = memoryFileStore();
    let fail = true;
    const commits: string[] = [];
    let clock = 0;
    const queue = createFileQueue({
      store,
      upload: async () => undefined,
      commit: async (f) => {
        if (fail) throw new Error('baza zajęta');
        commits.push(f.id);
      },
      now: () => clock,
    });
    await queue.enqueue(file('a1'), new Uint8Array([1]));
    await queue.flush();
    expect(commits).toEqual([]);
    fail = false;
    clock += retryDelayMs(1);
    await queue.flush();
    expect(commits).toEqual(['a1']);
  });

  it('błąd trwały albo wyczerpane próby → nieudany do decyzji; ponów / porzuć', async () => {
    const { queue, tick, committed } = setup(async (path) => {
      if (path.includes('big')) throw new FileUploadError('Payload too large', true);
      throw new Error('403 row-level security');
    });
    await queue.enqueue({ ...file('big'), storagePath: 'u/t1/big-a.mp4' }, new Uint8Array([1]));
    await queue.enqueue(file('a2'), new Uint8Array([1]));
    for (let i = 0; i < 4; i++) {
      await queue.flush();
      tick(600_000);
    }
    const list = await queue.list();
    expect(list.find((f) => f.id === 'big')).toMatchObject({ failed: true, attempts: 1 });
    expect(list.find((f) => f.id === 'a2')).toMatchObject({ failed: true, attempts: 3 });
    await queue.retry('a2');
    expect((await queue.list()).find((f) => f.id === 'a2')).toMatchObject({ failed: false, attempts: 0 });
    await queue.discard('big');
    expect((await queue.list()).map((f) => f.id)).toEqual(['a2']);
    expect(committed).toEqual([]);
  });

  it('równoległe `flush` w jednej karcie — jedna wysyłka', async () => {
    let calls = 0;
    const { queue } = setup(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
    });
    await queue.enqueue(file('a1'), new Uint8Array([1]));
    const [a, b] = await Promise.all([queue.flush(), queue.flush()]);
    expect(calls).toBe(1);
    expect(a + b).toBe(2); // ten sam przebieg, ten sam wynik
  });
});
