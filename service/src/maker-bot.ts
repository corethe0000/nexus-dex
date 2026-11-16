//an always-on maker: keeps a person's offers up and carries out the swaps that come of them, without a browser page.
//It does what the page does (app/src/lib/desk.ts): posts offers signed by the EVM key, keeps them online with an agent
//key, accepts takes it can carry out, runs each swap with the same engine (core SwapRunner), puts an offer up again
//after a swap when asked to. Everything it needs to carry on after a restart is in the state file.
//The Nexus password and PIN and the EVM key are read from files the owner keeps (chmod 600); they never leave here.
import { randomBytes } from 'node:crypto';
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { hashlockUsed, offerFromJson, offerToJson, newNonce, swapRecord, takeFromJson, typed, type Json, type Offer, type TakeOut, takeProblemForMaker } from '../../core/src/book/offer';
import { EvmLeg, erc20Abi, gasShort, isNative } from '../../core/src/evm/leg';
import { NexusLeg } from '../../core/src/nexus/leg';
import type { NexusNode } from '../../core/src/nexus/node';
import { neverLocked, SwapRunner, type SwapRecord } from '../../core/src/swap/runner';
import { takerFundsProblem } from '../../core/src/book/funds';
import type { Timing } from '../../core/src/swap/timing';
import { accountsFor, createSlot, network, refresh, signIn, type NexusProfile } from '../../app/src/lib/nexus';
import type { Relay } from '../../app/src/lib/relay';

//one offer the owner wants up: sell (or buy) `amount` of a Nexus coin for `price` of an EVM token per coin
export interface WantedOffer {
  sell: boolean;
  coin: string; //Nexus token id, "0" or "NXS" for NXS
  amount: string; //in coins, e.g. "5"
  chain: string; //EVM chain id
  token: string; //EVM token symbol as the relay lists it (USDT, ETH, ...)
  price: string; //EVM token per coin
  hours?: number; //each posting stays up this long (default 24)
  again?: boolean; //post again after each swap that goes through (default: once)
}

export interface BotState {
  agentKey?: Hex;
  posted: Record<string, { id: Hex; offer: Json<Offer>; expires: number; takeId?: Hex; finished?: boolean }>; //by wanted index
  swaps: Record<string, { rec: SwapRecord; wanted: string; chainId: string; result?: string }>; //by take id
}

export interface ChainInfo {
  name: string;
  swap: Address;
  fromBlock: string;
  confirmations: number;
  finalDelay: number;
  tokens: { address: Address; symbol: string; decimals: number; maxAmount?: string }[];
}

export interface Info {
  nexus: { finalDelay: number; confirmations: number };
  chains: Record<string, ChainInfo>;
  timing: Timing;
}

export interface BotSetup {
  node: NexusNode;
  witnesses?: NexusNode[]; //other nodes that must know a taker's Nexus lock before the bot locks EVM coins against it
  relay: Relay;
  info: Info;
  nexus: { username: string; password: string; pin: string };
  evmKey: Hex;
  rpc: Record<string, string>; //chain id -> RPC
  wanted: WantedOffer[];
  state: BotState;
  save: () => void;
  log: (msg: string) => void;
}

const toUnits = (text: string, decimals: number): bigint => {
  const [w, f = ''] = text.trim().split('.');
  if (!/^\d+$/.test(w ?? '') || !/^\d*$/.test(f) || f.length > decimals) {
    throw new Error(`not an amount with at most ${decimals} decimals: ${text}`);
  }
  return BigInt(w!) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
};

export class MakerBot {
  private profile!: NexusProfile;
  private agent!: PrivateKeyAccount;
  private account: PrivateKeyAccount;
  private wallets = new Map<string, WalletClient>();
  private readers = new Map<string, PublicClient>();
  private runners = new Map<string, SwapRunner>();

  constructor(private s: BotSetup) {
    this.account = privateKeyToAccount(s.evmKey);
  }

  async start() {
    const { node, nexus, state } = this.s;
    this.profile = await signIn(node, nexus.username, nexus.password, nexus.pin);
    this.s.log(`signed in to Nexus as ${this.profile.username}, EVM address ${this.account.address}`);
    state.agentKey ??= `0x${randomBytes(32).toString('hex')}` as Hex;
    this.agent = privateKeyToAccount(state.agentKey);
    this.s.save();
    //a maker that buys Nexus coins collects them with the swap's secret through its reveal slot
    if (this.s.wanted.some((w) => !w.sell) && !this.profile.slotReady) {
      this.s.log('setting up swaps on the Nexus profile (reveal slot)');
      await node.waitConfirmed(await createSlot(this.profile, await network(node)), 1, 600000);
      await refresh(node, this.profile);
    }
  }

  private chainOf(id: string) {
    const c = this.s.info.chains[id];
    const rpc = this.s.rpc[id];
    if (!c || !rpc) {
      throw new Error(`chain ${id} is not on the relay or has no RPC in the config`);
    }
    return defineChain({ id: Number(id), name: c.name, nativeCurrency: { name: 'gas', symbol: 'GAS', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  }

  private wallet(id: string): WalletClient {
    let w = this.wallets.get(id);
    if (!w) {
      w = createWalletClient({ account: this.account, chain: this.chainOf(id), transport: http(this.s.rpc[id]) });
      this.wallets.set(id, w);
    }
    return w;
  }

  private reader(id: string): PublicClient {
    let r = this.readers.get(id);
    if (!r) {
      r = createPublicClient({ chain: this.chainOf(id), transport: http(this.s.rpc[id]) }) as PublicClient;
      this.readers.set(id, r);
    }
    return r;
  }

  //the offer for one wanted entry with today's balances, or why it cannot go up now
  private async build(w: WantedOffer): Promise<Omit<Offer, 'agent' | 'nonce' | 'maker'> | string> {
    const c = this.s.info.chains[w.chain];
    const t = c?.tokens.find((x) => x.symbol === w.token);
    if (!c || !t) {
      return `${w.token} on chain ${w.chain} is not traded on this relay`;
    }
    const coin = w.coin === 'NXS' ? '0' : w.coin;
    const accounts = accountsFor(this.profile, coin);
    const decimals = accounts[0]?.decimals ?? (coin === '0' ? 6 : undefined);
    if (decimals === undefined) {
      return `the Nexus profile has no account for ${w.coin}`;
    }
    const nexusAmount = toUnits(w.amount, decimals);
    const evmAmount = (nexusAmount * toUnits(w.price, t.decimals)) / 10n ** BigInt(decimals);
    const acct = w.sell ? accounts.find((a) => a.balance >= nexusAmount) : accounts[0];
    if (!acct) {
      return `no ${w.coin} account holds ${w.amount}`;
    }
    if (!w.sell) {
      const r = this.reader(w.chain);
      const bal = isNative(t.address) ? await r.getBalance({ address: this.account.address }) : await r.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [this.account.address] });
      if (bal < evmAmount) {
        return `the EVM address holds less than ${evmAmount} base units of ${t.symbol}`;
      }
    }
    return {
      nexusAccount: acct.address,
      nexusGenesis: this.profile.genesis,
      makerGivesNexus: w.sell,
      nexusToken: coin,
      nexusAmount,
      evmChainId: BigInt(w.chain),
      evmToken: t.address,
      evmAmount,
      expires: BigInt(Math.floor(Date.now() / 1000) + Math.round((w.hours ?? 24) * 3600)),
    };
  }

  //puts up every wanted offer that has none open: never posted, expired, or (with again) its swap went through
  async keepOffersUp(now: number) {
    let refreshed = false;
    for (const [i, w] of this.s.wanted.entries()) {
      const key = String(i);
      const p = this.s.state.posted[key];
      if (p && !p.takeId && p.expires > now + 60) {
        continue; //still open
      }
      if (p?.takeId) {
        const sw = this.s.state.swaps[p.takeId];
        if (!sw?.result) {
          continue; //its swap is still running
        }
        if (sw.result === 'swapped' && !w.again) {
          if (!p.finished) {
            p.finished = true;
            this.s.log(`offer ${key} went through; not posted again (again is off)`);
            this.s.save();
          }
          continue;
        }
      }
      if (!refreshed) {
        await refresh(this.s.node, this.profile);
        refreshed = true;
      }
      const o = await this.build(w);
      if (typeof o === 'string') {
        this.s.log(`offer ${key} not posted: ${o}`);
        continue;
      }
      const offer: Offer = { ...o, maker: this.account.address, agent: this.agent.address, nonce: newNonce() };
      const sig = await this.account.signTypedData(typed('Offer', offer) as any);
      const { id } = await this.s.relay.post(offerToJson(offer), sig);
      this.s.state.posted[key] = { id, offer: offerToJson(offer), expires: Number(offer.expires) };
      this.s.save();
      const ticker = accountsFor(this.profile, o.nexusToken)[0]?.ticker ?? w.coin;
      this.s.log(`offer ${key} up: ${w.sell ? 'sell' : 'buy'} ${w.amount} ${ticker} at ${w.price} ${w.token} (${id.slice(0, 10)})`);
    }
  }

  //tells the relay this maker is online and accepts the takes it can carry out
  async beat() {
    const at = Math.floor(Date.now() / 1000);
    const { takes } = await this.s.relay.alive(this.agent.address, at, await this.agent.signTypedData(typed('Alive', { agent: this.agent.address, at: BigInt(at) }) as any));
    for (const t of takes) {
      await this.consider(t);
    }
  }

  private async consider(t: TakeOut) {
    if (this.s.state.swaps[t.id]) {
      return;
    }
    const entry = Object.entries(this.s.state.posted).find(([, p]) => p.id === t.offer.id);
    if (!entry) {
      this.s.log(`take ${t.id.slice(0, 10)} is not for an offer of this maker, left`);
      return;
    }
    if (entry[1].takeId || entry[1].expires <= Date.now() / 1000) {
      this.s.log(`take ${t.id.slice(0, 10)} left: the offer is already taken or has expired`);
      return;
    }
    if (hashlockUsed(t, Object.values(this.s.state.swaps).map((s) => s.rec))) {
      this.s.log(`take ${t.id.slice(0, 10)} left: its hashlock was used in another swap`);
      return;
    }
    //my own copy of the offer, never the relay's (it could hand back other terms under my offer's id)
    const offer = offerFromJson(entry[1].offer);
    const problem = await takeProblemForMaker(offer, entry[1].id, t, Math.floor(Date.now() / 1000));
    if (problem) {
      this.s.log(`take ${t.id.slice(0, 10)} left: ${problem}`);
      return;
    }
    //what I give must still be there, after what my other running swaps will still lock from it
    const promised = this.unlocked(offer);
    if (offer.makerGivesNexus) {
      await refresh(this.s.node, this.profile);
      const acct = this.profile.accounts.find((a) => a.address === offer.nexusAccount);
      if (!acct || acct.balance - promised < offer.nexusAmount) {
        this.s.log(`take ${t.id.slice(0, 10)} left: the Nexus account does not hold the amount beside my other swaps`);
        return;
      }
    } else {
      const client = this.reader(offer.evmChainId.toString());
      const balance = await (isNative(offer.evmToken) ? client.getBalance({ address: offer.maker }) : client.readContract({ address: offer.evmToken, abi: erc20Abi, functionName: 'balanceOf', args: [offer.maker] })).catch(() => null);
      if (balance === null || balance - promised < offer.evmAmount) {
        this.s.log(`take ${t.id.slice(0, 10)} left: the wallet does not hold the amount beside my other swaps`);
        return;
      }
    }
    //and the gas for my own lock or claim on the EVM chain (a native coin I lock comes on top)
    const promisedNative = !offer.makerGivesNexus && isNative(offer.evmToken) ? promised + offer.evmAmount : 0n;
    const short = await gasShort(this.reader(offer.evmChainId.toString()), offer.maker, promisedNative).catch(() => ({ has: 0n, needs: 0n }));
    if (short) {
      this.s.log(`take ${t.id.slice(0, 10)} left: the wallet holds too little of the chain's coin for the gas (${short.has} of ${short.needs})`);
      return;
    }
    const takerProblem = await takerFundsProblem(offer, takeFromJson(t.take), this.reader(offer.evmChainId.toString()), this.s.node);
    if (takerProblem) {
      this.s.log(`take ${t.id.slice(0, 10)} left: ${takerProblem}`);
      return;
    }
    await this.s.relay.accept(t.id, await this.agent.signTypedData(typed('Accept', { takeId: t.id }) as any));
    entry[1].takeId = t.id;
    this.s.state.swaps[t.id] = { rec: swapRecord(offer, takeFromJson(t.take), 'participant'), wanted: entry[0], chainId: offer.evmChainId.toString() };
    this.s.save();
    this.s.log(`take ${t.id.slice(0, 10)} accepted, swap starts`);
  }

  //what my running swaps still have to lock from the same account or token as this offer (a lock already made is out
  //of the balance)
  private unlocked(like: Offer): bigint {
    let sum = 0n;
    for (const sw of Object.values(this.s.state.swaps)) {
      if (sw.result || sw.rec.done || sw.rec.aborted) {
        continue;
      }
      const r = sw.rec;
      const givesNexus = r.initiatorChain === 'evm';
      const same = like.makerGivesNexus ? givesNexus && r.nexus.from === like.nexusAccount : !givesNexus && sw.chainId === like.evmChainId.toString() && r.evm.token.toLowerCase() === like.evmToken.toLowerCase();
      const myLock = givesNexus ? r.nexusLock : r.evmLock;
      if (same && !myLock) {
        sum += BigInt(givesNexus ? r.nexus.amount : r.evm.amount);
      }
    }
    return sum;
  }

  //one step of every running swap; the record is saved after each, so a restart carries on
  async tickSwaps() {
    for (const [id, sw] of Object.entries(this.s.state.swaps)) {
      if (sw.result) {
        continue;
      }
      let r = this.runners.get(id);
      if (!r) {
        const chainId = sw.chainId;
        const c = this.s.info.chains[chainId];
        if (!c) {
          this.s.log(`swap ${id.slice(0, 10)}: its chain is not known any more`);
          continue;
        }
        const leg = new EvmLeg(this.reader(chainId), c.swap, c.confirmations, BigInt(c.fromBlock));
        r = new SwapRunner(sw.rec, new NexusLeg(this.s.node, this.s.info.nexus.confirmations, this.s.witnesses ?? []), leg, { nexus: this.profile.signer, evm: this.wallet(chainId) }, this.s.info.timing, {
          nexusFinalDelay: this.s.info.nexus.finalDelay,
          evmFinalDelay: c.finalDelay,
          resendAfter: 300,
        });
        //a lock about to be sent is saved first: a crash while sending cannot lead to a second lock after the restart
        const runner = r;
        r.onMark = () => {
          sw.rec = runner.rec;
          this.s.save();
        };
        this.runners.set(id, r);
      }
      try {
        const a = await r.tick();
        sw.rec = r.rec;
        if (a.kind === 'done' || a.kind === 'abort') {
          sw.result = a.kind === 'done' ? a.result : 'stopped';
          this.s.log(`swap ${id.slice(0, 10)}: ${sw.result}${'reason' in a && a.reason ? ` (${a.reason})` : ''}`);
          this.runners.delete(id);
          if (a.kind === 'abort' && a.reason === neverLocked) {
            await this.reopen(id, sw.wanted);
          }
        }
      } catch (e) {
        this.s.log(`swap ${id.slice(0, 10)}: ${(e as Error).message.split('\n')[0]}`);
      }
      this.s.save();
    }
  }

  //the taker never locked: the offer opens again on the relay while it runs
  private async reopen(takeId: string, wanted: string) {
    const p = this.s.state.posted[wanted];
    if (!p || p.takeId !== takeId || p.expires <= Date.now() / 1000) {
      return;
    }
    try {
      await this.s.relay.void(takeId as Hex, await this.agent.signTypedData(typed('Void', { takeId: takeId as Hex }) as any));
      p.takeId = undefined;
      this.s.log(`offer ${wanted} open again: the taker never locked`);
    } catch (e) {
      this.s.log(`offer ${wanted} not opened again: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  //takes every open offer down (on stop)
  async withdrawAll() {
    for (const p of Object.values(this.s.state.posted)) {
      if (!p.takeId && p.expires > Date.now() / 1000) {
        await this.s.relay.cancel(p.id, await this.agent.signTypedData(typed('Cancel', { offerId: p.id }) as any)).catch(() => {});
        p.expires = 0;
      }
    }
    this.s.save();
  }
}
