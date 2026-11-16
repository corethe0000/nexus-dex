//the Nexus leg of a swap seen from the chain: is the lock there, final, exactly as agreed, claimed or refunded,
//and the secret once the recipient revealed it. Reads only, no login.
import { addressOfMemory, hashedForm, hexOfMemory, parseTx, txidOf } from '../../../../wallet/src/lib/tritium';
import { memoryOfAddress, toHexBytes } from './bytes';
import { lockCondition, secretMatches, slotAddress, type NexusLockTerms } from './htlc';
import type { NexusNode } from './node';
import type { LockStatus, LockView } from '../swap/types';

const opDebit = 0x10;

export interface NexusLockRef {
  txid: string;
  contract: number;
}

export interface NexusLockExpect {
  terms: Omit<NexusLockTerms, 'deadline'>; //the deadline is read from the lock
  from: string; //sender account (base58)
  to: string; //recipient account (base58)
  amount: bigint;
  //agreed token ('0' = NXS, else the token address): both accounts must hold it and belong to the agreed profiles.
  //A DEBIT from an account of another (worthless) token passes every byte check of the op, but its CREDIT fails,
  //after the claimer already revealed the secret. Undefined only for records made before this check existed.
  token?: string;
}

export interface RawContract {
  op: Uint8Array;
  condition: Uint8Array;
}

//contracts of a raw transaction (ledger/get/transaction format raw = message byte + serialized tx)
export function parseContracts(rawHex: string): RawContract[] {
  const b = Uint8Array.from((rawHex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
  let p = 1;
  //bounds checked: a node's answer is input like any other
  const compact = () => {
    if (p >= b.length) {
      throw new Error('raw transaction cut short');
    }
    const first = b[p++]!;
    if (first < 253) {
      return first;
    }
    if (first === 253) {
      const v = b[p]! | (b[p + 1]! << 8);
      p += 2;
      return v;
    }
    throw new Error('compact size too big');
  };
  const vec = () => {
    const n = compact();
    if (p + n > b.length) {
      throw new Error('raw transaction cut short');
    }
    const out = b.subarray(p, p + n);
    p += n;
    return out;
  };
  const count = compact();
  const list: RawContract[] = [];
  for (let i = 0; i < count; i++) {
    const op = vec();
    const condition = vec();
    vec(); //registers
    list.push({ op, condition });
  }
  return list;
}

function u64le(b: Uint8Array, at: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(b[at + i]!);
  }
  return v;
}

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

//compares a lock condition with the agreed terms, any deadline; returns the deadline, or null when it differs.
//The deadline bytes are found by building the condition with two different deadlines.
export function conditionDeadline(condition: Uint8Array, terms: Omit<NexusLockTerms, 'deadline'>): number | null {
  const lo = lockCondition({ ...terms, deadline: 0 });
  const hi = lockCondition({ ...terms, deadline: Number.MAX_SAFE_INTEGER });
  if (condition.length !== lo.length) {
    return null;
  }
  const at: number[] = [];
  for (let i = 0; i < lo.length; i++) {
    if (lo[i] !== hi[i]) {
      at.push(i);
    } else if (condition[i] !== lo[i]) {
      return null;
    }
  }
  //two u64 fields (claim and refund paths): both must hold the same deadline
  const first = at.slice(0, 8)[0]!;
  const second = at.find((i) => i >= first + 8)!;
  const d = u64le(condition, first);
  if (u64le(condition, second) !== d || d > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(d);
}

const pageSize = 50;
//transactions read at most in one search. Not a time window: a transaction's timestamp only has to be >= the previous
//one of its sigchain, so a profile quiet for a month can date its claim a month back. A claimer who sends many
//transactions after its claim to push it out of reach pays for each (mainnet fee under 10 s apart) and only slows us
const maxScan = 100000;
//a claim is in the lock's block or a later one; confirmations are read at slightly different moments
const blockSlack = 3;

//contract ops that only move value; anything else (WRITE, CREATE, ...) can put bytes into a register
const valueOnly = new Set(['DEBIT', 'CREDIT', 'FEE']);

function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((b, j) => hay[i + j] === b)) {
      return true;
    }
  }
  return false;
}

//any 32 bytes of the contracts' ops that hash to the hashlock
function secretIn(contracts: RawContract[], hashlock: Uint8Array): Uint8Array | null {
  for (const c of contracts) {
    for (let i = 0; i + 32 <= c.op.length; i++) {
      const window = c.op.subarray(i, i + 32);
      if (secretMatches(window, hashlock)) {
        return Uint8Array.from(window);
      }
    }
  }
  return null;
}

const opWrite = 0x01;
const opCreate = 0x02;
const opTransfer = 0x04;
const opClaim = 0x05;
const opAppend = 0x06;
const opCredit = 0x11;
//sigchains the secret search follows the slot through at most
const maxHops = 8;
//blocks the last resort search reads at most (a week of mainnet blocks at ~50 s)
const maxBlocks = 12000;

type SlotMove = { kind: 'write' } | { kind: 'transfer'; to: string } | { kind: 'claim'; txid: string; contract: number };

//what a contract did to the slot: wrote it, sent it away (TRANSFER: address, to, type) or took it in (CLAIM: transfer
//txid, contract, address); anything else that names it counts as a write
function slotMove(op: Uint8Array, slot: Uint8Array): SlotMove | null {
  const is = (at: number) => equal(op.subarray(at, at + 32), slot);
  if ((op[0] === opWrite || op[0] === opCreate || op[0] === opAppend) && is(1)) {
    return { kind: 'write' };
  }
  if (op[0] === opTransfer && is(1)) {
    return { kind: 'transfer', to: hexOfMemory(op.subarray(33, 65)) };
  }
  if (op[0] === opClaim && is(69)) {
    const contract = op[65]! | (op[66]! << 8) | (op[67]! << 16) | (op[68]! << 24);
    return { kind: 'claim', txid: hexOfMemory(op.subarray(1, 65)), contract };
  }
  return contains(op, slot) ? { kind: 'write' } : null;
}

const sameGenesis = (a: string, b: string) => a.toLowerCase().replace(/^0x/, '') === b.toLowerCase().replace(/^0x/, '');

//an account's owner can change (a register can be transferred): read it again after this long
const accountTtl = 600;

export class NexusLeg {
  //account address -> its token and owner, as read at `at` (a register's token never changes, its owner can)
  private accounts = new Map<string, { token: string; owner: string; at: number }>();

  constructor(
    readonly node: NexusNode,
    readonly confirmations = 1,
    //other nodes asked before a step that trusts a lock seen only through `node` (a lying node could show one that
    //does not exist)
    readonly witnesses: NexusNode[] = [],
  ) {}

  private async account(address: string): Promise<{ token: string; owner: string } | null> {
    const now = Date.now() / 1000;
    const known = this.accounts.get(address);
    if (known && now - known.at < accountTtl) {
      return known;
    }
    const a = await this.node.accountState(address).catch(() => null);
    if (!a) {
      return null;
    }
    const got = { token: a.token, owner: a.owner, at: now };
    this.accounts.set(address, got);
    return got;
  }

  //both accounts of the lock hold the agreed token and belong to the agreed sender and recipient; null = all fine.
  //A record from before the agreed token was kept: both accounts must at least hold the same token
  async accountsProblem(e: NexusLockExpect): Promise<string | null> {
    const [from, to] = await Promise.all([this.account(e.from), this.account(e.to)]);
    if (!from || !to) {
      return 'account not readable';
    }
    if (e.token === undefined ? from.token !== to.token : from.token !== e.token || to.token !== e.token) {
      return 'lock is in another token than agreed';
    }
    if (!sameGenesis(from.owner, e.terms.sender) || !sameGenesis(to.owner, e.terms.recipient)) {
      return 'lock account belongs to someone else';
    }
    return null;
  }

  //the lock exactly as agreed? (op, accounts, amount, and the full condition byte for byte except the deadline)
  checkContract(c: RawContract, e: NexusLockExpect): { problem: string | null; deadline?: number; amount?: bigint } {
    const op = c.op;
    if (op[0] !== opDebit || op.length !== 81) {
      return { problem: 'not a debit' };
    }
    const amount = u64le(op, 65);
    if (!equal(op.subarray(1, 33), memoryOfAddress(e.from))) {
      return { problem: 'debit from another account', amount };
    }
    if (!equal(op.subarray(33, 65), memoryOfAddress(e.to))) {
      return { problem: 'debit to another account', amount };
    }
    const deadline = conditionDeadline(c.condition, e.terms);
    if (deadline === null) {
      return { problem: 'condition differs from the agreed terms', amount };
    }
    if (amount !== e.amount) {
      return { problem: `amount ${amount}, agreed ${e.amount}`, amount, deadline };
    }
    return { problem: null, amount, deadline };
  }

  //the contract as the node gives it, only when the transaction hashes to the txid asked for (a node that changes a
  //byte of the lock is caught; one that makes up a whole transaction is what witnessProblem is for)
  async readContract(ref: NexusLockRef, node = this.node): Promise<RawContract | null> {
    const raw = await node.call('ledger/get/transaction', { hash: ref.txid, format: 'raw' }).catch(() => null);
    if (!raw?.data) {
      return null;
    }
    try {
      const h = parseTx(raw.data);
      if (txidOf(hashedForm(h.contractBytes, h)) !== ref.txid.toLowerCase()) {
        return null;
      }
      return parseContracts(raw.data)[ref.contract] ?? null;
    } catch {
      return null;
    }
  }

  //every witness node knows the same lock, final: null = fine (or no witnesses set up), else what is wrong
  async witnessProblem(ref: NexusLockRef): Promise<string | null> {
    const mine = await this.readContract(ref);
    if (!mine) {
      return 'lock not readable';
    }
    for (const w of this.witnesses) {
      const [theirs, tx] = await Promise.all([this.readContract(ref, w), w.transaction(ref.txid).catch(() => null)]);
      if (!theirs || !equal(theirs.op, mine.op) || !equal(theirs.condition, mine.condition)) {
        return `node ${w.url} does not know this lock`;
      }
      if ((tx?.confirmations ?? 0) < this.confirmations) {
        return `lock not final yet on node ${w.url}`;
      }
    }
    return null;
  }

  //a sigchain's transactions newest first, page by page, until `stop` says so, the history ends (`end` is then
  //called) or maxScan were read
  private async *newest(genesis: string, stop: (tx: any) => boolean, verbose?: string, end?: () => void): AsyncGenerator<any> {
    for (let offset = 0; offset < maxScan; offset += pageSize) {
      const page = await this.node.call<any[]>('ledger/list/transactions', { genesis, limit: pageSize, offset, ...(verbose ? { verbose } : {}) }).catch(() => null);
      if (!page) {
        return;
      }
      for (const tx of page) {
        if (stop(tx)) {
          return;
        }
        yield tx;
      }
      if (page.length < pageSize) {
        end?.();
        return;
      }
    }
  }

  //finds the lock on the chain alone: a DEBIT with the agreed hash in the sender's transactions since `since`
  async locate(senderGenesis: string, e: NexusLockExpect, since = 0): Promise<NexusLockRef | null> {
    //summary: the plain list has no timestamp (the scan would never stop at `since`) and no ops
    for await (const tx of this.newest(senderGenesis, (tx) => typeof tx.timestamp === 'number' && tx.timestamp < since, 'summary')) {
      if (Array.isArray(tx.contracts) && !tx.contracts.some((c: any) => c.OP === 'DEBIT')) {
        continue;
      }
      const raw = await this.node.call('ledger/get/transaction', { hash: tx.txid, format: 'raw' }).catch(() => null);
      if (!raw?.data) {
        continue;
      }
      const contracts = parseContracts(raw.data);
      for (let i = 0; i < contracts.length; i++) {
        if (conditionDeadline(contracts[i]!.condition, e.terms) !== null) {
          return { txid: tx.txid, contract: i };
        }
      }
    }
    return null;
  }

  //CREDIT of this lock in a sigchain, final or not: back to the lock's block (a credit's own timestamp can be set
  //back, the block it is in cannot)
  private async creditIn(genesis: string, ref: NexusLockRef, lockConfirmations: number): Promise<{ txid: string; final: boolean } | null> {
    const older = (tx: any) => typeof tx.confirmations === 'number' && tx.confirmations > lockConfirmations + blockSlack;
    for await (const tx of this.newest(genesis, older, 'summary')) {
      const full = tx.contracts ? tx : await this.node.transaction(tx.txid);
      for (const c of full?.contracts ?? []) {
        if (c.OP === 'CREDIT' && c.txid === ref.txid && c.contract === ref.contract) {
          return { txid: full.txid, final: (full.confirmations ?? 0) >= this.confirmations };
        }
      }
    }
    return null;
  }

  async view(ref: NexusLockRef | undefined, e: NexusLockExpect, pendingOwn?: 'lock' | 'claim' | 'refund'): Promise<LockView> {
    if (!ref) {
      return { status: pendingOwn === 'lock' ? 'pending' : 'none' };
    }
    const tx = await this.node.transaction(ref.txid);
    if (!tx) {
      return { status: 'pending', ref: `${ref.txid}:${ref.contract}` };
    }
    const c = await this.readContract(ref);
    const read = c ? this.checkContract(c, e) : { problem: 'lock not readable' };
    const check = read.problem === null ? { ...read, problem: await this.accountsProblem(e) } : read;
    const base: LockView = {
      status: 'pending',
      ref: `${ref.txid}:${ref.contract}`,
      amount: check.amount?.toString(),
      hashlock: check.problem === 'condition differs from the agreed terms' ? 'mismatch' : toHexBytes(e.terms.hashlock),
      deadline: check.deadline,
      recipientOk: check.problem === null || check.problem.startsWith('amount'),
      problem: check.problem?.startsWith('amount') ? undefined : (check.problem ?? undefined),
      slotReady: (await this.node.slot(e.terms.recipient)) !== null,
    };
    if ((tx.confirmations ?? 0) < this.confirmations) {
      return base;
    }
    let status: LockStatus = 'confirmed';
    let closedBy: string | undefined;
    const lockConfirmations = Number(tx.confirmations ?? 0);
    const claim = await this.creditIn(e.terms.recipient, ref, lockConfirmations);
    if (claim) {
      status = claim.final ? 'claimed' : 'claiming';
      closedBy = claim.txid;
    } else {
      const refund = await this.creditIn(e.terms.sender, ref, lockConfirmations);
      if (refund) {
        status = refund.final ? 'refunded' : 'refunding';
        closedBy = refund.txid;
      } else if (pendingOwn === 'claim') {
        status = 'claiming';
      } else if (pendingOwn === 'refund') {
        status = 'refunding';
      }
    }
    return { ...base, status, closedBy };
  }

  //the secret, once the recipient wrote it into its reveal slot. The slot is the recipient's own and can be written
  //again right after the claim (on purpose, or by its next swap), so with `deep` the recipient's transactions are
  //searched for the write that held it: from its claim (`claimTxid`, the CREDIT of the lock) back to the slot's last
  //write before it, else through the whole history. `since` (unix time, before the secret was made): last, every block
  //from then on is searched for a transaction that touched the slot, wherever the slot went (a transfer to the
  //wildcard address leaves no trail to follow)
  async findSecret(recipient: string, hashlock: Uint8Array, deep = false, claimTxid?: string, since?: number): Promise<Uint8Array | null> {
    const slot = await this.node.slot(recipient);
    if (slot && secretMatches(slot.value, hashlock)) {
      return slot.value;
    }
    if (!deep) {
      return null;
    }
    const found = (claimTxid ? await this.secretBeforeClaim(recipient, hashlock, claimTxid) : null) ?? (await this.secretInHistory(recipient, hashlock));
    return found ?? (since !== undefined ? this.secretInBlocks(slotAddress(recipient), hashlock, since) : null);
  }

  //blocks read for secretInBlocks, by hash: its time, the one before it and its transactions that touched a register
  //(by register address, base58); kept once a few blocks deep
  private blocks = new Map<string, { timestamp: number; prev: string; txs: { txid: string; registers: string[] }[] }>();
  //raw contracts of transactions read there
  private touched = new Map<string, RawContract[]>();

  private async secretInBlocks(slot: Uint8Array, hashlock: Uint8Array, since: number): Promise<Uint8Array | null> {
    const address = addressOfMemory(slot);
    //a long running watcher: forget blocks older than any search reaches
    if (this.blocks.size > maxBlocks) {
      for (const [h, b] of this.blocks) {
        if (b.timestamp < since - maxBlocks * 50) {
          this.blocks.delete(h);
        }
      }
    }
    if (this.touched.size > maxBlocks) {
      this.touched.clear();
    }
    const [top] = (await this.node.call<any[]>('ledger/list/blocks', { limit: 1, verbose: 'detail' }).catch(() => null)) ?? [];
    let hash: string | undefined = top?.hash;
    for (let depth = 0; hash && depth < maxBlocks; depth++) {
      let b = this.blocks.get(hash);
      if (!b) {
        const raw = depth === 0 ? top : await this.node.call<any>('ledger/get/block', { hash, verbose: 'detail' }).catch(() => null);
        if (!raw) {
          return null;
        }
        const txs = ((raw.tx ?? []) as any[])
          .map((tx) => ({ txid: String(tx.txid), registers: ((tx.contracts ?? []) as any[]).filter((c) => !valueOnly.has(String(c.OP)) && c.address).map((c) => String(c.address)) }))
          .filter((tx) => tx.registers.length);
        b = { timestamp: Number(raw.timestamp), prev: String(raw.previousblockhash ?? ''), txs };
        if (depth >= blockSlack) {
          this.blocks.set(hash, b);
        }
      }
      if (b.timestamp < since) {
        return null;
      }
      for (const tx of b.txs.filter((t) => t.registers.includes(address))) {
        let contracts = this.touched.get(tx.txid);
        if (!contracts) {
          contracts = (await this.rawTx(tx.txid))?.contracts ?? [];
          this.touched.set(tx.txid, contracts);
        }
        const found = secretIn(contracts, hashlock);
        if (found) {
          return found;
        }
      }
      hash = b.prev;
    }
    return null;
  }

  private async rawTx(txid: string): Promise<{ contracts: RawContract[]; prevTx: string; genesis: string } | null> {
    const raw: any = await this.node.call('ledger/get/transaction', { hash: txid, format: 'raw' }).catch(() => null);
    if (!raw?.data) {
      return null;
    }
    const h = parseTx(raw.data);
    return { contracts: parseContracts(raw.data), prevTx: h.prevTx, genesis: h.genesis };
  }

  //the credit read the slot as it was then: walk back along the sigchain (each transaction names the one before it)
  //from the claim to the newest transaction that wrote or created the slot. The lock checks that the recipient owns the
  //slot when it claims, but a name can leave and come back (transfer and claim, or a forced transfer), and the secret can
  //be written while another profile holds it: the walk follows the slot into those sigchains
  private async secretBeforeClaim(recipient: string, hashlock: Uint8Array, claimTxid: string): Promise<Uint8Array | null> {
    const slot = slotAddress(recipient);
    const claimTx = await this.node.transaction(claimTxid);
    const claimConfirmations = Number(claimTx?.confirmations ?? 0);
    //txid and the contracts of it that come before the point we reached it from
    let at: { txid: string; before: number } | null = { txid: claimTxid, before: Infinity };
    let first = true;
    let hops = 0;
    for (let i = 0; i < maxScan && at && !/^0*$/.test(at.txid); i++) {
      const tx = await this.rawTx(at.txid);
      if (!tx) {
        return null;
      }
      //a secret anywhere in it is the secret, whatever came before or after
      const found = secretIn(tx.contracts, hashlock);
      if (found) {
        return found;
      }
      //in the claim itself only what came before the credit counts
      const end: number = first ? Math.max(0, tx.contracts.findIndex((c) => c.op[0] === opCredit)) : Math.min(at.before, tx.contracts.length);
      first = false;
      const last: { move: SlotMove | null; k: number } | undefined = tx.contracts
        .slice(0, end)
        .map((c, k) => ({ move: slotMove(c.op, slot), k }))
        .filter((m) => m.move)
        .pop();
      if (!last) {
        at = { txid: tx.prevTx, before: Infinity };
        continue;
      }
      const move: SlotMove = last.move!;
      if (move.kind === 'write' || ++hops > maxHops) {
        return null;
      }
      if (move.kind === 'claim') {
        //it came from another profile: on to that one's transfer
        at = { txid: move.txid, before: move.contract };
        continue;
      }
      //it left this sigchain here and came back without a claim in it (a forced transfer): find who sent it back
      at = await this.slotSentTo(slot, move.to, tx.genesis, claimConfirmations);
    }
    return null;
  }

  //follows the slot from `holder` on (no further than the claim's block) until a forced transfer to `home`; returns
  //that transfer, to walk back from
  private async slotSentTo(slot: Uint8Array, holder: string, home: string, claimConfirmations: number): Promise<{ txid: string; before: number } | null> {
    for (let hop = 0; hop < maxHops; hop++) {
      if (/^f+$/i.test(holder)) {
        return null; //a transfer anyone could claim: no way to tell who held it
      }
      let out: { txid: string; k: number; to: string } | null = null;
      for await (const tx of this.newest(holder, () => false, 'summary')) {
        if (Number(tx.confirmations ?? 0) < claimConfirmations) {
          continue; //after the claim
        }
        const raw = await this.rawTx(tx.txid);
        const moves = (raw?.contracts ?? []).map((c, k) => ({ move: slotMove(c.op, slot), k })).filter((m) => m.move);
        const last = moves.pop();
        if (last) {
          out = last.move!.kind === 'transfer' ? { txid: tx.txid, k: last.k, to: last.move!.to } : null;
          break;
        }
      }
      if (!out) {
        return null;
      }
      if (sameGenesis(out.to, home)) {
        return { txid: out.txid, before: out.k };
      }
      holder = out.to;
    }
    return null;
  }

  //transactions already read per profile (they never change): plain value moves (no secret in them for any swap), the
  //contracts of the others (checked again for each hashlock, never skipped: one swap's miss can be the next one's
  //secret), and whether every transaction older than them was read too
  private searched = new Map<string, { values: Set<string>; parsed: Map<string, RawContract[]>; complete: boolean }>();

  //newest first through the recipient's transactions (not cut by timestamps, which can be set back): every 32 bytes
  //of every contract that can change a register checked against the hashlock (plain debits, credits and fees cannot)
  private async secretInHistory(recipient: string, hashlock: Uint8Array): Promise<Uint8Array | null> {
    const memo = this.searched.get(recipient) ?? { values: new Set<string>(), parsed: new Map<string, RawContract[]>(), complete: false };
    this.searched.set(recipient, memo);
    let gaps = false;
    let reachedEnd = false;
    let caughtUp = false;
    for await (const tx of this.newest(recipient, () => false, 'summary', () => (reachedEnd = true))) {
      if (memo.values.has(tx.txid) || memo.parsed.has(tx.txid)) {
        if (memo.complete) {
          caughtUp = true;
          break;
        }
        const found = secretIn(memo.parsed.get(tx.txid) ?? [], hashlock);
        if (found) {
          return found;
        }
        continue;
      }
      const ops: string[] = (tx.contracts ?? []).map((c: any) => String(c.OP));
      if (ops.length && ops.every((op) => valueOnly.has(op))) {
        memo.values.add(tx.txid);
        continue;
      }
      const raw = await this.node.call('ledger/get/transaction', { hash: tx.txid, format: 'raw' }).catch(() => null);
      if (!raw?.data) {
        gaps = true;
        continue;
      }
      const contracts = parseContracts(raw.data);
      memo.parsed.set(tx.txid, contracts);
      const found = secretIn(contracts, hashlock);
      if (found) {
        return found;
      }
    }
    //the older ones were all read before: look in what they held
    if (caughtUp) {
      for (const contracts of memo.parsed.values()) {
        const found = secretIn(contracts, hashlock);
        if (found) {
          return found;
        }
      }
    }
    //complete only once every transaction down to the first one was read
    memo.complete = !gaps && (memo.complete ? caughtUp || reachedEnd : reachedEnd);
    return null;
  }

  async clock(): Promise<number> {
    return (await this.node.tip()).timestamp;
  }
}
