import { describe, expect, it } from 'vitest';

import {
  REMINDER_SNOOZE_OPTIONS,
  reminderPopups,
  reminderSnoozeLabel,
  dismissOps,
  filterNotifications,
  freshNotifications,
  inQuietHours,
  markReadOps,
  notificationDays,
  notificationFireKey,
  notificationPush,
  notificationSeenKey,
  notificationTarget,
  notificationText,
  notificationTime,
  notificationWorkspaces,
  NotificationPrefs,
  phoneNotificationPushes,
  reminderBellUpdate,
  reminderNotifications,
  EMPTY_REMINDER_BELL,
  toNotification,
  unreadCount,
  visibleNotifications,
  wantsPush,
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
    expect(NotificationPrefs.parse({ tasks: 'głośno', sharing: 'off', toast: 'tak', quiet: { from: '25:00' } })).toEqual({
      tasks: 'app',
      sharing: 'off',
      system: 'app',
      reminders: 'app',
      toast: true,
      quiet: { enabled: false, from: '22:00', to: '07:00' },
    });
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

describe('Web Push (N2)', () => {
  const push = NotificationPrefs.parse({ tasks: 'push', sharing: 'push' });
  const at = (iso: string) => new Date(iso);

  it('cisza nocna przez północ i w ciągu dnia, w strefie z ustawień', () => {
    const night = { quiet: { enabled: true, from: '22:00', to: '07:00' } };
    expect(inQuietHours(night, at('2026-11-18T21:30:00Z'), TZ)).toBe(true); // 22:30 w Warszawie
    expect(inQuietHours(night, at('2026-11-18T05:59:00Z'), TZ)).toBe(true); // 06:59
    expect(inQuietHours(night, at('2026-11-18T06:00:00Z'), TZ)).toBe(false); // 07:00
    expect(inQuietHours({ quiet: { enabled: true, from: '12:00', to: '13:00' } }, at('2026-11-18T11:30:00Z'), TZ)).toBe(true);
    expect(inQuietHours({ quiet: { enabled: false, from: '00:00', to: '23:59' } }, NOW, TZ)).toBe(false);
    expect(inQuietHours({ quiet: { enabled: true, from: '08:00', to: '08:00' } }, NOW, TZ)).toBe(false);
  });

  it('push: kanał grupy, nieprzeczytane, minuta po zdarzeniu, najwyżej 15 min, poza ciszą', () => {
    const n = note({ at: '2026-11-18T11:58:00Z' });
    expect(wantsPush(n, push, NOW, TZ)).toBe(true);
    expect(wantsPush(n, prefs, NOW, TZ)).toBe(false);
    expect(wantsPush({ ...n, readAt: '2026-11-18T11:59:00Z' }, push, NOW, TZ)).toBe(false);
    expect(wantsPush({ ...n, at: '2026-11-18T11:59:30Z' }, push, NOW, TZ)).toBe(false);
    expect(wantsPush({ ...n, at: '2026-11-18T11:40:00Z' }, push, NOW, TZ)).toBe(false);
    expect(wantsPush(n, { ...push, quiet: { enabled: true, from: '12:00', to: '14:00' } }, NOW, TZ)).toBe(false);
    expect(wantsPush({ ...n, kind: 'invite' }, { ...push, sharing: 'app' }, NOW, TZ)).toBe(false);
  });

  it('klucz wysyłki zmienia się ze scaleniem, treść i adres jak w dzwonku', () => {
    expect(notificationFireKey(note())).toBe(`n:${note().id}:${Date.parse('2026-11-18T11:50:00Z')}`);
    expect(notificationFireKey(note({ at: '2026-11-18T11:51:00Z' }))).not.toBe(notificationFireKey(note()));
    expect(notificationPush(note({ groupKey: 'comment:x', kind: 'comment', data: { title: 'Raport', actor: 'Jan', excerpt: 'Hej' } }))).toEqual({
      title: 'Nowy komentarz w „Raport”',
      body: 'Jan: Hej',
      url: `/?task=${note().taskId}`,
      tag: 'tp-n:comment:x',
      taskId: note().taskId,
    });
    expect(notificationPush(note({ kind: 'role_changed', data: { workspace: 'Dom', role: 'editor' } }))).toMatchObject({ url: '/#/manage', tag: `tp-n:${note().id}` });
    expect(notificationPush(note({ kind: 'invite', data: {} }))).toMatchObject({ url: '/', body: '' });
  });
});

describe('zdarzenia systemowe i terminy (N3)', () => {
  const sys = (kind: AppNotification['kind'], data: AppNotification['data']) => note({ kind, data, taskId: null, workspaceId: null, actorId: null });

  it('zmiana terminu: nowy i pierwotny termin, pusty = bez terminu', () => {
    const n = note({ kind: 'due_changed', data: { actor: 'Jan', title: 'Raport', due: '2026-11-20', time: '14:00', before: '2026-11-19', beforeTime: '' } });
    expect(notificationText(n)).toEqual({ text: 'Nowy termin zadania „Raport”: pt., 20.11 14:00', detail: 'Było: czw., 19.11 · Od: Jan' });
    expect(notificationText({ ...n, data: { title: 'Raport', due: '', time: '', before: '2026-11-19' } }).text).toBe('Nowy termin zadania „Raport”: bez terminu');
    expect(notificationTarget(n)).toEqual({ kind: 'task', taskId: n.taskId });
  });

  it('teksty i cele zdarzeń systemowych', () => {
    expect(notificationText(sys('delivery_failed', { label: 'Slack zespołu', title: 'Raport', excerpt: 'HTTP 500', count: 3 }))).toEqual({
      text: '3 nieudane wysyłki do „Slack zespołu”',
      detail: 'Zadanie: „Raport” · HTTP 500',
    });
    expect(notificationText(sys('delivery_failed', {})).text).toBe('Nieudana wysyłka do integracji');
    expect(notificationText(sys('connection_error', { label: 'GitLab', excerpt: '401' })).text).toBe('Integracja „GitLab” wyłączona — usługa odmówiła dostępu');
    expect(notificationText(sys('calendar_error', { label: 'Praca', revoked: true })).text).toBe('Kalendarz „Praca” odłączony — połącz go ponownie');
    expect(notificationText(sys('calendar_error', { label: 'Praca' })).text).toBe('Kalendarz „Praca” nie synchronizuje się');
    expect(notificationText(sys('ai_error', { label: 'Gemini' })).text).toBe('Klucz asystenta AI (Gemini) został odrzucony');
    expect(notificationText(sys('storage_quota', { percent: 90, used: 236_000_000, quota: 262_144_000 })).text).toBe('Załączniki zajmują 90 % miejsca');
    expect(notificationText(sys('storage_quota', { percent: 100 })).text).toBe('Brak miejsca na nowe załączniki');

    expect(notificationTarget(sys('delivery_failed', {}))).toEqual({ kind: 'deliveries' });
    expect(notificationTarget(sys('connection_error', {}))).toEqual({ kind: 'settings', section: 'plugins' });
    expect(notificationTarget(sys('calendar_error', {}))).toEqual({ kind: 'settings', section: 'calendars' });
    expect(notificationTarget(sys('ai_error', {}))).toEqual({ kind: 'settings', section: 'ai' });
    expect(notificationTarget(sys('storage_quota', {}))).toEqual({ kind: 'none' });
    expect(notificationPush(sys('connection_error', { label: 'GitLab' })).url).toBe('/#/settings/plugins');
    expect(notificationPush(sys('delivery_failed', {})).url).toBe('/#/deliveries');
  });

  it('grupa „system” ma własny kanał (push, wyłączenie)', () => {
    const n = sys('ai_error', {});
    expect(visibleNotifications([n], { ...prefs, system: 'off' }, NOW)).toEqual([]);
    expect(wantsPush({ ...n, at: '2026-11-18T11:58:00Z' }, { ...prefs, system: 'push' }, NOW, TZ)).toBe(true);
    expect(wantsPush({ ...n, at: '2026-11-18T11:58:00Z' }, { ...prefs, tasks: 'push' }, NOW, TZ)).toBe(false);
  });

  it('filtry widoku: stan, grupa, przestrzeń; lista przestrzeni z migawki', () => {
    const W2 = '01900000-0000-7000-8000-0000000000b2';
    const a = note({ id: 'a', data: { workspace: 'Dom' } });
    const b = note({ id: 'b', kind: 'invite', workspaceId: W2, data: { workspace: 'Praca' }, readAt: '2026-11-18T11:55:00Z' });
    const c = sys('ai_error', {});
    const list = [a, b, { ...c, id: 'c' }];
    const ids = (f: Parameters<typeof filterNotifications>[3]) => filterNotifications(list, prefs, NOW, f).map((n) => n.id);
    expect(ids({ only: 'all', group: null, workspaceId: null })).toHaveLength(3);
    expect(ids({ only: 'unread', group: null, workspaceId: null }).sort()).toEqual(['a', 'c']);
    expect(ids({ only: 'all', group: 'sharing', workspaceId: null })).toEqual(['b']);
    expect(ids({ only: 'all', group: null, workspaceId: W2 })).toEqual(['b']);
    expect(notificationWorkspaces(list)).toEqual([
      { id: a.workspaceId, name: 'Dom' },
      { id: W2, name: 'Praca' },
    ]);
  });
});

describe('telefon: powiadomienie systemowe po synchronizacji', () => {
  const push = { ...prefs, tasks: 'push' as const };
  it('nieprzeczytane z kanałem push, w oknie 24 h, jeszcze nie pokazane; najstarsze pierwsze; cisza nocna — nic', () => {
    const a = note({ id: 'a', at: '2026-11-18T11:00:00Z' });
    const b = note({ id: 'b', at: '2026-11-18T09:00:00Z' });
    const old = note({ id: 'old', at: '2026-11-17T11:00:00Z' });
    const read = note({ id: 'r', readAt: '2026-11-18T11:30:00Z' });
    const invite = note({ id: 'i', kind: 'invite' });
    const shown = new Set([notificationFireKey(note({ id: 'b', at: '2026-11-18T09:00:00Z' }))]);
    expect(phoneNotificationPushes([a, b, old, read, invite], push, new Set(), NOW, TZ).map((n) => n.id)).toEqual(['b', 'a']);
    expect(phoneNotificationPushes([a, b], push, shown, NOW, TZ).map((n) => n.id)).toEqual(['a']);
    expect(phoneNotificationPushes([a], prefs, new Set(), NOW, TZ)).toEqual([]);
    // 13:00 w Warszawie.
    expect(phoneNotificationPushes([a], { ...push, quiet: { enabled: true, from: '12:30', to: '14:00' } }, new Set(), NOW, TZ)).toEqual([]);
  });
});

describe('przypomnienia w dzwonku', () => {
  it('okno na środku ekranu: tylko tryb „popup”, nieprzeczytane, ≤ 15 min, niezamknięte; najstarsze pierwsze', () => {
    const now = new Date('2026-11-18T12:00:00.000Z');
    const entry = (id: string, at: string, readAt: string | null = null) => ({ id, kind: 'reminder' as const, taskId: 't1', workspaceId: null, actorId: null, data: {}, groupKey: null, at, readAt });
    const list = [
      entry('r:b', '2026-11-18T11:58:00.000Z'),
      entry('r:a', '2026-11-18T11:50:00.000Z'),
      entry('r:old', '2026-11-18T11:40:00.000Z'),
      entry('r:read', '2026-11-18T11:59:00.000Z', '2026-11-18T11:59:00.000Z'),
      entry('r:closed', '2026-11-18T11:59:30.000Z'),
      { ...entry('n1', '2026-11-18T11:59:00.000Z'), kind: 'comment' as const },
    ];
    const state = { popped: ['r:closed'] };
    expect(reminderPopups(list, { reminders: 'popup' }, state, now).map((n) => n.id)).toEqual(['r:a', 'r:b']);
    expect(reminderPopups(list, { reminders: 'app' }, state, now)).toEqual([]);
  });
  it('„Przypomnij za…”: 15 min, 30 min, 1 h', () => {
    expect(REMINDER_SNOOZE_OPTIONS.map(reminderSnoozeLabel)).toEqual(['15 min', '30 min', '1 h']);
  });
  const fire = (key: string, fireAt: string) => ({ key, taskId: 't1', reminderId: key.split(':')[0]!, occurrenceDate: '2026-11-18' as const, fireAt, dueAt: '2026-11-18T11:30:00.000Z' });
  const tasks = new Map([['t1', { title: 'Raport', dueTime: '12:30', kind: 'task' as const, habit: null }]]);
  it('wybite w ostatnich 24 h, z treścią z chwili wybicia; przyszłe i starsze — nie', () => {
    const list = reminderNotifications(
      [fire('a:2026-11-18', '2026-11-18T11:30:00.000Z'), fire('b:2026-11-18', '2026-11-18T13:00:00.000Z'), fire('c:2026-11-16', '2026-11-16T11:00:00.000Z')],
      tasks, EMPTY_REMINDER_BELL, NOW, TZ,
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'r:a:2026-11-18', kind: 'reminder', taskId: 't1', readAt: null });
    expect(notificationText(list[0]!)).toEqual({ text: 'Przypomnienie: „Raport”', detail: 'Teraz (12:30)' });
    expect(notificationTarget(list[0]!)).toEqual({ kind: 'task', taskId: 't1' });
    // Wiersza w bazie nie ma — żadnych operacji.
    expect(markReadOps(list, NOW)).toEqual([]);
    expect(dismissOps(list, NOW)).toEqual([]);
  });

  it('przeczytane / usunięte na urządzeniu; „wszystkie do chwili”; wyłączone w ustawieniach', () => {
    const fires = [fire('a:2026-11-18', '2026-11-18T11:30:00.000Z'), fire('d:2026-11-18', '2026-11-18T11:50:00.000Z')];
    const first = reminderNotifications(fires, tasks, EMPTY_REMINDER_BELL, NOW, TZ);
    const read = reminderBellUpdate(EMPTY_REMINDER_BELL, [first[0]!, note()], 'read');
    expect(read.read).toEqual(['r:a:2026-11-18']);
    expect(reminderNotifications(fires, tasks, read, NOW, TZ).map((n) => Boolean(n.readAt))).toEqual([true, false]);
    expect(reminderNotifications(fires, tasks, reminderBellUpdate(EMPTY_REMINDER_BELL, [first[1]!], 'dismissed'), NOW, TZ).map((n) => n.id)).toEqual(['r:a:2026-11-18']);
    expect(reminderNotifications(fires, tasks, { ...EMPTY_REMINDER_BELL, readBefore: '2026-11-18T11:40:00Z' }, NOW, TZ).map((n) => Boolean(n.readAt))).toEqual([true, false]);
    expect(unreadCount(first, { ...prefs, reminders: 'off' }, NOW)).toBe(0);
    expect(unreadCount(first, prefs, NOW)).toBe(2);
  });
});
