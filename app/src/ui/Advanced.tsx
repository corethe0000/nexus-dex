//advanced trading: the whole offer book with filters, best prices and depth, taking any offer, and posting offers
//at your own price (with how long they stay up). The same checks as simple mode (offers.ts).
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import type { AppState } from '../App';
import { askToNotify } from '../lib/attention';
import { tokenOf, type TokenInfo } from '../lib/config';
import type { MyOfferState } from '../lib/desk';
import { fromUnits, span, toUnits } from '../lib/format';
import { useT, type Texts } from '../lib/i18n';
import { FeeNote, MarketNote } from './MarketNote';
import { ShareLink } from './ShareLink';
import { StableMarketPanel } from './MarketCharts';
import { chainLabel, evmAmount, evmFraction, evmUsd, groupName, groupOf, makeChecks, shownPrice, useMarketPrice, useNetworkFee, useOffers, useRows, useTakeChecks, useTokenUsd, type Row } from './offers';

//a text whose {name} placeholders are elements (bold prices): the sentence stays whole for translators
function withParts(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((s, i) => (i % 2 ? <Fragment key={i}>{parts[s] ?? `{${s}}`}</Fragment> : s));
}

//NXS, then the site's listed Nexus tokens in its order, then the rest
function rankOf(app: AppState, token: string): number {
  if (token === '0') {
    return 0;
  }
  const i = (app.site.nexusTokens ?? []).findIndex((x) => x.token === token);
  return i >= 0 ? 1 + i : 1000;
}

export function Advanced({ app, onSwap }: { app: AppState; onSwap: () => void }) {
  const { t, f } = useT();
  const { offers, error } = useOffers(app);
  const all = useRows(app, offers);
  const [chain, setChain] = useState<string>('all');
  //prices are compared only inside one group: every stablecoin together, or one other token on its own
  const groups = [...new Set(Object.values(app.info.chains).flatMap((c) => c.tokens.map(groupOf)))].sort((a, b) => (a === 'usd' ? -1 : b === 'usd' ? 1 : a.localeCompare(b)));
  const [groupPick, setGroup] = useState<string>(groups[0] ?? 'usd');
  const group = groups.includes(groupPick) ? groupPick : (groups[0] ?? 'usd');
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'take' | 'make'>('make');

  //one Nexus token per book: NXS first, then the site's listed tokens, then any other one (its ticker shows its address)
  const coins = [...new Map(all.map((r) => [r.offer.nexusToken, r.nexusTicker])).entries()].sort(([a], [b]) => rankOf(app, a) - rankOf(app, b));
  const [coinPick, setCoin] = useState<string>('0');
  const coin = coins.some(([c]) => c === coinPick) ? coinPick : (coins[0]?.[0] ?? '0');
  const rows = all.filter((r) => (chain === 'all' || r.chainId === chain) && r.group === group && r.offer.nexusToken === coin);
  const asks = rows.filter((r) => r.offer.makerGivesNexus).sort((a, b) => b.priceNum - a.priceNum);
  const bids = rows.filter((r) => !r.offer.makerGivesNexus).sort((a, b) => b.priceNum - a.priceNum);
  const bestAsk = asks[asks.length - 1];
  const bestBid = bids[0];
  const pick = rows.find((r) => r.o.id === selected) ?? null;

  const select = (id: string) => {
    setSelected(id);
    setTab('take');
  };

  return (
    <>
      <Stats app={app} bestAsk={bestAsk} bestBid={bestBid} asks={asks} bids={bids} />
      <StableMarketPanel app={app} token={(bestAsk ?? bestBid)?.offer.nexusToken ?? '0'} />
      <div className="market">
        <section className="panel book-panel" aria-labelledby="book-title">
          <div className="book-head">
            <h2 id="book-title">{t.advOffersTitle}</h2>
            <div className="filters">
              <div className="seg" role="group" aria-label={t.advChainFilter}>
                <button aria-pressed={chain === 'all'} onClick={() => setChain('all')}>
                  {t.advAllChains}
                </button>
                {Object.entries(app.info.chains).map(([id, c]) => (
                  <button key={id} aria-pressed={chain === id} onClick={() => setChain(id)}>
                    {c.name}
                  </button>
                ))}
              </div>
              {coins.length > 1 && (
                <div className="seg" role="group" aria-label={t.advCoinFilter}>
                  {coins.map(([c, ticker]) => (
                    <button key={c} aria-pressed={coin === c} onClick={() => (setCoin(c), setSelected(null))}>
                      {ticker}
                    </button>
                  ))}
                </div>
              )}
              {groups.length > 1 && (
                <div className="seg" role="group" aria-label={t.advPricedIn}>
                  {groups.map((g) => (
                    <button key={g} aria-pressed={group === g} onClick={() => (setGroup(g), setSelected(null))}>
                      {groupName(t, g)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {error && <p className="problem" style={{ margin: '0 20px 12px' }}>{error}</p>}
          <Depth asks={asks} bids={bids} />
          <Side title={t.advPeopleSelling} hint={t.advPeopleSellingHint} rows={asks} kind="sell" selected={selected} onPick={select} loading={offers === null} />
          <div className="spread">
            {bestAsk && bestBid ? (
              <>{withParts(t.advBestPrices, { low: <strong>{shownPrice(bestBid.priceNum)}</strong>, high: <strong>{shownPrice(bestAsk.priceNum)}</strong> })}</>
            ) : (
              <>{t.advNoPriceYet}</>
            )}
          </div>
          <Side title={t.advPeopleBuying} hint={t.advPeopleBuyingHint} rows={bids} kind="buy" selected={selected} onPick={select} loading={offers === null} />
        </section>
        <aside className="panel act" aria-label={t.advTrade}>
          <div className="tabs" role="tablist" aria-label={t.advTakeOrMake}>
            <button role="tab" id="tab-take" aria-controls="tab-panel" aria-selected={tab === 'take' && !!pick} onClick={() => pick && setTab('take')} aria-disabled={!pick}>
              {t.advTakeOffer}
              <small>{pick ? f(t.advTakeOfferPicked, { amount: fromUnits(pick.offer.nexusAmount, pick.nexusDecimals), coin: pick.nexusTicker, price: shownPrice(pick.priceNum) }) : t.advPickOffer}</small>
            </button>
            <button role="tab" id="tab-make" aria-controls="tab-panel" aria-selected={tab === 'make' || !pick} onClick={() => setTab('make')}>
              {t.advMakeOffer}
              <small>{t.advOwnPrice}</small>
            </button>
          </div>
          <div className="tab-panel" id="tab-panel" role="tabpanel" aria-labelledby={tab === 'take' && pick ? 'tab-take' : 'tab-make'}>
            {tab === 'take' && pick ? <Take app={app} row={pick} onSwap={onSwap} /> : <Make app={app} bestAsk={bestAsk} bestBid={bestBid} group={group} />}
          </div>
        </aside>
      </div>
    </>
  );
}

function Stats({ app, bestAsk, bestBid, asks, bids }: { app: AppState; bestAsk?: Row; bestBid?: Row; asks: Row[]; bids: Row[] }) {
  const { t, f } = useT();
  const spread = bestAsk && bestBid ? ((bestAsk.priceNum - bestBid.priceNum) / bestAsk.priceNum) * 100 : null;
  const sum = (rs: Row[]) => rs.reduce((s, r) => s + Number(r.offer.nexusAmount) / 10 ** r.nexusDecimals, 0);
  const ticker = (bestAsk ?? bestBid)?.nexusTicker ?? 'NXS';
  const unit = (bestAsk ?? bestBid)?.evmSymbol ?? '';
  const market = useMarketPrice(app, (bestAsk ?? bestBid)?.offer.nexusToken ?? '0');
  //the market price in the coin this book is priced in (dollars for stablecoins)
  const usdOf = useTokenUsd(app);
  const quote = bestAsk ?? bestBid;
  const quoteUsd = quote && !quote.stable ? usdOf(quote.chainId, quote.offer.evmToken) : 1;
  return (
    <dl className="stats">
      {market && quoteUsd !== null && (
        <div>
          <dt>{t.advMarketPrice}</dt>
          <dd title={f(t.advMarketPriceHint, { price: shownPrice(market.usd), source: market.source })}>{quote && !quote.stable ? `${shownPrice(market.usd / quoteUsd)} ${quote.evmSymbol}` : `$${shownPrice(market.usd)}`}</dd>
        </div>
      )}
      <div>
        <dt>{t.advBestBuyPrice}</dt>
        <dd className="price-buy">{bestBid ? `${shownPrice(bestBid.priceNum)} ${unit}` : '-'}</dd>
      </div>
      <div>
        <dt>{t.advBestSellPrice}</dt>
        <dd className="price-sell">{bestAsk ? `${shownPrice(bestAsk.priceNum)} ${unit}` : '-'}</dd>
      </div>
      <div>
        <dt>{t.advSpread}</dt>
        <dd>{spread === null ? '-' : `${spread.toFixed(2)}%`}</dd>
      </div>
      <div>
        <dt>{t.advOnOffer}</dt>
        <dd>{f(t.advOnOfferText, { forSale: sum(asks).toLocaleString('en-US', { maximumFractionDigits: 4 }), coin: ticker, wanted: sum(bids).toLocaleString('en-US', { maximumFractionDigits: 4 }) })}</dd>
      </div>
    </dl>
  );
}

//cumulative amount on each side by price: buyers step down to the left, sellers step up to the right
function Depth({ asks, bids }: { asks: Row[]; bids: Row[] }) {
  const { t } = useT();
  const w = 600;
  const h = 120;
  const d = useMemo(() => {
    if (asks.length + bids.length === 0) {
      return null;
    }
    const amt = (r: Row) => Number(r.offer.nexusAmount) / 10 ** r.nexusDecimals;
    const b = [...bids].sort((x, y) => y.priceNum - x.priceNum);
    const a = [...asks].sort((x, y) => x.priceNum - y.priceNum);
    const prices = [...a, ...b].map((r) => r.priceNum);
    let lo = Math.min(...prices);
    let hi = Math.max(...prices);
    if (hi === lo) {
      lo *= 0.95;
      hi *= 1.05;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const total = Math.max(b.reduce((s, r) => s + amt(r), 0), a.reduce((s, r) => s + amt(r), 0));
    const x = (p: number) => ((p - lo) / (hi - lo)) * w;
    const y = (v: number) => h - 6 - (v / total) * (h - 16);
    const steps = (rs: Row[], edge: number) => {
      let cum = 0;
      let path = '';
      for (const r of rs) {
        path += `${path ? ' L' : 'M'} ${x(r.priceNum).toFixed(1)} ${y(cum).toFixed(1)}`;
        cum += amt(r);
        path += ` L ${x(r.priceNum).toFixed(1)} ${y(cum).toFixed(1)}`;
      }
      if (rs.length) {
        path += ` L ${edge} ${y(cum).toFixed(1)}`;
        return { line: path, area: `${path} L ${edge} ${h} L ${x(rs[0]!.priceNum).toFixed(1)} ${h} Z` };
      }
      return null;
    };
    return { bid: steps(b, 0), ask: steps(a, w), lo, hi };
  }, [asks, bids]);
  if (!d) {
    return null;
  }
  return (
    <figure className="depth" aria-label={t.advDepth}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-hidden="true">
        {d.bid && (
          <>
            <path d={d.bid.area} className="depth-bid-area" />
            <path d={d.bid.line} className="depth-bid" />
          </>
        )}
        {d.ask && (
          <>
            <path d={d.ask.area} className="depth-ask-area" />
            <path d={d.ask.line} className="depth-ask" />
          </>
        )}
      </svg>
      <figcaption>
        <span>{shownPrice(d.lo)}</span>
        <span>{t.advDepthCaption}</span>
        <span>{shownPrice(d.hi)}</span>
      </figcaption>
    </figure>
  );
}

function Side({ title, hint, rows, kind, selected, onPick, loading }: { title: string; hint: string; rows: Row[]; kind: 'sell' | 'buy'; selected: string | null; onPick: (id: string) => void; loading: boolean }) {
  const { t } = useT();
  return (
    <>
      <div className="side-label">
        {title} <span>{hint}</span>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{loading ? t.advLoadingOffers : t.advNoOffers}</p>
      ) : (
        <table className="book">
          <thead>
            <tr>
              <th>{t.advColPrice}</th>
              <th>{t.advColAmount}</th>
              <th className="hide-s">{t.advColTotal}</th>
              <th>{t.advColChain}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.o.id} aria-selected={selected === r.o.id} tabIndex={0} onClick={() => onPick(r.o.id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onPick(r.o.id)}>
                <td className={kind === 'sell' ? 'price-sell' : 'price-buy'}>
                  {shownPrice(r.priceNum)} {r.evmSymbol}
                </td>
                <td>
                  {fromUnits(r.offer.nexusAmount, r.nexusDecimals)} {r.nexusTicker}
                </td>
                <td className="hide-s">
                  {fromUnits(r.offer.evmAmount, r.evmDecimals, evmFraction(r.stable, r.evmDecimals))} {r.evmSymbol}
                </td>
                <td>
                  <span className={`tag chain-${r.chainId}`}>{chainLabel(r.chainId)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Take({ app, row, onSwap }: { app: AppState; row: Row; onSwap: () => void }) {
  const { problems, nexusAccount, need } = useTakeChecks(app, row);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const takerGivesNexus = !row.offer.makerGivesNexus;
  const nexusText = `${fromUnits(row.offer.nexusAmount, row.nexusDecimals)} ${row.nexusTicker}`;
  const evmText = `${fromUnits(row.offer.evmAmount, row.evmDecimals, evmFraction(row.stable, row.evmDecimals))} ${row.evmSymbol}`;
  const chainName = app.info.chains[row.chainId]?.name ?? row.chainId;
  const timing = app.info.timing;
  const { t, f } = useT();
  const market = useMarketPrice(app, row.offer.nexusToken);
  const usdOf = useTokenUsd(app);
  //receive only: the relay or a keeper collects and pays that fee
  const fee = useNetworkFee(app, takerGivesNexus && app.evm && !app.evm.wallet ? null : row.chainId, row.offer.evmToken, takerGivesNexus ? 'claim' : 'lock');

  async function go() {
    if (need) {
      app.openDialog(need);
      return;
    }
    setBusy(true);
    setError('');
    try {
      askToNotify();
      await app.desk.takeOffer(row.o, nexusAccount!);
      onSwap();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="legs">
        <div className={`leg ${takerGivesNexus ? 'chain-nexus' : `chain-${row.chainId}`}`}>
          <span>{t.advYouPay}</span>
          <b>{takerGivesNexus ? nexusText : evmText}</b>
        </div>
        <div className={`leg ${takerGivesNexus ? `chain-${row.chainId}` : 'chain-nexus'}`}>
          <span>{t.advYouGet}</span>
          <b>{takerGivesNexus ? evmText : nexusText}</b>
        </div>
      </div>
      <p className="note" style={{ marginTop: 0 }}>
        {f(takerGivesNexus ? t.advTakePayNexus : t.advTakeGetNexus, { chain: chainName, time: span(timing.initiatorLock) })}
      </p>
      <MarketNote priceNum={row.priceNum * (usdOf(row.chainId, row.offer.evmToken) ?? NaN)} market={market} iBuy={!takerGivesNexus} />
      <FeeNote fee={fee} chain={chainName} swapUsd={evmUsd(row, usdOf)} />
      {problems.length > 0 && !need && (
        <ul className="problem" style={{ paddingLeft: 28 }}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && <p className="problem">{error}</p>}
      <button className="btn" disabled={busy || (problems.length > 0 && !need)} onClick={go} aria-busy={busy}>
        {busy ? t.advAsking : need === 'nexus' ? t.advSignInNexus : need === 'evm' ? t.advConnectWallet : f(t.advSwapFor, { amount: takerGivesNexus ? evmText : nexusText })}
      </button>
      <p className="note">{t.advKeepOpen}</p>
    </>
  );
}

const offerStateText = (t: Texts): Record<MyOfferState, string> => ({ open: t.advStateOpen, swapping: t.advStateSwapping, swapped: t.advStateSwapped, 'not done': t.advStateNotDone, expired: t.advStateExpired });

//one offer or a ladder: the amount split in equal parts (the last takes the rest), each part priced one step further
//from the first price (sellers ask more for each next part, buyers pay less); evm = what each part costs
export function splitOffer(nexus: bigint, price: bigint, nexusDecimals: number, pieces: number, stepPct: number, sell: boolean): { nexus: bigint; evm: bigint; price: bigint }[] {
  const n = BigInt(Math.max(1, Math.min(5, Math.floor(pieces) || 1)));
  const part = nexus / n;
  const out: { nexus: bigint; evm: bigint; price: bigint }[] = [];
  for (let i = 0n; i < n; i++) {
    const amount = i === n - 1n ? nexus - part * (n - 1n) : part;
    const bp = BigInt(Math.round(stepPct * 100)) * i; //basis points away from the first price
    const p = sell ? (price * (10000n + bp)) / 10000n : (price * (10000n - bp)) / 10000n;
    out.push({ nexus: amount, evm: (amount * p) / 10n ** BigInt(nexusDecimals), price: p });
  }
  return out.filter((x) => x.nexus > 0n && x.evm > 0n);
}

function Ladder({ pieces, sell, ticker, decimals, token, total }: { pieces: { nexus: bigint; evm: bigint; price: bigint }[]; sell: boolean; ticker: string; decimals: number; token: TokenInfo; total: bigint }) {
  const { t, f, p: plural } = useT();
  if (pieces.length <= 1) {
    return <p className="fine">{f(sell ? t.advTotalGet : t.advTotalPay, { amount: evmAmount(total, token), coin: token.symbol })}</p>;
  }
  const sum = pieces.reduce((s, p) => s + p.evm, 0n);
  return (
    <div className="fine ladder">
      <p>{plural(sell ? t.advLadderGet : t.advLadderPay, pieces.length, { amount: evmAmount(sum, token), coin: token.symbol })}</p>
      <ul>
        {pieces.map((p, i) => (
          <li key={i}>{f(t.advLadderPart, { amount: fromUnits(p.nexus, decimals), coin: ticker, price: evmAmount(p.price, token), quote: token.symbol })}</li>
        ))}
      </ul>
    </div>
  );
}

function Make({ app, bestAsk, bestBid, group }: { app: AppState; bestAsk?: Row; bestBid?: Row; group: string }) {
  const { t, f, p: plural } = useT();
  const [sell, setSell] = useState(true);
  const chains = Object.entries(app.info.chains);
  //start on the chain the wallet is on, when the site trades there
  const walletChain = app.evm?.wallet && app.info.chains[String(app.evm.chainId)] ? String(app.evm.chainId) : null;
  const [chainId, setChainId] = useState(walletChain ?? chains[0]?.[0] ?? '');
  const tokens = app.info.chains[chainId]?.tokens ?? [];
  //start on a token of the price group picked in the book
  const [tokenAddr, setTokenAddr] = useState((tokens.find((tk) => groupOf(tk) === group) ?? tokens[0])?.address ?? '');
  const accounts = app.nexus?.accounts ?? [];
  const [account, setAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [hours, setHours] = useState('24');
  const [again, setAgain] = useState(false);
  const [pieces, setPieces] = useState('1');
  const [step, setStep] = useState('1');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const acct = accounts.find((a) => a.address === account) ?? accounts[0];
  const evmToken = tokens.find((tk) => tk.address === tokenAddr) ?? tokens[0];
  const nexusUnits = acct ? toUnits(amount, acct.decimals) : null;
  const priceUnits = evmToken ? toUnits(unitPrice, evmToken.decimals) : null;
  const evmUnits = nexusUnits !== null && priceUnits !== null && acct ? (nexusUnits * priceUnits) / 10n ** BigInt(acct.decimals) : null;

  const { problems, need } = makeChecks(app, sell, acct, nexusUnits, { token: evmToken, units: evmUnits });
  const incomplete = !acct || !evmToken || nexusUnits === null || evmUnits === null || evmUnits <= 0n || nexusUnits <= 0n;
  //a quick start from the book: match the best price on the other side
  const hintRow = sell ? bestBid : bestAsk;
  const hint = hintRow && evmToken && hintRow.group === groupOf(evmToken) ? hintRow : undefined;
  const market = useMarketPrice(app, acct?.token ?? '0');
  const usdOf = useTokenUsd(app);
  const tokenUsd = evmToken ? usdOf(chainId, evmToken.address) : null;

  const mine = app.desk.myOffers(app.evm?.address);

  async function post() {
    if (need) {
      app.openDialog(need);
      return;
    }
    if (incomplete) {
      setMsg({ ok: false, text: t.advEnterAmount });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      askToNotify();
      const ladder = splitOffer(nexusUnits!, priceUnits!, acct!.decimals, Number(pieces), Number(step.replace(',', '.')), sell);
      for (const [i, p] of ladder.entries()) {
        if (ladder.length > 1) {
          setMsg({ ok: true, text: f(t.advPostingPart, { i: i + 1, n: ladder.length }) });
        }
        await app.desk.postOffer(
          {
            nexusAccount: acct!.address,
            nexusGenesis: app.nexus!.genesis,
            makerGivesNexus: sell,
            nexusToken: acct!.token,
            nexusAmount: p.nexus,
            evmChainId: BigInt(chainId),
            evmToken: evmToken!.address,
            evmAmount: p.evm,
            expires: BigInt(Math.floor(Date.now() / 1000) + Math.round(Number(hours) * 3600)),
          },
          { again },
        );
      }
      setMsg({ ok: true, text: ladder.length > 1 ? plural(t.advOffersPosted, ladder.length) : t.advOfferPosted });
      setAmount('');
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="seg wide" role="group" aria-label={t.advDirection} style={{ marginBottom: 14 }}>
        <button aria-pressed={sell} onClick={() => setSell(true)}>
          {f(t.advISell, { coin: acct?.ticker ?? 'NXS' })}
        </button>
        <button aria-pressed={!sell} onClick={() => setSell(false)}>
          {f(t.advIBuy, { coin: acct?.ticker ?? 'NXS' })}
        </button>
      </div>
      <label className="field">
        <span>{t.advNexusAccount}</span>
        <select value={acct?.address ?? ''} onChange={(e) => setAccount(e.target.value)} disabled={!accounts.length}>
          {accounts.length === 0 && <option value="">{t.advSignInToPick}</option>}
          {accounts.map((a) => (
            <option key={a.address} value={a.address}>
              {f(t.advAccountOption, { name: a.name ?? t.advAccountNoName, balance: fromUnits(a.balance, a.decimals), coin: a.ticker })}
            </option>
          ))}
        </select>
      </label>
      <div className="pair">
        <label className="field">
          <span>{t.advAmount}</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0" />
        </label>
        <label className="field">
          <span>{t.advPricePerCoin}</span>
          <input value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} inputMode="decimal" placeholder="0.00" />
        </label>
      </div>
      {hint && (
        <p className="quick">
          <button type="button" className="link" onClick={() => setUnitPrice(String(hint.priceNum))}>
            {f(sell ? t.advUseBestBuy : t.advUseBestSell, { price: shownPrice(hint.priceNum), coin: hint.evmSymbol })}
          </button>
        </p>
      )}
      {tokenUsd !== null && <MarketNote priceNum={Number(unitPrice.replace(',', '.')) * tokenUsd} market={market} iBuy={!sell} onUse={(usd) => setUnitPrice(String(Number((usd / tokenUsd).toPrecision(6))))} />}
      <div className="pair">
        <label className="field">
          <span>{t.advChain}</span>
          <select
            value={chainId}
            onChange={(e) => {
              setChainId(e.target.value);
              setTokenAddr(app.info.chains[e.target.value]?.tokens[0]?.address ?? '');
            }}
          >
            {chains.map(([id, c]) => (
              <option key={id} value={id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.advPaidIn}</span>
          <select value={evmToken?.address ?? ''} onChange={(e) => setTokenAddr(e.target.value)}>
            {tokens.map((tk) => (
              <option key={tk.address} value={tk.address}>
                {tk.symbol}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>{t.advStaysUp}</span>
        <select value={hours} onChange={(e) => setHours(e.target.value)}>
          <option value="1">{t.advOneHour}</option>
          <option value="24">{t.advOneDay}</option>
          <option value="168">{t.advOneWeek}</option>
        </select>
      </label>
      <div className="pair">
        <label className="field">
          <span>{t.advSplitInto}</span>
          <select value={pieces} onChange={(e) => setPieces(e.target.value)}>
            <option value="1">{t.advOneOffer}</option>
            {[2, 3, 4, 5].map((n) => (
              <option key={n} value={String(n)}>
                {plural(t.advSplitOffers, n)}
              </option>
            ))}
          </select>
        </label>
        {pieces !== '1' && (
          <label className="field">
            <span>{t.advPriceStep}</span>
            <select value={step} onChange={(e) => setStep(e.target.value)}>
              {['0.5', '1', '2', '5'].map((v) => (
                <option key={v} value={v}>
                  {f(sell ? t.advStepHigher : t.advStepLower, { pct: v })}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} />
        {t.advPostAgainAuto}
      </label>
      {evmUnits !== null && evmToken && evmUnits > 0n && nexusUnits !== null && priceUnits !== null && acct && (
        <Ladder pieces={splitOffer(nexusUnits, priceUnits, acct.decimals, Number(pieces), Number(step.replace(',', '.')), sell)} sell={sell} ticker={acct.ticker} decimals={acct.decimals} token={evmToken} total={evmUnits} />
      )}
      {problems.length > 0 && !need && (
        <ul className="problem" style={{ paddingLeft: 28 }}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {msg && <p className={msg.ok ? 'fine' : 'problem'}>{msg.text}</p>}
      {app.desk.lastError && mine.length > 0 && <p className="problem">{f(t.advNotOnline, { reason: app.desk.lastError })}</p>}
      <button className="btn" disabled={busy || (!need && (problems.length > 0 || incomplete))} onClick={post} aria-busy={busy}>
        {busy ? t.advPosting : need === 'nexus' ? t.advSignInNexus : need === 'evm' ? t.advConnectWallet : t.advPostOffer}
      </button>
      <p className="note">{app.evm && !app.evm.wallet ? t.advSignsReceive : t.advSignsWallet}</p>
      {mine.length > 0 && (
        <>
          <h2 style={{ marginTop: 24 }}>{t.advYourOffers}</h2>
          {mine.map((o) => {
            const nt = app.tokens.get(o.offer.nexusToken);
            const et = tokenOf(app.info, o.offer.evmChainId, o.offer.evmToken);
            const state = app.desk.offerState(o);
            return (
              <div key={o.id} className={`my-offer state-${state.replace(' ', '-')}`}>
                <span>
                  {f(o.offer.makerGivesNexus ? t.advMySell : t.advMyBuy, {
                    amount: nt ? fromUnits(o.offer.nexusAmount, nt.decimals) : String(o.offer.nexusAmount),
                    coin: nt?.ticker ?? '',
                    price: et ? `${evmAmount(o.offer.evmAmount, et)} ${et.symbol}` : String(o.offer.evmAmount),
                  })}
                  <small>{o.again && state !== 'expired' ? f(t.advStateAgain, { state: offerStateText(t)[state] }) : offerStateText(t)[state]}</small>
                </span>
                {state === 'open' && (
                  <span className="my-offer-acts">
                    <ShareLink app={app} id={o.id} />
                    <button className="btn quiet small" onClick={() => void app.desk.cancelOffer(o.id)}>
                      {t.advWithdraw}
                    </button>
                  </span>
                )}
                {(state === 'swapped' || state === 'not done' || state === 'expired') && (
                  <span className="my-offer-acts">
                    <button className="btn quiet small" onClick={() => void app.desk.repost(o.id).catch((e) => setMsg({ ok: false, text: (e as Error).message }))}>
                      {t.advPostAgain}
                    </button>
                    <button className="btn quiet small" onClick={() => app.desk.forgetOffer(o.id)} aria-label={t.advRemoveLabel}>
                      {t.advRemove}
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
