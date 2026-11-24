import { describe, expect, it } from 'vitest';

import { listKindPatch } from '../lists.ts';

describe('listKindPatch', () => {
  it('projekt → lista czyści status i daty; lista → projekt jest aktywny', () => {
    expect(listKindPatch({ kind: 'project', projectStatus: 'on_hold' }, 'list')).toEqual({ kind: 'list', project_status: null, start_date: null, end_date: null });
    expect(listKindPatch({ kind: 'list', projectStatus: null }, 'project')).toEqual({ kind: 'project', project_status: 'active' });
  });

  it('bez zmiany — nic; Inbox ma stały rodzaj', () => {
    expect(listKindPatch({ kind: 'project', projectStatus: 'done' }, 'project')).toEqual({});
    expect(() => listKindPatch({ kind: 'inbox', projectStatus: null }, 'list')).toThrow('Inbox');
  });
});
