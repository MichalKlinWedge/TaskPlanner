import { describe, expect, it } from 'vitest';

import { addCommentOps, commentAuthor, commentBody, commentTime, deleteCommentOps, editCommentOps, sortComments } from '../comments.ts';
import { MODEL } from '../schemas/model.ts';

const TASK = '01900000-0000-7000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000001';

describe('komentarze', () => {
  it('nowy komentarz: przycięta treść, czas napisania z urządzenia, wiersz zgodny ze schematem', () => {
    const result = addCommentOps(TASK, '  Zadzwonię jutro.\n', '2026-11-20T10:00:00Z', '01900000-0000-7000-8000-0000000000c1');
    expect(result).toEqual({
      ok: true,
      id: '01900000-0000-7000-8000-0000000000c1',
      ops: [{ table: 'task_comments', id: '01900000-0000-7000-8000-0000000000c1', patch: { task_id: TASK, body: 'Zadzwonię jutro.', posted_at: '2026-11-20T10:00:00.000Z', edited_at: null, deleted_at: null } }],
    });
    const { deleted_at: _, ...row } = result.ok ? result.ops[0]!.patch : {};
    expect(MODEL.task_comments.safeParse({ id: '01900000-0000-7000-8000-0000000000c1', ...row }).success).toBe(true);
  });

  it('pusty i za długi — błąd', () => {
    expect(commentBody('   ')).toEqual({ ok: false, error: 'Komentarz nie może być pusty.' });
    expect(commentBody('x'.repeat(10_001)).ok).toBe(false);
    expect(addCommentOps(TASK, '', '2026-11-20T10:00:00Z').ok).toBe(false);
  });

  it('edycja: tylko gdy treść inna, z `edited_at`; usunięcie z cofnięciem', () => {
    const comment = { id: 'c1', body: 'Ala' };
    expect(editCommentOps(comment, ' Ala ', '2026-11-20T11:00:00Z')).toEqual({ ok: true, ops: [] });
    expect(editCommentOps(comment, 'Ola', '2026-11-20T11:00:00Z')).toEqual({ ok: true, ops: [{ table: 'task_comments', id: 'c1', patch: { body: 'Ola', edited_at: '2026-11-20T11:00:00.000Z' } }] });
    expect(deleteCommentOps('c1', '2026-11-20T11:00:00Z')).toEqual({
      ops: [{ table: 'task_comments', id: 'c1', patch: { deleted_at: '2026-11-20T11:00:00.000Z' } }],
      undo: [{ table: 'task_comments', id: 'c1', patch: { deleted_at: null } }],
    });
  });

  it('kolejność wątku, autor, czas w strefie użytkownika', () => {
    const list = [
      { id: 'b', postedAt: '2026-11-20T10:00:00Z' },
      { id: 'a', postedAt: '2026-11-20T10:00:00+00:00' },
      { id: 'c', postedAt: '2026-11-19T22:00:00Z' },
    ];
    expect(sortComments(list).map((c) => c.id)).toEqual(['c', 'a', 'b']);
    expect(commentAuthor(null, USER)).toBe('Ty');
    expect(commentAuthor(USER, USER)).toBe('Ty');
    expect(commentAuthor('00000000-0000-4000-8000-000000000002', USER)).toBe('Inna osoba');
    expect(commentTime('2026-11-20T08:05:00Z', '2026-11-20', 'Europe/Warsaw')).toBe('dziś 9:05');
    expect(commentTime('2026-11-19T22:30:00Z', '2026-11-20', 'Europe/Warsaw')).toBe('wczoraj 23:30');
    expect(commentTime('2026-11-13T17:00:00Z', '2026-11-20', 'Europe/Warsaw')).toBe('pt 13 lis 18:00');
  });
});
