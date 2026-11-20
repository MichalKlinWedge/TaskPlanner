/**
 * Szczegóły zadania (MVP-3, jak panel zadania na webie): tytuł, status, priorytet, lista, termin,
 * godzina, początek, czas, powtarzanie (edytor M7, pomiń / zakończ serię), czas pracy, tagi, przypomnienia,
 * opis Markdown (edycja + podgląd z odhaczaniem pól), podzadania do 4 poziomów, kosz.
 * Każda zmiana to `mutate` jednego pola — synchronizacja scala zmiany z innych urządzeń (§6).
 */
import {
  canAddSubtask,
  datesPatch,
  deleteTaskOps,
  descendants,
  describeRecurrence,
  endSeriesOps,
  formatMinutes,
  isOpen,
  manualEntryOps,
  moveTaskOps,
  PRIORITY,
  REMINDER_PRESETS,
  reminderOffset,
  relativeDay,
  shortDate,
  skipOccurrenceOps,
  TASK_STATUS,
  taskTagId,
  taskTagOps,
  toggleMarkdownCheckbox,
  uuidv7,
  type LocalDate,
  type Recurrence,
  type TaskStatus,
  type ViewTask,
} from '@taskplanner/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { confirm, useTaskActions } from '@/components/actions';
import { AttachmentsField } from '@/components/attachments-field';
import { MarkdownView } from '@/components/markdown-view';
import { pickDate, pickOption, pickTime } from '@/components/pickers';
import { QuickAddField } from '@/components/quick-add-field';
import { RecurrenceEditor } from '@/components/recurrence-editor';
import { pickList, pickPriority } from '@/components/task-menus';
import { TaskRow } from '@/components/task-row';
import { Button, usePalette } from '@/components/ui';
import { listLabel, useView, type AppData } from '@/lib/app-data';
import { spentMinutes, useFocusData } from '@/lib/focus';
import { useLocalQuery } from '@/lib/local-query';
import { rememberRecent } from '@/lib/recent';
import { permissionState, requestNotificationPermission } from '@/lib/reminders';

const STATUSES = Object.keys(TASK_STATUS) as TaskStatus[];
const DURATIONS = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240];

/** Wynik arkusza wyboru → akcja (bez zwracania wartości do `onPress`). */
const then = <T,>(choice: Promise<T>, act: (value: T) => unknown) => void choice.then((value) => void act(value));

function Block({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  const p = usePalette();
  return (
    <View style={[styles.block, { borderColor: p.border }]}>
      <View style={styles.blockHead}>
        <Text style={[styles.blockTitle, { color: p.muted }]}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

/** Pole w siatce: etykieta + wartość, dotknięcie otwiera wybór. */
function Cell({ label, value, onPress, disabled, tone }: { label: string; value: string; onPress: () => void; disabled?: boolean; tone?: string }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.cell, { borderColor: p.border, backgroundColor: pressed ? p.border : p.card, opacity: disabled ? 0.45 : 1 }]}
    >
      <Text style={{ color: p.muted, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: tone ?? p.fg, fontSize: 15 }} numberOfLines={1}>
        {value}
      </Text>
    </Pressable>
  );
}

function Pill({ label, onPress, color }: { label: string; onPress: () => void; color?: string }) {
  const p = usePalette();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.pill, { borderColor: color ?? p.border, opacity: pressed ? 0.6 : 1 }]}>
      <Text style={{ color: color ?? p.fg, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export default function TaskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = usePalette();
  const { data, today } = useView();
  const actions = useTaskActions();
  const { run, toggle } = actions;
  const task = data.tasks.find((t) => t.id === id);
  useEffect(() => rememberRecent(id), [id]);

  if (!task) {
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: p.bg }}>
        <Stack.Screen options={{ title: 'Zadanie' }} />
        <Text style={{ color: p.muted }}>{data.loaded ? 'Tego zadania już nie ma (usunięte albo w zarchiwizowanej liście).' : 'Wczytywanie…'}</Text>
      </View>
    );
  }

  const update = (patch: Record<string, unknown>, toast?: string) => run([{ table: 'tasks', id: task.id, patch }], toast ? { text: toast } : undefined);
  const parent = task.parentId ? data.tasks.find((t) => t.id === task.parentId) : undefined;
  const children = data.tasks.filter((t) => t.parentId === task.id).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  const closed = task.status === 'done' || task.status === 'cancelled';
  const color = PRIORITY[task.priority].color;

  const remove = () => {
    const ops = deleteTaskOps(data.tasks, task.id, new Date());
    void run(ops, { text: `„${task.title}” w koszu`, undo: ops.map((op) => ({ ...op, patch: { deleted_at: null } })) });
    router.back();
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.bg }} behavior="height">
      <Stack.Screen options={{ title: listLabel(data, task.listId) || 'Zadanie' }} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {parent ? (
          <Pressable accessibilityRole="link" onPress={() => router.replace({ pathname: '/task/[id]', params: { id: parent.id } })}>
            <Text style={{ color: p.muted, fontSize: 13 }} numberOfLines={1}>
              ↑ {parent.title}
            </Text>
          </Pressable>
        ) : null}

        <View style={styles.titleRow}>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: closed }}
            accessibilityLabel={closed ? 'Przywróć zadanie' : 'Ukończ zadanie'}
            hitSlop={10}
            onPress={() => void toggle(task)}
            style={[styles.check, { borderColor: color, backgroundColor: closed ? color : 'transparent' }]}
          >
            {closed ? <Text style={styles.tick}>✓</Text> : null}
          </Pressable>
          <TitleField key={`${task.id}:${task.title}`} value={task.title} onSave={(title) => void update({ title })} />
        </View>

        <View style={styles.grid}>
          <Cell
            label="Status"
            value={TASK_STATUS[task.status]}
            onPress={() =>
              then(pickOption<TaskStatus>(
                'Status',
                STATUSES.map((s) => ({ label: TASK_STATUS[s], value: s, selected: s === task.status })),
              ), (s) => s && s !== task.status && update(s === 'done' || s === 'cancelled' ? { status: s, completed_at: new Date().toISOString() } : { status: s, completed_at: null }))
            }
          />
          <Cell label="Priorytet" value={PRIORITY[task.priority].label} tone={color} onPress={() => then(pickPriority('Priorytet', task.priority), (v) => v && v !== task.priority && update({ priority: v }))} />
          <Cell
            label="Lista"
            value={listLabel(data, task.listId)}
            onPress={() =>
              then(pickList(data, 'Przenieś do listy', task.listId), (listId) => listId && listId !== task.listId && run(moveTaskOps(data.tasks, task.id, listId), { text: `Przeniesiono do ${listLabel(data, listId)}` }))
            }
          />
          <Cell
            label="Czas"
            value={task.durationMin ? formatMinutes(task.durationMin) : '—'}
            onPress={() =>
              then(pickOption<number>('Czas trwania', [
                ...DURATIONS.map((m) => ({ label: formatMinutes(m), value: m, selected: m === task.durationMin })),
                { label: 'Bez czasu', value: 0, tone: 'bad' as const },
              ]), (m) => m !== undefined && update({ duration_min: m || null }))
            }
          />
          <Cell
            label="Termin"
            value={task.dueDate ? relativeDay(task.dueDate, today) : 'Bez terminu'}
            tone={task.dueDate && task.dueDate < today && !closed ? p.bad : undefined}
            onPress={() =>
              then(pickDate({ title: 'Termin', value: task.dueDate, today, allowNone: true, firstDayOfWeek: data.settings.firstDayOfWeek }), 
                (d) => d !== undefined && d !== task.dueDate && update(datesPatch(task, { due_date: d })),
              )
            }
          />
          <Cell
            label="Godzina"
            value={task.dueTime ?? '—'}
            disabled={!task.dueDate}
            onPress={() => then(pickTime({ title: 'Godzina', value: task.dueTime, allowNone: true }), (t) => t !== undefined && t !== task.dueTime && update(datesPatch(task, { due_time: t })))}
          />
          <Cell
            label="Początek"
            value={task.startDate ? relativeDay(task.startDate, today) : '—'}
            disabled={!task.dueDate}
            onPress={() =>
              then(pickDate({ title: 'Początek (zakres do terminu)', value: task.startDate, today, allowNone: true, firstDayOfWeek: data.settings.firstDayOfWeek }), 
                (d) => d !== undefined && d !== task.startDate && update(datesPatch(task, { start_date: d })),
              )
            }
          />
          <View style={[styles.cell, { borderColor: 'transparent', justifyContent: 'center' }]}>
            <Text style={{ color: p.muted, fontSize: 12 }}>{task.dueDate ? relativeDay(task.dueDate, today, 'distance') : 'Bez terminu'}</Text>
          </View>
        </View>

        <RecurrenceField key={`rec:${task.id}`} task={task} data={data} today={today} timeZone={data.settings.timeZone} onSave={(patch) => void update(patch)} />
        <TimeField task={task} />
        <TagsField task={task} data={data} />
        <RemindersField task={task} today={today} />

        <Block title="Opis">
          <DescriptionField taskId={task.id} />
        </Block>

        <AttachmentsField taskId={task.id} />

        <Block title={`Podzadania${children.length ? ` · ${children.filter((c) => c.status === 'done').length}/${children.filter((c) => c.status !== 'cancelled').length}` : ''}`}>
          <View style={{ marginHorizontal: -12 }}>
            {children.map((c) => (
              <TaskRow key={c.id} task={c} today={today} />
            ))}
          </View>
          {canAddSubtask(data.tasks, task.id) ? (
            <QuickAddField parent={{ id: task.id, listId: task.listId }} placeholder="Dodaj podzadanie" />
          ) : (
            <Text style={{ color: p.muted, fontSize: 12 }}>Najwyżej 4 poziomy zadań — tu nie można dodać kolejnego.</Text>
          )}
        </Block>

        <View style={styles.footer}>
          <Text style={{ color: p.muted, fontSize: 12, flex: 1 }}>
            Dodano {task.createdAt.startsWith('1970') ? 'teraz (jeszcze nie wysłane)' : shortDate(task.createdAt.slice(0, 10))}
          </Text>
          <Button kind="danger" title="Przenieś do kosza" onPress={remove} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function TitleField({ value, onSave }: { value: string; onSave: (title: string) => void }) {
  const p = usePalette();
  const [draft, setDraft] = useState(value);
  const commit = () => {
    const title = draft.trim();
    if (title && title !== value) onSave(title.slice(0, 500));
    else setDraft(value);
  };
  return (
    <TextInput
      accessibilityLabel="Tytuł"
      value={draft}
      onChangeText={(t) => setDraft(t.replace(/\n/g, ' '))}
      onBlur={commit}
      onSubmitEditing={commit}
      submitBehavior="blurAndSubmit"
      multiline
      maxLength={500}
      style={[styles.title, { color: p.fg }]}
    />
  );
}

function RecurrenceField({ task, data, today, timeZone, onSave }: { task: ViewTask; data: AppData; today: LocalDate; timeZone?: string; onSave: (patch: Record<string, unknown>) => void }) {
  const p = usePalette();
  const { run } = useTaskActions();
  const [editing, setEditing] = useState(false);
  const anchor = task.dueDate ?? today;
  const save = (recurrence: Recurrence) => {
    // Seria liczy się od terminu zadania; termin przechodzi na pierwsze pasujące wystąpienie.
    const due = recurrence.mode === 'schedule' ? recurrence.anchor : anchor;
    onSave({ recurrence, ...datesPatch(task, { due_date: due }) });
    setEditing(false);
  };
  const series = !!task.recurrence && task.kind === 'task' && isOpen(task);
  const skip = () => {
    const result = skipOccurrenceOps(task, { now: new Date(), timeZone, subtasks: descendants(data.tasks, task.id) });
    void run(result.ops, { text: result.nextDue ? `Pominięto — następny termin: ${relativeDay(result.nextDue, today)}` : 'Pominięto ostatnie wystąpienie — seria zakończona', undo: result.undo });
  };
  const end = async () => {
    if (!(await confirm(`Zakończyć serię „${task.title}”?`, 'Kolejne wystąpienia nie powstaną.', 'Zakończ', 'Anuluj'))) return;
    const result = endSeriesOps(task, new Date());
    void run(result.ops, { text: `Zakończono serię „${task.title}”`, undo: result.undo });
  };
  return (
    <Block title="Powtarzanie">
      {editing ? (
        <RecurrenceEditor value={task.recurrence} anchor={anchor} today={today} timeZone={timeZone} onSave={save} onCancel={() => setEditing(false)} />
      ) : (
        <View style={{ gap: 8 }}>
          <View style={styles.pills}>
            <Text style={{ color: task.recurrence ? p.fg : p.muted, fontSize: 15, flexShrink: 1 }}>{task.recurrence ? `↻ ${describeRecurrence(task.recurrence)}` : 'Nie powtarza się'}</Text>
            <Pill label={task.recurrence ? 'Zmień' : 'Ustaw'} onPress={() => setEditing(true)} />
            {task.recurrence ? <Pill label="Usuń" onPress={() => onSave({ recurrence: null })} /> : null}
          </View>
          {series ? (
            <>
              <View style={styles.pills}>
                <Pill label="Pomiń to wystąpienie" onPress={skip} />
                <Pill label="Zakończ serię" color={p.bad} onPress={() => void end()} />
              </View>
              <Text style={{ color: p.muted, fontSize: 12 }}>Zmiana terminu wyżej przesuwa tylko to wystąpienie.</Text>
            </>
          ) : null}
        </View>
      )}
    </Block>
  );
}

/** Czas pracy (Etap 7): spędzono kontra szacunek (`duration_min`), „▶ Skup się”, ręczny wpis. */
function TimeField({ task }: { task: ViewTask }) {
  const p = usePalette();
  const { run } = useTaskActions();
  const focus = useFocusData();
  const spent = spentMinutes(focus.entries, task.id);
  const estimate = task.durationMin;
  const add = () =>
    void pickOption<number>('Dodaj czas pracy (kończy się teraz)', [5, 10, 15, 25, 30, 45, 60, 90, 120].map((m) => ({ label: formatMinutes(m), value: m }))).then((min) => {
      if (!min) return;
      const ops = manualEntryOps(task.id, min, new Date());
      void run(ops, { text: `Dodano ${formatMinutes(min)} pracy`, undo: ops.map((op) => ({ ...op, patch: { deleted_at: new Date().toISOString() } })) });
    });
  const current = focus.state.phase !== 'idle' && focus.state.taskId === task.id;
  return (
    <Block title="Czas pracy" right={<Pill label="+ Dodaj czas" onPress={add} />}>
      <Text style={{ color: p.fg, fontSize: 15 }}>
        Spędzono {formatMinutes(spent)}
        {estimate ? ` / szac. ${formatMinutes(estimate)}` : ''}
      </Text>
      {estimate ? (
        <View style={[styles.bar, { backgroundColor: p.border }]}>
          <View style={{ width: `${Math.min(100, (spent / estimate) * 100)}%`, height: '100%', backgroundColor: spent > estimate ? p.bad : p.accent }} />
        </View>
      ) : null}
      {isOpen(task) && task.kind === 'task' ? (
        <View style={styles.pills}>
          <Pill label={current ? '⏱ Timer trwa — otwórz' : '▶ Skup się'} color={p.accent} onPress={() => router.push({ pathname: '/focus', params: { task: task.id } })} />
        </View>
      ) : null}
    </Block>
  );
}

function TagsField({ task, data }: { task: ViewTask; data: AppData }) {
  const p = usePalette();
  const { run } = useTaskActions();
  const [name, setName] = useState('');
  const byId = new Map(data.tags.map((t) => [t.id, t]));
  const query = name.trim().replace(/^[@#]/, '').toLowerCase();
  const suggestions = data.tags.filter((t) => !task.tagIds.includes(t.id) && (!query || t.name.toLowerCase().includes(query))).slice(0, 8);
  const add = (value: string) => {
    const tag = value.trim().replace(/^[@#]/, '');
    if (!tag) return;
    setName('');
    void run(taskTagOps({ userId: data.userId, tags: data.tags }, task.id, [tag]));
  };
  return (
    <Block title="Tagi">
      <View style={styles.pills}>
        {task.tagIds.map((tagId) => (
          <Pill
            key={tagId}
            label={`@${byId.get(tagId)?.name ?? '…'}  ×`}
            color="#d97706"
            onPress={() => void run([{ table: 'task_tags', id: taskTagId(task.id, tagId), patch: { deleted_at: new Date().toISOString() } }])}
          />
        ))}
        <TextInput
          value={name}
          onChangeText={setName}
          onSubmitEditing={() => add(name)}
          placeholder="+ tag"
          placeholderTextColor={p.muted}
          maxLength={60}
          autoCapitalize="none"
          style={[styles.tagInput, { color: p.fg, borderColor: p.border }]}
        />
      </View>
      {name || suggestions.length ? (
        <View style={styles.pills}>
          {suggestions.map((t) => (
            <Pill key={t.id} label={`@${t.name}`} onPress={() => add(t.name)} />
          ))}
          {query && !data.tags.some((t) => t.name.toLowerCase() === query) ? <Pill label={`+ nowy „${name.trim().replace(/^[@#]/, '')}”`} color={p.accent} onPress={() => add(name)} /> : null}
        </View>
      ) : null}
    </Block>
  );
}

function RemindersField({ task, today }: { task: ViewTask; today: LocalDate }) {
  const p = usePalette();
  const { run } = useTaskActions();
  const rows =
    useLocalQuery(
      ['reminders'],
      (engine) =>
        engine.db.all<{ id: string; kind: string; offset_min: number | null; at_date: string | null; at_time: string | null }>(
          'select id, kind, offset_min, at_date, at_time from reminders where task_id = ? and deleted_at is null order by kind, offset_min, at_date, at_time',
          [task.id],
        ),
      [task.id],
    ) ?? [];
  const add = async (patch: Record<string, unknown>) => {
    await run([{ table: 'reminders', id: uuidv7(), patch: { task_id: task.id, offset_min: null, at_date: null, at_time: null, ...patch } }]);
    // Pierwsze przypomnienie: prośba o powiadomienia (Android 13+); dokładne alarmy — w ustawieniach.
    if (!(await permissionState()).notifications) await requestNotificationPermission();
  };
  const addMenu = async () => {
    const choice = await pickOption<string>('Przypomnienie', [
      ...(task.dueDate ? REMINDER_PRESETS.map((m) => ({ label: reminderOffset(m), value: `rel:${m}` })) : []),
      { label: 'O wybranej porze…', value: 'abs' },
    ]);
    if (!choice) return;
    if (choice.startsWith('rel:')) return add({ kind: 'relative', offset_min: Number(choice.slice(4)) });
    const date = await pickDate({ title: 'Dzień przypomnienia', value: task.dueDate ?? today, today });
    if (!date) return;
    const time = await pickTime({ title: 'Godzina przypomnienia', value: task.dueTime ?? '09:00' });
    if (time) await add({ kind: 'absolute', at_date: date, at_time: time });
  };
  return (
    <Block title="Przypomnienia" right={<Pill label="+ Dodaj" color={p.accent} onPress={() => void addMenu()} />}>
      {rows.map((r) => (
        <View key={r.id} style={styles.reminder}>
          <Text style={{ color: p.fg, fontSize: 15, flex: 1 }}>
            🔔 {r.kind === 'relative' ? reminderOffset(Number(r.offset_min)) : `${relativeDay(r.at_date as LocalDate, today)} ${String(r.at_time).slice(0, 5)}`}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Usuń przypomnienie" hitSlop={10} onPress={() => void run([{ table: 'reminders', id: r.id, patch: { deleted_at: new Date().toISOString() } }])}>
            <Text style={{ color: p.muted, fontSize: 16 }}>✕</Text>
          </Pressable>
        </View>
      ))}
      {!rows.length ? <Text style={{ color: p.muted, fontSize: 13 }}>Brak przypomnień{task.dueDate ? '' : ' — „przed terminem” wymaga terminu'}</Text> : null}
    </Block>
  );
}

type Selection = { start: number; end: number };

/** Opis: podgląd Markdown (dotknięcie „Edytuj”) albo pole tekstowe z paskiem formatowania. */
function DescriptionField({ taskId }: { taskId: string }) {
  const p = usePalette();
  const { run } = useTaskActions();
  const saved = useLocalQuery(['tasks'], async (engine) => ((await engine.db.all<{ d: string | null }>('select description_md as d from tasks where id = ?', [taskId]))[0]?.d ?? ''), [taskId]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 });
  const save = (value: string) => {
    const md = value.trim();
    if (md !== (saved ?? '').trim()) void run([{ table: 'tasks', id: taskId, patch: { description_md: md || null } }]);
  };
  const wrap = (mark: string) => {
    const { start, end } = selection;
    const inner = draft.slice(start, end) || 'tekst';
    setDraft(draft.slice(0, start) + mark + inner + mark + draft.slice(end));
  };
  const linePrefix = (prefix: string) => {
    const at = draft.lastIndexOf('\n', Math.max(0, selection.start - 1)) + 1;
    setDraft(draft.slice(0, at) + prefix + draft.slice(at));
  };

  if (saved === undefined) return null;
  if (!editing) {
    return (
      <View style={{ gap: 8 }}>
        {saved.trim() ? (
          <MarkdownView source={saved} onToggleCheckbox={(line) => save(toggleMarkdownCheckbox(saved, line))} />
        ) : (
          <Text style={{ color: p.muted, fontSize: 14 }}>Brak opisu.</Text>
        )}
        <View style={styles.pills}>
          <Pill
            label={saved.trim() ? 'Edytuj opis' : '+ Dodaj opis'}
            onPress={() => {
              // Zmiana z innego urządzenia nie przerywa pisania: szkic tylko przy wejściu w edycję.
              setDraft(saved);
              setEditing(true);
            }}
          />
        </View>
      </View>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.pills}>
        <Pill label="B" onPress={() => wrap('**')} />
        <Pill label="I" onPress={() => wrap('*')} />
        <Pill label="• lista" onPress={() => linePrefix('- ')} />
        <Pill label="☐ pole" onPress={() => linePrefix('- [ ] ')} />
        <Pill label="# nagłówek" onPress={() => linePrefix('## ')} />
      </View>
      <TextInput
        autoFocus
        multiline
        value={draft}
        onChangeText={setDraft}
        onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
        placeholder="Markdown: **pogrubienie**, *kursywa*, - lista, - [ ] pole, [link](https://…)"
        placeholderTextColor={p.muted}
        textAlignVertical="top"
        style={[styles.input, styles.description, { color: p.fg, borderColor: p.border }]}
      />
      <View style={styles.pills}>
        <Pill
          label="Gotowe"
          color={p.accent}
          onPress={() => {
            save(draft);
            setEditing(false);
          }}
        />
        <Pill
          label="Anuluj"
          onPress={() => {
            setDraft(saved);
            setEditing(false);
          }}
        />
      </View>
      {draft.trim() ? (
        <View style={[styles.previewBox, { borderColor: p.border }]}>
          <Text style={{ color: p.muted, fontSize: 11, marginBottom: 4 }}>PODGLĄD</Text>
          <MarkdownView source={draft} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: 12, gap: 12, paddingBottom: 60 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  check: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  tick: { color: '#fff', fontSize: 14, fontWeight: '700' },
  title: { flex: 1, fontSize: 20, fontWeight: '600', paddingVertical: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { width: '48.5%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, gap: 2 },
  block: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 8 },
  blockHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  blockTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  pill: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 5 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  tagInput: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 3, fontSize: 13, minWidth: 90 },
  description: { minHeight: 140 },
  previewBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 10 },
  reminder: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bar: { height: 6, borderRadius: 3, overflow: 'hidden' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#8884', paddingTop: 12 },
});
