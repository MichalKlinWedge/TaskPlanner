/**
 * Sekcja „Załączniki” na ekranie zadania (Etap 10, jak `AttachmentsField` na webie): zdjęcie z aparatu,
 * obrazy z galerii, dowolne pliki i linki. Pliki idą przez kolejkę (`lib/files.ts`) — offline czekają
 * z dopiskiem „czeka na sieć”. Podgląd: obrazy w aplikacji (pełny ekran), PDF i reszta w aplikacji
 * systemowej (`File.preview` → `ACTION_VIEW`).
 */
import { attachmentView, fileProblem, formatBytes, linkAttachmentOp, parseHttpUrl, plural, AttachmentPreview, type NewFile } from '@taskplanner/core';
import type { PendingFile, SqlRow } from '@taskplanner/sync';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { Image, Linking, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { sessionUser } from '@/lib/config';
import { addFile, discardFile, localFile, localUri, retryFile, usePendingFiles } from '@/lib/files';
import { useLocalQuery, useSyncStatus } from '@/lib/local-query';

import { useTaskActions } from './actions';
import { usePalette } from './ui';

interface Attachment {
  id: string;
  kind: 'file' | 'link';
  storagePath: string | null;
  name: string;
  mime: string | null;
  size: number | null;
  url: string | null;
  preview: AttachmentPreview | null;
}

const parsePreview = (value: unknown): AttachmentPreview | null => {
  if (value === null || value === undefined) return null;
  try {
    const parsed = AttachmentPreview.safeParse(typeof value === 'string' ? JSON.parse(value) : value);
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
};

function useAttachments(taskId: string): Attachment[] {
  return (
    useLocalQuery(
      ['attachments'],
      async (engine) =>
        (
          await engine.db.all<SqlRow>(
            'select id, kind, storage_path, name, mime, size_bytes, url, preview from attachments where task_id = ? and deleted_at is null order by id',
            [taskId],
          )
        ).map((r) => ({
          id: String(r.id),
          kind: r.kind === 'link' ? 'link' : 'file',
          storagePath: (r.storage_path as string | null) ?? null,
          name: String(r.name),
          mime: (r.mime as string | null) ?? null,
          size: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
          url: (r.url as string | null) ?? null,
          preview: parsePreview(r.preview),
        })),
      [taskId],
    ) ?? []
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
function photoName(mime?: string) {
  const d = new Date();
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return `Zdjęcie ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.${ext}`;
}

type Shown = { id: string; storagePath: string | null; name: string; mime: string | null };

/** `readOnly` — przestrzeń udostępniona do podglądu: tylko otwieranie, bez dodawania i usuwania. */
export function AttachmentsField({ taskId, readOnly = false }: { taskId: string; readOnly?: boolean }) {
  const p = usePalette();
  const { run, notify } = useTaskActions();
  const items = useAttachments(taskId);
  const waiting = usePendingFiles().filter((f) => f.taskId === taskId && !items.some((i) => i.id === f.id));
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const sync = useSyncStatus();
  const offline = !sessionUser().online || !!sync.error;

  const add = async (files: ({ uri: string } & Partial<NewFile>)[]) => {
    const problems = files.map((f) => fileProblem({ name: f.name || 'plik', mime: f.mime ?? '', size: f.size ?? 0 })).filter(Boolean);
    if (problems.length) notify(problems.join(' '));
    const ok = files.filter((f) => !fileProblem({ name: f.name || 'plik', mime: f.mime ?? '', size: f.size ?? 0 }));
    try {
      for (const f of ok) await addFile(taskId, f);
      if (ok.length) notify(offline ? `${plural(ok.length, ['plik czeka', 'pliki czekają', 'plików czeka'])} na połączenie` : `Wysyłanie: ${plural(ok.length, ['plik', 'pliki', 'plików'])}`);
    } catch (error) {
      notify(`Nie udało się dodać pliku: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Aparat nie podaje nazwy (plik w pamięci podręcznej ma losowe id) — „Zdjęcie 2026-11-19 21-44.jpg”.
  const fromPicker = (assets: ImagePicker.ImagePickerAsset[], camera = false) =>
    add(assets.map((a) => ({ uri: a.uri, name: camera || !a.fileName ? photoName(a.mimeType) : a.fileName, mime: a.mimeType, size: a.fileSize })));

  const camera = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return notify('Bez dostępu do aparatu — włącz go w ustawieniach systemu.');
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 0.7 });
    if (!result.canceled) await fromPicker(result.assets, true);
  };
  const gallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, quality: 0.8 });
    if (!result.canceled) await fromPicker(result.assets);
  };
  const document = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (!result.canceled) await add(result.assets.map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType, size: a.size })));
  };
  const addLink = () => {
    const parsed = parseHttpUrl(url);
    if (!parsed) return notify('Podaj adres zaczynający się od http:// albo https://');
    const op = linkAttachmentOp(taskId, parsed.href);
    void run([op], { text: 'Dodano link', undo: [{ table: 'attachments', id: op.id, patch: { deleted_at: new Date().toISOString() } }] });
    setUrl('');
    setLinking(false);
  };
  const remove = (a: Attachment) =>
    void run([{ table: 'attachments', id: a.id, patch: { deleted_at: new Date().toISOString() } }], {
      text: `Usunięto „${a.name}”`,
      undo: [{ table: 'attachments', id: a.id, patch: { deleted_at: null } }],
    });

  const open = async (item: Shown) => {
    try {
      const file = await localFile(item);
      if (attachmentView(item.mime) === 'image') setImage(file.uri);
      else await file.preview({ mimeType: item.mime ?? undefined, title: item.name });
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  };

  const links = items.filter((a) => a.kind === 'link');
  const files = items.filter((a) => a.kind === 'file');
  const count = items.length + waiting.length;

  return (
    <View style={[styles.block, { borderColor: p.border, backgroundColor: p.card }]}>
      <Text style={[styles.title, { color: p.muted }]}>{`ZAŁĄCZNIKI${count ? ` · ${count}` : ''}`}</Text>
      <View style={styles.actions}>
        <Action label="📷 Aparat" disabled={readOnly} onPress={() => void camera()} />
        <Action label="🖼 Galeria" disabled={readOnly} onPress={() => void gallery()} />
        <Action label="📎 Plik" disabled={readOnly} onPress={() => void document()} />
        <Action label="🔗 Link" disabled={readOnly} onPress={() => setLinking((v) => !v)} />
      </View>
      {linking ? (
        <View style={styles.linkRow}>
          <TextInput
            value={url}
            onChangeText={setUrl}
            autoFocus
            placeholder="https://…"
            placeholderTextColor={p.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onSubmitEditing={addLink}
            accessibilityLabel="Adres linku"
            style={[styles.input, { color: p.fg, borderColor: p.border }]}
          />
          <Action label="Dodaj" onPress={addLink} primary />
        </View>
      ) : null}

      {links.map((a) => (
        <Pressable
          key={a.id}
          accessibilityRole="link"
          onPress={() => a.url && void Linking.openURL(a.url)}
          onLongPress={readOnly ? undefined : () => remove(a)}
          style={[styles.link, { borderColor: p.border }]}
        >
          <Text style={{ color: p.fg }} numberOfLines={1}>
            🔗 {a.name}
          </Text>
          <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={1}>
            {a.preview === null ? 'Pobieranie podglądu…' : [a.preview.siteName, a.preview.description].filter(Boolean).join(' · ') || a.url}
          </Text>
        </Pressable>
      ))}

      {files.length || waiting.length ? (
        <View style={styles.grid}>
          {files.map((a) => (
            <Tile key={a.id} item={a} subtitle={a.size !== null ? formatBytes(a.size) : ''} onOpen={() => void open(a)} onRemove={readOnly ? undefined : () => remove(a)} />
          ))}
          {waiting.map((f) => (
            <PendingTile key={f.id} file={f} offline={offline} onOpen={() => void open({ id: f.id, storagePath: null, name: f.name, mime: f.mime })} />
          ))}
        </View>
      ) : null}

      {!count && !linking ? <Text style={{ color: p.muted, fontSize: 12 }}>Zdjęcie, plik do 25 MB albo link. Przytrzymaj, żeby usunąć.</Text> : null}

      <Modal visible={!!image} transparent animationType="fade" onRequestClose={() => setImage(null)}>
        <Pressable accessibilityLabel="Zamknij podgląd" style={styles.viewer} onPress={() => setImage(null)}>
          {image ? <Image source={{ uri: image }} style={styles.full} resizeMode="contain" /> : null}
        </Pressable>
      </Modal>
    </View>
  );
}

function Action({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.action, { borderColor: primary ? p.accent : p.border, backgroundColor: primary ? p.accent : 'transparent', opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
    >
      <Text style={{ color: primary ? '#fff' : p.fg, fontSize: 13, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

/** Miniatura obrazu (z pliku na telefonie; z serwera pobierana przy pierwszym pokazaniu) albo ikona typu. */
function Thumb({ item }: { item: { id: string; storagePath: string | null; mime: string | null } }) {
  const kind = attachmentView(item.mime);
  const [uri, setUri] = useState(() => (kind === 'image' ? localUri(item) : null));
  useEffect(() => {
    if (kind !== 'image' || uri) return;
    let alive = true;
    localFile(item).then(
      (file) => alive && setUri(file.uri),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [kind, uri, item]);
  if (uri) return <Image source={{ uri }} style={styles.thumb} resizeMode="cover" />;
  return <Text style={styles.icon}>{kind === 'pdf' ? '📄' : kind === 'image' ? '🖼' : '📦'}</Text>;
}

function Tile({ item, subtitle, onOpen, onRemove }: { item: Attachment; subtitle: string; onOpen: () => void; onRemove?: () => void }) {
  const p = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Otwórz „${item.name}”`} onPress={onOpen} onLongPress={onRemove} style={[styles.tile, { borderColor: p.border }]}>
      <Thumb item={item} />
      <Text style={{ color: p.fg, fontSize: 12 }} numberOfLines={1}>
        {item.name}
      </Text>
      <Text style={{ color: p.muted, fontSize: 11 }}>{subtitle}</Text>
    </Pressable>
  );
}

function PendingTile({ file, offline, onOpen }: { file: PendingFile; offline: boolean; onOpen: () => void }) {
  const p = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Otwórz „${file.name}”`} onPress={onOpen} style={[styles.tile, styles.pending, { borderColor: p.border }]}>
      <Thumb item={{ id: file.id, storagePath: null, mime: file.mime }} />
      <Text style={{ color: p.fg, fontSize: 12 }} numberOfLines={1}>
        {file.name}
      </Text>
      {file.failed ? (
        <View style={styles.failed}>
          <Text style={{ color: p.bad, fontSize: 11 }}>Nie wysłano</Text>
          <Text accessibilityRole="button" style={{ color: p.accent, fontSize: 11 }} onPress={() => void retryFile(file.id)}>
            ponów
          </Text>
          <Text accessibilityRole="button" style={{ color: p.accent, fontSize: 11 }} onPress={() => void discardFile(file.id)}>
            usuń
          </Text>
        </View>
      ) : (
        <Text style={{ color: p.muted, fontSize: 11 }}>{`${formatBytes(file.size)} · ${offline || file.attempts ? 'czeka na sieć' : 'wysyłanie…'}`}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 8 },
  title: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  action: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6 },
  linkRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  link: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 8, gap: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { width: '31%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 6, gap: 2 },
  pending: { borderStyle: 'dashed' },
  thumb: { width: '100%', height: 80, borderRadius: 6 },
  icon: { fontSize: 32, height: 80, textAlign: 'center', textAlignVertical: 'center' },
  failed: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  viewer: { flex: 1, backgroundColor: '#000000ee', justifyContent: 'center' },
  full: { width: '100%', height: '100%' },
});
