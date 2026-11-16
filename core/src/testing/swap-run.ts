//one full swap between the private Nexus chain and anvil, both sides driven by SwapRunner, with balances checked
//after; used by swap.e2e.test.ts and chaos.e2e.test.ts
import { keccak256, toHex, type Address } from 'viem';
import { expect } from 'vitest';
import { EvmLeg, erc20Abi } from '../evm/leg';
import { toHexBytes } from '../nexus/bytes';
import { hashOf, newSecret } from '../nexus/htlc';
import { NexusLeg } from '../nexus/leg';
import type { NexusNode } from '../nexus/node';
import { localSigner } from '../nexus/signer';
import { SwapRunner, type SwapRecord } from '../swap/runner';
import { testTiming } from '../swap/timing';
import { alice, bob, deploy, ensureSlot, keys, localChains, nudgeNexus, sleep } from './local';

//offline: a side that stops ticking (closed app); it comes back once the other side is done, if `back`
export interface Offline {
  who: 'taker' | 'maker';
  when: (t: SwapRecord, m: SwapRecord) => boolean;
  back: boolean;
}

export interface RunOptions {
  initiatorChain: 'nexus' | 'evm';
  offline?: Offline;
  expectResult?: 'swapped' | 'refunded';
  //called before every round of ticks: breaks a chain on purpose (stall, reorg, node down)
  chaos?: (t: SwapRunner, m: SwapRunner) => Promise<void>;
  //the node the runners talk to (a switchable proxy in the chaos test); setup always uses the real one
  runnerNode?: NexusNode;
  //seconds before a step not seen on its chain is sent again (default 300, as on the page)
  resendAfter?: number;
  //this many swaps of the same two profiles at once (default 1): their claims share one reveal slot per profile
  swaps?: number;
}

export async function runSwap(o: RunOptions): Promise<{ t: SwapRunner; m: SwapRunner; pairs: { t: SwapRunner; m: SwapRunner }[] }> {
  const { initiatorChain, offline, expectResult = 'swapped' } = o;
  const count = o.swaps ?? 1;
  const { node, client, wallet } = localChains();
  const taker = wallet(keys.taker);
  const maker = wallet(keys.maker);
  const { swap, usdt, fromBlock } = await deploy([taker.account.address, maker.account.address]);
  const aliceGenesis = await ensureSlot(node, alice);
  const bobGenesis = await ensureSlot(node, bob);

  const nexusAmount = '4'; //TESTT base units (2 decimals = 0.04)
  const evmAmount = '25000000'; //25 USDT
  //taker gives on its chain: initiatorChain evm = taker pays USDT for TESTT
  const nexusSide = initiatorChain === 'evm' ? { sender: aliceGenesis, recipient: bobGenesis, from: alice.account, to: bob.account } : { sender: bobGenesis, recipient: aliceGenesis, from: bob.account, to: alice.account };
  const evmSide = initiatorChain === 'evm' ? { sender: taker.account.address, recipient: maker.account.address } : { sender: maker.account.address, recipient: taker.account.address };
  const token = (await node.accountState(nexusSide.from)).token;
  const rn = o.runnerNode ?? node;
  const nexusLeg = new NexusLeg(rn, 1);
  const evmLeg = new EvmLeg(client, swap, 2, fromBlock);
  const chains = { nexusFinalDelay: 120, evmFinalDelay: 10, resendAfter: o.resendAfter ?? 300 };
  const pairs: { t: SwapRunner; m: SwapRunner }[] = [];
  for (let i = 0; i < count; i++) {
    const secret = newSecret();
    const id = `e2e-${Date.now()}-${i}`;
    const base: Omit<SwapRecord, 'role' | 'secret' | 'log'> = {
      id,
      initiatorChain,
      hashlock: toHexBytes(hashOf(secret)),
      nexus: { ...nexusSide, amount: nexusAmount, token },
      evm: { ...evmSide, token: usdt, amount: evmAmount, nexusRef: keccak256(toHex(id)) },
    };
    pairs.push({
      t: new SwapRunner({ ...base, role: 'initiator', secret: toHexBytes(secret), log: [] }, nexusLeg, evmLeg, { nexus: localSigner(rn, bob, bobGenesis), evm: taker }, testTiming, chains),
      m: new SwapRunner({ ...base, role: 'participant', log: [] }, nexusLeg, evmLeg, { nexus: localSigner(rn, alice, aliceGenesis), evm: maker }, testTiming, chains),
    });
  }
  const { t, m } = pairs[0]!;

  const usdtOf = (a: Address) => client.readContract({ address: usdt, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
  const balances = async () => ({ takerUsdt: await usdtOf(taker.account.address), makerUsdt: await usdtOf(maker.account.address), alice: (await node.accountState(alice.account)).balance, bob: (await node.accountState(bob.account)).balance });
  const before = await balances();

  const end = Date.now() + 28 * 60 * 1000;
  let gone = false;
  const finished = (r: SwapRunner) => !!(r.rec.done || r.rec.aborted);
  const all = pairs.flatMap((p) => [p.t, p.m]);
  const traced = new Map<unknown, string>();
  while (Date.now() < end && !all.every(finished)) {
    if (o.chaos) {
      await o.chaos(t, m).catch((e) => t.rec.log.push(`${new Date().toISOString()} test: chaos step failed: ${(e as Error).message}`));
    }
    if (offline && !gone && offline.when(t.rec, m.rec)) {
      gone = true;
      t.rec.log.push(`${new Date().toISOString()} test: ${offline.who} goes offline`);
    }
    for (const r of all) {
      const isOff = offline && gone && (offline.who === 'taker' ? r === t : r === m);
      const other = r === t ? m : r === m ? t : r;
      if (isOff && !(offline!.back && finished(other))) {
        continue;
      }
      try {
        const a = await r.tick();
        //SWAP_TRACE=1: every change of what a side waits for
        const why = a.kind === 'wait' ? a.reason : a.kind;
        if (process.env.SWAP_TRACE && traced.get(r) !== why) {
          traced.set(r, why);
          r.rec.log.push(`${new Date().toISOString()} ${r.rec.role} trace: ${why}`);
        }
      } catch (e) {
        r.rec.log.push(`${new Date().toISOString()} ${r.rec.role} tick error: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    await nudgeNexus(node, alice, 120).catch(() => false);
    await sleep(3000);
  }
  //lines start with the time; with several swaps the swap number goes right after it
  console.log(all.flatMap((r) => r.rec.log.map((l) => (count > 1 ? l.replace(' ', ` [${r.rec.id.slice(-1)}] `) : l))).sort((a, b) => a.localeCompare(b)).join('\n'));
  for (const p of pairs.slice(1)) {
    expect(p.t.rec.done?.result).toBe(expectResult);
    expect(p.m.rec.done?.result).toBe(expectResult);
  }
  expect(t.rec.done?.result).toBe(expectResult);
  if (offline?.who === 'maker' && !offline.back) {
    expect(m.rec.done).toBeUndefined();
  } else {
    expect(m.rec.done?.result).toBe(expectResult);
  }

  const after = await balances();
  if (expectResult === 'refunded') {
    expect(after).toEqual(before);
    return { t, m, pairs };
  }
  const usdtMoved = BigInt(evmAmount) * BigInt(count);
  const nexusMoved = BigInt(nexusAmount) * BigInt(count);
  if (initiatorChain === 'evm') {
    expect(after.takerUsdt).toBe(before.takerUsdt - usdtMoved);
    expect(after.makerUsdt).toBe(before.makerUsdt + usdtMoved);
    expect(after.bob).toBe(before.bob + nexusMoved);
    expect(after.alice).toBe(before.alice - nexusMoved);
  } else {
    expect(after.takerUsdt).toBe(before.takerUsdt + usdtMoved);
    expect(after.makerUsdt).toBe(before.makerUsdt - usdtMoved);
    expect(after.bob).toBe(before.bob - nexusMoved);
    expect(after.alice).toBe(before.alice + nexusMoved);
  }
  return { t, m, pairs };
}
