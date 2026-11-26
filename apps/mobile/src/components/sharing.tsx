/**
 * Współdzielenie przestrzeni (v1.x) na telefonie: pasek zaproszeń nad Dziś / Inboxem
 * i propozycji roli właściciela (`ScopeInvitesBanner`) i sekcja „Osoby” na ekranie przestrzeni (`SharingSection`: członkowie,
 * zaproszenie z rolą i linkiem przez systemowe „Udostępnij”, cofanie, zmiana roli, usuwanie,
 * przekazanie przestrzeni za zgodą drugiej osoby, „Opuść przestrzeń”). Wymaga sieci. Odpowiednik webowego `components/app/sharing.tsx`.
 */
import {
  canManageMember,
  inviteLink,
  memberRoleLabel,
  memberSince,
  OWNER_AFTER,
  OWNER_OFFER_NOTE,
  ownerOfferQuestion,
  ownerResignQuestion,
  ownershipAcceptQuestion,
  ownershipHeirs,
  ownershipOfferText,
  SCOPE_ROLE,
  SCOPE_ROLE_HINT,
  shareEmail,
  WORKSPACE_SHARE_NOTE,
  type OwnerAfter,
  type OwnershipOffer,
  type ShareRole,
  type SpaceMember,
} from '@taskplanner/core';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { sessionUser, webAppUrl } from '@/lib/config';
import {
  answerOwnershipOffer,
  answerScopeInvite,
  cancelOwnershipOffer,
  offerOwnership,
  removeMember,
  resignOwner,
  revokeInvite,
  setMemberRole,
  shareWorkspace,
  useOwnershipOffers,
  useScopeInvites,
  workspaceSharing,
  type MyInvite,
  type PendingInvite,
  type PendingOwnerOffer,
  type WorkspaceSharing,
} from '@/lib/sharing';

import { pickOption } from './pickers';
import { Button, Chip, Field, P, Row, Section, usePalette } from './ui';

const ROLES: ShareRole[] = ['editor', 'viewer'];
const AFTER: OwnerAfter[] = ['editor', 'viewer', 'leave'];
const date = (iso: string) => new Date(iso).toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric', year: 'numeric' });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function shareInvite(workspace: string, invite: { email: string; token: string }) {
  const web = webAppUrl();
  const text = `Zapraszam Cię do przestrzeni „${workspace}” w Task Plannerze. Zaloguj się adresem ${invite.email} — zaproszenie czeka w aplikacji${web ? `, albo otwórz link: ${inviteLink(web, invite.token)}` : ''}.`;
  void Share.share({ message: text });
}

/** Pytanie z przyciskiem wykonania (`destructive` — czerwony). */
const confirm = (title: string, text: string, action: string, onYes: () => void, destructive = false) =>
  Alert.alert(title, text, [
    { text: 'Anuluj', style: 'cancel' },
    { text: action, style: destructive ? 'destructive' : 'default', onPress: onYes },
  ]);

/** Zaproszenia i propozycje własności do zalogowanego — przyjęcie / odmowa. Nic, gdy ich nie ma. */
export function ScopeInvitesBanner() {
  const p = usePalette();
  const invites = useScopeInvites();
  const offers = useOwnershipOffers();
  const [busy, setBusy] = useState(false);
  if ((!invites.length && !offers.length) || !sessionUser().online) return null;

  const answer = (invite: MyInvite, accept: boolean) => {
    setBusy(true);
    answerScopeInvite(invite, accept)
      .then(() => accept && Alert.alert('Dołączono', `Przestrzeń „${invite.workspace}” pobiera się na telefon.`))
      .catch((e: unknown) => Alert.alert('Zaproszenie', message(e)))
      .finally(() => setBusy(false));
  };

  const answerOffer = (offer: OwnershipOffer, accept: boolean) => {
    setBusy(true);
    answerOwnershipOffer(offer, accept)
      .then(() => accept && Alert.alert('Przyjęto', `Jesteś teraz właścicielem przestrzeni „${offer.workspace}”.`))
      .catch((e: unknown) => Alert.alert('Rola właściciela', message(e)))
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
      {offers.map((o) => (
        <View key={o.id} style={styles.invite}>
          <Text style={{ color: p.fg, fontSize: 13 }}>{ownershipOfferText(o)}</Text>
          <Row>
            <Button
              title={o.after ? 'Przejmij…' : 'Przyjmij…'}
              disabled={busy}
              onPress={() => confirm('Potwierdź przejęcie', ownershipAcceptQuestion(o), o.after ? 'Przejmij' : 'Przyjmij', () => answerOffer(o, true))}
            />
            <Button title="Odmów" kind="secondary" disabled={busy} onPress={() => answerOffer(o, false)} />
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
  const me = sharing?.members.find((m) => m.me);
  const offers = sharing?.offers ?? [];
  const normalized = shareEmail(email);

  const invite = () => {
    if (!normalized) return;
    void act(async () => {
      const { token } = await shareWorkspace(workspaceId, normalized, role);
      setEmail('');
      shareInvite(name, { email: normalized, token });
    });
  };

  const propose = (member: SpaceMember, after: OwnerAfter | null) =>
    confirm(after ? 'Przekazać przestrzeń?' : 'Rola właściciela', ownerOfferQuestion(member.email, name, after), 'Wyślij propozycję', () =>
      void act(async () => {
        await offerOwnership(workspaceId, member.userId, after);
        Alert.alert('Wysłano', `Propozycja czeka w aplikacji: ${member.email}. Zadziała, gdy ta osoba ją potwierdzi.`);
      }),
    );

  const memberMenu = async (member: SpaceMember) => {
    const choice = await pickOption<ShareRole | 'owner' | 'remove'>(`${member.email} — ${memberRoleLabel(member, sharing?.members ?? []).toLowerCase()}`, [
      ...(member.role === 'owner' ? [] : [{ label: 'Zaproponuj rolę właściciela…', value: 'owner' as const, hint: 'po zgodzie tej osoby' }]),
      ...ROLES.filter((r) => r !== member.role).map((r) => ({ label: `Zmień na: ${SCOPE_ROLE[r]}`, value: r, hint: SCOPE_ROLE_HINT[r] })),
      { label: 'Usuń z przestrzeni', value: 'remove' as const, tone: 'bad' as const },
    ]);
    if (!choice) return;
    if (choice === 'owner') propose(member, null);
    else if (choice === 'remove') confirm('Usunąć z przestrzeni?', `Dane „${name}” znikną z urządzeń: ${member.email}.`, 'Usuń', () => void act(() => removeMember(workspaceId, member.userId)), true);
    else if (member.role === 'owner') confirm('Odebrać rolę właściciela?', `${member.email} zostanie z rolą ${SCOPE_ROLE[choice]}.`, 'Odbierz', () => void act(() => setMemberRole(workspaceId, member.userId, choice)), true);
    else void act(() => setMemberRole(workspaceId, member.userId, choice));
  };

  const offerMenu = (o: PendingOwnerOffer) =>
    Alert.alert(o.email, `${o.after ? 'Przekazanie przestrzeni' : 'Rola właściciela'} — ${o.expired ? 'propozycja wygasła' : `czeka na zgodę do ${date(o.expiresAt)}`}.`, [
      { text: 'Wycofaj propozycję', style: 'destructive', onPress: () => void act(() => cancelOwnershipOffer(o.id)) },
      { text: 'Zamknij', style: 'cancel' },
    ]);

  /** Zrzeczenie się roli: następca (główny właściciel musi go wskazać), potem własna rola po przekazaniu. */
  const handOver = async () => {
    if (!sharing || !me) return;
    const heir = await pickOption<string>('Kto przejmuje przestrzeń?', [
      ...ownershipHeirs(sharing.members).map((m) => ({ label: m.email, value: m.userId, hint: memberRoleLabel(m, sharing.members).toLowerCase() })),
      ...(me.primary ? [] : [{ label: 'Bez następcy', value: '', hint: 'zostaje główny właściciel' }]),
    ]);
    if (heir === undefined) return;
    const after = await pickOption<OwnerAfter>('Twoja rola potem', AFTER.map((a) => ({ label: OWNER_AFTER[a], value: a, hint: a === 'leave' ? undefined : SCOPE_ROLE_HINT[a], tone: a === 'leave' ? ('bad' as const) : undefined })));
    if (!after) return;
    const member = sharing.members.find((m) => m.userId === heir);
    if (member) return propose(member, after);
    confirm('Zrzec się roli właściciela?', ownerResignQuestion(name, after), 'Zrzeknij się', () =>
      void act(async () => {
        await resignOwner(workspaceId, after);
        if (after === 'leave') router.back();
      }), true);
  };

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
            if (me) await removeMember(workspaceId, me.userId, true);
            router.back();
          }),
      },
    ]);

  return (
    <Section title="Osoby">
      {sharing?.members.map((m) => (
        <Pressable key={m.userId} disabled={!canManageMember(me, m) || busy} onPress={() => void memberMenu(m)} style={[styles.row, { borderTopColor: p.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: p.fg }} numberOfLines={1}>
              {m.email}
              {m.me ? <Text style={{ color: p.muted }}> (Ty)</Text> : null}
            </Text>
            {memberSince(m.joinedAt) ? <Text style={{ color: p.muted, fontSize: 12 }}>{memberSince(m.joinedAt)}</Text> : null}
          </View>
          <Text style={{ color: p.muted, fontSize: 12 }}>{memberRoleLabel(m, sharing.members)}</Text>
        </Pressable>
      ))}
      {offers.map((o) => (
        <Pressable key={o.id} disabled={!owner || !(o.mine || me?.primary) || busy} onPress={() => offerMenu(o)} style={[styles.row, { borderTopColor: p.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: p.fg }} numberOfLines={1}>
              {o.email}
            </Text>
            <Text style={{ color: p.muted, fontSize: 12 }}>{o.expired ? 'propozycja wygasła' : `czeka na zgodę do ${date(o.expiresAt)}`}</Text>
          </View>
          <Text style={{ color: p.muted, fontSize: 12 }}>{o.after ? 'Przekazanie' : 'Właściciel'}</Text>
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
          {sharing.members.length > 1 ? (
            <>
              <P muted>{OWNER_OFFER_NOTE}</P>
              <Button title={me?.primary ? 'Przekaż przestrzeń…' : 'Zrzeknij się roli właściciela…'} kind="secondary" disabled={busy} onPress={() => void handOver()} />
            </>
          ) : null}
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
