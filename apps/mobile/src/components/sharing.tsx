/**
 * Współdzielenie przestrzeni (v1.x) na telefonie: pasek zaproszeń nad Dziś / Inboxem
 * (`ScopeInvitesBanner`) i sekcja „Osoby” na ekranie przestrzeni (`SharingSection`: członkowie,
 * zaproszenie z rolą i linkiem przez systemowe „Udostępnij”, cofanie, zmiana roli, usuwanie,
 * „Opuść przestrzeń”). Wymaga sieci. Odpowiednik webowego `components/app/sharing.tsx`.
 */
import { inviteLink, SCOPE_ROLE, SCOPE_ROLE_HINT, shareEmail, WORKSPACE_SHARE_NOTE, type ShareRole } from '@taskplanner/core';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { sessionUser, webAppUrl } from '@/lib/config';
import {
  answerScopeInvite,
  removeMember,
  revokeInvite,
  setMemberRole,
  shareWorkspace,
  useScopeInvites,
  workspaceSharing,
  type MyInvite,
  type PendingInvite,
  type WorkspaceSharing,
} from '@/lib/sharing';

import { Button, Chip, Field, P, Row, Section, usePalette } from './ui';

const ROLES: ShareRole[] = ['editor', 'viewer'];
const date = (iso: string) => new Date(iso).toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric', year: 'numeric' });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function shareInvite(workspace: string, invite: { email: string; token: string }) {
  const web = webAppUrl();
  const text = `Zapraszam Cię do przestrzeni „${workspace}” w Task Plannerze. Zaloguj się adresem ${invite.email} — zaproszenie czeka w aplikacji${web ? `, albo otwórz link: ${inviteLink(web, invite.token)}` : ''}.`;
  void Share.share({ message: text });
}

/** Zaproszenia do zalogowanego — „Przyjmij” / „Odrzuć”. Nic, gdy ich nie ma. */
export function ScopeInvitesBanner() {
  const p = usePalette();
  const invites = useScopeInvites();
  const [busy, setBusy] = useState(false);
  if (!invites.length || !sessionUser().online) return null;

  const answer = (invite: MyInvite, accept: boolean) => {
    setBusy(true);
    answerScopeInvite(invite, accept)
      .then(() => accept && Alert.alert('Dołączono', `Przestrzeń „${invite.workspace}” pobiera się na telefon.`))
      .catch((e: unknown) => Alert.alert('Zaproszenie', message(e)))
      .finally(() => setBusy(false));
  };

  return (
    <View style={[styles.banner, { backgroundColor: p.selected }]}>
      {invites.map((i) => (
        <View key={i.id} style={styles.invite}>
          <Text style={{ color: p.fg, fontSize: 13 }}>
            Zaproszenie do przestrzeni <Text style={{ fontWeight: '600' }}>„{i.workspace}”</Text>
            {i.invitedBy ? ` od ${i.invitedBy}` : ''} — {SCOPE_ROLE[i.role].toLowerCase()} ({SCOPE_ROLE_HINT[i.role]})
          </Text>
          <Row>
            <Button title="Przyjmij" disabled={busy} onPress={() => answer(i, true)} />
            <Button title="Odrzuć" kind="secondary" disabled={busy} onPress={() => answer(i, false)} />
          </Row>
        </View>
      ))}
    </View>
  );
}

/** Członkowie przestrzeni i zaproszenia (właściciel) albo „Opuść przestrzeń” (pozostali). */
export function SharingSection({ workspaceId, name }: { workspaceId: string; name: string }) {
  const p = usePalette();
  const [sharing, setSharing] = useState<WorkspaceSharing | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ShareRole>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = sessionUser().online;

  const load = useCallback(async () => {
    try {
      setSharing(await workspaceSharing(workspaceId));
      setError(null);
    } catch (e) {
      setError(`Osoby w przestrzeni wczytają się przy połączeniu z serwerem (${message(e)}).`);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (online) void Promise.resolve().then(load);
  }, [load, online]);

  if (!online) return null;

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(message(e));
    }
    await load();
    setBusy(false);
  };

  const owner = sharing?.role === 'owner';
  const normalized = shareEmail(email);

  const invite = () => {
    if (!normalized) return;
    void act(async () => {
      const { token } = await shareWorkspace(workspaceId, normalized, role);
      setEmail('');
      shareInvite(name, { email: normalized, token });
    });
  };

  const memberMenu = (member: WorkspaceSharing['members'][number]) =>
    Alert.alert(member.email, `Rola: ${SCOPE_ROLE[member.role]}`, [
      ...ROLES.filter((r) => r !== member.role).map((r) => ({ text: `Zmień na: ${SCOPE_ROLE[r]}`, onPress: () => void act(() => setMemberRole(workspaceId, member.userId, r)) })),
      { text: 'Usuń z przestrzeni', style: 'destructive' as const, onPress: () => void act(() => removeMember(workspaceId, member.userId)) },
      { text: 'Anuluj', style: 'cancel' as const },
    ]);

  const inviteMenu = (i: PendingInvite) =>
    Alert.alert(i.email, i.expired ? 'Zaproszenie wygasło.' : `Ważne do ${date(i.expiresAt)}.`, [
      ...(i.expired ? [] : [{ text: 'Wyślij link', onPress: () => shareInvite(name, i) }]),
      { text: 'Cofnij zaproszenie', style: 'destructive' as const, onPress: () => void act(() => revokeInvite(i.id)) },
      { text: 'Anuluj', style: 'cancel' as const },
    ]);

  const leave = () =>
    Alert.alert('Opuścić przestrzeń?', `Zadania z „${name}” znikną z Twoich urządzeń; wrócisz tylko z nowym zaproszeniem.`, [
      { text: 'Anuluj', style: 'cancel' },
      {
        text: 'Opuść',
        style: 'destructive',
        onPress: () =>
          void act(async () => {
            const me = sharing?.members.find((m) => m.me);
            if (me) await removeMember(workspaceId, me.userId, true);
            router.back();
          }),
      },
    ]);

  return (
    <Section title="Osoby">
      {sharing?.members.map((m) => (
        <Pressable key={m.userId} disabled={!owner || m.role === 'owner' || busy} onPress={() => memberMenu(m)} style={[styles.row, { borderTopColor: p.border }]}>
          <Text style={{ color: p.fg, flex: 1 }} numberOfLines={1}>
            {m.email}
            {m.me ? <Text style={{ color: p.muted }}> (Ty)</Text> : null}
          </Text>
          <Text style={{ color: p.muted, fontSize: 12 }}>{SCOPE_ROLE[m.role]}</Text>
        </Pressable>
      ))}
      {sharing?.invites.map((i) => (
        <Pressable key={i.id} disabled={busy} onPress={() => inviteMenu(i)} style={[styles.row, { borderTopColor: p.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: p.fg }} numberOfLines={1}>
              {i.email}
            </Text>
            <Text style={{ color: p.muted, fontSize: 12 }}>{i.expired ? 'zaproszenie wygasło' : `czeka od ${date(i.createdAt)}`}</Text>
          </View>
          <Text style={{ color: p.muted, fontSize: 12 }}>{SCOPE_ROLE[i.role]}</Text>
        </Pressable>
      ))}
      {owner ? (
        <>
          <P muted>{WORKSPACE_SHARE_NOTE}</P>
          <Field label="Adres e-mail" value={email} onChangeText={setEmail} placeholder="adres@example.com" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
          <Row>
            {ROLES.map((r) => (
              <Chip key={r} label={SCOPE_ROLE[r]} selected={role === r} onPress={() => setRole(r)} />
            ))}
          </Row>
          <P muted>
            {SCOPE_ROLE[role]} — {SCOPE_ROLE_HINT[role]}.
          </P>
          <Button title="Zaproś" disabled={busy || !normalized} onPress={invite} />
        </>
      ) : sharing ? (
        <>
          <P muted>
            Twoja rola: {SCOPE_ROLE[sharing.role]}
            {sharing.role === 'viewer' ? ' — możesz tylko przeglądać zadania.' : '.'}
          </P>
          <Button title="Opuść przestrzeń" kind="danger" disabled={busy} onPress={leave} />
        </>
      ) : null}
      {error ? <P tone="bad">{error}</P> : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  banner: { marginHorizontal: 12, marginTop: 10, borderRadius: 10, padding: 10, gap: 10 },
  invite: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
});
