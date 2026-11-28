/**
 * Sekcja „Załączniki” na ekranie zadania (Etap 10, jak `AttachmentsField` na webie): zdjęcie z aparatu,
 * obrazy z galerii, dowolne pliki i linki. Pliki idą przez kolejkę (`lib/files.ts`) — offline czekają
 * z dopiskiem „czeka na sieć”. Podgląd: obrazy w aplikacji (pełny ekran), PDF i reszta w aplikacji
 * systemowej (`File.preview` → `ACTION_VIEW`). Menu kafelka (⋯ albo przytrzymanie) i przyciski podglądu: „Udostępnij”
 * (systemowy arkusz — też zapis do plików) i „Otwórz w innej aplikacji”. Link ma ikonę strony z podglądu i ✕;
 * plik, którego nie udało się wysłać, pokazuje przyczynę z kolejki.
 */
import { attachmentView, fileProblem, formatBytes, linkAttachmentOp, parseHttpUrl, plural, AttachmentPreview, type NewFile } from '@taskplanner/core';
import type { PendingFile, SqlRow } from '@taskplanner/sync';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { Image, Linking, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { sessionUser } from '@/lib/config';
import { addFile, discardFile, localFile, localUri, retryFile, shareableFile, usePendingFiles } from '@/lib/files';
import { useLocalQuery, useSyncStatus } from '@/lib/local-query';

import { useTaskActions } from './actions';
import { PanelSection } from './panel-section';
import { pickOption, type Option } from './pickers';
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
const pendingItem = (f: PendingFile): Shown => ({ id: f.id, storagePath: null, name: f.name, mime: f.mime });

/**
 * `readOnly` — przestrzeń udostępniona do podglądu: tylko otwieranie, bez dodawania i usuwania.
 * `summary` — podgląd zadania: same załączniki (bez przycisków dodawania i usuwania) bez własnej karty sekcji.
 */
export function AttachmentsField({ taskId, readOnly: locked = false, summary = false }: { taskId: string; readOnly?: boolean; summary?: boolean }) {
  const readOnly = locked || summary;
  const p = usePalette();
  const { run, notify } = useTaskActions();
  const items = useAttachments(taskId);
  const waiting = usePendingFiles().filter((f) => f.taskId === taskId && !items.some((i) => i.id === f.id));
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState('');
  const [image, setImage] = useState<{ uri: string; item: Shown } | null>(null);
  const insets = useSafeAreaInsets();
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
      if (attachmentView(item.mime) === 'image') setImage({ uri: file.uri, item });
      else await file.preview({ mimeType: item.mime ?? undefined, title: item.name });
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  };
  const share = async (item: Shown) => {
    try {
      const file = await shareableFile(item);
      await Sharing.shareAsync(file.uri, { mimeType: item.mime ?? undefined, dialogTitle: item.name });
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  };
  const openElsewhere = async (item: Shown) => {
    try {
      const file = await localFile(item);
      await file.preview({ mimeType: item.mime ?? undefined, title: item.name });
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  };
  const menu = async (item: Shown, onRemove?: () => void) => {
    const options: Option<'open' | 'share' | 'remove'>[] = [
      { label: 'Otwórz', value: 'open' },
      { label: 'Udostępnij / zapisz…', value: 'share' },
      ...(onRemove ? [{ label: 'Usuń', value: 'remove' as const, tone: 'bad' as const }] : []),
    ];
    const choice = await pickOption(item.name, options);
    if (choice === 'open') await open(item);
    else if (choice === 'share') await share(item);
    else if (choice === 'remove') onRemove?.();
  };

  const links = items.filter((a) => a.kind === 'link');
  const files = items.filter((a) => a.kind === 'file');
  const count = items.length + waiting.length;

  const content = (
    <>
      {summary ? null : (
      <View style={styles.actions}>
        <Action label="📷 Aparat" disabled={readOnly} onPress={() => void camera()} />
        <Action label="🖼 Galeria" disabled={readOnly} onPress={() => void gallery()} />
        <Action label="📎 Plik" disabled={readOnly} onPress={() => void document()} />
        <Action label="🔗 Link" disabled={readOnly} onPress={() => setLinking((v) => !v)} />
      </View>
      )}
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
        <LinkRow key={a.id} item={a} onRemove={readOnly ? undefined : () => remove(a)} />
      ))}

      {files.length || waiting.length ? (
        <View style={styles.grid}>
          {files.map((a) => (
            <Tile key={a.id} item={a} subtitle={a.size !== null ? formatBytes(a.size) : ''} onOpen={() => void open(a)} onMenu={() => void menu(a, readOnly ? undefined : () => remove(a))} />
          ))}
          {waiting.map((f) => (
            <PendingTile key={f.id} file={f} offline={offline} onOpen={() => void open(pendingItem(f))} onMenu={() => void menu(pendingItem(f))} />
          ))}
        </View>
      ) : null}

      {!count && !linking && !summary ? <Text style={{ color: p.muted, fontSize: 12 }}>{readOnly ? 'Brak załączników.' : 'Zdjęcie, plik do 25 MB albo link.'}</Text> : null}

      <Modal visible={!!image} transparent animationType="fade" onRequestClose={() => setImage(null)}>
        <Pressable accessibilityLabel="Zamknij podgląd" style={styles.viewer} onPress={() => setImage(null)}>
          {image ? <Image source={{ uri: image.uri }} style={styles.full} resizeMode="contain" /> : null}
        </Pressable>
        {image ? (
          <View style={[styles.viewerBar, { paddingBottom: insets.bottom + 12 }]}>
            <ViewerButton label="Udostępnij / zapisz" onPress={() => void share(image.item)} />
            <ViewerButton label="Otwórz w…" onPress={() => void openElsewhere(image.item)} />
            <ViewerButton label="Zamknij" onPress={() => setImage(null)} />
          </View>
        ) : null}
      </Modal>
    </>
  );
  if (summary) return <View style={styles.summary}>{content}</View>;
  return (
    <PanelSection id="attachments" title="Załączniki" count={count || undefined}>
      {content}
    </PanelSection>
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
      <Text style={{ color: primary ? p.onAccent : p.fg, fontSize: 13, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

function ViewerButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.viewerButton, { opacity: pressed ? 0.6 : 1 }]}>
      <Text style={styles.viewerText}>{label}</Text>
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

/** Ikona strony z podglądu linku (`preview.icon`); bez niej albo po błędzie wczytania — 🔗. */
function SiteIcon({ uri }: { uri?: string }) {
  const [broken, setBroken] = useState(false);
  if (!uri || broken) return <Text style={styles.siteIconText}>🔗</Text>;
  return <Image source={{ uri }} style={styles.siteIcon} resizeMode="contain" accessibilityIgnoresInvertColors onError={() => setBroken(true)} />;
}

/** Link: dotknięcie otwiera stronę, ✕ usuwa (z „Cofnij”); w podglądzie bez ✕. */
function LinkRow({ item, onRemove }: { item: Attachment; onRemove?: () => void }) {
  const p = usePalette();
  const preview = item.preview;
  return (
    <View style={[styles.link, { borderColor: p.border }]}>
      <SiteIcon key={preview?.icon} uri={preview?.icon} />
      <Pressable accessibilityRole="link" accessibilityLabel={`Otwórz „${item.name}”`} onPress={() => item.url && void Linking.openURL(item.url)} style={styles.linkText}>
        <Text style={{ color: p.fg }} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={1}>
          {preview === null ? 'Pobieranie podglądu…' : [preview.siteName, preview.description].filter(Boolean).join(' · ') || item.url}
        </Text>
      </Pressable>
      {onRemove ? <CornerButton label="✕" accessibilityLabel={`Usuń „${item.name}”`} onPress={onRemove} /> : null}
    </View>
  );
}

/** Widoczny przycisk na kafelku / wierszu (✕ albo ⋯) — zamiast samego przytrzymania. */
function CornerButton({ label, accessibilityLabel, onPress }: { label: string; accessibilityLabel: string; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} hitSlop={8} onPress={onPress} style={({ pressed }) => [styles.corner, { backgroundColor: p.card, borderColor: p.border, opacity: pressed ? 0.6 : 1 }]}>
      <Text style={{ color: p.muted, fontSize: 13, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

function Tile({ item, subtitle, onOpen, onMenu }: { item: Attachment; subtitle: string; onOpen: () => void; onMenu: () => void }) {
  const p = usePalette();
  return (
    <View style={[styles.tile, { borderColor: p.border }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Otwórz „${item.name}”`} onPress={onOpen} onLongPress={onMenu} style={styles.tileBody}>
        <Thumb item={item} />
        <Text style={{ color: p.fg, fontSize: 12 }} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={{ color: p.muted, fontSize: 11 }}>{subtitle}</Text>
      </Pressable>
      <View style={styles.cornerWrap}>
        <CornerButton label="⋯" accessibilityLabel={`Menu „${item.name}”`} onPress={onMenu} />
      </View>
    </View>
  );
}

/** Plik w kolejce; po nieudanej próbie widać przyczynę z kolejki (`PendingFile.error`). */
function PendingTile({ file, offline, onOpen, onMenu }: { file: PendingFile; offline: boolean; onOpen: () => void; onMenu: () => void }) {
  const p = usePalette();
  return (
    <View style={[styles.tile, styles.pending, { borderColor: p.border }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Otwórz „${file.name}”`} onPress={onOpen} onLongPress={onMenu} style={styles.tileBody}>
        <Thumb item={{ id: file.id, storagePath: null, mime: file.mime }} />
        <Text style={{ color: p.fg, fontSize: 12 }} numberOfLines={1}>
          {file.name}
        </Text>
        {file.failed ? null : <Text style={{ color: p.muted, fontSize: 11 }}>{`${formatBytes(file.size)} · ${offline || file.attempts ? 'czeka na sieć' : 'wysyłanie…'}`}</Text>}
      </Pressable>
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
      ) : null}
      {file.error && (file.failed || file.attempts) ? (
        <Text style={{ color: file.failed ? p.bad : p.muted, fontSize: 11 }} numberOfLines={4}>
          {file.error}
        </Text>
      ) : null}
      <View style={styles.cornerWrap}>
        <CornerButton label="⋯" accessibilityLabel={`Menu „${file.name}”`} onPress={onMenu} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  summary: { gap: 8 },
  action: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6 },
  linkRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  link: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 8, gap: 8 },
  linkText: { flex: 1, minWidth: 0, gap: 2 },
  siteIcon: { width: 16, height: 16 },
  siteIconText: { fontSize: 14, width: 18, textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { width: '31%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 6, gap: 2 },
  tileBody: { gap: 2 },
  cornerWrap: { position: 'absolute', top: 4, right: 4 },
  corner: { minWidth: 24, height: 24, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  pending: { borderStyle: 'dashed' },
  thumb: { width: '100%', height: 80, borderRadius: 6 },
  icon: { fontSize: 32, height: 80, textAlign: 'center', textAlignVertical: 'center' },
  failed: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  viewer: { flex: 1, backgroundColor: '#000000ee', justifyContent: 'center' },
  full: { width: '100%', height: '100%' },
  viewerBar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, paddingTop: 12 },
  viewerButton: { borderWidth: 1, borderColor: '#ffffff88', backgroundColor: '#00000088', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  viewerText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
