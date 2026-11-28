/**
 * „Zaproszenia” w „Ustawieniach” (v1.x): lista adresów i domen, z których można założyć
 * konto (`allowed_emails`). Widoczna tylko dla administratora (`is_app_admin()`); czyta i zmienia
 * listę przez RPC na serwerze (`list_invites` / `add_invite` / `remove_invite`) — wymaga sieci.
 * Odpowiednik webowego `invites-card.tsx`.
 */
import { invitePattern, isDomainInvite, plural } from '@taskplanner/core';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { sessionUser } from '@/lib/config';
import { supabaseClient } from '@/lib/sync';

import { Button, Field, P, Section, usePalette } from './ui';

interface Invite {
  pattern: string;
  note: string | null;
  created_at: string;
  accounts: number;
}

const date = (iso: string) => new Date(iso).toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric', year: 'numeric' });

export function InvitesSection() {
  const p = usePalette();
  const [admin, setAdmin] = useState(false);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [pattern, setPattern] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabaseClient().rpc('list_invites');
    if (e) setError(`Nie udało się wczytać listy: ${e.message}`);
    else {
      setError(null);
      setInvites(data as Invite[]);
    }
  }, []);

  useEffect(() => {
    if (!sessionUser().online) return;
    let alive = true;
    void supabaseClient()
      .rpc('is_app_admin')
      .then(({ data }) => {
        if (!alive || data !== true) return;
        setAdmin(true);
        void load();
      });
    return () => {
      alive = false;
    };
  }, [load]);

  if (!admin) return null;

  const normalized = invitePattern(pattern);

  const act = async (work: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true);
    setError(null);
    const { error: e } = await work();
    if (e) setError(e.message);
    await load();
    setBusy(false);
  };

  const add = () => {
    if (!normalized) return;
    void act(async () => {
      const result = await supabaseClient().rpc('add_invite', { p_pattern: normalized, p_note: note.trim() || null });
      if (!result.error) {
        setPattern('');
        setNote('');
      }
      return result;
    });
  };

  const remove = (invite: Invite) => {
    const extra = invite.accounts ? ` ${plural(invite.accounts, ['założone konto', 'założone konta', 'założonych kont'])} zostanie — usuwa się je osobno.` : '';
    Alert.alert('Usunąć zaproszenie?', `${invite.pattern}${extra}`, [
      { text: 'Anuluj', style: 'cancel' },
      { text: 'Usuń', style: 'destructive', onPress: () => void act(() => supabaseClient().rpc('remove_invite', { p_pattern: invite.pattern })) },
    ]);
  };

  return (
    <Section title="Zaproszenia">
      <P muted>
        Konto może założyć tylko adres z tej listy albo dowolny adres z wpisanej domeny („@firma.pl”, bez subdomen). Usunięcie z listy nie usuwa konta, które już
        powstało. Widzisz tę sekcję jako administrator.
      </P>
      <Field label="Adres albo domena" value={pattern} onChangeText={setPattern} placeholder="jan@example.com albo @firma.pl" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
      {pattern.trim() && !normalized ? <P tone="bad">Wpisz adres e-mail albo domenę z „@” na początku.</P> : null}
      <Field label="Notatka (opcjonalnie)" value={note} onChangeText={setNote} maxLength={200} />
      <Button title="Zaproś" disabled={busy || !normalized} onPress={add} />
      {invites === null ? null : invites.length === 0 ? (
        <P muted>Lista jest pusta — nikt nowy nie założy konta.</P>
      ) : (
        <View>
          {invites.map((invite) => (
            <View key={invite.pattern} style={[styles.row, { borderTopColor: p.border }]}>
              <View style={styles.text}>
                <Text style={[styles.pattern, { color: p.fg }]} numberOfLines={1}>
                  {invite.pattern}
                  {isDomainInvite(invite.pattern) ? <Text style={{ color: p.muted, fontWeight: '400' }}> · cała domena</Text> : null}
                </Text>
                <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={1}>
                  {[invite.note, `od ${date(invite.created_at)}`, invite.accounts ? plural(invite.accounts, ['konto', 'konta', 'kont']) : 'bez konta'].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`Usuń ${invite.pattern}`} disabled={busy} onPress={() => remove(invite)} hitSlop={8}>
                <Text style={{ color: p.bad }}>Usuń</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
      {error ? <P tone="bad">{error}</P> : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  text: { flex: 1, minWidth: 0 },
  pattern: { fontWeight: '600' },
});
