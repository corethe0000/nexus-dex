//trading on the Nexus chain alone: NXS and Nexus tokens against each other, on the core's own market. Only a Nexus
//profile is needed (no EVM wallet). Placing an order moves the coins into it; taking one is a single transaction
//that pays both sides. The order's owner then collects the payment (a CREDIT with its own signature).
//Simple: pay / get, the best order that fits is picked. Advanced: the book of a pair both ways, orders at your price.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppState } from '../App';
import { askToNotify } from '../lib/attention';
import { fromUnits, toUnits } from '../lib/format';
import { useT, type Texts, type Tr } from '../lib/i18n';
import { waitingPayments, type Waiting } from '../lib/incoming';
import { accountsFor, refresh, spendable } from '../lib/nexus';
import { orderPrice, pairOrders, type MarketOrder } from '../lib/nexus-market';
import { marketOf } from '@nexus-dex/core/src/nexus/signer';
import { Knot } from './Frame';
import { NexusMarketPanel } from './MarketCharts';
import { shownPrice } from './offers';

interface Coin {
  token: string;
  ticker: string;
  decimals: number;
}

type Act = (key: string, f: () => Promise<string>, text: string) => Promise<void>;

const refreshMs = 10000;
const customKey = (net: string) => `nexus-dex:tokens:${net}`;

function loadCustom(net: string): Coin[] {
  try {
    return JSON.parse(localStorage.getItem(customKey(net)) ?? '[]') as Coin[];
  } catch {
    return [];
  }
}

//coins to trade: NXS, the tokens this site lists, tokens added by address, and the tokens in the user's accounts
function useCoins(app: AppState) {
  const [custom, setCustom] = useState<Coin[]>(() => loadCustom(app.prefs.net));
  const coins = useMemo<Coin[]>(() => {
    const m = new Map<string, Coin>([['0', { token: '0', ticker: 'NXS', decimals: 6 }]]);
    for (const c of [...(app.site.nexusTokens ?? []), ...custom]) {
      m.set(c.token, c);
    }
    for (const a of app.nexus?.accounts ?? []) {
      if (!m.has(a.token)) {
        m.set(a.token, { token: a.token, ticker: a.ticker, decimals: a.decimals });
      }
    }
    return [...m.values()];
  }, [app.site, app.nexus, custom]);
  const add = (c: Coin) => {
    const next = [...custom.filter((x) => x.token !== c.token), c];
    setCustom(next);
    try {
      localStorage.setItem(customKey(app.prefs.net), JSON.stringify(next));
    } catch {
      //kept until reload
    }
  };
  return { coins, add };
}

//the two coins of a trade, never the same one: picking the other side's coin swaps them
function usePair(coins: Coin[]) {
  const [a, setA] = useState('0');
  const [b, setB] = useState<string | null>(null);
  const first = coins.find((c) => c.token === a) ?? coins[0]!;
  const second = coins.find((c) => c.token === b && c.token !== first.token) ?? coins.find((c) => c.token !== first.token) ?? null;
  const pickFirst = (t: string) => {
    if (second && t === second.token) {
      setB(first.token);
    }
    setA(t);
  };
  const pickSecond = (t: string) => {
    if (t === first.token) {
      setA(second?.token ?? '0');
    }
    setB(t);
  };
  const flip = () => {
    if (second) {
      setA(second.token);
      setB(first.token);
    }
  };
  return { first, second, pickFirst, pickSecond, flip };
}

export function NexusMarket({ app }: { app: AppState }) {
  const { t, f, p } = useT();
  const { coins, add } = useCoins(app);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [tick, setTick] = useState(0);

  const loadWaiting = useCallback(async () => {
    if (!app.nexus) {
      setWaiting([]);
      return;
    }
    setWaiting(await waitingPayments(app.node, app.nexus.accounts).catch(() => []));
  }, [app.node, app.nexus]);
  useEffect(() => {
    void loadWaiting();
    const t = window.setInterval(loadWaiting, 20000);
    return () => window.clearInterval(t);
  }, [loadWaiting]);

  //after a transaction: final with the next block; then balances, orders and payments are read again
  const act: Act = async (key, send, text) => {
    if (!app.nexus) {
      app.openDialog('nexus');
      return;
    }
    askToNotify();
    setBusy(key);
    setMsg(null);
    try {
      const txid = await send();
      setBusy(null);
      setMsg({ ok: true, text: f(t.nmFinalNextBlock, { text }) });
      await app.node.waitConfirmed(txid, 1, 300000).catch(() => {});
      await refresh(app.node, app.nexus);
      app.setNexus(app.nexus);
      setMsg({ ok: true, text: f(t.nmDone, { text }) });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
      setTick((t) => t + 1);
      void loadWaiting();
    }
  };

  const collect = () =>
    act(
      'collect',
      () => app.nexus!.signer.collect(waiting.map((w) => ({ txid: w.txid, contract: w.contract, to: w.to, from: w.from, amount: w.amount }))),
      f(t.nmCollected, { list: [...waiting.reduce((m, w) => m.set(w.ticker, { d: w.decimals, sum: (m.get(w.ticker)?.sum ?? 0n) + w.amount }), new Map<string, { d: number; sum: bigint }>())].map(([tk, v]) => `${fromUnits(v.sum, v.d)} ${tk}`).join(t.nmCollectedJoin) }),
    );

  const simple = app.prefs.mode === 'simple';
  //per coin: total and how many payments
  const totals = [...waiting.reduce((m, w) => m.set(w.token, { w, sum: (m.get(w.token)?.sum ?? 0n) + w.amount, n: (m.get(w.token)?.n ?? 0) + 1 }), new Map<string, { w: Waiting; sum: bigint; n: number }>()).values()];
  return (
    <>
      {waiting.length > 0 && (
        <div className="waiting" role="status">
          <span>
            <b>{t.nmWaitingTitle}</b> {f(t.nmWaitingText, { list: totals.map((x) => p(t.nmWaitingItem, x.n, { amount: fromUnits(x.sum, x.w.decimals), ticker: x.w.ticker })).join(t.nmWaitingJoin) })}
          </span>
          <button className="btn small" onClick={collect} disabled={!!busy}>
            {busy === 'collect' ? t.nmCollecting : t.nmCollect}
          </button>
        </div>
      )}
      {msg && <p className={msg.ok ? 'fine' : 'problem'}>{msg.text}</p>}
      {simple ? <SimpleNexus app={app} coins={coins} add={add} act={act} busy={busy} tick={tick} /> : <AdvancedNexus app={app} coins={coins} add={add} act={act} busy={busy} tick={tick} />}
    </>
  );
}

//the open orders of a pair, read again every few seconds and after each own transaction
function usePairOrders(app: AppState, a: Coin, b: Coin | null, tick: number) {
  const [orders, setOrders] = useState<MarketOrder[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!b) {
      setOrders([]);
      return;
    }
    try {
      setOrders(await pairOrders(app.node, a.token, b.token));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [app.node, a.token, b]);
  useEffect(() => {
    setOrders(null);
    void load();
    const t = window.setInterval(load, refreshMs);
    return () => window.clearInterval(t);
  }, [load, tick]);
  return { orders, error };
}

const tickerOf = (t: Texts, coins: Coin[], s: MarketOrder['give']) => s.ticker ?? coins.find((c) => c.token === s.token)?.ticker ?? t.nmToken;

//can this profile take that order: an account with what it wants, and one for what it gives
function takeProblem({ t, f }: Tr, app: AppState, coins: Coin[], o: MarketOrder): string | null {
  if (!app.nexus) {
    return null;
  }
  if (!accountsFor(app.nexus, o.want.token).some((a) => Number(a.balance) / 10 ** a.decimals >= o.want.amount)) {
    return f(t.nmNeedAmount, { amount: o.want.amount, ticker: tickerOf(t, coins, o.want) });
  }
  if (!accountsFor(app.nexus, o.give.token).length) {
    return f(t.nmNeedAccount, { ticker: tickerOf(t, coins, o.give) });
  }
  return null;
}

function takeOrder({ t, f }: Tr, app: AppState, coins: Coin[], act: Act, o: MarketOrder) {
  const pay = accountsFor(app.nexus, o.want.token).find((a) => Number(a.balance) / 10 ** a.decimals >= o.want.amount);
  const receive = accountsFor(app.nexus, o.give.token)[0];
  return act('take:' + o.txid, () => app.nexus!.signer.market.fill({ txid: o.txid, market: marketOf(o.give.token, o.want.token), pay: pay?.address, receive: receive?.address }), f(t.nmPaidGot, { pay: o.want.amount, payTicker: tickerOf(t, coins, o.want), get: o.give.amount, getTicker: tickerOf(t, coins, o.give) }));
}

interface ModeProps {
  app: AppState;
  coins: Coin[];
  add: (c: Coin) => void;
  act: Act;
  busy: string | null;
  tick: number;
}

function SimpleNexus({ app, coins, add, act, busy, tick }: ModeProps) {
  const tr = useT();
  const { t, f } = tr;
  const pair = usePair(coins);
  const pay = pair.first;
  const get = pair.second;
  const { orders, error } = usePairOrders(app, pay, get, tick);
  const [amount, setAmount] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [own, setOwn] = useState(false);
  const me = app.nexus?.genesis.toLowerCase();
  //orders that give what I get and want what I pay, cheapest per coin got first
  const candidates = get ? (orders ?? []).filter((o) => o.give.token === get.token && o.want.token === pay.token && o.owner.toLowerCase() !== me).sort((x, y) => orderPrice(x, get.token) - orderPrice(y, get.token)) : [];
  const typed = amount.trim() === '' ? null : Number(amount.replace(',', '.'));
  const typedOk = amount.trim() === '' || (typed !== null && Number.isFinite(typed) && typed >= 0);
  const fits = typed ? candidates.filter((o) => o.want.amount <= typed * (1 + 1e-12)) : candidates;
  const match = fits.find((o) => o.txid === chosen) ?? fits[0] ?? null;
  const sizes = candidates.filter((o, i) => candidates.findIndex((x) => x.want.amount === o.want.amount) === i).slice(0, 4);
  const problem = match ? takeProblem(tr, app, coins, match) : null;
  const balance = spendable(app.nexus, pay.token);

  let cta = '';
  let enabled = false;
  if (!get) {
    cta = t.nmAddSecondCoin;
  } else if (orders === null) {
    cta = t.nmReading;
  } else if (!candidates.length) {
    cta = f(t.nmNobodyOffers, { get: get.ticker, pay: pay.ticker });
  } else if (!typedOk) {
    cta = t.nmEnterAmountLike;
  } else if (!match) {
    cta = t.nmNoOrderFits;
  } else if (!app.nexus) {
    cta = t.nmSignInToTrade;
    enabled = true;
  } else if (busy?.startsWith('take:')) {
    cta = t.nmTakingOrder;
  } else if (problem) {
    cta = t.nmNotReady;
  } else {
    cta = f(t.nmPayGet, { pay: match.want.amount, payTicker: pay.ticker, get: match.give.amount, getTicker: get.ticker });
    enabled = !busy;
  }

  return (
    <div className="simple">
      <section className="ticket" aria-label={t.nmTicketLabel}>
        <div className="ticket-leg chain-nexus">
          <label className="leg-label" htmlFor="nm-pay">
            {t.nmYouPay}
          </label>
          <div className="leg-main">
            <input
              id="nm-pay"
              className="leg-amount"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setChosen(null);
              }}
              inputMode="decimal"
              placeholder={match ? String(match.want.amount) : '0'}
              autoComplete="off"
              aria-invalid={!typedOk}
            />
            <CoinSelect app={app} coins={coins} value={pay.token} onChange={pair.pickFirst} add={add} label={t.nmCoinYouPay} />
          </div>
          <div className="leg-foot">
            <span>{t.nmOnNexus}</span>
            {app.nexus && (
              <button type="button" className="link" onClick={() => setAmount(fromUnits(balance, pay.decimals).replace(/,/g, ''))}>
                {f(t.nmBalance, { amount: fromUnits(balance, pay.decimals), ticker: pay.ticker })}
              </button>
            )}
          </div>
        </div>
        <button className="ticket-flip" onClick={() => (pair.flip(), setAmount(''), setChosen(null))} aria-label={t.nmSwapCoins}>
          <Knot spin={!!busy?.startsWith('take:')} size={30} />
        </button>
        <div className="ticket-leg get chain-nexus">
          <span className="leg-label">{t.nmYouGet}</span>
          <div className="leg-main">
            <output className="leg-amount" aria-live="polite">
              {match ? match.give.amount : '0'}
            </output>
            {get ? <CoinSelect app={app} coins={coins.filter((c) => c.token !== pay.token)} value={get.token} onChange={pair.pickSecond} add={add} label={t.nmCoinYouGet} /> : <CoinSelect app={app} coins={[]} value="" onChange={pair.pickSecond} add={add} label={t.nmCoinYouGet} />}
          </div>
          <div className="leg-foot">
            <span>{t.nmOnNexus}</span>
            {match && get && <span>{f(t.nmRate, { get: get.ticker, price: shownPrice(orderPrice(match, get.token)), pay: pay.ticker })}</span>}
          </div>
        </div>
        {match && typed !== null && typed > match.want.amount * (1 + 1e-9) && <p className="ticket-note warn">{f(t.nmTakenWhole, { amount: match.want.amount, ticker: pay.ticker })}</p>}
        {match && !(typed !== null && typed > match.want.amount) && <p className="ticket-note">{t.nmOneTx}</p>}
        {sizes.length > 1 && (
          <div className="sizes" role="group" aria-label={t.nmOtherOrders}>
            {sizes.map((o) => (
              <button key={o.txid} aria-pressed={match?.txid === o.txid} onClick={() => (setAmount(String(o.want.amount)), setChosen(o.txid))}>
                {o.want.amount} {pay.ticker}
                <small>{f(t.nmSizeFor, { amount: o.give.amount })}</small>
              </button>
            ))}
          </div>
        )}
        {error && <p className="problem">{error}</p>}
        {problem && <p className="problem">{problem}</p>}
        <button className="btn big" disabled={!enabled} onClick={() => (app.nexus ? match && takeOrder(tr, app, coins, act, match) : app.openDialog('nexus'))} aria-busy={!!busy?.startsWith('take:')}>
          {cta}
        </button>
        {get && (
          <button type="button" className="link own-toggle" onClick={() => setOwn(!own)} aria-expanded={own}>
            {own ? t.nmHideOwn : f(t.nmPlaceOwn, { pay: pay.ticker, get: get.ticker })}
          </button>
        )}
        {own && get && <PlaceOrder app={app} give={pay} want={get} act={act} busy={busy} suggest={candidates[0] ? orderPrice(candidates[0], get.token) : null} initial={amount} />}
      </section>
      {get && <NexusMarketPanel app={app} a={get} b={pay} compact tick={tick} />}
    </div>
  );
}

function AdvancedNexus({ app, coins, add, act, busy, tick }: ModeProps) {
  const tr = useT();
  const { t, f } = tr;
  const pair = usePair(coins);
  const base = pair.first;
  const quote = pair.second;
  const { orders, error } = usePairOrders(app, base, quote, tick);
  const [side, setSide] = useState<'sell' | 'buy'>('sell');
  const me = app.nexus?.genesis.toLowerCase();
  const sellers = quote ? (orders ?? []).filter((o) => o.give.token === base.token).sort((x, y) => orderPrice(x, base.token) - orderPrice(y, base.token)) : [];
  const buyers = quote ? (orders ?? []).filter((o) => o.want.token === base.token).sort((x, y) => orderPrice(y, base.token) - orderPrice(x, base.token)) : [];
  const mine = (orders ?? []).filter((o) => o.owner.toLowerCase() === me);
  const bestSell = sellers[0] ? orderPrice(sellers[0], base.token) : null;
  const bestBuy = buyers[0] ? orderPrice(buyers[0], base.token) : null;

  const book = (title: string, hint: string, list: MarketOrder[], cls: string) => (
    <>
      <div className="side-label">
        {title} <span>{hint}</span>
      </div>
      {list.length === 0 ? (
        <p className="empty">{orders === null ? t.nmReading : t.nmNoOrders}</p>
      ) : (
        <table className="book">
          <thead>
            <tr>
              <th>{f(t.nmPriceIn, { ticker: quote?.ticker ?? '' })}</th>
              <th>{base.ticker}</th>
              <th className="hide-s">{quote?.ticker}</th>
              <th aria-label={t.nmAction} />
            </tr>
          </thead>
          <tbody>
            {list.map((o) => {
              const own = o.owner.toLowerCase() === me;
              const problem = own ? null : takeProblem(tr, app, coins, o);
              const baseAmt = o.give.token === base.token ? o.give.amount : o.want.amount;
              const quoteAmt = o.give.token === base.token ? o.want.amount : o.give.amount;
              return (
                <tr key={o.txid}>
                  <td className={cls}>{shownPrice(orderPrice(o, base.token))}</td>
                  <td>{baseAmt}</td>
                  <td className="hide-s">{quoteAmt}</td>
                  <td>
                    {own ? (
                      <span className="tag">{t.nmYours}</span>
                    ) : (
                      <button className="btn small" disabled={!!busy || !!problem} title={problem ?? undefined} onClick={() => (app.nexus ? takeOrder(tr, app, coins, act, o) : app.openDialog('nexus'))}>
                        {busy === 'take:' + o.txid ? t.nmTaking : t.nmTake}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );

  return (
    <>
      <div className="pair-pick">
        <CoinSelect app={app} coins={coins} value={base.token} onChange={pair.pickFirst} add={add} label={t.nmCoin} />
        <button className="icon-btn" onClick={pair.flip} aria-label={t.nmSwapCoins} title={t.nmSwapCoins}>
          <Knot size={20} />
        </button>
        {quote ? <CoinSelect app={app} coins={coins.filter((c) => c.token !== base.token)} value={quote.token} onChange={pair.pickSecond} add={add} label={t.nmPricedIn} /> : <CoinSelect app={app} coins={[]} value="" onChange={pair.pickSecond} add={add} label={t.nmPricedIn} />}
        <dl className="pair-stats">
          <div>
            <dt>{t.nmBestSell}</dt>
            <dd className="price-sell">{bestSell === null ? '-' : shownPrice(bestSell)}</dd>
          </div>
          <div>
            <dt>{t.nmBestBuy}</dt>
            <dd className="price-buy">{bestBuy === null ? '-' : shownPrice(bestBuy)}</dd>
          </div>
        </dl>
      </div>
      {quote && <NexusMarketPanel app={app} a={base} b={quote} tick={tick} />}
      <div className="market">
        <section className="panel book-panel" aria-label={f(t.nmOrdersLabel, { base: base.ticker, quote: quote?.ticker ?? '' })}>
          {error && <p className="problem" style={{ margin: '12px 20px' }}>{error}</p>}
          {book(f(t.nmSelling, { ticker: base.ticker }), t.nmYouBuyFromThem, [...sellers].reverse(), 'price-sell')}
          <div className="spread">
            {bestSell !== null && bestBuy !== null ? (
              //the sentence with the two prices in bold where {low} and {high} stand
              <>
                {f(t.nmBestPrices, { quote: quote?.ticker ?? '', base: base.ticker })
                  .split(/(\{low\}|\{high\})/)
                  .map((part, i) => (part === '{low}' ? <strong key={i}>{shownPrice(bestBuy)}</strong> : part === '{high}' ? <strong key={i}>{shownPrice(bestSell)}</strong> : part))}
              </>
            ) : (
              <>{t.nmPriceBothWays}</>
            )}
          </div>
          {book(f(t.nmBuying, { ticker: base.ticker }), t.nmYouSellToThem, buyers, 'price-buy')}
        </section>
        <aside className="panel act" aria-label={t.nmPlaceOrderLabel}>
          <div className="tab-panel">
            <div className="seg wide" role="group" aria-label={t.nmDirection} style={{ marginBottom: 14 }}>
              <button aria-pressed={side === 'sell'} onClick={() => setSide('sell')}>
                {f(t.nmSell, { ticker: base.ticker })}
              </button>
              <button aria-pressed={side === 'buy'} onClick={() => setSide('buy')}>
                {f(t.nmBuy, { ticker: base.ticker })}
              </button>
            </div>
            {quote && <PlaceOrder key={side + base.token + quote.token} app={app} give={side === 'sell' ? base : quote} want={side === 'sell' ? quote : base} act={act} busy={busy} suggest={null} initial="" />}
            {mine.length > 0 && (
              <>
                <h2 style={{ marginTop: 22 }}>{t.nmYourOrders}</h2>
                {mine.map((o) => (
                  <div key={o.txid} className="my-offer">
                    <span>{f(t.nmGiveFor, { give: o.give.amount, giveTicker: tickerOf(t, coins, o.give), want: o.want.amount, wantTicker: tickerOf(t, coins, o.want) })}</span>
                    <button className="btn quiet small" disabled={!!busy} onClick={() => act('cancel:' + o.txid, () => app.nexus!.signer.market.cancel({ txid: o.txid, market: marketOf(o.give.token, o.want.token) }), t.nmCancelled)}>
                      {busy === 'cancel:' + o.txid ? t.nmCancelling : t.nmCancel}
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

//an order at your own price: give an amount of one coin, ask an amount of the other
function PlaceOrder({ app, give, want, act, busy, suggest, initial }: { app: AppState; give: Coin; want: Coin; act: Act; busy: string | null; suggest: number | null; initial: string }) {
  const { t, f } = useT();
  const [giveText, setGiveText] = useState(initial);
  //price = how much of `want` per `give`; starts at the best order on the other side when there is one
  const [priceText, setPriceText] = useState(suggest ? String(Number((1 / suggest).toPrecision(8))) : '');
  const giveUnits = toUnits(giveText, give.decimals);
  const price = Number(priceText.replace(',', '.'));
  const wantAmount = giveUnits !== null && Number.isFinite(price) && price > 0 ? (Number(giveUnits) / 10 ** give.decimals) * price : null;
  const wantUnits = wantAmount !== null ? toUnits(wantAmount.toFixed(want.decimals), want.decimals) : null;
  const from = accountsFor(app.nexus, give.token).find((a) => giveUnits !== null && a.balance >= giveUnits) ?? accountsFor(app.nexus, give.token)[0];
  const to = accountsFor(app.nexus, want.token)[0];
  const problems: string[] = [];
  if (app.nexus) {
    if (!from) {
      problems.push(f(t.nmNoAccount, { ticker: give.ticker }));
    } else if (giveUnits !== null && from.balance < giveUnits) {
      problems.push(f(t.nmLargestAccount, { ticker: give.ticker, amount: fromUnits(from.balance, give.decimals) }));
    }
    if (!to) {
      problems.push(f(t.nmNeedAccount, { ticker: want.ticker }));
    }
  }
  const complete = giveUnits !== null && giveUnits > 0n && wantUnits !== null && wantUnits > 0n;
  const place = () =>
    act(
      'place',
      () => app.nexus!.signer.market.place({ give: { token: give.token, amount: giveUnits!, decimals: give.decimals }, want: { token: want.token, amount: wantUnits!, decimals: want.decimals }, from: from?.address, to: to?.address }),
      f(t.nmOrderUp, { give: fromUnits(giveUnits!, give.decimals), giveTicker: give.ticker, want: fromUnits(wantUnits!, want.decimals), wantTicker: want.ticker }),
    );
  return (
    <div className="own">
      <div className="pair">
        <label className="field">
          <span>{f(t.nmYouGive, { ticker: give.ticker })}</span>
          <input value={giveText} onChange={(e) => setGiveText(e.target.value)} inputMode="decimal" placeholder="0" aria-label={f(t.nmAmountYouGive, { ticker: give.ticker })} />
        </label>
        <label className="field">
          <span>{f(t.nmPerLabel, { want: want.ticker, give: give.ticker })}</span>
          <input value={priceText} onChange={(e) => setPriceText(e.target.value)} inputMode="decimal" placeholder="0.00" aria-label={f(t.nmPriceInPer, { want: want.ticker, give: give.ticker })} />
        </label>
      </div>
      {wantUnits !== null && wantUnits > 0n && <p className="fine">{f(t.nmYouGetWhenTaken, { amount: fromUnits(wantUnits, want.decimals), want: want.ticker, give: give.ticker })}</p>}
      {problems.length > 0 && complete && (
        <ul className="problem">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <button className="btn" disabled={!!app.nexus && (!complete || problems.length > 0 || !!busy)} onClick={() => (app.nexus ? place() : app.openDialog('nexus'))} aria-busy={busy === 'place'}>
        {busy === 'place' ? t.nmPlacing : !app.nexus ? t.nmSignIn : complete ? f(t.nmPlaceOrder, { give: fromUnits(giveUnits!, give.decimals), giveTicker: give.ticker, want: fromUnits(wantUnits!, want.decimals), wantTicker: want.ticker }) : t.nmEnterAmountPrice}
      </button>
    </div>
  );
}

//a coin picker; "Other token" asks for a token address and checks it on the chain
function CoinSelect({ app, coins, value, onChange, add, label }: { app: AppState; coins: Coin[]; value: string; onChange: (v: string) => void; add: (c: Coin) => void; label: string }) {
  const { t } = useT();
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  async function addToken() {
    setError('');
    try {
      const r = await app.node.call<any>('register/get/any', { address: address.trim() });
      if (r?.type !== 'TOKEN' && r?.object !== 'TOKEN') {
        //only compared below, the text shown comes from the pack
        throw new Error('That address is not a token.');
      }
      const c = { token: address.trim(), ticker: r.ticker ?? r.name ?? t.nmToken, decimals: Number(r.decimals ?? 0) };
      add(c);
      onChange(c.token);
      setAdding(false);
      setAddress('');
    } catch (e) {
      setError((e as Error).message === 'That address is not a token.' ? t.nmNotToken : t.nmNoTokenFound);
    }
  }
  return (
    <span className="coin-pick">
      <select
        className="coin chain-nexus"
        value={adding ? 'other' : value}
        onChange={(e) => {
          if (e.target.value === 'other') {
            setAdding(true);
          } else {
            setAdding(false);
            onChange(e.target.value);
          }
        }}
        aria-label={label}
      >
        {!coins.length && <option value="">{t.nmPickCoin}</option>}
        {coins.map((c) => (
          <option key={c.token} value={c.token}>
            {c.ticker}
          </option>
        ))}
        <option value="other">{t.nmOtherToken}</option>
      </select>
      {adding && (
        <span className="add-token">
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t.nmTokenAddress} aria-label={t.nmTokenAddress} spellCheck={false} />
          <button className="btn small" type="button" onClick={() => void addToken()} disabled={!address.trim()}>
            {t.nmAdd}
          </button>
          {error && <small className="alert-text">{error}</small>}
        </span>
      )}
    </span>
  );
}
