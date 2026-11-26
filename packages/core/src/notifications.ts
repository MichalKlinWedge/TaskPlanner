/**
 * Centrum powiadomień (v1.x, etap N1; migracja `*_v1x_notifications.sql`). Wiersze `notifications` tworzy
 * serwer (wyzwalacze) w zakresie osobistym odbiorcy; klient zaznacza tylko „przeczytane” (`read_at`) i usuwa
 * z listy (`deleted_at`). Tu: rodzaje, teksty (te same w UI i — od N2 — w treści push), cel kliknięcia,
 * filtrowanie według ustawień i grupowanie po dniach.
 */
import { z } from 'zod';

import { addDays, localDateAt } from './dates.ts';
import { dayLabel, pluralForm } from './format.ts';
import { SCOPE_ROLE, type OwnerAfter, type ScopeRole } from './sharing.ts';

export const NOTIFICATION_KINDS = [
  'assigned', 'comment', 'participant', 'completed',
  'invite', 'owner_offer', 'member_joined', 'member_left', 'member_removed', 'role_changed',
] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** Grupa w ustawieniach: zadania we wspólnych przestrzeniach albo udostępnianie. */
export type NotificationGroup = 'tasks' | 'sharing';
export const NOTIFICATION_GROUP: Record<NotificationKind, NotificationGroup> = {
  assigned: 'tasks',
  comment: 'tasks',
  participant: 'tasks',
  completed: 'tasks',
  invite: 'sharing',
  owner_offer: 'sharing',
  member_joined: 'sharing',
  member_left: 'sharing',
  member_removed: 'sharing',
  role_changed: 'sharing',
};

export const NOTIFICATION_GROUP_LABEL: Record<NotificationGroup, { title: string; hint: string }> = {
  tasks: { title: 'Zadania we wspólnych przestrzeniach', hint: 'przypisanie, komentarz, dodanie jako uczestnik, ukończenie Twojego zadania' },
  sharing: { title: 'Udostępnianie', hint: 'zaproszenia, propozycje roli właściciela, osoby dołączające i odchodzące, zmiana Twojej roli' },
};

/** `push` = w aplikacji i Web Push (etap N2; do tego czasu działa jak `app`). */
export const NotificationChannel = z.enum(['off', 'app', 'push']);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

export const NOTIFICATION_CHANNEL: Record<NotificationChannel, string> = {
  off: 'Wyłączone',
  app: 'W aplikacji',
  push: 'W aplikacji i push',
};

/** `profiles.settings.notifications`; uszkodzone wartości wracają do domyślnych. */
export const NotificationPrefs = z.object({
  tasks: NotificationChannel.catch('app').default('app'),
  sharing: NotificationChannel.catch('app').default('app'),
  /** Dymek przy nowym powiadomieniu, gdy karta jest widoczna. */
  toast: z.boolean().catch(true).default(true),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

/** `notifications.data` (camelCase); nieznane pola pomijane. */
export const NotificationData = z.object({
  actor: z.string().max(200).optional().catch(undefined),
  title: z.string().max(500).optional().catch(undefined),
  workspace: z.string().max(200).optional().catch(undefined),
  excerpt: z.string().max(500).optional().catch(undefined),
  role: z.enum(['owner', 'editor', 'viewer']).optional().catch(undefined),
  after: z.enum(['editor', 'viewer', 'leave']).optional().catch(undefined),
  count: z.number().int().min(1).optional().catch(undefined),
});
export type NotificationData = z.infer<typeof NotificationData>;

/** Starsze niż tyle dni powiadomienia nie są pokazywane (serwer usuwa je miękko po tym samym czasie). */
export const NOTIFICATION_RETENTION_DAYS = 90;

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  taskId: string | null;
  workspaceId: string | null;
  actorId: string | null;
  data: NotificationData;
  groupKey: string | null;
  /** Ostatnie zdarzenie (scalone powiadomienie przesuwa ten czas). */
  at: string;
  readAt: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** Wiersz lokalnej bazy (jsonb jako tekst albo obiekt) → powiadomienie; nieznany rodzaj / usunięty wiersz → `null`. */
export function toNotification(row: Record<string, unknown>): AppNotification | null {
  if (row.deleted_at) return null;
  const kind = NotificationKind.safeParse(row.kind);
  const at = text(row.at);
  if (!kind.success || !at || typeof row.id !== 'string') return null;
  let raw: unknown = row.data;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = {};
    }
  }
  const data = NotificationData.safeParse(raw ?? {});
  return {
    id: row.id,
    kind: kind.data,
    taskId: text(row.task_id),
    workspaceId: text(row.workspace_id),
    actorId: text(row.actor_id),
    data: data.success ? data.data : {},
    groupKey: text(row.group_key),
    at,
    readAt: text(row.read_at),
  };
}

const quoted = (value: string | undefined, fallback: string) => (value ? `„${value}”` : fallback);
const roleName = (role: ScopeRole | undefined) => (role ? SCOPE_ROLE[role] : null);
const afterNote = (after: OwnerAfter | undefined) =>
  after === 'leave' ? 'po przekazaniu ta osoba opuści przestrzeń' : after ? `po przekazaniu ta osoba zostanie z rolą ${SCOPE_ROLE[after]}` : 'jako kolejny właściciel';

/** Treść powiadomienia: główny tekst i linia szczegółów (autor, fragment komentarza). Bez form rodzajowych. */
export function notificationText(n: Pick<AppNotification, 'kind' | 'data'>): { text: string; detail: string | null } {
  const { actor, title, workspace, excerpt, role, after } = n.data;
  const count = n.data.count ?? 1;
  const task = quoted(title, 'zadaniu');
  // Tytuł / nazwa po spacji albo nic (migawka może być pusta).
  const named = (value: string | undefined) => (value ? ` „${value}”` : '');
  const space = named(workspace);
  const from = actor ? `Od: ${actor}` : null;
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ') || null;
  switch (n.kind) {
    case 'assigned':
      return { text: `Przypisano Ci zadanie${named(title)}`, detail: from };
    case 'comment': {
      const what = count > 1 ? `${count} ${pluralForm(count, ['nowy komentarz', 'nowe komentarze', 'nowych komentarzy'])}` : 'Nowy komentarz';
      const last = actor && excerpt ? `${actor}: ${excerpt}` : (actor ?? excerpt ?? null);
      return { text: `${what} w ${task}`, detail: count > 1 && last ? `Ostatni — ${last}` : last };
    }
    case 'participant':
      return { text: `Dodano Cię do zadania${named(title)}`, detail: from };
    case 'completed':
      return { text: `Ukończono zadanie${named(title)}`, detail: actor ? `Ukończone przez: ${actor}` : null };
    case 'invite':
      return { text: `Zaproszenie do przestrzeni${space}`, detail: join(from, roleName(role) && `rola: ${roleName(role)}`) };
    case 'owner_offer':
      return { text: `Propozycja roli właściciela przestrzeni${space}`, detail: join(from, afterNote(after)) };
    case 'member_joined':
      return { text: `Nowa osoba w przestrzeni${space}`, detail: join(actor ?? null, roleName(role) && `rola: ${roleName(role)}`) };
    case 'member_left':
      return { text: `Odejście z przestrzeni${space}`, detail: actor ?? 'konto usunięte' };
    case 'member_removed':
      return { text: `Nie należysz już do przestrzeni${space}`, detail: from };
    case 'role_changed':
      return { text: `Nowa rola w przestrzeni${space}: ${roleName(role) ?? '—'}`, detail: from };
  }
}

export type NotificationTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'invites' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'none' };

/** Co otwiera kliknięcie: zadanie, pasek zaproszeń albo ekran przestrzeni. */
export function notificationTarget(n: Pick<AppNotification, 'kind' | 'taskId' | 'workspaceId'>): NotificationTarget {
  if (NOTIFICATION_GROUP[n.kind] === 'tasks') return n.taskId ? { kind: 'task', taskId: n.taskId } : { kind: 'none' };
  if (n.kind === 'invite' || n.kind === 'owner_offer') return { kind: 'invites' };
  if (n.kind === 'member_removed' || !n.workspaceId) return { kind: 'none' };
  return { kind: 'workspace', workspaceId: n.workspaceId };
}

/** Widoczne powiadomienia (bez wyłączonych grup i starszych niż retencja), najnowsze pierwsze. */
export function visibleNotifications(
  list: readonly AppNotification[],
  prefs: NotificationPrefs,
  now: Date,
  only: 'unread' | 'all' = 'all',
): AppNotification[] {
  const since = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000).toISOString();
  return list
    .filter((n) => prefs[NOTIFICATION_GROUP[n.kind]] !== 'off' && new Date(n.at).toISOString() >= since && (only === 'all' || !n.readAt))
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : new Date(b.at).getTime() - new Date(a.at).getTime()));
}

export const unreadCount = (list: readonly AppNotification[], prefs: NotificationPrefs, now: Date): number =>
  visibleNotifications(list, prefs, now, 'unread').length;

/** Sekcje listy: „Dziś”, „Wczoraj”, dalej dzień tygodnia z datą (strefa z ustawień albo urządzenia). */
export function notificationDays(
  list: readonly AppNotification[],
  now: Date,
  timeZone?: string,
): { label: string; items: AppNotification[] }[] {
  const today = localDateAt(now, timeZone);
  const yesterday = addDays(today, -1);
  const out: { day: string; label: string; items: AppNotification[] }[] = [];
  for (const n of list) {
    const day = localDateAt(n.at, timeZone);
    let section = out.at(-1);
    if (section?.day !== day) {
      const label = day === today ? 'Dziś' : day === yesterday ? 'Wczoraj' : dayLabel(day).replace(/^./, (c) => c.toUpperCase());
      section = { day, label, items: [] };
      out.push(section);
    }
    section.items.push(n);
  }
  return out.map(({ label, items }) => ({ label, items }));
}

/** Godzina zdarzenia: „przed chwilą”, „12 min temu”, dalej „14:05” (sekcja dnia mówi resztę). */
export function notificationTime(at: string, now: Date, timeZone?: string): string {
  const minutes = Math.floor((now.getTime() - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return 'przed chwilą';
  if (minutes < 60) return `${minutes} min temu`;
  return new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(at));
}

export type NotificationOp = { table: 'notifications'; id: string; patch: { read_at?: string; deleted_at?: string } };

/** Zaznaczenie jako przeczytane (już przeczytane pomijane). */
export const markReadOps = (list: readonly Pick<AppNotification, 'id' | 'readAt'>[], now: Date): NotificationOp[] =>
  list.filter((n) => !n.readAt).map((n) => ({ table: 'notifications', id: n.id, patch: { read_at: now.toISOString() } }));

/** Usunięcie z listy (miękkie, przechodzi na inne urządzenia). */
export const dismissOps = (list: readonly Pick<AppNotification, 'id'>[], now: Date): NotificationOp[] =>
  list.map((n) => ({ table: 'notifications', id: n.id, patch: { deleted_at: now.toISOString() } }));

/** Nowe nieprzeczytane od poprzedniego odczytu (dymek): id spoza `seen`, zdarzenie nie starsze niż 2 min. */
export function freshNotifications(list: readonly AppNotification[], seen: ReadonlySet<string>, now: Date): AppNotification[] {
  return list.filter((n) => !n.readAt && !seen.has(notificationSeenKey(n)) && now.getTime() - new Date(n.at).getTime() < 120_000);
}

/** Klucz „widziane” dla dymka — scalone powiadomienie (nowy `at`) pokazuje się ponownie. */
export const notificationSeenKey = (n: Pick<AppNotification, 'id' | 'at'>): string => `${n.id}:${n.at}`;
