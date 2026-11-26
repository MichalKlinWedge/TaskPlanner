/**
 * Centrum powiadomień (v1.x, etapy N1–N3; migracje `*_v1x_notifications.sql`, `*_v1x_notification_system.sql`). Wiersze `notifications` tworzy
 * serwer (wyzwalacze) w zakresie osobistym odbiorcy; klient zaznacza tylko „przeczytane” (`read_at`) i usuwa
 * z listy (`deleted_at`). Tu: rodzaje, teksty (te same w UI i — od N2 — w treści push), cel kliknięcia,
 * filtrowanie według ustawień i grupowanie po dniach.
 */
import { z } from 'zod';

import { addDays, localDateAt, localDateTimeAt } from './dates.ts';
import { dayChip, dayLabel, formatBytes, pluralForm } from './format.ts';
import { LocalTime } from './schemas/primitives.ts';
import { SCOPE_ROLE, type OwnerAfter, type ScopeRole } from './sharing.ts';

export const NOTIFICATION_KINDS = [
  'assigned', 'comment', 'participant', 'completed', 'due_changed',
  'invite', 'owner_offer', 'member_joined', 'member_left', 'member_removed', 'role_changed',
  'delivery_failed', 'connection_error', 'calendar_error', 'ai_error', 'storage_quota',
] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** Grupa w ustawieniach: zadania we wspólnych przestrzeniach, udostępnianie, zdarzenia systemowe (N3). */
export type NotificationGroup = 'tasks' | 'sharing' | 'system';
export const NOTIFICATION_GROUPS: readonly NotificationGroup[] = ['tasks', 'sharing', 'system'];
export const NOTIFICATION_GROUP: Record<NotificationKind, NotificationGroup> = {
  assigned: 'tasks',
  comment: 'tasks',
  participant: 'tasks',
  completed: 'tasks',
  due_changed: 'tasks',
  invite: 'sharing',
  owner_offer: 'sharing',
  member_joined: 'sharing',
  member_left: 'sharing',
  member_removed: 'sharing',
  role_changed: 'sharing',
  delivery_failed: 'system',
  connection_error: 'system',
  calendar_error: 'system',
  ai_error: 'system',
  storage_quota: 'system',
};

export const NOTIFICATION_GROUP_LABEL: Record<NotificationGroup, { title: string; hint: string }> = {
  tasks: { title: 'Zadania we wspólnych przestrzeniach', hint: 'przypisanie, komentarz, dodanie jako uczestnik, ukończenie i zmiana terminu Twojego zadania' },
  sharing: { title: 'Udostępnianie', hint: 'zaproszenia, propozycje roli właściciela, osoby dołączające i odchodzące, zmiana Twojej roli' },
  system: { title: 'Integracje i konto', hint: 'nieudane wysyłki integracji, wyłączone połączenie, kalendarz bez synchronizacji, odrzucony klucz AI, kończące się miejsce na załączniki' },
};

/** Krótka nazwa grupy (filtry widoku `#/notifications`). */
export const NOTIFICATION_GROUP_SHORT: Record<NotificationGroup, string> = { tasks: 'Zadania', sharing: 'Udostępnianie', system: 'Integracje i konto' };

/** `push` = w aplikacji i Web Push na przeglądarki z włączonymi przypomnieniami (etap N2). */
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
  system: NotificationChannel.catch('app').default('app'),
  /** Dymek przy nowym powiadomieniu, gdy karta jest widoczna. */
  toast: z.boolean().catch(true).default(true),
  /** Cisza nocna: bez Web Push w tych godzinach (strefa z ustawień); dzwonek w aplikacji działa dalej. */
  quiet: z
    .object({ enabled: z.boolean().default(false), from: LocalTime.default('22:00'), to: LocalTime.default('07:00') })
    .catch({ enabled: false, from: '22:00', to: '07:00' })
    .prefault({}),
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
  // N3: nazwa połączenia / konta, plugin, termin (pusty tekst = brak), odwołany dostęp, zajęte miejsce.
  label: z.string().max(200).optional().catch(undefined),
  plugin: z.string().max(50).optional().catch(undefined),
  due: z.string().max(10).optional().catch(undefined),
  time: z.string().max(8).optional().catch(undefined),
  before: z.string().max(10).optional().catch(undefined),
  beforeTime: z.string().max(8).optional().catch(undefined),
  revoked: z.boolean().optional().catch(undefined),
  percent: z.number().int().min(0).max(1000).optional().catch(undefined),
  used: z.number().int().min(0).optional().catch(undefined),
  quota: z.number().int().min(0).optional().catch(undefined),
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

/** Termin z migawki: „pt., 20.11 14:00”, pusty = „bez terminu”. */
const dueText = (date: string | undefined, time: string | undefined) =>
  date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${dayChip(date)}${time ? ` ${time.slice(0, 5)}` : ''}` : 'bez terminu';

/** Treść powiadomienia: główny tekst i linia szczegółów (autor, fragment komentarza). Bez form rodzajowych. */
export function notificationText(n: Pick<AppNotification, 'kind' | 'data'>): { text: string; detail: string | null } {
  const { actor, title, workspace, excerpt, role, after, label } = n.data;
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
    case 'due_changed':
      return {
        text: `Nowy termin zadania${named(title)}: ${dueText(n.data.due, n.data.time)}`,
        detail: join(`Było: ${dueText(n.data.before, n.data.beforeTime)}`, from),
      };
    case 'delivery_failed': {
      const what = count > 1 ? `${count} ${pluralForm(count, ['nieudana wysyłka', 'nieudane wysyłki', 'nieudanych wysyłek'])}` : 'Nieudana wysyłka';
      return { text: `${what} do${named(label) || ' integracji'}`, detail: join(title ? `Zadanie: „${title}”` : null, excerpt || null) };
    }
    case 'connection_error':
      return { text: `Integracja${named(label)} wyłączona — usługa odmówiła dostępu`, detail: excerpt || null };
    case 'calendar_error':
      return n.data.revoked
        ? { text: `Kalendarz${named(label)} odłączony — połącz go ponownie`, detail: excerpt || null }
        : { text: `Kalendarz${named(label)} nie synchronizuje się`, detail: excerpt || null };
    case 'ai_error':
      return { text: `Klucz asystenta AI${label ? ` (${label})` : ''} został odrzucony`, detail: excerpt || null };
    case 'storage_quota': {
      const used = n.data.used !== undefined && n.data.quota ? `Zajęte ${formatBytes(n.data.used)} z ${formatBytes(n.data.quota)}` : null;
      return (n.data.percent ?? 0) >= 100
        ? { text: 'Brak miejsca na nowe załączniki', detail: join(used, 'usuń na stałe zadania z plikami z kosza') }
        : { text: `Załączniki zajmują ${n.data.percent ?? 90} % miejsca`, detail: used };
    }
  }
}

export type NotificationTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'invites' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'deliveries' }
  | { kind: 'settings'; section: 'plugins' | 'calendars' | 'ai' }
  | { kind: 'none' };

/** Co otwiera kliknięcie: zadanie, pasek zaproszeń, ekran przestrzeni, dziennik wysyłek albo sekcja ustawień. */
export function notificationTarget(n: Pick<AppNotification, 'kind' | 'taskId' | 'workspaceId'>): NotificationTarget {
  if (NOTIFICATION_GROUP[n.kind] === 'tasks') return n.taskId ? { kind: 'task', taskId: n.taskId } : { kind: 'none' };
  if (n.kind === 'delivery_failed') return { kind: 'deliveries' };
  if (n.kind === 'connection_error') return { kind: 'settings', section: 'plugins' };
  if (n.kind === 'calendar_error') return { kind: 'settings', section: 'calendars' };
  if (n.kind === 'ai_error') return { kind: 'settings', section: 'ai' };
  if (n.kind === 'storage_quota') return { kind: 'none' };
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

/** Filtry widoku `#/notifications` (N3); `workspaceId` dotyczy tylko powiadomień z przestrzenią. */
export interface NotificationFilter {
  only: 'unread' | 'all';
  group: NotificationGroup | null;
  workspaceId: string | null;
}

export function filterNotifications(
  list: readonly AppNotification[],
  prefs: NotificationPrefs,
  now: Date,
  { only, group, workspaceId }: NotificationFilter,
): AppNotification[] {
  return visibleNotifications(list, prefs, now, only).filter(
    (n) => (!group || NOTIFICATION_GROUP[n.kind] === group) && (!workspaceId || n.workspaceId === workspaceId),
  );
}

/** Przestrzenie, z których są powiadomienia (do listy filtra), w kolejności pierwszego wystąpienia; nazwa z migawki. */
export function notificationWorkspaces(list: readonly AppNotification[]): { id: string; name: string }[] {
  const out = new Map<string, string>();
  for (const n of list) if (n.workspaceId && !out.has(n.workspaceId)) out.set(n.workspaceId, n.data.workspace ?? '');
  return [...out].map(([id, name]) => ({ id, name }));
}

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

// ── Web Push (etap N2) ──────────────────────────────────────────────────────────────────────

/** Push wychodzi minutę po ostatnim zdarzeniu (seria komentarzy = jeden push; przeczytane w tym czasie — wcale). */
export const NOTIFICATION_PUSH_DELAY_MS = 60_000;
/** Starsze zdarzenia (przerwa crona, koniec ciszy nocnej) nie idą jako push — czekają w dzwonku. */
export const NOTIFICATION_PUSH_WINDOW_MS = 15 * 60_000;

/** Czy chwila `now` wypada w ciszy nocnej (`from` > `to` = przez północ; `from` = `to` — nigdy). */
export function inQuietHours(prefs: Pick<NotificationPrefs, 'quiet'>, now: Date, timeZone?: string): boolean {
  const { enabled, from, to } = prefs.quiet;
  if (!enabled || from === to) return false;
  const time = localDateTimeAt(now, timeZone).slice(11);
  return from < to ? time >= from && time < to : time >= from || time < to;
}

/** Czy to powiadomienie ma teraz pójść jako Web Push: grupa z kanałem `push`, nieprzeczytane, w oknie czasu, poza ciszą. */
export function wantsPush(n: Pick<AppNotification, 'kind' | 'at' | 'readAt'>, prefs: NotificationPrefs, now: Date, timeZone?: string): boolean {
  if (n.readAt || prefs[NOTIFICATION_GROUP[n.kind]] !== 'push') return false;
  const age = now.getTime() - new Date(n.at).getTime();
  return age >= NOTIFICATION_PUSH_DELAY_MS && age < NOTIFICATION_PUSH_WINDOW_MS && !inQuietHours(prefs, now, timeZone);
}

/** Klucz wysyłki w dzienniku `reminder_deliveries`: scalone powiadomienie (nowy `at`) idzie ponownie. */
export const notificationFireKey = (n: Pick<AppNotification, 'id' | 'at'>): string => `n:${n.id}:${new Date(n.at).getTime()}`;

/** Treść Web Push (Service Worker): tytuł, treść, adres otwarcia i `tag` (nowszy push z tej grupy zastępuje starszy). */
export function notificationPush(n: AppNotification): { title: string; body: string; url: string; tag: string; taskId?: string } {
  const { text, detail } = notificationText(n);
  const target = notificationTarget(n);
  return {
    title: text,
    body: detail ?? '',
    url:
      target.kind === 'task'
        ? `/?task=${target.taskId}`
        : target.kind === 'workspace'
          ? '/#/manage'
          : target.kind === 'deliveries'
            ? '/#/deliveries'
            : target.kind === 'settings'
              ? `/#/settings/${target.section}`
              : '/',
    tag: `tp-n:${n.groupKey ?? n.id}`,
    ...(target.kind === 'task' && { taskId: target.taskId }),
  };
}

// ── Telefon: powiadomienie systemowe po synchronizacji ──────────────────────────────────────

/**
 * Telefon nie dostaje Web Push — pokazuje powiadomienia systemowe sam, po synchronizacji w tle (WorkManager, co
 * kilkanaście minut). Stąd szersze okno niż na serwerze; starsze zdarzenia czekają tylko w dzwonku.
 */
export const NOTIFICATION_PHONE_WINDOW_MS = 24 * 3_600_000;

/**
 * Które powiadomienia telefon ma teraz pokazać w zasobniku: nieprzeczytane, grupa z kanałem `push`, nie starsze niż
 * okno, jeszcze nie pokazane (`shown` = klucze `notificationFireKey`, także wyświetlone jako dymek w aplikacji).
 * W ciszy nocnej — nic (po jej końcu pokażą się te, które zmieszczą się w oknie). Najstarsze pierwsze.
 */
export function phoneNotificationPushes(
  list: readonly AppNotification[],
  prefs: NotificationPrefs,
  shown: ReadonlySet<string>,
  now: Date,
  timeZone?: string,
): AppNotification[] {
  if (inQuietHours(prefs, now, timeZone)) return [];
  return list
    .filter((n) => {
      const age = now.getTime() - new Date(n.at).getTime();
      return !n.readAt && prefs[NOTIFICATION_GROUP[n.kind]] === 'push' && age >= 0 && age < NOTIFICATION_PHONE_WINDOW_MS && !shown.has(notificationFireKey(n));
    })
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}
