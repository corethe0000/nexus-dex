//payments that reached this profile's accounts but are not collected yet. On Nexus a payment to someone else's
//account is a DEBIT that the receiver must CREDIT with its own signature; a core with a login does that by itself,
//a profile signed in on this page does it here (a filled market order pays its owner this way).
import type { NexusNode } from '@nexus-dex/core/src/nexus/node';
import { recentBlocks } from '../../../../wallet/src/lib/blocks';
import { isExpired } from '../../../../wallet/src/lib/claims';
import type { NexusAccount } from './nexus';

export interface Waiting {
  txid: string;
  contract: number;
  to: string; //own account
  from: string;
  token: string;
  ticker: string;
  amount: bigint; //still open, base units
  decimals: number;
}

const addressOf = (v: unknown) => (typeof v === 'object' && v ? (v as { address?: string }).address : (v as string | undefined));

export async function waitingPayments(node: NexusNode, accounts: NexusAccount[]): Promise<Waiting[]> {
  const mine = new Map(accounts.map((a) => [a.address, a]));
  if (!mine.size) {
    return [];
  }
  const txids = new Set<string>();
  for (const b of await recentBlocks((m, p) => node.call(m, p), node.url)) {
    for (const tx of b.tx ?? []) {
      for (const c of tx.contracts ?? []) {
        if (c.OP === 'DEBIT' && mine.has(addressOf(c.to) ?? '')) {
          txids.add(tx.txid);
        }
      }
    }
  }
  const out: Waiting[] = [];
  for (const txid of txids) {
    const tx = await node.call<any>('ledger/get/transaction', { hash: txid, verbose: 'summary' }).catch(() => null);
    for (const c of tx?.contracts ?? []) {
      const to = addressOf(c.to);
      const from = addressOf(c.from);
      const acct = to ? mine.get(to) : undefined;
      if (c.OP !== 'DEBIT' || !acct || !from || isExpired(c, tx.timestamp)) {
        continue;
      }
      //an atomic swap lock (hash check on the reveal slot) is collected by its swap with the secret, never here
      if (/sk256/i.test(String(c.conditions ?? ''))) {
        continue;
      }
      const open = BigInt(Math.round((Number(c.amount ?? 0) - Number(c.claimed ?? 0)) * 10 ** acct.decimals));
      if (open > 0n) {
        out.push({ txid, contract: c.id, to: acct.address, from, token: acct.token, ticker: acct.ticker, amount: open, decimals: acct.decimals });
      }
    }
  }
  return out;
}
