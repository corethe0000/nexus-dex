//EvmLeg log searches in pieces (security review 2026-11-13: public RPCs refuse long getLogs ranges, a search from
//the deployment block failed once the chain had moved on)
import type { Hex, PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { EvmLeg } from './leg';

const id = `0x${'ab'.repeat(32)}` as Hex;
const secret = `0x${'cd'.repeat(32)}` as Hex;

//a chain at block 12000 whose Claimed event of `id` sits in block `at`; getLogs is answered by a load-balanced backend
//that is one block behind (11999), which refuses a range past its head as public RPCs do
function chain(at: bigint) {
  const ranges: [bigint, bigint][] = [];
  const raw: (bigint | string)[] = [];
  const backendHead = 11999n;
  const client = {
    getBlockNumber: async () => 12000n,
    getLogs: async (q: { fromBlock: bigint; toBlock: bigint | 'latest' }) => {
      raw.push(q.toBlock);
      const to = q.toBlock === 'latest' ? backendHead : q.toBlock;
      if (to > backendHead) {
        throw new Error(`block range extends beyond current head block: requested ${to}, head ${backendHead}`);
      }
      ranges.push([q.fromBlock, q.toBlock === 'latest' ? 12000n : to]);
      return q.fromBlock <= at && at <= to ? [{ args: { id, secret }, transactionHash: '0x01' }] : [];
    },
  } as unknown as PublicClient;
  return { leg: new EvmLeg(client, '0x0000000000000000000000000000000000000001', 2, 100n), ranges, raw };
}

describe('finding a lock and where to search', () => {
  const ref = `0x${'01'.repeat(32)}` as Hex;
  const hashlock = `0x${'02'.repeat(32)}` as Hex;
  const token = '0x00000000000000000000000000000000000000aa' as Hex;
  const e = { sender: '0x00000000000000000000000000000000000000b1', recipient: '0x00000000000000000000000000000000000000b2', token, amount: 1000n, hashlock, nexusRef: ref } as const;
  const lockLog = (n: number, amount: bigint) => ({ args: { id: `0x${n.toString(16).padStart(64, '0')}`, nexusRef: ref, hashlock, token, amount, deadline: 99n }, transactionHash: `0x0${n}` });

  it('a dust lock with the same reference does not hide the real one', async () => {
    const client = { getBlockNumber: async () => 100n, getLogs: async () => [lockLog(1, 1n), lockLog(2, 1000n)] } as unknown as PublicClient;
    const leg = new EvmLeg(client, '0x0000000000000000000000000000000000000001', 2, 0n);
    expect((await leg.locate(e))?.tx).toBe('0x02');
  });

  it('a lock of another amount is still found when it is the only one (the view then refuses it)', async () => {
    const client = { getBlockNumber: async () => 100n, getLogs: async () => [lockLog(1, 1n)] } as unknown as PublicClient;
    const leg = new EvmLeg(client, '0x0000000000000000000000000000000000000001', 2, 0n);
    expect((await leg.locate(e))?.tx).toBe('0x01');
  });

  it('searches back a time, in blocks of this chain', async () => {
    //one block every 2 s: 6 h = 10800 blocks
    const client = { getBlock: async (q: { blockTag?: string; blockNumber?: bigint }) => (q.blockTag ? { number: 50000n, timestamp: 100000n } : { number: q.blockNumber!, timestamp: 100000n - (50000n - q.blockNumber!) * 2n }) } as unknown as PublicClient;
    const leg = new EvmLeg(client, '0x0000000000000000000000000000000000000001', 2, 0n);
    expect(await leg.searchStart()).toBe(50000n - 10800n);
  });
});

describe('EVM log search in pieces', () => {
  it('newest first, at most 5000 blocks a call, stops at the first hit', async () => {
    const { leg, ranges } = chain(3000n);
    expect(await leg.findSecret(id)).toBe(secret);
    expect(ranges.every(([lo, hi]) => hi - lo + 1n <= 5000n)).toBe(true);
    expect(ranges[0]).toEqual([7001n, 12000n]);
    expect(ranges[ranges.length - 1]![0]).toBeLessThanOrEqual(3000n);
  });
  it('never below the swap start block (or the deployment), and nothing found is null', async () => {
    const { leg, ranges } = chain(50n);
    expect(await leg.findSecret(id, 6000n)).toBeNull();
    expect(Math.min(...ranges.map(([lo]) => Number(lo)))).toBe(6000);
    const all = chain(50n);
    expect(await all.leg.findSecret(id)).toBeNull();
    expect(Math.min(...all.ranges.map(([lo]) => Number(lo)))).toBe(100);
  });
  it('the newest piece ends at latest, so a backend a block behind does not refuse it', async () => {
    const { leg, raw } = chain(11999n);
    expect(await leg.findSecret(id)).toBe(secret);
    expect(raw[0]).toBe('latest');
    const older = chain(3000n);
    await older.leg.findSecret(id);
    expect(older.raw.slice(1).every((t) => typeof t === 'bigint')).toBe(true);
  });
});
