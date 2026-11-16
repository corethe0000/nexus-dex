//the relay's API (dex/service/src/api.ts). What the page sends is signed by the user's EVM wallet, or by the page's agent
//key for a side that only receives USDT/USDC (offerSignerOk / takeSignerOk in core/src/book/offer.ts).
import type { Address, Hex } from 'viem';
import type { Json, Offer, OfferOut, Take, TakeOut } from '@nexus-dex/core/src/book/offer';

export type { OfferOut, TakeOut };

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

//an independent keeper (dex/service/src/keeper.ts): collects one EVM lock for its fixed recipient with its own gas
export async function keeperClaim(base: string, chainId: string, lockId: Hex, secret: Hex): Promise<Hex> {
  let res: Response;
  try {
    res = await fetch(`${base}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId, lockId, secret }) });
  } catch {
    throw new RelayError(0, `keeper ${base} cannot be reached`);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new RelayError(res.status, j.error ?? `keeper answered ${res.status}`);
  }
  return j.tx as Hex;
}

export interface RelayTrade {
  at: number;
  nexusToken: string;
  chainId: string;
  evmToken: Address;
  nexusAmount: string;
  evmAmount: string;
  takerBuys: boolean;
}

export class Relay {
  constructor(readonly base: string) {}

  private async req<T>(path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new RelayError(0, 'The offer service cannot be reached. Check your connection.');
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new RelayError(res.status, j.error ?? `offer service answered ${res.status}`);
    }
    return j as T;
  }

  offers() {
    return this.req<{ offers: OfferOut[]; now: number }>('offers');
  }

  //swaps that went through on this relay (default: last 7 days)
  trades(since?: number) {
    return this.req<{ trades: RelayTrade[]; now: number }>(`trades${since === undefined ? '' : `?since=${since}`}`);
  }

  //the reference price of a Nexus token over the last 24 h, null without a feed
  history(token: string) {
    return this.req<{ history: { prices: [number, number][]; change24?: number; volume24?: number; source: string } | null; now: number }>(`history?token=${encodeURIComponent(token)}`);
  }

  //reference prices in USD per Nexus token ("0" = NXS), a hint only
  price() {
    return this.req<{ prices: Record<string, { usd: number; at: number; source?: string }>; source: string }>('price');
  }

  post(offer: Json<Offer>, sig: Hex) {
    return this.req<{ id: Hex }>('offers', { offer, sig });
  }

  cancel(id: Hex, sig: Hex) {
    return this.req<{ ok: true }>(`offers/${id}/cancel`, { sig });
  }

  alive(agent: Address, at: number, sig: Hex) {
    return this.req<{ takes: TakeOut[]; now: number }>('alive', { agent, at, sig });
  }

  take(take: Json<Take>, sig: Hex) {
    return this.req<{ id: Hex; acceptBy: number }>('takes', { take, sig });
  }

  accept(id: Hex, sig: Hex) {
    return this.req<{ ok: true }>(`takes/${id}/accept`, { sig });
  }

  //maker: the taker of this accepted take never locked, open the offer again
  void(id: Hex, sig: Hex) {
    return this.req<{ ok: true }>(`takes/${id}/void`, { sig });
  }

  //receive only: the relay's watcher collects the EVM lock of this swap for its fixed recipient, with its own gas
  claim(id: Hex, secret: Hex) {
    return this.req<{ tx: Hex }>(`takes/${id}/claim`, { secret });
  }

  get(id: Hex) {
    return this.req<TakeOut>(`takes/${id}`);
  }
}
