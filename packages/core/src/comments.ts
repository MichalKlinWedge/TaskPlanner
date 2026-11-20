/**
 * Komentarze zadań (v1.x). Komentarz ma czas napisania z urządzenia (`posted_at`, także offline)
 * i autora z serwera (`created_by` — przed wysłaniem pusty, czyli „Ty”). Edycja zmienia treść
 * i `edited_at`; usunięcie jest miękkie, z cofnięciem.
 */
import { localDateTimeAt } from './dates.ts';
import { relativeDay } from './format.ts';
import { uuidv7 } from './ids.ts';
import { TaskCommentRow } from './schemas/model.ts';
import type { LocalDate } from './schemas/primitives.ts';
import type { TaskOp } from './tasks.ts';

export interface TaskComment {
  id: string;
  taskId: string;
  body: string;
  /** Chwila napisania (ISO). */
  postedAt: string;
  editedAt: string | null;
  /** `created_by` z serwera; `null` = jeszcze niewysłany (autor to bieżący użytkownik). */
  authorId: string | null;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const Body = TaskCommentRow.shape.body;

/** Treść z pola: końcowe odstępy przycięte, pusta i za długa — błąd po polsku. */
export function commentBody(text: string): Result<{ body: string }> {
  const parsed = Body.safeParse(text);
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false, error: parsed.error.issues[0]?.message ?? 'Niepoprawny komentarz.' };
}

export function addCommentOps(taskId: string, text: string, now: Date | string, id: string = uuidv7()): Result<{ id: string; ops: TaskOp[] }> {
  const body = commentBody(text);
  if (!body.ok) return body;
  return { ok: true, id, ops: [{ table: 'task_comments', id, patch: { task_id: taskId, body: body.body, posted_at: new Date(now).toISOString(), edited_at: null, deleted_at: null } }] };
}

/** Zmiana treści; ta sama treść — brak zmian. */
export function editCommentOps(comment: Pick<TaskComment, 'id' | 'body'>, text: string, now: Date | string): Result<{ ops: TaskOp[] }> {
  const body = commentBody(text);
  if (!body.ok) return body;
  if (body.body === comment.body) return { ok: true, ops: [] };
  return { ok: true, ops: [{ table: 'task_comments', id: comment.id, patch: { body: body.body, edited_at: new Date(now).toISOString() } }] };
}

export function deleteCommentOps(commentId: string, now: Date | string): { ops: TaskOp[]; undo: TaskOp[] } {
  return {
    ops: [{ table: 'task_comments', id: commentId, patch: { deleted_at: new Date(now).toISOString() } }],
    undo: [{ table: 'task_comments', id: commentId, patch: { deleted_at: null } }],
  };
}

/** Od najstarszego (kolejność wątku); ta sama chwila — po id (UUIDv7). */
export const sortComments = <T extends Pick<TaskComment, 'id' | 'postedAt'>>(comments: readonly T[]): T[] =>
  [...comments].sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt) || (a.id < b.id ? -1 : 1));

/** Autor komentarza: „Ty” albo „Inna osoba” (cudze komentarze dojdą ze współdzieleniem). */
export const commentAuthor = (authorId: string | null, userId: string): string => (!authorId || authorId === userId ? 'Ty' : 'Inna osoba');

/** „dziś 14:05”, „wczoraj 9:30”, „pt 13 lis 18:00” w strefie użytkownika. */
export function commentTime(postedAt: string, today: LocalDate, timeZone?: string): string {
  const local = localDateTimeAt(postedAt, timeZone);
  const time = local.slice(11, 16).replace(/^0/, '');
  return `${relativeDay(local.slice(0, 10) as LocalDate, today)} ${time}`;
}
