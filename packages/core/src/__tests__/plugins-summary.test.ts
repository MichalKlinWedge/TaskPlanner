import { describe, expect, it } from 'vitest';

import { canRetryDelivery, DEFAULT_DELAY_SEC, pluginDelayLabel, pluginTriggerSummary, type PluginRule } from '../plugins/index.ts';

const rule = (trigger: PluginRule['trigger'], options: PluginRule['options'] = {}): Pick<PluginRule, 'trigger' | 'options'> => ({ trigger, options });

describe('opis reguły integracji na liście', () => {
  it('reguła ręczna = „Wyślij do…”', () => {
    expect(pluginTriggerSummary(rule({ kind: 'manual' }))).toBe('„Wyślij do…”');
  });

  it('reguła zdarzeniowa: zdarzenia, filtr i opóźnienie', () => {
    expect(pluginTriggerSummary(rule({ kind: 'event', events: ['task.completed'] }))).toBe(`gdy: Ukończone · po ${DEFAULT_DELAY_SEC} s`);
    expect(pluginTriggerSummary(rule({ kind: 'event', events: ['task.completed', 'task.created'], filter: { priorities: [1] } }, { delaySec: 300 }))).toBe(
      'gdy: Ukończone, Dodane zadanie (z filtrem) · po 5 min',
    );
    // Pusty filtr nie jest filtrem.
    expect(pluginTriggerSummary(rule({ kind: 'event', events: ['task.created'], filter: {} }, { delaySec: 0 }))).toBe('gdy: Dodane zadanie · po od razu');
  });

  it('opóźnienie spoza listy w sekundach', () => {
    expect(pluginDelayLabel(45)).toBe('45 s');
    expect(pluginDelayLabel(3600)).toBe('1 godz.');
    expect(pluginDelayLabel(DEFAULT_DELAY_SEC)).toBe(`${DEFAULT_DELAY_SEC} s`);
  });

  it('„Ponów” tylko dla nieudanych i pominiętych wysyłek', () => {
    expect(['failed', 'dead', 'skipped'].every(canRetryDelivery)).toBe(true);
    expect(['pending', 'sending', 'sent', 'x'].some(canRetryDelivery)).toBe(false);
  });
});
