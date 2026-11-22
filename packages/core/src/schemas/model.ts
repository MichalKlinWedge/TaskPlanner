/**
 * Model danych (SPECYFIKACJA §5) jako schematy Zod: wiersze tabel (kolumny snake_case — formularze
 * i operacje `mutate`/`push_changes`) i zawartość kolumn `jsonb` (camelCase). Ograniczenia jak
 * w migracji (długości, zakresy, formaty); kolumny systemowe (`row_version`, `field_clock`,
 * `created_at`…) nie należą do schematów — pilnuje ich serwer.
 *
 * Wiersze tabel synchronizowanych mają dokładnie kolumny z `packages/sync/src/specs.ts` (`TABLES`)
 * plus `id` — sprawdza to test w `packages/sync`.
 */
import { z } from 'zod';

import { FocusSettings, FocusState } from '../focus.ts';
import { HabitSettings } from '../habits.ts';
import { Recurrence } from '../recurrence.ts';
import { ReviewStats } from '../review.ts';
import { CompletedMode, FilterQuery, GroupBy, SortBy } from '../views.ts';
import { GuestAccess, IsoWeekday, ListKind, LocalDate, LocalTime, Priority, ProjectStatus, ReminderKind, SortKey, TaskStatus } from './primitives.ts';

// ── Typy pomocnicze ──────────────────────────────────────────────────────────────────────────

const Id = z.uuid();
/** Chwila (`timestamptz`), także z przesunięciem strefy, jak zwraca Postgres. */
export const Instant = z.iso.datetime({ offset: true });
export const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Kolor w formacie #RRGGBB.');
const Icon = z.string().min(1).max(40);
const name = (max: number) => z.string().trim().min(1, 'Nazwa nie może być pusta.').max(max);

/** Strefa IANA (`Europe/Warsaw`), którą zna `Intl` na urządzeniu. */
export const TimeZone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, 'Nieznana strefa czasowa.');

// ── jsonb ────────────────────────────────────────────────────────────────────────────────────

/** `lists.board_columns`: własna kolumna tablicy listy (v1.x). */
export const BoardColumnDef = z.object({ id: Id, name: name(60) });
export type BoardColumnDef = z.infer<typeof BoardColumnDef>;
/** Własne kolumny tablicy w kolejności wyświetlania; `null` = brak. */
export const BoardColumns = z.array(BoardColumnDef).max(50);

/** `lists.view_prefs`: ustawienia widoku listy (M2). */
export const ViewPrefs = z.object({
  view: z.enum(['list', 'kanban', 'calendar', 'timeline']).optional(),
  /** Kryterium kolumn tablicy (M10). */
  boardBy: z.enum(['status', 'priority', 'weekday', 'tag', 'list', 'custom']).optional().catch(undefined),
  groupBy: GroupBy.optional(),
  sortBy: SortBy.optional(),
  completed: CompletedMode.optional(),
  /** Filtr z chipów „+ Filtr” zapamiętany dla listy; uszkodzony nie psuje reszty ustawień. */
  filter: FilterQuery.optional().catch(undefined),
});
export type ViewPrefs = z.infer<typeof ViewPrefs>;

/** `tasks.source`: skąd zadanie przyszło. */
export const TaskSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('quick_add'), text: z.string().max(1000) }),
  z.object({ kind: z.literal('email'), from: z.email().optional(), subject: z.string().max(500).optional(), receivedAt: Instant.optional() }),
  z.object({ kind: z.literal('link'), url: z.url(), title: z.string().max(500).optional() }),
  z.object({ kind: z.literal('calendar'), eventId: z.string() }),
]);
export type TaskSource = z.infer<typeof TaskSource>;

/** `attachments.preview`: podgląd linku (`link-preview`). */
export const AttachmentPreview = z.object({
  title: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  image: z.url().optional(),
  siteName: z.string().max(200).optional(),
  icon: z.url().optional(),
});
export type AttachmentPreview = z.infer<typeof AttachmentPreview>;

/** `devices.push_subscription`: subskrypcja Web Push przeglądarki. */
export const PushSubscriptionJson = z.object({
  endpoint: z.url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
export type PushSubscriptionJson = z.infer<typeof PushSubscriptionJson>;

/** `profiles.settings` (M1); `ProfileSettings.parse({})` daje komplet domyślnych. */
export const ProfileSettings = z.object({
  /** Brak = strefa urządzenia. */
  timeZone: TimeZone.optional(),
  firstDayOfWeek: IsoWeekday.default(1),
  workHours: z
    .object({
      days: z.array(IsoWeekday).min(1).default([1, 2, 3, 4, 5]),
      start: LocalTime.default('09:00'),
      end: LocalTime.default('17:00'),
    })
    .refine((w) => w.start < w.end, 'Koniec pracy musi być po początku.')
    .prefault({}),
  /** Przypomnienie zadania bez godziny. */
  defaultReminderTime: LocalTime.default('09:00'),
  /** Czas bloku przy przeciąganiu do kalendarza. */
  defaultDurationMin: z.number().int().min(5).max(480).default(30),
  focus: FocusSettings.prefault({}),
  dailyReview: z.object({ enabled: z.boolean().default(false), time: LocalTime.default('20:00') }).prefault({}),
  weeklyReview: z.object({ enabled: z.boolean().default(false), weekday: IsoWeekday.default(7), time: LocalTime.default('18:00') }).prefault({}),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  /** Onboarding zakończony (M1) — bez niego aplikacja po zalogowaniu pokazuje kreator. */
  onboarded: z.boolean().default(false),
});
export type ProfileSettings = z.infer<typeof ProfileSettings>;

/**
 * `profiles.calendar_sync` (Etap 12, M18): konto Google z kalendarzem „Task Planner” i przestrzenie, których
 * zadania z godziną są tam wydarzeniami. Pusta lista = nic nie wysyłamy (wydarzenia znikają z Google).
 */
export const CalendarSync = z.object({
  accountId: Id,
  workspaceIds: z.array(Id).max(100),
});
export type CalendarSync = z.infer<typeof CalendarSync>;

// ── Wiersze: konto i struktura ───────────────────────────────────────────────────────────────

/** Profil: id = id użytkownika = jego zakres osobisty. */
export const ProfileRow = z.object({
  id: Id,
  display_name: z.string().trim().max(100).nullable(),
  settings: ProfileSettings,
  /** Timer skupienia (Etap 7); `null` = brak. */
  focus: FocusState.nullable(),
  /** Zadania z godziną → kalendarz „Task Planner” w Google (Etap 12); `null` = wyłączone. */
  calendar_sync: CalendarSync.nullable(),
});

export const DeviceRow = z.object({
  id: Id,
  /** Zakres osobisty. */
  scope_id: Id,
  name: name(100),
  platform: z.enum(['web', 'android']),
  /** Czy to urządzenie dostaje przypomnienia (M1: telefon / przeglądarka / oba). */
  reminder_channel: z.enum(['enabled', 'disabled']),
  push_subscription: PushSubscriptionJson.nullable(),
  last_sync_at: Instant.nullable(),
});

export const WorkspaceRow = z.object({
  id: Id,
  name: name(100),
  color: Color.nullable(),
  icon: Icon.nullable(),
  sort_key: SortKey,
  archived_at: Instant.nullable(),
  /** Nieużywane — własne kolumny są per lista (`ListRow.board_columns`); zostaje w bazie. */
  board_columns: BoardColumns.nullable(),
});

export const ListRow = z
  .object({
    id: Id,
    /** Przestrzeń listy. */
    scope_id: Id,
    kind: ListKind,
    name: name(200),
    color: Color.nullable(),
    icon: Icon.nullable(),
    description_md: z.string().max(20_000).nullable(),
    start_date: LocalDate.nullable(),
    end_date: LocalDate.nullable(),
    project_status: ProjectStatus.nullable(),
    sort_key: SortKey,
    view_prefs: ViewPrefs,
    archived_at: Instant.nullable(),
    /** Własne kolumny tablicy listy (`BoardColumns`); `null` = brak. */
    board_columns: BoardColumns.nullable(),
    /** Dostęp gości współdzielonej przestrzeni (`hidden` / `view` / `edit`); zmienia tylko właściciel. */
    guest_access: GuestAccess.default('edit'),
  })
  .refine((l) => !l.start_date || !l.end_date || l.start_date <= l.end_date, { message: 'Koniec projektu przed początkiem.', path: ['end_date'] })
  .refine((l) => l.kind === 'project' || (!l.project_status && !l.start_date && !l.end_date), { message: 'Daty i status mają tylko projekty.', path: ['kind'] });

// ── Wiersze: zadania ─────────────────────────────────────────────────────────────────────────

export const TaskRow = z
  .object({
    id: Id,
    list_id: Id,
    parent_id: Id.nullable(),
    kind: z.enum(['task', 'habit']),
    title: name(500),
    description_md: z.string().max(100_000).nullable(),
    status: TaskStatus,
    priority: Priority,
    start_date: LocalDate.nullable(),
    due_date: LocalDate.nullable(),
    due_time: LocalTime.nullable(),
    duration_min: z.number().int().min(1).max(10_080).nullable(),
    time_zone: TimeZone.nullable(),
    recurrence: Recurrence.nullable(),
    habit: HabitSettings.nullable(),
    completed_at: Instant.nullable(),
    sort_key: SortKey,
    /** Kolejność na tablicy kanbanu z kilku list (D15); brak = kolejność automatyczna. */
    board_sort_key: SortKey.nullable(),
    source: TaskSource.nullable(),
    postpone_count: z.number().int().min(0),
    /** Odpowiedzialny (`collaborators.id`); `null` = twórca zadania. */
    assignee_id: Id.nullable(),
    /** Własna kolumna tablicy (`lists.board_columns` listy zadania); `null` / nieznane id = „Do przypisania”. */
    board_column_id: Id.nullable(),
  })
  .refine((t) => t.due_date || (!t.due_time && !t.start_date), { message: 'Godzina i początek wymagają terminu.', path: ['due_date'] })
  .refine((t) => !t.start_date || !t.due_date || t.start_date <= t.due_date, { message: 'Początek po terminie.', path: ['start_date'] })
  .refine((t) => t.kind !== 'habit' || t.recurrence?.mode === 'schedule', { message: 'Nawyk wymaga reguły według harmonogramu.', path: ['recurrence'] })
  .refine((t) => t.id !== t.parent_id, { message: 'Zadanie nie może być własnym podzadaniem.', path: ['parent_id'] });

export const TagRow = z.object({
  id: Id,
  /** Zakres osobisty (id użytkownika). */
  scope_id: Id,
  name: name(60),
  color: Color.nullable(),
  sort_key: SortKey,
  /** Przestrzenie, w których tag się pokazuje i podpowiada; `null` / `[]` = wszystkie (`tagVisibleIn`). */
  workspace_ids: z.array(Id).max(100).nullable(),
});

export const TaskTagRow = z.object({ id: Id, task_id: Id, tag_id: Id });

export const TaskCompletionRow = z.object({
  id: Id,
  task_id: Id,
  occurrence_date: LocalDate,
  kind: z.enum(['done', 'skipped']),
  value: z.number().min(0).nullable(),
  completed_at: Instant,
});

export const ReminderRow = z
  .object({
    id: Id,
    task_id: Id,
    kind: ReminderKind,
    /** Minuty przed terminem (do 4 tygodni). */
    offset_min: z.number().int().min(0).max(40_320).nullable(),
    at_date: LocalDate.nullable(),
    at_time: LocalTime.nullable(),
  })
  .refine((r) => (r.kind === 'relative' ? r.offset_min !== null : r.at_date !== null && r.at_time !== null), {
    message: 'Przypomnienie względne wymaga wyprzedzenia, bezwzględne — daty i godziny.',
    path: ['kind'],
  });

export const TaskDependencyRow = z
  .object({
    id: Id,
    predecessor_id: Id,
    successor_id: Id,
    kind: z.literal('finish_to_start'),
    lag_days: z.number().int().min(-365).max(365),
  })
  .refine((d) => d.predecessor_id !== d.successor_id, { message: 'Zadanie nie może zależeć od siebie.', path: ['successor_id'] });

export const TimeEntryRow = z
  .object({
    id: Id,
    task_id: Id.nullable(),
    kind: z.enum(['focus', 'break', 'manual']),
    started_at: Instant,
    ended_at: Instant.nullable(),
    pomodoro_index: z.number().int().min(0).nullable(),
  })
  .refine((e) => !e.ended_at || Date.parse(e.ended_at) >= Date.parse(e.started_at), { message: 'Koniec przed początkiem.', path: ['ended_at'] });

/** Limit pliku (M5). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const AttachmentRow = z
  .object({
    id: Id,
    task_id: Id,
    kind: z.enum(['file', 'link']),
    storage_path: z.string().min(1).nullable(),
    name: name(255),
    mime: z.string().max(200).nullable(),
    size_bytes: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES).nullable(),
    url: z.url().nullable(),
    preview: AttachmentPreview.nullable(),
  })
  .refine((a) => (a.kind === 'file' ? a.storage_path !== null : a.url !== null), { message: 'Plik wymaga ścieżki, link — adresu.', path: ['kind'] });

export const SavedFilterRow = z.object({
  id: Id,
  /** Zakres osobisty. */
  scope_id: Id,
  name: name(60),
  icon: Icon.nullable(),
  query: FilterQuery,
  sort_key: SortKey,
});

export const ReviewSessionRow = z.object({
  id: Id,
  /** Zakres osobisty. */
  scope_id: Id,
  kind: z.enum(['daily', 'weekly']),
  started_at: Instant,
  finished_at: Instant.nullable(),
  stats: ReviewStats.nullable(),
});

// ── Wiersze: współpracownicy i komentarze ───────────────────────────────────────────────────

/** Limit komentarza (znaki). */
export const MAX_COMMENT_LENGTH = 10_000;

/** Współpracownik (zakres osobisty): tylko do opisu zadań — nie daje dostępu. */
export const CollaboratorRow = z.object({
  id: Id,
  /** Zakres osobisty. */
  scope_id: Id,
  name: name(100),
  email: z.email('Niepoprawny adres e-mail.').max(254).nullable(),
  /** Skrót przy zadaniu; `null` = inicjały z nazwy. */
  acronym: z.string().trim().min(1, 'Akronim nie może być pusty.').max(5, 'Akronim: najwyżej 5 znaków.').nullable(),
  /** Status: `null` = aktywny; nieaktywny nie podpowiada się przy zadaniach. */
  archived_at: Instant.nullable(),
  /** Przestrzenie, w których osoba się podpowiada; `null` = wszystkie (jak `tags.workspace_ids`). */
  workspace_ids: z.array(Id).max(100).nullable(),
});

export const TaskParticipantRow = z.object({ id: Id, task_id: Id, collaborator_id: Id });

export const TaskCommentRow = z.object({
  id: Id,
  task_id: Id,
  body: z.string().trim().min(1, 'Komentarz nie może być pusty.').max(MAX_COMMENT_LENGTH),
  /** Chwila napisania na urządzeniu (także offline). */
  posted_at: Instant,
  edited_at: Instant.nullable(),
});

/** Schemat wiersza po nazwie tabeli (formularze, walidacja operacji przed `mutate`). */
export const MODEL = {
  workspaces: WorkspaceRow,
  lists: ListRow,
  tasks: TaskRow,
  tags: TagRow,
  task_tags: TaskTagRow,
  task_completions: TaskCompletionRow,
  reminders: ReminderRow,
  task_dependencies: TaskDependencyRow,
  time_entries: TimeEntryRow,
  attachments: AttachmentRow,
  saved_filters: SavedFilterRow,
  review_sessions: ReviewSessionRow,
  profiles: ProfileRow,
  devices: DeviceRow,
  collaborators: CollaboratorRow,
  task_participants: TaskParticipantRow,
  task_comments: TaskCommentRow,
} as const;
export type ModelTable = keyof typeof MODEL;
export type ModelRow<T extends ModelTable> = z.infer<(typeof MODEL)[T]>;
