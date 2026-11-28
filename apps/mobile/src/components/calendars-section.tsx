/**
 * Ustawienia → „Kalendarze” (M18) na telefonie: konta Google / ICS ze stanem, czasem ostatniej
 * synchronizacji i błędem, kalendarze z przełącznikiem widoczności (`calendar-sync` `calendars/update`, jak web)
 * i „Odśwież” (`accounts/sync`). Podłączanie (OAuth Google, adres ICS), odłączanie i wybór przestrzeni dla
 * „Zadania z godziną → Google” zostają na webie — tu tylko ich stan. Kalendarze z telefonu wybiera się
 * w Kalendarzu („📱”).
 */
import { CALENDAR_ACCOUNT_STATUS, localDateAt, localDateTimeAt, relativeDay } from '@taskplanner/core';
import { useState } from 'react';
import { Switch, Text, View } from 'react-native';

import { useView } from '@/lib/app-data';
import { setCalendarVisible, syncCalendarAccount, useCalendarAccounts, type CalendarAccount, type ServerCalendar } from '@/lib/calendars';
import { sessionUser } from '@/lib/config';

import { Button, ColorDot, P, Section, usePalette } from './ui';

type Message = { tone: 'ok' | 'bad'; text: string } | null;

export function CalendarsSection() {
  const state = useCalendarAccounts();
  const { data } = useView();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  if (!state) return null;
  const online = sessionUser().online;
  const timeZone = data.settings.timeZone;

  const act = (work: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMessage(null);
    work()
      .then(() => ok && setMessage({ tone: 'ok', text: ok }))
      .catch((e: unknown) => setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(false));
  };

  const synced = (at: string | null) => {
    if (!at) return 'jeszcze nie';
    return `${relativeDay(localDateAt(at, timeZone), localDateAt(new Date(), timeZone))} ${localDateTimeAt(at, timeZone).slice(11)}`;
  };
  const workspaceName = (id: string) => data.workspaces.find((w) => w.id === id)?.name;

  return (
    <Section title="Kalendarze">
      <P muted>
        Spotkania z kalendarzy z serwera widać w Kalendarzu i „Planie dnia” (tylko do odczytu); odświeżają się same co kilka minut. Konto Google albo adres ICS podłączysz
        i odłączysz na webie (Ustawienia → „Kalendarze”).
      </P>
      {message ? <P tone={message.tone}>{message.text}</P> : null}
      {!state.accounts.length ? <P muted>Brak połączonych kalendarzy.</P> : null}
      {state.accounts.map((a) => (
        <Account
          key={a.id}
          account={a}
          calendars={state.calendars.filter((c) => c.accountId === a.id)}
          synced={synced(a.lastSyncedAt)}
          taskTarget={
            a.provider === 'google' && state.taskSync?.accountId === a.id && state.taskSync.workspaceIds.length
              ? state.taskSync.workspaceIds.map((id) => workspaceName(id) ?? '?').join(', ')
              : null
          }
          busy={busy || !online}
          onVisible={(c, visible) => act(() => setCalendarVisible(c.id, visible))}
          onSync={() => act(() => syncCalendarAccount(a.id), 'Odświeżono.')}
        />
      ))}
      {state.accounts.length && !online ? <P muted>Widoczność i odświeżenie zmienisz po zalogowaniu, z siecią.</P> : null}
    </Section>
  );
}

function Account({
  account: a,
  calendars,
  synced,
  taskTarget,
  busy,
  onVisible,
  onSync,
}: {
  account: CalendarAccount;
  calendars: ServerCalendar[];
  synced: string;
  /** Przestrzenie, których zadania z godziną idą do kalendarza „Task Planner” na tym koncie (`null` = wyłączone). */
  taskTarget: string | null;
  busy: boolean;
  onVisible: (calendar: ServerCalendar, visible: boolean) => void;
  onSync: () => void;
}) {
  const p = usePalette();
  const target = calendars.find((c) => c.isTaskTarget);
  return (
    <View style={{ gap: 4, borderTopWidth: 1, borderTopColor: p.border, paddingTop: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ flex: 1, color: p.fg }}>
          {a.label}
          <Text style={{ color: p.muted, fontSize: 13 }}>
            {`\n${a.provider === 'google' ? 'Google' : 'ICS'} · ${CALENDAR_ACCOUNT_STATUS[a.status as keyof typeof CALENDAR_ACCOUNT_STATUS] ?? a.status} · synchronizacja: ${synced}`}
          </Text>
        </Text>
        <Button kind="secondary" title="Odśwież" disabled={busy || a.status === 'revoked'} onPress={onSync} />
      </View>
      {a.lastError ? <P tone="bad">{a.lastError}</P> : null}
      {calendars
        .filter((c) => !c.isTaskTarget)
        .map((c) => (
          <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8 }}>
            <ColorDot color={c.color} />
            <Text style={{ flex: 1, color: p.fg }} numberOfLines={1}>
              {c.name}
              <Text style={{ color: p.muted, fontSize: 13 }}>{c.visible ? ` · ${c.events} wyd.` : ' · ukryty'}</Text>
            </Text>
            <Switch accessibilityLabel={`Kalendarz „${c.name}” widoczny`} value={c.visible} disabled={busy} onValueChange={(on) => onVisible(c, on)} />
          </View>
        ))}
      {a.provider === 'google' ? (
        <P muted>
          {taskTarget
            ? `Zadania z godziną → Google: ${target ? `do „${target.name}”` : a.lastError ? 'czeka na zgodę na zapis' : 'kalendarz „Task Planner” powstanie przy synchronizacji'} (${taskTarget}).`
            : 'Zadania z godziną → Google: wyłączone.'}
          {' Przestrzenie wybierasz na webie.'}
        </P>
      ) : null}
    </View>
  );
}
