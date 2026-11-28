/**
 * Szczegóły zadania (MVP-3, jak panel zadania na webie): tytuł, status, priorytet, lista, termin,
 * godzina, początek, czas, opis Markdown (edycja + podgląd z odhaczaniem pól), osoby (odpowiedzialny i uczestnicy —
 * tylko informacyjnie), komentarze, zadanie nadrzędne, podzadania do 4 poziomów, zależności (M12), tagi, załączniki,
 * przypomnienia, powtarzanie (edytor M7, pomiń / zakończ serię), czas pracy (tylko przy włączonym trybie skupienia),
 * kosz. Kolejność sekcji jak w panelu zadania na webie.
 * `mode=preview` (ikona oka w wierszu listy) — podgląd bez formularza (`TaskPreview`); przełącznik „Podgląd” / „Edytuj”
 * w nagłówku zmienia tryb w miejscu.
 * Każda zmiana to `mutate` jednego pola — synchronizacja scala zmiany z innych urządzeń (§6).
 */
import {
  canEditScope,
  BOARD_UNASSIGNED,
  taskBoardColumn,
  addCommentOps,
  addDependencyOps,
  addParticipantByNameOps,
  addParticipantOps,
  assigneeChoices,
  assigneeOf,
  assigneeReminderNote,
  assignSelfOps,
  assignTaskOps,
  attachSubtaskOps,
  canAddSubtask,
  canSetOwnReminder,
  subtaskCandidates,
  clampLag,
  collaboratorMatches,
  collaboratorsForWorkspace,
  commentAuthor,
  commentTime,
  creatorLabel,
  datesPatch,
  deleteCommentOps,
  dependencyErrorText,
  deleteTaskOps,
  editCommentOps,
  MAX_COMMENT_LENGTH,
  removeParticipantOps,
  selfCollaborator,
  selfName,
  sortComments,
  descendants,
  describeRecurrence,
  endSeriesOps,
  HABIT_CONVERT,
  formatMinutes,
  isOpen,
  derivedLinks,
  manualEntryOps,
  moveTaskOps,
  normalizeText,
  parentCandidates,
  plural,
  PLUGIN_SEND_NOTE,
  pluginRequestOps,
  PRIORITY,
  REMINDER_PRESETS,
  reminderOffset,
  relativeDay,
  removeDependencyOps,
  reorderTaskTagOps,
  reparentTaskOps,
  readableColor,
  responsibleAccount,
  shortDate,
  seriesToHabitOps,
  seriesToHabitProblem,
  skipOccurrenceOps,
  TASK_STATUS,
  taskLinks,
  tagsForWorkspace,
  taskTagId,
  taskTagOps,
  trashListLabel,
  trashPreview,
  uuidv7,
  VIEWER_REMINDER_NOTE,
  type Dependency,
  type LocalDate,
  type Recurrence,
  type TaskLink,
  type TaskStatus,
  type TrashedTask,
  type TrashPreview,
  type ViewTask,
} from '@taskplanner/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { confirm, useTaskActions } from '@/components/actions';
import { BreakdownField } from '@/components/ai-breakdown';
import { AttachmentsField } from '@/components/attachments-field';
import { ColorPicker } from '@/components/color-picker';
import { DescriptionField } from '@/components/description-field';
import { LockedSections, PanelSection, useSectionsLocked } from '@/components/panel-section';
import { PurgeButton } from '@/components/purge-button';
import { pickAmount, pickDate, pickOption, pickTime } from '@/components/pickers';
import { QuickAddField } from '@/components/quick-add-field';
import { RecurrenceEditor } from '@/components/recurrence-editor';
import { pickList, pickPriority } from '@/components/task-menus';
import { TaskPreview } from '@/components/task-preview';
import { EyeButton, EyeIcon, TaskRow } from '@/components/task-row';
import { Button, usePalette } from '@/components/ui';
import { listEditable, listLabel, useView, type AppData } from '@/lib/app-data';
import { spentMinutes, useFocusData } from '@/lib/focus';
import { sessionUser } from '@/lib/config';
import { useDependencies } from '@/lib/dependencies';
import { useLocalQuery } from '@/lib/local-query';
import { useSendableRules } from '@/lib/plugins';
import { rememberRecent } from '@/lib/recent';
import { permissionState, requestNotificationPermission } from '@/lib/reminders';
import { useTrash } from '@/lib/trash';

const STATUSES = Object.keys(TASK_STATUS) as TaskStatus[];
const DURATIONS = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240];
/** Odstęp zależności w dniach (koniec poprzednika → początek następnika); inne — „Inna…”. */
const LAGS = [-2, -1, 0, 1, 2, 3, 5, 7, 10, 14, 21, 30];

/** Wynik arkusza wyboru → akcja (bez zwracania wartości do `onPress`). */
const then = <T,>(choice: Promise<T>, act: (value: T) => unknown) => void choice.then((value) => void act(value));

/**
 * Część ekranu, którą da się zmieniać. W przestrzeni udostępnionej do podglądu i w koszu treść sekcji jest
 * wyszarzona i bez dotyku (`LockedSections`); wiersz tytułu blokuje się osobno.
 */
function Editable({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  return <LockedSections value={readOnly}>{children}</LockedSections>;
}

/** Zwijana karta sekcji; klucz = tytuł bez licznika („Podzadania · 2/3” → „Podzadania”), ten sam co na webie. */
function Block({ id, title, children, right, readable }: { id?: string; title: string; children: ReactNode; right?: ReactNode; readable?: boolean }) {
  const [base, ...count] = title.split(' · ');
  return (
    <PanelSection id={id ?? base} title={base} count={count.join(' · ') || undefined} right={right} readable={readable}>
      {children}
    </PanelSection>
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
    <Pressable hitSlop={6} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.pill, { borderColor: color ?? p.border, opacity: pressed ? 0.6 : 1 }]}>
      <Text style={{ color: color ?? p.fg, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export default function TaskScreen() {
  const { id, mode } = useLocalSearchParams<{ id: string; mode?: string }>();
  const preview = mode === 'preview';
  const p = usePalette();
  const { data: live, today } = useView();
  const actions = useTaskActions();
  const { run, toggle } = actions;
  const liveTask = live.tasks.find((t) => t.id === id);
  // Zadanie w koszu: ten sam ekran tylko do odczytu, z przywróceniem.
  const trashed = useTrash(live.loaded && !liveTask);
  const trash = useMemo(() => (liveTask || !trashed ? null : trashPreview(trashed, id, new Set(live.tasks.map((t) => t.id)))), [liveTask, trashed, id, live.tasks]);
  // Zadania z kosza obok żywych: sekcje (zależności, zadanie nadrzędne) czytają je z `data.tasks`.
  const data = useMemo(() => (trash && trashed ? { ...live, tasks: [...live.tasks, ...trashed] } : live), [live, trash, trashed]);
  const task = liveTask ?? trash?.task;
  useEffect(() => rememberRecent(id), [id]);

  if (!task) {
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: p.bg }}>
        <Stack.Screen options={{ title: 'Zadanie' }} />
        <Text style={{ color: p.muted }}>{live.loaded && trashed ? 'Tego zadania już nie ma (usunięte na stałe, nie ma go na tym urządzeniu albo jest w zarchiwizowanej liście).' : 'Wczytywanie…'}</Text>
      </View>
    );
  }

  const update = (patch: Record<string, unknown>, toast?: string) => run([{ table: 'tasks', id: task.id, patch }], toast ? { text: toast } : undefined);
  const parent = task.parentId ? data.tasks.find((t) => t.id === task.parentId) : undefined;
  const children = trash ? trash.children : data.tasks.filter((t) => t.parentId === task.id).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  const closed = task.status === 'done' || task.status === 'cancelled';
  const color = PRIORITY[task.priority].color;
  // Własne kolumny tablicy listy zadania (tryb „Własne”) — tylko zadania najwyższego poziomu.
  const boardDefs = data.lists.find((l) => l.id === task.listId)?.boardColumns ?? [];
  const boardColumn = taskBoardColumn(task, boardDefs);
  const scopeReadOnly = !canEditScope(data.workspaces.find((w) => w.id === task.workspaceId)?.role);
  const listReadOnly = !listEditable(data, task.listId);
  // Zadanie w koszu: wszystko zablokowane, da się je tylko przywrócić.
  const readOnly = listReadOnly || !!trash;

  const remove = () => {
    const ops = deleteTaskOps(data.tasks, task.id, new Date());
    void run(ops, { text: `„${task.title}” w koszu`, undo: ops.map((op) => ({ ...op, patch: { deleted_at: null } })) });
    router.back();
  };

  const title = trash ? 'Zadanie w koszu' : listLabel(data, task.listId) || 'Zadanie';
  const modeLabel = preview ? 'Edytuj' : 'Podgląd';
  const modeSwitch = () => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={preview ? 'Przejdź do edycji zadania' : 'Pokaż podgląd zadania'}
      hitSlop={8}
      onPress={() => router.setParams({ mode: preview ? 'edit' : 'preview' })}
      style={({ pressed }) => [styles.modeSwitch, { borderColor: p.border, backgroundColor: pressed ? p.border : 'transparent' }]}
      testID="task-mode-switch"
    >
      {preview ? <Text style={{ color: p.accent, fontSize: 14, fontWeight: '600' }}>✎</Text> : <EyeIcon color={p.accent} size={16} />}
      <Text style={{ color: p.accent, fontSize: 14, fontWeight: '600' }}>{modeLabel}</Text>
    </Pressable>
  );

  if (preview) {
    return (
      <View style={{ flex: 1, backgroundColor: p.bg }}>
        <Stack.Screen options={{ title, headerRight: modeSwitch }} />
        <ScrollView contentContainerStyle={styles.body}>
          {trash ? <TrashBar preview={trash} readOnly={listReadOnly} today={today} timeZone={data.settings.timeZone} /> : null}
          <TaskPreview task={task} data={data} today={today} trash={trash} />
        </ScrollView>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.bg }} behavior="height">
      <Stack.Screen options={{ title, headerRight: modeSwitch }} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {parent ? (
          <Pressable accessibilityRole="link" onPress={() => router.replace({ pathname: '/task/[id]', params: { id: parent.id } })}>
            <Text style={{ color: p.muted, fontSize: 13 }} numberOfLines={1}>
              ↑ {parent.title}
            </Text>
          </Pressable>
        ) : null}

        {trash ? (
          <TrashBar preview={trash} readOnly={listReadOnly} today={today} timeZone={data.settings.timeZone} />
        ) : readOnly ? (
          <Text style={[styles.readOnly, { color: p.muted, backgroundColor: p.selected }]}>
            {scopeReadOnly
              ? `Przestrzeń „${data.workspaces.find((w) => w.id === task.workspaceId)?.name ?? ''}” jest udostępniona Ci tylko do podglądu — zadania nie da się zmienić.`
              : `Lista „${data.lists.find((l) => l.id === task.listId)?.name ?? ''}” jest udostępniona Ci tylko do podglądu — zadania nie da się zmienić.`}
          </Text>
        ) : null}

        <Editable readOnly={readOnly}>
          <View style={[styles.titleRow, readOnly && { opacity: 0.7 }]} pointerEvents={readOnly ? 'none' : 'auto'}>
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

          <Block id="details" title="Szczegóły">
          <View style={styles.grid}>
            <Cell
              label="Status"
              value={TASK_STATUS[task.status]}
              onPress={() =>
                then(pickOption<TaskStatus>(
                  'Status',
                  STATUSES.map((s) => ({ label: TASK_STATUS[s], value: s, selected: s === task.status })),
                ), (s) =>
                  s && s !== task.status &&
                  // „Gotowe” w otwartej serii = ukończenie wystąpienia (jak kółko), nie zamknięcie całej serii.
                  (s === 'done' && task.kind === 'task' && task.recurrence && isOpen(task)
                    ? toggle(task)
                    : update(s === 'done' || s === 'cancelled' ? { status: s, completed_at: new Date().toISOString() } : { status: s, completed_at: null })))
              }
            />
            <Cell label="Priorytet" value={PRIORITY[task.priority].label} tone={color} onPress={() => then(pickPriority('Priorytet', task.priority), (v) => v && v !== task.priority && update({ priority: v }))} />
            <Cell
              label="Lista"
              value={trash ? trashListLabel(trash.task, listLabel(data, task.listId)) : listLabel(data, task.listId)}
              onPress={() =>
                then(pickList(data, 'Przenieś do listy', task.listId), (listId) => listId && listId !== task.listId && run(moveTaskOps(data.tasks, task.id, listId), { text: `Przeniesiono do ${listLabel(data, listId)}` }))
              }
            />
            <Cell
              label="Czas"
              value={task.durationMin ? formatMinutes(task.durationMin) : '—'}
              onPress={() =>
                then(pickAmount('Czas trwania', [
                  { label: 'Bez czasu', value: 0, tone: 'bad' },
                  ...[...new Set([...DURATIONS, ...(task.durationMin ? [task.durationMin] : [])])].sort((a, b) => a - b).map((m) => ({ label: formatMinutes(m), value: m, selected: m === task.durationMin })),
                ], { value: task.durationMin, min: 1, max: 10_080, unit: 'min' }), (m) => m !== undefined && update({ duration_min: m || null }))
              }
            />
            <Cell
              label="Termin"
              value={task.dueDate ? relativeDay(task.dueDate, today) : 'Bez terminu'}
              tone={task.dueDate && task.dueDate < today && !closed ? p.bad : undefined}
              onPress={() =>
                then(pickDate({ title: 'Termin', value: task.dueDate, today, allowNone: true }), 
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
                then(pickDate({ title: 'Początek (zakres do terminu)', value: task.startDate, today, allowNone: true }), 
                  (d) => d !== undefined && d !== task.startDate && update(datesPatch(task, { start_date: d })),
                )
              }
            />
            <View style={[styles.cell, { borderColor: 'transparent', justifyContent: 'center' }]}>
              <Text style={{ color: p.muted, fontSize: 12 }}>{task.dueDate ? relativeDay(task.dueDate, today, 'distance') : 'Bez terminu'}</Text>
            </View>
            {boardDefs.length && task.kind === 'task' && !task.parentId ? (
              <Cell
                label="Kolumna tablicy"
                value={boardDefs.find((d) => d.id === boardColumn)?.name ?? BOARD_UNASSIGNED}
                onPress={() =>
                  then(pickOption<string>('Kolumna tablicy', [
                    { label: BOARD_UNASSIGNED, value: '', selected: !boardColumn },
                    ...boardDefs.map((d) => ({ label: d.name, value: d.id, selected: d.id === boardColumn })),
                  ]), (v) => v !== undefined && (v || null) !== boardColumn && update({ board_column_id: v || null }))
                }
              />
            ) : null}
          </View>
          </Block>

          {/* Nawyk otwarty jak zwykłe zadanie (np. z Szukaj) — przejście do jego ekranu, jak sekcja „Nawyk” na webie. */}
          {task.kind === 'habit' && !trash ? (
            <Block id="Nawyk" title="Nawyk" readable>
              <Button kind="secondary" title="Statystyki, harmonogram i cel →" onPress={() => router.push({ pathname: '/habit/[id]', params: { id: task.id } })} />
            </Block>
          ) : null}

          <Block title="Opis" readable>
            <DescriptionField key={task.id} taskId={task.id} readOnly={readOnly} />
          </Block>

          <PeopleField key={`people:${task.id}`} task={task} data={data} />
          <CommentsField key={`com:${task.id}`} task={task} data={data} today={today} />
          {task.kind === 'task' ? <ParentField key={`parent:${task.id}`} task={task} data={data} parent={parent} /> : null}
        </Editable>

        <Block title={`Podzadania${children.length ? ` · ${children.filter((c) => c.status === 'done').length}/${children.filter((c) => c.status !== 'cancelled').length}` : ''}`}>
          <View style={{ marginHorizontal: -12 }}>
            {children.map((c) => (trash ? <TrashedRow key={c.id} task={c} today={today} /> : <TaskRow key={c.id} task={c} today={today} />))}
          </View>
          {readOnly ? null : canAddSubtask(data.tasks, task.id) ? (
            <>
              <QuickAddField parent={{ id: task.id, listId: task.listId }} placeholder="Dodaj podzadanie" />
              <AttachSubtask key={`sub:${task.id}`} task={task} data={data} />
              <BreakdownField key={`ai:${task.id}`} task={task} data={data} today={today} />
            </>
          ) : (
            <Text style={{ color: p.muted, fontSize: 12 }}>Najwyżej 4 poziomy zadań — tu nie można dodać kolejnego.</Text>
          )}
        </Block>

        <Editable readOnly={readOnly}>
          <DependenciesField key={`dep:${task.id}`} task={task} data={data} />
          <TagsField task={task} data={data} />
        </Editable>

        <AttachmentsField taskId={task.id} readOnly={readOnly} />

        <RemindersField task={task} data={data} today={today} trashed={!!trash} />

        <Editable readOnly={readOnly}>
          <RecurrenceField key={`rec:${task.id}`} task={task} data={data} today={today} timeZone={data.settings.timeZone} onSave={(patch) => void update(patch)} />
          {data.settings.focus.enabled ? <TimeField task={task} /> : null}
        </Editable>

        <View style={styles.footer}>
          <Text style={{ color: p.muted, fontSize: 12, flex: 1 }}>
            Dodano {task.createdAt.startsWith('1970') ? 'teraz (jeszcze nie wysłane)' : shortDate(task.createdAt.slice(0, 10))}
          </Text>
          {trash ? null : (
            <>
              <SendToButton task={task} userId={data.userId} />
              <Button kind="danger" title="Przenieś do kosza" disabled={readOnly} onPress={remove} />
            </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Pasek zadania w koszu: od kiedy, z czym usunięte i „Przywróć”. */
function TrashBar({ preview, readOnly, today, timeZone }: { preview: TrashPreview<TrashedTask>; readOnly: boolean; today: LocalDate; timeZone?: string }) {
  const p = usePalette();
  const { run } = useTaskActions();
  const { task, root, parent, inside, restore, restoreAlone } = preview;
  return (
    <View style={[styles.trash, { backgroundColor: p.selected }]}>
      <Text style={{ color: p.muted, fontSize: 13 }}>
        🗑️ W koszu od {commentTime(task.deletedAt, today, timeZone)}
        {parent ? ` (usunięte razem z „${root.title}”)` : ''} — tylko podgląd. Żeby coś zmienić, przywróć zadanie.
      </Text>
      <Button title={parent ? `Przywróć całość („${root.title}”)` : 'Przywróć'} disabled={readOnly} onPress={() => void run(restore, { text: `Przywrócono „${root.title}”` })} />
      {restoreAlone ? (
        <Button kind="secondary" title="Przywróć tylko to" disabled={readOnly} onPress={() => void run(restoreAlone, { text: `Przywrócono „${task.title}” jako zadanie główne` })} />
      ) : null}
      <PurgeButton task={task} inside={inside} onPurged={() => (router.canGoBack() ? router.back() : router.replace('/trash'))} />
      {readOnly ? <Text style={{ color: p.muted, fontSize: 12 }}>Lista jest udostępniona Ci tylko do podglądu — zadania nie da się przywrócić ani usunąć.</Text> : null}
    </View>
  );
}

/** Podzadanie w koszu: bez odhaczania i gestów `TaskRow`, dotknięcie otwiera jego podgląd. */
function TrashedRow({ task, today }: { task: ViewTask; today: LocalDate }) {
  const p = usePalette();
  const closed = !isOpen(task);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={task.title}
      accessibilityHint="Otwiera szczegóły; tylko podgląd"
      onPress={() => router.push({ pathname: '/task/[id]', params: { id: task.id } })}
      style={({ pressed }) => [styles.trashedRow, { borderColor: p.border, backgroundColor: pressed ? p.border : undefined }]}
    >
      <View style={styles.trashedTitle}>
        <Text style={{ flex: 1, color: closed ? p.muted : p.fg, fontSize: 15, textDecorationLine: closed ? 'line-through' : 'none' }}>
          {closed ? '✓ ' : ''}
          {task.title}
        </Text>
        <EyeButton taskId={task.id} title={task.title} />
      </View>
      {task.dueDate ? <Text style={{ color: p.muted, fontSize: 12 }}>{relativeDay(task.dueDate, today)}</Text> : null}
    </Pressable>
  );
}

/** „Wyślij do…” (M21): reguły ręczne z Ustawień webu; prośba zapisuje się lokalnie (offline też) i wychodzi z serwera po synchronizacji. */
function SendToButton({ task, userId }: { task: ViewTask; userId: string }) {
  const { run } = useTaskActions();
  const rules = useSendableRules();
  if (!rules.length) return null;
  return (
    <Button
      title="Wyślij do…"
      onPress={() =>
        then(pickOption<string>(`Wyślij do… — ${PLUGIN_SEND_NOTE}`, rules.map((r) => ({ label: r.name, value: r.id }))), (ruleId) => {
          const rule = rules.find((r) => r.id === ruleId);
          if (rule) void run(pluginRequestOps(userId, rule.id, [task.id]), { text: `Wysyłka do „${rule.name}” czeka na serwer` });
        })
      }
    />
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
  // Zwykła seria → cykliczne z passą (ekran nawyku); przy odmowie — powód.
  const toHabit = () => {
    const subtasks = descendants(data.tasks, task.id).length;
    const problem = seriesToHabitProblem(task, { subtasks });
    if (problem) return Alert.alert(HABIT_CONVERT.toHabit, problem);
    const result = seriesToHabitOps(task, { subtasks });
    void run(result.ops, { text: result.message, undo: result.undo });
    router.replace({ pathname: '/habit/[id]', params: { id: task.id } });
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
            {task.recurrence ? (
              <Pill
                label="Usuń"
                onPress={() =>
                  void run([{ table: 'tasks', id: task.id, patch: { recurrence: null } }], { text: 'Usunięto powtarzanie', undo: [{ table: 'tasks', id: task.id, patch: { recurrence: task.recurrence } }] })
                }
              />
            ) : null}
          </View>
          {series ? (
            <>
              <View style={styles.pills}>
                <Pill label="Pomiń to wystąpienie" onPress={skip} />
                <Pill label="Zakończ serię" color={p.bad} onPress={() => void end()} />
                <Pill label={HABIT_CONVERT.toHabit} onPress={toHabit} />
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
    void pickAmount('Dodaj czas pracy (kończy się teraz)', [5, 10, 15, 25, 30, 45, 60, 90, 120].map((m) => ({ label: formatMinutes(m), value: m })), { value: null, min: 1, max: 1440, unit: 'min' }).then((min) => {
      if (!min) return;
      const ops = manualEntryOps(task.id, min, new Date());
      void run(ops, { text: `Dodano ${formatMinutes(min)} pracy`, undo: ops.map((op) => ({ ...op, patch: { deleted_at: new Date().toISOString() } })) });
    });
  const current = focus.state.phase !== 'idle' && focus.state.taskId === task.id;
  return (
    <Block id="time" title={`Czas pracy${spent ? ` · ${formatMinutes(spent)}` : ''}`} right={<Pill label="+ Dodaj czas" onPress={add} />}>
      <Text style={{ color: p.fg, fontSize: 15 }}>
        Spędzono {formatMinutes(spent)}
        {estimate ? ` / szac. ${formatMinutes(estimate)}` : ''}
      </Text>
      {estimate ? (
        <View style={[styles.bar, { backgroundColor: p.border }]}>
          <View style={{ width: `${Math.min(100, (spent / estimate) * 100)}%`, height: '100%', backgroundColor: spent > estimate ? p.bad : p.accent }} />
        </View>
      ) : null}
      {isOpen(task) && task.kind === 'task' && focus.settings.enabled ? (
        <View style={styles.pills}>
          <Pill label={current ? '⏱ Timer trwa — otwórz' : '▶ Skup się'} color={p.accent} onPress={() => router.push({ pathname: '/focus', params: { task: task.id } })} />
        </View>
      ) : null}
    </Block>
  );
}

/**
 * Tagi zadania. Dotknięcie chipa = menu jak na webie: kolor tagu (nie dla kopii z cudzej przestrzeni — zmienia go
 * autor), przesunięcie w lewo / prawo (`reorderTaskTagOps`; pierwszy kolorowy tag nadaje kolor karteczce), usunięcie.
 */
function TagsField({ task, data }: { task: ViewTask; data: AppData }) {
  const p = usePalette();
  const { run } = useTaskActions();
  const [name, setName] = useState('');
  // Tag, któremu wybieramy kolor (menu chipa → „Kolor…”).
  const [coloring, setColoring] = useState<string | null>(null);
  const byId = new Map(data.tags.map((t) => [t.id, t]));
  const colored = coloring && task.tagIds.includes(coloring) ? byId.get(coloring) : undefined;
  const query = name.trim().replace(/^[@#]/, '').toLowerCase();
  const tagMenu = (tagId: string, index: number) => {
    const tag = byId.get(tagId);
    const count = task.tagIds.length;
    then(
      pickOption<'color' | 'left' | 'right' | 'remove'>(`@${tag?.name ?? '…'}`, [
        ...(tag && !tag.shared ? [{ label: 'Kolor…', value: 'color' as const }] : []),
        ...(index > 0 ? [{ label: '← Przesuń w lewo', value: 'left' as const }] : []),
        ...(index < count - 1 ? [{ label: 'Przesuń w prawo →', value: 'right' as const }] : []),
        { label: 'Usuń z zadania', value: 'remove' as const, tone: 'bad' as const },
      ]),
      (choice) => {
        if (choice === 'color') setColoring(tagId);
        else if (choice === 'left' || choice === 'right') void run(reorderTaskTagOps(task.id, task.tagIds, index, index + (choice === 'left' ? -1 : 1)));
        else if (choice === 'remove')
          void run([{ table: 'task_tags', id: taskTagId(task.id, tagId), patch: { deleted_at: new Date().toISOString() } }], {
            text: `Usunięto @${tag?.name ?? 'tag'} z zadania`,
            undo: [{ table: 'task_tags', id: taskTagId(task.id, tagId), patch: { deleted_at: null } }],
          });
      },
    );
  };
  const setColor = (color: string | null) => {
    if (!colored) return;
    void run([{ table: 'tags', id: colored.id, patch: { color } }]);
    setColoring(null);
  };
  // Podpowiedzi: tagi przestrzeni zadania (wpisana nazwa ukrytego tagu i tak trafia w ten sam tag).
  const suggestions = tagsForWorkspace(data.tags, task.workspaceId).filter((t) => !task.tagIds.includes(t.id) && (!query || t.name.toLowerCase().includes(query))).slice(0, 8);
  const add = (value: string) => {
    const tag = value.trim().replace(/^[@#]/, '');
    if (!tag) return;
    setName('');
    void run(taskTagOps({ userId: data.userId, tags: data.tags }, task.id, [tag], task.workspaceId));
  };
  return (
    <Block title="Tagi">
      <View style={styles.pills}>
        {task.tagIds.map((tagId, index) => (
          <Pill
            key={tagId}
            label={`@${byId.get(tagId)?.name ?? '…'}  ⋯`}
            color={readableColor(byId.get(tagId)?.color ?? '#d97706', p.card, p.fg)}
            onPress={() => tagMenu(tagId, index)}
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
      {colored ? (
        <View style={styles.tagColor}>
          <View style={styles.tagColorHead}>
            <Text style={{ color: p.muted, fontSize: 13 }}>Kolor @{colored.name}:</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Zamknij wybór koloru" hitSlop={8} onPress={() => setColoring(null)}>
              <Text style={{ color: p.muted, fontSize: 15 }}>✕</Text>
            </Pressable>
          </View>
          <ColorPicker value={colored.color} onChange={setColor} onClear={() => setColor(null)} />
        </View>
      ) : null}
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

/**
 * Odpowiedzialny (domyślnie twórca) i uczestnicy — tylko do informacji, bez dostępu dla tych osób.
 * Nowa nazwa w polu „+ osoba” dopisuje współpracownika (Przeglądaj → „Współpracownicy”).
 */
function PeopleField({ task, data }: { task: ViewTask; data: AppData }) {
  const p = usePalette();
  const { run, notify } = useTaskActions();
  const info = useLocalQuery(
    ['task_participants', 'tasks', 'profiles', 'scope_collaborators'],
    async (engine) => {
      const [parts, creator, profile, linked] = await Promise.all([
        engine.db.all<{ collaborator_id: string }>('select collaborator_id from task_participants where task_id = ? and deleted_at is null order by rowid', [task.id]),
        engine.db.all<{ created_by: string | null }>('select created_by from tasks where id = ?', [task.id]),
        engine.db.all<{ display_name: string | null }>('select display_name from profiles where id = ?', [engine.userId]),
        engine.db.all<{ collaborator_id: string }>('select collaborator_id from scope_collaborators where scope_id = ? and user_id = ?', [task.workspaceId, engine.userId]),
      ]);
      return {
        participants: parts.map((r) => r.collaborator_id),
        createdBy: creator[0]?.created_by ?? null,
        displayName: profile[0]?.display_name ?? null,
        linked: linked.map((r) => r.collaborator_id),
      };
    },
    [task.id, task.workspaceId],
  );
  const [name, setName] = useState('');
  const byId = new Map(data.collaborators.map((c) => [c.id, c]));
  const chosen = (info?.participants ?? []).filter((id) => byId.has(id));
  const assignee = assigneeOf(task.assigneeId, data.collaborators);
  const creator = creatorLabel(info?.createdBy, data.userId);
  // Osoby z przestrzeni zadania (+ obecny odpowiedzialny, żeby wybór go pokazał).
  const people = collaboratorsForWorkspace(data.collaborators, task.workspaceId, [assignee?.id]);
  const suggestions = collaboratorMatches(people, name, chosen, 6);
  const typed = name.trim();

  const add = (value: string) => {
    const result = addParticipantByNameOps(data.userId, data.collaborators, task.id, value, task.workspaceId);
    if (!result.ok) return notify(result.error);
    setName('');
    void run(result.ops, result.created ? { text: `Nowy współpracownik: „${value.trim()}”` } : undefined);
  };
  const remove = (id: string) => {
    const { ops, undo } = removeParticipantOps(task.id, id, new Date());
    void run(ops, { text: `Usunięto z uczestników: ${byId.get(id)?.name ?? ''}`, undo });
  };
  // „Ja”: jawne wskazanie siebie (znaczek przy zadaniu); wpis powstaje przy pierwszym wyborze.
  const account = { userId: data.userId, email: sessionUser().email, displayName: info?.displayName };
  const me = selfCollaborator(data.collaborators, account, info?.linked);
  const meValue = me?.id ?? 'self';
  const assign = (id: string) => {
    if (id !== meValue) return void run(assignTaskOps(task.id, id || null));
    const result = assignSelfOps(data.collaborators, account, task.id, info?.linked);
    if (!result.ok) return notify(result.error);
    void run(result.ops, result.created ? { text: `Nowy współpracownik: „${result.created}” — akronim zmienisz we „Współpracownikach”` } : undefined);
  };
  const pickAssignee = () =>
    then(
      pickOption<string>('Odpowiedzialny', [
        { label: `${creator} (twórca zadania)`, value: '', selected: !assignee },
        { label: `Ja — ${selfName(data.collaborators, account, info?.linked)}`, value: meValue, hint: account.email ?? undefined, selected: !!assignee && assignee.id === meValue },
        ...assigneeChoices(people, assignee?.id).filter((c) => c.id !== meValue).map((c) => ({ label: c.archivedAt ? `${c.name} (nieaktywny)` : c.name, value: c.id, hint: c.email ?? undefined, selected: c.id === assignee?.id })),
      ]),
      (id) => id !== undefined && id !== (assignee?.id ?? '') && assign(id),
    );

  return (
    <Block title="Osoby">
      <View style={styles.pills}>
        <Text style={{ color: p.muted, fontSize: 13 }}>Odpowiedzialny</Text>
        <Pill label={assignee ? `👤 ${assignee.name}` : `${creator} (twórca)`} color={p.accent} onPress={pickAssignee} />
      </View>
      <Text style={{ color: p.muted, fontSize: 13 }}>Uczestnicy</Text>
      <View style={styles.pills}>
        {chosen.map((id) => (
          <Pill key={id} label={`${byId.get(id)?.name ?? '…'}  ×`} color="#0284c7" onPress={() => remove(id)} />
        ))}
        <TextInput
          value={name}
          onChangeText={setName}
          onSubmitEditing={() => typed && add(name)}
          placeholder="+ osoba"
          placeholderTextColor={p.muted}
          accessibilityLabel="Dodaj uczestnika"
          maxLength={100}
          style={[styles.tagInput, { color: p.fg, borderColor: p.border }]}
        />
      </View>
      {typed || suggestions.length ? (
        <View style={styles.pills}>
          {suggestions.map((c) => (
            <Pill key={c.id} label={c.name} onPress={() => add(c.name)} />
          ))}
          {typed && !data.collaborators.some((c) => normalizeText(c.name) === normalizeText(typed)) ? <Pill label={`+ nowa osoba „${typed}”`} color={p.accent} onPress={() => add(name)} /> : null}
        </View>
      ) : null}
      {assignee && !chosen.includes(assignee.id) ? <Pill label="+ odpowiedzialny do uczestników" onPress={() => void run(addParticipantOps(task.id, assignee.id))} /> : null}
      <Text style={{ color: p.muted, fontSize: 12 }}>Tylko informacyjnie — te osoby nie dostają dostępu do zadania.</Text>
    </Block>
  );
}

/** Komentarze: wątek od najstarszego, dodanie, edycja i usunięcie z „Cofnij”. */
function CommentsField({ task, data, today }: { task: ViewTask; data: AppData; today: LocalDate }) {
  const p = usePalette();
  const { run, notify } = useTaskActions();
  const rows = useLocalQuery(
    ['task_comments'],
    (engine) =>
      engine.db.all<{ id: string; body: string; posted_at: string; edited_at: string | null; created_by: string | null }>(
        'select id, body, posted_at, edited_at, created_by from task_comments where task_id = ? and deleted_at is null',
        [task.id],
      ),
    [task.id],
  );
  const comments = useMemo(
    () => sortComments((rows ?? []).map((r) => ({ id: r.id, taskId: task.id, body: r.body, postedAt: r.posted_at, editedAt: r.edited_at, authorId: r.created_by }))),
    [rows, task.id],
  );
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const timeZone = data.settings.timeZone;

  const submit = () => {
    const result = addCommentOps(task.id, draft, new Date());
    if (!result.ok) return notify(result.error);
    setDraft('');
    void run(result.ops);
  };
  const saveEdit = () => {
    const comment = editing && comments.find((c) => c.id === editing.id);
    if (!editing || !comment) return setEditing(null);
    const result = editCommentOps(comment, editing.text, new Date());
    if (!result.ok) return notify(result.error);
    setEditing(null);
    if (result.ops.length) void run(result.ops);
  };
  const remove = (id: string) => {
    const { ops, undo } = deleteCommentOps(id, new Date());
    void run(ops, { text: 'Usunięto komentarz', undo });
  };

  return (
    <Block title={`Komentarze${comments.length ? ` · ${comments.length}` : ''}`}>
      {comments.map((c) => (
        <View key={c.id} style={[styles.comment, { borderColor: p.border }]}>
          <View style={styles.reminder}>
            <Text style={{ color: p.fg, fontSize: 13, fontWeight: '600' }}>{commentAuthor(c.authorId, data.userId)}</Text>
            <Text style={{ color: p.muted, fontSize: 12, flex: 1 }}>
              {commentTime(c.postedAt, today, timeZone)}
              {c.editedAt ? ' (edytowano)' : ''}
            </Text>
          </View>
          {editing?.id === c.id ? (
            <>
              <TextInput
                autoFocus
                multiline
                value={editing.text}
                onChangeText={(text) => setEditing({ id: c.id, text })}
                maxLength={MAX_COMMENT_LENGTH}
                accessibilityLabel="Edycja komentarza"
                textAlignVertical="top"
                style={[styles.input, styles.commentInput, { color: p.fg, borderColor: p.border }]}
              />
              <View style={styles.pills}>
                <Pill label="Zapisz" color={p.accent} onPress={saveEdit} />
                <Pill label="Anuluj" onPress={() => setEditing(null)} />
              </View>
            </>
          ) : (
            <>
              <Text selectable style={{ color: p.fg, fontSize: 15 }}>
                {c.body}
              </Text>
              <View style={styles.pills}>
                <Pill label="Edytuj" onPress={() => setEditing({ id: c.id, text: c.body })} />
                <Pill label="Usuń" color={p.bad} onPress={() => remove(c.id)} />
              </View>
            </>
          )}
        </View>
      ))}
      <TextInput
        multiline
        value={draft}
        onChangeText={setDraft}
        placeholder="Napisz komentarz…"
        placeholderTextColor={p.muted}
        maxLength={MAX_COMMENT_LENGTH}
        accessibilityLabel="Nowy komentarz"
        textAlignVertical="top"
        style={[styles.input, styles.commentInput, { color: p.fg, borderColor: p.border }]}
      />
      {draft.trim() ? (
        <View style={styles.pills}>
          <Pill label="Dodaj komentarz" color={p.accent} onPress={submit} />
        </View>
      ) : null}
    </Block>
  );
}

/** Własne przypomnienia — także w zadaniu do podglądu, gdy użytkownik jest uczestnikiem albo odpowiedzialnym. */
function RemindersField({ task, data, today, trashed }: { task: ViewTask; data: AppData; today: LocalDate; trashed: boolean }) {
  const p = usePalette();
  const { run } = useTaskActions();
  // Kto dostanie automatyczne przypomnienie w chwili terminu i czy użytkownik jest uczestnikiem (udostępniona przestrzeń).
  const people = useLocalQuery(
    ['tasks', 'scope_collaborators', 'task_participants'],
    async (engine) => {
      const [creator, person, participant] = await Promise.all([
        engine.db.all<{ created_by: string | null }>('select created_by from tasks where id = ?', [task.id]),
        engine.db.all<{ user_id: string | null }>('select user_id from scope_collaborators where scope_id = ? and collaborator_id = ?', [task.workspaceId, task.assigneeId ?? '']),
        engine.db.all(
          'select 1 as me from task_participants p join scope_collaborators sc on sc.collaborator_id = p.collaborator_id where p.task_id = ? and p.deleted_at is null and sc.scope_id = ? and sc.user_id = ? limit 1',
          [task.id, task.workspaceId, engine.userId],
        ),
      ]);
      return {
        responsible: responsibleAccount({ assigneeId: task.assigneeId, createdBy: creator[0]?.created_by ?? engine.userId }, () => person[0]?.user_id),
        participant: participant.length > 0,
        creator: creator[0]?.created_by ?? engine.userId,
      };
    },
    [task.id, task.workspaceId, task.assigneeId ?? ''],
  );
  const note = people
    ? assigneeReminderNote(task, {
        shared: (data.workspaces.find((w) => w.id === task.workspaceId)?.members ?? 1) > 1,
        userId: data.userId,
        assigneeName: assigneeOf(task.assigneeId, data.collaborators)?.name ?? null,
        account: people.responsible,
        prefs: data.settings.notifications,
        follows:
          (data.settings.notifications.follow.created && people.creator === data.userId) ||
          (data.settings.notifications.follow.participating && people.participant),
      })
    : null;
  const allowed = canSetOwnReminder({ editable: listEditable(data, task.listId), userId: data.userId, responsible: people?.responsible ?? null, participant: people?.participant ?? false });
  const rows =
    useLocalQuery(
      ['reminders'],
      (engine) =>
        engine.db.all<{ id: string; kind: string; offset_min: number | null; at_date: string | null; at_time: string | null }>(
          'select id, kind, offset_min, at_date, at_time from reminders where task_id = ? and deleted_at is null and (created_by is null or created_by = ?) order by kind, offset_min, at_date, at_time',
          [task.id, engine.userId],
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
    <Editable readOnly={trashed || (!allowed && !rows.length)}>
      <Block title="Przypomnienia" right={allowed ? <Pill label="+ Dodaj" color={p.accent} onPress={() => void addMenu()} /> : undefined}>
        {rows.map((r) => (
          <View key={r.id} style={styles.reminder}>
            <Text style={{ color: p.fg, fontSize: 15, flex: 1 }}>
              🔔 {r.kind === 'relative' ? reminderOffset(Number(r.offset_min)) : `${relativeDay(r.at_date as LocalDate, today)} ${String(r.at_time).slice(0, 5)}`}
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Usuń przypomnienie" hitSlop={10} onPress={() => void run([{ table: 'reminders', id: r.id, patch: { deleted_at: new Date().toISOString() } }], { text: 'Usunięto przypomnienie', undo: [{ table: 'reminders', id: r.id, patch: { deleted_at: null } }] })}>
              <Text style={{ color: p.muted, fontSize: 16 }}>✕</Text>
            </Pressable>
          </View>
        ))}
        {!rows.length ? <Text style={{ color: p.muted, fontSize: 13 }}>Brak przypomnień{task.dueDate ? '' : ' — „przed terminem” wymaga terminu'}</Text> : null}
        {!allowed && !trashed && people ? <Text style={{ color: p.muted, fontSize: 13 }}>{VIEWER_REMINDER_NOTE}</Text> : null}
        {note ? <Text style={{ color: p.muted, fontSize: 13 }}>{note}</Text> : null}
      </Block>
    </Editable>
  );
}

/**
 * Zależności koniec→początek (M12), jak w panelu zadania na webie: „Czeka na” (poprzednicy) i „Blokuje”
 * (następnicy) z odstępem w dniach i naruszeniem; dodanie wyszukaniem otwartego zadania z tej samej
 * przestrzeni przez `addDependencyOps` (cykl, duplikat i inna przestrzeń są blokowane).
 */
/** Podpięcie istniejącego zadania z tej samej listy jako podzadania (core `subtaskCandidates`), jak na webie. */
function AttachSubtask({ task, data }: { task: ViewTask; data: AppData }) {
  const p = usePalette();
  const { run, notify } = useTaskActions();
  const [open, setOpen] = useState(false);
  const all = useMemo(() => (open ? subtaskCandidates(data.tasks, task.id) : []), [open, data.tasks, task.id]);

  const attach = (child: ViewTask) => {
    const result = attachSubtaskOps(data.tasks, task.id, child.id);
    if (!result) return notify('Tego zadania nie można podpiąć (cykl albo więcej niż 4 poziomy).');
    void run(result.ops, { text: `„${child.title}” jest podzadaniem „${task.title}”`, undo: result.undo });
  };

  if (!open) {
    return (
      <View style={styles.pills}>
        <Pill label="+ Z istniejących…" color={p.accent} onPress={() => setOpen(true)} />
      </View>
    );
  }
  return <TaskPicker data={data} candidates={all} onPick={attach} onClose={() => setOpen(false)} label="Szukaj zadania do podpięcia" verb="Podepnij" empty="Brak zadań na tej liście, które można podpiąć." />;
}

/**
 * Rodzic zadania, jak na webie: przepięcie pod inne zadanie tej listy albo odpięcie do zadań głównych
 * (core `parentCandidates` / `reparentTaskOps`, z „Cofnij”).
 */
function ParentField({ task, data, parent }: { task: ViewTask; data: AppData; parent: ViewTask | undefined }) {
  const p = usePalette();
  const { run, notify } = useTaskActions();
  const locked = useSectionsLocked();
  const [open, setOpen] = useState(false);
  const all = useMemo(() => (open ? parentCandidates(data.tasks, task.id) : []), [open, data.tasks, task.id]);

  const move = (to: ViewTask | null) => {
    const result = reparentTaskOps(data.tasks, task.id, to?.id ?? null);
    if (!result) return notify('Tu nie można przepiąć zadania (cykl albo więcej niż 4 poziomy).');
    void run(result.ops, { text: to ? `„${task.title}” jest podzadaniem „${to.title}”` : `„${task.title}” jest zadaniem głównym`, undo: result.undo });
    setOpen(false);
  };

  return (
    <Block title="Zadanie nadrzędne" readable>
      {parent ? (
        <Pressable accessibilityRole="link" accessibilityLabel={`Otwórz „${parent.title}”`} onPress={() => router.push({ pathname: '/task/[id]', params: { id: parent.id } })}>
          <Text style={{ color: p.accent, fontSize: 15 }} numberOfLines={2}>
            {parent.title}
          </Text>
        </Pressable>
      ) : (
        <Text style={{ color: p.muted, fontSize: 15 }}>— (zadanie główne)</Text>
      )}
      {locked ? null : open ? (
        <TaskPicker data={data} candidates={all} onPick={move} onClose={() => setOpen(false)} label="Szukaj zadania nadrzędnego" verb="Przepnij pod" empty="Brak zadań na tej liście, pod które można przepiąć." />
      ) : (
        <View style={styles.pills}>
          <Pill label={parent ? 'Przepnij…' : 'Przypnij do zadania…'} color={p.accent} onPress={() => setOpen(true)} />
          {parent ? <Pill label="Odepnij" onPress={() => move(null)} /> : null}
        </View>
      )}
    </Block>
  );
}

/** Wyszukiwarka zadania z listy kandydatów (8 pierwszych pasujących; „Gotowe” na klawiaturze = pierwsze). */
function TaskPicker({ data, candidates: all, onPick, onClose, label, verb, empty }: {
  data: AppData;
  candidates: readonly ViewTask[];
  onPick: (task: ViewTask) => void;
  onClose: () => void;
  label: string;
  verb: string;
  empty: string;
}) {
  const p = usePalette();
  const [query, setQuery] = useState('');
  const needle = normalizeText(query.trim());
  const candidates = (needle ? all.filter((t) => normalizeText(t.title).includes(needle)) : all).slice(0, 8);
  const titleOf = (id: string | null) => (id ? (data.tasks.find((t) => t.id === id)?.title ?? '') : '');
  const pick = (t: ViewTask) => {
    onPick(t);
    setQuery('');
  };

  return (
    <View style={{ gap: 6 }}>
      <View style={styles.pills}>
        <TextInput
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder="Szukaj zadania na tej liście"
          placeholderTextColor={p.muted}
          accessibilityLabel={label}
          returnKeyType="done"
          onSubmitEditing={() => candidates[0] && pick(candidates[0])}
          style={[styles.input, { flex: 1, color: p.fg, borderColor: p.border }]}
        />
        <Pill label="Anuluj" onPress={onClose} />
      </View>
      {candidates.map((t) => (
        <Pressable key={t.id} accessibilityRole="button" accessibilityLabel={`${verb} „${t.title}”`} onPress={() => pick(t)} style={[styles.candidate, { borderColor: p.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: p.fg, fontSize: 15 }} numberOfLines={1}>
              {t.title}
            </Text>
            {t.parentId ? (
              <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={1}>
                ↳ {titleOf(t.parentId)}
              </Text>
            ) : null}
          </View>
          {t.dueDate ? <Text style={{ color: p.muted, fontSize: 12 }}>{shortDate(t.dueDate)}</Text> : null}
        </Pressable>
      ))}
      {!candidates.length ? <Text style={{ color: p.muted, fontSize: 12 }}>{needle ? 'Brak otwartych zadań o takim tytule na tej liście.' : empty}</Text> : null}
    </View>
  );
}

function DependenciesField({ task, data }: { task: ViewTask; data: AppData }) {
  const p = usePalette();
  const { run, notify } = useTaskActions();
  const locked = useSectionsLocked();
  const deps = useDependencies();
  const links = useMemo(() => taskLinks(task.id, data.tasks, deps), [task.id, data.tasks, deps]);
  const derived = useMemo(() => derivedLinks(task.id, data.tasks), [task.id, data.tasks]);
  const [adding, setAdding] = useState<'predecessor' | 'successor' | null>(null);
  const [query, setQuery] = useState('');
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const titleOf = (id: string) => `„${byId.get(id)?.title ?? '?'}”`;
  const needle = normalizeText(query.trim());
  const candidates = adding && needle ? data.tasks.filter((t) => t.id !== task.id && t.kind === 'task' && t.workspaceId === task.workspaceId && isOpen(t) && normalizeText(t.title).includes(needle)).slice(0, 8) : [];

  const close = () => {
    setAdding(null);
    setQuery('');
  };
  const add = (otherId: string) => {
    const next = adding === 'predecessor' ? { predecessorId: otherId, successorId: task.id } : { predecessorId: task.id, successorId: otherId };
    const result = addDependencyOps(data.tasks, deps, next);
    if ('error' in result) return notify(dependencyErrorText(result.error, titleOf));
    void run(result.ops, { text: `Zależność: ${titleOf(next.predecessorId)} → ${titleOf(next.successorId)}`, undo: result.undo });
    close();
  };
  const lagLabel = (days: number) => (days ? `${days > 0 ? '+' : ''}${plural(days, ['dzień', 'dni', 'dni'])}` : 'bez odstępu');
  const pickLag = (d: Dependency) =>
    then(
      pickAmount(
        'Odstęp: koniec poprzednika → początek następnika',
        [...new Set([...LAGS, d.lagDays])].sort((a, b) => a - b).map((n) => ({ label: lagLabel(n), value: n, selected: n === d.lagDays })),
        { value: d.lagDays, min: -365, max: 365, unit: 'dni' },
      ),
      (lag) => lag !== undefined && clampLag(lag) !== d.lagDays && run([{ table: 'task_dependencies', id: d.id, patch: { lag_days: clampLag(lag) } }]),
    );

  const item = (link: TaskLink) => {
    const other = byId.get(link.otherId);
    const done = !!other && !isOpen(other);
    const { dependency: d } = link;
    return (
      <View key={d.id} style={styles.dependency}>
        <Pressable accessibilityRole="link" style={{ flex: 1, gap: 2 }} onPress={() => router.push({ pathname: '/task/[id]', params: { id: link.otherId } })}>
          <Text style={{ color: done ? p.muted : p.fg, fontSize: 15, textDecorationLine: done ? 'line-through' : 'none' }} numberOfLines={1}>
            {other?.title ?? '?'}
          </Text>
          {link.violation ? (
            <Text style={{ color: p.bad, fontSize: 12 }}>
              ⚠ {plural(link.violation.days, ['dzień', 'dni', 'dni'])} za wcześnie — następnik najwcześniej {shortDate(link.violation.earliestStart)}
            </Text>
          ) : null}
        </Pressable>
        {locked ? (
          <Text style={{ color: p.muted, fontSize: 12 }}>{lagLabel(d.lagDays)}</Text>
        ) : (
          <>
            <Pill label={lagLabel(d.lagDays)} onPress={() => pickLag(d)} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Usuń zależność z ${titleOf(link.otherId)}`}
              hitSlop={10}
              onPress={() => {
                const result = removeDependencyOps(d.id);
                void run(result.ops, { text: `Usunięto zależność ${titleOf(d.predecessorId)} → ${titleOf(d.successorId)}`, undo: result.undo });
              }}
            >
              <Text style={{ color: p.muted, fontSize: 16 }}>✕</Text>
            </Pressable>
          </>
        )}
      </View>
    );
  };

  // „Wynika z” (Karteczki na webie) to samo powiązanie, nie zależność — tu tylko do odczytu.
  const linked = (title: string, tasks: readonly ViewTask[]) =>
    tasks.length ? (
      <View style={{ gap: 6 }}>
        <Text style={{ color: p.muted, fontSize: 12 }}>{title}</Text>
        {tasks.map((t) => (
          <Pressable key={t.id} accessibilityRole="link" accessibilityLabel={`${title}: „${t.title}”`} style={styles.dependency} onPress={() => router.push({ pathname: '/task/[id]', params: { id: t.id } })}>
            <Text style={{ flex: 1, color: isOpen(t) ? p.fg : p.muted, fontSize: 15, textDecorationLine: isOpen(t) ? 'none' : 'line-through' }} numberOfLines={1}>
              {t.title}
            </Text>
          </Pressable>
        ))}
      </View>
    ) : null;

  const count = links.predecessors.length + links.successors.length + derived.from.length + derived.to.length;
  return (
    <Block title={`Zależności${count ? ` · ${count}` : ''}`} readable>
      {links.predecessors.length ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: p.muted, fontSize: 12 }}>Czeka na</Text>
          {links.predecessors.map(item)}
        </View>
      ) : null}
      {links.successors.length ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: p.muted, fontSize: 12 }}>Blokuje</Text>
          {links.successors.map(item)}
        </View>
      ) : null}
      {linked('Wynika z', derived.from)}
      {linked('Z tego wynika', derived.to)}
      {derived.from.length || derived.to.length ? <Text style={{ color: p.muted, fontSize: 11 }}>„Wynika z” to powiązanie z Karteczek na webie (bez wpływu na terminy); zmienia się tylko tam.</Text> : null}
      {adding ? (
        <View style={{ gap: 6 }}>
          <View style={styles.pills}>
            <TextInput
              autoFocus
              value={query}
              onChangeText={setQuery}
              placeholder={adding === 'predecessor' ? 'Na co czeka to zadanie?' : 'Co czeka na to zadanie?'}
              placeholderTextColor={p.muted}
              accessibilityLabel="Szukaj zadania"
              style={[styles.input, { flex: 1, color: p.fg, borderColor: p.border }]}
            />
            <Pill label="Anuluj" onPress={close} />
          </View>
          {candidates.map((t) => (
            <Pressable key={t.id} accessibilityRole="button" accessibilityLabel={`Wybierz „${t.title}”`} onPress={() => add(t.id)} style={[styles.candidate, { borderColor: p.border }]}>
              <Text style={{ color: p.fg, fontSize: 15, flex: 1 }} numberOfLines={1}>
                {t.title}
              </Text>
              {t.dueDate ? <Text style={{ color: p.muted, fontSize: 12 }}>{shortDate(t.dueDate)}</Text> : null}
            </Pressable>
          ))}
          {needle && !candidates.length ? <Text style={{ color: p.muted, fontSize: 12 }}>Brak otwartych zadań o takim tytule w tej przestrzeni.</Text> : null}
        </View>
      ) : locked ? (
        count ? null : <Text style={{ color: p.muted, fontSize: 12 }}>Brak zależności.</Text>
      ) : (
        <View style={styles.pills}>
          <Pill label="+ Czeka na…" color={p.accent} onPress={() => setAdding('predecessor')} />
          <Pill label="+ Blokuje…" color={p.accent} onPress={() => setAdding('successor')} />
        </View>
      )}
    </Block>
  );
}

const styles = StyleSheet.create({
  body: { padding: 12, gap: 12, paddingBottom: 60 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  readOnly: { fontSize: 13, borderRadius: 8, padding: 8 },
  trash: { borderRadius: 8, padding: 10, gap: 8 },
  trashedRow: { paddingHorizontal: 12, paddingVertical: 9, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth },
  trashedTitle: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  modeSwitch: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  check: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  tick: { color: '#fff', fontSize: 14, fontWeight: '700' },
  title: { flex: 1, fontSize: 20, fontWeight: '600', paddingVertical: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { width: '48.5%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, gap: 2 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  pill: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 5, minHeight: 36, justifyContent: 'center' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  tagInput: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 3, fontSize: 13, minWidth: 90 },
  tagColor: { marginTop: 10, gap: 8 },
  tagColorHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  comment: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, gap: 6 },
  commentInput: { minHeight: 64 },
  reminder: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dependency: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  candidate: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9 },
  bar: { height: 6, borderRadius: 3, overflow: 'hidden' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#8884', paddingTop: 12 },
});
