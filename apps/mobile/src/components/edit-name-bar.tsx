/** Edycja nazwy (do 60 znaków, jak w bazie) i koloru z usunięciem po potwierdzeniu — tag, zapisany filtr. */
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { ColorPicker } from './color-picker';
import { Button, Field, Row } from './ui';

export function EditNameBar({
  name,
  label,
  color,
  onSave,
  onDelete,
  deleteTitle,
  deleteMessage,
}: {
  name: string;
  label: string;
  /** `undefined` — bez wyboru koloru. */
  color?: { value: string | null; onChange: (color: string) => void; onClear?: () => void };
  onSave: (name: string) => void;
  onDelete: () => void;
  deleteTitle: string;
  deleteMessage: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 8, gap: 8 }}>
      {editing ? (
        <>
          <Field label={label} value={draft} onChangeText={setDraft} maxLength={60} autoFocus />
          {color ? <ColorPicker value={color.value} onChange={color.onChange} onClear={color.onClear} /> : null}
          <Row>
            <Button
              title="Zapisz"
              disabled={!draft.trim() || draft.trim() === name}
              onPress={() => {
                onSave(draft.trim());
                setEditing(false);
              }}
            />
            <Button kind="secondary" title="Gotowe" onPress={() => setEditing(false)} />
            <Button
              kind="danger"
              title="Usuń"
              onPress={() =>
                Alert.alert(deleteTitle, deleteMessage, [
                  { text: 'Anuluj', style: 'cancel' },
                  { text: 'Usuń', style: 'destructive', onPress: onDelete },
                ])
              }
            />
          </Row>
        </>
      ) : (
        <Row>
          <Button
            kind="secondary"
            title="Edytuj"
            onPress={() => {
              setDraft(name);
              setEditing(true);
            }}
          />
        </Row>
      )}
    </View>
  );
}
