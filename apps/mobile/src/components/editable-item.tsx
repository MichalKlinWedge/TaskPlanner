/**
 * Wiersz przestrzeni albo listy: dotknięcie otwiera, „Edytuj” rozwija nazwę, kolor, kolejność
 * (↑ ↓) i archiwizację. Zapis od razu do lokalnej bazy (`onSave` → `mutate`).
 */
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ColorPicker } from './color-picker';
import { Button, ColorDot, Field, Row, usePalette } from './ui';

export interface EditableItemProps {
  name: string;
  /** Limit nazwy w bazie (przestrzeń 100, lista 200). */
  maxLength: number;
  color: string | null;
  subtitle: string;
  onOpen?: () => void;
  /** Bez `onSave` nazwy nie da się zmienić (Inbox). */
  onSave?: (patch: { name: string; color: string | null }) => Promise<void>;
  onColor?: (color: string) => Promise<void>;
  onMoveUp?: () => Promise<void>;
  onMoveDown?: () => Promise<void>;
  archived?: boolean;
  onArchive?: (archived: boolean) => Promise<void>;
  /** Dodatkowe pola w trybie edycji (rodzaj listy, status projektu, usunięcie). */
  children?: ReactNode;
  onError: (error: unknown) => void;
}

export function EditableItem(props: EditableItemProps) {
  const p = usePalette();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(props.name);
  const [busy, setBusy] = useState(false);

  const run = (work?: () => Promise<void>) => {
    if (!work) return;
    setBusy(true);
    work()
      .catch(props.onError)
      .finally(() => setBusy(false));
  };

  return (
    <View style={[styles.item, { borderColor: p.border, backgroundColor: p.card, opacity: props.archived ? 0.7 : 1 }]}>
      <View style={styles.head}>
        <Pressable
          accessibilityRole="button"
          disabled={!props.onOpen}
          onPress={props.onOpen}
          style={({ pressed }) => [styles.main, { opacity: pressed ? 0.6 : 1 }]}
        >
          <ColorDot color={props.color} size={14} />
          <View style={styles.titles}>
            <Text style={[styles.name, { color: p.fg }]} numberOfLines={1}>
              {props.name}
            </Text>
            <Text style={[styles.subtitle, { color: p.muted }]}>{props.subtitle}</Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setName(props.name);
            setEditing(!editing);
          }}
          hitSlop={8}
        >
          <Text style={{ color: p.accent, fontWeight: '600' }}>{editing ? 'Gotowe' : 'Edytuj'}</Text>
        </Pressable>
      </View>
      {editing ? (
        <View style={styles.edit}>
          {props.onSave ? (
            <Row>
              <View style={{ flex: 1, minWidth: 160 }}>
                <Field label="Nazwa" value={name} onChangeText={setName} maxLength={props.maxLength} />
              </View>
              <View style={{ justifyContent: 'flex-end' }}>
                <Button
                  title="Zapisz"
                  disabled={busy || !name.trim() || name.trim() === props.name}
                  onPress={() => run(() => props.onSave!({ name, color: props.color }))}
                />
              </View>
            </Row>
          ) : null}
          {props.onColor ? <ColorPicker value={props.color} onChange={(color) => run(() => props.onColor!(color))} /> : null}
          <Row>
            {props.onMoveUp || props.onMoveDown ? (
              <>
                <Button kind="secondary" title="↑ Wyżej" disabled={busy || !props.onMoveUp} onPress={() => run(props.onMoveUp)} />
                <Button kind="secondary" title="↓ Niżej" disabled={busy || !props.onMoveDown} onPress={() => run(props.onMoveDown)} />
              </>
            ) : null}
            {props.onArchive ? (
              <Button
                kind="secondary"
                title={props.archived ? 'Przywróć z archiwum' : 'Archiwizuj'}
                disabled={busy}
                onPress={() => run(() => props.onArchive!(!props.archived))}
              />
            ) : null}
          </Row>
          {props.children}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  item: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  titles: { flex: 1 },
  name: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 12 },
  edit: { gap: 10 },
});
