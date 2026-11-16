//swaps while a chain misbehaves: the EVM chain stalls, an own transaction waits in the queue (gas spike), a reorg
//drops an own lock or claim, the Nexus node is unreachable. Every case must end swapped with exact balances, and a
//step is never sent twice while the first one can still go through. Uses anvil's test methods (evm_setIntervalMining,
//evm_snapshot / evm_revert), so run it against an anvil of its own, never the one the relay and keeper use. It needs
//a block every 2 s like the dev chain (a lock is final 2 blocks later; with blocks only on transactions it never is):
//  anvil --port 8547 --block-time 2 &
//  CHAOS=1 NEXUS_NODE=http://127.0.0.1:7080 EVM_RPC=http://127.0.0.1:8547 CONTRACTS=$HOME/dex/contracts/out npx vitest run src/swap/chaos.e2e.test.ts
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { maxUint256 } from 'viem';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { erc20Abi } from '../evm/leg';
import { NexusNode } from '../nexus/node';
import { env, haveLocal } from '../testing/local';
import { runSwap } from '../testing/swap-run';
import type { SwapRunner } from './runner';

const chaosOk = haveLocal && process.env.CHAOS === '1';

let rpcId = 1;
async function anvil(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(env.rpc!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) {
    throw new Error(`${method}: ${j.error.message}`);
  }
  return j.result;
}

//the maker's token allowance up front: with blocks stopped, the approve inside the lock would wait for its receipt
//and hold the whole test loop
const approved = new Set<string>();
async function approveFirst(m: SwapRunner) {
  if (approved.has(m.rec.id)) {
    return;
  }
  approved.add(m.rec.id);
  const w = m.signers.evm;
  const tx = await w.writeContract({ address: m.rec.evm.token, abi: erc20Abi, functionName: 'approve', args: [m.evm.swap, maxUint256], account: w.account!, chain: w.chain });
  await m.evm.client.waitForTransactionReceipt({ hash: tx });
}

//no new blocks at all (stalled chain; also how a transaction "waits in the queue"), and blocks every 2 s again
const blockTime = 2;
const stopBlocks = () => anvil('evm_setIntervalMining', [0]);
const startBlocks = async () => {
  await anvil('evm_setIntervalMining', [blockTime]);
  await anvil('evm_mine');
};

const note = (r: SwapRunner, msg: string) => r.rec.log.push(`${new Date().toISOString()} test: ${msg}`);
const lines = (r: SwapRunner, re: RegExp) => r.rec.log.filter((l) => re.test(l));
const minutes = (n: number) => n * 60 * 1000;
//longer than the runners' resendAfter (300 s), so the "send it again?" decision is really taken
const stallFor = minutes(6.5);

describe.skipIf(!chaosOk)('swaps while a chain misbehaves (CHAOS=1, own anvil)', () => {
  //the Nexus node behind a switch: down = every request fails at once
  let proxy: Server;
  let nexusDown = false;
  let proxyUrl = '';
  beforeAll(async () => {
    const target = new URL(env.nexusUrl!);
    proxy = createServer((req, res) => {
      if (nexusDown) {
        req.socket.destroy();
        return;
      }
      const up = request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.destroy());
      req.pipe(up);
    });
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    await startBlocks();
  });
  afterAll(async () => {
    proxy?.close();
  });
  //blocks always run again after a case, whatever it left behind
  afterEach(async () => {
    nexusDown = false;
    await startBlocks().catch(() => {});
  });

  it('the EVM chain stalls before the maker claims: its claim waits and is sent once', async () => {
    let stalledAt = 0;
    const { m } = await runSwap({
      initiatorChain: 'evm',
      chaos: async (t) => {
        //the taker writes the secret on Nexus; the maker's claim on EVM comes after it, into the stalled chain
        if (!stalledAt && t.rec.pending?.kind === 'reveal') {
          stalledAt = Date.now();
          await stopBlocks();
          note(t, 'EVM chain stalls');
        } else if (stalledAt > 0 && Date.now() - stalledAt > stallFor) {
          stalledAt = -1;
          await startBlocks();
          note(t, 'EVM chain runs again');
        }
      },
    });
    expect(lines(m, /claim on EVM sent/)).toHaveLength(1);
    expect(lines(m, /still waiting on the EVM chain|not final yet: not sending it again|sent again with a higher fee/).length).toBeGreaterThan(0);
  }, minutes(30));

  //the taker's claim shows the secret while it waits: it must get in before the maker's lock runs out, so it goes
  //again with a higher fee (same nonce) and replaces the first. anvil drops a transaction from its queue as soon as
  //the base fee rises above its fee (real nodes keep it waiting), so the queue is held by stopping blocks instead
  it("the taker's EVM claim waits in the queue: it is sent again with a higher fee and replaces the first", async () => {
    let phase = 0;
    let first = '';
    const { t } = await runSwap({
      initiatorChain: 'nexus',
      chaos: async (t, m) => {
        //blocks by hand from the maker lock on: one per round before the taker ticks, none once its claim is out
        //(the taker reads the lock off the chain and can claim in the same round the maker sees it confirmed)
        if (phase === 0 && m.rec.pending?.kind === 'lock' && m.rec.pending.ref.startsWith('0x')) {
          phase = 1;
          await stopBlocks();
          note(t, 'EVM blocks by hand from here');
        } else if (phase === 1 && t.rec.pending?.kind === 'claim' && t.rec.pending.ref.startsWith('0x')) {
          phase = 2;
          first = t.rec.pending.ref;
          note(t, 'EVM blocks held: the taker claim stays in the queue');
        } else if (phase === 1) {
          await anvil('evm_mine');
        } else if (phase === 2 && lines(t, /sent again with a higher fee/).length > 0) {
          phase = 3;
          await startBlocks();
          note(t, 'EVM blocks again');
        }
      },
    });
    expect(phase).toBe(3);
    expect(lines(t, /claim on EVM sent/)).toHaveLength(1);
    expect(lines(t, /not seen after/)).toHaveLength(0);
    const sent = await t.evm.client.getTransaction({ hash: first as `0x${string}` }).catch(() => null);
    expect(sent).toBeNull();
    const claims = t.rec.txs!.filter((x) => x.chain === 'evm' && x.kind === 'claim').map((x) => x.hash);
    const mined = await Promise.all(claims.map((h) => t.evm.txState(h as `0x${string}`)));
    expect(mined.filter((x) => x === 'mined')).toHaveLength(1);
    expect(mined[0]).not.toBe('mined');
  }, minutes(30));

  it('gas spike: the maker\'s EVM lock waits in the queue and is sent once', async () => {
    let stalledAt = 0;
    const { m } = await runSwap({
      initiatorChain: 'nexus',
      chaos: async (t, m) => {
        await approveFirst(m);
        if (!stalledAt && t.rec.nexusLock) {
          stalledAt = Date.now();
          await stopBlocks();
          note(t, 'EVM transactions stay in the queue');
        } else if (stalledAt > 0 && Date.now() - stalledAt > stallFor) {
          stalledAt = -1;
          await startBlocks();
          note(t, 'EVM chain takes transactions again');
        }
      },
    });
    expect(lines(m, /locked on EVM/)).toHaveLength(1);
    expect(lines(m, /still waiting on the EVM chain/).length).toBeGreaterThan(0);
  }, minutes(30));

  it('a reorg drops the maker\'s EVM lock: it is sent again as the same lock, never a second one', async () => {
    let phase = 0;
    let snap = '';
    const { m } = await runSwap({
      initiatorChain: 'nexus',
      //sent again before the taker's lock is too old to answer (testTiming maxLockAge is 300 s, like the default resend)
      resendAfter: 120,
      chaos: async (t, m) => {
        await approveFirst(m);
        if (phase === 0 && t.rec.nexusLock) {
          phase = 1;
          await stopBlocks();
          note(t, 'EVM blocks by hand from here');
        } else if (phase === 1 && m.rec.pending?.kind === 'lock' && m.rec.pending.ref.startsWith('0x')) {
          phase = 2;
          snap = (await anvil('evm_snapshot')) as string;
          await anvil('evm_mine');
          note(t, 'maker lock in a block (1 confirmation)');
        } else if (phase === 2) {
          phase = 3;
          await anvil('evm_revert', [snap]);
          await anvil('anvil_dropAllTransactions');
          await startBlocks();
          note(t, 'reorg: the block with the maker lock is gone and the lock is not coming back by itself');
        }
      },
    });
    const sent = lines(m, /locked on EVM/).map((l) => /locked on EVM (0x[0-9a-f]+)/.exec(l)?.[1]);
    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(1);
    expect(lines(m, /not seen after/).length).toBeGreaterThan(0);
  }, minutes(30));

  it('a reorg drops the taker\'s EVM claim after the secret was seen: it is sent again and the taker gets paid', async () => {
    let phase = 0;
    let snap = '';
    const { t } = await runSwap({
      initiatorChain: 'nexus',
      chaos: async (t, m) => {
        if (phase === 0 && m.rec.pending?.kind === 'lock' && m.rec.pending.ref.startsWith('0x')) {
          phase = 1;
          await stopBlocks();
          note(t, 'EVM blocks by hand from here');
        } else if (phase === 1) {
          if (t.rec.pending?.kind === 'claim') {
            phase = 2;
            snap = (await anvil('evm_snapshot')) as string;
            note(t, 'taker claim goes into a block');
          }
          await anvil('evm_mine');
        } else if (phase === 2 && m.rec.secret) {
          phase = 3;
          await anvil('evm_revert', [snap]);
          await anvil('anvil_dropAllTransactions');
          await startBlocks();
          note(t, 'reorg: the block with the taker claim is gone, the maker already has the secret');
        } else if (phase === 2) {
          await anvil('evm_mine');
        }
      },
    });
    expect(lines(t, /claim on EVM sent/)).toHaveLength(2);
    expect(lines(t, /not seen after/).length).toBeGreaterThan(0);
  }, minutes(30));

  it('the Nexus node is unreachable for 4 minutes after the maker locked', async () => {
    let downAt = 0;
    await runSwap({
      initiatorChain: 'evm',
      runnerNode: new NexusNode(proxyUrl),
      chaos: async (t, m) => {
        if (!downAt && m.rec.nexusLock && m.rec.pending?.kind !== 'lock') {
          downAt = Date.now();
          nexusDown = true;
          note(t, 'Nexus node down');
        } else if (downAt > 0 && Date.now() - downAt > minutes(4)) {
          downAt = -1;
          nexusDown = false;
          note(t, 'Nexus node back');
        }
      },
    });
  }, minutes(30));
});
