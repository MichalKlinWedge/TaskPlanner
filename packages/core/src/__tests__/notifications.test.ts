import { describe, expect, it } from 'vitest';

import {
  dismissOps,
  freshNotifications,
  markReadOps,
  notificationDays,
  notificationSeenKey,
  notificationTarget,
  notificationText,
  notificationTime,
  NotificationPrefs,
  toNotification,
  unreadCount,
  visibleNotifications,
  type AppNotification,
} from '../notifications.ts';
import { MODEL } from '../schemas/model.ts';

const NOW = new Date('2026-11-18T12:00:00Z');
const TZ = 'Europe/Warsaw';
const prefs = NotificationPrefs.parse({});

const note = (patch: Partial<AppNotification> = {}): AppNotification => ({
  id: '01900000-0000-7000-8000-000000000001',
  kind: 'assigned',
  taskId: '01900000-0000-7000-8000-0000000000aa',
  workspaceId: '01900000-0000-7000-8000-0000000000bb',
  actorId: '01900000-0000-7000-8000-0000000000cc',
  data: { actor: 'Jan', title: 'Raport' },
  groupKey: null,
  at: '2026-11-18T11:50:00+00:00',
  readAt: null,
  ...patch,
});

describe('toNotification', () => {
  it('czyta wiersz lokalnej bazy z jsonb jako tekstem', () => {
    const n = toNotification({
      id: 'x', kind: 'comment', task_id: 't', workspace_id: null, actor_id: null, group_key: 'comment:t',
      data: '{"actor":"Ola","excerpt":"Hej","count":3,"obce":1}', at: '2026-11-18T11:00:00+00:00', read_at: null, deleted_at: null,
    });
    expect(n).toMatchObject({ id: 'x', kind: 'comment', taskId: 't', groupKey: 'comment:t', data: { actor: 'Ola', excerpt: 'Hej', count: 3 } });
    expect(n?.data).not.toHaveProperty('obce');
  });

  it('pomija usunięte, nieznane rodzaje i uszkodzone dane', () => {
    expect(toNotification({ id: 'x', kind: 'assigned', at: '2026-11-18T11:00:00Z', deleted_at: '2026-11-18T11:00:00Z' })).toBeNull();
    expect(toNotification({ id: 'x', kind: 'nowy_rodzaj', at: '2026-11-18T11:00:00Z' })).toBeNull();
    expect(toNotification({ id: 'x', kind: 'assigned', at: '2026-11-18T11:00:00Z', data: '{zepsute' })?.data).toEqual({});
    expect(toNotification({ id: 'x', kind: 'assigned', at: '2026-11-18T11:00:00Z', data: { count: 'dużo', role: 'król' } })?.data).toEqual({});
  });
});

describe('notificationText', () => {
  it('zadania — bez form rodzajowych', () => {
    expect(notificationText(note())).toEqual({ text: 'Przypisano Ci zadanie „Raport”', detail: 'Od: Jan' });
    expect(notificationText(note({ kind: 'participant' }))).toEqual({ text: 'Dodano Cię do zadania „Raport”', detail: 'Od: Jan' });
    expect(notificationText(note({ kind: 'completed' }))).toEqual({ text: 'Ukończono zadanie „Raport”', detail: 'Ukończone przez: Jan' });
    expect(notificationText(note({ data: {} }))).toEqual({ text: 'Przypisano Ci zadanie', detail: null });
  });

  it('komentarze — scalone z licznikiem', () => {
    expect(notificationText(note({ kind: 'comment', data: { actor: 'Jan', title: 'Raport', excerpt: 'Gotowe?' } }))).toEqual({
      text: 'Nowy komentarz w „Raport”',
      detail: 'Jan: Gotowe?',
    });
    expect(notificationText(note({ kind: 'comment', data: { actor: 'Jan', title: 'Raport', excerpt: 'Już', count: 3 } }))).toEqual({
      text: '3 nowe komentarze w „Raport”',
      detail: 'Ostatni — Jan: Już',
    });
    expect(notificationText(note({ kind: 'comment', data: { count: 5 } })).text).toBe('5 nowych komentarzy w zadaniu');
  });

  it('udostępnianie', () => {
    const data = { actor: 'Jan', workspace: 'Dom', role: 'editor' as const };
    expect(notificationText(note({ kind: 'invite', data }))).toEqual({ text: 'Zaproszenie do przestrzeni „Dom”', detail: 'Od: Jan · rola: Edytor' });
    expect(notificationText(note({ kind: 'owner_offer', data: { actor: 'Jan', workspace: 'Dom', after: 'leave' } })).detail).toBe(
      'Od: Jan · po przekazaniu ta osoba opuści przestrzeń',
    );
    expect(notificationText(note({ kind: 'member_joined', data }))).toEqual({ text: 'Nowa osoba w przestrzeni „Dom”', detail: 'Jan · rola: Edytor' });
    expect(notificationText(note({ kind: 'member_left', data: { workspace: 'Dom' } }))).toEqual({ text: 'Odejście z przestrzeni „Dom”', detail: 'konto usunięte' });
    expect(notificationText(note({ kind: 'member_removed', data }))).toEqual({ text: 'Nie należysz już do przestrzeni „Dom”', detail: 'Od: Jan' });
    expect(notificationText(note({ kind: 'role_changed', data: { workspace: 'Dom', role: 'viewer' } })).text).toBe('Nowa rola w przestrzeni „Dom”: Podgląd');
    expect(notificationText(note({ kind: 'role_changed', data: {} })).text).toBe('Nowa rola w przestrzeni: —');
  });
});

describe('notificationTarget', () => {
  it('zadanie, zaproszenia, przestrzeń, nic', () => {
    expect(notificationTarget(note())).toEqual({ kind: 'task', taskId: note().taskId });
    expect(notificationTarget(note({ taskId: null }))).toEqual({ kind: 'none' });
    expect(notificationTarget(note({ kind: 'invite' }))).toEqual({ kind: 'invites' });
    expect(notificationTarget(note({ kind: 'owner_offer' }))).toEqual({ kind: 'invites' });
    expect(notificationTarget(note({ kind: 'role_changed' }))).toEqual({ kind: 'workspace', workspaceId: note().workspaceId });
    expect(notificationTarget(note({ kind: 'member_removed' }))).toEqual({ kind: 'none' });
  });
});

describe('lista', () => {
  const list = [
    note({ id: 'a', at: '2026-11-18T11:00:00Z' }),
    note({ id: 'b', at: '2026-11-18T11:30:00Z', readAt: '2026-11-18T11:31:00Z' }),
    note({ id: 'c', kind: 'invite', at: '2026-11-17T09:00:00Z' }),
    note({ id: 'd', at: '2026-08-01T09:00:00Z' }),
  ];

  it('najnowsze pierwsze, bez starszych niż 90 dni i wyłączonych grup', () => {
    expect(visibleNotifications(list, prefs, NOW).map((n) => n.id)).toEqual(['b', 'a', 'c']);
    expect(visibleNotifications(list, prefs, NOW, 'unread').map((n) => n.id)).toEqual(['a', 'c']);
    expect(visibleNotifications(list, { ...prefs, sharing: 'off' }, NOW).map((n) => n.id)).toEqual(['b', 'a']);
    expect(unreadCount(list, prefs, NOW)).toBe(2);
    expect(unreadCount(list, { ...prefs, tasks: 'off' }, NOW)).toBe(1);
  });

  it('sekcje dni w strefie z ustawień', () => {
    const days = notificationDays(visibleNotifications(list, prefs, NOW), NOW, TZ);
    expect(days.map((d) => [d.label, d.items.map((n) => n.id)])).toEqual([
      ['Dziś', ['b', 'a']],
      ['Wczoraj', ['c']],
    ]);
    const older = notificationDays([note({ at: '2026-11-14T10:00:00Z' })], NOW, TZ);
    expect(older[0]!.label).toBe('Sobota, 14 listopada');
  });

  it('czas zdarzenia', () => {
    expect(notificationTime('2026-11-18T11:59:40Z', NOW, TZ)).toBe('przed chwilą');
    expect(notificationTime('2026-11-18T11:48:00Z', NOW, TZ)).toBe('12 min temu');
    expect(notificationTime('2026-11-18T09:05:00Z', NOW, TZ)).toBe('10:05');
  });

  it('operacje: przeczytane (bez już przeczytanych) i usunięcie', () => {
    expect(markReadOps(list, NOW)).toEqual([
      { table: 'notifications', id: 'a', patch: { read_at: NOW.toISOString() } },
      { table: 'notifications', id: 'c', patch: { read_at: NOW.toISOString() } },
      { table: 'notifications', id: 'd', patch: { read_at: NOW.toISOString() } },
    ]);
    expect(dismissOps([list[0]!], NOW)).toEqual([{ table: 'notifications', id: 'a', patch: { deleted_at: NOW.toISOString() } }]);
  });

  it('dymek: tylko nowe, nieprzeczytane i świeże; scalone (nowy czas) znowu', () => {
    const fresh = note({ id: 'f', at: '2026-11-18T11:59:00Z' });
    expect(freshNotifications([fresh, list[0]!], new Set(), NOW).map((n) => n.id)).toEqual(['f']);
    expect(freshNotifications([fresh], new Set([notificationSeenKey(fresh)]), NOW)).toEqual([]);
    expect(freshNotifications([{ ...fresh, at: '2026-11-18T11:59:30Z' }], new Set([notificationSeenKey(fresh)]), NOW)).toHaveLength(1);
  });
});

describe('ustawienia i wiersz', () => {
  it('uszkodzone ustawienia → domyślne', () => {
    expect(NotificationPrefs.parse({ tasks: 'głośno', sharing: 'off', toast: 'tak' })).toEqual({ tasks: 'app', sharing: 'off', toast: true });
  });

  it('schemat wiersza przyjmuje wiersz z serwera', () => {
    expect(
      MODEL.notifications.safeParse({
        id: '01900000-0000-7000-8000-000000000001', user_id: '01900000-0000-7000-8000-000000000002', kind: 'comment',
        task_id: null, workspace_id: null, actor_id: null, data: { count: 2 }, group_key: 'comment:x', at: '2026-11-18T11:00:00.123+00:00', read_at: null,
      }).success,
    ).toBe(true);
  });
});
