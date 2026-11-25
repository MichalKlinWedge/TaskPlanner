/**
 * Szablony akcji pluginów (SPECYFIKACJA M21): pola `{{title}}`, `{{due}}`… bez żadnej logiki; ucieczka
 * znaków według celu (JSON / Markdown / Slack). Podgląd reguły pokazuje dokładny wynik dla wybranego zadania.
 */
import { PRIORITY, TASK_STATUS, PLUGIN_EVENT } from '../labels.ts';
import type { PluginDef } from './catalog.ts';
import type { PluginEvent } from './events.ts';
import type { PluginTaskData } from './payload.ts';

export const TEMPLATE_FIELDS = [
  { key: 'title', label: 'Tytuł' },
  { key: 'description', label: 'Opis' },
  { key: 'due', label: 'Termin (RRRR-MM-DD)' },
  { key: 'time', label: 'Godzina' },
  { key: 'duration', label: 'Czas (min)' },
  { key: 'priority', label: 'Priorytet' },
  { key: 'status', label: 'Status' },
  { key: 'list', label: 'Lista' },
  { key: 'workspace', label: 'Przestrzeń' },
  { key: 'tags', label: 'Tagi' },
  { key: 'assignee', label: 'Odpowiedzialny' },
  { key: 'url', label: 'Link do zadania' },
  { key: 'event', label: 'Zdarzenie' },
] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number]['key'];
export type TemplateValues = Partial<Record<TemplateField, string>>;

/** Ucieczka wstawianych wartości: `plain` — bez zmian, `json` — wnętrze napisu JSON, `markdown`, `slack` (mrkdwn). */
export type TemplateEscape = 'plain' | 'json' | 'markdown' | 'slack';

const FIELD_KEYS = new Set<string>(TEMPLATE_FIELDS.map((f) => f.key));
const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

const ESCAPE: Record<TemplateEscape, (value: string) => string> = {
  plain: (v) => v,
  json: (v) => JSON.stringify(v).slice(1, -1),
  markdown: (v) => v.replace(/([\\`*_{}[\]()#+\-.!|<>~])/g, '\\$1'),
  slack: (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
};

/** Szablon z wartościami; nieznane pole zostaje dosłownie (widać pomyłkę w podglądzie), brak wartości = pusto. */
export function renderTemplate(template: string, values: TemplateValues, escape: TemplateEscape = 'plain'): string {
  return template.replace(PLACEHOLDER, (all, key: string) => (FIELD_KEYS.has(key) ? ESCAPE[escape](values[key as TemplateField] ?? '') : all));
}

/** Pola szablonu, których nie ma w `TEMPLATE_FIELDS` (podpowiedź w formularzu reguły). */
export const unknownTemplateFields = (template: string): string[] =>
  [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((key) => !FIELD_KEYS.has(key)))];

/** Wartości pól szablonu dla zadania; daty jak w bazie (systemy zewnętrzne czytają ISO), etykiety po polsku. */
export function templateValues(task: PluginTaskData, opts: { event: PluginEvent; url: string }): Record<TemplateField, string> {
  return {
    title: task.title,
    description: task.description ?? '',
    due: task.dueDate ?? '',
    time: task.dueTime ?? '',
    duration: task.durationMin ? String(task.durationMin) : '',
    priority: PRIORITY[task.priority].label,
    status: TASK_STATUS[task.status],
    list: task.list,
    workspace: task.workspace ?? '',
    tags: task.tags.join(', '),
    assignee: task.assignee ?? '',
    url: opts.url,
    event: PLUGIN_EVENT[opts.event],
  };
}

/**
 * Pola akcji reguły dla zadania: szablony wypełnione (puste = `defaultValue` pola), inne pola bez zmian.
 * To samo liczy serwer przy wysyłce i podgląd reguły w aplikacji.
 */
export function renderActionFields(
  def: Pick<PluginDef, 'actionFields' | 'escape'>,
  action: Record<string, unknown>,
  task: PluginTaskData,
  opts: { event: PluginEvent; url: string },
): Record<string, string> {
  const values = templateValues(task, opts);
  const out: Record<string, string> = {};
  for (const field of def.actionFields) {
    const raw = typeof action[field.key] === 'string' && (action[field.key] as string) !== '' ? (action[field.key] as string) : (field.defaultValue ?? '');
    out[field.key] = field.kind === 'template' ? renderTemplate(raw, values, def.escape) : raw;
  }
  return out;
}
