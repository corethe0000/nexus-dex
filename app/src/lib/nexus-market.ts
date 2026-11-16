//the Nexus market: orders that live on the Nexus chain itself (core market API). An order is a conditional payment;
//whoever pays what it asks takes it in one transaction, so both sides are paid at once or not at all. No relay, no
//deadlines, no other chain: only a Nexus profile is needed.
import type { NexusNode } from '@nexus-dex/core/src/nexus/node';
import { marketOf } from '@nexus-dex/core/src/nexus/signer';
import { toOrder } from '../../../../wallet/src/lib/orders';
import type { MarketOrder } from '../../../../wallet/src/lib/types';

export type { MarketOrder };

//every open order between two tokens, both directions ('0' = NXS)
export async function pairOrders(node: NexusNode, a: string, b: string): Promise<MarketOrder[]> {
  const r = await node.call<any>('market/list/order', { market: marketOf(a, b), limit: 100 });
  const all = [...(r?.bids ?? []), ...(r?.asks ?? [])].map(toOrder);
  const seen = new Set<string>();
  return all.filter((o) => !seen.has(o.txid) && seen.add(o.txid));
}

//filled orders between two tokens (market/list/executed, same shape as open orders), oldest first: when, the price of
//one `a` in `b`, and how much `a` changed hands
export async function pairFills(node: NexusNode, a: string, b: string): Promise<{ at: number; price: number; amount: number }[]> {
  const r = await node.call<any>('market/list/executed', { market: marketOf(a, b), limit: 200 });
  const seen = new Set<string>();
  return [...(r?.bids ?? []), ...(r?.asks ?? [])]
    .map(toOrder)
    .filter((o) => !seen.has(o.txid) && seen.add(o.txid) && o.give.amount > 0 && o.want.amount > 0)
    .map((o) => ({ at: o.timestamp, price: orderPrice(o, a), amount: o.give.token === a ? o.give.amount : o.want.amount }))
    .sort((x, y) => x.at - y.at);
}

//price of one `of` in the other token of the order
export function orderPrice(o: MarketOrder, of: string): number {
  return o.give.token === of ? o.want.amount / o.give.amount : o.give.amount / o.want.amount;
}
