/** „Usuń na stałe” w koszu: potwierdzenie, usunięcie na serwerze (`purge_tasks`), bez cofnięcia. */
import { purgeErrorText, purgeQuestion, type TrashedTask } from '@taskplanner/core';
import { useState } from 'react';

import { confirm, useTaskActions } from '@/components/actions';
import { Button } from '@/components/ui';
import { listEditable, useAppData } from '@/lib/app-data';
import { purgeFromTrash } from '@/lib/trash';

export function PurgeButton({ task, inside, kind = 'danger', onPurged }: { task: TrashedTask; inside: number; kind?: 'secondary' | 'danger'; onPurged?: () => void }) {
  const data = useAppData();
  const { notify } = useTaskActions();
  const [busy, setBusy] = useState(false);

  const purge = async () => {
    const shared = (data.workspaces.find((w) => w.id === task.workspaceId)?.members ?? 1) > 1;
    const question = purgeQuestion(task.title, inside, shared);
    if (!(await confirm(question.title, question.text, 'Usuń na stałe', 'Anuluj'))) return;
    setBusy(true);
    try {
      await purgeFromTrash(task.id);
      notify(`Usunięto na stałe „${task.title}”`);
      onPurged?.();
    } catch (e) {
      notify(purgeErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return <Button kind={kind} title={busy ? 'Usuwanie…' : 'Usuń na stałe'} disabled={busy || !listEditable(data, task.listId)} onPress={() => void purge()} />;
}
