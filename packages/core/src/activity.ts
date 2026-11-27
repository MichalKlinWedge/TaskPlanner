/**
 * Historia zmian zadania (M3): wiersze `activity_log` → czytelne wpisy. Serwer zapisuje zmienione pola zadania,
 * dodane / usunięte tagi (`tag_added`, `tag_removed`) i wysyłki integracji (`delivery`); `source` = zmiana
 * z integracji (reguła po udanej wysyłce, Kalendarz Google). Nazwa reguły jest znana tylko jej właścicielowi
 * (`names.rules` = reguły z lokalnej bazy) — inni widzą samą usługę.
 */
import { shortDate } from './format.ts';
import { PRIORITY, TASK_FIELD, TASK_STATUS } from './labels.ts';
import { pluginDef } from './plugins/catalog.ts';
import type { LocalDate } from './schemas/primitives.ts';

export interface ActivityRow {
  id: number;
  at: string;
  changes: Record<string, unknown>;
  source: unknown;
}

/** Nazwy do podstawienia za id. */
export interface ActivityNames {
  lists: ReadonlyMap<string, string>;
  people: ReadonlyMap<string, string>;
  /** Własne reguły integracji (także usunięte, jeśli są lokalnie). */
  rules: ReadonlyMap<string, string>;
}

export interface ActivityEntry {
  /** Id najnowszego wiersza wpisu. */
  id: number;
  at: string;
  created: boolean;
  /** Skąd zmiana, jeśli nie od użytkownika. */
  by: string | null;
  lines: string[];
}

const object = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Wpis z utworzenia zadania ma wszystkie kolumny. */
const isCreation = (changes: Record<string, unknown>) => 'kind' in changes && 'list_id' in changes && 'title' in changes;

const ruleName = (id: unknown, names: ActivityNames): string | undefined => (typeof id === 'string' ? names.rules.get(id) : undefined);

function sourceText(source: unknown, names: ActivityNames): string | null {
  const { kind, ruleId } = object(source);
  if (kind === 'plugin') {
    const name = ruleName(ruleId, names);
    return name ? `reguła integracji „${name}”` : 'reguła integracji';
  }
  if (kind === 'calendar') return 'Kalendarz Google';
  if (kind === 'api') return 'aplikacja przez token API';
  return kind ? 'integracja' : null;
}

function deliveryText(value: unknown, names: ActivityNames): string {
  const d = object(value);
  const plugin = typeof d.plugin === 'string' ? (pluginDef(d.plugin)?.name ?? d.plugin) : null;
  const to = plugin ? ` do ${plugin}` : '';
  const name = ruleName(d.ruleId, names);
  const result =
    d.status === 'sent' ? `wysłano${to}` : d.status === 'skipped' ? `wysyłka${to} pominięta` : `wysyłka${to} nie powiodła się`;
  return `${d.trigger === 'manual' ? 'Wyślij do…' : 'Integracja'}: ${result}${name ? ` (reguła „${name}”)` : ''}`;
}

function fieldText(field: string, v: unknown, names: ActivityNames): string {
  if (field === 'deleted_at') return v ? 'w koszu' : 'przywrócone';
  if (field === 'assignee_id') return v ? (names.people.get(String(v)) ?? 'usunięty współpracownik') : 'twórca zadania';
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'status') return TASK_STATUS[v as keyof typeof TASK_STATUS] ?? String(v);
  if (field === 'priority') return PRIORITY[v as keyof typeof PRIORITY]?.label ?? String(v);
  if (field === 'list_id') return names.lists.get(String(v)) ?? 'inna lista';
  if (field === 'due_date' || field === 'start_date') return shortDate(String(v) as LocalDate);
  if (field === 'due_time') return String(v).slice(0, 5);
  if (field === 'completed_at') return new Date(String(v)).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
  if (field === 'recurrence' && typeof v === 'object') return 'zmieniona reguła';
  if (field === 'description_md') return 'zmieniony';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

const tagName = (v: unknown) => String(object(v).name ?? '');

/**
 * Wiersze (od najnowszych) → wpisy w tej samej kolejności. Sąsiednie wiersze jednej transakcji (ta sama chwila
 * i źródło, np. nowe zadanie z tagami) to jeden wpis; tagi są w nim zebrane w jedną linię. Kolejność ręczna
 * i puste pola nowego zadania są pomijane.
 */
export function activityEntries(rows: readonly ActivityRow[], names: ActivityNames): ActivityEntry[] {
  const groups: ActivityRow[][] = [];
  const key = (r: ActivityRow) => `${r.at}|${JSON.stringify(r.source ?? null)}`;
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && key(last[0]!) === key(row)) last.push(row);
    else groups.push([row]);
  }
  return groups.flatMap((group) => {
    const lines: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    let created = false;
    for (const { changes } of [...group].reverse()) {
      const creation = isCreation(changes);
      created ||= creation;
      for (const [field, v] of Object.entries(changes)) {
        if (field === 'sort_key' || field === 'board_sort_key') continue;
        if (creation && (v === null || field === 'kind' || field === 'postpone_count')) continue;
        if (field === 'tag_added') added.push(tagName(v));
        else if (field === 'tag_removed') removed.push(tagName(v));
        else if (field === 'delivery') lines.push(deliveryText(v, names));
        else lines.push(`${TASK_FIELD[field] ?? field}: ${fieldText(field, v, names)}`);
      }
    }
    if (added.length) lines.push(`${added.length > 1 ? 'Dodano tagi' : 'Dodano tag'}: ${added.join(', ')}`);
    if (removed.length) lines.push(`${removed.length > 1 ? 'Usunięto tagi' : 'Usunięto tag'}: ${removed.join(', ')}`);
    if (!lines.length) return [];
    return [{ id: group[0]!.id, at: group[0]!.at, created, by: sourceText(group[0]!.source, names), lines }];
  });
}
