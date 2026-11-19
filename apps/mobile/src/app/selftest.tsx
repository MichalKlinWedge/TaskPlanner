import { useState } from 'react';
import { Share } from 'react-native';

import { Button, P, Row, Screen, Section } from '@/components/ui';
import { runChecks, type Check } from '@/selftest/checks';

export default function SelfTest() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);
  const [ms, setMs] = useState<number | null>(null);

  const start = async () => {
    setRunning(true);
    setChecks([]);
    setMs(null);
    const result = await runChecks(setChecks);
    setChecks(result.checks);
    setMs(result.ms);
    setRunning(false);
  };

  const failed = checks.filter((c) => !c.ok).length;
  const groups = [...new Set(checks.map((c) => c.group))];
  const text = () =>
    [`Samosprawdzenie PoC-4 (Hermes) ${new Date().toISOString()}: ${checks.length - failed}/${checks.length} zgodnych, ${ms?.toFixed(0)} ms`, ...checks.map((c) => `${c.ok ? '✓' : '✗'} [${c.group}] ${c.name} ${c.detail}`)].join('\n');

  return (
    <Screen>
      <Row>
        <Button disabled={running} title={running ? 'Trwa…' : 'Uruchom'} onPress={() => void start()} />
        <Button disabled={!checks.length || running} kind="secondary" title="Udostępnij wynik" onPress={() => void Share.share({ message: text() })} />
      </Row>
      {checks.length ? (
        <P tone={failed ? 'bad' : 'ok'}>
          {checks.length - failed} / {checks.length} zgodnych{ms !== null ? ` · ${ms.toFixed(0)} ms` : ''}
        </P>
      ) : (
        <P muted>Te same przypadki co Vitest (Node) i /dev/recurrence (przeglądarka) + lokalna baza i silnik synchronizacji. Część z serwerem wymaga zalogowania.</P>
      )}
      {groups.map((group) => (
        <Section key={group} title={group}>
          {checks
            .filter((c) => c.group === group)
            .map((c, i) => (
              <P key={i} tone={c.ok ? undefined : 'bad'}>
                {c.ok ? '✓' : '✗'} {c.name}
                {c.detail ? `  ·  ${c.detail}` : ''}
              </P>
            ))}
        </Section>
      ))}
    </Screen>
  );
}
