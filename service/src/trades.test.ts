import { describe, expect, it } from 'vitest';
import type { TakeOut } from './book';
import { Trades } from './trades';

const take = (makerGivesNexus: boolean) => ({ offer: { offer: { nexusToken: '0', evmChainId: '97', evmToken: '0xabc', nexusAmount: '5000000', evmAmount: '100000000000000000000', makerGivesNexus } } }) as unknown as TakeOut;

describe('Trades', () => {
  it('keeps what changed hands, from the taker side, and drops old ones', () => {
    const t = new Trades([], 100, 3);
    t.add(take(true), 10);
    t.add(take(false), 20);
    expect(t.since(0, 30)).toEqual([
      { at: 10, nexusToken: '0', chainId: '97', evmToken: '0xabc', nexusAmount: '5000000', evmAmount: '100000000000000000000', takerBuys: true },
      { at: 20, nexusToken: '0', chainId: '97', evmToken: '0xabc', nexusAmount: '5000000', evmAmount: '100000000000000000000', takerBuys: false },
    ]);
    expect(t.since(15, 30)).toHaveLength(1);
    expect(t.since(0, 115)).toHaveLength(1);
  });

  it('caps the list at max entries', () => {
    const t = new Trades([], 1000, 3);
    for (let i = 0; i < 5; i++) {
      t.add(take(true), i);
    }
    expect(t.list.map((x) => x.at)).toEqual([2, 3, 4]);
  });
});
