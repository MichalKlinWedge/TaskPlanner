import { describe, expect, it } from 'vitest';

import { inboxId } from '../ids.ts';
import { defaultWorkspaceId, isOnboarded, onboardingOps } from '../onboarding.ts';
import { ListRow, ProfileSettings, WorkspaceRow } from '../schemas/model.ts';

const USER = '00000000-0000-4000-8000-0000000000c1';

describe('onboarding', () => {
  it('profil, „Osobiste” i „Praca” z Inboxem — w kolejności zapisu', () => {
    const ops = onboardingOps(USER, { displayName: ' Michał ', settings: { firstDayOfWeek: 1, defaultDurationMin: 45 } });
    expect(ops.map((o) => `${o.table}:${(o.patch.name as string | undefined) ?? ''}`)).toEqual([
      'profiles:', 'workspaces:Osobiste', 'lists:Inbox', 'workspaces:Praca', 'lists:Inbox',
    ]);
    expect(ops[0]!.patch.display_name).toBe('Michał');
    expect(ops[0]!.patch.settings).toMatchObject({ onboarded: true, defaultDurationMin: 45, workHours: { start: '09:00' } });
    const personal = defaultWorkspaceId(USER, 'personal');
    expect(ops[1]!.id).toBe(personal);
    expect(ops[2]).toMatchObject({ id: inboxId(personal), patch: { scope_id: personal, kind: 'inbox' } });
  });

  it('te same id na każdym urządzeniu (onboarding offline na dwóch urządzeniach nie dubluje przestrzeni)', () => {
    expect(onboardingOps(USER).map((o) => o.id)).toEqual(onboardingOps(USER).map((o) => o.id));
    expect(defaultWorkspaceId(USER, 'personal')).not.toBe(defaultWorkspaceId(USER, 'work'));
  });

  it('wiersze przechodzą schematy modelu', () => {
    for (const op of onboardingOps(USER)) {
      if (op.table === 'workspaces') expect(WorkspaceRow.safeParse({ id: op.id, archived_at: null, board_columns: null, ...op.patch }).success).toBe(true);
      if (op.table === 'lists') {
        const row = { id: op.id, color: null, icon: null, description_md: null, start_date: null, end_date: null, project_status: null, view_prefs: {}, archived_at: null, board_columns: null, ...op.patch };
        expect(ListRow.safeParse(row).success).toBe(true);
      }
    }
  });

  it('tylko wybrane przestrzenie; isOnboarded z ustawień profilu', () => {
    expect(onboardingOps(USER, { workspaces: ['personal'] }).filter((o) => o.table === 'workspaces')).toHaveLength(1);
    expect(isOnboarded(null)).toBe(false);
    expect(isOnboarded(ProfileSettings.parse({}))).toBe(false);
    expect(isOnboarded(onboardingOps(USER)[0]!.patch.settings)).toBe(true);
  });
});
