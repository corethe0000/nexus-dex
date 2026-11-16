//swaps that went through on this relay, for the price and volume charts. Public data only: what changed hands at
//what price and when (no addresses, no swap ids). Kept for keepFor seconds, newest last.
import type { Address } from 'viem';
import type { TakeOut } from './book';

export interface Trade {
  at: number;
  nexusToken: string;
  chainId: string;
  evmToken: Address;
  nexusAmount: string; //base units
  evmAmount: string; //base units
  takerBuys: boolean; //the taker bought the Nexus coin (paid with the EVM token)
}

export class Trades {
  constructor(
    readonly list: Trade[] = [],
    private keepFor = 30 * 24 * 3600,
    private max = 20000,
  ) {}

  add(t: TakeOut, at: number) {
    const o = t.offer.offer;
    this.list.push({ at, nexusToken: o.nexusToken, chainId: o.evmChainId, evmToken: o.evmToken as Address, nexusAmount: o.nexusAmount, evmAmount: o.evmAmount, takerBuys: !!o.makerGivesNexus });
    this.trim(at);
  }

  since(from: number, now: number): Trade[] {
    this.trim(now);
    return this.list.filter((t) => t.at >= from);
  }

  private trim(now: number) {
    const keep = this.list.filter((t) => now - t.at <= this.keepFor);
    this.list.splice(0, this.list.length, ...keep.slice(-this.max));
  }
}
