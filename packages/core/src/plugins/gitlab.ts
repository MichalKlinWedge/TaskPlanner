/**
 * Plugin GitLab (SPECYFIKACJA M21, etap I3) — czysta logika: treść issue z pól akcji reguły, plan zmian
 * powiązanego issue dla zdarzeń zadania, id obiektu zewnętrznego. Wywołania API robi Edge Function
 * (`supabase/functions/_shared/plugins/gitlab.ts`); podgląd reguły w aplikacji pokazuje tę samą treść.
 *
 * Zadanie ↔ issue: pierwsza wysyłka zadania przez połączenie tworzy issue (z ukrytym znacznikiem id wysyłki
 * w opisie — ponowienie po zerwanym połączeniu znajduje już utworzone issue zamiast robić drugie), kolejne
 * zmieniają to samo issue: ukończenie / kosz → zamknięcie, przywrócenie → otwarcie, termin → `due_date`,
 * tagi → etykiety, odpowiedzialny → przypisani (`assignees`), komentarz → notatka, ponowne „Wyślij do…” →
 * tytuł, opis, etykiety, przypisani, termin i stan.
 */
import type { PluginEvent } from './events.ts';
import type { PluginPayload } from './payload.ts';

/** Najdłuższy tytuł issue w GitLabie. */
export const GITLAB_TITLE_MAX = 255;

/** Ukryty znacznik wysyłki w opisie issue (komentarz HTML — nie widać go w GitLabie). */
export const gitlabMarker = (deliveryId: string): string => `<!-- taskplanner:${deliveryId} -->`;

/** `grupa/projekt` albo numer → segment ścieżki API (`/projects/:id`). */
export const gitlabProjectRef = (project: string): string => encodeURIComponent(project.trim().replace(/^\/+|\/+$/g, ''));

/** Adres API (`<baseUrl>/api/v4/…`) — `baseUrl` może mieć ścieżkę (GitLab pod podkatalogiem). */
export const gitlabApiUrl = (baseUrl: string, path: string): string => `${baseUrl.replace(/\/+$/, '')}/api/v4${path}`;

/** Etykiety z pola „po przecinku”: bez pustych i powtórzeń. */
export const gitlabLabels = (text: string): string =>
  [...new Set(text.split(',').map((label) => label.trim()).filter(Boolean))].join(',');

/** Nazwy użytkowników GitLaba z pola „po przecinku” (`@` z przodu dozwolone): bez pustych i powtórzeń. */
export const gitlabUsernames = (text: string): string[] =>
  [...new Set(text.split(/[,\s]+/).map((name) => name.trim().replace(/^@/, '')).filter(Boolean))];

/** Termin issue z pola akcji (już wypełnionego): data `RRRR-MM-DD` albo `null` (puste / coś innego). */
export const gitlabDueDate = (text: string | undefined): string | null => {
  const value = (text ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null;
};

export interface GitlabIssueBody {
  title: string;
  description: string;
  labels: string;
  due_date: string | null;
  /** Nazwy użytkowników do przypisania — Edge Function zamienia je na `assignee_ids` (puste = bez zmian). */
  assignees: string[];
}

type PayloadTask = PluginPayload['task'];

/** Treść nowego issue z pól akcji (już wypełnionych) — pusty tytuł = tytuł zadania. */
export function gitlabIssueBody(fields: Readonly<Record<string, string>>, task: PayloadTask, deliveryId: string): GitlabIssueBody {
  const title = (fields.title ?? '').replace(/\s+/g, ' ').trim() || task.title;
  const description = (fields.description ?? '').trim();
  return {
    title: title.length > GITLAB_TITLE_MAX ? `${title.slice(0, GITLAB_TITLE_MAX - 1)}…` : title,
    description: `${description}${description ? '\n\n' : ''}${gitlabMarker(deliveryId)}`,
    labels: gitlabLabels(fields.labels ?? ''),
    due_date: gitlabDueDate(fields.dueDate),
    assignees: gitlabUsernames(fields.assignees ?? ''),
  };
}

/** Zmiany powiązanego issue: pola `PUT /issues/:iid` (puste = bez zmian) i notatka. */
export interface GitlabChange {
  put: Partial<Pick<GitlabIssueBody, 'title' | 'description' | 'labels' | 'due_date' | 'assignees'>> & { state_event?: 'close' | 'reopen' };
  note?: string;
}

const closed = (status: PayloadTask['status']) => status === 'done' || status === 'cancelled';

/** Notatka z komentarza zadania. */
export const gitlabNote = (comment: { body: string }, task: PayloadTask): string => `${comment.body}\n\n— komentarz w [Task Plannerze](${task.url})`;

/**
 * Plan zmian powiązanego issue dla zdarzeń wysyłki (już połączonych z okna). Stan issue idzie za stanem
 * zadania tylko przy zdarzeniach, które go dotyczą — zamknięte ręcznie w GitLabie zostaje zamknięte.
 */
export function gitlabChange(events: readonly PluginEvent[], task: PayloadTask, issue: GitlabIssueBody, comment?: { body: string }): GitlabChange {
  const has = (e: PluginEvent) => events.includes(e);
  const put: GitlabChange['put'] = {};
  if (has('task.sent')) {
    Object.assign(put, { title: issue.title, description: issue.description, due_date: issue.due_date }, issue.labels && { labels: issue.labels }, issue.assignees.length && { assignees: issue.assignees });
    put.state_event = closed(task.status) ? 'close' : 'reopen';
  }
  if (has('task.deleted') || has('task.completed')) put.state_event = 'close';
  else if (has('task.reopened') || has('task.restored')) put.state_event = 'reopen';
  if (has('task.due_changed')) put.due_date = issue.due_date;
  // Puste etykiety nie czyszczą issue (etykiety dodane w GitLabie zostają).
  if ((has('task.tagged') || has('task.untagged')) && issue.labels) put.labels = issue.labels;
  // Tak samo osoby: puste pole nie zdejmuje przypisania zrobionego w GitLabie.
  if (has('task.assigned') && issue.assignees.length) put.assignees = issue.assignees;
  return { put, ...(has('task.commented') && comment && { note: gitlabNote(comment, task) }) };
}

/** Zdarzenia, po których nie ma sensu zakładać issue, gdy jeszcze go nie ma (tylko zmiana stanu / etykiet). */
const CHANGE_ONLY: ReadonlySet<PluginEvent> = new Set(['task.deleted', 'task.reopened', 'task.restored', 'task.untagged']);

/**
 * Brak powiązanego issue: treść nowego i zmiany zaraz po utworzeniu (zamknięcie ukończonego, notatka z komentarza)
 * albo `null` — same zdarzenia „zmiany” (kosz, przywrócenie, zdjęty tag) nie zakładają issue.
 */
export function gitlabCreate(
  events: readonly PluginEvent[],
  task: PayloadTask,
  issue: GitlabIssueBody,
  comment?: { body: string },
): { create: GitlabIssueBody; after: GitlabChange } | null {
  if (events.every((e) => CHANGE_ONLY.has(e))) return null;
  return {
    create: issue,
    after: { put: closed(task.status) ? { state_event: 'close' } : {}, ...(events.includes('task.commented') && comment && { note: gitlabNote(comment, task) }) },
  };
}

/** Id issue w `plugin_links` / historii: `<id projektu>:<iid>`. */
export const gitlabExternalId = (projectId: number, iid: number): string => `${projectId}:${iid}`;

export function parseGitlabExternalId(id: string | null | undefined): { projectId: number; iid: number } | null {
  const m = /^(\d+):(\d+)$/.exec(id ?? '');
  return m ? { projectId: Number(m[1]), iid: Number(m[2]) } : null;
}
