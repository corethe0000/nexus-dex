//offer -> take -> accept over the relay's HTTP API, then the swap on the private Nexus chain + anvil, with the
//watcher finishing the EVM side for users who closed their page. Env as in core/src/testing/local.ts:
//NEXUS_NODE=http://127.0.0.1:7080 EVM_RPC=http://127.0.0.1:8545 CONTRACTS=$HOME/dex/contracts/out npx vitest run src/relay.e2e.test.ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Address, Hex, WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, describe, expect, it } from 'vitest';
import { idOf, newNonce, offerFromJson, offerToJson, swapRecord, takeFromJson, takeToJson, typed, type Kind, type Offer, type Take } from '../../core/src/book/offer';
import { EvmLeg, erc20Abi } from '../../core/src/evm/leg';
import { toHexBytes } from '../../core/src/nexus/bytes';
import { hashOf, newSecret } from '../../core/src/nexus/htlc';
import { NexusLeg } from '../../core/src/nexus/leg';
import { localSigner } from '../../core/src/nexus/signer';
import { SwapRunner } from '../../core/src/swap/runner';
import { testTiming } from '../../core/src/swap/timing';
import { alice, bob, deploy, ensureSlot, haveLocal, keys, localChains, nudgeNexus, sleep } from '../../core/src/testing/local';
import { apiHandler } from './api';
import { Book, defaultBookSettings, type TakeOut } from './book';
import { evmChain, Watcher, type Watched } from './watcher';

describe.skipIf(!haveLocal)('relay end to end', () => {
  const { node, client, wallet } = localChains();
  const taker = wallet(keys.taker);
  const maker = wallet(keys.maker);
  const keeper = wallet(keys.watcher);
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  const sign = (w: WalletClient, kind: Kind, message: unknown): Promise<Hex> => w.signTypedData({ ...(typed(kind, message as any) as any), account: w.account! });

  async function relay(usdt: Address) {
    const book = new Book({ ...defaultBookSettings, chains: { '31337': { tokens: [usdt] } } });
    const server = createServer(apiHandler(book, () => ({})));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const api = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
      const j = await res.json();
      if (!res.ok) {
        throw new Error(`${path}: ${res.status} ${j.error}`);
      }
      return j;
    };
    return { book, api };
  }

  //maker sells TESTT for 25 USDT, taker takes it; returns the accepted take as the relay hands it out
  async function agree(usdt: Address, api: (p: string, b?: unknown) => Promise<any>, secret: Uint8Array): Promise<TakeOut> {
    const aliceGenesis = await ensureSlot(node, alice);
    const bobGenesis = await ensureSlot(node, bob);
    const testt = (await node.accountState(alice.account)).token;
    const now = Math.floor(Date.now() / 1000);
    const agent = privateKeyToAccount(generatePrivateKey()); //the maker page's session key
    const offer: Offer = { maker: maker.account!.address, agent: agent.address, nexusAccount: alice.account, nexusGenesis: aliceGenesis, makerGivesNexus: true, nexusToken: testt, nexusAmount: 4n, evmChainId: 31337n, evmToken: usdt, evmAmount: 25_000000n, expires: BigInt(now + 3600), nonce: newNonce() };
    const { id: offerId } = await api('offers', { offer: offerToJson(offer), sig: await sign(maker, 'Offer', offer) });
    expect(offerId).toBe(idOf('Offer', offer));

    //taker: picks it from the list, checks the maker's signature itself, sends its take
    const { offers } = await api('offers');
    const listed = offers.find((o: any) => o.id === offerId);
    expect(listed).toBeTruthy();
    const take: Take = { offerId, taker: taker.account!.address, agent: taker.account!.address, nexusAccount: bob.account, nexusGenesis: bobGenesis, hashlock: `0x${toHexBytes(hashOf(secret))}`, expires: BigInt(now + 600) };
    const { id: takeId } = await api('takes', { take: takeToJson(take), sig: await sign(taker, 'Take', take) });

    //maker's page: its alive beat (signed by the agent key, no wallet popup) returns the waiting take, it accepts
    const at = Math.floor(Date.now() / 1000);
    const { takes } = await api('alive', { agent: agent.address, at, sig: await agent.signTypedData(typed('Alive', { agent: agent.address, at: BigInt(at) }) as any) });
    expect(takes.map((t: TakeOut) => t.id)).toEqual([takeId]);
    await api(`takes/${takeId}/accept`, { sig: await agent.signTypedData(typed('Accept', { takeId }) as any) });
    const accepted: TakeOut = await api(`takes/${takeId}`);
    expect(accepted.status).toBe('accepted');
    return accepted;
  }

  async function run(offline: { taker: (r: SwapRunner, m: SwapRunner) => boolean; maker: (r: SwapRunner, m: SwapRunner) => boolean }, until: (t: SwapRunner, w: Watched) => boolean) {
    const { swap, usdt, fromBlock } = await deploy([taker.account!.address, maker.account!.address]);
    const { book, api } = await relay(usdt);
    const secret = newSecret();
    const accepted = await agree(usdt, api, secret);
    const offer = offerFromJson(accepted.offer.offer);
    const take = takeFromJson(accepted.take);

    const nexusLeg = new NexusLeg(node, 1);
    const evmLeg = new EvmLeg(client, swap, 2, fromBlock);
    const chains = { nexusFinalDelay: 120, evmFinalDelay: 10, resendAfter: 300 };
    const aliceGenesis = offer.nexusGenesis;
    const bobGenesis = take.nexusGenesis;
    const t = new SwapRunner(swapRecord(offer, take, 'initiator', toHexBytes(secret)), nexusLeg, evmLeg, { nexus: localSigner(node, bob, bobGenesis), evm: taker }, testTiming, chains);
    const m = new SwapRunner(swapRecord(offer, take, 'participant'), nexusLeg, evmLeg, { nexus: localSigner(node, alice, aliceGenesis), evm: maker }, testTiming, chains);
    const watched = new Map<Hex, Watched>();
    const logs: string[] = [];
    const say = (s: string) => logs.push(`${new Date().toISOString()} ${s}`);
    const watcher = new Watcher(new Map([['31337', evmChain(client, swap, 2, fromBlock, keeper, { claimMargin: testTiming.claimMargin, claimGrace: 20, refundDelay: testTiming.refundDelay, giveUpAfter: 3600 })]]), nexusLeg, watched, say, 60);

    const usdtOf = (a: Address) => client.readContract({ address: usdt, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
    const before = { taker: await usdtOf(taker.account!.address), maker: await usdtOf(maker.account!.address) };
    const off = { taker: false, maker: false };
    const end = Date.now() + 28 * 60 * 1000;
    while (Date.now() < end) {
      for (const [who, r] of [['taker', t], ['maker', m]] as const) {
        if (!off[who] && offline[who](t, m)) {
          off[who] = true;
          say(`test: ${who} closes the page`);
        }
        if (off[who] || r.rec.done || r.rec.aborted) {
          continue;
        }
        await r.tick().catch((e) => r.rec.log.push(`tick error: ${(e as Error).message}`));
      }
      await watcher.tick(book.accepted(), Math.floor(Date.now() / 1000));
      const w = watched.get(accepted.id);
      if (w && until(t, w)) {
        break;
      }
      await nudgeNexus(node, alice, 120).catch(() => false);
      await sleep(3000);
    }
    console.log([...t.rec.log, ...m.rec.log, ...logs].sort((a, b) => a.localeCompare(b)).join('\n'));
    const after = { taker: await usdtOf(taker.account!.address), maker: await usdtOf(maker.account!.address) };
    return { t, m, w: watched.get(accepted.id)!, before, after };
  }

  it('maker closes the page after its Nexus lock: the watcher claims the USDT for the maker', async () => {
    const r = await run({ taker: () => false, maker: (_t, m) => !!m.rec.nexusLock }, (t, w) => !!t.rec.done && w.done === 'claimed');
    expect(r.t.rec.done?.result).toBe('swapped');
    expect(r.w.done).toBe('claimed');
    expect(r.w.sent?.kind).toBe('claim');
    expect(r.after.maker).toBe(r.before.maker + 25_000000n);
    expect(r.after.taker).toBe(r.before.taker - 25_000000n);
  }, 30 * 60 * 1000);

  //~20 min (testTiming initiator lock)
  it('maker never locks and the taker leaves: the watcher refunds the taker after the deadline', async () => {
    const r = await run({ taker: (t) => !!t.rec.evmLock && !t.rec.pending, maker: () => true }, (_t, w) => w.done === 'refunded');
    expect(r.w.done).toBe('refunded');
    expect(r.w.sent?.kind).toBe('refund');
    expect(r.after.taker).toBe(r.before.taker);
    expect(r.after.maker).toBe(r.before.maker);
  }, 30 * 60 * 1000);
});
