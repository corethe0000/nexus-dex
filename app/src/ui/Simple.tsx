//simple mode: one swap ticket. Pick sell or buy, type what you pay, and the page picks the best offer that fits. An
//atomic swap takes an offer whole, so the ticket shows that offer's exact amounts; other offer sizes are one tap away.
//No offer fits: post your own at a suggested price, from the same ticket.
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { AppState } from '../App';
import { askToNotify } from '../lib/attention';
import { fromUnits, span, toUnits } from '../lib/format';
import { useT } from '../lib/i18n';
import { termsAccepted } from '../lib/terms';
import { takeLinkedOffer } from '../lib/link';
import { accountsFor, spendable } from '../lib/nexus';
import { Knot } from './Frame';
import { FeeNote, MarketNote } from './MarketNote';
import { ShareLink } from './ShareLink';
import { evmFraction, evmUsd, isStable, makeChecks, shownPrice, useEvmBalance, useMarketPrice, useNetworkFee, useOffers, useRows, useTakeChecks, useTokenUsd, type Row } from './offers';

//the chart panel loads after the ticket
const StableMarketPanel = lazy(() => import('./MarketCharts').then((m) => ({ default: m.StableMarketPanel })));

type Dir = 'sell' | 'buy';

interface Route {
  id: string; //chainId:token
  chainId: string;
  token: `0x${string}`;
  symbol: string;
  stable: boolean;
  decimals: number;
  chainName: string;
}

const amountRe = /^\d*([.,]\d*)?$/;

//a sentence with {b} where the bold part goes
function withBold(text: string, bold: string) {
  const [pre = '', post = ''] = text.split('{b}');
  return (
    <>
      {pre}
      <b>{bold}</b>
      {post}
    </>
  );
}

export function Simple({ app, onSwap }: { app: AppState; onSwap: () => void }) {
  const { t, f } = useT();
  const { offers, error: loadError } = useOffers(app);
  const rows = useRows(app, offers);
  const [dir, setDir] = useState<Dir>('sell');
  const [amount, setAmount] = useState('');
  const [routeId, setRouteId] = useState('any');
  const [coinPick, setCoinPick] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [own, setOwn] = useState(false);
  //an offer from a shared link: picked once the book is loaded, or a note that it is not up
  const [linked, setLinked] = useState(takeLinkedOffer);
  const [linkGone, setLinkGone] = useState(false);

  const routes = useMemo<Route[]>(
    () => Object.entries(app.info.chains).flatMap(([chainId, c]) => c.tokens.map((tk) => ({ id: `${chainId}:${tk.address}`, chainId, token: tk.address, symbol: tk.symbol, stable: isStable(tk), decimals: tk.decimals, chainName: c.name }))),
    [app.info],
  );
  //"any" = any stablecoin (they are all worth a dollar, so their prices compare); without stablecoins the first token
  const anyStable = routes.some((r) => r.stable);
  const route = routes.find((r) => r.id === routeId) ?? (anyStable ? null : (routes[0] ?? null));
  const usdOf = useTokenUsd(app);

  useEffect(() => {
    if (!linked || offers === null) {
      return;
    }
    setLinked(null);
    const r = rows.find((x) => x.o.id.toLowerCase() === linked);
    const rt = r && routes.find((x) => x.chainId === r.chainId && x.token.toLowerCase() === r.offer.evmToken.toLowerCase());
    if (!r || !rt) {
      setLinkGone(true);
      return;
    }
    const buy = r.offer.makerGivesNexus;
    setDir(buy ? 'buy' : 'sell');
    setCoinPick(r.offer.nexusToken);
    setRouteId(rt.id);
    //full precision: a rounded amount could be just below the offer, and then the offer would not fit
    setAmount((buy ? fromUnits(r.offer.evmAmount, r.evmDecimals) : fromUnits(r.offer.nexusAmount, r.nexusDecimals)).replace(/,/g, ''));
    setChosen(r.o.id);
  }, [linked, offers, rows, routes]);

  //the Nexus coins people trade here; NXS first, then whatever has offers
  const coins = useMemo(() => {
    const m = new Map<string, { token: string; ticker: string; decimals: number; n: number }>([['0', { token: '0', ticker: 'NXS', decimals: 6, n: 0 }]]);
    for (const r of rows) {
      const c = m.get(r.offer.nexusToken) ?? { token: r.offer.nexusToken, ticker: r.nexusTicker, decimals: r.nexusDecimals, n: 0 };
      c.n++;
      m.set(r.offer.nexusToken, c);
    }
    return [...m.values()];
  }, [rows]);
  const coin = coins.find((c) => c.token === coinPick) ?? [...coins].sort((a, b) => b.n - a.n)[0]!;
  const market = useMarketPrice(app, coin.token);

  //offers on the other side of what I want, best price first
  const candidates = rows
    .filter((r) => (dir === 'sell' ? !r.offer.makerGivesNexus : r.offer.makerGivesNexus) && r.offer.nexusToken === coin.token && (route ? r.chainId === route.chainId && r.offer.evmToken.toLowerCase() === route.token.toLowerCase() : r.stable))
    .sort((a, b) => (dir === 'sell' ? b.priceNum - a.priceNum : a.priceNum - b.priceNum));
  const paidOf = (r: Row) => (dir === 'sell' ? Number(r.offer.nexusAmount) / 10 ** r.nexusDecimals : Number(r.offer.evmAmount) / 10 ** r.evmDecimals);
  const evmText = (r: Row) => fromUnits(r.offer.evmAmount, r.evmDecimals, evmFraction(r.stable, r.evmDecimals));
  const gotOf = (r: Row) => (dir === 'sell' ? evmText(r) : fromUnits(r.offer.nexusAmount, r.nexusDecimals));
  const paidText = (r: Row) => (dir === 'sell' ? fromUnits(r.offer.nexusAmount, r.nexusDecimals) : evmText(r));
  const typedOk = amountRe.test(amount.trim());
  const typed = typedOk && amount.trim() !== '' ? Number(amount.replace(',', '.')) : null;
  const fits = typed && typed > 0 ? candidates.filter((r) => paidOf(r) <= typed * (1 + 1e-12)) : candidates;
  const match = fits.find((r) => r.o.id === chosen) ?? fits[0] ?? null;
  const smallest = candidates.length ? candidates.reduce((a, b) => (paidOf(b) < paidOf(a) ? b : a)) : null;
  //a few other sizes to pick from, best price first, one per size
  const sizes = candidates.filter((r, i) => candidates.findIndex((x) => paidOf(x) === paidOf(r)) === i).slice(0, 4);

  const payUnit = dir === 'sell' ? coin.ticker : (match?.evmSymbol ?? route?.symbol ?? 'USD');
  const getUnit = dir === 'sell' ? (match?.evmSymbol ?? route?.symbol ?? 'USD') : coin.ticker;

  //balance of what I pay
  const nexusBal = spendable(app.nexus, coin.token);
  const evmBal = useEvmBalance(app, dir === 'buy' ? (match?.chainId ?? route?.chainId ?? null) : null, dir === 'buy' ? (match?.offer.evmToken ?? route?.token ?? null) : null);
  const balance = dir === 'sell' ? (app.nexus ? `${fromUnits(nexusBal, coin.decimals)} ${coin.ticker}` : null) : evmBal !== null ? `${fromUnits(evmBal, match?.evmDecimals ?? route?.decimals ?? 6, evmFraction(match?.stable ?? route?.stable ?? true, match?.evmDecimals ?? route?.decimals ?? 6))} ${payUnit}` : null;

  const { problems, nexusAccount, need } = useTakeChecks(app, match);
  //my own EVM step: the lock when I pay there, the claim when I get paid there (receive only: the relay or a keeper
  //collects and pays that fee)
  const fee = useNetworkFee(app, match && !(dir === 'sell' && app.evm && !app.evm.wallet) ? match.chainId : null, match?.offer.evmToken ?? null, dir === 'buy' ? 'lock' : 'claim');

  function flip() {
    setDir(dir === 'sell' ? 'buy' : 'sell');
    setAmount('');
    setChosen(null);
    setOwn(false);
    setError('');
  }

  async function go() {
    if (!match) {
      return;
    }
    if (need) {
      app.openDialog(need);
      return;
    }
    setBusy(true);
    setError('');
    try {
      //the notice before the first swap, once
      if (!termsAccepted()) {
        app.openDialog('terms');
        return;
      }
      askToNotify();
      await app.desk.takeOffer(match.o, nexusAccount!);
      onSwap();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  //the main button says exactly what happens, or what is missing
  let cta: { text: string; enabled: boolean; hint?: string } = { text: '', enabled: false };
  if (offers === null && !loadError) {
    cta = { text: t.trLoadingOffers, enabled: false };
  } else if (candidates.length === 0) {
    cta = { text: f(dir === 'sell' ? t.trNobodyBuying : t.trNobodySelling, { coin: coin.ticker }), enabled: false };
  } else if (!typedOk) {
    cta = { text: t.trEnterAmount, enabled: false };
  } else if (!match) {
    cta = { text: t.trNoOfferFits, enabled: false, hint: smallest ? f(t.trSmallestOffer, { amount: paidText(smallest), unit: payUnit }) : undefined };
  } else if (busy) {
    cta = { text: t.trAsking, enabled: false };
  } else if (need === 'nexus') {
    cta = { text: app.nexus ? t.trSetUpSwaps : t.trSignInToSwap, enabled: true };
  } else if (need === 'evm') {
    cta = { text: dir === 'sell' ? t.trAddWallet : t.trConnectToPay, enabled: true };
  } else if (problems.length) {
    cta = { text: t.trNotReady, enabled: false };
  } else {
    cta = { text: f(t.trSwapFor, { pay: `${paidText(match)} ${payUnit}`, get: `${gotOf(match)} ${getUnit}` }), enabled: true };
  }
  const timing = app.info.timing;
  const bigger = match && typed !== null && typed > paidOf(match) * (1 + 1e-9);

  return (
    <div className="simple">
      <section className="ticket" aria-label={t.trTicket}>
        <div className="ticket-dir seg wide" role="group" aria-label={t.trWhatToDo}>
          <button aria-pressed={dir === 'sell'} onClick={() => dir !== 'sell' && flip()}>
            {f(t.trSellCoin, { coin: coin.ticker })}
          </button>
          <button aria-pressed={dir === 'buy'} onClick={() => dir !== 'buy' && flip()}>
            {f(t.trBuyCoin, { coin: coin.ticker })}
          </button>
        </div>
        {linkGone && (
          <p className="ticket-note warn" role="status">
            {t.trLinkGone}
          </p>
        )}

        <div className={`ticket-leg ${dir === 'sell' ? 'chain-nexus' : `chain-${match?.chainId ?? route?.chainId ?? ''}`}`}>
          <label className="leg-label" htmlFor="pay-amount">
            {t.trYouPay}
          </label>
          <div className="leg-main">
            <input
              id="pay-amount"
              className="leg-amount"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setChosen(null);
              }}
              inputMode="decimal"
              autoComplete="off"
              placeholder={match ? paidText(match) : '0'}
              aria-invalid={!typedOk}
            />
            {dir === 'sell' ? <CoinPick coins={coins} value={coin.token} onChange={(v) => (setCoinPick(v), setChosen(null))} /> : <RoutePick routes={routes} value={routeId} onChange={(v) => (setRouteId(v), setChosen(null))} />}
          </div>
          <div className="leg-foot">
            <span>{dir === 'sell' ? t.trOnNexus : match ? f(t.trOnChain, { chain: app.info.chains[match.chainId]?.name ?? match.chainId }) : route ? f(t.trOnChain, { chain: route.chainName }) : t.trOnAnyChain}</span>
            {balance && (
              <button type="button" className="link" onClick={() => setAmount(balance.split(' ')[0]!.replace(/,/g, ''))} title={t.trUseBalance}>
                {f(t.trBalance, { balance })}
              </button>
            )}
          </div>
        </div>

        <button className="ticket-flip" onClick={flip} aria-label={f(dir === 'sell' ? t.trSwitchToBuying : t.trSwitchToSelling, { coin: coin.ticker })}>
          <Knot spin={busy} size={30} />
        </button>

        <div className={`ticket-leg get ${dir === 'sell' ? `chain-${match?.chainId ?? route?.chainId ?? ''}` : 'chain-nexus'}`}>
          <span className="leg-label">{t.trYouGet}</span>
          <div className="leg-main">
            <output className="leg-amount" aria-live="polite">
              {match ? gotOf(match) : '0'}
            </output>
            {dir === 'sell' ? <RoutePick routes={routes} value={routeId} onChange={(v) => (setRouteId(v), setChosen(null))} /> : <CoinPick coins={coins} value={coin.token} onChange={(v) => (setCoinPick(v), setChosen(null))} />}
          </div>
          <div className="leg-foot">
            <span>{dir === 'buy' ? t.trOnNexus : match ? f(t.trOnChain, { chain: app.info.chains[match.chainId]?.name ?? match.chainId }) : route ? f(t.trOnChain, { chain: route.chainName }) : t.trOnAnyChain}</span>
            {match && (
              <span>
                1 {coin.ticker} = {shownPrice(match.priceNum)} {match.evmSymbol}
              </span>
            )}
          </div>
        </div>

        {match && (
          <p className={`ticket-note${bigger ? ' warn' : ''}`}>
            {bigger
              ? f(t.trBestFits, { amount: paidText(match), unit: payUnit })
              : f(t.trLockFirst, { unit: payUnit, time: span(timing.initiatorLock) })}
          </p>
        )}
        {match && <MarketNote priceNum={match.priceNum * (usdOf(match.chainId, match.offer.evmToken) ?? NaN)} market={market} iBuy={dir === 'buy'} />}
        {match && <FeeNote fee={fee} chain={app.info.chains[match.chainId]?.name ?? match.chainId} swapUsd={evmUsd(match, usdOf)} />}

        {sizes.length > 1 && (
          <div className="sizes" role="group" aria-label={t.trOtherOffers}>
            {sizes.map((r) => (
              <button
                key={r.o.id}
                aria-pressed={match?.o.id === r.o.id}
                onClick={() => {
                  setAmount(paidText(r).replace(/,/g, ''));
                  setChosen(r.o.id);
                }}
              >
                {paidText(r)} {payUnit}
                <small>{f(t.trAtPrice, { price: shownPrice(r.priceNum) })}</small>
              </button>
            ))}
          </div>
        )}

        {match && problems.length > 0 && !need && (
          <ul className="problem">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {(error || loadError) && <p className="problem">{error || loadError}</p>}
        <button className="btn big" disabled={!cta.enabled} onClick={go} aria-busy={busy}>
          {cta.text}
        </button>
        {cta.hint && <p className="ticket-note">{cta.hint}</p>}

        <button type="button" className="link own-toggle" onClick={() => setOwn(!own)} aria-expanded={own}>
          {own ? t.trHideOwn : f(dir === 'sell' ? t.trOwnSell : t.trOwnBuy, { coin: coin.ticker })}
        </button>
        {own && <OwnOffer app={app} dir={dir} coin={coin} amount={typed} route={route ?? routes[0] ?? null} candidates={candidates} market={market} usd={route ? usdOf(route.chainId, route.token) : null} />}
      </section>

      <Suspense fallback={null}>
        <StableMarketPanel app={app} token={coin.token} compact />
      </Suspense>

      <ol className="how" aria-label={t.trHowTitle}>
        <li>
          <span>{withBold(t.trHow1, t.trHow1Bold)}</span>
        </li>
        <li>
          <span>{withBold(t.trHow2, t.trHow2Bold)}</span>
        </li>
        <li>
          <span>{withBold(t.trHow3, t.trHow3Bold)}</span>
        </li>
      </ol>
    </div>
  );
}

function CoinPick({ coins, value, onChange }: { coins: { token: string; ticker: string }[]; value: string; onChange: (v: string) => void }) {
  const { t } = useT();
  if (coins.length < 2) {
    return <span className="coin chain-nexus">{coins[0]?.ticker ?? 'NXS'}</span>;
  }
  return (
    <select className="coin chain-nexus" value={value} onChange={(e) => onChange(e.target.value)} aria-label={t.trNexusCoin}>
      {coins.map((c) => (
        <option key={c.token} value={c.token}>
          {c.ticker}
        </option>
      ))}
    </select>
  );
}

function RoutePick({ routes, value, onChange }: { routes: Route[]; value: string; onChange: (v: string) => void }) {
  const { t, f } = useT();
  const r = routes.find((x) => x.id === value);
  return (
    <select className={`coin chain-${r?.chainId ?? ''}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={t.trCoinAndChain}>
      {routes.some((x) => x.stable) && <option value="any">{t.trAnyStable}</option>}
      {routes.map((x) => (
        <option key={x.id} value={x.id}>
          {f(t.trTokenOnChain, { symbol: x.symbol, chain: x.chainName })}
        </option>
      ))}
    </select>
  );
}

//no offer fits, or the user wants a better price: post an offer from the ticket, the price starts at the best one on
//the same side (what others ask for), so the offer lands where people look
function OwnOffer({ app, dir, coin, amount, route, candidates, market, usd }: { app: AppState; dir: Dir; coin: { token: string; ticker: string; decimals: number }; amount: number | null; route: Route | null; candidates: Row[]; market: { usd: number; source: string } | null; usd: number | null }) {
  const { t, f } = useT();
  const sell = dir === 'sell';
  const [size, setSize] = useState(amount ? String(amount) : '');
  //starts at the best offer on the same side, else at the market price
  const inToken = (dollars: number) => String(Number((dollars / usd!).toPrecision(6)));
  const [priceText, setPriceText] = useState(candidates[0] ? String(candidates[0].priceNum) : market && usd ? inToken(market.usd) : '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [postedId, setPostedId] = useState<string | null>(null);
  const accounts = accountsFor(app.nexus, coin.token);
  const nexusUnits = toUnits(size, coin.decimals);
  const acct = sell ? (accounts.find((a) => nexusUnits !== null && a.balance >= nexusUnits) ?? accounts[0]) : accounts[0];
  const priceUnits = route ? toUnits(priceText, route.decimals) : null;
  const evmUnits = nexusUnits !== null && priceUnits !== null ? (nexusUnits * priceUnits) / 10n ** BigInt(coin.decimals) : null;
  const { problems, need } = makeChecks(app, sell, acct, nexusUnits, { token: route ? app.info.chains[route.chainId]?.tokens.find((tk) => tk.address === route.token) : undefined, units: evmUnits });
  const incomplete = !route || nexusUnits === null || nexusUnits <= 0n || evmUnits === null || evmUnits <= 0n;

  async function post() {
    if (need) {
      app.openDialog(need);
      return;
    }
    setBusy(true);
    setMsg(null);
    setPostedId(null);
    try {
      //the notice before the first swap, once
      if (!termsAccepted()) {
        app.openDialog('terms');
        return;
      }
      askToNotify();
      const mine = await app.desk.postOffer({
        nexusAccount: acct!.address,
        nexusGenesis: app.nexus!.genesis,
        makerGivesNexus: sell,
        nexusToken: coin.token,
        nexusAmount: nexusUnits!,
        evmChainId: BigInt(route!.chainId),
        evmToken: route!.token,
        evmAmount: evmUnits!,
        expires: BigInt(Math.floor(Date.now() / 1000) + 24 * 3600),
      });
      setMsg({ ok: true, text: t.trOwnPosted });
      setPostedId(mine.id);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="own">
      <div className="pair">
        <label className="field">
          <span>{f(sell ? t.trOwnSellField : t.trOwnBuyField, { coin: coin.ticker })}</span>
          <input value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal" placeholder="0" />
        </label>
        <label className="field">
          <span>{f(t.trPricePer, { coin: coin.ticker, unit: route?.symbol ?? '' })}</span>
          <input value={priceText} onChange={(e) => setPriceText(e.target.value)} inputMode="decimal" placeholder="0.00" />
        </label>
      </div>
      {route && <p className="ticket-note">{f(t.trPaidIn, { symbol: route.symbol, chain: route.chainName })}</p>}
      {usd !== null && <MarketNote priceNum={Number(priceText.replace(',', '.')) * usd} market={market} iBuy={!sell} onUse={(d) => setPriceText(inToken(d))} />}
      {evmUnits !== null && evmUnits > 0n && route && (
        <p className="fine">
          {f(sell ? t.trOwnGetWhen : t.trOwnPayWhen, { amount: fromUnits(evmUnits, route.decimals, evmFraction(route.stable, route.decimals)), symbol: route.symbol })}
        </p>
      )}
      {problems.length > 0 && !need && (
        <ul className="problem">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {msg && (
        <p className={`${msg.ok ? 'fine' : 'problem'} posted-line`}>
          {msg.text} {msg.ok && postedId && <ShareLink app={app} id={postedId} />}
        </p>
      )}
      <button className="btn" disabled={busy || (!need && (problems.length > 0 || incomplete))} onClick={post} aria-busy={busy}>
        {busy ? t.trPosting : need === 'nexus' ? t.trSignIn : need === 'evm' ? t.trConnectWallet : t.trPostOffer}
      </button>
    </div>
  );
}
