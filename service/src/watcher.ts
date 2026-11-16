//the watcher finishes the EVM side of accepted swaps for users whose page is closed. NexusSwap lets anyone call
//claim (pays the recipient, needs the secret) and refund (pays the sender, only after the deadline), so the watcher
//needs no user key and cannot redirect funds; it only spends its own gas. The Nexus side needs the owner's
//signature and stays with the users' own clients.
//
//per swap: once the secret is public (on the Nexus recipient's reveal slot, or on the EVM chain) and the EVM lock is
//still open before its deadline -> claim it for the recipient; once the deadline is past -> refund it to the sender.
import type { Hex, PublicClient, WalletClient } from 'viem';
import { offerFromJson, swapRecord, takeFromJson } from '../../core/src/book/offer';
import { EvmGasRefused, EvmLeg, helperMaxGas, type EvmLockExpect } from '../../core/src/evm/leg';
import { fromHexBytes, toHexBytes } from '../../core/src/nexus/bytes';
import { secretMatches } from '../../core/src/nexus/htlc';
import type { NexusLeg } from '../../core/src/nexus/leg';
import { BookError, type TakeOut } from './book';

export interface WatchChain {
  leg: EvmLeg;
  wallet?: WalletClient; //no wallet = only watch and log
  claimMargin: number; //do not send a claim this close to the deadline (it would fail and cost gas)
  claimGrace: number; //after the secret is out, leave the recipient this long to claim with its own page
  refundDelay: number;
  giveUpAfter: number; //no EVM lock this long after the accept: stop watching the swap
}

export interface Watched {
  id: Hex;
  acceptedAt: number;
  lockId?: Hex;
  fromBlock?: string; //this swap's EVM events are searched from here (set when first watched)
  secretSeenAt?: number; //the owner gets claimGrace seconds from here to claim with its own page first
  sent?: { kind: 'claim' | 'refund'; tx: Hex; at: number };
  failed?: { tries: number; next: number }; //the last looks went wrong: next look not before `next`
  done?: string;
}

//swaps looked at per round (the rest come next round, oldest look first): many open swaps cannot make one round
//take minutes
const maxPerTick = 40;
//a swap whose look or send keeps failing is looked at after 1, 2, 4 ... minutes (at most an hour), and given up
//after this many tries in a row
const maxTries = 8;

export class Watcher {
  constructor(
    readonly chains: Map<string, WatchChain>,
    readonly nexus: NexusLeg,
    readonly state: Map<Hex, Watched>,
    private log: (msg: string) => void = console.log,
    private resendAfter = 300,
    private onSwapped?: (t: TakeOut, now: number) => void, //a swap went through (the EVM lock was collected)
  ) {}

  private lastLook = new Map<Hex, number>();

  async tick(accepted: TakeOut[], now: number): Promise<void> {
    //swaps the book has forgotten are forgotten here too
    const ids = new Set(accepted.map((t) => t.id));
    for (const id of this.state.keys()) {
      if (!ids.has(id)) {
        this.state.delete(id);
        this.lastLook.delete(id);
      }
    }
    const due = accepted.filter((t) => {
      const w = this.state.get(t.id);
      return !w?.done && !(w?.failed && now < w.failed.next);
    });
    //swaps with an EVM lock found first (accepted takes that never locked cost nothing to make, so many of them must
    //not push a real swap back), then the one looked at longest ago
    //(a quarter of each round stays for the ones without a lock yet, so their lock is still found)
    const oldest = (a: TakeOut, b: TakeOut) => (this.lastLook.get(a.id) ?? 0) - (this.lastLook.get(b.id) ?? 0);
    const withLock = due.filter((t) => this.state.get(t.id)?.lockId).sort(oldest);
    const without = due.filter((t) => !this.state.get(t.id)?.lockId).sort(oldest);
    const first = withLock.slice(0, maxPerTick - Math.min(without.length, maxPerTick / 4));
    for (const t of [...first, ...without.slice(0, maxPerTick - first.length)]) {
      let w = this.state.get(t.id);
      if (!w) {
        w = { id: t.id, acceptedAt: now };
        this.state.set(t.id, w);
      }
      this.lastLook.set(t.id, now);
      try {
        await this.one(t, w, now);
        w.failed = undefined;
      } catch (e) {
        const tries = (w.failed?.tries ?? 0) + 1;
        const why = (e as Error).message.split('\n')[0];
        if (tries >= maxTries) {
          w.done = `gave up: ${why}`;
          this.log(`watch ${t.id.slice(0, 10)} - gave up after ${tries} failures: ${why}`);
        } else {
          w.failed = { tries, next: now + Math.min(3600, 30 * 2 ** tries) };
          this.log(`watch ${t.id.slice(0, 10)} - ${why}`);
        }
      }
    }
  }

  private async one(t: TakeOut, w: Watched, now: number) {
    const offer = offerFromJson(t.offer.offer);
    const rec = swapRecord(offer, takeFromJson(t.take), 'participant');
    const chain = this.chains.get(offer.evmChainId.toString());
    if (!chain) {
      w.done = 'chain not watched';
      return;
    }
    const e: EvmLockExpect = { sender: rec.evm.sender, recipient: rec.evm.recipient, token: rec.evm.token, amount: BigInt(rec.evm.amount), hashlock: `0x${rec.hashlock}`, nexusRef: rec.evm.nexusRef };
    if (!w.lockId) {
      w.fromBlock ??= (await chain.leg.searchStart()).toString();
      w.lockId = (await chain.leg.locate(e, BigInt(w.fromBlock)))?.id;
      if (!w.lockId) {
        if (now - w.acceptedAt > chain.giveUpAfter) {
          w.done = 'no EVM lock';
        }
        return;
      }
    }
    const v = await chain.leg.view(w.lockId, e);
    if (v.status === 'claimed' || v.status === 'refunded') {
      w.done = v.status;
      this.log(`watch ${t.id.slice(0, 10)} - EVM lock ${v.status}`);
      if (v.status === 'claimed') {
        this.onSwapped?.(t, now);
      }
      return;
    }
    if (v.status !== 'confirmed' && v.status !== 'claiming' && v.status !== 'refunding') {
      return;
    }
    if (w.sent && now - w.sent.at < this.resendAfter) {
      return;
    }
    const evmNow = await chain.leg.clock();
    const deadline = v.deadline!;
    if (evmNow + chain.claimMargin < deadline) {
      const secret = await this.secret(rec.nexus.recipient, rec.hashlock, chain.leg, w.lockId, w.fromBlock ? BigInt(w.fromBlock) : undefined, w.acceptedAt - 3600);
      if (secret && w.secretSeenAt === undefined) {
        w.secretSeenAt = now;
      }
      //the recipient's own page claims first; the watcher steps in when it does not, or when the deadline gets close
      const ownersTurn = w.secretSeenAt !== undefined && now - w.secretSeenAt < chain.claimGrace && deadline - evmNow > 2 * chain.claimMargin;
      if (secret && chain.wallet && !ownersTurn) {
        const tx = await chain.leg.guarded(chain.wallet, { fn: 'claim', id: w.lockId, secret }, helperMaxGas);
        w.sent = { kind: 'claim', tx, at: now };
        this.log(`watch ${t.id.slice(0, 10)} - claim sent for the recipient ${tx}`);
      }
      return;
    }
    //same for refunds: the sender's own page refunds first (one wallet prompt, no failing duplicate); the watcher
    //steps in when it did not
    if (evmNow >= deadline + chain.refundDelay + chain.claimGrace && chain.wallet) {
      const tx = await chain.leg.guarded(chain.wallet, { fn: 'refund', id: w.lockId }, helperMaxGas);
      w.sent = { kind: 'refund', tx, at: now };
      this.log(`watch ${t.id.slice(0, 10)} - refund sent for the sender ${tx}`);
    }
  }

  //"collect for me": a receive-only recipient's page hands over the secret, the watcher claims at once (no grace). The
  //claim pays the lock's fixed recipient, so whoever asks cannot redirect anything; only the right secret works.
  async claimFor(t: TakeOut, secret: Hex, now: number): Promise<Hex> {
    const offer = offerFromJson(t.offer.offer);
    const rec = swapRecord(offer, takeFromJson(t.take), 'participant');
    const chain = this.chains.get(offer.evmChainId.toString());
    if (!chain?.wallet) {
      throw new BookError('this relay does not collect on that chain');
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(secret) || !secretMatches(fromHexBytes(secret.slice(2)), fromHexBytes(rec.hashlock))) {
      throw new BookError('that is not the secret of this swap');
    }
    const e: EvmLockExpect = { sender: rec.evm.sender, recipient: rec.evm.recipient, token: rec.evm.token, amount: BigInt(rec.evm.amount), hashlock: `0x${rec.hashlock}`, nexusRef: rec.evm.nexusRef };
    let w = this.state.get(t.id);
    if (!w) {
      w = { id: t.id, acceptedAt: now };
      this.state.set(t.id, w);
    }
    w.fromBlock ??= (await chain.leg.searchStart()).toString();
    w.lockId ??= (await chain.leg.locate(e, BigInt(w.fromBlock)))?.id;
    if (!w.lockId) {
      throw new BookError('no EVM lock for this swap yet');
    }
    const v = await chain.leg.view(w.lockId, e);
    if (v.status === 'claimed' || v.status === 'claiming') {
      return w.sent?.kind === 'claim' ? w.sent.tx : ((await chain.leg.claimTx(w.lockId, w.fromBlock ? BigInt(w.fromBlock) : undefined)) ?? w.lockId);
    }
    if (v.status !== 'confirmed') {
      throw new BookError(`EVM lock is ${v.status}`);
    }
    if ((await chain.leg.clock()) + chain.claimMargin >= v.deadline!) {
      throw new BookError('too close to the deadline to collect');
    }
    if (w.sent?.kind === 'claim' && now - w.sent.at < this.resendAfter) {
      return w.sent.tx;
    }
    let tx: Hex;
    try {
      tx = await chain.leg.guarded(chain.wallet, { fn: 'claim', id: w.lockId, secret }, helperMaxGas);
    } catch (e) {
      //the keepers are asked at the same time; when one of them was first the lock is claimed now
      if ((await chain.leg.statePending(w.lockId)) === 'claimed') {
        this.log(`watch ${t.id.slice(0, 10)} - already collected by someone else`);
        return (await chain.leg.claimTx(w.lockId, w.fromBlock ? BigInt(w.fromBlock) : undefined)) ?? w.lockId;
      }
      if (e instanceof EvmGasRefused) {
        throw new BookError(e.message, 409);
      }
      throw e;
    }
    w.sent = { kind: 'claim', tx, at: now };
    this.log(`watch ${t.id.slice(0, 10)} - claim sent on request of the recipient ${tx}`);
    return tx;
  }

  //the secret, if it is public: the Nexus recipient's reveal slot (written when it claims there) or a claim on EVM
  private async secret(nexusRecipient: string, hashlock: string, leg: EvmLeg, lockId: Hex, from?: bigint, since?: number): Promise<Hex | null> {
    const h = fromHexBytes(hashlock);
    //deep: also the recipient's past writes, the slot may already hold something else (repeat searches are cheap);
    //since: the blocks from the swap's start, for a slot that went through another profile
    const fromNexus = await this.nexus.findSecret(nexusRecipient, h, true, undefined, since);
    if (fromNexus && secretMatches(fromNexus, h)) {
      return `0x${toHexBytes(fromNexus)}`;
    }
    const fromEvm = await leg.findSecret(lockId, from);
    return fromEvm && secretMatches(fromHexBytes(fromEvm.slice(2)), h) ? fromEvm : null;
  }
}

export function evmChain(client: PublicClient, swap: Hex, confirmations: number, fromBlock: bigint, wallet: WalletClient | undefined, o: { claimMargin: number; claimGrace: number; refundDelay: number; giveUpAfter: number }): WatchChain {
  return { leg: new EvmLeg(client, swap, confirmations, fromBlock), wallet, ...o };
}
