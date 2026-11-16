//SlotGate: one Nexus claim at a time per profile
import { describe, expect, it } from 'vitest';
import { SlotGate } from './slot-gate';

describe('reveal slot gate', () => {
  it('a second swap of the same profile waits until the first lets go', () => {
    const g = new SlotGate();
    expect(g.acquire('bob', 'A', 0, 600)).toBe(true);
    expect(g.acquire('bob', 'B', 10, 600)).toBe(false);
    expect(g.acquire('alice', 'B', 10, 600)).toBe(true);
    expect(g.acquire('bob', 'A', 20, 600)).toBe(true);
    g.release('bob', 'B');
    expect(g.holder('bob')).toBe('A');
    g.release('bob', 'A');
    expect(g.acquire('bob', 'B', 30, 600)).toBe(true);
  });
  it('a holder that stopped asking is let go after maxHold, one that keeps asking is not', () => {
    const g = new SlotGate();
    g.acquire('bob', 'A', 0, 600);
    g.acquire('bob', 'A', 500, 600);
    expect(g.acquire('bob', 'B', 1000, 600)).toBe(false);
    expect(g.acquire('bob', 'B', 1101, 600)).toBe(true);
  });
});
