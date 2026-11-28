/**
 * Szybkie dodawanie (M13) na telefonie: pole z parserem z `core/quick-add.ts`, rozpoznane fragmenty
 * jako chipy (dotknięcie cofa rozpoznanie), podgląd tytułu i listy docelowej, wklejenie wielu linii
 * = wiele zadań (z pytaniem). Zapis przez `quickAddTaskOps` (core) — te same reguły co na webie; adres
 * w tytule albo udostępniony link → załącznik-link (`withLinkOps`), tytuł strony uzupełni `link-preview`.
 */
import {
  findUrl,
  linkName,
  localDateTimeAt,
  parseQuickAdd,
  plural,
  quickAddChip,
  quickAddTaskOps,
  suppressToken,
  taskTagOps,
  withLinkOps,
  type LocalDate,
  type QuickAddContext,
  type QuickAddSlot,
  type QuickAddTokenKind,
  type TaskOp,
} from '@taskplanner/core';
import { useMemo, useRef, useState, type ComponentRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { lastSortKey, listLabel, targetInbox, useAppData, useWorkspace } from '@/lib/app-data';

import { choose, useTaskActions } from './actions';
import { usePalette } from './ui';

const KIND_COLOR: Record<QuickAddTokenKind, string> = {
  date: '#2563eb',
  time: '#2563eb',
  duration: '#0891b2',
  priority: '#dc2626',
  target: '#16a34a',
  tag: '#d97706',
  recurrence: '#7c3aed',
  reminder: '#db2777',
};

export interface QuickAddFieldProps {
  /** Lista, gdy wpis nie wskazuje innej; brak = Inbox bieżącej (albo pierwszej) przestrzeni. */
  listId?: string;
  dueDate?: LocalDate | null;
  /** Dotknięte miejsce kalendarza: dzień i godzina, gdy wpis ich nie podaje. */
  slot?: QuickAddSlot | null;
  parent?: { id: string; listId: string };
  placeholder?: string;
  autoFocus?: boolean;
  /** Tekst na start (udostępniony z innej aplikacji). */
  initialText?: string;
  /** Udostępniony link (Chrome → „Udostępnij”): załącznik i `source` pierwszego zadania. */
  link?: string | null;
  /** Po dodaniu; `ids` — nowe zadania. */
  onAdded?: (ids: string[]) => void;
  /** Przycisk „Dodaj” obok pola (okno „+”), bez niego Enter na klawiaturze. */
  submitLabel?: string;
  /** Pola z kolumny tablicy (status, priorytet, własna kolumna), gdy wpis ich nie podaje; tagi dokładane. */
  defaults?: { status?: string; priority?: number; tagNames?: readonly string[]; boardColumnId?: string };
}

export function QuickAddField({ listId, dueDate, slot, parent, placeholder = 'Dodaj zadanie', autoFocus, initialText = '', link, onAdded, submitLabel, defaults }: QuickAddFieldProps) {
  const p = usePalette();
  const data = useAppData();
  const workspaceId = useWorkspace(data);
  const { run, notify } = useTaskActions();
  const [text, setText] = useState(initialText);
  const input = useRef<ComponentRef<typeof TextInput>>(null);

  const names = useMemo(() => new Map(data.workspaces.map((w) => [w.id, w.name])), [data.workspaces]);
  const defaultListId = parent?.listId ?? listId ?? targetInbox(data, workspaceId)?.id;
  const defaultWorkspace = data.lists.find((l) => l.id === defaultListId)?.workspaceId ?? workspaceId;
  const parserContext = useMemo(
    (): Omit<QuickAddContext, 'now'> => ({
      currentWorkspace: defaultWorkspace ? names.get(defaultWorkspace) : undefined,
      workspaces: data.workspaces.map((w) => w.name),
      lists: data.lists.filter((l) => l.kind !== 'inbox').map((l) => ({ workspace: names.get(l.workspaceId) ?? '', name: l.name, kind: l.kind })),
      tags: data.tags.map((t) => t.name),
      ...(slot && { slot }),
    }),
    [data.workspaces, data.lists, data.tags, names, defaultWorkspace, slot],
  );
  const timeZone = data.settings.timeZone;
  const parse = (value: string) => parseQuickAdd(value, { ...parserContext, now: localDateTimeAt(new Date(), timeZone) });
  const result = useMemo(() => parse(text), [text, parserContext, timeZone]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = localDateTimeAt(new Date(), timeZone).slice(0, 10) as LocalDate;

  const scope = (fallback: string) => ({
    userId: data.userId,
    workspaces: data.workspaces,
    lists: data.lists,
    tags: data.tags,
    defaultListId: fallback,
    defaultDueDate: dueDate ?? null,
    parent,
    lastSortKey: (id: string) => lastSortKey(data, id),
  });

  const add = async (lines: string[]) => {
    if (!defaultListId) return notify('Brak listy docelowej — utwórz przestrzeń w „Przestrzenie i listy”.');
    const ops: TaskOp[] = [];
    const added: { taskId: string; listId: string }[] = [];
    const keys = new Map<string, string>();
    for (const line of lines) {
      const parsed = parse(line);
      if (!parsed.title.trim()) continue;
      const base = scope(defaultListId);
      const r = quickAddTaskOps(parsed, line, { ...base, lastSortKey: (id) => keys.get(id) ?? base.lastSortKey(id) });
      keys.set(parent?.id ?? r.listId, r.ops[0]!.patch.sort_key as string);
      if (defaults?.status) Object.assign(r.ops[0]!.patch, { status: defaults.status }, defaults.status === 'done' ? { completed_at: new Date().toISOString() } : {});
      if (defaults?.priority && !parsed.fields.priority) r.ops[0]!.patch.priority = defaults.priority;
      if (defaults?.boardColumnId) r.ops[0]!.patch.board_column_id = defaults.boardColumnId;
      ops.push(...withLinkOps(r, { title: parsed.title, url: added.length === 0 ? link : null, shared: added.length === 0 && !!link }));
      if (defaults?.tagNames?.length) ops.push(...taskTagOps({ userId: data.userId, tags: data.tags }, r.taskId, defaults.tagNames, data.lists.find((l) => l.id === r.listId)?.workspaceId).filter((op) => !ops.some((o) => o.table === op.table && o.id === op.id)));
      added.push(r);
    }
    if (!added.length) return notify('Zadanie musi mieć tytuł.');
    const at = new Date().toISOString();
    await run(ops, {
      text: added.length === 1 ? `Dodano do ${listLabel(data, added[0]!.listId)}` : `Dodano ${plural(added.length, ['zadanie', 'zadania', 'zadań'])}`,
      undo: added.map((a) => ({ table: 'tasks' as const, id: a.taskId, patch: { deleted_at: at } })),
    });
    setText('');
    onAdded?.(added.map((a) => a.taskId));
  };

  const submit = async () => {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return;
    if (lines.length === 1) return add(lines);
    const mode = await choose<'one' | 'each'>('Kilka linii', `Dodać ${plural(lines.length, ['zadanie', 'zadania', 'zadań'])} (każda linia osobno) czy jedno?`, [
      { label: 'Jedno', value: 'one' },
      { label: 'Osobno', value: 'each' },
    ]);
    if (mode) await add(mode === 'one' ? [lines.join(' ')] : lines);
  };

  let target: string | null = null;
  if (text.trim() && defaultListId && result.title.trim()) target = quickAddTaskOps(result, text, { ...scope(defaultListId), newId: () => 'podglad' }).listId;
  const canAdd = !!defaultListId && !!text.trim();
  // Adres w tytule albo udostępniony link → załącznik-link pierwszego zadania (jak chip na webie).
  const linkUrl = link ?? findUrl(result.title);

  return (
    <View style={styles.wrap}>
      <View style={styles.inputRow}>
        <TextInput
          ref={input}
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={p.muted}
          autoFocus={autoFocus}
          multiline
          submitBehavior="submit"
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
          maxLength={1000}
          editable={!!defaultListId}
          style={[styles.input, { color: p.fg, borderColor: p.border, backgroundColor: p.card }]}
        />
        {submitLabel ? (
          <Pressable accessibilityRole="button" disabled={!canAdd} onPress={() => void submit()} style={[styles.add, { backgroundColor: p.accent, opacity: canAdd ? 1 : 0.4 }]}>
            <Text style={[styles.addText, { color: p.onAccent }]}>{submitLabel}</Text>
          </Pressable>
        ) : null}
      </View>
      {text.trim() ? (
        <View style={styles.preview}>
          <Text style={{ color: p.muted, fontSize: 13 }}>
            {result.title.trim() ? <Text style={{ color: p.fg, fontWeight: '600' }}>{result.title}</Text> : <Text style={{ fontStyle: 'italic' }}>bez tytułu</Text>}
            {target ? ` → ${listLabel(data, target)}` : ''}
          </Text>
          <View style={styles.chips}>
            {linkUrl ? (
              <View accessibilityLabel={`Link ${linkName(linkUrl)} trafi do załączników zadania`} style={[styles.chip, styles.linkChip, { backgroundColor: p.border }]}>
                <Text style={{ color: p.fg, fontSize: 13, fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>
                  🔗 {linkName(linkUrl)}
                </Text>
                <Text style={{ color: p.muted, fontSize: 13 }}> — trafi do załączników</Text>
              </View>
            ) : null}
            {result.tokens.map((token) => {
              const label = quickAddChip(token, result, today);
              return (
                <Pressable
                  hitSlop={8}
                  key={token.start}
                  accessibilityRole="button"
                  accessibilityLabel={`${label} — cofnij rozpoznanie`}
                  onPress={() => {
                    setText(suppressToken(text, token));
                    input.current?.focus();
                  }}
                  style={[styles.chip, { backgroundColor: `${KIND_COLOR[token.kind]}22` }]}
                >
                  <Text style={{ color: KIND_COLOR[token.kind], fontSize: 13, fontWeight: '600' }}>{label} ×</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, maxHeight: 140 },
  add: { borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12 },
  addText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  preview: { gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4, minHeight: 32, justifyContent: 'center' },
  linkChip: { flexDirection: 'row', maxWidth: '100%' },
});
