/**
 * Kosz (M3): wiersze usuniętych zadań z lokalnej bazy, grupy usunięte razem (zadanie z podzadaniami) i podgląd
 * zadania z kosza tylko do odczytu z operacjami przywrócenia. Lokalna baza trzyma usunięte wiersze zadań, które
 * były na tym urządzeniu; pełne pobranie (`pull_changes` od zera) ich nie przysyła, więc na nowym urządzeniu kosz
 * może być pusty albo niepełny — wtedy rodzica lub podzadania po prostu nie ma na liście.
 * Tagi, komentarze, załączniki itd. nie są usuwane razem z zadaniem (zostają bez `deleted_at`).
 */
import { isTransientError } from './errors.ts';
import { plural } from './format.ts';
import { descendants, restoreTaskOps, sameDeletion, toViewTask, TRASH_DAYS, type LocalTaskRow, type TaskOp } from './tasks.ts';
import type { ViewTask } from './views.ts';

type Trashed = Pick<ViewTask, 'id' | 'parentId'> & { deletedAt: string };

/** Zadanie w koszu: to samo co w widokach + kiedy usunięte i nazwa listy (też zarchiwizowanej / usuniętej). */
export interface TrashedTask extends ViewTask {
  /** `timestamptz` (ISO). */
  deletedAt: string;
  /** Nazwa listy z lokalnej bazy; `null` = listy nie ma na tym urządzeniu. */
  listName: string | null;
  /** Lista usunięta albo zarchiwizowana (nie ma jej w danych widoków). */
  listState: 'active' | 'archived' | 'deleted' | 'missing';
}

/** Wiersz zapytania `TRASH_SQL` (`packages/sync`) → zadanie w koszu. */
export function toTrashedTask(row: Record<string, unknown>): TrashedTask {
  const tagIds = typeof row.tag_ids === 'string' && row.tag_ids ? row.tag_ids.split(',') : [];
  return {
    ...toViewTask(row as unknown as LocalTaskRow, tagIds),
    deletedAt: String(row.deleted_at),
    listName: (row.list_name as string | null | undefined) ?? null,
    listState: row.list_name == null ? 'missing' : row.list_deleted_at ? 'deleted' : row.list_archived_at ? 'archived' : 'active',
  };
}

/** Od kiedy usunięte zadania są jeszcze w koszu (ISO). */
export const trashSince = (now: Date | number): string => new Date(Number(now) - TRASH_DAYS * 86_400_000).toISOString();

/** Podpis listy zadania z kosza; `name` = nazwa listy z danych widoków (brak = zarchiwizowana albo usunięta). */
export const trashListLabel = (task: Pick<TrashedTask, 'listName' | 'listState'>, name?: string | null): string =>
  name || (task.listName === null ? 'lista niedostępna' : task.listState === 'deleted' ? `${task.listName} (lista usunięta)` : task.listState === 'archived' ? `${task.listName} (zarchiwizowana)` : task.listName);

/** Podzadania (każdego poziomu) usunięte razem z zadaniem — przywracają się z nim. */
export function trashedWith<T extends Trashed>(trashed: readonly T[], id: string): T[] {
  const task = trashed.find((t) => t.id === id);
  return task ? descendants(trashed, id).filter((d) => sameDeletion(d.deletedAt, task.deletedAt)) : [];
}

/** Rodzic usunięty razem z zadaniem. */
const trashedParent = <T extends Trashed>(byId: ReadonlyMap<string, T>, task: T): T | undefined => {
  const parent = task.parentId ? byId.get(task.parentId) : undefined;
  return parent && sameDeletion(parent.deletedAt, task.deletedAt) ? parent : undefined;
};

/** Pozycje kosza: podzadania usunięte razem z rodzicem są pod nim, nie osobno. */
export function trashRoots<T extends Trashed>(trashed: readonly T[]): T[] {
  const byId = new Map(trashed.map((t) => [t.id, t]));
  return trashed.filter((t) => !trashedParent(byId, t));
}

export interface TrashPreview<T> {
  task: T;
  /** Zadanie, z którym to usunięto (samo `task`, gdy usunięto właśnie je). */
  root: T;
  /** Rodzic usunięty razem z zadaniem; `null` — zadanie jest pozycją kosza. */
  parent: T | null;
  /** Bezpośrednie podzadania usunięte razem z zadaniem, w kolejności ręcznej. */
  children: T[];
  /** Ile podzadań wróci razem z `root`. */
  count: number;
  /** Ile podzadań usunięto razem z `task` (znikną z nim przy definitywnym usunięciu). */
  inside: number;
  /** Przywrócenie `root` z całą grupą. */
  restore: TaskOp[];
  /** Podzadanie: przywrócenie tylko jego (z własnymi podzadaniami) jako zadania głównego listy; `null` dla `root`. */
  restoreAlone: TaskOp[] | null;
}

/** Podgląd zadania z kosza; `null` — nie ma go w koszu tego urządzenia. `alive` = id zadań poza koszem. */
export function trashPreview<T extends Trashed & Pick<ViewTask, 'sortKey'>>(trashed: readonly T[], id: string, alive: ReadonlySet<string>): TrashPreview<T> | null {
  const byId = new Map(trashed.map((t) => [t.id, t]));
  const task = byId.get(id);
  if (!task) return null;
  const parent = trashedParent(byId, task) ?? null;
  let root = task;
  // Licznik chroni przed pętlą rodziców w uszkodzonych danych.
  for (let up = parent, i = 0; up && i <= trashed.length; up = trashedParent(byId, up) ?? null, i++) root = up;
  return {
    task,
    root,
    parent,
    children: trashed
      .filter((t) => t.parentId === id && sameDeletion(t.deletedAt, task.deletedAt))
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1)),
    count: trashedWith(trashed, root.id).length,
    inside: trashedWith(trashed, id).length,
    restore: restoreTaskOps(trashed, root.id, { parentAlive: !root.parentId || alive.has(root.parentId) }),
    restoreAlone: parent ? restoreTaskOps(trashed, id, { parentAlive: false }) : null,
  };
}

/** Pytanie przed definitywnym usunięciem zadania; `inside` = podzadania usunięte razem z nim, `shared` = przestrzeń z innymi osobami. */
export function purgeQuestion(title: string, inside: number, shared = false): { title: string; text: string } {
  return {
    title: `Usunąć na stałe „${title}”?`,
    text:
      `Zadanie${inside ? ` z ${plural(inside, ['podzadaniem', 'podzadaniami', 'podzadaniami'])}` : ''}, komentarze, załączniki, przypomnienia i zapisany czas znikną z serwera i wszystkich urządzeń` +
      `${shared ? ', także u innych osób w tej przestrzeni' : ''}. Tego nie da się cofnąć.`,
  };
}

/** Dlaczego definitywne usunięcie się nie udało (błąd `purgeTasks` z `packages/sync`). */
export function purgeErrorText(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'TP007') return 'Na serwerze tego zadania nie ma w koszu — przywrócono je na innym urządzeniu albo usunięcie czeka jeszcze na wysłanie.';
  if (code === 'TP003') return 'Lista jest udostępniona Ci tylko do podglądu — zadania nie da się usunąć.';
  if (isTransientError(error)) return 'Brak połączenia z serwerem. Definitywne usunięcie wymaga sieci.';
  return `Nie udało się usunąć zadania na stałe: ${error instanceof Error ? error.message : String(error)}`;
}
