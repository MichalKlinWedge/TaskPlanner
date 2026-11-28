/**
 * Pytanie przed wyjściem z ekranu z niezapisaną pracą (systemowe „Wstecz”, strzałka w nagłówku, gest).
 * `ask(leave)` pokazuje własne pytanie; `leave()` kończy przerwaną nawigację. Zwracana funkcja zdejmuje
 * ochronę przed własną nawigacją ekranu (np. `router.back()` po zapisie).
 */
import { usePreventRemove } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

export function useConfirmLeave(dirty: boolean, ask: (leave: () => void) => void): () => void {
  const [leaving, setLeaving] = useState(false);
  const disable = usePreventRemove(dirty && !leaving, ({ repeat }) =>
    ask(() => {
      setLeaving(true);
      repeat();
    }),
  );
  return useCallback(() => {
    setLeaving(true);
    disable();
  }, [disable]);
}

/** Najczęstszy wariant: „Odrzucić zmiany?” z „Zostań” / „Odrzuć” (i opcjonalnie „Zapisz”). */
export function useDiscardChanges(dirty: boolean, text: { title?: string; message: string; save?: () => Promise<boolean> | boolean }): () => void {
  return useConfirmLeave(dirty, (leave) =>
    Alert.alert(text.title ?? 'Odrzucić zmiany?', text.message, [
      { text: 'Zostań', style: 'cancel' },
      { text: 'Odrzuć', style: 'destructive', onPress: leave },
      ...(text.save
        ? [
            {
              text: 'Zapisz',
              onPress: () =>
                void Promise.resolve(text.save?.())
                  .then((ok) => {
                    if (ok) leave();
                  })
                  .catch(() => undefined),
            },
          ]
        : []),
    ]),
  );
}
