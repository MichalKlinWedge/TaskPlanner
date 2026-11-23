/**
 * Szablony projektów (v1.x) na telefonie: „Zapisz jako szablon” na ekranie projektu, wybór szablonu
 * z datą startu / końca przy dodawaniu projektu w przestrzeni i sekcja szablonów (usunięcie z „Cofnij”).
 */
import { deleteTemplateOps, shortDate, templateDates, templateHasDates, templateNamed, templateSummary, type LocalDate, type ProjectTemplate, type TemplateAnchor } from '@taskplanner/core';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { useTaskActions } from './actions';
import { pickDate } from './pickers';
import { Button, Chip, Field, P, Row, Section } from './ui';
import { saveProjectAsTemplate, useProjectTemplates } from '@/lib/templates';

/** Wybrany szablon nowego projektu (`null` = pusty projekt). */
export interface TemplateChoice {
  template: ProjectTemplate;
  anchor: TemplateAnchor | null;
}

/** Zapis projektu jako szablonu: pole nazwy (domyślnie nazwa projektu); ta sama nazwa = zastąpienie po potwierdzeniu. */
export function SaveTemplateBar({ listId, listName, onClose }: { listId: string; listName: string; onClose: () => void }) {
  const templates = useProjectTemplates();
  const { notify } = useTaskActions();
  const [name, setName] = useState(listName);
  const [busy, setBusy] = useState(false);
  const existing = templateNamed(templates, name);

  const save = () => {
    setBusy(true);
    saveProjectAsTemplate(listId, name, templates)
      .then(({ replaced, summary }) => {
        notify(`${replaced ? 'Zastąpiono' : 'Zapisano'} szablon „${name.trim()}” · ${summary}`);
        onClose();
      })
      .catch((e: unknown) => notify(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8 }}>
      <Field label="Nazwa szablonu" value={name} onChangeText={setName} maxLength={100} autoFocus />
      <P muted>Zadania z podzadaniami, tagi, przypomnienia i zależności; daty liczone od startu projektu.</P>
      <Row>
        <Button
          title={existing ? 'Zastąp szablon' : 'Zapisz szablon'}
          disabled={!name.trim() || busy}
          onPress={() =>
            existing
              ? Alert.alert(`Zastąpić „${existing.name}”?`, 'Szablon o tej nazwie już jest — dostanie zadania tego projektu.', [
                  { text: 'Anuluj', style: 'cancel' },
                  { text: 'Zastąp', style: 'destructive', onPress: save },
                ])
              : save()
          }
        />
        <Button kind="secondary" title="Anuluj" onPress={onClose} />
      </Row>
    </View>
  );
}

/** Szablon nowego projektu: „Pusty” albo szablon; szablon z datami — start / koniec i dzień. */
export function TemplateFields({ templates, value, onChange, today }: { templates: readonly ProjectTemplate[]; value: TemplateChoice | null; onChange: (v: TemplateChoice | null) => void; today: LocalDate }) {
  if (!templates.length) return null;
  const content = value?.template.content ?? null;
  const anchor = value?.anchor ?? { kind: 'start' as const, date: today };
  const dated = content ? templateHasDates(content) : false;
  const dates = content && dated ? templateDates(content, anchor) : null;
  return (
    <>
      <P muted>Szablon</P>
      <Row>
        <Chip label="Pusty projekt" selected={!value} onPress={() => onChange(null)} />
        {templates.map((t) => (
          <Chip
            key={t.id}
            label={t.name}
            disabled={!t.content}
            selected={value?.template.id === t.id}
            onPress={() => onChange({ template: t, anchor: t.content && templateHasDates(t.content) ? anchor : null })}
          />
        ))}
      </Row>
      {value && dated ? (
        <Row>
          <Chip label="Od startu" selected={anchor.kind === 'start'} onPress={() => onChange({ ...value, anchor: { ...anchor, kind: 'start' } })} />
          <Chip label="Do końca" selected={anchor.kind === 'end'} onPress={() => onChange({ ...value, anchor: { ...anchor, kind: 'end' } })} />
          <Chip
            label={`${anchor.kind === 'start' ? 'Start' : 'Koniec'}: ${shortDate(anchor.date)}`}
            onPress={() =>
              void pickDate({ title: anchor.kind === 'start' ? 'Data startu projektu' : 'Data końca projektu', value: anchor.date, today }).then(
                (date) => date && onChange({ ...value, anchor: { ...anchor, date } }),
              )
            }
          />
        </Row>
      ) : null}
      {value ? (
        <P muted>
          {templateSummary(content)}
          {dates ? ` · ${shortDate(dates.start)} – ${shortDate(dates.end)}` : ''}
        </P>
      ) : null}
    </>
  );
}

/** Szablony użytkownika z opisem i usunięciem (z „Cofnij”). */
export function TemplatesSection() {
  const templates = useProjectTemplates();
  const { run } = useTaskActions();
  if (!templates.length) return null;
  return (
    <Section title="Szablony projektów">
      {templates.map((t) => (
        <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <P>{t.name}</P>
            <P muted>{templateSummary(t.content)}</P>
          </View>
          <Button
            kind="secondary"
            title="Usuń"
            onPress={() => {
              const { ops, undo } = deleteTemplateOps(t.id);
              void run(ops, { text: `Usunięto szablon „${t.name}”`, undo });
            }}
          />
        </View>
      ))}
      <P muted>Szablon zapiszesz na ekranie projektu („⧉ Zapisz jako szablon”). Szablony są Twoje — widzisz je na wszystkich urządzeniach.</P>
    </Section>
  );
}
