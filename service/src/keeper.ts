//a second, independent keeper for the NexusSwap contract. It knows nothing of the relay's order book and shares no
//key with it: it reads the contract alone and spends only its own gas. Anyone can run one.
//- collect on request: a page hands it {chainId, lockId, secret}; it claims at once. The claim pays the lock's fixed
//  recipient and only the right secret works, so whoever asks cannot redirect anything.
//- refund sweep: locks whose deadline is long past get refunded (refund pays the lock's fixed sender), for people whose
//  page is closed and whose relay is gone.
//The page asks every keeper it knows and the relay at the same time (Desk, receive-only claim), so one of them being
//down changes nothing.
import type { Hex, WalletClient } from 'viem';
import { EvmGasRefused, helperMaxGas, type EvmLeg } from '../../core/src/evm/leg';
import { fromHexBytes } from '../../core/src/nexus/bytes';
import { secretMatches } from '../../core/src/nexus/htlc';

export interface KeeperChain {
  leg: EvmLeg;
  wallet: WalletClient;
  claimMargin: number; //no claim this close to the deadline (it would fail and cost gas)
  refundDelay: number; //refund only this long after the deadline (owners and the relay go first)
  //tokens it pays gas for (lowercase address, 0x0...0 = the chain's coin) and the smallest amount (base units) worth it;
  //not set = every token and amount
  tokens?: Map<string, bigint>;
  maxGas?: bigint; //most gas for one claim or refund (default helperMaxGas)
  maxPerDay?: number; //claims and refunds this keeper pays for on this chain in one day (default 200)
  maxPerAddressPerDay?: number; //claims for one recipient in one day (default 10)
}

const defaultPerDay = 200;
const claimSearchBlocks = 200000n;
const defaultPerAddressPerDay = 10;
//blocks swept again each time: a lock in a block that a reorg replaced after it was swept is found again
const rescanBlocks = 300n;

//a lock whose refund failed is tried again after 2, 4, 8 ... minutes (at most an hour), and left alone after this
//many tries
const maxTries = 6;
//refunds sent per chain and sweep: many tiny locks cannot make one sweep spend all the gas at once
const maxRefundsPerSweep = 20;

export class KeeperError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const hex32 = /^0x[0-9a-fA-F]{64}$/;

export class Keeper {
  private sent = new Map<Hex, { tx: Hex; at: number }>();
  private scanned = new Map<string, bigint>(); //chain id -> last block swept
  private open = new Map<string, Map<Hex, bigint>>(); //chain id -> lock id -> deadline (not yet seen closed)
  private failed = new Map<Hex, { tries: number; next: number }>();
  //what was paid for today: per chain, and per chain + recipient (locks to oneself with a known secret, sent again
  //and again, would otherwise let anyone spend this keeper's gas)
  private spent = { day: -1, chain: new Map<string, number>(), address: new Map<string, number>() };
  private claimTxs = new Map<Hex, Hex>(); //lock id -> claim transaction, looked up once
  private settled = new Set<Hex>(); //locks seen closed or left alone (dropped from open for good)

  private settle(open: Map<Hex, bigint>, id: Hex) {
    open.delete(id);
    this.failed.delete(id);
    if (this.settled.size > 50000) {
      this.settled.clear();
    }
    this.settled.add(id);
  }

  constructor(
    readonly chains: Map<string, KeeperChain>,
    private log: (msg: string) => void = console.log,
    private resendAfter = 300,
  ) {}

  async claim(chainId: string, lockId: string, secret: string, now: number): Promise<Hex> {
    const c = this.chains.get(chainId);
    if (!c) {
      throw new KeeperError('this keeper does not work on that chain', 404);
    }
    if (!hex32.test(lockId) || !hex32.test(secret)) {
      throw new KeeperError('bad lock id or secret');
    }
    const id = lockId as Hex;
    const l = await c.leg.state(id);
    //someone (the relay, another keeper, the owner) collected it already: the recipient has the money, so that is a yes
    if (l.state === 'claimed') {
      return this.claimTxOf(c, id);
    }
    if (l.state !== 'open') {
      throw new KeeperError(l.state === 'none' ? 'no such lock' : `lock is ${l.state}`, 409);
    }
    if (!secretMatches(fromHexBytes(secret.slice(2)), fromHexBytes(l.hashlock.slice(2)))) {
      throw new KeeperError('that is not the secret of this lock');
    }
    if (!worthGas(c, l.token, l.amount)) {
      throw new KeeperError('this keeper does not collect that token or amount', 409);
    }
    if ((await c.leg.clock()) + c.claimMargin >= Number(l.deadline)) {
      throw new KeeperError('too close to the deadline to collect', 409);
    }
    const prev = this.sent.get(id);
    if (prev && now - prev.at < this.resendAfter) {
      return prev.tx;
    }
    const over = this.overBudget(chainId, c, l.recipient, now);
    if (over) {
      throw new KeeperError(over, 429);
    }
    let tx: Hex;
    try {
      tx = await c.leg.guarded(c.wallet, { fn: 'claim', id, secret: secret as Hex }, c.maxGas ?? helperMaxGas);
    } catch (e) {
      //the relay and the keepers are asked at the same time; the one that comes second sees a claimed lock
      if ((await c.leg.statePending(id)) === 'claimed') {
        this.log(`keeper ${chainId} ${id.slice(0, 10)} - already collected by someone else`);
        return this.claimTxOf(c, id);
      }
      if (e instanceof EvmGasRefused) {
        throw new KeeperError(e.message, 409);
      }
      throw e;
    }
    this.sent.set(id, { tx, at: now });
    this.count(chainId, l.recipient);
    this.log(`keeper ${chainId} ${id.slice(0, 10)} - claim sent for the recipient ${tx}`);
    return tx;
  }

  //the claim transaction of a collected lock, searched once per lock and only over recent blocks (each request
  //for an old lock would otherwise search the chain back to the contract's first block)
  private async claimTxOf(c: KeeperChain, id: Hex): Promise<Hex> {
    const known = this.claimTxs.get(id);
    if (known) {
      return known;
    }
    const head = await c.leg.client.getBlockNumber();
    const from = head > claimSearchBlocks ? head - claimSearchBlocks : 0n;
    const tx = (await c.leg.claimTx(id, from > c.leg.fromBlock ? from : c.leg.fromBlock).catch(() => null)) ?? id;
    if (this.claimTxs.size > 10000) {
      this.claimTxs.clear();
    }
    this.claimTxs.set(id, tx);
    return tx;
  }

  //null = this keeper still pays for one more today
  private overBudget(chainId: string, c: KeeperChain, recipient: string | null, now: number): string | null {
    this.newDay(now);
    if ((this.spent.chain.get(chainId) ?? 0) >= (c.maxPerDay ?? defaultPerDay)) {
      return 'this keeper has paid for enough today on that chain';
    }
    if (recipient && (this.spent.address.get(`${chainId}:${recipient.toLowerCase()}`) ?? 0) >= (c.maxPerAddressPerDay ?? defaultPerAddressPerDay)) {
      return 'this keeper has collected enough for that address today';
    }
    return null;
  }

  private count(chainId: string, recipient: string | null) {
    this.spent.chain.set(chainId, (this.spent.chain.get(chainId) ?? 0) + 1);
    if (recipient) {
      const k = `${chainId}:${recipient.toLowerCase()}`;
      this.spent.address.set(k, (this.spent.address.get(k) ?? 0) + 1);
    }
  }

  private newDay(now: number) {
    const day = Math.floor(now / 86400);
    if (day !== this.spent.day) {
      this.spent = { day, chain: new Map(), address: new Map() };
    }
  }

  //one pass over every chain: learn new locks, refund the ones long past their deadline
  async sweep(now: number): Promise<void> {
    for (const [chainId, c] of this.chains) {
      try {
        await this.sweepChain(chainId, c, now);
      } catch (e) {
        this.log(`keeper ${chainId} sweep - ${(e as Error).message.split('\n')[0]}`);
      }
    }
  }

  private async sweepChain(chainId: string, c: KeeperChain, now: number) {
    //only settled blocks: refunds come long after a lock, and a load-balanced RPC refuses a range past the head of
    //whichever backend answers (it can be a block behind the head number just read)
    const head = (await c.leg.client.getBlockNumber()) - BigInt(c.leg.confirmations);
    const last = this.scanned.get(chainId);
    const again = last !== undefined && last - rescanBlocks > c.leg.fromBlock ? last - rescanBlocks : c.leg.fromBlock - 1n;
    const from = (last === undefined ? c.leg.fromBlock - 1n : again) + 1n;
    const open = this.open.get(chainId) ?? new Map<Hex, bigint>();
    this.open.set(chainId, open);
    //public RPCs cap getLogs ranges
    for (let a = from; a <= head; a += 5000n) {
      const b = a + 4999n < head ? a + 4999n : head;
      for (const l of await c.leg.locksBetween(a, b)) {
        //the blocks swept again bring back locks already closed or left alone
        if (!this.settled.has(l.id)) {
          open.set(l.id, l.deadline);
        }
      }
      this.scanned.set(chainId, b);
    }
    const chainNow = await c.leg.clock();
    let refunds = 0;
    for (const [id, deadline] of open) {
      if (chainNow < Number(deadline) + c.refundDelay || refunds >= maxRefundsPerSweep) {
        continue;
      }
      const f = this.failed.get(id);
      if (f && now < f.next) {
        continue;
      }
      const prev = this.sent.get(id);
      if (prev && now - prev.at < this.resendAfter) {
        continue;
      }
      //one lock that cannot be refunded (or a node hiccup on it) never holds up the others
      try {
        const l = await c.leg.state(id);
        if (l.state !== 'open' || !worthGas(c, l.token, l.amount)) {
          this.settle(open, id);
          continue;
        }
        if (this.overBudget(chainId, c, null, now)) {
          break;
        }
        const tx = await c.leg.guarded(c.wallet, { fn: 'refund', id }, c.maxGas ?? helperMaxGas);
        refunds++;
        this.count(chainId, null);
        this.sent.set(id, { tx, at: now });
        this.failed.delete(id);
        this.log(`keeper ${chainId} ${id.slice(0, 10)} - refund sent for the sender ${tx}`);
      } catch (e) {
        const tries = (f?.tries ?? 0) + 1;
        if (tries >= maxTries) {
          this.settle(open, id);
          this.log(`keeper ${chainId} ${id.slice(0, 10)} - refund failed ${tries} times, left alone: ${(e as Error).message.split('\n')[0]}`);
        } else {
          this.failed.set(id, { tries, next: now + Math.min(3600, 60 * 2 ** tries) });
          this.log(`keeper ${chainId} ${id.slice(0, 10)} - refund failed (try ${tries}): ${(e as Error).message.split('\n')[0]}`);
        }
      }
    }
  }
}

//the keeper pays gas for this token and amount
function worthGas(c: KeeperChain, token: string, amount: bigint): boolean {
  if (!c.tokens) {
    return true;
  }
  const min = c.tokens.get(token.toLowerCase());
  return min !== undefined && amount >= min;
}
