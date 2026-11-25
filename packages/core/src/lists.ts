/**
 * Listy i projekty (M2): zmiana rodzaju. Status i daty mają tylko projekty (`ListRow`), więc lista
 * z projektu je traci, a projekt z listy zaczyna jako aktywny.
 */
import type { ListKind, ProjectStatus } from './schemas/primitives.ts';

export interface ListKindPatch {
  kind: Exclude<ListKind, 'inbox'>;
  project_status?: ProjectStatus | null;
  start_date?: null;
  end_date?: null;
}

/** Pola listy po zmianie rodzaju; bez zmiany — pusty obiekt. */
export function listKindPatch(list: { kind: ListKind; projectStatus: ProjectStatus | null }, kind: Exclude<ListKind, 'inbox'>): ListKindPatch | Record<string, never> {
  if (list.kind === 'inbox') throw new Error('Inbox ma stały rodzaj.');
  if (list.kind === kind) return {};
  return kind === 'list' ? { kind, project_status: null, start_date: null, end_date: null } : { kind, project_status: list.projectStatus ?? 'active' };
}
