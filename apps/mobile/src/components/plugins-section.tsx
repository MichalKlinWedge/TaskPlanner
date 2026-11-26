/**
 * Ustawienia → „Integracje” (M21) na telefonie: połączenia (tylko podgląd stanu), reguły z przełącznikiem
 * wł. / wył. (zapis lokalny — działa offline, wychodzi synchronizacją) i ostatnie wysyłki z wynikiem
 * i „Ponów” (serwer, `plugin_deliveries` / RPC `retry_plugin_delivery`). Połączeń (sekrety) i treści reguł
 * telefon celowo nie zmienia — to zostaje na webie (Ustawienia → „Integracje”).
 */
import { afterSendSummary, canRetryDelivery, DELIVERY_STATUS, PLUGIN_CONNECTION_STATUS, pluginDef, pluginRuleEnableOps, pluginTriggerSummary, type PluginConnection, type PluginRule } from '@taskplanner/core';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Switch, Text, View } from 'react-native';

import { useView } from '@/lib/app-data';
import { sessionUser } from '@/lib/config';
import { recentDeliveries, retryPluginDelivery, usePlugins, type DeliveryRow } from '@/lib/plugins';
import { mutateMany } from '@/lib/sync';

import { Button, P, Row, Section, usePalette } from './ui';

/** Ile ostatnich wysyłek (jak w Ustawieniach webu; całość z filtrami — web `#/deliveries`). */
const RECENT_DELIVERIES = 10;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (iso: string) => new Date(iso).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

export function PluginsSection() {
  const plugins = usePlugins();
  const [message, setMessage] = useState<string | null>(null);
  if (!plugins) return null;
  const { connections, rules } = plugins;
  return (
    <Section title="Integracje">
      <P muted>
        Wysyłka zadań do innych usług (webhook, GitLab). Połączenia i reguły dodaje się i edytuje na webie (Ustawienia → „Integracje”); tu włączysz albo wyłączysz regułę i zobaczysz,
        co wyszło. Regułę ręczną wybierasz przy zadaniu („Wyślij do…”).
      </P>
      {!connections.length && !rules.length ? <P muted>Brak integracji.</P> : null}
      {connections.length ? <Connections connections={connections} /> : null}
      {rules.length ? <Rules rules={rules} connections={connections} onError={setMessage} /> : null}
      {message ? <P tone="bad">{message}</P> : null}
      {connections.length || rules.length ? <Deliveries rules={rules} connections={connections} /> : null}
    </Section>
  );
}

function Heading({ children }: { children: string }) {
  const p = usePalette();
  return <Text style={{ color: p.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginTop: 4 }}>{children}</Text>;
}

function Connections({ connections }: { connections: PluginConnection[] }) {
  return (
    <>
      <Heading>Połączenia</Heading>
      {connections.map((c) => (
        <View key={c.id}>
          <P>
            {c.label}
            <P muted>{` · ${pluginDef(c.plugin)?.name ?? c.plugin} · ${PLUGIN_CONNECTION_STATUS[c.status]}${c.lastUsedAt ? ` · ostatnio ${when(c.lastUsedAt)}` : ''}`}</P>
          </P>
          {c.lastError && c.status !== 'active' ? <P tone="bad">{c.lastError}</P> : null}
        </View>
      ))}
    </>
  );
}

function Rules({ rules, connections, onError }: { rules: PluginRule[]; connections: PluginConnection[]; onError: (text: string | null) => void }) {
  const p = usePalette();
  const { data } = useView();
  const tagName = (id: string) => data.tags.find((t) => t.id === id)?.name;
  const toggle = (rule: PluginRule, enabled: boolean) => {
    onError(null);
    mutateMany(pluginRuleEnableOps(rule.id, enabled)).catch((e: unknown) => onError(errorText(e)));
  };
  return (
    <>
      <Heading>Reguły</Heading>
      {rules.map((r) => {
        const c = connections.find((x) => x.id === r.connectionId);
        const after = afterSendSummary(r.options.afterSend, tagName);
        const target = c ? `${c.label}${c.status !== 'active' ? ` (${PLUGIN_CONNECTION_STATUS[c.status]})` : ''}` : 'połączenie usunięte';
        return (
          <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ flex: 1, color: p.fg }}>
              {r.name}
              <Text style={{ color: p.muted, fontSize: 13 }}>{`\n→ ${target} · ${pluginTriggerSummary(r)}${after ? ` · ${after}` : ''}`}</Text>
            </Text>
            <Switch accessibilityLabel={`Reguła „${r.name}” włączona`} value={r.enabled} onValueChange={(on) => toggle(r, on)} />
          </View>
        );
      })}
    </>
  );
}

function Deliveries({ rules, connections }: { rules: PluginRule[]; connections: PluginConnection[] }) {
  const p = usePalette();
  const online = sessionUser().online;
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await recentDeliveries(RECENT_DELIVERIES));
      setProblem(null);
    } catch (e) {
      setProblem(`Historia jest na serwerze — nie udało się jej wczytać (${errorText(e)}).`);
    }
  }, []);

  useEffect(() => {
    // Wczytanie przy pokazaniu sekcji (zapytanie do serwera, nie do lokalnej bazy) — jak na webie.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (online) void load();
  }, [load, online]);

  const retry = async (id: string) => {
    setBusy(true);
    try {
      await retryPluginDelivery(id);
      await load();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const ruleName = (id: string | null) => rules.find((r) => r.id === id)?.name;
  const connectionLabel = (id: string | null) => connections.find((c) => c.id === id)?.label;
  const tone = { muted: p.muted, ok: p.ok, error: p.bad } as const;

  return (
    <>
      <Heading>Ostatnie wysyłki</Heading>
      {!online ? <P muted>Historia wysyłek jest na serwerze — widać ją po zalogowaniu.</P> : null}
      {online ? (
        <Row>
          <Button kind="secondary" title="Odśwież" disabled={busy} onPress={() => void load()} />
        </Row>
      ) : null}
      {problem ? <P tone="bad">{problem}</P> : null}
      {rows && !rows.length ? <P muted>Jeszcze nic nie wysłano.</P> : null}
      {rows?.map((d) => {
        const status = DELIVERY_STATUS[d.status] ?? { label: d.status, tone: 'muted' as const };
        const link = d.external_url && /^https?:\/\//.test(d.external_url) ? d.external_url : null;
        const meta = [
          ruleName(d.rule_id) ?? connectionLabel(d.connection_id),
          when(d.sent_at ?? d.created_at),
          d.status === 'pending' && d.attempts > 0 && d.next_attempt_at ? `próba ${d.attempts + 1} o ${when(d.next_attempt_at)}` : '',
          d.http_status ? `HTTP ${d.http_status}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <View key={d.id} style={{ gap: 2 }}>
            <Text style={{ color: p.fg }}>
              <Text style={{ color: tone[status.tone], fontWeight: '600' }}>{status.label}</Text>
              {` ${d.title ?? '(zadanie)'}`}
            </Text>
            <P muted>{meta}</P>
            {d.error ? <P muted>{d.error}</P> : null}
            {link || canRetryDelivery(d.status) ? (
              <Row>
                {link ? <Button kind="secondary" title="Otwórz ↗" onPress={() => void Linking.openURL(link)} /> : null}
                {canRetryDelivery(d.status) ? <Button kind="secondary" title="Ponów" disabled={busy} onPress={() => void retry(d.id)} /> : null}
              </Row>
            ) : null}
          </View>
        );
      })}
    </>
  );
}
