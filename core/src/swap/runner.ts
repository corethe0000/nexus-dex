//drives one side of a swap: reads both chains, asks the engine, carries out the step. Everything it needs to carry
//on after a restart is in the record (persist it after every tick). The secret never leaves the initiator's record
//until its claim reveals it.
import type { Address, Hex, WalletClient } from 'viem';
import { EvmLeg, type EvmLockExpect } from '../evm/leg';
import { fromHexBytes, toHexBytes } from '../nexus/bytes';
import { secretMatches, type NexusLockTerms } from '../nexus/htlc';
import { NexusLeg, type NexusLockExpect, type NexusLockRef } from '../nexus/leg';
import type { NexusSigner } from '../nexus/signer';
import { decide, type Agreed } from './engine';
import { slotGate, type SlotGate } from './slot-gate';
import type { Timing } from './timing';
import type { Action, LockStatus, LockView, Role, SwapView } from './types';

export interface SwapRecord {
  id: string;
  role: Role;
  initiatorChain: 'nexus' | 'evm'; //where the taker locks (what the taker gives)
  hashlock: string; //hex
  createdAt?: number; //unix time the swap was agreed: locks are searched from an hour before it
  secret?: string; //hex: initiator from the start, participant once seen
  nexus: { sender: string; recipient: string; from: string; to: string; amount: string; token?: string }; //genesis x2, accounts x2, base units, agreed token ('0' = NXS)
  evm: { sender: Address; recipient: Address; token: Address; amount: string; nexusRef: Hex };
  nexusLock?: NexusLockRef;
  evmLock?: Hex;
  evmFromBlock?: string; //EVM events of this swap are searched from here (set at the first look; older records search from the deployment)
  //bumps / replaced: an EVM claim or refund stuck in the queue is sent again with a higher fee (same nonce); the
  //hashes it replaced are kept, any of them can still be the one that gets mined
  pending?: { kind: 'lock' | 'reveal' | 'claim' | 'refund'; ref: string; at: number; queuedSaid?: boolean; bumps?: number; replaced?: string[] };
  //deadline of the lock I sent: a lock sent again uses it while it still leaves enough time, so on the EVM chain it
  //is the same lock (same id, the contract refuses a second one) and never two
  lockDeadline?: number;
  //initiator: the secret went to a signer (reveal or claim); from then on only claiming is safe (SwapView.disclosed)
  disclosed?: boolean;
  done?: { result: string; reason?: string };
  //the last look at both chains (for a progress display): lock status and deadline, chain clocks
  seen?: { at: number; nexus: { status: LockStatus; deadline?: number }; evm: { status: LockStatus; deadline?: number }; nexusNow: number; evmNow: number; firstLockAt?: number };
  aborted?: string;
  //every transaction of this swap that is known, own and the other side's, for links to an explorer
  txs?: SwapTx[];
  log: string[];
}

export interface SwapTx {
  chain: 'nexus' | 'evm';
  kind: 'lock' | 'reveal' | 'claim' | 'refund';
  by: 'me' | 'them' | 'helper'; //helper = the relay or a keeper collected for me
  hash: string;
}

//adds a transaction once (the same hash can be seen again on every look at the chains)
export function noteTx(rec: SwapRecord, t: SwapTx) {
  rec.txs ??= [];
  if (!rec.txs.some((x) => x.hash === t.hash)) {
    rec.txs.push(t);
  }
}

export interface Signers {
  nexus: NexusSigner;
  evm: WalletClient;
}

//the maker gave up because the taker never locked: nothing of either side is locked, the offer can open again
export const neverLocked = 'the other side never locked';

//two transactions of one sigchain need this much between them on Nexus (the fee-free interval)
const nexusTxGap = 10;
//how far the local clock may be ahead before its floor (ChainTime.floor) changes a decision
const clockTolerance = 120;
//an EVM claim or refund waiting in the queue gets a higher fee at most this often (each time 30 % or more)
const maxBumps = 10;
//wallet error codes that mean nothing was sent: refused by the user, not connected or logged in, locked, busy
const notSentCodes = new Set([4001, 4100, 4200, 4900, -32002]);

function nothingSent(e: unknown): boolean {
  let c: any = e;
  for (let i = 0; c && i < 8; i++, c = c.cause) {
    if (typeof c.code === 'number' && notSentCodes.has(c.code)) {
      return true;
    }
  }
  return false;
}

export interface ChainSettings {
  nexusFinalDelay: number;
  evmFinalDelay: number;
  resendAfter: number; //a sent step not seen on its chain after this long is sent again
}

export class SwapRunner {
  //called when the record holds a mark that must outlive a crash, right before a signer is asked (a lock about to be
  //sent, the secret about to go out): the owner saves the record there
  onMark?: () => void;

  constructor(
    readonly rec: SwapRecord,
    readonly nexus: NexusLeg,
    readonly evm: EvmLeg,
    readonly signers: Signers,
    readonly timing: Timing,
    readonly chains: ChainSettings,
    readonly gate: SlotGate = slotGate,
  ) {}

  //how long a slot holder may go without asking before another swap of the profile takes the slot
  private maxHold(): number {
    return 4 * (2 * this.chains.nexusFinalDelay + nexusTxGap) + this.chains.resendAfter;
  }

  //I claim on Nexus and hold my profile's slot: let it go once my credit is final (or the swap is over), else say I
  //still need it
  private keepSlot(nexusClaimed: boolean) {
    if (this.myChain() !== 'evm') {
      return;
    }
    const g = this.signers.nexus.genesis;
    if (this.gate.holder(g) !== this.rec.id) {
      return;
    }
    if (nexusClaimed || this.rec.done || this.rec.aborted) {
      this.gate.release(g, this.rec.id);
    } else {
      this.gate.acquire(g, this.rec.id, Date.now() / 1000, this.maxHold());
    }
  }

  private say(msg: string) {
    this.rec.log.push(`${new Date().toISOString()} ${this.rec.role} ${msg}`);
  }

  private nexusExpect(): NexusLockExpect {
    const n = this.rec.nexus;
    return { terms: { recipient: n.recipient, sender: n.sender, hashlock: fromHexBytes(this.rec.hashlock) }, from: n.from, to: n.to, amount: BigInt(n.amount), token: n.token };
  }

  private evmExpect(): EvmLockExpect {
    const e = this.rec.evm;
    return { sender: e.sender, recipient: e.recipient, token: e.token, amount: BigInt(e.amount), hashlock: `0x${this.rec.hashlock}`, nexusRef: e.nexusRef };
  }

  //my own lock is on the initiator chain if I am the initiator
  private myChain(): 'nexus' | 'evm' {
    const i = this.rec.initiatorChain;
    return this.rec.role === 'initiator' ? i : i === 'nexus' ? 'evm' : 'nexus';
  }

  private pendingOn(chain: 'nexus' | 'evm'): 'lock' | 'claim' | 'refund' | undefined {
    const p = this.rec.pending;
    if (!p) {
      return undefined;
    }
    const mine = this.myChain();
    const kind = p.kind === 'reveal' ? 'claim' : p.kind;
    const on = kind === 'claim' ? (mine === 'nexus' ? 'evm' : 'nexus') : mine;
    return on === chain ? kind : undefined;
  }

  async view(): Promise<{ v: SwapView; nexusView: LockView; evmView: LockView }> {
    const ne = this.nexusExpect();
    const ee = this.evmExpect();
    const mine = this.myChain();
    if (!this.rec.nexusLock) {
      this.rec.nexusLock = (await this.nexus.locate(this.rec.nexus.sender, ne, (this.rec.createdAt ?? 0) - 3600)) ?? undefined;
      if (this.rec.nexusLock) {
        noteTx(this.rec, { chain: 'nexus', kind: 'lock', by: mine === 'nexus' ? 'me' : 'them', hash: this.rec.nexusLock.txid });
      }
    }
    if (this.rec.evmFromBlock === undefined && !this.rec.evmLock) {
      this.rec.evmFromBlock = (await this.evm.searchStart()).toString();
    }
    const from = this.rec.evmFromBlock !== undefined ? BigInt(this.rec.evmFromBlock) : undefined;
    if (!this.rec.evmLock) {
      const found = await this.evm.locate(ee, from);
      this.rec.evmLock = found?.id;
      if (found) {
        noteTx(this.rec, { chain: 'evm', kind: 'lock', by: mine === 'evm' ? 'me' : 'them', hash: found.tx });
      }
    }
    const [nexusView, evmView, nexusNow, evmNow] = await Promise.all([
      this.nexus.view(this.rec.nexusLock, ne, this.pendingOn('nexus')),
      this.evm.view(this.rec.evmLock, ee, this.pendingOn('evm')),
      this.nexus.clock(),
      this.evm.clock(),
    ]);
    //the EVM claim, whoever sent it (one lookup, once)
    if (this.rec.evmLock && (evmView.status === 'claimed' || evmView.status === 'claiming') && !this.rec.txs?.some((t) => t.chain === 'evm' && t.kind === 'claim')) {
      const tx = await this.evm.claimTx(this.rec.evmLock, from).catch(() => null);
      if (tx) {
        noteTx(this.rec, { chain: 'evm', kind: 'claim', by: mine === 'evm' ? 'them' : 'helper', hash: tx });
      }
    }
    //the other side's claim of my Nexus lock (my own claims and refunds are noted when sent)
    if (mine === 'nexus' && nexusView.closedBy && (nexusView.status === 'claimed' || nexusView.status === 'claiming')) {
      noteTx(this.rec, { chain: 'nexus', kind: 'claim', by: 'them', hash: nexusView.closedBy });
    }
    //the participant learns the secret from the chain of its own lock, where the initiator claims
    if (!this.rec.secret) {
      const found = this.myChain() === 'evm' ? (this.rec.evmLock ? await this.evm.findSecret(this.rec.evmLock, from) : null) : await this.nexus.findSecret(this.rec.nexus.recipient, fromHexBytes(this.rec.hashlock), nexusView.status === 'claimed' || nexusView.status === 'claiming', nexusView.closedBy, this.rec.createdAt !== undefined ? this.rec.createdAt - 3600 : undefined);
      if (found) {
        const s = typeof found === 'string' ? found.replace(/^0x/, '') : toHexBytes(found);
        if (secretMatches(fromHexBytes(s), fromHexBytes(this.rec.hashlock))) {
          this.rec.secret = s;
          this.say('secret seen on chain');
        }
      }
    }
    //the Nexus tip can be minutes old (blocks come when they come; on a private chain only with transactions) and
    //the next block's time is what the lock condition sees: take the EVM chain's newest block as a floor (EVM blocks
    //come every few seconds). The local clock of the user's PC can be wrong, so it only sets a floor (minus a
    //tolerance) for the decisions where a stalled chain would make the time left look longer than it is: still
    //time to reveal, how long their lock runs (engine latest()); never for refunds or locks
    //refunds go by the Nexus tip itself: that is what the lock condition's ledger.timestamp reads
    //a claim on Nexus is two transactions (secret into the slot, then the credit), each waiting for its block
    const floor = Date.now() / 1000 - clockTolerance;
    const nexusTime = { now: Math.max(nexusNow, evmNow), finalDelay: this.chains.nexusFinalDelay, claimDelay: 2 * this.chains.nexusFinalDelay + nexusTxGap, ledgerNow: nexusNow, floor };
    const evmTime = { now: evmNow, finalDelay: this.chains.evmFinalDelay, floor };
    const initIsNexus = this.rec.initiatorChain === 'nexus';
    //before my own lock exists on Nexus: the recipient's reveal slot must exist, or a refund could fail
    const recipientSlotReady = this.myChain() === 'nexus' ? (await this.nexus.node.slot(this.rec.nexus.recipient)) !== null : undefined;
    const v: SwapView = {
      initiatorLock: initIsNexus ? nexusView : evmView,
      participantLock: initIsNexus ? evmView : nexusView,
      initiatorChain: initIsNexus ? nexusTime : evmTime,
      participantChain: initIsNexus ? evmTime : nexusTime,
      recipientSlotReady,
      secret: this.rec.secret,
      disclosed: this.rec.role === 'initiator' ? !!this.rec.disclosed : undefined,
    };
    return { v, nexusView, evmView };
  }

  private agreed(): Agreed {
    const initIsNexus = this.rec.initiatorChain === 'nexus';
    return {
      initiatorAmount: initIsNexus ? this.rec.nexus.amount : this.rec.evm.amount,
      participantAmount: initIsNexus ? this.rec.evm.amount : this.rec.nexus.amount,
      hashlock: this.rec.hashlock,
    };
  }

  //one step; returns what the engine decided
  async tick(): Promise<Action> {
    if (this.rec.done || this.rec.aborted) {
      this.keepSlot(false);
      return this.rec.done ? { kind: 'done', result: this.rec.done.result as 'swapped' } : { kind: 'abort', reason: this.rec.aborted! };
    }
    const { v, nexusView, evmView } = await this.view();
    this.keepSlot(nexusView.status === 'claimed');
    const firstLock = this.rec.seen?.firstLockAt ?? (nexusView.status !== 'none' || evmView.status !== 'none' ? v.participantChain.now : undefined);
    this.rec.seen = {
      at: Math.floor(Date.now() / 1000),
      nexus: { status: nexusView.status, deadline: nexusView.deadline },
      evm: { status: evmView.status, deadline: evmView.deadline },
      nexusNow: this.rec.initiatorChain === 'nexus' ? v.initiatorChain.now : v.participantChain.now,
      evmNow: this.rec.initiatorChain === 'evm' ? v.initiatorChain.now : v.participantChain.now,
      firstLockAt: firstLock,
    };
    //a step I sent: clear it once the chain shows it, send again if it never shows
    const p = this.rec.pending;
    if (p) {
      const seen = await this.pendingSeen(p, v, nexusView);
      if (seen) {
        this.rec.pending = undefined;
      } else if (Date.now() / 1000 - p.at < this.patience(p, v)) {
        return { kind: 'wait', reason: `own ${p.kind} not on chain yet` };
      } else if (this.pendingOn('evm') && p.ref.startsWith('0x') && (await this.stillOnItsWay(p))) {
        return { kind: 'wait', reason: `own ${p.kind} still on its way` };
      } else {
        this.say(`${p.kind} ${p.ref} not seen after ${this.chains.resendAfter} s, trying again`);
        this.rec.pending = undefined;
      }
    }
    //maker: the taker never locked (closed its page, ran out of gas): nothing of mine is locked yet, so give up once
    //a lock that came now would be too old to accept anyway
    if (this.rec.role === 'participant' && v.initiatorLock.status === 'none' && v.participantLock.status === 'none' && !this.rec.pending && this.rec.createdAt !== undefined && Date.now() / 1000 - this.rec.createdAt > this.timing.maxLockAge) {
      this.rec.aborted = neverLocked;
      this.say(`abort: ${neverLocked}`);
      return { kind: 'abort', reason: this.rec.aborted };
    }
    let a = decide(this.rec.role, v, this.agreed(), this.timing);
    switch (a.kind) {
      case 'done':
        this.rec.done = { result: a.result, reason: a.reason };
        this.say(`done: ${a.result}${a.reason ? ' (' + a.reason + ')' : ''}`);
        break;
      case 'abort':
        this.rec.aborted = a.reason;
        this.say(`abort: ${a.reason}`);
        break;
      case 'lock': {
        //my EVM lock answers their Nexus lock: other nodes must know it too, else a lying node could have made it up
        const witness = this.myChain() === 'evm' && this.rec.nexusLock ? await this.nexus.witnessProblem(this.rec.nexusLock) : null;
        if (witness) {
          const note = `not locking yet: ${witness}`;
          if (!this.rec.log[this.rec.log.length - 1]?.endsWith(note)) {
            this.say(note);
          }
          a = { kind: 'wait', reason: witness };
          break;
        }
        await this.lock(this.lockDeadline(a.deadline, this.rec.role === 'initiator' ? v.initiatorChain.now : v.participantChain.now));
        break;
      }
      case 'claim': {
        //the first claim of their Nexus lock reveals the secret: other nodes must know that lock too, as before a lock
        const witness = this.rec.role === 'initiator' && !this.rec.disclosed && this.myChain() === 'evm' && this.rec.nexusLock ? await this.nexus.witnessProblem(this.rec.nexusLock) : null;
        if (witness) {
          const note = `not claiming yet: ${witness}`;
          if (!this.rec.log[this.rec.log.length - 1]?.endsWith(note)) {
            this.say(note);
          }
          a = { kind: 'wait', reason: witness };
          break;
        }
        if (!(await this.claim())) {
          a = { kind: 'wait', reason: 'another swap of this profile is using its reveal slot' };
        }
        break;
      }
      case 'refund':
        await this.refund();
        break;
      case 'wait':
        break;
    }
    this.keepSlot(nexusView.status === 'claimed');
    return a;
  }

  //how long a sent step may go unseen before it is looked into: a claim of a lock whose deadline is near is urgent
  //(the secret is in the queued transaction for anyone to read), so a stuck one gets a higher fee sooner
  private patience(p: NonNullable<SwapRecord['pending']>, v: SwapView): number {
    const r = this.chains.resendAfter;
    if (p.kind !== 'claim') {
      return r;
    }
    const theirs = this.rec.role === 'initiator' ? v.participantLock : v.initiatorLock;
    const now = this.rec.role === 'initiator' ? v.participantChain.now : v.initiatorChain.now;
    return theirs.deadline !== undefined && theirs.deadline - now < 4 * r ? r / 4 : r;
  }

  //an own EVM step not seen yet: still in the queue (a claim or refund then goes again with a higher fee, same
  //nonce), or in a block that is not final yet (stalled chain). Sending it again as a new transaction could put a
  //second one through: only a dropped or failed one is (false)
  private async stillOnItsWay(p: NonNullable<SwapRecord['pending']>): Promise<boolean> {
    const hashes = [p.ref, ...(p.replaced ?? [])] as Hex[];
    const states = await Promise.all(hashes.map((h) => this.evm.txState(h)));
    const live = hashes.findIndex((_, i) => states[i] === 'mined');
    if (live >= 0) {
      if (live > 0) {
        this.say(`${p.kind}: ${hashes[live]} went through, not the higher-fee ${p.ref}`);
        p.ref = hashes[live]!;
      }
      if (!p.queuedSaid) {
        p.queuedSaid = true;
        this.say(`${p.kind} ${p.ref} in a block, not final yet: not sending it again`);
      }
      return true;
    }
    if (states[0] !== 'queued' && !states.slice(1).includes('queued')) {
      return false;
    }
    if ((p.kind === 'claim' || p.kind === 'refund') && states[0] === 'queued' && (p.bumps ?? 0) < maxBumps) {
      const old = p.ref;
      let cannot = false;
      const tx = await this.evm.speedUp(this.signers.evm, old as Hex).catch((e: Error) => {
        this.say(`${p.kind}: higher fee failed: ${e.message.split('\n')[0]}`);
        cannot = true;
        return null;
      });
      //a claim or refund this side cannot speed up (sent by a helper, or a wallet without that call) is sent again
      //as a new one: a second one only costs its fee, waiting on a low-fee one can run past the deadline
      if (cannot) {
        return false;
      }
      if (tx && tx !== old) {
        p.replaced = [...(p.replaced ?? []), old];
        p.ref = tx;
        p.bumps = (p.bumps ?? 0) + 1;
        p.at = Date.now() / 1000;
        noteTx(this.rec, { chain: 'evm', kind: p.kind, by: 'me', hash: tx });
        this.say(`${p.kind} still in the queue: sent again with a higher fee ${tx} (replaces ${old})`);
        return true;
      }
    }
    if (!p.queuedSaid) {
      p.queuedSaid = true;
      this.say(`${p.kind} ${p.ref} still waiting on the EVM chain (in the queue), not sending it again`);
    }
    return true;
  }

  private async pendingSeen(p: NonNullable<SwapRecord['pending']>, v: SwapView, nexusView: LockView): Promise<boolean> {
    const mine = this.rec.role === 'initiator' ? v.initiatorLock : v.participantLock;
    const theirs = this.rec.role === 'initiator' ? v.participantLock : v.initiatorLock;
    switch (p.kind) {
      case 'lock':
        return mine.status !== 'none' && mine.status !== 'pending';
      case 'reveal': {
        if (nexusView.status === 'claimed') {
          return true;
        }
        const tx = await this.nexus.node.transaction(p.ref);
        if ((tx?.confirmations ?? 0) >= this.nexus.confirmations) {
          return true;
        }
        //the node applies the reveal when it takes it, so the credit can follow before the reveal is in a block;
        //both then go into the same block and the secret is not out for long without the credit. Just past the
        //fee-free interval between two transactions of one profile (a second one sooner costs a fee on mainnet)
        if (!tx || Date.now() / 1000 - p.at < nexusTxGap + 1) {
          return false;
        }
        const slot = await this.nexus.node.slot(this.signers.nexus.genesis);
        const held = !!slot && secretMatches(slot.value, fromHexBytes(this.rec.hashlock));
        if (held) {
          this.say('the node holds the reveal: the claim follows the reveal without waiting for its block');
        }
        return held;
      }
      case 'claim':
        return theirs.status === 'claimed';
      case 'refund':
        return mine.status === 'refunded';
    }
  }

  //a lock sent again keeps the first deadline while that still leaves the time the engine needs: the initiator's
  //must leave the participant its full lock plus the safety window, the participant's its minimum window
  private lockDeadline(fresh: number, myNow: number): number {
    const old = this.rec.lockDeadline;
    if (old === undefined) {
      return fresh;
    }
    const t = this.timing;
    const need = this.rec.role === 'initiator' ? t.participantLock + t.safety : t.minParticipantWindow;
    return old <= fresh && old - myNow >= need ? old : fresh;
  }

  private async lock(deadline: number) {
    //my Nexus lock only into accounts of the agreed token and profiles (else nobody could claim it, and it sits until
    //its deadline)
    if (this.myChain() === 'nexus') {
      const problem = await this.nexus.accountsProblem(this.nexusExpect());
      if (problem) {
        this.rec.aborted = problem;
        this.say(`abort: ${problem}`);
        return;
      }
    }
    //marked (and saved, onMark) before the wallet is asked, so nothing treats the swap as "nothing locked" while a
    //prompt is open, nor after a crash during it; the same deadline keeps a lock sent again the same lock id on EVM
    this.rec.lockDeadline = deadline;
    this.rec.pending = { kind: 'lock', ref: '', at: Date.now() / 1000 };
    this.onMark?.();
    try {
      await this.sendLock(deadline);
    } catch (e) {
      //a Nexus lock has no id of its own: a wallet that sent it through its node and then failed, then a second
      //lock, would leave two that one secret claims. So it stays marked for resendAfter and locate gets to see it;
      //on EVM the same deadline gives the same id, which the contract takes only once
      if (this.myChain() === 'nexus' && !nothingSent(e)) {
        this.rec.pending = { kind: 'lock', ref: '', at: Date.now() / 1000 };
      } else {
        this.rec.pending = undefined;
      }
      throw e;
    }
  }

  private async sendLock(deadline: number) {
    if (this.myChain() === 'nexus') {
      const n = this.rec.nexus;
      const terms: NexusLockTerms = { recipient: n.recipient, sender: n.sender, hashlock: fromHexBytes(this.rec.hashlock), deadline };
      const txid = await this.signers.nexus.lock({ from: n.from, to: n.to, amount: BigInt(n.amount), terms });
      this.rec.nexusLock = { txid, contract: 0 };
      this.rec.pending = { kind: 'lock', ref: txid, at: Date.now() / 1000 };
      noteTx(this.rec, { chain: 'nexus', kind: 'lock', by: 'me', hash: txid });
      this.say(`locked on Nexus ${txid} until ${deadline}`);
    } else {
      const { id, tx } = await this.evm.lock(this.signers.evm, this.evmExpect(), deadline);
      this.rec.evmLock = id;
      this.rec.pending = { kind: 'lock', ref: tx, at: Date.now() / 1000 };
      noteTx(this.rec, { chain: 'evm', kind: 'lock', by: 'me', hash: tx });
      this.say(`locked on EVM ${id} until ${deadline}`);
    }
  }

  //claim the other side's lock: on EVM in one call; on Nexus write the secret into my slot first, then credit (the
  //credit as soon as the node holds the reveal, see pendingSeen).
  //false = not now: another swap of my profile is between its reveal and its final credit
  private async claim(): Promise<boolean> {
    const secret = this.rec.secret!;
    //before the secret goes anywhere: a waiting initiator that has not disclosed can still refund
    if (this.myChain() === 'evm' && !this.gate.acquire(this.signers.nexus.genesis, this.rec.id, Date.now() / 1000, this.maxHold())) {
      const note = `waiting for swap ${this.gate.holder(this.signers.nexus.genesis)} to finish its claim (one reveal slot)`;
      if (!this.rec.log[this.rec.log.length - 1]?.endsWith(note)) {
        this.say(note);
      }
      return false;
    }
    //before any signer sees it: if this tick dies after the send, the next one still knows the secret may be out
    if (this.rec.role === 'initiator' && !this.rec.disclosed) {
      this.rec.disclosed = true;
      this.say('secret handed to the signer: claiming from now on');
      this.onMark?.();
    }
    if (this.myChain() === 'nexus') {
      const tx = await this.evm.claim(this.signers.evm, this.rec.evmLock!, `0x${secret}`);
      this.rec.pending = { kind: 'claim', ref: tx, at: Date.now() / 1000 };
      noteTx(this.rec, { chain: 'evm', kind: 'claim', by: 'me', hash: tx });
      this.say(`claim on EVM sent ${tx}`);
      return true;
    }
    const n = this.rec.nexus;
    const me = this.signers.nexus.genesis;
    const slot = await this.nexus.node.slot(me);
    if (!slot) {
      throw new Error('no reveal slot: create it before taking part in swaps');
    }
    const lock = this.rec.nexusLock!;
    if (!secretMatches(slot.value, fromHexBytes(this.rec.hashlock))) {
      if (slot.value.some((b) => b !== 0)) {
        this.say('the reveal slot holds another value (another swap of this profile?): writing over it');
      }
      const txid = await this.signers.nexus.reveal(fromHexBytes(secret), lock);
      this.rec.pending = { kind: 'reveal', ref: txid, at: Date.now() / 1000 };
      noteTx(this.rec, { chain: 'nexus', kind: 'reveal', by: 'me', hash: txid });
      this.say(`secret written to the slot ${txid}`);
      return true;
    }
    const txid = await this.signers.nexus.claim({ lockTxid: lock.txid, contract: lock.contract, to: n.to, from: n.from, amount: BigInt(n.amount) });
    this.rec.pending = { kind: 'claim', ref: txid, at: Date.now() / 1000 };
    noteTx(this.rec, { chain: 'nexus', kind: 'claim', by: 'me', hash: txid });
    this.say(`claim on Nexus sent ${txid}`);
    return true;
  }

  private async refund() {
    if (this.myChain() === 'nexus') {
      const n = this.rec.nexus;
      const lock = this.rec.nexusLock!;
      const txid = await this.signers.nexus.refund({ lockTxid: lock.txid, contract: lock.contract, from: n.from, amount: BigInt(n.amount) });
      this.rec.pending = { kind: 'refund', ref: txid, at: Date.now() / 1000 };
      noteTx(this.rec, { chain: 'nexus', kind: 'refund', by: 'me', hash: txid });
      this.say(`refund on Nexus sent ${txid}`);
    } else {
      const tx = await this.evm.refund(this.signers.evm, this.rec.evmLock!);
      this.rec.pending = { kind: 'refund', ref: tx, at: Date.now() / 1000 };
      noteTx(this.rec, { chain: 'evm', kind: 'refund', by: 'me', hash: tx });
      this.say(`refund on EVM sent ${tx}`);
    }
  }
}
