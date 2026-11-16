//keeper and watcher as helpers that pay gas for other people's locks (security review 2026-11-13, task d27a3f42):
//one bad lock never holds up the rest, failures are retried less and less often, tokens and amounts can be limited
import type { Hex, WalletClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { EvmGasRefused, type EvmLeg } from '../../core/src/evm/leg';
import { toHexBytes } from '../../core/src/nexus/bytes';
import { hashOf } from '../../core/src/nexus/htlc';
import type { NexusLeg } from '../../core/src/nexus/leg';
import { Keeper, type KeeperChain } from './keeper';
import { Watcher, type Watched } from './watcher';
import type { TakeOut } from './book';

const coin = '0x0000000000000000000000000000000000000000';
const usdt = '0x00000000000000000000000000000000000000aa';
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

//a chain with locks 1..n, all past their deadline; lock `bad` refuses every refund
function chain(n: number, bad: number[], token = (_i: number) => coin, amount = (_i: number) => 1000n) {
  const refunded: Hex[] = [];
  const leg = {
    fromBlock: 0n,
    confirmations: 2,
    client: { getBlockNumber: async () => 10n },
    locksBetween: async () => Array.from({ length: n }, (_, i) => ({ id: id(i + 1), deadline: 100n })),
    clock: async () => 10000,
    state: async (lock: Hex) => {
      const i = Number(BigInt(lock));
      return { state: refunded.includes(lock) ? 'refunded' : 'open', token: token(i), amount: amount(i), deadline: 100n, hashlock: `0x${'00'.repeat(32)}`, sender: coin, recipient: coin };
    },
    guarded: async (_w: WalletClient, call: { fn: string; id: Hex }) => {
      if (bad.includes(Number(BigInt(call.id)))) {
        throw new EvmGasRefused('refund would fail: sender refuses the coin');
      }
      refunded.push(call.id);
      return call.id;
    },
  } as unknown as EvmLeg;
  return { leg, refunded };
}

const quiet = () => {};

describe('keeper refund sweep', () => {
  it('a lock that cannot be refunded does not hold up the ones after it', async () => {
    const { leg, refunded } = chain(5, [2]);
    const k = new Keeper(new Map([['1', { leg, wallet: {} as WalletClient, claimMargin: 60, refundDelay: 60 } satisfies KeeperChain]]), quiet);
    await k.sweep(1000);
    expect(refunded.map((h) => Number(BigInt(h)))).toEqual([1, 3, 4, 5]);
  });

  it('a failing lock is tried again later, less often, and left alone after 6 tries', async () => {
    const { leg } = chain(1, [1]);
    let tries = 0;
    const counting = { ...leg, guarded: async (...a: Parameters<EvmLeg['guarded']>) => (tries++, leg.guarded(...a)) } as unknown as EvmLeg;
    const k = new Keeper(new Map([['1', { leg: counting, wallet: {} as WalletClient, claimMargin: 60, refundDelay: 60 }]]), quiet);
    await k.sweep(1000);
    await k.sweep(1010); //too soon
    expect(tries).toBe(1);
    for (let t = 1000; t < 100000; t += 60) {
      await k.sweep(t);
    }
    expect(tries).toBe(6);
  });

  it('only listed tokens from their smallest amount, at most 20 refunds a sweep', async () => {
    const { leg, refunded } = chain(30, [], (i) => (i % 2 ? coin : usdt), (i) => (i <= 4 ? 10n : 1000n));
    const k = new Keeper(new Map([['1', { leg, wallet: {} as WalletClient, claimMargin: 60, refundDelay: 60, tokens: new Map([[coin, 100n]]) }]]), quiet);
    await k.sweep(1000);
    const got = refunded.map((h) => Number(BigInt(h)));
    expect(got.every((i) => i % 2 === 1 && i > 4)).toBe(true);
    expect(got).toHaveLength(13); //5, 7, ... 29
  });

  it('a claim request for a token it does not pay for is refused', async () => {
    const { leg } = chain(1, []);
    const open = { ...leg, state: async () => ({ state: 'open', token: usdt, amount: 5n, deadline: 99999n, hashlock: `0x${toHexBytes(hashOf(new Uint8Array(32)))}`, sender: coin, recipient: coin }) } as unknown as EvmLeg;
    const k = new Keeper(new Map([['1', { leg: open, wallet: {} as WalletClient, claimMargin: 60, refundDelay: 60, tokens: new Map([[coin, 0n]]) }]]), quiet);
    await expect(k.claim('1', id(1), `0x${'00'.repeat(32)}`, 1000)).rejects.toThrow(/does not collect that token/);
  });
});

describe('relay watcher rounds', () => {
  const take = (n: number) => ({ id: id(n) }) as unknown as TakeOut;
  function watcher(state: Map<Hex, Watched>, fail = false) {
    const looked: Hex[] = [];
    const w = new Watcher(new Map(), {} as NexusLeg, state, quiet);
    (w as unknown as { one: (t: TakeOut, w: Watched) => Promise<void> }).one = async (t) => {
      looked.push(t.id);
      if (fail) {
        throw new Error('node down');
      }
    };
    return { w, looked };
  }

  it('at most 40 swaps a round, the ones not looked at longest first', async () => {
    const state = new Map<Hex, Watched>();
    const { w, looked } = watcher(state);
    const all = Array.from({ length: 50 }, (_, i) => take(i + 1));
    await w.tick(all, 1000);
    expect(looked).toHaveLength(40);
    looked.length = 0;
    await w.tick(all, 1010);
    expect(looked.slice(0, 10).map((h) => Number(BigInt(h)))).toEqual([41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
  });

  it('swaps the book forgot are dropped; a swap that keeps failing waits longer and is given up', async () => {
    const state = new Map<Hex, Watched>([[id(9), { id: id(9), acceptedAt: 0, done: 'claimed' }]]);
    const { w, looked } = watcher(state, true);
    await w.tick([take(1)], 1000);
    expect(state.has(id(9))).toBe(false);
    await w.tick([take(1)], 1010);
    expect(looked).toHaveLength(1);
    for (let t = 1000; t < 200000; t += 30) {
      await w.tick([take(1)], t);
    }
    expect(looked).toHaveLength(8);
    expect(state.get(id(1))!.done).toMatch(/gave up/);
  });
});
