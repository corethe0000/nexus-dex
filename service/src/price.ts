//a reference price in US dollars for Nexus coins, so the page can say when an offer is far from the market and draw
//a price line. Taken from a public feed (CoinGecko simple/price, with its 24 h change and volume) by the relay: browsers
//ask the relay, never the feed. The relay keeps its own samples for the line (CoinGecko's chart endpoint answers 404
//for NXS since 2026-11-07, simple/price still works). Only a hint for people, never used by the swap itself.
//refs: Nexus token ("0" = NXS) -> CoinGecko coin id, or a fixed number (test chains, whose coins have no market)

export interface PriceOut {
  prices: Record<string, { usd: number; at: number; source: string }>;
  source: string;
}

//samples as [unix seconds, usd]; change24 in percent and volume24 in USD across all markets, as the feed says
export interface History {
  prices: [number, number][];
  change24?: number;
  volume24?: number;
  source: string;
}

export type Samples = Record<string, [number, number][]>;

export type FetchJson = (url: string) => Promise<any>;

const feedUrl = 'https://api.coingecko.com/api/v3/simple/price';
const keepSamples = 7 * 24 * 3600;

const fetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`price feed answered ${res.status}`);
  }
  return res.json();
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export class PriceFeed {
  private last: PriceOut['prices'] = {};
  private extra: Record<string, { change24?: number; volume24?: number }> = {};
  private fetchedAt = -Infinity;
  private loading: Promise<void> | null = null;

  constructor(
    private refs: Record<string, string | number>,
    private get: FetchJson = fetchJson,
    private refreshAfter = 300, //seconds between feed calls (and between samples)
    private dropAfter = 3600, //a price older than this is not shown at all
    private log: (msg: string) => void = console.log,
    readonly samples: Samples = {},
    private onSample: () => void = () => {},
  ) {}

  async prices(now: number): Promise<PriceOut> {
    if (now - this.fetchedAt >= this.refreshAfter) {
      this.loading ??= this.load(now).finally(() => (this.loading = null));
      await this.loading;
    }
    const prices = Object.fromEntries(Object.entries(this.last).filter(([, p]) => now - p.at < this.dropAfter));
    return { prices, source: 'CoinGecko' };
  }

  //the samples of the last 7 days plus the feed's 24 h figures; null for fixed prices and tokens without a feed id
  async history(token: string, now: number): Promise<History | null> {
    if (typeof this.refs[token] !== 'string') {
      return null;
    }
    await this.prices(now);
    const prices = (this.samples[token] ?? []).filter(([t]) => now - t <= keepSamples);
    if (!prices.length) {
      return null;
    }
    return { prices, ...this.extra[token], source: 'CoinGecko' };
  }

  private async load(now: number) {
    this.fetchedAt = now;
    const ids = [...new Set(Object.values(this.refs).filter((v): v is string => typeof v === 'string'))];
    let feed: Record<string, { usd?: number; usd_24h_change?: number; usd_24h_vol?: number }> = {};
    if (ids.length) {
      try {
        feed = await this.get(`${feedUrl}?ids=${ids.map(encodeURIComponent).join(',')}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`);
      } catch (e) {
        //keep the last prices; they drop out by themselves once too old
        this.log(`price feed - ${(e as Error).message}`);
      }
    }
    let sampled = false;
    for (const [token, ref] of Object.entries(this.refs)) {
      const usd = typeof ref === 'number' ? ref : num(feed[ref]?.usd);
      if (usd === undefined || usd <= 0) {
        continue;
      }
      this.last[token] = { usd, at: now, source: typeof ref === 'number' ? 'fixed test price' : 'CoinGecko' };
      if (typeof ref === 'string') {
        this.extra[token] = { change24: num(feed[ref]?.usd_24h_change), volume24: num(feed[ref]?.usd_24h_vol) };
        const list = (this.samples[token] ??= []);
        list.push([now, usd]);
        this.samples[token] = list.filter(([t]) => now - t <= keepSamples);
        sampled = true;
      }
    }
    if (sampled) {
      this.onSample();
    }
  }
}
