//the offer book as both trading modes see it: rows with names and prices, live refresh, and what a user still has to
//do before taking one. Simple and advanced mode use exactly these, so they never disagree.
import { useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { offerFromJson, type Offer, type OfferOut } from '@nexus-dex/core/src/book/offer';
import { erc20Abi, isNative, nativeToken } from '@nexus-dex/core/src/evm/leg';

//what has to stay in the wallet when the native coin itself is paid: 0.001 of an 18-decimal coin covers a lock on BSC,
//Polygon and Ethereum testnets; the wallet still shows the exact fee before signing
const nativeFeeReserve = 10n ** 15n;
import type { AppState } from '../App';
import { tokenOf, type TokenInfo } from '../lib/config';
import { gasCoinOf, readClient } from '../lib/evm';
import { accountsFor, type NexusAccount } from '../lib/nexus';
import { fromUnits, price } from '../lib/format';
import { T, type Texts } from '../lib/i18n';

export interface Row {
  o: OfferOut;
  offer: Offer;
  nexusTicker: string;
  nexusDecimals: number;
  evmSymbol: string;
  evmDecimals: number;
  chainId: string;
  price: string;
  priceNum: number; //in the EVM token, per Nexus coin
  stable: boolean; //the EVM token is a stablecoin (worth one dollar)
  group: string; //what its price can be compared with: "usd" for every stablecoin, else the token symbol
}

//a stablecoin = a token the service values at one dollar (relay config usd: 1); a config without usd goes by its name
export const isStable = (t: { symbol: string; usd?: number | string }) => t.usd === 1 || (t.usd === undefined && /^(USDT|USDC|DAI|BUSD|FDUSD)$/i.test(t.symbol));
export const groupOf = (t: { symbol: string; usd?: number | string }) => (isStable(t) ? 'usd' : t.symbol);
export const groupName = (t: Texts, g: string) => (g === 'usd' ? t.advStablecoins : g);

//decimals shown for an EVM amount: cents for stablecoins, up to 6 for other tokens (0.0021 TETH must not show as 0)
export const evmFraction = (stable: boolean, decimals: number) => (stable ? 2 : Math.min(decimals, 6));
//an EVM token amount as text, without the symbol
export const evmAmount = (v: bigint | string, t: { decimals: number; symbol: string; usd?: number | string }) => fromUnits(v, t.decimals, evmFraction(isStable(t), t.decimals));

const refreshMs = 8000;

export function useOffers(app: AppState): { offers: OfferOut[] | null; error: string } {
  const [offers, setOffers] = useState<OfferOut[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await app.relay.offers();
        await Promise.all(r.offers.map((o) => app.tokens.ready(o.offer.nexusToken)));
        if (!stop) {
          setOffers(r.offers);
          setError('');
        }
      } catch (e) {
        if (!stop) {
          setError((e as Error).message);
        }
      }
    };
    void load();
    const t = window.setInterval(load, refreshMs);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [app.relay, app.tokens]);
  return { offers, error };
}

export function useRows(app: AppState, offers: OfferOut[] | null): Row[] {
  return useMemo(() => {
    const out: Row[] = [];
    for (const o of offers ?? []) {
      let offer: Offer;
      try {
        offer = offerFromJson(o.offer);
      } catch {
        continue;
      }
      const nt = app.tokens.get(offer.nexusToken);
      const et = tokenOf(app.info, o.offer.evmChainId, o.offer.evmToken);
      if (!nt || !et) {
        continue;
      }
      const p = price(offer.nexusAmount, nt.decimals, offer.evmAmount, et.decimals, 12);
      out.push({ o, offer, nexusTicker: nt.ticker, nexusDecimals: nt.decimals, evmSymbol: et.symbol, evmDecimals: et.decimals, chainId: o.offer.evmChainId, price: p, priceNum: Number(p.replace(/,/g, '')), stable: isStable(et), group: groupOf(et) });
    }
    return out;
  }, [offers, app.info, app.tokens]);
}

const chainLabels: Record<string, string> = { '56': 'BSC', '97': 'BSC', '137': 'Polygon', '80002': 'Polygon', '1': 'Ethereum', '11155111': 'Ethereum', '31337': 'Local' };
export const chainLabel = (id: string) => chainLabels[id] ?? id;

//the price a person sees: 2 decimals for ordinary prices, 4 below 1, and 4 significant digits for tiny ones (NXS in ETH)
export function shownPrice(n: number): string {
  if (!Number.isFinite(n)) {
    return '-';
  }
  if (n !== 0 && Math.abs(n) < 0.01) {
    return n.toLocaleString('en-US', { maximumSignificantDigits: 4 });
  }
  const digits = Math.abs(n) >= 1 ? 2 : 4;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

//dollar prices from the relay: Nexus coins by token id, EVM tokens as "<chain id>:<address>". One request per 5
//minutes for the whole page.
const priceTtl = 300000;
type PriceMap = { prices: Record<string, { usd: number; source?: string }>; source: string };
let priceCache: { relay: string; at: number; p: Promise<PriceMap> } | null = null;

function pricesOf(app: AppState): Promise<PriceMap> {
  if (!priceCache || priceCache.relay !== app.relay.base || Date.now() - priceCache.at > priceTtl) {
    priceCache = { relay: app.relay.base, at: Date.now(), p: app.relay.price().catch(() => ({ prices: {}, source: '' })) };
  }
  return priceCache.p;
}

//dollars per one EVM token: its fixed value from the relay config, else the relay price; null when unknown
export function useTokenUsd(app: AppState): (chainId: string, address: string) => number | null {
  const [map, setMap] = useState<PriceMap | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => void pricesOf(app).then((r) => !stop && setMap(r));
    load();
    const t = window.setInterval(load, priceTtl);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [app.relay]); // eslint-disable-line react-hooks/exhaustive-deps
  return (chainId, address) => {
    const t = tokenOf(app.info, chainId, address);
    if (typeof t?.usd === 'number') {
      return t.usd;
    }
    if (t && isStable(t)) {
      return 1;
    }
    return map?.prices[`${chainId}:${address.toLowerCase()}`]?.usd ?? null;
  };
}

export function useMarketPrice(app: AppState, token: string | undefined): { usd: number; source: string } | null {
  const [v, setV] = useState<{ usd: number; source: string } | null>(null);
  useEffect(() => {
    if (token === undefined) {
      setV(null);
      return;
    }
    let stop = false;
    const load = () => {
      void pricesOf(app).then((r) => {
        const p = r.prices[token];
        if (!stop) {
          setV(p ? { usd: p.usd, source: p.source ?? r.source } : null);
        }
      });
    };
    load();
    const t = window.setInterval(load, priceTtl);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [app.relay, token]);
  return v;
}

//how far a price is from the market, said from the side of the person about to act: paying more than the market
//(buying) or getting less (selling) by `warnAt` or more is a warning
const warnAt = 0.1;
export function marketNote(priceNum: number, market: { usd: number; source: string } | null, iBuy: boolean): { text: string; warn: boolean } | null {
  if (!market || !Number.isFinite(priceNum) || priceNum <= 0) {
    return null;
  }
  const diff = priceNum / market.usd - 1;
  const pct = Math.round(Math.abs(diff) * 100);
  //T() and not a parameter: MarketNote.tsx calls this too
  const { t, f } = T();
  const vars = { price: shownPrice(market.usd), source: market.source || t.advMarketReference, pct };
  if (pct < 1) {
    return { text: f(t.advMarketMatches, vars), warn: false };
  }
  const worse = iBuy ? diff > 0 : diff < 0;
  return { text: f(diff > 0 ? t.advMarketAbove : t.advMarketBelow, vars), warn: worse && Math.abs(diff) >= warnAt };
}

//the EVM token balance of the connected address on one chain (null while unknown)
//owner: whose balance (default: the connected wallet)
export function useEvmBalance(app: AppState, chainId: string | null, token: Address | null, owner?: Address | null): bigint | null {
  const [bal, setBal] = useState<bigint | null>(null);
  const address = owner === undefined ? app.evm?.address : owner;
  useEffect(() => {
    setBal(null);
    const c = chainId ? app.info.chains[chainId] : undefined;
    if (!address || !c || !token || !chainId) {
      return;
    }
    let stop = false;
    const client = readClient(app.site, chainId, c);
    //the chain's own coin (ETH, BNB, POL) is the address balance, a token its balanceOf
    const read = isNative(token) ? client.getBalance({ address: address as Address }) : client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address as Address] });
    read
      .then((b) => !stop && setBal(b))
      .catch(() => !stop && setBal(null));
    return () => {
      stop = true;
    };
  }, [address, app.info, app.site, chainId, token]);
  return bal;
}

//balance of a Nexus account in the given token (null while unknown or when the account holds another token)
function useNexusBalance(app: AppState, address: string | null, token: string | null): bigint | null {
  const [bal, setBal] = useState<bigint | null>(null);
  useEffect(() => {
    setBal(null);
    if (!address || token === null) {
      return;
    }
    let stop = false;
    app.node
      .accountState(address)
      .then((s) => !stop && setBal(s.token === token ? s.balance : 0n))
      .catch(() => !stop && setBal(null));
    return () => {
      stop = true;
    };
  }, [address, token, app.node]);
  return bal;
}

//gas of the EVM steps a user sends in a swap (forge gas report 2026-11-14 plus the 21000 of every transaction, rounded
//up): approve of an ERC-20, the lock, the claim (the SK256 check of the secret is most of it)
const stepGas = { approve: 70000n, lock: 200000n, claim: 330000n };
const feeRefreshMs = 60000;

export interface NetworkFee {
  coin: string; //the chain's gas coin, e.g. BNB
  amount: number; //in that coin
  usd: number | null;
}

//about what the user's own EVM step of a swap costs at today's gas price: paying = lock (plus approve for a token),
//getting = the claim. null while unknown or when there is no such step (chainId null)
export function useNetworkFee(app: AppState, chainId: string | null, token: Address | null, step: 'lock' | 'claim'): NetworkFee | null {
  const [gasPrice, setGasPrice] = useState<bigint | null>(null);
  const usdOf = useTokenUsd(app);
  useEffect(() => {
    setGasPrice(null);
    const c = chainId ? app.info.chains[chainId] : undefined;
    if (!c || !chainId) {
      return;
    }
    let stop = false;
    const load = () =>
      void readClient(app.site, chainId, c)
        .getGasPrice()
        .then((p) => !stop && setGasPrice(p))
        .catch(() => {});
    load();
    const t = window.setInterval(load, feeRefreshMs);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [app.info, app.site, chainId]);
  if (!chainId || gasPrice === null || !token) {
    return null;
  }
  const gas = step === 'claim' ? stepGas.claim : stepGas.lock + (isNative(token) ? 0n : stepGas.approve);
  const amount = Number(gas * gasPrice) / 1e18;
  const rate = usdOf(chainId, nativeToken);
  return { coin: gasCoinOf(chainId), amount, usd: rate === null ? null : amount * rate };
}

//dollars of an offer's EVM side, null when the token has no price
export function evmUsd(r: Row, usdOf: (chainId: string, address: string) => number | null): number | null {
  const u = usdOf(r.chainId, r.offer.evmToken);
  return u === null ? null : (Number(r.offer.evmAmount) / 10 ** r.evmDecimals) * u;
}

export type Need = 'nexus' | 'evm' | null;

//what the user still has to do before this swap can start; empty = ready. `need` says which connection is missing
//first, so a button can open the right dialog instead of only being greyed out.
export function useTakeChecks(app: AppState, row: Row | null): { problems: string[]; nexusAccount: string | null; need: Need } {
  const takerGivesNexus = row ? !row.offer.makerGivesNexus : false;
  const evmBalance = useEvmBalance(app, row && !takerGivesNexus ? row.chainId : null, row ? row.offer.evmToken : null);
  //the maker must still hold what it gives: else the taker locks first and its coins wait for the refund deadline
  const makerEvm = useEvmBalance(app, row && takerGivesNexus ? row.chainId : null, row ? row.offer.evmToken : null, row ? row.offer.maker : null);
  const makerNexus = useNexusBalance(app, row && !takerGivesNexus ? row.offer.nexusAccount : null, row ? row.offer.nexusToken : null);
  const problems: string[] = [];
  let need: Need = null;
  //T() and not a parameter: Simple.tsx calls this too
  const { t, f } = T();
  if (!row) {
    return { problems, nexusAccount: null, need };
  }
  if (!app.nexus) {
    problems.push(t.advCheckSignIn);
    need = 'nexus';
  }
  if (!app.evm) {
    problems.push(takerGivesNexus ? t.advCheckWalletOrAddress : t.advCheckWallet);
    need ??= 'evm';
  } else if (!app.evm.wallet && !takerGivesNexus) {
    problems.push(t.deskReceiveOnlyPays);
    need ??= 'evm';
  }
  const accounts = accountsFor(app.nexus, row.offer.nexusToken);
  let nexusAccount: string | null = null;
  if (app.nexus) {
    if (takerGivesNexus) {
      const a = accounts.find((x) => x.balance >= row.offer.nexusAmount);
      nexusAccount = a?.address ?? null;
      if (!a) {
        problems.push(f(t.advCheckNeedNexus, { amount: fromUnits(row.offer.nexusAmount, row.nexusDecimals), coin: row.nexusTicker }));
      }
    } else {
      nexusAccount = accounts[0]?.address ?? null;
      if (!nexusAccount) {
        problems.push(f(t.advCheckNeedAccount, { coin: row.nexusTicker }));
      }
      if (!app.nexus.slotReady) {
        problems.push(t.advCheckSetUpSwaps);
        need ??= 'nexus';
      }
    }
  }
  if (app.evm && !takerGivesNexus && evmBalance !== null && evmBalance < row.offer.evmAmount) {
    problems.push(f(t.advCheckWalletHas, { balance: fromUnits(evmBalance, row.evmDecimals, evmFraction(row.stable, row.evmDecimals)), coin: row.evmSymbol, amount: fromUnits(row.offer.evmAmount, row.evmDecimals, evmFraction(row.stable, row.evmDecimals)) }));
  } else if (app.evm && !takerGivesNexus && evmBalance !== null && isNative(row.offer.evmToken) && evmBalance - row.offer.evmAmount < nativeFeeReserve) {
    //paying with the coin the network fee is paid in: all of it cannot go into the lock
    problems.push(f(t.advCheckKeepFee, { coin: row.evmSymbol, amount: fromUnits(row.offer.evmAmount, row.evmDecimals, 6) }));
  }
  if (app.evm && app.evm.address.toLowerCase() === row.offer.maker.toLowerCase()) {
    problems.push(t.advCheckOwnOffer);
  } else if (takerGivesNexus ? makerEvm !== null && makerEvm < row.offer.evmAmount : makerNexus !== null && makerNexus < row.offer.nexusAmount) {
    problems.push(t.advCheckMakerFunds);
  }
  return { problems, nexusAccount, need };
}

//what the user still has to do before posting an offer; `need` = which connection to open first
//evm: the stablecoin and total of the offer, checked against the service's size limit
export function makeChecks(app: AppState, sell: boolean, acct: NexusAccount | undefined, nexusUnits: bigint | null, evm?: { token?: TokenInfo; units: bigint | null }): { problems: string[]; need: Need } {
  const problems: string[] = [];
  let need: Need = null;
  //T() and not a parameter: Simple.tsx calls this too
  const { t, f } = T();
  if (!app.nexus) {
    problems.push(t.advCheckSignIn);
    need = 'nexus';
  } else if (!acct) {
    problems.push(t.advCheckNoAccount);
  } else if (!sell && !app.nexus.slotReady) {
    problems.push(t.advCheckSetUpSwaps);
    need = 'nexus';
  }
  if (!app.evm) {
    problems.push(sell ? t.advCheckWalletOrAddress : t.advCheckWallet);
    need ??= 'evm';
  } else if (!app.evm.wallet && !sell) {
    problems.push(t.deskReceiveOnlyPays);
    need ??= 'evm';
  }
  if (sell && acct && nexusUnits !== null && nexusUnits > acct.balance) {
    problems.push(f(t.advCheckAccountHolds, { balance: fromUnits(acct.balance, acct.decimals), coin: acct.ticker }));
  }
  const max = evm?.token?.maxAmount ? BigInt(evm.token.maxAmount) : null;
  if (max !== null && evm?.units != null && evm.units > max) {
    problems.push(f(t.advCheckMax, { max: evmAmount(max, evm.token!), coin: evm.token!.symbol }));
  }
  return { problems, need };
}
