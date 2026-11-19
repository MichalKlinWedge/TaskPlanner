/**
 * Koordynacja kart (`connectTabs`): karta, która nie jest liderem, a lider ma starszą wersję
 * aplikacji — zapis zbiorczy nie może zniknąć bez błędu (stary lider nie znał `mutateMany`).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { connectTabs, STALE_LEADER_MESSAGE, TAB_PROTOCOL, type TabStore } from '../tabs.ts';

const NAME = 'tp-test-tabs';
const opened: { close: () => void }[] = [];

/** Lider-atrapa na tym samym kanale: odpowiada podaną wersją (`undefined` = sprzed wersjonowania). */
function fakeLeader(v: number | undefined) {
  const channel = new BroadcastChannel(NAME);
  const seen: string[] = [];
  channel.onmessage = (event: MessageEvent) => {
    const m = event.data;
    if (m.kind !== 'request') return;
    seen.push(m.body.op);
    channel.postMessage({ kind: 'reply', id: m.id, to: m.from, result: m.body.op === 'query' ? [] : null, ...(v === undefined ? {} : { v }) });
  };
  opened.push(channel);
  return seen;
}

function follower(): TabStore {
  // Blokada lidera nigdy nie przychodzi — ta karta zawsze pyta lidera przez kanał.
  Object.defineProperty(globalThis, 'navigator', { value: { locks: { request: () => new Promise(() => {}) } }, configurable: true });
  const store = connectTabs({ name: NAME, createEngine: () => Promise.reject(new Error('nie lider')), timeoutMs: 500 });
  opened.push(store);
  return store;
}

afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

describe('connectTabs — wersja lidera', () => {
  it('lider sprzed wersjonowania: zapis zbiorczy odrzucony, karta oznaczona; zwykły zapis i zapytania działają', async () => {
    const seen = fakeLeader(undefined);
    const store = follower();
    const events: boolean[] = [];
    store.onStale((s) => events.push(s));
    await expect(store.mutateMany([{ table: 'tasks', id: 'a', patch: { title: 'x' } }])).rejects.toThrow(STALE_LEADER_MESSAGE);
    expect(store.staleLeader).toBe(true);
    await expect(store.mutate('tasks', 'a', { title: 'y' })).resolves.toBeUndefined();
    await expect(store.query('select 1')).resolves.toEqual([]);
    expect(seen).toEqual(['mutateMany', 'mutate', 'query']);
    expect(events).toEqual([true]);
  });

  it('lider w bieżącej wersji: zapis zbiorczy przechodzi, karta aktualna', async () => {
    fakeLeader(TAB_PROTOCOL);
    const store = follower();
    await expect(store.mutateMany([{ table: 'tasks', id: 'a', patch: { title: 'x' } }])).resolves.toBeUndefined();
    expect(store.staleLeader).toBe(false);
  });
});
