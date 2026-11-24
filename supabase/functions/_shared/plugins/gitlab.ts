/**
 * Plugin GitLab (SPECYFIKACJA M21, etap I3): zadanie jako issue przez REST API v4 (`PRIVATE-TOKEN`).
 * Logika treści i planu zmian jest w core (`packages/core/src/plugins/gitlab.ts`), tu — wywołania API.
 *
 * Bez powiązania: `POST /projects/:id/issues` (znacznik id wysyłki w opisie; ponowienie najpierw szuka issue
 * z tym znacznikiem — GitLab nie ma `Idempotency-Key`), potem zamknięcie ukończonego / notatka z komentarza.
 * Przypisani: nazwy użytkowników z reguły → `assignee_ids` (`GET /users?username=`, tylko gdy potrzebne).
 * Szacowany czas: `POST …/time_estimate` po zapisie issue; odmowa (np. rola Guest) nie psuje wysyłki — uwaga w historii.
 * Z powiązaniem (`plugin_links`): `PUT /projects/:id/issues/:iid` + `POST …/notes`; issue usunięte w GitLabie
 * (404) → nowe issue. Ochrona SSRF jak w webhooku (tylko `https`, publiczne IP, bez przekierowań).
 * Odpowiedź: 401 / 403 = połączenie wyłączone (zły token, brak uprawnień), 429 / 5xx / sieć / 10 s = ponowienie,
 * inne 4xx = błąd bez ponowień z komunikatem GitLaba.
 */
import {
  gitlabApiUrl,
  gitlabChange,
  gitlabCreate,
  gitlabExternalId,
  gitlabIssueBody,
  gitlabProjectRef,
  parseGitlabExternalId,
  type GitlabChange,
  type GitlabIssueBody,
} from '../../../../packages/core/src/plugins/gitlab.ts';
import { PreviewError } from '../link-preview.ts';
import type { DeliveryResult, PluginRuntime, RuntimeContext } from './types.ts';
import { checkResolved, checkWebhookUrl, responseText, retryAfterSec } from './webhook.ts';

export const GITLAB_TIMEOUT_MS = 10_000;

type Failure = Extract<DeliveryResult, { ok: false }>;
type ApiOk = { ok: true; status: number; data: Record<string, unknown> | Record<string, unknown>[] | null };
type ApiResult = ApiOk | { ok: false; status: number; failure: Failure };

const baseUrl = (ctx: RuntimeContext) => String(ctx.config.baseUrl ?? 'https://gitlab.com');

/** Komunikat GitLaba (`message` / `error`) z treści odpowiedzi. */
function gitlabMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    const message = body.message ?? body.error;
    if (typeof message === 'string') return message;
    if (message && typeof message === 'object') return JSON.stringify(message);
  } catch {
    // nie JSON — surowy początek
  }
  return text;
}

/** Jedno wywołanie API z ochroną SSRF; `404` wraca jako `ok: false` z `status`, żeby wołający zdecydował. */
async function api(ctx: RuntimeContext, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const allow = new Set((ctx.net.allowHosts ?? []).map((h) => h.toLowerCase()));
  try {
    const url = checkWebhookUrl(gitlabApiUrl(baseUrl(ctx), path), ctx.net.allowHosts);
    await checkResolved(url, ctx.net, allow);
    const res = await ctx.net.fetch(url.href, {
      method,
      headers: {
        'private-token': ctx.secrets.token ?? '',
        'user-agent': 'TaskPlannerGitLab/1.0',
        accept: 'application/json',
        ...(body !== undefined && { 'content-type': 'application/json; charset=utf-8' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(ctx.net.timeoutMs ?? GITLAB_TIMEOUT_MS),
    });
    const status = res.status;
    if (status >= 200 && status < 300) {
      const text = await res.text();
      return { ok: true, status, data: text ? (JSON.parse(text) as ApiOk['data']) : null };
    }
    const detail = gitlabMessage(await responseText(res));
    const error = `GitLab odpowiedział ${status}${detail ? `: ${detail}` : ''}`;
    if (status >= 300 && status < 400) return { ok: false, status, failure: { ok: false, retryable: false, error: `${error} (przekierowanie — podaj właściwy adres GitLaba)`, httpStatus: status } };
    if (status === 401) return { ok: false, status, failure: { ok: false, retryable: false, disable: true, error: `${error} — token nieważny albo wygasł`, httpStatus: status } };
    if (status === 403) return { ok: false, status, failure: { ok: false, retryable: false, disable: true, error: `${error} — token nie ma uprawnień (zakres „api”, rola co najmniej Reporter)`, httpStatus: status } };
    if (status === 429 || status >= 500) {
      return { ok: false, status, failure: { ok: false, retryable: true, retryAfterSec: retryAfterSec(res.headers.get('retry-after'), ctx.now()), error, httpStatus: status } };
    }
    return { ok: false, status, failure: { ok: false, retryable: false, error, httpStatus: status } };
  } catch (error) {
    if (error instanceof PreviewError) return { ok: false, status: 0, failure: { ok: false, retryable: false, error: `Adres niedozwolony: ${error.message}` } };
    const name = (error as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, status: 0, failure: { ok: false, retryable: true, error: 'GitLab nie odpowiedział w 10 s' } };
    return { ok: false, status: 0, failure: { ok: false, retryable: true, error: `Błąd sieci: ${(error as Error).message}` } };
  }
}

interface Issue {
  projectId: number;
  iid: number;
  url: string | null;
}

const asIssue = (data: unknown): Issue | null => {
  const d = data as { project_id?: unknown; iid?: unknown; web_url?: unknown } | null;
  return d && typeof d.project_id === 'number' && typeof d.iid === 'number' ? { projectId: d.project_id, iid: d.iid, url: typeof d.web_url === 'string' ? d.web_url : null } : null;
};

const issuePath = (issue: Pick<Issue, 'projectId' | 'iid'>) => `/projects/${issue.projectId}/issues/${issue.iid}`;

/** Zmiany powiązanego issue; `missing` = issue już nie istnieje (usunięte w GitLabie). */
/** Nazwy użytkowników → id (`GET /users?username=`); nieznana nazwa = błąd bez ponowień (do poprawy w regule). */
async function userIds(ctx: RuntimeContext, names: readonly string[]): Promise<number[] | Failure> {
  const ids: number[] = [];
  for (const name of names) {
    const r = await api(ctx, 'GET', `/users?username=${encodeURIComponent(name)}`);
    if (!r.ok) return r.failure;
    const user = (Array.isArray(r.data) ? r.data : []).find((u) => typeof u.username === 'string' && u.username.toLowerCase() === name.toLowerCase());
    if (!user || typeof user.id !== 'number') return { ok: false, retryable: false, error: `Nie ma użytkownika GitLaba „${name}” — popraw pole „Przypisz do” w regule` };
    ids.push(user.id);
  }
  return ids;
}

/** Id przypisanych liczone raz na wysyłkę i tylko wtedy, gdy są potrzebne. */
type Assignees = () => Promise<number[] | Failure>;

/** `assignees` (nazwy) w treści → `assignee_ids`; błąd, gdy nazwa nieznana. */
async function withAssigneeIds<T extends { assignees?: string[] }>(body: T, assignees: Assignees): Promise<Omit<T, 'assignees'> & { assignee_ids?: number[] } | Failure> {
  const { assignees: names, ...rest } = body;
  if (!names?.length) return rest;
  const ids = await assignees();
  return Array.isArray(ids) ? { ...rest, assignee_ids: ids } : ids;
}

const isFailure = (value: unknown): value is Failure => typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;

async function applyChange(ctx: RuntimeContext, issue: Issue, change: GitlabChange, assignees: Assignees, status?: number): Promise<DeliveryResult | 'missing'> {
  let url = issue.url;
  let httpStatus = status;
  let warning: string | undefined;
  if (Object.keys(change.put).length) {
    const put = await withAssigneeIds(change.put, assignees);
    if (isFailure(put)) return put;
    const r = await api(ctx, 'PUT', issuePath(issue), put);
    if (!r.ok) return r.status === 404 ? 'missing' : r.failure;
    url = asIssue(r.data)?.url ?? url;
    httpStatus = r.status;
  }
  if (change.estimate) {
    const r = await api(ctx, 'POST', `${issuePath(issue)}/time_estimate`, { duration: change.estimate });
    if (!r.ok) {
      if (r.status === 404) return 'missing';
      // Issue jest już zapisane: zły token i błędy przejściowe jak zwykle, odmowa samej estymaty — tylko uwaga.
      if (r.status === 401 || r.failure.retryable) return r.failure;
      warning = `Nie ustawiono szacowanego czasu: ${r.failure.error}`;
    } else httpStatus = r.status;
  }
  if (change.note) {
    const r = await api(ctx, 'POST', `${issuePath(issue)}/notes`, { body: change.note });
    if (!r.ok) return r.status === 404 ? 'missing' : r.failure;
    httpStatus = r.status;
  }
  return { ok: true, externalId: gitlabExternalId(issue.projectId, issue.iid), externalUrl: url ?? undefined, httpStatus, ...(warning && { note: warning }) };
}

/** Issue utworzone przez wcześniejszą próbę tej wysyłki (znacznik id w opisie). */
async function findCreated(ctx: RuntimeContext, project: string, deliveryId: string): Promise<Issue | Failure | null> {
  const r = await api(ctx, 'GET', `/projects/${project}/issues?in=description&search=${encodeURIComponent(deliveryId)}&per_page=5`);
  if (!r.ok) return r.status === 404 ? null : r.failure;
  const list = Array.isArray(r.data) ? r.data : [];
  const hit = list.find((i) => typeof i.description === 'string' && i.description.includes(deliveryId));
  return hit ? asIssue(hit) : null;
}

const createBody = (issue: GitlabIssueBody) => ({
  title: issue.title,
  description: issue.description,
  ...(issue.labels && { labels: issue.labels }),
  ...(issue.due_date && { due_date: issue.due_date }),
  ...(issue.assignees.length && { assignees: issue.assignees }),
});

export const gitlab: PluginRuntime = {
  validateConfig(config, net) {
    try {
      checkWebhookUrl(String(config.baseUrl ?? 'https://gitlab.com'), net.allowHosts);
      return null;
    } catch (error) {
      return error instanceof PreviewError ? `Adres GitLaba niedozwolony: ${error.message}` : 'Niepoprawny adres GitLaba';
    }
  },

  async test(ctx) {
    const r = await api(ctx, 'GET', `/projects/${gitlabProjectRef(String(ctx.config.project ?? ''))}`);
    if (!r.ok) return r.status === 404 ? { ok: false, retryable: false, error: 'Nie ma takiego projektu albo token go nie widzi', httpStatus: 404 } : r.failure;
    const project = r.data as { web_url?: unknown; id?: unknown } | null;
    return { ok: true, httpStatus: r.status, externalUrl: typeof project?.web_url === 'string' ? project.web_url : undefined };
  },

  async deliver(ctx, { id, payload, fields, link, retry }) {
    const issue = gitlabIssueBody(fields, payload.task, id);
    let resolved: Promise<number[] | Failure> | null = null;
    const assignees: Assignees = () => (resolved ??= userIds(ctx, issue.assignees));
    const linked = parseGitlabExternalId(link?.externalId);
    if (linked) {
      const result = await applyChange(ctx, { ...linked, url: link?.externalUrl ?? null }, gitlabChange(payload.events, payload.task, issue, payload.comment), assignees);
      if (result !== 'missing') return result;
    }
    const plan = gitlabCreate(payload.events, payload.task, issue, payload.comment);
    if (!plan) return { ok: true, skipped: linked ? 'Issue usunięte w GitLabie — nic do zmiany' : 'Zadanie nie ma jeszcze issue — nic do zmiany' };
    const project = gitlabProjectRef(String(ctx.config.project ?? ''));
    let created: Issue | null = null;
  let status: number | undefined;
    if (retry) {
      const found = await findCreated(ctx, project, id);
      if (found && 'ok' in found) return found;
      created = found;
    }
    if (!created) {
      const body = await withAssigneeIds(createBody(plan.create), assignees);
      if (isFailure(body)) return body;
      const r = await api(ctx, 'POST', `/projects/${project}/issues`, body);
      if (!r.ok) return r.status === 404 ? { ok: false, retryable: false, error: 'Nie ma takiego projektu albo token go nie widzi', httpStatus: 404 } : r.failure;
      created = asIssue(r.data);
      status = r.status;
      if (!created) return { ok: false, retryable: false, error: 'GitLab nie zwrócił utworzonego issue', httpStatus: r.status };
    }
    const after = await applyChange(ctx, created, plan.after, assignees, status);
    return after === 'missing' ? { ok: false, retryable: true, error: 'Utworzone issue zniknęło — ponowię' } : after;
  },
};
