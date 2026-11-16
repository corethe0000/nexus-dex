//the swaps and offers of this browser, kept in localStorage and moved on while the page is open:
//- taker: sends a take, waits for the maker's accept, then runs its side of the swap
//- maker: keeps its offers online (alive beats signed by the page's agent key), accepts takes, runs its side
//Each swap record is saved after every step, so a reload carries on where it was. The taker's secret is saved
//before the take goes out: without it the taker could only refund.
import { getAddress, isAddress, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { acceptOk, hashlockUsed, idOf, newNonce, offerFromJson, offerProblemForTaker, offerToJson, swapRecord, takeFromJson, takeProblemForMaker, takeToJson, typed, type Json, type Offer, type OfferOut, type Take, type TakeOut } from '@nexus-dex/core/src/book/offer';
import { erc20Abi, EvmLeg, gasShort, isNative } from '@nexus-dex/core/src/evm/leg';
import { toHexBytes } from '@nexus-dex/core/src/nexus/bytes';
import { hashOf, newSecret } from '@nexus-dex/core/src/nexus/htlc';
import { NexusLeg } from '@nexus-dex/core/src/nexus/leg';
import { NexusNode } from '@nexus-dex/core/src/nexus/node';
import { neverLocked, noteTx, SwapRunner, type SwapRecord } from '@nexus-dex/core/src/swap/runner';
import { takerFundsProblem } from '@nexus-dex/core/src/book/funds';
import { SlotGate, type Hold, type HoldStore } from '@nexus-dex/core/src/swap/slot-gate';
import { mergeAgents, mergeItems, stamp } from './store-merge';
import type { Action, Role } from '@nexus-dex/core/src/swap/types';
import type { RelayInfo, SiteConfig } from './config';
import { connect, readClient, signer, useChain, type EvmSession, type WalletOption } from './evm';
import { T } from './i18n';
import type { NexusProfile } from './nexus';
import { keeperClaim, type Relay } from './relay';

export type Stage = 'asking' | 'running' | 'lapsed' | 'finished';

export interface StoredSwap {
  id: Hex;
  role: Role;
  stage: Stage;
  offer: OfferOut;
  take: Json<Take>;
  rec: SwapRecord;
  createdAt: number;
  last?: { at: number; action: string; reason?: string }; //what the engine said last
  history?: { at: number; action: string; reason?: string }[]; //changes of that, newest last (for troubleshooting)
  paused?: string; //why this page cannot move it now (not signed in, wrong wallet)
  seq?: number; //raised on every change, for merging the copies of several tabs (store-merge.ts)
}

//a wallet step this page asked for and the user has not answered yet (only in memory: stale after a reload)
export interface WalletWait {
  wallet: 'nexus' | 'evm';
  step: string; //lock, reveal, claim, refund, createSlot, approve
  since: number;
}

export interface MyOffer {
  id: Hex;
  offer: Json<Offer>;
  sig: Hex;
  postedAt: number;
  cancelled?: boolean;
  takeId?: Hex; //taken: the swap that came of it
  again?: boolean; //post the same offer again after each swap that goes through
  reposted?: boolean; //posted again (the new one carries on), hidden from the list
  seq?: number;
}

//where one of my offers stands, for the list under the offer form
export type MyOfferState = 'open' | 'swapping' | 'swapped' | 'not done' | 'expired';

interface Saved {
  swaps: StoredSwap[];
  offers: MyOffer[];
  agents: Record<string, Hex>; //maker address -> agent key (holds nothing, only signs alive beats and accepts)
}


const collectHelpAfter = 90;

//swaps, offers and agent keys of one network (mainnet and testnet never mix); the first testnet build used one key
const storeKey = (net: string) => `nexus-dex:v1:${net}`;
const oldStoreKey = 'nexus-dex:v1';
const tickMs = 6000;
const beatMs = 20000;
const maxHistory = 40;
//without navigator.locks (plain http): the tab that runs the swaps renews a lease in storage; a closed tab's lease
//runs out after this long and another tab takes over
const leaseMs = 30000;

//the one-reveal-slot holds of every tab of the browser (SlotGate), one key per profile
function storedHolds(prefix: string): HoldStore {
  return {
    get: (g) => {
      try {
        return (JSON.parse(localStorage.getItem(prefix + g) ?? 'null') as Hold | null) ?? undefined;
      } catch {
        return undefined;
      }
    },
    set: (g, h) => {
      try {
        localStorage.setItem(prefix + g, JSON.stringify(h));
      } catch {
        //storage blocked: this tab alone, as before
      }
    },
    delete: (g) => {
      try {
        localStorage.removeItem(prefix + g);
      } catch {
        //nothing stored
      }
    },
  };
}

//a collect a helper says it sent must show on this page's RPC within this many looks
const collectChecks = 10;
const collectCheckMs = 2000;

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

function load(net: string): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(storeKey(net)) ?? (net === 'testnet' ? localStorage.getItem(oldStoreKey) : null) ?? 'null') as Saved | null;
    return s ?? { swaps: [], offers: [], agents: {} };
  } catch {
    return { swaps: [], offers: [], agents: {} };
  }
}

export interface DeskContext {
  net: string;
  site: SiteConfig;
  info: RelayInfo;
  relay: Relay;
  node: NexusNode;
  nexus: () => NexusProfile | null;
  evm: () => EvmSession | null;
}

export class Desk {
  private saved: Saved;
  private listeners = new Set<() => void>();
  private runners = new Map<Hex, SwapRunner>();
  private waits = new Map<Hex, WalletWait>();
  private helpers = new Map<Hex, EvmSession>(); //receive only: a wallet the user picked to send the collect itself
  private readers = new Map<string, PublicClient>();
  private timer: number | undefined;
  private beatTimer: number | undefined;
  private busy = false;
  version = 0;
  lastError: string | null = null;
  //several tabs of the page: a swap moves on in one tab at a time (else two tabs could each send its lock), the one
  //holding its lock (navigator.locks, or a lease in storage on plain http), after reading its newest record
  private readonly tab = Math.random().toString(36).slice(2);
  private gate: SlotGate;
  private stamped = new Map<string, string>(); //id -> content when its seq was last set
  private gone = new Set<string>(); //swaps this tab removed (a failed take): not brought back from another copy
  private onStorage = (e: StorageEvent) => {
    if (e.key === storeKey(this.ctx.net)) {
      this.merge(load(this.ctx.net));
      this.version++;
      this.listeners.forEach((f) => f());
    }
  };

  constructor(private ctx: DeskContext) {
    this.saved = load(ctx.net);
    this.restamp([...this.saved.swaps, ...this.saved.offers]);
    this.gate = new SlotGate(storedHolds(`${storeKey(ctx.net)}:slot:`));
  }

  //--- store ---

  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };

  private restamp(items: { id: string; seq?: number }[]) {
    for (const it of items) {
      const { seq: _seq, ...rest } = it;
      this.stamped.set(it.id, json(rest));
    }
  }

  //takes in what other tabs stored: newer copies of my items, items I do not have
  private merge(stored: Saved) {
    const swaps = mergeItems(this.saved.swaps, stored.swaps, this.gone);
    const offers = mergeItems(this.saved.offers, stored.offers);
    this.saved = { swaps: swaps.items, offers: offers.items, agents: mergeAgents(this.saved.agents, stored.agents) };
    for (const id of swaps.adopted) {
      //its runner holds the old record
      this.runners.delete(id as Hex);
    }
    this.restamp([...swaps.items.filter((s) => swaps.adopted.has(s.id)), ...offers.items.filter((o) => offers.adopted.has(o.id))]);
  }

  private changed() {
    stamp(this.saved.swaps, this.stamped, json);
    stamp(this.saved.offers, this.stamped, json);
    try {
      this.merge(load(this.ctx.net));
      localStorage.setItem(storeKey(this.ctx.net), json(this.saved));
    } catch {
      //storage blocked or full: the swap keeps running in this page, it only does not survive a reload
    }
    this.version++;
    this.listeners.forEach((f) => f());
  }

  //runs fn while this tab holds the swap's lock; skipped (false) while another tab of the page holds it
  private async exclusive(id: Hex, fn: () => Promise<void>): Promise<boolean> {
    const name = `${storeKey(this.ctx.net)}:swap:${id}`;
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks) {
      return locks.request(name, { ifAvailable: true }, async (l) => {
        if (!l) {
          return false;
        }
        await fn();
        return true;
      });
    }
    //plain http has no navigator.locks: a lease in storage, renewed while fn runs (a wallet prompt can take minutes)
    const write = () => localStorage.setItem(name, JSON.stringify({ tab: this.tab, until: Date.now() + leaseMs }));
    try {
      const l = JSON.parse(localStorage.getItem(name) ?? 'null') as { tab: string; until: number } | null;
      if (l && l.tab !== this.tab && l.until > Date.now()) {
        return false;
      }
      write();
      if ((JSON.parse(localStorage.getItem(name) ?? 'null') as { tab: string } | null)?.tab !== this.tab) {
        return false;
      }
    } catch {
      //no storage: nothing is shared with other tabs either
      await fn();
      return true;
    }
    const renew = window.setInterval(write, leaseMs / 3);
    try {
      await fn();
    } finally {
      window.clearInterval(renew);
      try {
        localStorage.removeItem(name);
      } catch {
        //the lease runs out by itself
      }
    }
    return true;
  }

  swaps(): StoredSwap[] {
    return [...this.saved.swaps].sort((a, b) => b.createdAt - a.createdAt);
  }

  //receive only: the service has not collected my USDT/USDC (it failed, or nothing after collectHelpAfter s) while
  //the key is known and the lock still open. Then the user can send the collect from any wallet (collectWith).
  collectHelp(s: StoredSwap): { deadline?: number; reason?: string } | null {
    const evm = this.ctx.evm();
    const myEvm = s.role === 'initiator' ? s.take.taker : s.offer.offer.maker;
    if (s.stage !== 'running' || !evm || evm.wallet || evm.address.toLowerCase() !== myEvm.toLowerCase() || this.helpers.has(s.id)) {
      return null;
    }
    const lock = s.rec.seen?.evm;
    if (!s.rec.secret || !lock || lock.status === 'claimed' || lock.status === 'refunded' || lock.status === 'refunding') {
      return null;
    }
    const p = s.rec.pending;
    const failed = s.last?.action === 'error' ? s.last.reason : undefined;
    const slow = p?.kind === 'claim' && Date.now() / 1000 - p.at > collectHelpAfter;
    return failed || slow ? { deadline: lock.deadline, reason: failed } : null;
  }

  //collect it myself: connects the picked wallet only for this swap (the receive-only session stays) and lets the
  //runner send the claim through it at once
  async collectWith(id: Hex, option: WalletOption): Promise<void> {
    this.helpers.set(id, await connect(option));
    const r = this.runners.get(id);
    if (r?.rec.pending?.kind === 'claim') {
      r.rec.pending = undefined;
    }
    this.changed();
    void this.tick();
  }

  //the collect of my EVM payment fails or hangs (a token that froze my address refuses it): my own wallet (the lock's
  //recipient, the only one the contract lets do this) can have it paid to another address of mine with claimTo
  collectToOption(s: StoredSwap): { deadline?: number; recipient: Address } | null {
    const lock = s.rec.seen?.evm;
    const recipient = s.rec.evm.recipient;
    if (s.stage !== 'running' || !s.rec.secret || !s.rec.evmLock || !lock || (lock.status !== 'confirmed' && lock.status !== 'claiming') || !this.recipientWallet(s)) {
      return null;
    }
    const p = s.rec.pending;
    const failed = s.last?.action === 'error';
    const slow = p?.kind === 'claim' && Date.now() / 1000 - p.at > collectHelpAfter;
    //sent and gone, then sent again: a collect the chain takes but that fails there (the wallet did not refuse it)
    const again = (s.rec.txs ?? []).filter((x) => x.chain === 'evm' && x.kind === 'claim' && x.by === 'me').length >= 2;
    return failed || slow || again ? { deadline: lock.deadline, recipient } : null;
  }

  //a wallet connected here for the lock's recipient address: the page's own, or one picked to collect (collectWith)
  private recipientWallet(s: StoredSwap): EvmSession | null {
    const r = s.rec.evm.recipient.toLowerCase();
    return [this.ctx.evm(), this.helpers.get(s.id)].find((x): x is EvmSession => !!x?.wallet && x.address.toLowerCase() === r) ?? null;
  }

  async collectTo(id: Hex, toText: string): Promise<Hex> {
    const { t } = T();
    const s = this.saved.swaps.find((x) => x.id === id);
    const w = s && this.collectToOption(s) ? this.recipientWallet(s) : null;
    if (!s || !w) {
      throw new Error(t.swToUnavailable);
    }
    const chainId = s.offer.offer.evmChainId;
    const c = this.ctx.info.chains[chainId]!;
    const text = toText.trim();
    if (!isAddress(text, { strict: false }) || /^0x0{40}$/i.test(text)) {
      throw new Error(t.swToBadAddress);
    }
    const to = getAddress(text);
    const never = [s.rec.evm.recipient, c.swap, s.rec.evm.token].map((x) => x.toLowerCase());
    if (never.includes(to.toLowerCase())) {
      throw new Error(t.swToSameAddress);
    }
    const leg = new EvmLeg(this.reader(chainId), c.swap, c.confirmations, BigInt(c.fromBlock));
    const lockId = s.rec.evmLock!;
    const st = await leg.state(lockId);
    if (st.state !== 'open' || st.recipient.toLowerCase() !== s.rec.evm.recipient.toLowerCase()) {
      throw new Error(t.swToUnavailable);
    }
    await useChain(w, this.ctx.site, chainId, c);
    //marked first, so the runner does not send its own collect (which fails the same way) meanwhile
    const r = this.runners.get(id);
    const rec = r?.rec ?? s.rec;
    rec.pending = { kind: 'claim', ref: '', at: Date.now() / 1000 };
    this.changed();
    try {
      const tx = await this.inWallet(id, 'evm', 'claimTo', () => leg.claimTo(signer(w, this.ctx.site, chainId, c), lockId, `0x${s.rec.secret!}`, to));
      rec.pending = { kind: 'claim', ref: tx, at: Date.now() / 1000 };
      noteTx(rec, { chain: 'evm', kind: 'claim', by: 'me', hash: tx });
      s.rec = rec;
      this.changed();
      return tx;
    } catch (e) {
      rec.pending = undefined;
      this.changed();
      throw e;
    }
  }

  waitingFor(id: Hex): WalletWait | undefined {
    return this.waits.get(id);
  }

  //runs one wallet call of a swap and shows meanwhile that the page waits for the user there
  //other Nexus nodes that must know a lock before my EVM lock answers it (site config witnessNodes)
  private witnessNodes: NexusNode[] | null = null;
  private witnesses(): NexusNode[] {
    this.witnessNodes ??= (this.ctx.site.witnessNodes ?? []).map((u) => new NexusNode(u));
    return this.witnessNodes;
  }

  private async inWallet<T>(id: Hex, wallet: WalletWait['wallet'], step: string, call: () => Promise<T>): Promise<T> {
    this.waits.set(id, { wallet, step, since: Date.now() });
    this.version++;
    this.listeners.forEach((f) => f());
    try {
      return await call();
    } finally {
      this.waits.delete(id);
      this.version++;
      this.listeners.forEach((f) => f());
    }
  }

  myOffers(maker?: Address): MyOffer[] {
    return this.saved.offers.filter((o) => !o.cancelled && !o.reposted && (!maker || o.offer.maker.toLowerCase() === maker.toLowerCase()));
  }

  offerState(o: MyOffer): MyOfferState {
    if (o.takeId) {
      const sw = this.saved.swaps.find((x) => x.id === o.takeId);
      if (!sw || sw.stage === 'running' || sw.stage === 'asking') {
        return 'swapping';
      }
      return sw.rec.done?.result === 'swapped' ? 'swapped' : 'not done';
    }
    return Number(o.offer.expires) > Date.now() / 1000 ? 'open' : 'expired';
  }

  //the same terms again, for as long as the first one was up; the old entry steps aside
  async repost(id: Hex): Promise<MyOffer> {
    const old = this.saved.offers.find((o) => o.id === id);
    if (!old) {
      throw new Error(T().t.deskOfferGone);
    }
    const o = offerFromJson(old.offer);
    const lasted = Math.max(3600, Number(o.expires) - old.postedAt);
    const next = await this.postOffer(
      { nexusAccount: o.nexusAccount, nexusGenesis: o.nexusGenesis, makerGivesNexus: o.makerGivesNexus, nexusToken: o.nexusToken, nexusAmount: o.nexusAmount, evmChainId: o.evmChainId, evmToken: o.evmToken, evmAmount: o.evmAmount, expires: BigInt(Math.floor(Date.now() / 1000) + lasted) },
      { again: old.again },
    );
    old.reposted = true;
    this.changed();
    return next;
  }

  //hides a finished or expired offer from the list
  forgetOffer(id: Hex) {
    const o = this.saved.offers.find((x) => x.id === id);
    if (o && this.offerState(o) !== 'open' && this.offerState(o) !== 'swapping') {
      o.cancelled = true;
      this.changed();
    }
  }

  activeCount(): number {
    return this.saved.swaps.filter((s) => s.stage === 'asking' || s.stage === 'running').length;
  }

  start() {
    this.stop();
    window.addEventListener('storage', this.onStorage);
    this.timer = window.setInterval(() => void this.tick(), tickMs);
    this.beatTimer = window.setInterval(() => void this.beat(), beatMs);
    void this.tick();
    void this.beat();
  }

  stop() {
    window.clearInterval(this.timer);
    window.clearInterval(this.beatTimer);
    window.removeEventListener('storage', this.onStorage);
  }

  //after a sign-in, sign-out or wallet change: runners are made again with the new signers
  sessionsChanged() {
    this.runners.clear();
    void this.tick();
    void this.beat();
  }

  //--- helpers ---

  private reader(chainId: string): PublicClient {
    let c = this.readers.get(chainId);
    if (!c) {
      c = readClient(this.ctx.site, chainId, this.ctx.info.chains[chainId]!);
      this.readers.set(chainId, c);
    }
    return c;
  }

  private agent(maker: Address): PrivateKeyAccount {
    const k = maker.toLowerCase();
    //another tab may have made it already
    let key = this.saved.agents[k] ?? load(this.ctx.net).agents[k];
    if (key && !this.saved.agents[k]) {
      this.saved.agents[k] = key;
    }
    if (!key) {
      key = generatePrivateKey();
      this.saved.agents[k] = key;
      this.changed();
    }
    return privateKeyToAccount(key);
  }

  private async evmFor(chainId: string, address: Address) {
    const s = this.ctx.evm();
    if (!s || s.address.toLowerCase() !== address.toLowerCase()) {
      return null;
    }
    if (String(s.chainId) !== chainId) {
      await useChain(s, this.ctx.site, chainId, this.ctx.info.chains[chainId]!);
    }
    return signer(s, this.ctx.site, chainId, this.ctx.info.chains[chainId]!);
  }

  //--- taker ---

  async takeOffer(o: OfferOut, nexusAccount: string): Promise<StoredSwap> {
    const evm = this.ctx.evm();
    const nexus = this.ctx.nexus();
    const { t } = T();
    if (!evm || !nexus) {
      throw new Error(t.deskConnectBoth);
    }
    //receive only: the taker gives Nexus coins and gets USDT/USDC; a one-time key of this page signs the take
    const takeKey = evm.wallet ? null : privateKeyToAccount(generatePrivateKey());
    if (takeKey && o.offer.makerGivesNexus) {
      throw new Error(t.deskReceiveOnlyPays);
    }
    //the offer as signed by its maker: a relay cannot change its terms
    const bad = await offerProblemForTaker(o);
    if (bad) {
      throw new Error(t.deskOfferNotGenuine);
    }
    const secret = newSecret();
    const now = Math.floor(Date.now() / 1000);
    const take: Take = { offerId: o.id, taker: evm.address, agent: takeKey?.address ?? evm.address, nexusAccount, nexusGenesis: nexus.genesis, hashlock: `0x${toHexBytes(hashOf(secret))}`, expires: BigInt(now + 600) };
    const id = idOf('Take', take);
    const rec = swapRecord(offerFromJson(o.offer), take, 'initiator', toHexBytes(secret));
    //the secret is saved before anyone sees the take
    const s: StoredSwap = { id, role: 'initiator', stage: 'asking', offer: o, take: takeToJson(take), rec, createdAt: now };
    this.saved.swaps.push(s);
    this.changed();
    //read back: a secret that only lives in this page is lost with it (closed tab, reload) after the lock
    if (!load(this.ctx.net).swaps.some((x) => x.id === id && x.rec.secret === rec.secret)) {
      this.saved.swaps = this.saved.swaps.filter((x) => x.id !== id);
      this.gone.add(id);
      this.changed();
      throw new Error(t.deskSecretNotSaved);
    }
    try {
      const sig = takeKey ? await takeKey.signTypedData(typed('Take', take) as any) : await (await this.evmFor(o.offer.evmChainId, evm.address))!.signTypedData({ ...(typed('Take', take) as any), account: evm.address });
      await this.ctx.relay.take(takeToJson(take), sig);
    } catch (e) {
      this.saved.swaps = this.saved.swaps.filter((x) => x.id !== id);
      this.gone.add(id);
      this.changed();
      throw e;
    }
    return s;
  }

  //--- maker ---

  async postOffer(o: Omit<Offer, 'agent' | 'nonce' | 'maker'>, opts: { again?: boolean } = {}): Promise<MyOffer> {
    const evm = this.ctx.evm();
    const { t } = T();
    if (!evm) {
      throw new Error(t.deskConnectEvm);
    }
    //receive only: the maker sells Nexus coins; its agent key signs the offer (offerSignerOk)
    if (!evm.wallet && !o.makerGivesNexus) {
      throw new Error(t.deskReceiveOnlyPays);
    }
    const agent = this.agent(evm.address);
    const offer: Offer = { ...o, maker: evm.address, agent: agent.address, nonce: newNonce() };
    const sig = evm.wallet ? await (await this.evmFor(offer.evmChainId.toString(), evm.address))!.signTypedData({ ...(typed('Offer', offer) as any), account: evm.address }) : await agent.signTypedData(typed('Offer', offer) as any);
    const { id } = await this.ctx.relay.post(offerToJson(offer), sig);
    const mine: MyOffer = { id, offer: offerToJson(offer), sig, postedAt: Math.floor(Date.now() / 1000), again: opts.again || undefined };
    this.saved.offers.push(mine);
    this.changed();
    return mine;
  }

  async cancelOffer(id: Hex): Promise<void> {
    const mine = this.saved.offers.find((o) => o.id === id);
    if (!mine) {
      return;
    }
    const agent = this.agent(mine.offer.maker);
    await this.ctx.relay.cancel(id, await agent.signTypedData(typed('Cancel', { offerId: id }) as any)).catch((e) => {
      if (e.status !== 409 && e.status !== 404) {
        throw e;
      }
    });
    mine.cancelled = true;
    this.changed();
  }

  //keeps this page's offers online and accepts takes that this page can carry out
  private async beat() {
    const nexus = this.ctx.nexus();
    const evm = this.ctx.evm();
    const now = Math.floor(Date.now() / 1000);
    const makers = new Set(this.myOffers().filter((o) => Number(o.offer.expires) > now).map((o) => o.offer.maker.toLowerCase()));
    for (const maker of makers) {
      //offers only show while this page can also do the swap
      if (!nexus || !evm || evm.address.toLowerCase() !== maker) {
        continue;
      }
      const agent = this.agent(maker as Address);
      try {
        const at = Math.floor(Date.now() / 1000);
        const { takes } = await this.ctx.relay.alive(agent.address, at, await agent.signTypedData(typed('Alive', { agent: agent.address, at: BigInt(at) }) as any));
        for (const t of takes) {
          await this.consider(t, agent, nexus);
        }
        this.lastError = null;
      } catch (e) {
        this.lastError = (e as Error).message;
        console.warn('offers online:', e);
        this.changed();
      }
    }
  }

  private async consider(t: TakeOut, agent: PrivateKeyAccount, nexus: NexusProfile) {
    if (this.saved.swaps.some((s) => s.id === t.id)) {
      return;
    }
    //my own copy of the offer, never the relay's (it could hand back other terms under my offer's id)
    const own = this.saved.offers.find((o) => o.id === t.offer.id && !o.cancelled);
    const offer = own ? offerFromJson(own.offer) : null;
    if (!own || !offer || offer.nexusGenesis !== nexus.genesis) {
      console.warn('take not for an offer of this page', t.id);
      return;
    }
    //an offer is filled once and only while it runs, whatever the relay says
    if (own.takeId || offer.expires <= BigInt(Math.floor(Date.now() / 1000))) {
      console.warn('take left: the offer is already taken or has expired', t.id);
      return;
    }
    if (hashlockUsed(t, this.saved.swaps.map((s) => s.rec))) {
      console.warn('take left: its hashlock was used in another swap', t.id);
      return;
    }
    const problem = await takeProblemForMaker(offer, own.id, t, Math.floor(Date.now() / 1000));
    if (problem) {
      console.warn(`take left: ${problem}`, t.id);
      return;
    }
    //what I give must still be there, after what my other running swaps will still lock from it
    if (offer.makerGivesNexus) {
      const acct = nexus.accounts.find((a) => a.address === offer.nexusAccount);
      const promised = this.unlocked((o) => o.makerGivesNexus && o.nexusAccount === offer.nexusAccount, (o) => o.nexusAmount);
      if (!acct || acct.balance - promised < offer.nexusAmount) {
        console.warn('take left: the Nexus account does not hold the amount beside my other swaps', t.id);
        return;
      }
    } else {
      const chainId = String(offer.evmChainId);
      const token = offer.evmToken.toLowerCase();
      const client = this.reader(chainId);
      const balance = await (isNative(token) ? client.getBalance({ address: offer.maker }) : client.readContract({ address: offer.evmToken, abi: erc20Abi, functionName: 'balanceOf', args: [offer.maker] })).catch(() => null);
      const promised = this.unlocked((o) => !o.makerGivesNexus && String(o.evmChainId) === chainId && o.evmToken.toLowerCase() === token, (o) => o.evmAmount);
      if (balance === null || balance - promised < offer.evmAmount) {
        console.warn('take left: the wallet does not hold the amount beside my other swaps', t.id);
        return;
      }
    }
    //and the gas for my own lock or claim (receive only: the relay or a keeper pays for the collect)
    if (this.ctx.evm()?.wallet) {
      const chainId = String(offer.evmChainId);
      const native = !offer.makerGivesNexus && isNative(offer.evmToken) ? this.unlocked((o) => !o.makerGivesNexus && String(o.evmChainId) === chainId && isNative(o.evmToken), (o) => o.evmAmount) + offer.evmAmount : 0n;
      const short = await gasShort(this.reader(chainId), offer.maker, native).catch(() => ({ has: 0n, needs: 0n }));
      if (short) {
        console.warn(`take left: the wallet holds too little of the chain's coin for the gas (${short.has} of ${short.needs})`, t.id);
        return;
      }
    }
    const takerProblem = await takerFundsProblem(offer, takeFromJson(t.take), this.reader(String(offer.evmChainId)), this.ctx.node);
    if (takerProblem) {
      console.warn(`take left: ${takerProblem}`, t.id);
      return;
    }
    await this.ctx.relay.accept(t.id, await agent.signTypedData(typed('Accept', { takeId: t.id }) as any));
    const mine = this.saved.offers.find((o) => o.id === t.offer.id);
    if (mine) {
      mine.takeId = t.id;
    }
    const rec = swapRecord(offer, takeFromJson(t.take), 'participant');
    this.saved.swaps.push({ id: t.id, role: 'participant', stage: 'running', offer: { ...t.offer, offer: own.offer, sig: own.sig }, take: t.take, rec, createdAt: Math.floor(Date.now() / 1000) });
    this.changed();
  }

  //a swap can be stopped by this side as long as nothing of its own is locked or being locked; the other side's
  //lock (if any) comes back to it at its deadline
  canStop(s: StoredSwap): boolean {
    if (s.stage !== 'running' && s.stage !== 'asking') {
      return false;
    }
    const mineIsNexus = (s.role === 'initiator') === (s.rec.initiatorChain === 'nexus');
    const myLock = mineIsNexus ? s.rec.nexusLock : s.rec.evmLock;
    return !myLock && s.rec.pending?.kind !== 'lock';
  }

  //what my running maker swaps that match still have to lock (a lock already made is out of the balance)
  private unlocked(match: (o: Offer) => boolean, amount: (o: Offer) => bigint): bigint {
    let sum = 0n;
    for (const s of this.saved.swaps) {
      if (s.role !== 'participant' || (s.stage !== 'running' && s.stage !== 'asking') || s.rec.done || s.rec.aborted) {
        continue;
      }
      const o = offerFromJson(s.offer.offer);
      const myLock = o.makerGivesNexus ? s.rec.nexusLock : s.rec.evmLock;
      if (match(o) && !myLock) {
        sum += amount(o);
      }
    }
    return sum;
  }

  stopSwap(id: Hex) {
    const s = this.saved.swaps.find((x) => x.id === id);
    if (!s || !this.canStop(s)) {
      return;
    }
    //saved with the swap, so it stays in the language of the moment it was stopped
    s.rec.aborted = T().t.deskStoppedBeforeLock;
    s.stage = 'finished';
    this.runners.delete(id);
    this.changed();
  }

  //--- running swaps ---

  private runnerFor(s: StoredSwap): SwapRunner | string {
    const nexus = this.ctx.nexus();
    const evm = this.ctx.evm();
    const myNexus = s.role === 'initiator' ? s.take.nexusGenesis : s.offer.offer.nexusGenesis;
    const myEvm = s.role === 'initiator' ? s.take.taker : s.offer.offer.maker;
    const { t, f } = T();
    if (!nexus || nexus.genesis !== myNexus) {
      return t.deskSignInProfile;
    }
    if (!evm || evm.address.toLowerCase() !== myEvm.toLowerCase()) {
      return f(t.deskConnectWallet, { address: `${myEvm.slice(0, 6)}...${myEvm.slice(-4)}` });
    }
    let r = this.runners.get(s.id);
    if (!r) {
      const chainId = s.offer.offer.evmChainId;
      const c = this.ctx.info.chains[chainId]!;
      const leg = new EvmLeg(this.reader(chainId), c.swap, c.confirmations, BigInt(c.fromBlock));
      //every EVM step is one writeContract: approve, lock, claim, refund
      let w: WalletClient;
      if (evm.wallet) {
        const plainW = signer(evm, this.ctx.site, chainId, c);
        w = { ...plainW, writeContract: ((args: { functionName: string }) => this.inWallet(s.id, 'evm', args.functionName, () => plainW.writeContract(args as never))) as typeof plainW.writeContract };
      } else {
        //receive only: this side's one EVM step is the claim, which the relay's watcher sends (Relay.claim), or a
        //wallet the user picked to collect it itself (collectWith; any address may send it, it pays the recipient)
        const relay = this.ctx.relay;
        w = {
          account: { address: evm.address, type: 'json-rpc' },
          writeContract: async (args: { functionName: string; args: readonly unknown[] }) => {
            if (args.functionName !== 'claim') {
              throw new Error(T().t.deskReceiveOnlyPays);
            }
            const helper = this.helpers.get(s.id);
            if (helper) {
              await useChain(helper, this.ctx.site, chainId, c);
              const hw = signer(helper, this.ctx.site, chainId, c);
              return this.inWallet(s.id, 'evm', 'claim', () => hw.writeContract({ ...(args as any), account: helper.address, chain: hw.chain }));
            }
            //the relay and every independent keeper at once: the first that sends it wins, one being down changes nothing
            const [lockId, secret] = args.args as [Hex, Hex];
            //an answer counts once this page's own RPC shows that transaction, or the lock collected: a helper
            //answering with a made-up hash cannot make the page wait for nothing
            const real = (p: Promise<Hex>) =>
              p.then(async (tx) => {
                for (let i = 0; i < collectChecks; i++) {
                  const ok = await this.reader(chainId)
                    .getTransaction({ hash: tx })
                    .then((x) => x.to?.toLowerCase() === c.swap.toLowerCase())
                    .catch(async () => (await leg.state(lockId).catch(() => null))?.state === 'claimed');
                  if (ok) {
                    return tx;
                  }
                  await new Promise((res) => setTimeout(res, collectCheckMs));
                }
                throw new Error(`collect ${tx} not found on the chain`);
              });
            const asks = [real(relay.claim(s.id, secret).then((r) => r.tx)), ...(this.ctx.site.keepers ?? []).map((k) => real(keeperClaim(k, chainId, lockId, secret)))];
            try {
              return await Promise.any(asks);
            } catch (e) {
              throw (e as AggregateError).errors?.[0] ?? e;
            }
          },
        } as unknown as WalletClient;
      }
      //a Nexus step waits for the user only through the wallet extension; in the page it signs at once
      const ns = nexus.signer;
      const nw: typeof ns =
        nexus.via === 'extension'
          ? {
              genesis: ns.genesis,
              createSlot: (...a) => this.inWallet(s.id, 'nexus', 'createSlot', () => ns.createSlot(...a)),
              lock: (...a) => this.inWallet(s.id, 'nexus', 'lock', () => ns.lock(...a)),
              reveal: (...a) => this.inWallet(s.id, 'nexus', 'reveal', () => ns.reveal(...a)),
              claim: (...a) => this.inWallet(s.id, 'nexus', 'claim', () => ns.claim(...a)),
              refund: (...a) => this.inWallet(s.id, 'nexus', 'refund', () => ns.refund(...a)),
              market: ns.market,
              collect: ns.collect,
            }
          : ns;
      r = new SwapRunner(s.rec, new NexusLeg(this.ctx.node, this.ctx.info.nexus.confirmations, this.witnesses()), leg, { nexus: nw, evm: w }, this.ctx.info.timing, {
        nexusFinalDelay: this.ctx.info.nexus.finalDelay,
        evmFinalDelay: c.finalDelay,
        resendAfter: 300,
      }, this.gate);
      //a lock about to be sent, the secret about to go out: saved before the wallet is asked, so a crash or a closed
      //tab during the prompt cannot lead to a second lock
      const runner = r;
      r.onMark = () => {
        const cur = this.saved.swaps.find((x) => x.id === s.id);
        if (cur) {
          cur.rec = runner.rec;
          this.changed();
        }
      };
      this.runners.set(s.id, r);
    }
    return r;
  }

  async tick() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      for (const id of this.saved.swaps.map((x) => x.id)) {
        //looked up each time: a copy from another tab may have replaced it meanwhile
        const s = () => this.saved.swaps.find((x) => x.id === id);
        //one swap that throws must never hold up the claims and refunds of the ones after it
        try {
          if (s()?.stage === 'asking') {
            await this.ask(s()!);
          }
          if (s()?.stage === 'running') {
            await this.exclusive(id, async () => {
              //what another tab did with it last
              this.merge(load(this.ctx.net));
              const cur = s();
              if (cur?.stage === 'running') {
                await this.run(cur);
              }
            });
          }
        } catch (e) {
          console.warn(`swap ${id}:`, e);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async ask(s: StoredSwap) {
    const t = await this.ctx.relay.get(s.id).catch(() => null);
    //accepted only with the maker's own signature on this take (a relay saying so is not enough to lock)
    if (t?.status === 'accepted' && (await acceptOk(offerFromJson(s.offer.offer), s.id, t.acceptSig))) {
      s.stage = 'running';
      this.changed();
    } else if (t?.status === 'lapsed' || (!t && Date.now() / 1000 - s.createdAt > 600)) {
      s.stage = 'lapsed';
      this.changed();
    }
  }

  private note(s: StoredSwap, entry: NonNullable<StoredSwap['last']>) {
    const h = (s.history ??= []);
    const prev = h[h.length - 1];
    if (!prev || prev.action !== entry.action || prev.reason !== entry.reason) {
      h.push(entry);
      if (h.length > maxHistory) {
        h.splice(0, h.length - maxHistory);
      }
    }
    s.last = entry;
  }

  private async run(s: StoredSwap) {
    let r: SwapRunner | string;
    try {
      r = this.runnerFor(s);
    } catch (e) {
      //a chain this page no longer knows (left out of the site's list, no RPC): this swap stops, the others go on
      this.note(s, { at: Date.now(), action: 'error', reason: (e as Error).message.split('\n')[0] });
      this.changed();
      return;
    }
    if (typeof r === 'string') {
      if (s.paused !== r) {
        s.paused = r;
        this.changed();
      }
      return;
    }
    s.paused = undefined;
    //the wallet must be on the swap's chain for a lock, claim or refund there
    const chainId = s.offer.offer.evmChainId;
    const evm = this.ctx.evm();
    let a: Action;
    try {
      if (evm && String(evm.chainId) !== chainId) {
        await useChain(evm, this.ctx.site, chainId, this.ctx.info.chains[chainId]!);
      }
      a = await r.tick();
    } catch (e) {
      this.note(s, { at: Date.now(), action: 'error', reason: (e as Error).message.split('\n')[0] });
      this.changed();
      return;
    }
    s.rec = r.rec;
    this.note(s, { at: Date.now(), action: a.kind, reason: 'reason' in a ? a.reason : undefined });
    if (s.rec.done || s.rec.aborted) {
      s.stage = 'finished';
      this.afterSwap(s);
    }
    this.changed();
  }

  //the taker never locked: nothing is locked on either side, the offer opens again on the relay while it runs (the
  //agent signs, no wallet window)
  private async reopen(s: StoredSwap) {
    const mine = this.saved.offers.find((o) => o.id === s.offer.id && o.takeId === s.id);
    if (!mine || mine.cancelled || Number(mine.offer.expires) <= Date.now() / 1000) {
      return;
    }
    const agent = this.agent(mine.offer.maker);
    try {
      await this.ctx.relay.void(s.id, await agent.signTypedData(typed('Void', { takeId: s.id }) as any));
      mine.takeId = undefined;
      this.changed();
    } catch (e) {
      console.warn('offer not opened again:', e);
    }
  }

  //my offer went through and was marked "post again": put the same offer up again (the wallet signs it, or this
  //page for a receiving address). Once per swap; a failure shows like any offer problem and the offer stays listed.
  private afterSwap(s: StoredSwap) {
    if (s.role === 'participant' && s.rec.aborted === neverLocked) {
      void this.reopen(s);
      return;
    }
    if (s.role !== 'participant' || s.rec.done?.result !== 'swapped') {
      return;
    }
    const mine = this.saved.offers.find((o) => o.id === s.offer.id && o.takeId === s.id);
    if (!mine?.again || mine.reposted || mine.cancelled) {
      return;
    }
    void this.repost(mine.id).catch((e) => {
      const { t, f } = T();
      this.lastError = f(t.deskRepostFailed, { error: (e as Error).message });
      this.changed();
    });
  }
}
