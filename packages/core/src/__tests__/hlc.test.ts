import { describe, expect, it } from 'vitest';

import { compareHlc, formatHlc, HlcClock, isHlc, maxHlc, parseHlc } from '../hlc.ts';

const fixedClock = (start: number) => {
  let time = start;
  return { now: () => time, set: (value: number) => (time = value) };
};

describe('HLC', () => {
  it('format i odczyt', () => {
    const value = formatHlc({ wall: 1_763_467_200_000, counter: 7, node: 'phone-1' });
    expect(value).toBe('001763467200000:00007:phone-1');
    expect(parseHlc(value)).toEqual({ wall: 1_763_467_200_000, counter: 7, node: 'phone-1' });
    expect(isHlc(value)).toBe(true);
    expect(isHlc('1763467200000:7:phone-1')).toBe(false);
    expect(() => formatHlc({ wall: 1, counter: 0, node: 'z:dwukropkiem' })).toThrow();
  });

  it('kolejne znaczniki rosną także przy stojącym zegarze', () => {
    const time = fixedClock(1000);
    const clock = new HlcClock('a', time.now);
    const first = clock.tick();
    const second = clock.tick();
    expect(compareHlc(second, first)).toBe(1);
    time.set(500); // zegar systemowy cofnięty
    const third = clock.tick();
    expect(third > second).toBe(true);
  });

  it('po odebraniu znacznika z przyszłości następna zmiana jest od niego nowsza', () => {
    const local = fixedClock(1000);
    const clock = new HlcClock('a', local.now);
    const remote = formatHlc({ wall: 5000, counter: 3, node: 'b' });
    clock.receive(remote);
    const next = clock.tick();
    expect(next > remote).toBe(true);
    expect(parseHlc(next)).toEqual({ wall: 5000, counter: 4, node: 'a' });
  });

  it('remis czasu i licznika rozstrzyga identyfikator węzła', () => {
    const a = formatHlc({ wall: 1000, counter: 0, node: 'a' });
    const b = formatHlc({ wall: 1000, counter: 0, node: 'b' });
    expect(compareHlc(a, b)).toBe(-1);
    expect(maxHlc(a, undefined, b, null)).toBe(b);
  });

  it('licznik bez przepełnienia przechodzi na następną milisekundę', () => {
    const clock = new HlcClock('a', () => 1000, formatHlc({ wall: 1000, counter: 99_999, node: 'x' }));
    expect(parseHlc(clock.tick())).toEqual({ wall: 1001, counter: 0, node: 'a' });
  });

  it('zegar odtworzony z ostatniego znacznika nie wydaje mniejszych', () => {
    const last = formatHlc({ wall: 9000, counter: 2, node: 'a' });
    const clock = new HlcClock('a', () => 1000, last);
    expect(clock.tick() > last).toBe(true);
  });
});
