/**
 * Szablony projektów (v1.x) na lokalnej bazie telefonu: lista szablonów, zapis projektu jako szablonu
 * i nowy projekt z szablonu — wszystko offline (`mutateMany` → outbox). Logika w core (`templates.ts`),
 * odczyt projektu — `readProjectSource` z `@taskplanner/sync` (ten sam co na webie).
 */
import {
  compareText,
  projectFromTemplateOps,
  projectTemplateContent,
  projectTemplateOf,
  saveTemplateOps,
  templateSummary,
  type ProjectTemplate,
  type QuickAddScope,
  type TemplateAnchor,
} from '@taskplanner/core';
import { readProjectSource, type SqlRow } from '@taskplanner/sync';

import { useLocalQuery } from './local-query';
import { localEngine, mutateMany } from './sync';

/** Szablony użytkownika (bez kosza), alfabetycznie. */
export function useProjectTemplates(): ProjectTemplate[] {
  return (
    useLocalQuery(['project_templates'], async (engine) =>
      (await engine.db.all<SqlRow>('select id, name, sort_key, content from project_templates where deleted_at is null'))
        .map((r) => projectTemplateOf(r as { id: string; name: string; sort_key: string; content: unknown }))
        .sort((a, b) => compareText(a.name, b.name)),
    ) ?? []
  );
}

/** Migawka projektu jako szablon (nazwa istniejącego szablonu = zastąpienie). */
export async function saveProjectAsTemplate(listId: string, name: string, templates: readonly ProjectTemplate[]): Promise<{ replaced: boolean; summary: string }> {
  const engine = await localEngine();
  const content = projectTemplateContent(await readProjectSource(engine.db.all.bind(engine.db), listId, engine.userId));
  const saved = saveTemplateOps(templates, name, content);
  await mutateMany(saved.ops);
  return { replaced: saved.replaced, summary: templateSummary(content) };
}

/** Nowy projekt z szablonu na końcu list przestrzeni; zwraca id listy. */
export async function createProjectFromTemplate(input: {
  template: ProjectTemplate;
  workspaceId: string;
  name: string;
  anchor: TemplateAnchor | null;
  userId: string;
  tags: QuickAddScope['tags'];
  /** Kolor wybrany przy dodawaniu (brak = kolor z szablonu). */
  color?: string | null;
}): Promise<string> {
  if (!input.template.content) throw new Error('Szablon z nowszej wersji aplikacji — zaktualizuj ją.');
  const engine = await localEngine();
  const [last] = await engine.db.all<{ sort_key: string }>(
    "select sort_key from lists where scope_id = ? and kind <> 'inbox' and deleted_at is null order by sort_key desc limit 1",
    [input.workspaceId],
  );
  const { listId, ops } = projectFromTemplateOps(input.template.content, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    name: input.name,
    anchor: input.anchor,
    tags: input.tags,
    lastListSortKey: last?.sort_key,
  });
  await mutateMany(input.color ? ops.map((op) => (op.table === 'lists' ? { ...op, patch: { ...op.patch, color: input.color } } : op)) : ops);
  return listId;
}
