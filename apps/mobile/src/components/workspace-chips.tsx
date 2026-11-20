/**
 * Przestrzenie, w których tag albo współpracownik się pokazuje i podpowiada (`workspace_ids`);
 * żadna zaznaczona = wszystkie.
 */
import { Text, View } from 'react-native';

import { Chip, usePalette } from '@/components/ui';
import type { AppData } from '@/lib/app-data';

export function WorkspaceChips({ ids, workspaces, onChange, inset = true }: { ids: readonly string[] | null | undefined; workspaces: AppData['workspaces']; onChange: (ids: string[]) => void; inset?: boolean }) {
  const p = usePalette();
  const chosen = (ids ?? []).filter((id) => workspaces.some((w) => w.id === id));
  return (
    <View style={{ paddingHorizontal: inset ? 12 : 0, paddingTop: inset ? 8 : 0, gap: 6 }}>
      <Text style={{ color: p.muted, fontSize: 13 }}>Widoczny w:</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip label="wszystkich przestrzeniach" selected={!chosen.length} onPress={() => onChange([])} />
        {workspaces.map((w) => {
          const on = chosen.includes(w.id);
          return <Chip key={w.id} label={w.name} selected={on} onPress={() => onChange(on ? chosen.filter((id) => id !== w.id) : [...chosen, w.id])} />;
        })}
      </View>
    </View>
  );
}
