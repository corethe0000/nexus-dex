//app/src/lib/pins.ts: what the page and the always-on maker fix themselves instead of trusting the relay
//(security review 2026-11-13)
import { describe, expect, it } from 'vitest';
import { defaultTiming, testTiming } from '../../core/src/swap/timing';
import type { RelayInfo } from '../../app/src/lib/config';
import { pinInfo } from '../../app/src/lib/pins';

const chain = (swap: string, confirmations: number) => ({ name: 'BSC', swap: swap as `0x${string}`, fromBlock: '0', confirmations, finalDelay: 30, tokens: [] });
const info: RelayInfo = {
  nexus: { finalDelay: 120, confirmations: 1 },
  chains: { '56': chain('0xAAaa000000000000000000000000000000000001', 2), '137': chain('0xbbbb000000000000000000000000000000000002', 2) },
  timing: testTiming,
  now: 0,
};

describe('pinned site values', () => {
  it('the same contract (any letter case): kept; a chain the site does not list: left out', () => {
    const r = pinInfo(info, { swapContracts: { '56': '0xaaaa000000000000000000000000000000000001' } });
    expect(Object.keys(r.chains)).toEqual(['56']);
  });
  it('another contract than the site names: nothing loads', () => {
    expect(() => pinInfo(info, { swapContracts: { '56': '0xcccc000000000000000000000000000000000003' } })).toThrow(/another swap contract on BSC/);
  });
  it('the site timing wins over the relay one', () => {
    expect(pinInfo(info, { timing: 'default' }).timing).toEqual(defaultTiming);
  });
  it('without a site timing, an unsafe relay timing is refused', () => {
    expect(() => pinInfo({ ...info, timing: { ...testTiming, safety: 10 } }, {})).toThrow(/not safe/);
  });
  it('confirmations never below the site minimum, never lowered', () => {
    const r = pinInfo(info, { minConfirmations: { nexus: 3, '56': 15, '137': 1 } });
    expect(r.nexus.confirmations).toBe(3);
    expect(r.chains['56']!.confirmations).toBe(15);
    expect(r.chains['137']!.confirmations).toBe(2);
  });
});

describe('pinned tokens', () => {
  const usdt = '0x00000000000000000000000000000000000000aa';
  const withTokens: RelayInfo = {
    ...info,
    chains: {
      '56': {
        ...chain('0xAAaa000000000000000000000000000000000001', 2),
        tokens: [
          { address: usdt, symbol: 'USDT', decimals: 6, usd: 1 },
          { address: '0x00000000000000000000000000000000000000bb', symbol: 'USDT', decimals: 6, usd: 1 },
        ],
      },
    },
  };
  it('only tokens the site lists, named and sized as the site says', () => {
    const r = pinInfo(withTokens, { tokens: { '56': [{ address: usdt.toUpperCase().replace('0X', '0x'), symbol: 'USDT', decimals: 18, usd: 1 }] } });
    expect(r.chains['56']!.tokens).toHaveLength(1);
    expect(r.chains['56']!.tokens[0]!.decimals).toBe(18);
  });
  it('a chain with no listed tokens shows none; no token list at all keeps the relay ones', () => {
    expect(pinInfo(withTokens, { tokens: {} }).chains['56']!.tokens).toEqual([]);
    expect(pinInfo(withTokens, {}).chains['56']!.tokens).toHaveLength(2);
  });
});
