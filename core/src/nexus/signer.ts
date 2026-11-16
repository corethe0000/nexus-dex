//who signs the Nexus steps of a swap. The runner only says what to do; how it gets signed is up to the signer:
//- localSigner: in this process, from username / password / PIN (tests, the page's own sign-in)
//- the browser wallet: the site asks it (nexus_swapStep) and the user approves each step there; the site never sees
//  the password (dex/app/src/lib/extension.ts)
import { addressOfMemory, creditContract, fillContracts, memoryOfAddress, orderContract, orderTerms, type OrderTerms } from '../../../../wallet/src/lib/tritium';
import { claimContract, lockContract, refundContract, revealContract, slotCreateContracts, type NexusLockTerms } from './htlc';
import type { Credentials, NexusNode } from './node';

export interface LockStep {
  from: string; //my account
  to: string; //the recipient's account
  amount: bigint;
  terms: NexusLockTerms;
}

export interface ClaimStep {
  lockTxid: string;
  contract: number;
  to: string; //my account that receives
  from: string; //the account the lock came from
  amount: bigint;
}

export interface RefundStep {
  lockTxid: string;
  contract: number;
  from: string; //my account the lock came from
  amount: bigint;
}

export interface NexusSigner {
  readonly genesis: string;
  //each returns the txid of the submitted transaction
  createSlot(feeFrom?: string): Promise<string>;
  lock(s: LockStep): Promise<string>;
  //lock = the lock to me this reveal is for (a wallet checks it and its deadline before publishing the secret)
  reveal(secret: Uint8Array, lock?: { txid: string; contract: number }): Promise<string>;
  claim(s: ClaimStep): Promise<string>;
  refund(s: RefundStep): Promise<string>;
  //the Nexus market (orders on the Nexus chain, no other chain involved): one atomic transaction fills an order
  market: MarketSigner;
  //collect payments made to own accounts (one CREDIT each, in one transaction)
  collect(items: CollectItem[]): Promise<string>;
}

export interface CollectItem {
  txid: string;
  contract: number;
  to: string; //own account
  from: string;
  amount: bigint;
}

//one side of an order: token '0' = NXS, amount in base units
export interface OrderLeg {
  token: string;
  amount: bigint;
  decimals: number;
}

export interface MarketSigner {
  //give one token, want another back; from / to = own accounts (a wallet that picks them itself may ignore them)
  place(o: { give: OrderLeg; want: OrderLeg; from?: string; to?: string }): Promise<string>;
  //pay = own account in the token the order wants, receive = own account in the token it gives
  fill(o: { txid: string; market: string; pay?: string; receive?: string }): Promise<string>;
  cancel(o: { txid: string; market: string }): Promise<string>;
}

//the market name the core and the wallet understand: NXS or the token's address, first the token given
export const marketOf = (give: string, want: string) => `${give === '0' ? 'NXS' : give}/${want === '0' ? 'NXS' : want}`;

//signs here; slotFee = name fee on mainnet (0 on test chains), taken from feeFrom
async function orderOf(node: NexusNode, txid: string): Promise<OrderTerms> {
  const raw = await node.call<{ data: string }>('ledger/get/transaction', { hash: txid, format: 'raw' });
  return orderTerms(raw.data);
}

export function localSigner(node: NexusNode, who: Credentials, genesis: string, slotFee = 0n): NexusSigner {
  return {
    genesis,
    async createSlot(feeFrom) {
      const fee = slotFee > 0n && feeFrom ? { account: feeFrom, state: await node.accountState(feeFrom), amount: slotFee } : undefined;
      if (slotFee > 0n && !fee) {
        throw new Error('the reveal slot costs a fee: name the NXS account that pays it');
      }
      return node.submit(who, genesis, (ts) => slotCreateContracts(genesis, ts, fee));
    },
    async lock(s) {
      const state = await node.accountState(s.from);
      return node.submit(who, genesis, (ts) => [lockContract({ address: s.from, state }, s.to, s.amount, s.terms, ts)]);
    },
    async reveal(secret) {
      const slot = await node.slot(genesis);
      if (!slot) {
        throw new Error('no reveal slot: create it before taking part in swaps');
      }
      return node.submit(who, genesis, (ts) => [revealContract(genesis, slot, secret, ts)]);
    },
    async claim(s) {
      const state = await node.accountState(s.to);
      return node.submit(who, genesis, (ts) => [claimContract(s.lockTxid, s.contract, { address: s.to, state }, s.from, s.amount, ts)]);
    },
    async refund(s) {
      const state = await node.accountState(s.from);
      return node.submit(who, genesis, (ts) => [refundContract(s.lockTxid, s.contract, { address: s.from, state }, s.amount, ts)]);
    },
    async collect(items) {
      const states = new Map<string, Awaited<ReturnType<NexusNode['accountState']>>>();
      for (const i of items) {
        if (!states.has(i.to)) {
          states.set(i.to, await node.accountState(i.to));
        }
      }
      //each credit on the state the previous one left
      return node.submit(who, genesis, (ts) => {
        const now = new Map(states);
        return items.map((i) => {
          const state = now.get(i.to)!;
          now.set(i.to, { ...state, balance: state.balance + i.amount, modified: ts });
          return creditContract({ debitTxid: i.txid, contract: i.contract, to: { address: i.to, state }, from: i.from, amount: i.amount }, ts);
        });
      });
    },
    market: {
      async place(o) {
        if (!o.from || !o.to) {
          throw new Error('pick the account that gives and the one that receives');
        }
        const state = await node.accountState(o.from);
        const wantToken = o.want.token === '0' ? new Uint8Array(32) : memoryOfAddress(o.want.token);
        return node.submit(who, genesis, (ts) => [orderContract({ address: o.from!, state }, o.give.amount, memoryOfAddress(o.to!), o.want.amount, wantToken, ts)]);
      },
      async fill(o) {
        if (!o.pay || !o.receive) {
          throw new Error('pick the account that pays and the one that receives');
        }
        const terms = await orderOf(node, o.txid);
        const [pay, receive] = await Promise.all([node.accountState(o.pay), node.accountState(o.receive)]);
        return node.submit(who, genesis, (ts) => fillContracts(genesis, o.txid, terms, { address: o.pay!, state: pay }, { address: o.receive!, state: receive }, ts));
      },
      //the order's amount credited back into the account it came from (core AddVoid)
      async cancel(o) {
        const terms = await orderOf(node, o.txid);
        const from = addressOfMemory(terms.from);
        const state = await node.accountState(from);
        return node.submit(who, genesis, (ts) => [creditContract({ debitTxid: o.txid, contract: terms.contract, to: { address: from, state }, from, amount: terms.amount }, ts)]);
      },
    },
  };
}
