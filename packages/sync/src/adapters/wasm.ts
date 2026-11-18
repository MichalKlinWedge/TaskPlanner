/**
 * Strona karty dla lokalnej bazy w przeglądarce: `LocalDb` nad workerem z `wasm-worker.ts`.
 * `const db = await openWasmDb(new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' }))`.
 */
import { createLocalDb, type LocalDb, type SqlRow, type SqlValue } from '../local-db.ts';
import type { OpenResult, WorkerRequest, WorkerResponse } from './wasm-worker.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export async function openWasmDb(worker: Worker, name = 'taskplanner'): Promise<LocalDb & OpenResult & { close(): void }> {
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const call = pending.get(event.data.id);
    if (!call) return;
    pending.delete(event.data.id);
    if (event.data.error !== undefined) call.reject(new Error(event.data.error));
    else call.resolve(event.data.result);
  };
  const call = <T>(request: DistributiveOmit<WorkerRequest, 'id'>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ ...request, id });
    });

  const info = await call<OpenResult>({ type: 'open', name });
  const db = createLocalDb({
    all: (sql, params) => call<SqlRow[]>({ type: 'all', sql, params: [...params] as SqlValue[] }),
    run: (sql, params) => call<void>({ type: 'run', sql, params: [...params] as SqlValue[] }),
  });
  return Object.assign(db, info, { close: () => worker.terminate() });
}
