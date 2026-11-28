/**
 * Podgląd zadania (ikona oka w wierszu listy, „Podgląd” w nagłówku ekranu zadania), jak `TaskPreview` na webie:
 * podsumowanie bez formularza, tylko wypełnione dane — z podzadaniami, zależnościami, tagami, osobami,
 * przypomnieniami, załącznikami i komentarzami. Powiązane zadania otwierają się też w podglądzie; do formularza
 * przechodzi się przyciskiem „Edytuj” w nagłówku ekranu.
 */
import {
  assigneeOf,
  commentAuthor,
  commentTime,
  describeHabit,
  describeRecurrence,
  formatMinutes,
  isOpen,
  LIST_KIND,
  plural,
  PRIORITY,
  readableColor,
  relativeDay,
  reminderOffset,
  shortDate,
  sortComments,
  TASK_SECTION_ICON,
  TASK_STATUS,
  taskBoardColumn,
  taskLinks,
  toHabit,
  trashListLabel,
  type LocalDate,
  type TaskLink,
  type TrashedTask,
  type TrashPreview,
  type ViewTask,
} from '@taskplanner/core';
import { router } from 'expo-router';
import { useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { listLabel, type AppData } from '@/lib/app-data';
import { useDependencies } from '@/lib/dependencies';
import { spentMinutes, useFocusData } from '@/lib/focus';
import { useLocalQuery } from '@/lib/local-query';

import { AttachmentsField } from './attachments-field';
import { MarkdownView } from './markdown-view';
import { openTaskPreview } from './task-row';
import { usePalette } from './ui';

/** Kółko stanu w kolorze priorytetu — sam znak, bez odhaczania. */
function StatusMark({ task, size = 16 }: { task: ViewTask; size?: number }) {
  const color = PRIORITY[task.priority]?.color ?? PRIORITY[4].color;
  const done = task.status === 'done';
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={TASK_STATUS[task.status]}
      style={[styles.mark, { width: size, height: size, borderRadius: size / 2, borderColor: color, backgroundColor: done ? color : 'transparent' }]}
    >
      {done ? <Text style={{ color: '#fff', fontSize: size * 0.6, fontWeight: '700' }}>✓</Text> : task.status === 'cancelled' ? <Text style={{ color, fontSize: size * 0.7 }}>–</Text> : null}
    </View>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  const p = usePalette();
  return (
    <View style={styles.fact}>
      <Text style={[styles.factLabel, { color: p.muted }]}>{label}</Text>
      <View style={styles.factValue}>{typeof children === 'string' ? <Text style={{ color: p.fg, fontSize: 15 }}>{children}</Text> : children}</View>
    </View>
  );
}

function Part({ icon, title, count, children }: { icon: string; title: string; count?: ReactNode; children: ReactNode }) {
  const p = usePalette();
  return (
    <View accessibilityLabel={title} style={[styles.part, { borderColor: p.border }]}>
      <Text style={[styles.partTitle, { color: p.fg }]}>
        {TASK_SECTION_ICON[icon] ? `${TASK_SECTION_ICON[icon]}  ` : ''}
        {title}
        {count !== undefined ? <Text style={{ color: p.muted, fontWeight: '400' }}> · {count}</Text> : null}
      </Text>
      {children}
    </View>
  );
}

/** Zadanie na liście podglądu — dotknięcie otwiera jego podgląd. */
function TaskLine({ task, today, note }: { task: ViewTask; today: LocalDate; note?: ReactNode }) {
  const p = usePalette();
  const open = isOpen(task);
  return (
    <Pressable accessibilityRole="link" accessibilityHint="Otwiera podgląd zadania" onPress={() => openTaskPreview(task.id)} style={({ pressed }) => [styles.line, { opacity: pressed ? 0.6 : 1 }]}>
      <View style={{ paddingTop: 2 }}>
        <StatusMark task={task} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ color: open ? p.fg : p.muted, fontSize: 15, textDecorationLine: open ? 'none' : 'line-through' }}>{task.title}</Text>
        {note}
      </View>
      {task.dueDate ? <Text style={{ color: open && task.dueDate < today ? p.bad : p.muted, fontSize: 12, paddingTop: 2 }}>{relativeDay(task.dueDate, today)}</Text> : null}
    </Pressable>
  );
}

/** Drzewo podzadań (do 4 poziomów). */
function Subtasks({ tasks, childrenOf, today }: { tasks: readonly ViewTask[]; childrenOf: (id: string) => readonly ViewTask[]; today: LocalDate }) {
  const p = usePalette();
  return (
    <View>
      {tasks.map((t) => {
        const inner = childrenOf(t.id);
        return (
          <View key={t.id}>
            <TaskLine task={t} today={today} />
            {inner.length ? (
              <View style={[styles.nested, { borderColor: p.border }]}>
                <Subtasks tasks={inner} childrenOf={childrenOf} today={today} />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const bySortKey = (a: ViewTask, b: ViewTask) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
const NONE: readonly ViewTask[] = [];

export function TaskPreview({ task, data, today, trash }: { task: ViewTask; data: AppData; today: LocalDate; trash?: TrashPreview<TrashedTask> | null }) {
  const p = usePalette();
  const timeZone = data.settings.timeZone;
  const description = useLocalQuery(['tasks'], async (engine) => (await engine.db.all<{ d: string | null }>('select description_md as d from tasks where id = ?', [task.id]))[0]?.d ?? '', [task.id]) ?? '';
  const commentRows = useLocalQuery(
    ['task_comments'],
    (engine) =>
      engine.db.all<{ id: string; body: string; posted_at: string; edited_at: string | null; created_by: string | null }>(
        'select id, body, posted_at, edited_at, created_by from task_comments where task_id = ? and deleted_at is null',
        [task.id],
      ),
    [task.id],
  );
  const comments = useMemo(
    () => sortComments((commentRows ?? []).map((r) => ({ id: r.id, taskId: task.id, body: r.body, postedAt: r.posted_at, editedAt: r.edited_at, authorId: r.created_by }))),
    [commentRows, task.id],
  );
  const reminders =
    useLocalQuery(
      ['reminders'],
      (engine) =>
        engine.db.all<{ id: string; kind: string; offset_min: number | null; at_date: string | null; at_time: string | null }>(
          'select id, kind, offset_min, at_date, at_time from reminders where task_id = ? and deleted_at is null and (created_by is null or created_by = ?) order by kind, offset_min, at_date, at_time',
          [task.id, engine.userId],
        ),
      [task.id],
    ) ?? [];
  const deps = useDependencies();
  const links = useMemo(() => taskLinks(task.id, data.tasks, deps), [task.id, data.tasks, deps]);
  const focus = useFocusData();
  const spent = data.settings.focus.enabled ? spentMinutes(focus.entries, task.id) : 0;
  const attachments = data.attachmentCounts.get(task.id) ?? 0;

  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const parent = task.parentId ? byId.get(task.parentId) : undefined;
  // W koszu: tylko podzadania usunięte razem z zadaniem (osobno usunięte są osobnymi pozycjami kosza).
  const childrenOf = (id: string): readonly ViewTask[] => (trash ? NONE : data.tasks.filter((t) => t.parentId === id).sort(bySortKey));
  const children = trash ? trash.children : childrenOf(task.id);
  const counted = children.filter((c) => c.status !== 'cancelled');

  const list = data.lists.find((l) => l.id === task.listId);
  const workspace = data.workspaces.find((w) => w.id === task.workspaceId)?.name;
  const boardColumns = list?.boardColumns ?? [];
  const columnId = taskBoardColumn(task, boardColumns);
  const column = columnId ? boardColumns.find((c) => c.id === columnId)?.name : undefined;
  const assignee = assigneeOf(task.assigneeId, data.collaborators);
  const participants = (data.participants.get(task.id) ?? []).flatMap((id) => data.collaborators.find((c) => c.id === id)?.name ?? []);
  const tags = task.tagIds.flatMap((id) => data.tags.find((t) => t.id === id) ?? []);
  const habit = task.kind === 'habit' ? toHabit(task) : null;
  const overdue = isOpen(task) && task.dueDate !== null && task.dueDate < today;
  const priority = PRIORITY[task.priority] ?? PRIORITY[4];

  const linkLines = (items: readonly TaskLink[]) =>
    items.map((link) => {
      const other = byId.get(link.otherId);
      if (!other) return null;
      const notes = [
        link.violation ? { text: `⚠ ${plural(link.violation.days, ['dzień', 'dni', 'dni'])} za wcześnie`, bad: true } : null,
        link.dependency.lagDays ? { text: `odstęp ${plural(link.dependency.lagDays, ['dzień', 'dni', 'dni'])}`, bad: false } : null,
      ].filter((n) => n !== null);
      return (
        <TaskLine
          key={link.dependency.id}
          task={other}
          today={today}
          note={
            notes.length ? (
              <Text style={{ fontSize: 12, color: p.muted }}>
                {notes.map((n, i) => (
                  <Text key={i} style={n.bad ? { color: p.bad } : null}>
                    {i ? ' · ' : ''}
                    {n.text}
                  </Text>
                ))}
              </Text>
            ) : undefined
          }
        />
      );
    });

  return (
    <View style={styles.body} testID="task-preview">
      {parent ? (
        <Pressable accessibilityRole="link" onPress={() => router.replace({ pathname: '/task/[id]', params: { id: parent.id, mode: 'preview' } })}>
          <Text style={{ color: p.muted, fontSize: 13 }} numberOfLines={1}>
            ↑ {parent.title}
          </Text>
        </Pressable>
      ) : null}
      <View style={styles.titleRow}>
        <View style={{ paddingTop: 4 }}>
          <StatusMark task={task} size={20} />
        </View>
        <Text selectable style={[styles.title, { color: task.status === 'done' ? p.muted : p.fg, textDecorationLine: task.status === 'done' ? 'line-through' : 'none' }]}>
          {task.title}
        </Text>
      </View>

      <View style={[styles.facts, { backgroundColor: p.card, borderColor: p.border }]}>
        <Fact label="Status">
          <Text style={{ color: p.fg, fontSize: 15 }}>
            {TASK_STATUS[task.status]}
            {task.completedAt && !isOpen(task) ? <Text style={{ color: p.muted }}> · {commentTime(task.completedAt, today, timeZone)}</Text> : null}
          </Text>
        </Fact>
        <Fact label="Priorytet">
          <Text style={{ color: priority.color, fontSize: 15 }}>{priority.label}</Text>
        </Fact>
        <Fact label="Lista">
          <Text style={{ color: p.fg, fontSize: 15 }}>
            {trash ? trashListLabel(trash.task, list?.name) : list ? listLabel(data, list.id) : '—'}
            {list ? (
              <Text style={{ color: p.muted }}>
                {[list.kind === 'inbox' ? null : LIST_KIND[list.kind], workspace]
                  .filter(Boolean)
                  .map((text) => ` · ${text}`)
                  .join('')}
              </Text>
            ) : null}
          </Text>
        </Fact>
        {column ? <Fact label="Kolumna tablicy">{column}</Fact> : null}
        {task.startDate ? <Fact label="Początek">{relativeDay(task.startDate, today)}</Fact> : null}
        {task.dueDate ? (
          <Fact label="Termin">
            <Text style={{ fontSize: 15, color: p.fg }}>
              <Text style={overdue ? { color: p.bad, fontWeight: '600' } : null}>
                {shortDate(task.dueDate)}
                {task.dueTime ? `, ${task.dueTime}` : ''}
              </Text>
              <Text style={{ color: p.muted }}> · {relativeDay(task.dueDate, today, 'distance')}</Text>
            </Text>
          </Fact>
        ) : null}
        {task.durationMin ? <Fact label="Czas">{formatMinutes(task.durationMin)}</Fact> : null}
        {spent ? <Fact label="Czas pracy">{formatMinutes(spent)}</Fact> : null}
        {habit ? (
          <Fact label="Nawyk">
            <Text style={{ color: p.fg, fontSize: 15 }}>
              {describeHabit(habit)}
              {trash ? null : (
                <>
                  {' · '}
                  <Text style={{ color: p.accent }} onPress={() => router.push({ pathname: '/habit/[id]', params: { id: task.id } })}>
                    statystyki
                  </Text>
                </>
              )}
            </Text>
          </Fact>
        ) : task.recurrence ? (
          <Fact label="Powtarzanie">{`↻ ${describeRecurrence(task.recurrence)}`}</Fact>
        ) : null}
        {reminders.length ? (
          <Fact label="Przypomnienia">
            {reminders.map((r) => (
              <Text key={r.id} style={{ color: p.fg, fontSize: 15 }}>
                🔔 {r.kind === 'relative' ? reminderOffset(Number(r.offset_min)) : `${relativeDay(r.at_date as LocalDate, today)} ${String(r.at_time).slice(0, 5)}`}
              </Text>
            ))}
          </Fact>
        ) : null}
        {assignee ? <Fact label="Odpowiedzialny">{assignee.name}</Fact> : null}
        {participants.length ? <Fact label="Uczestnicy">{participants.join(', ')}</Fact> : null}
        {tags.length ? (
          <Fact label="Tagi">
            <View style={styles.tags}>
              {tags.map((t) => (
                <Text
                  key={t.id}
                  numberOfLines={1}
                  style={[styles.tag, t.color ? { color: readableColor(t.color, p.card, p.fg), backgroundColor: `${t.color}33` } : { color: p.fg, backgroundColor: p.border }]}
                >
                  {t.name}
                </Text>
              ))}
            </View>
          </Fact>
        ) : null}
      </View>

      {description.trim() ? (
        <Part icon="Opis" title="Opis">
          <MarkdownView source={description} />
        </Part>
      ) : null}

      {children.length ? (
        <Part icon="Podzadania" title="Podzadania" count={`${counted.filter((c) => c.status === 'done').length}/${counted.length}`}>
          <Subtasks tasks={children} childrenOf={childrenOf} today={today} />
        </Part>
      ) : null}

      {links.predecessors.length ? (
        <Part icon="Zależności" title="Czeka na">
          {linkLines(links.predecessors)}
        </Part>
      ) : null}
      {links.successors.length ? (
        <Part icon="Zależności" title="Blokuje">
          {linkLines(links.successors)}
        </Part>
      ) : null}

      {attachments ? (
        <Part icon="attachments" title="Załączniki" count={attachments}>
          <AttachmentsField taskId={task.id} summary />
        </Part>
      ) : null}

      {comments.length ? (
        <Part icon="Komentarze" title="Komentarze" count={comments.length}>
          {comments.map((c) => (
            <View key={c.id} style={styles.comment}>
              <Text style={{ color: p.muted, fontSize: 12 }}>
                <Text style={{ color: p.fg, fontWeight: '600' }}>{commentAuthor(c.authorId, data.userId)}</Text> {commentTime(c.postedAt, today, timeZone)}
                {c.editedAt ? ' (edytowano)' : ''}
              </Text>
              <Text selectable style={{ color: p.fg, fontSize: 15 }}>
                {c.body}
              </Text>
            </View>
          ))}
        </Part>
      ) : null}

      <Text style={[styles.footer, { color: p.muted, borderColor: p.border }]}>Dodano {task.createdAt.startsWith('1970') ? 'teraz (jeszcze nie wysłane)' : shortDate(task.createdAt.slice(0, 10))}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12 },
  mark: { borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  title: { flex: 1, fontSize: 20, lineHeight: 27, fontWeight: '600' },
  facts: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 8 },
  fact: { flexDirection: 'row', gap: 12 },
  factLabel: { width: 108, fontSize: 12, lineHeight: 20 },
  factValue: { flex: 1, minWidth: 0, gap: 2 },
  part: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 6 },
  partTitle: { fontSize: 13, fontWeight: '700' },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 5 },
  nested: { marginLeft: 7, paddingLeft: 14, borderLeftWidth: StyleSheet.hairlineWidth },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { fontSize: 12, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden', maxWidth: 200 },
  comment: { gap: 2, paddingVertical: 4 },
  footer: { fontSize: 12, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10 },
});
