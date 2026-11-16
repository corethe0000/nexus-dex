//market panels above the trading forms: the price of the coin over time, how much changed hands, a few headline
//numbers. Two sources: swaps that went through on this relay (relay /api/trades) plus the coin's reference price from
//the relay's feed (/api/history); on the Nexus market the filled orders on the chain itself (market/list/executed).
import { useEffect, useMemo, useState } from 'react';
import type { AppState } from '../App';
import { tokenOf } from '../lib/config';
import { useT } from '../lib/i18n';
import { pairFills } from '../lib/nexus-market';
import type { RelayTrade } from '../lib/relay';
import { buckets, lastPerSlot, PriceChart, type Pt, type Series } from './Chart';
import { shownPrice, useTokenUsd } from './offers';

type Range = '24h' | '7d';
const day = 24 * 3600;

function usePoll<T>(load: () => Promise<T>, everyMs: number, deps: unknown[]): T | null {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => {
    let stop = false;
    const go = () =>
      void load()
        .then((r) => !stop && setV(r))
        .catch(() => {});
    go();
    const t = window.setInterval(go, everyMs);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return v;
}

const pct = (a: number, b: number) => (a > 0 ? ((b - a) / a) * 100 : null);

function Change({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) {
    return <dd>-</dd>;
  }
  const up = value >= 0;
  return <dd className={up ? 'up' : 'down'}>{`${up ? '+' : '-'}${Math.abs(value).toFixed(2)}%`}</dd>;
}

function RangePick({ range, setRange }: { range: Range; setRange: (r: Range) => void }) {
  const { t } = useT();
  return (
    <div className="seg small" role="group" aria-label={t.trTimeRange}>
      {(['24h', '7d'] as const).map((r) => (
        <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
          {r === '24h' ? t.tr24Hours : t.tr7Days}
        </button>
      ))}
    </div>
  );
}

//NXS (or a Nexus token) against the coins on other chains, all in dollars: reference price line, swaps here as dots,
//volume of swaps here
export function StableMarketPanel({ app, token, compact = false }: { app: AppState; token: string; compact?: boolean }) {
  const { t: tx, f, p } = useT();
  const [range, setRange] = useState<Range>('24h');
  const now = Math.floor(Date.now() / 1000);
  const trades = usePoll(() => app.relay.trades(now - 7 * day).then((r) => r.trades), 60000, [app.relay]);
  const history = usePoll(() => app.relay.history(token).then((r) => r.history), 600000, [app.relay, token]);
  const coin = app.tokens.get(token);
  const usdOf = useTokenUsd(app);
  const ticker = coin?.ticker ?? (token === '0' ? 'NXS' : tx.trCoin);

  const mine = useMemo(() => {
    const out: { t: number; price: number; usd: number }[] = [];
    for (const t of (trades ?? []) as RelayTrade[]) {
      const et = tokenOf(app.info, t.chainId, t.evmToken);
      if (t.nexusToken !== token || !et || !coin) {
        continue;
      }
      const n = Number(t.nexusAmount) / 10 ** coin.decimals;
      //in dollars: stablecoins at one dollar, other tokens at the relay price (left out while it is unknown)
      const rate = usdOf(t.chainId, t.evmToken);
      const usd = (Number(t.evmAmount) / 10 ** et.decimals) * (rate ?? NaN);
      if (n > 0 && Number.isFinite(usd)) {
        out.push({ t: t.at, price: usd / n, usd });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }, [trades, token, coin, app.info, usdOf]);

  const span = range === '24h' ? day : 7 * day;
  const from = now - span;
  const ref: Pt[] = (history?.prices ?? []).map(([t, v]) => ({ t, v }));
  const swaps: Pt[] = mine.map((m) => ({ t: m.t, v: m.price }));
  const series: Series[] = [];
  if (ref.length) {
    series.push({ label: f(tx.trMarketPriceSource, { source: history!.source }), kind: 'line', color: 'var(--chart-market)', pts: ref });
    series.push({ label: tx.trSwapsHere, kind: 'dots', color: 'var(--chart-swaps)', pts: swaps });
  } else {
    series.push({ label: tx.trSwapsHere, kind: 'line', color: 'var(--chart-swaps)', pts: lastPerSlot(swaps, span / 48) });
    series.push({ label: tx.trSwapsHere, kind: 'dots', color: 'var(--chart-swaps)', pts: swaps });
  }

  const last24 = mine.filter((m) => m.t >= now - day);
  const volume24 = last24.reduce((s, m) => s + m.usd, 0);
  const priceNow = ref.at(-1)?.v ?? swaps.at(-1)?.v;
  const change = history?.change24 ?? (last24.length > 1 ? pct(last24[0]!.price, last24.at(-1)!.price) : null);
  const allMarkets = history?.volume24;

  return (
    <section className={`panel market-panel${compact ? ' compact' : ''}`} aria-label={f(tx.trCoinMarket, { coin: ticker })}>
      <div className="market-head">
        <dl className="market-figures">
          <div className="lead">
            {/* without a market feed the figure is the last swap here, and says so */}
            <dt>{ref.length ? f(tx.trCoinPrice, { coin: ticker }) : f(tx.trLastPrice, { a: ticker, b: 'USD' })}</dt>
            <dd>{priceNow === undefined ? '-' : `$${shownPrice(priceNow)}`}</dd>
          </div>
          <div>
            <dt>{tx.trChange24}</dt>
            <Change value={change} />
          </div>
          <div>
            <dt>{tx.trSwapped24}</dt>
            <dd>
              ${volume24.toLocaleString('en-US', { maximumFractionDigits: 0 })} <small>{p(tx.trInSwaps, last24.length)}</small>
            </dd>
          </div>
          {!compact && allMarkets !== undefined && (
            <div>
              <dt>{tx.trAllMarkets24}</dt>
              <dd>${allMarkets.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })}</dd>
            </div>
          )}
        </dl>
        {!compact && <RangePick range={range} setRange={setRange} />}
      </div>
      <PriceChart
        series={series}
        bars={compact ? undefined : { label: tx.trSwappedHere, color: 'var(--chart-swaps)', unit: 'USD', pts: buckets(mine.map((m) => ({ t: m.t, v: m.usd })), from, now, range === '24h' ? 3600 : 6 * 3600) }}
        from={from}
        to={now}
        unit="$"
        height={compact ? 96 : 160}
        empty={f(tx.trNoPriceYet, { coin: ticker })}
      />
    </section>
  );
}

//a pair on the Nexus market: filled orders as price points, how much of the first coin changed hands
export function NexusMarketPanel({ app, a, b, compact = false, tick }: { app: AppState; a: { token: string; ticker: string }; b: { token: string; ticker: string }; compact?: boolean; tick: number }) {
  const { t: tx, f, p } = useT();
  const [range, setRange] = useState<Range>('24h');
  const fills = usePoll(() => pairFills(app.node, a.token, b.token), 60000, [app.node, a.token, b.token, tick]) ?? [];
  const now = Math.floor(Date.now() / 1000);
  const span = range === '24h' ? day : 7 * day;
  const from = now - span;
  const pts: Pt[] = fills.map((f) => ({ t: f.at, v: f.price }));
  const last24 = fills.filter((f) => f.at >= now - day);
  const change = last24.length > 1 ? pct(last24[0]!.price, last24.at(-1)!.price) : null;
  const unit = b.ticker;
  return (
    <section className={`panel market-panel${compact ? ' compact' : ''}`} aria-label={f(tx.trPairIn, { a: a.ticker, b: b.ticker })}>
      <div className="market-head">
        <dl className="market-figures">
          <div className="lead">
            <dt>{f(tx.trLastPrice, { a: a.ticker, b: b.ticker })}</dt>
            <dd>{fills.length ? shownPrice(fills.at(-1)!.price) : '-'}</dd>
          </div>
          <div>
            <dt>{tx.trChange24}</dt>
            <Change value={change} />
          </div>
          <div>
            <dt>{tx.trTraded24}</dt>
            <dd>
              {last24.reduce((s, f) => s + f.amount, 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} {a.ticker} <small>{p(tx.trInTrades, last24.length)}</small>
            </dd>
          </div>
        </dl>
        {!compact && <RangePick range={range} setRange={setRange} />}
      </div>
      <PriceChart
        series={[
          { label: tx.trTrades, kind: 'line', color: 'var(--chart-market)', pts: lastPerSlot(pts, span / 48) },
          { label: tx.trTrades, kind: 'dots', color: 'var(--chart-market)', pts },
        ]}
        bars={compact ? undefined : { label: tx.trTraded, color: 'var(--chart-market)', unit: a.ticker, pts: buckets(fills.map((f) => ({ t: f.at, v: f.amount })), from, now, range === '24h' ? 3600 : 6 * 3600) }}
        from={from}
        to={now}
        unit={unit}
        height={compact ? 96 : 160}
        empty={f(tx.trNoPairTrades, { a: a.ticker, b: b.ticker })}
      />
    </section>
  );
}
